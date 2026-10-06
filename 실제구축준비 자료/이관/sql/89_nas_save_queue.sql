-- 89_nas_save_queue.sql — 에이전트 첨부 원본·생성 자료를 사내 NAS 부서 폴더에 저장(REQ-0108 · ADR-110 v3 · P4)
-- 관리자 결정(2026-10-06): 첨부 원본 + 생성 자료 모두 · 사용자가 [NAS 저장] 버튼을 누른 것만 · 부서 폴더 공유
--                          · 보존 3년, 그 뒤는 설정(nas_save_policy.after_expiry)에 따름 · NAS 외부 백업 없이 적용
--
-- 흐름(역방향 큐 — NAS 는 밖으로만 연결한다)
--   화면 [NAS 저장] → 게이트웨이(jeil-chat-lab op nas_save)가 파일을 비공개 버킷 nas-outbox 에 잠깐 올리고 이 큐에 한 줄
--   → NAS 워커가 nas_save_claim 으로 집어, 중계 함수가 준 1회용 주소로 내려받아 부서 폴더의 「AI저장/연도/」에 쓴다
--   → nas_save_finish(done) → 중계 함수가 버킷의 임시 파일을 지운다(생성 자료는 원래 자료함 사본이라 남긴다).
--   저장된 파일은 허용 폴더 안이므로 문서 색인(SQL 87)이 10분 안에 집어 「사내 문서 검색」에 나온다.
--
-- 어디에 저장하나 — **에이전트의 담당 부서 폴더**(ai_agent.dept_nm = nas_folder_scope.dept_nm, audience='dept').
--   누가 저장할 수 있는지는 게이트웨이가 에이전트 구성원 판정으로 이미 걸렀다(이 함수들은 service_role 전용).
-- 되돌리기: 89_nas_save_queue_rollback.sql

-- ── 0. 임시 보관 버킷(비공개 · 10MB) ─────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit)
values ('nas-outbox', 'nas-outbox', false, 10485760)
on conflict (id) do nothing;

-- ── 1. 보존 정책(한 줄) ───────────────────────────────────────────────────────
create table if not exists etl_meta.nas_save_policy (
  id            boolean primary key default true check (id),
  retain_years  int  not null default 3 check (retain_years between 1 and 30),
  after_expiry  text not null default 'keep' check (after_expiry in ('keep', 'delete')),  -- 보존 기간이 지난 뒤: 그대로 둠 | 자동 삭제
  max_mb        int  not null default 8 check (max_mb between 1 and 10),
  updated_by    text,
  updated_at    timestamptz not null default now()
);
insert into etl_meta.nas_save_policy (id, updated_by) values (true, 'REQ-0108 초기값(3년 · 만료 뒤 유지)')
on conflict (id) do nothing;
alter table etl_meta.nas_save_policy enable row level security;

-- ── 2. 저장 대장 겸 큐 ────────────────────────────────────────────────────────
create table if not exists etl_meta.nas_save (
  save_id      uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('attachment', 'artifact')),
  agent_key    text not null,
  upn          text not null,                 -- 저장한 사람
  saver_name   text,                          -- 표시용(부서 이름) — 직원 이름은 마스킹 제외(§1.7)
  folder_key   text not null,                 -- 대상 부서 폴더(nas_folder_scope.folder_key)
  file_name    text not null,
  size_bytes   bigint,
  sha256       text,
  src_bucket   text not null,
  src_path     text not null,
  turn_id      bigint,
  artifact_id  uuid,
  status       text not null default 'queued'
               check (status in ('queued', 'running', 'done', 'failed', 'purge', 'purged')),
  created_at   timestamptz not null default now(),
  claimed_at   timestamptz,
  finished_at  timestamptz,
  worker       text,
  rel_path     text,                          -- 부서 폴더 기준 상대 경로(워커가 채운다). 절대 경로는 어디에도 두지 않는다
  retain_until date not null,
  purge_by     text,
  error_msg    text
);
create index if not exists nas_save_status_idx on etl_meta.nas_save (status, created_at);
create index if not exists nas_save_folder_idx on etl_meta.nas_save (folder_key, created_at desc);
alter table etl_meta.nas_save enable row level security;   -- 정책 없음 → 게이트웨이·중계 함수(service_role)만

-- ── 3. 저장 요청(게이트웨이) ──────────────────────────────────────────────────
create or replace function public.nas_save_submit(
  p_upn text, p_saver text, p_agent text, p_dept text, p_kind text, p_file_name text,
  p_size bigint, p_sha256 text, p_bucket text, p_path text,
  p_turn_id bigint default null, p_artifact_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  v_upn   text := lower(coalesce(p_upn, ''));
  v_name  text := btrim(coalesce(p_file_name, ''));
  f       etl_meta.nas_folder_scope%rowtype;
  pol     etl_meta.nas_save_policy%rowtype;
  dup     etl_meta.nas_save%rowtype;
  v_id    uuid;
begin
  if v_upn = '' or coalesce(p_agent, '') = '' then
    raise exception 'nas_save_submit: upn·agent 가 비었다' using errcode = '22023';
  end if;
  if p_kind not in ('attachment', 'artifact') then
    raise exception 'nas_save_submit: 알 수 없는 종류(%)', p_kind using errcode = '22023';
  end if;
  if v_name = '' or length(v_name) > 160 or v_name ~ '[\\/:*?"<>|]' or v_name ~ '[[:cntrl:]]' or v_name ~ '^\.' then
    raise exception 'nas_save_submit: 파일 이름이 올바르지 않다' using errcode = '22023';
  end if;
  if p_bucket not in ('nas-outbox', 'agent-artifacts') or coalesce(p_path, '') = '' or p_path ~ '\.\.' then
    raise exception 'nas_save_submit: 원본 위치가 올바르지 않다' using errcode = '22023';
  end if;

  select * into pol from etl_meta.nas_save_policy where id;
  if coalesce(p_size, 0) <= 0 or p_size > pol.max_mb * 1048576 then
    return jsonb_build_object('status', 'too_big', 'max_mb', pol.max_mb);
  end if;

  select * into f from etl_meta.nas_folder_scope
   where active and audience = 'dept' and dept_nm = p_dept
   order by folder_key limit 1;
  if not found then
    return jsonb_build_object('status', 'no_folder');           -- 이 부서의 폴더가 등록돼 있지 않다
  end if;

  -- 같은 내용이 같은 폴더에 이미 있으면 다시 쓰지 않는다
  if p_sha256 is not null then
    select * into dup from etl_meta.nas_save
     where folder_key = f.folder_key and sha256 = p_sha256 and status in ('queued', 'running', 'done')
     order by created_at desc limit 1;
    if found then
      return jsonb_build_object('status', 'duplicate', 'save_id', dup.save_id, 'file_name', dup.file_name,
                                'saved_at', dup.finished_at, 'folder', f.label_ko);
    end if;
  end if;

  insert into etl_meta.nas_save (kind, agent_key, upn, saver_name, folder_key, file_name, size_bytes, sha256,
                                 src_bucket, src_path, turn_id, artifact_id, retain_until)
  values (p_kind, p_agent, v_upn, nullif(btrim(coalesce(p_saver, '')), ''), f.folder_key, v_name, p_size, p_sha256,
          p_bucket, p_path, p_turn_id, p_artifact_id, (current_date + make_interval(years => pol.retain_years))::date)
  returning save_id into v_id;

  return jsonb_build_object('status', 'queued', 'save_id', v_id, 'folder', f.label_ko,
    'retain_years', pol.retain_years,
    'worker_online', exists (select 1 from etl_meta.nas_query_worker where seen_at > now() - interval '60 seconds'));
end;
$fn$;

-- ── 4. 워커: 한 건 집기 ───────────────────────────────────────────────────────
create or replace function public.nas_save_claim(p_worker text)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  s etl_meta.nas_save%rowtype;
  f etl_meta.nas_folder_scope%rowtype;
begin
  if p_worker is null or p_worker !~ '^[A-Za-z0-9_.-]{1,60}$' then
    raise exception 'nas_save_claim: 워커 이름이 올바르지 않다' using errcode = '22023';
  end if;
  select * into s from etl_meta.nas_save
   where status = 'queued' or (status = 'running' and claimed_at < now() - interval '2 minutes')
   order by created_at
   limit 1
   for update skip locked;
  if not found then
    return null;
  end if;
  select * into f from etl_meta.nas_folder_scope where folder_key = s.folder_key and active;
  if not found then
    update etl_meta.nas_save set status = 'failed', finished_at = now(), error_msg = '대상 폴더가 등록에서 빠졌다'
     where save_id = s.save_id;
    return null;
  end if;
  update etl_meta.nas_save set status = 'running', claimed_at = now(), worker = p_worker where save_id = s.save_id;
  return jsonb_build_object('save_id', s.save_id, 'kind', s.kind, 'file_name', s.file_name, 'size_bytes', s.size_bytes,
    'sha256', s.sha256, 'folder_key', f.folder_key, 'folder_rel', f.rel_path, 'saved_on', to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD'));
end;
$fn$;

-- 중계 함수가 1회용 내려받기 주소를 만들 때 쓴다 — 그 워커가 지금 처리 중인 건만 알려 준다
create or replace function public.nas_save_source(p_save_id uuid, p_worker text)
returns jsonb
language sql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
  select jsonb_build_object('bucket', src_bucket, 'path', src_path)
    from etl_meta.nas_save
   where save_id = p_save_id and status = 'running' and worker = p_worker;
$fn$;

-- ── 5. 워커: 결과 되쓰기 ──────────────────────────────────────────────────────
create or replace function public.nas_save_finish(
  p_save_id uuid, p_status text, p_rel_path text default null, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  s etl_meta.nas_save%rowtype;
begin
  if p_status not in ('done', 'failed') then
    raise exception 'nas_save_finish: 알 수 없는 상태(%)', p_status using errcode = '22023';
  end if;
  if p_status = 'done' and (coalesce(p_rel_path, '') = '' or p_rel_path ~ '\.\.' or p_rel_path ~ '^[\\/]' or length(p_rel_path) > 400) then
    raise exception 'nas_save_finish: 저장 경로가 올바르지 않다' using errcode = '22023';
  end if;
  update etl_meta.nas_save
     set status = p_status, finished_at = now(),
         rel_path = case when p_status = 'done' then replace(p_rel_path, '\', '/') else rel_path end,
         error_msg = case when p_status = 'failed' then left(coalesce(p_error, '실패'), 300) else null end
   where save_id = p_save_id and status = 'running'
  returning * into s;
  if not found then
    return jsonb_build_object('ok', false);
  end if;
  -- 임시 버킷의 파일은 끝나면(성공·실패 모두) 지운다 — 지우는 일은 중계 함수가 한다
  return jsonb_build_object('ok', true, 'status', s.status,
    'cleanup', case when s.src_bucket = 'nas-outbox' then jsonb_build_object('bucket', s.src_bucket, 'path', s.src_path) end);
end;
$fn$;

-- ── 6. 목록(게이트웨이) — 부서 폴더 단위로 공유된다 ───────────────────────────
create or replace function public.nas_save_list(p_dept text, p_limit int default 100)
returns jsonb
language sql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
  with f as (select folder_key, label_ko from etl_meta.nas_folder_scope
              where active and audience = 'dept' and dept_nm = p_dept order by folder_key limit 1),
       pol as (select retain_years, after_expiry, max_mb from etl_meta.nas_save_policy where id)
  select jsonb_build_object(
    'folder', (select label_ko from f),
    'policy', (select to_jsonb(pol) from pol),
    'worker_online', exists (select 1 from etl_meta.nas_query_worker where seen_at > now() - interval '60 seconds'),
    'items', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select s.save_id, s.kind, s.file_name, s.size_bytes, s.status, s.created_at, s.finished_at, s.rel_path,
               s.retain_until, s.upn, s.saver_name, s.error_msg
          from etl_meta.nas_save s
         where s.folder_key = (select folder_key from f) and s.status <> 'purged'
         order by s.created_at desc
         limit greatest(1, least(coalesce(p_limit, 100), 300))) x), '[]'::jsonb));
$fn$;

-- ── 7. 삭제 요청(게이트웨이) — 본인이 저장한 것 또는 관리 권한자 ─────────────
create or replace function public.nas_save_request_purge(p_save_id uuid, p_upn text, p_can_manage boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  s etl_meta.nas_save%rowtype;
begin
  select * into s from etl_meta.nas_save where save_id = p_save_id for update;
  if not found then return jsonb_build_object('status', 'missing'); end if;
  if s.upn <> lower(coalesce(p_upn, '')) and not coalesce(p_can_manage, false) then
    return jsonb_build_object('status', 'denied');
  end if;
  if s.status in ('failed', 'queued') then
    update etl_meta.nas_save set status = 'purged', finished_at = now(), purge_by = lower(p_upn) where save_id = p_save_id;
    return jsonb_build_object('status', 'purged',
      'cleanup', case when s.src_bucket = 'nas-outbox' then jsonb_build_object('bucket', s.src_bucket, 'path', s.src_path) end);
  end if;
  if s.status <> 'done' then return jsonb_build_object('status', 'busy'); end if;
  update etl_meta.nas_save set status = 'purge', purge_by = lower(p_upn) where save_id = p_save_id;
  return jsonb_build_object('status', 'purge');
end;
$fn$;

-- ── 8. 워커: 지울 것 받기 · 지운 결과 ─────────────────────────────────────────
-- 지울 것 = 삭제 요청된 것 + (정책이 delete 일 때) 보존 기간이 지난 것
create or replace function public.nas_save_purge_list(p_limit int default 20)
returns jsonb
language sql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object('save_id', s.save_id, 'folder_key', s.folder_key,
                                               'folder_rel', f.rel_path, 'rel_path', s.rel_path)), '[]'::jsonb)
    from (select * from etl_meta.nas_save
           where status = 'purge'
              or (status = 'done' and retain_until < current_date
                  and (select after_expiry from etl_meta.nas_save_policy where id) = 'delete')
           order by created_at
           limit greatest(1, least(coalesce(p_limit, 20), 100))) s
    join etl_meta.nas_folder_scope f on f.folder_key = s.folder_key;
$fn$;

create or replace function public.nas_save_purged(p_save_id uuid, p_ok boolean, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
begin
  if coalesce(p_ok, false) then
    update etl_meta.nas_save
       set status = 'purged', finished_at = now(), purge_by = coalesce(purge_by, '보존 기간 만료'), error_msg = null
     where save_id = p_save_id and status in ('purge', 'done');
  else
    update etl_meta.nas_save set error_msg = left('삭제 실패: ' || coalesce(p_error, ''), 300)
     where save_id = p_save_id and status in ('purge', 'done');
  end if;
  return jsonb_build_object('ok', found);
end;
$fn$;

-- ── 9. 권한 — 전부 service_role 전용 ──────────────────────────────────────────
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('nas_save_submit', 'nas_save_claim', 'nas_save_source',
              'nas_save_finish', 'nas_save_list', 'nas_save_request_purge', 'nas_save_purge_list', 'nas_save_purged')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;
