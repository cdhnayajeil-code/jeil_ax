-- 90_nas_save_manage.sql — 부서 NAS 보관함 관리 3종: 폴더 만들기 · 내려받기 · 즉시 삭제 (REQ-0108 · 관리자 지시 2026-10-06)
-- 89(저장 큐) 위에 얹는다. 전부 service_role 전용 — 누가 무엇을 할 수 있는지는 게이트웨이가 에이전트 구성원 판정으로 거른다.
--
--  ① 폴더: 부서 폴더의 「AI저장/<폴더 이름>/」 — 사용자가 이름을 붙여 만든다. 폴더를 고르지 않으면 종전대로 「AI저장/<연도>/」.
--     폴더는 대장(nas_save_folder)에 먼저 생기고, NAS 의 실제 폴더는 첫 파일이 저장될 때 만들어진다.
--  ② 내려받기: NAS → 비공개 버킷 nas-outbox 의 `_fetch/…` 로 잠깐 올림(워커가 1회용 올리기 주소로) → 사용자에게 2분짜리 주소.
--     NAS 는 여전히 밖으로만 연결한다. 올린 사본은 10분 뒤 게이트웨이가 지운다.
--  ③ 즉시 삭제: 워커가 물고 있는 대기(nas_work_claim)에 「지울 것이 있다」는 신호를 실어 보낸다 → 10분 주기를 기다리지 않는다.
--
-- 워커 n1.7 부터 nas_work_claim 하나로 저장·내려받기·삭제 신호를 받는다. 이전 워커(n1.6)가 쓰는 nas_save_claim 은
-- 그대로 두되 **폴더가 지정된 저장은 집지 않게** 한다(옛 워커는 폴더를 몰라 연도 폴더에 써 버린다).
-- 되돌리기: 90_nas_save_manage_rollback.sql

-- ── 1. 표 ─────────────────────────────────────────────────────────────────────
alter table etl_meta.nas_save add column if not exists subdir text;      -- 사용자 폴더 이름(없으면 연도 폴더)

create table if not exists etl_meta.nas_save_folder (
  folder_key  text not null,                -- 부서 폴더(nas_folder_scope.folder_key)
  name        text not null,                -- 「AI저장」 바로 아래 한 단계 이름
  created_by  text not null,
  created_at  timestamptz not null default now(),
  primary key (folder_key, name)
);
alter table etl_meta.nas_save_folder enable row level security;

create table if not exists etl_meta.nas_fetch (
  fetch_id    uuid primary key default gen_random_uuid(),
  save_id     uuid not null,
  upn         text not null,
  status      text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cleaned')),
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  finished_at timestamptz,
  worker      text,
  out_path    text not null,                -- nas-outbox 안의 임시 위치(_fetch/…)
  error_msg   text
);
create index if not exists nas_fetch_status_idx on etl_meta.nas_fetch (status, created_at);
alter table etl_meta.nas_fetch enable row level security;

-- ── 2. 폴더 이름 검사(한 곳) ──────────────────────────────────────────────────
-- 한 단계 이름만 · 경로·금지 글자 없음 · 숫자 4자리(연도 폴더와 겹침) 금지 · 민감 낱말 금지(색인·게이트웨이와 같은 목록)
create or replace function etl_meta.nas_subdir_ok(p_name text)
returns boolean
language sql
immutable
as $fn$
  select p_name is not null
     and p_name = btrim(p_name)
     and length(p_name) between 1 and 40
     and p_name !~ '[\\/:*?"<>|]'
     and p_name !~ '[[:cntrl:]]'
     and p_name !~ '^\.'
     and p_name !~ '\.$'
     and p_name !~ '^[0-9]{4}$'
     and p_name !~* '급여|연봉|임금대장|인사평가|고과|주민등록|통장사본|신분증';
$fn$;

create or replace function public.nas_save_folder_create(p_dept text, p_name text, p_upn text)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  f      etl_meta.nas_folder_scope%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
begin
  select * into f from etl_meta.nas_folder_scope where active and audience = 'dept' and dept_nm = p_dept order by folder_key limit 1;
  if not found then return jsonb_build_object('status', 'no_folder'); end if;
  if not etl_meta.nas_subdir_ok(v_name) then return jsonb_build_object('status', 'bad_name'); end if;
  if exists (select 1 from etl_meta.nas_save_folder where folder_key = f.folder_key and lower(name) = lower(v_name)) then
    return jsonb_build_object('status', 'exists');
  end if;
  if (select count(*) from etl_meta.nas_save_folder where folder_key = f.folder_key) >= 100 then
    return jsonb_build_object('status', 'too_many');
  end if;
  insert into etl_meta.nas_save_folder (folder_key, name, created_by) values (f.folder_key, v_name, lower(coalesce(p_upn, '')));
  return jsonb_build_object('status', 'ok', 'name', v_name);
end;
$fn$;

-- 빈 폴더만 지운다(만든 사람 또는 관리 권한자). 안에 보관 중·처리 중인 파일이 있으면 거부.
create or replace function public.nas_save_folder_delete(p_dept text, p_name text, p_upn text, p_can_manage boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  f  etl_meta.nas_folder_scope%rowtype;
  d  etl_meta.nas_save_folder%rowtype;
begin
  select * into f from etl_meta.nas_folder_scope where active and audience = 'dept' and dept_nm = p_dept order by folder_key limit 1;
  if not found then return jsonb_build_object('status', 'no_folder'); end if;
  select * into d from etl_meta.nas_save_folder where folder_key = f.folder_key and name = p_name for update;
  if not found then return jsonb_build_object('status', 'missing'); end if;
  if d.created_by <> lower(coalesce(p_upn, '')) and not coalesce(p_can_manage, false) then
    return jsonb_build_object('status', 'denied');
  end if;
  if exists (select 1 from etl_meta.nas_save where folder_key = f.folder_key and subdir = p_name
                and status in ('queued', 'running', 'done', 'purge')) then
    return jsonb_build_object('status', 'not_empty');
  end if;
  delete from etl_meta.nas_save_folder where folder_key = f.folder_key and name = p_name;
  return jsonb_build_object('status', 'ok');
end;
$fn$;

-- ── 3. 저장 요청 — 폴더 지정 인자 추가(시그니처가 바뀌므로 옛 것을 지운다) ─────
drop function if exists public.nas_save_submit(text, text, text, text, text, text, bigint, text, text, text, bigint, uuid);

create or replace function public.nas_save_submit(
  p_upn text, p_saver text, p_agent text, p_dept text, p_kind text, p_file_name text,
  p_size bigint, p_sha256 text, p_bucket text, p_path text,
  p_turn_id bigint default null, p_artifact_id uuid default null, p_subdir text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  v_upn   text := lower(coalesce(p_upn, ''));
  v_name  text := btrim(coalesce(p_file_name, ''));
  v_sub   text := nullif(btrim(coalesce(p_subdir, '')), '');
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
    return jsonb_build_object('status', 'no_folder');
  end if;

  -- 폴더를 골랐으면 대장에 있는 폴더여야 한다(이름을 지어 보내 아무 데나 쓰게 하지 않는다)
  if v_sub is not null and not exists (select 1 from etl_meta.nas_save_folder where folder_key = f.folder_key and name = v_sub) then
    return jsonb_build_object('status', 'no_subdir');
  end if;

  if p_sha256 is not null then
    select * into dup from etl_meta.nas_save
     where folder_key = f.folder_key and sha256 = p_sha256 and status in ('queued', 'running', 'done')
     order by created_at desc limit 1;
    if found then
      return jsonb_build_object('status', 'duplicate', 'save_id', dup.save_id, 'file_name', dup.file_name,
                                'saved_at', dup.finished_at, 'folder', f.label_ko, 'subdir', dup.subdir);
    end if;
  end if;

  insert into etl_meta.nas_save (kind, agent_key, upn, saver_name, folder_key, file_name, size_bytes, sha256,
                                 src_bucket, src_path, turn_id, artifact_id, retain_until, subdir)
  values (p_kind, p_agent, v_upn, nullif(btrim(coalesce(p_saver, '')), ''), f.folder_key, v_name, p_size, p_sha256,
          p_bucket, p_path, p_turn_id, p_artifact_id, (current_date + make_interval(years => pol.retain_years))::date, v_sub)
  returning save_id into v_id;

  return jsonb_build_object('status', 'queued', 'save_id', v_id, 'folder', f.label_ko, 'subdir', v_sub,
    'retain_years', pol.retain_years,
    'worker_online', exists (select 1 from etl_meta.nas_query_worker where seen_at > now() - interval '60 seconds'));
end;
$fn$;

-- ── 4. 저장 한 건 집기(공통) — p_with_subdir=false 면 폴더 지정 건은 건너뛴다(옛 워커용) ──
create or replace function etl_meta.nas_save_take(p_worker text, p_with_subdir boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  s etl_meta.nas_save%rowtype;
  f etl_meta.nas_folder_scope%rowtype;
begin
  select * into s from etl_meta.nas_save
   where (status = 'queued' or (status = 'running' and claimed_at < now() - interval '2 minutes'))
     and (p_with_subdir or subdir is null)
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
  return jsonb_build_object('job', 'save', 'save_id', s.save_id, 'kind', s.kind, 'file_name', s.file_name,
    'size_bytes', s.size_bytes, 'sha256', s.sha256, 'folder_key', f.folder_key, 'folder_rel', f.rel_path,
    'subdir', s.subdir, 'saved_on', to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD'));
end;
$fn$;
revoke all on function etl_meta.nas_save_take(text, boolean) from public;

create or replace function public.nas_save_claim(p_worker text)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
begin
  if p_worker is null or p_worker !~ '^[A-Za-z0-9_.-]{1,60}$' then
    raise exception 'nas_save_claim: 워커 이름이 올바르지 않다' using errcode = '22023';
  end if;
  return etl_meta.nas_save_take(p_worker, false);
end;
$fn$;

-- ── 5. 워커 n1.7: 일감 하나 — 저장 → 내려받기 → 「지울 것 있음」 신호 순 ───────
create or replace function public.nas_work_claim(p_worker text)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  j  jsonb;
  ft etl_meta.nas_fetch%rowtype;
  s  etl_meta.nas_save%rowtype;
  f  etl_meta.nas_folder_scope%rowtype;
begin
  if p_worker is null or p_worker !~ '^[A-Za-z0-9_.-]{1,60}$' then
    raise exception 'nas_work_claim: 워커 이름이 올바르지 않다' using errcode = '22023';
  end if;

  j := etl_meta.nas_save_take(p_worker, true);
  if j is not null then return j; end if;

  select * into ft from etl_meta.nas_fetch
   where created_at > now() - interval '2 minutes'
     and (status = 'queued' or (status = 'running' and claimed_at < now() - interval '30 seconds'))
   order by created_at
   limit 1
   for update skip locked;
  if found then
    select * into s from etl_meta.nas_save where save_id = ft.save_id and status = 'done';
    if found then
      select * into f from etl_meta.nas_folder_scope where folder_key = s.folder_key and active;
    end if;
    if s.save_id is null or f.folder_key is null or s.rel_path is null then
      update etl_meta.nas_fetch set status = 'failed', finished_at = now(), error_msg = '보관된 파일이 아니다' where fetch_id = ft.fetch_id;
      return null;
    end if;
    update etl_meta.nas_fetch set status = 'running', claimed_at = now(), worker = p_worker where fetch_id = ft.fetch_id;
    return jsonb_build_object('job', 'fetch', 'fetch_id', ft.fetch_id, 'folder_key', f.folder_key, 'folder_rel', f.rel_path,
                              'rel_path', s.rel_path, 'size_bytes', s.size_bytes);
  end if;

  -- 삭제 요청이 있으면 알린다. 한 번 실패한 건(error_msg 있음)은 신호에서 뺀다 — 10분 주기 정리가 다시 시도한다(헛돌기 방지)
  if exists (select 1 from etl_meta.nas_save where status = 'purge' and error_msg is null) then
    return jsonb_build_object('job', 'purge');
  end if;

  if random() < 0.02 then
    update etl_meta.nas_fetch set status = 'failed', finished_at = now(), error_msg = '시간 초과'
     where status in ('queued', 'running') and created_at < now() - interval '2 minutes';
    delete from etl_meta.nas_fetch where created_at < now() - interval '30 days';
  end if;
  return null;
end;
$fn$;

-- ── 6. 내려받기 ───────────────────────────────────────────────────────────────
-- 요청(게이트웨이) — 이 부서 폴더에 「보관됨」인 파일만
create or replace function public.nas_fetch_submit(p_save_id uuid, p_upn text, p_dept text)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  s    etl_meta.nas_save%rowtype;
  v_id uuid := gen_random_uuid();
begin
  select s2.* into s from etl_meta.nas_save s2
    join etl_meta.nas_folder_scope f on f.folder_key = s2.folder_key and f.active and f.audience = 'dept' and f.dept_nm = p_dept
   where s2.save_id = p_save_id and s2.status = 'done';
  if not found then return jsonb_build_object('status', 'missing'); end if;
  if not exists (select 1 from etl_meta.nas_query_worker where seen_at > now() - interval '60 seconds') then
    return jsonb_build_object('status', 'offline');
  end if;
  if (select count(*) from etl_meta.nas_fetch where upn = lower(p_upn) and created_at > now() - interval '1 minute') >= 20 then
    return jsonb_build_object('status', 'busy');
  end if;
  insert into etl_meta.nas_fetch (fetch_id, save_id, upn, out_path)
  values (v_id, s.save_id, lower(coalesce(p_upn, '')), '_fetch/' || v_id::text);
  return jsonb_build_object('status', 'queued', 'fetch_id', v_id, 'file_name', s.file_name, 'size_bytes', s.size_bytes);
end;
$fn$;

-- 중계 함수가 1회용 올리기 주소를 만들 때 — 그 워커가 지금 처리 중인 건만
create or replace function public.nas_fetch_source(p_fetch_id uuid, p_worker text)
returns jsonb
language sql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
  select jsonb_build_object('bucket', 'nas-outbox', 'path', out_path)
    from etl_meta.nas_fetch where fetch_id = p_fetch_id and status = 'running' and worker = p_worker;
$fn$;

create or replace function public.nas_fetch_finish(p_fetch_id uuid, p_status text, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
begin
  if p_status not in ('done', 'failed') then
    raise exception 'nas_fetch_finish: 알 수 없는 상태(%)', p_status using errcode = '22023';
  end if;
  update etl_meta.nas_fetch
     set status = p_status, finished_at = now(),
         error_msg = case when p_status = 'failed' then left(coalesce(p_error, '실패'), 300) end
   where fetch_id = p_fetch_id and status = 'running';
  return jsonb_build_object('ok', found);
end;
$fn$;

-- 게이트웨이가 기다리며 확인 — 요청한 본인 것만
create or replace function public.nas_fetch_status(p_fetch_id uuid, p_upn text)
returns jsonb
language sql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
  select jsonb_build_object('status', ft.status, 'path', ft.out_path, 'error', ft.error_msg, 'file_name', s.file_name)
    from etl_meta.nas_fetch ft join etl_meta.nas_save s on s.save_id = ft.save_id
   where ft.fetch_id = p_fetch_id and ft.upn = lower(p_upn);
$fn$;

-- 다 쓴 임시 사본 목록(10분 지난 것) — 게이트웨이가 버킷에서 지우고 cleaned 로 맺는다
create or replace function public.nas_fetch_sweep()
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  v jsonb;
begin
  with x as (
    update etl_meta.nas_fetch set status = 'cleaned'
     where fetch_id in (select fetch_id from etl_meta.nas_fetch
                         where status in ('done', 'failed') and created_at < now() - interval '10 minutes' limit 50)
    returning out_path)
  select coalesce(jsonb_agg(out_path), '[]'::jsonb) into v from x;
  return v;
end;
$fn$;

-- ── 7. 목록 — 폴더 목록과 파일의 폴더 이름을 함께 ─────────────────────────────
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
    'folders', coalesce((select jsonb_agg(jsonb_build_object('name', d.name, 'created_by', d.created_by) order by d.name)
                           from etl_meta.nas_save_folder d where d.folder_key = (select folder_key from f)), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select s.save_id, s.kind, s.file_name, s.size_bytes, s.status, s.created_at, s.finished_at, s.rel_path,
               s.retain_until, s.upn, s.saver_name, s.error_msg, s.subdir
          from etl_meta.nas_save s
         where s.folder_key = (select folder_key from f) and s.status <> 'purged'
         order by s.created_at desc
         limit greatest(1, least(coalesce(p_limit, 100), 300))) x), '[]'::jsonb));
$fn$;

-- ── 8. 권한 — 전부 service_role 전용 ──────────────────────────────────────────
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('nas_save_submit', 'nas_save_claim', 'nas_work_claim', 'nas_save_list',
              'nas_save_folder_create', 'nas_save_folder_delete', 'nas_fetch_submit', 'nas_fetch_source', 'nas_fetch_finish',
              'nas_fetch_status', 'nas_fetch_sweep')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;
