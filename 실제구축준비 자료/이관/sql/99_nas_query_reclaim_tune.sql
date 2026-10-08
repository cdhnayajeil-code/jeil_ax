-- 99 — NAS 조회 큐: 잃어버린 요청을 더 빨리 되살리고, 결과 청소가 표를 훑지 않게 한다(REQ-0117 · 동시 조회 지연 · 2026-10-08)
--
-- 왜
--   워커가 「길게 대기」로 물고 있던 연결이 끊기면, 그 순간 집힌 요청은 running 인 채 아무에게도 전달되지 않는다.
--   87 은 그런 요청을 5초 뒤에 다시 집게 했는데, 워커가 오류 뒤 5초를 쉬던 것과 겹쳐 게이트웨이 상한 8초를 넘겼다
--   (2026-10-08 실측: 조회 33건 중 1건이 9.9초 대기 끝에 「보관소 응답 없음」).
--   워커는 n1.11 에서 병렬 처리·곧바로 다시 물기로 고쳤고, 여기서는 되살리는 시간을 줄인다.
--
-- 바뀌는 것 (nas_query_claim 한 함수 + 색인 하나)
--   · 되살리기: 집힌 지 **3초**가 넘도록 안 끝난 요청은 다시 집을 수 있다(종전 5초). 표 읽기(doc_table)는 한 건에 6초까지
--     쓸 수 있어 **7초**로 둔다 — 정상 처리 중인 표 읽기를 두 번 돌리지 않게. 조회는 읽기뿐이라 두 번 처리돼도 해가 없고
--     nas_query_finish 는 running 일 때만 쓰므로 먼저 끝난 쪽이 남는다(87 과 같다).
--   · 결과 청소(98)가 0.3초마다 표 전체를 훑지 않도록 부분 색인을 둔다(결과가 남은 행만 — 평소 몇 건).
--
-- 되돌리기: 99_nas_query_reclaim_tune_rollback.sql

create index if not exists nas_query_result_left_ix on etl_meta.nas_query (finished_at) where result is not null;

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

  -- 읽히지 않은 결과를 남기지 않는다(98)
  update etl_meta.nas_query set result = null
   where result is not null and status = 'done' and finished_at < now() - interval '2 minutes';

  select * into q from etl_meta.nas_query
   where created_at > now() - interval '30 seconds'
     and (status = 'queued'
          or (status = 'running'
              and claimed_at < now() - case when kind = 'doc_table' then interval '7 seconds' else interval '3 seconds' end))
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
