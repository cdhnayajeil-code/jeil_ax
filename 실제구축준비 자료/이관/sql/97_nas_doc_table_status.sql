-- 97 — NAS 표 구조 판독·판독 상태 조회(REQ-0117 S1 · CLAUDE.md §19 · 기준 문서 12/10)
--
-- 무엇
--   86·87 의 조회 큐에 두 종류를 더한다.
--   · doc_table    — 엑셀·CSV 한 건을 표 구조(시트 이름·머리글·열·행 번호·날짜 복원)로 읽는다.
--                    색인용 글자는 셀을 " | " 로 이어 붙여 열 위치가 사라지므로, 표로 읽는 길을 따로 둔다.
--   · index_status — 허용 폴더 안 파일의 판독 상태(읽힘 / 못 읽음·사유). **내용은 싣지 않는다** — 보관함 화면이 쓴다.
--
-- 바뀌지 않는 것
--   · 값은 어디에도 쌓지 않는다. 87 과 같이 조회 큐에 잠깐 머물다 게이트웨이가 읽으면 지워진다(D-95 유지).
--     문서에서 뽑은 값을 쌓는 전용 구역(D-144)은 이 파일이 아니라 S2 의 별도 정본 SQL 이 만든다.
--   · 범위 계산은 file_list·doc_search·doc_read 와 **같은 식**(허용 폴더 ∩ 부서) — 도구·워커에서 넓히지 않는다(§17.7 ⑥).
--   · ERP 미러(erp_ro)는 건드리지 않는다(§4.7).
--
-- 함께 고치는 곳(§17.7 ⑥ — 세 곳): 이 파일 · 워커 nas_worker.py handle_query(n1.9) · 게이트웨이 modules/nas/_nas_query.ts
-- 되돌리기: 97_nas_doc_table_status_rollback.sql

alter table etl_meta.nas_query drop constraint if exists nas_query_kind_check;
alter table etl_meta.nas_query add constraint nas_query_kind_check
  check (kind in ('file_list', 'turn_history', 'doc_search', 'doc_read', 'doc_table', 'index_status'));

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
  if p_kind not in ('file_list', 'turn_history', 'doc_search', 'doc_read', 'doc_table', 'index_status') then
    raise exception 'nas_query_submit: 알 수 없는 종류(%)', p_kind using errcode = '22023';
  end if;
  if octet_length(v_params::text) > 4000 then
    raise exception 'nas_query_submit: 인자가 너무 크다' using errcode = '22023';
  end if;
  if p_kind = 'doc_search' and coalesce(btrim(v_params ->> 'q'), '') = '' then
    raise exception 'nas_query_submit: 검색어(q)가 비었다' using errcode = '22023';
  end if;
  if p_kind in ('doc_read', 'doc_table') and coalesce(v_params ->> 'doc', '') !~ '^[a-z0-9_]{1,40}:[0-9]{1,12}$' then
    raise exception 'nas_query_submit: 문서 번호(doc) 형식이 올바르지 않다' using errcode = '22023';
  end if;
  if p_kind = 'index_status' and coalesce(v_params ->> 'under', '') ~ '(^|/)\.\.?(/|$)|\\|^/|:' then
    raise exception 'nas_query_submit: 폴더 경로(under)가 올바르지 않다' using errcode = '22023';
  end if;

  if p_kind in ('file_list', 'doc_search', 'doc_read', 'doc_table', 'index_status') then
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

-- 권한은 86 에서 준 그대로다(create or replace 는 권한을 보존한다). 혹시 새로 만들어진 환경을 위해 다시 잠근다.
revoke all on function public.nas_query_submit(text, text, jsonb, text[], boolean) from public, anon, authenticated;
grant execute on function public.nas_query_submit(text, text, jsonb, text[], boolean) to service_role;
