-- 86 — NAS 실시간 조회 큐 (REQ-0103 · ADR-110 v3 · P2 · 2026-10-02)
--
-- 무엇
--   에이전트(게이트웨이)가 「NAS 에서 이것 좀 찾아 줘」를 한 줄 넣으면, 사내 NAS 워커가 물고 있던 연결로
--   즉시 받아 처리하고 결과를 되쓴다. 적재 큐(82)와 방향이 반대다 — 그래서 표를 따로 둔다.
--     게이트웨이 → nas_query_submit → [nas_query] ← nas_query_claim(워커, 브리지가 길게 대기) → nas_query_finish
--     게이트웨이 ← nas_query_poll(0.3초 간격, 도구 자체 상한 8초)
--
-- 왜 82 의 nas_request 를 재사용하지 않는가
--   ① nas_request 는 「밤에 통째로 내보내기」용이라 60초 쿨다운·4시간 만료가 걸려 있다 — 초 단위 조회에 맞지 않는다
--   ② 사내 PC 예약작업(적재 전용)은 심박은 남기지만 조회에는 답하지 않는다. 같은 심박으로 가동을 판정하면
--      「워커 있음」으로 오판해 사용자가 8초를 기다린다. 그래서 **조회에 답하는 워커의 생존 신호를 따로** 둔다.
--
-- 권한(§5.4 — 판정은 서버에서)
--   · 볼 수 있는 폴더는 **이 함수가 계산해 요청 행에 적는다**(허용 폴더 등록제 ∩ 부서). 워커·모델이 정하지 않는다.
--   · 허용 폴더가 하나도 등록돼 있지 않으면 전부 거부한다(fail-closed — 기존 문서 검색 ai_document_scope 와 같은 원칙).
--   · 과거 대화는 **본인 것만**. 요청 행의 scope.upn 을 서버가 박는다.
--   · 결과(파일 이름·대화 발췌)는 큐에 잠깐만 머문다 — 게이트웨이가 읽으면 지운다. 누가 무엇을 찾았는지(요청)만 남는다.
--   · 전부 service_role 전용. anon·authenticated 는 표도 함수도 못 쓴다.
--
-- 되돌리기: 86_nas_query_queue_rollback.sql

-- ── 1. 허용 폴더(조회·색인 대상의 단일 출처) ─────────────
create table if not exists etl_meta.nas_folder_scope (
  folder_key  text primary key check (folder_key ~ '^[a-z0-9_]{1,40}$'),
  -- 문서 루트 기준 상대경로. 절대경로·역슬래시·상위 이동(..)은 등재 자체가 안 된다. NAS 주소·공유 이름은 여기에 없다.
  rel_path    text not null check (
                length(rel_path) between 1 and 300
            and rel_path !~ '^[/\\]' and rel_path !~ '\\' and rel_path !~ ':'
            and rel_path !~ '(^|/)\.\.?(/|$)'),
  label_ko    text not null,
  audience    text not null check (audience in ('all','dept')),   -- all = 전사공유 · dept = 해당 부서만
  dept_nm     text,                                              -- perm_effective 의 부서명과 같은 표기
  active      boolean not null default true,
  approved_by text,
  approved_at timestamptz not null default now(),
  note        text,
  constraint nas_folder_scope_dept check (audience = 'all' or dept_nm is not null)
);
alter table etl_meta.nas_folder_scope enable row level security;
revoke all on etl_meta.nas_folder_scope from anon, authenticated;

comment on table etl_meta.nas_folder_scope is
  '에이전트가 NAS 에서 조회할 수 있는 폴더의 허용 목록(단일 출처). 등록이 없으면 전부 거부한다. 급여·인사평가 폴더는 등록하지 않는다(§1.7).';

-- ── 2. 조회에 답하는 워커의 생존 신호 ────────────────────
create table if not exists etl_meta.nas_query_worker (
  worker  text primary key,
  seen_at timestamptz not null default now()
);
alter table etl_meta.nas_query_worker enable row level security;
revoke all on etl_meta.nas_query_worker from anon, authenticated;

-- ── 3. 조회 큐 ───────────────────────────────────────────
create table if not exists etl_meta.nas_query (
  query_id     uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('file_list','turn_history')),
  upn          text not null,
  params       jsonb not null default '{}'::jsonb,
  scope        jsonb not null default '{}'::jsonb,      -- 서버가 계산한 범위(폴더 목록·본인 upn)
  status       text not null default 'queued' check (status in ('queued','running','done','failed','expired')),
  created_at   timestamptz not null default now(),
  claimed_at   timestamptz,
  finished_at  timestamptz,
  delivered_at timestamptz,
  worker       text,
  rows_n       int,
  result       jsonb,                                   -- 전달되면 null 로 지운다
  error_msg    text
);
create index if not exists nas_query_queue_ix on etl_meta.nas_query (status, created_at);
alter table etl_meta.nas_query enable row level security;
revoke all on etl_meta.nas_query from anon, authenticated;

comment on table etl_meta.nas_query is
  'NAS 실시간 조회 큐. 결과(result)는 게이트웨이가 읽으면 지운다 — 요청 이력(누가·언제·무엇을·몇 건)만 남는다. 90일 지난 행은 claim 때 정리한다.';

-- ── 4. 게이트웨이용 ──────────────────────────────────────
-- 요청 넣기. p_depts·p_is_admin 은 게이트웨이가 perm_effective 로 이미 판정한 값이다(서버 코드 → 서버 함수).
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
  if p_kind not in ('file_list', 'turn_history') then
    raise exception 'nas_query_submit: 알 수 없는 종류(%)', p_kind using errcode = '22023';
  end if;
  if octet_length(v_params::text) > 4000 then
    raise exception 'nas_query_submit: 인자가 너무 크다' using errcode = '22023';
  end if;

  if p_kind = 'file_list' then
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

  -- 조회에 답할 워커가 없으면 줄을 세우지 않는다 — 사용자를 기다리게 하지 않는다
  if not exists (select 1 from etl_meta.nas_query_worker where seen_at > now() - interval '60 seconds') then
    return jsonb_build_object('status', 'offline');
  end if;

  -- 한 사람이 1분에 30건을 넘기면 막는다(모델이 같은 도구를 반복 호출하는 사고 대비)
  if (select count(*) from etl_meta.nas_query where upn = v_upn and created_at > now() - interval '1 minute') >= 30 then
    return jsonb_build_object('status', 'busy');
  end if;

  insert into etl_meta.nas_query (kind, upn, params, scope)
  values (p_kind, v_upn, v_params, v_scope)
  returning query_id into v_id;
  return jsonb_build_object('status', 'queued', 'query_id', v_id);
end;
$fn$;

-- 결과 받기. 끝났으면 결과를 돌려주고 **지운다**(한 번만 전달).
create or replace function public.nas_query_poll(p_query_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  q etl_meta.nas_query%rowtype;
begin
  select * into q from etl_meta.nas_query where query_id = p_query_id for update;
  if not found then
    return jsonb_build_object('status', 'missing');
  end if;
  if q.status = 'queued' and q.created_at < now() - interval '30 seconds' then
    update etl_meta.nas_query set status = 'expired', finished_at = now() where query_id = p_query_id;
    return jsonb_build_object('status', 'expired');
  end if;
  if q.status = 'done' then
    update etl_meta.nas_query set result = null, delivered_at = coalesce(delivered_at, now()) where query_id = p_query_id;
    return jsonb_build_object('status', 'done', 'rows', q.rows_n, 'result', q.result,
                              'ms', round(extract(epoch from (q.finished_at - q.created_at)) * 1000));
  end if;
  if q.status = 'failed' then
    return jsonb_build_object('status', 'failed', 'error', q.error_msg);
  end if;
  return jsonb_build_object('status', q.status);
end;
$fn$;

-- ── 5. 워커용(브리지 경유) ───────────────────────────────
-- 한 건 집기. 없으면 null — 브리지가 0.3초마다 다시 부르며 길게 기다린다.
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
  -- 생존 신호 — 20초에 한 번만 쓴다(0.3초마다 불리므로)
  insert into etl_meta.nas_query_worker as w (worker, seen_at) values (p_worker, now())
  on conflict (worker) do update set seen_at = now() where w.seen_at < now() - interval '20 seconds';

  select * into q from etl_meta.nas_query
   where status = 'queued' and created_at > now() - interval '30 seconds'
   order by created_at
   limit 1
   for update skip locked;
  if not found then
    -- 가끔 청소: 오래 기다린 요청 만료 · 멈춘 실행 실패 처리 · 90일 지난 이력 삭제
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

create or replace function public.nas_query_finish(
  p_query_id uuid, p_status text, p_result jsonb default null, p_rows int default 0, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
begin
  if p_status not in ('done', 'failed') then
    raise exception 'nas_query_finish: 상태는 done·failed 뿐이다' using errcode = '22023';
  end if;
  if p_status = 'done' and octet_length(coalesce(p_result, '{}'::jsonb)::text) > 200000 then
    update etl_meta.nas_query set status = 'failed', finished_at = now(), error_msg = '결과가 너무 크다'
     where query_id = p_query_id and status = 'running';
    return;
  end if;
  update etl_meta.nas_query
     set status = p_status, finished_at = now(), rows_n = coalesce(p_rows, 0),
         result = case when p_status = 'done' then p_result end,
         error_msg = left(p_error, 500)
   where query_id = p_query_id and status = 'running';
end;
$fn$;

revoke all on function public.nas_query_submit(text, text, jsonb, text[], boolean) from public, anon, authenticated;
revoke all on function public.nas_query_poll(uuid) from public, anon, authenticated;
revoke all on function public.nas_query_claim(text) from public, anon, authenticated;
revoke all on function public.nas_query_finish(uuid, text, jsonb, int, text) from public, anon, authenticated;
grant execute on function public.nas_query_submit(text, text, jsonb, text[], boolean) to service_role;
grant execute on function public.nas_query_poll(uuid) to service_role;
grant execute on function public.nas_query_claim(text) to service_role;
grant execute on function public.nas_query_finish(uuid, text, jsonb, int, text) to service_role;
