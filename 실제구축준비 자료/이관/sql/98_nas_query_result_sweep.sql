-- 98 — NAS 조회 큐: 전달되지 않은 결과를 남기지 않는다(REQ-0117 · 독립 검토 2026-10-08 H3)
--
-- 무엇
--   조회 결과(result)는 게이트웨이가 읽을 때(nas_query_poll) 지워진다. 그런데 게이트웨이가 8초에 포기한 뒤
--   워커가 늦게 끝내면 아무도 읽지 않아 결과(발췌·표 값 — 최대 20만 바이트)가 90일 삭제 때까지 남았다.
--   「문서 내용을 클라우드 DB 에 쌓지 않는다」(D-95 · CLAUDE.md §19-6)에 어긋나므로, 워커가 일감을 물으러 올 때마다
--   **끝난 지 2분이 지난 결과를 비운다**(확률 청소가 아니라 매번 — 조회 큐는 작아서 부담이 없다).
--
-- 바뀌는 것: public.nas_query_claim 한 함수(87 판에 청소 한 문장 추가). 그 밖의 동작은 87 과 같다.
-- 되돌리기: 98_nas_query_result_sweep_rollback.sql (87 판 정의를 다시 실행)

create or replace function public.nas_query_claim(p_worker text)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  q etl_meta.nas_query%rowtype;
begin
  if p_worker is null or p_worker !~ '^[A-Za-z0-9_.-]{1,60}$' then
    raise exception 'nas_query_claim: 워커 이름이 올바르지 않다' using errcode = '22023';
  end if;
  insert into etl_meta.nas_query_worker as w (worker, seen_at) values (p_worker, now())
  on conflict (worker) do update set seen_at = now() where w.seen_at < now() - interval '20 seconds';

  -- 읽히지 않은 결과를 남기지 않는다(게이트웨이가 시간 초과로 포기한 요청의 결과)
  update etl_meta.nas_query set result = null
   where result is not null and status = 'done' and finished_at < now() - interval '2 minutes';

  select * into q from etl_meta.nas_query
   where created_at > now() - interval '30 seconds'
     and (status = 'queued' or (status = 'running' and claimed_at < now() - interval '5 seconds'))
   order by created_at
   limit 1
   for update skip locked;
  if not found then
    if random() < 0.01 then
      update etl_meta.nas_query set status = 'expired', finished_at = now()
       where status = 'queued' and created_at < now() - interval '30 seconds';
      update etl_meta.nas_query set status = 'failed', finished_at = now(), error_msg = '시간 초과(워커 응답 없음)'
       where status = 'running' and claimed_at < now() - interval '2 minutes';
      delete from etl_meta.nas_query where created_at < now() - interval '90 days';
    end if;
    return null;
  end if;

  update etl_meta.nas_query set status = 'running', claimed_at = now(), worker = p_worker where query_id = q.query_id;
  return jsonb_build_object('query_id', q.query_id, 'kind', q.kind, 'params', q.params, 'scope', q.scope);
end;
$fn$;

revoke all on function public.nas_query_claim(text) from public, anon, authenticated;
grant execute on function public.nas_query_claim(text) to service_role;

-- 이미 남아 있던 것도 한 번 비운다
update etl_meta.nas_query set result = null
 where result is not null and status = 'done' and finished_at < now() - interval '2 minutes';
