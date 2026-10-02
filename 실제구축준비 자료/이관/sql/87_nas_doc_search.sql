-- 87 — NAS 문서 내용 검색(P3) (REQ-0104 · ADR-110 v3 · D-95 승인 2026-10-02)
--
-- 무엇
--   86 의 조회 큐에 「문서 내용 검색(doc_search)」과 「문서 읽기(doc_read)」 두 종류를 더한다.
--   색인은 사내 NAS 워커 쪽 SQLite 에만 있다 — 이 DB 에는 문서 내용을 쌓지 않는다. 큐에 잠깐 머무는 것은
--   질문에 걸린 발췌뿐이고, 게이트웨이가 읽으면 지워진다(86 의 nas_query_poll).
--
-- 결정 D-95(2026-10-02 관리자): 허용 목록에 등록한 폴더의 문서만 검색하고, 질문과 관련된 발췌만 AI 모델에 보낸다.
--   급여·인사평가 폴더는 등록하지 않는다. 주민등록번호 꼴이 든 파일은 워커가 색인에서 뺀다.
--
-- 바뀌는 것(전부 86 에서 만든 객체 — 다른 기능은 건드리지 않는다)
--   · nas_query.kind CHECK 에 doc_search·doc_read 추가
--   · nas_query_submit: 두 종류의 범위를 file_list 와 **같은 식**으로 계산(허용 폴더 ∩ 부서) + 필수 인자 확인
--   · nas_index_folders(): 워커가 색인할 폴더 목록(활성 허용 폴더 전부) — service_role 전용
--
-- 되돌리기: 87_nas_doc_search_rollback.sql

alter table etl_meta.nas_query drop constraint if exists nas_query_kind_check;
alter table etl_meta.nas_query add constraint nas_query_kind_check
  check (kind in ('file_list', 'turn_history', 'doc_search', 'doc_read'));

create or replace function public.nas_query_submit(
  p_upn text, p_kind text, p_params jsonb default '{}'::jsonb,
  p_depts text[] default '{}', p_is_admin boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  v_upn     text := lower(coalesce(p_upn, ''));
  v_params  jsonb := coalesce(p_params, '{}'::jsonb);
  v_scope   jsonb;
  v_folders jsonb;
  v_want    text;
  v_id      uuid;
begin
  if v_upn = '' then
    raise exception 'nas_query_submit: upn 이 비었다' using errcode = '22023';
  end if;
  if p_kind not in ('file_list', 'turn_history', 'doc_search', 'doc_read') then
    raise exception 'nas_query_submit: 알 수 없는 종류(%)', p_kind using errcode = '22023';
  end if;
  if octet_length(v_params::text) > 4000 then
    raise exception 'nas_query_submit: 인자가 너무 크다' using errcode = '22023';
  end if;
  if p_kind = 'doc_search' and coalesce(btrim(v_params ->> 'q'), '') = '' then
    raise exception 'nas_query_submit: 검색어(q)가 비었다' using errcode = '22023';
  end if;
  if p_kind = 'doc_read' and coalesce(v_params ->> 'doc', '') !~ '^[a-z0-9_]{1,40}:[0-9]{1,12}$' then
    raise exception 'nas_query_submit: 문서 번호(doc) 형식이 올바르지 않다' using errcode = '22023';
  end if;

  if p_kind in ('file_list', 'doc_search', 'doc_read') then
    if not exists (select 1 from etl_meta.nas_folder_scope where active) then
      return jsonb_build_object('status', 'no_scope');          -- 등록된 폴더가 없다 → 전부 거부
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('key', f.folder_key, 'rel_path', f.rel_path, 'label', f.label_ko)
                              order by f.folder_key), '[]'::jsonb)
      into v_folders
      from etl_meta.nas_folder_scope f
     where f.active
       and (f.audience = 'all' or coalesce(p_is_admin, false) or f.dept_nm = any(coalesce(p_depts, '{}')));
    v_want := nullif(v_params ->> 'folder_key', '');
    if v_want is not null then
      select coalesce(jsonb_agg(x), '[]'::jsonb) into v_folders
        from jsonb_array_elements(v_folders) x where x ->> 'key' = v_want;
    end if;
    if jsonb_array_length(v_folders) = 0 then
      return jsonb_build_object('status', 'denied');            -- 등록은 있으나 이 사용자가 볼 폴더가 없다
    end if;
    v_scope := jsonb_build_object('folders', v_folders);
  else
    v_scope := jsonb_build_object('upn', v_upn);                -- 과거 대화는 본인 것만
  end if;

  if not exists (select 1 from etl_meta.nas_query_worker where seen_at > now() - interval '60 seconds') then
    return jsonb_build_object('status', 'offline');
  end if;

  if (select count(*) from etl_meta.nas_query where upn = v_upn and created_at > now() - interval '1 minute') >= 30 then
    return jsonb_build_object('status', 'busy');
  end if;

  insert into etl_meta.nas_query (kind, upn, params, scope)
  values (p_kind, v_upn, v_params, v_scope)
  returning query_id into v_id;
  return jsonb_build_object('status', 'queued', 'query_id', v_id);
end;
$fn$;

-- 워커가 색인할 폴더(활성 허용 폴더 전부). 누가 볼 수 있는지는 여기서 정하지 않는다 —
-- 검색할 때마다 nas_query_submit 이 그 사용자의 폴더만 scope 에 적고, 워커는 그 안에서만 찾는다.
create or replace function public.nas_index_folders()
returns jsonb
language sql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object('key', f.folder_key, 'rel_path', f.rel_path, 'label', f.label_ko)
                            order by f.folder_key), '[]'::jsonb)
    from etl_meta.nas_folder_scope f
   where f.active;
$fn$;

revoke all on function public.nas_index_folders() from public, anon, authenticated;
grant execute on function public.nas_index_folders() to service_role;

-- ── 집어 간 뒤 사라진 요청 되살리기 (2026-10-02 실 NAS 검증에서 발견) ──
-- 워커가 「길게 대기」 중에 끊기면(재시작·네트워크) 중계 함수에 남은 대기가 요청을 집어 죽은 연결로 돌려준다.
-- 그 요청은 running 인 채로 아무도 처리하지 않아 사용자가 8초를 기다린 끝에 「응답 지연」을 본다.
-- 조회는 보통 1초 안에 끝나므로, **집힌 지 5초가 넘도록 안 끝난 요청은 다른 호출이 다시 집을 수 있게** 한다.
-- 조회는 읽기뿐이라 두 번 처리돼도 해가 없고, nas_query_finish 는 running 일 때만 쓰므로 먼저 끝난 쪽이 남는다.
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
