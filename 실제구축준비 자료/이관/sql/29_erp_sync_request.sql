-- 29. 「데이터 업데이트」 요청 큐 (etl_meta.sync_request) + 러너 하트비트
-- 정본. 적용 마이그레이션: erp_sync_request_v1 (2026-08-20) → erp_sync_request_sensitive_v1 (2026-08-20, 급여 포함 옵션)
-- 화면: app/erp-status.html 「🔄 데이터 업데이트」 버튼 · 러너: 10_ERP_DB연계/etl/etl_watch.py
--
-- 왜 큐인가: ERP(UNIERP) MSSQL은 사외 IDC + IP 허용이라 브라우저·Supabase Edge에서 직접 붙을 수 없다(CLAUDE.md §4).
--   ETL(etl_run.py)은 ERP 접속이 되는 호스트에서만 돈다 → 웹은 "요청"만 남기고,
--   그 호스트의 감시 러너(etl_watch.py)가 집어가 실행하고 진행률·결과를 여기에 되쓴다.
--   화면은 요청 상태를 폴링하다가 done 이면 v_erp_sync_overview 를 다시 그린다.
-- 보안(CLAUDE.md §1·§4·§5): 큐는 etl_meta 스키마(REST 미노출) → public RPC 로만 접근.
--   요청 생성·조회는 사내 세션(is_internal)만, 집행(claim/progress/finish/ping)은 service_role 만.
--   민감 job(급여 hr_payroll → erp_secure)은 기본 제외 — `include_sensitive` 요청일 때만 러너가 돌리고,
--   그 플래그는 **전체관리자(public.portal_admin)만** 쓸 수 있으며 허용·거부 모두 erp_secure.hr_access_log 에 남는다.

create schema if not exists etl_meta;

-- ── 1. 요청 큐 ────────────────────────────────────────────
create table if not exists etl_meta.sync_request (
  request_id     uuid primary key default gen_random_uuid(),
  requested_at   timestamptz not null default now(),
  requested_by   text not null default '',            -- 요청자 이메일(감사용)
  jobs           text[] not null default '{}',        -- 비우면 러너 기본 세트(허용 목록 전체)
  status         text not null default 'queued'
                 check (status in ('queued','running','done','failed')),
  claimed_at     timestamptz,
  finished_at    timestamptz,
  runner         text,                                -- 집행 호스트명
  progress_done  int  not null default 0,
  progress_total int  not null default 0,
  progress_job   text,                                -- 지금 돌고 있는 job
  rows_read      int  not null default 0,
  rows_upserted  int  not null default 0,
  result         jsonb,                               -- job별 {job,status,read,upserted,error}
  error_msg      text
);
-- 급여(erp_secure) 포함 여부 — 관리자 요청에서만 true (erp_sync_request_sensitive_v1)
alter table etl_meta.sync_request add column if not exists include_sensitive boolean not null default false;

create index if not exists sync_request_status_idx on etl_meta.sync_request (status, requested_at);

alter table etl_meta.sync_request enable row level security;   -- 정책 0 = RPC(정의자 권한) 전용
revoke all on etl_meta.sync_request from anon, authenticated;

-- ── 2. 러너 하트비트 ──────────────────────────────────────
-- 러너가 꺼져 있으면 요청만 쌓이고 아무 일도 안 난다 → 화면이 즉시 "러너 미가동"을 안내하도록 한다.
create table if not exists etl_meta.runner_heartbeat (
  runner   text primary key,
  seen_at  timestamptz not null default now(),
  note     text
);
alter table etl_meta.runner_heartbeat enable row level security;
revoke all on etl_meta.runner_heartbeat from anon, authenticated;

-- ── 3. 사용자용 RPC (사내 세션 전용) ──────────────────────
-- 3-0. 화면 진입 시 1회 — 관리자 여부(급여 포함 옵션 노출)·러너 생존
create or replace function public.erp_sync_caps()
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare
  v_email  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_admin  boolean;
  v_online boolean;
begin
  if not public.is_internal() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select exists(select 1 from public.portal_admin where lower(email) = v_email) into v_admin;
  select exists(select 1 from etl_meta.runner_heartbeat where seen_at > now() - interval '3 minutes') into v_online;
  return jsonb_build_object('ok', true, 'is_admin', coalesce(v_admin, false), 'runner_online', v_online);
end;
$$;

-- 3-1. 요청 생성. 진행 중 요청이 있으면 새로 만들지 않고 그 건을 돌려준다(중복 실행 방지).
--      p_include_sensitive = 급여 집계 포함 요청 → 전체관리자만, 감사 기록 필수.
create or replace function public.erp_sync_request_create(
  p_jobs text[] default null, p_include_sensitive boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare
  v_email  text := coalesce(auth.jwt() ->> 'email', '');
  v_admin  boolean;
  v_online boolean;
  v_last   timestamptz;
  v_sens   boolean := coalesce(p_include_sensitive, false);
  r        etl_meta.sync_request%rowtype;
begin
  if not public.is_internal() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- 급여(erp_secure) 포함 요청은 전체관리자만. 허용·거부 모두 감사 기록(jeil-hr 와 동일 원장).
  if v_sens then
    select exists(select 1 from public.portal_admin where lower(email) = lower(v_email)) into v_admin;
    insert into erp_secure.hr_access_log (upn, dept_nm, action, ok)
    values (v_email, null, 'sync_request_hr_payroll', coalesce(v_admin, false));
    if not coalesce(v_admin, false) then
      raise exception 'forbidden_sensitive' using errcode = '42501';
    end if;
  end if;

  select exists(select 1 from etl_meta.runner_heartbeat where seen_at > now() - interval '3 minutes')
    into v_online;

  select * into r from etl_meta.sync_request
   where status in ('queued','running') and requested_at > now() - interval '2 hours'
   order by requested_at limit 1;
  if found then
    return jsonb_build_object(
      'ok', true, 'reused', true, 'runner_online', v_online,
      'request_id', r.request_id, 'status', r.status, 'requested_at', r.requested_at,
      'requested_by', r.requested_by, 'claimed_at', r.claimed_at, 'finished_at', r.finished_at,
      'runner', r.runner, 'progress_done', r.progress_done, 'progress_total', r.progress_total,
      'progress_job', r.progress_job, 'rows_read', r.rows_read, 'rows_upserted', r.rows_upserted,
      'result', r.result, 'error_msg', r.error_msg, 'include_sensitive', r.include_sensitive);
  end if;

  -- 쿨다운: 마지막 종료 후 60초 이내 재요청 차단(ERP 부하·연타 방지)
  select max(finished_at) into v_last from etl_meta.sync_request where status in ('done','failed');
  if v_last is not null and v_last > now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'cooldown', true, 'runner_online', v_online,
      'wait_sec', ceil(extract(epoch from (v_last + interval '60 seconds' - now())))::int);
  end if;

  insert into etl_meta.sync_request (requested_by, jobs, include_sensitive)
  values (v_email, coalesce(p_jobs, '{}'::text[]), v_sens)
  returning * into r;

  return jsonb_build_object(
    'ok', true, 'reused', false, 'runner_online', v_online,
    'request_id', r.request_id, 'status', r.status, 'requested_at', r.requested_at,
    'requested_by', r.requested_by, 'claimed_at', null, 'finished_at', null,
    'runner', null, 'progress_done', 0, 'progress_total', 0, 'progress_job', null,
    'rows_read', 0, 'rows_upserted', 0, 'result', null, 'error_msg', null,
    'include_sensitive', v_sens);
end;
$$;

-- 3-2. 요청 상태 조회(화면 폴링용)
create or replace function public.erp_sync_request_status(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare
  v_online boolean;
  r        etl_meta.sync_request%rowtype;
begin
  if not public.is_internal() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select exists(select 1 from etl_meta.runner_heartbeat where seen_at > now() - interval '3 minutes')
    into v_online;

  select * into r from etl_meta.sync_request where request_id = p_request_id;
  if not found then
    return jsonb_build_object('ok', false, 'notfound', true, 'runner_online', v_online);
  end if;

  return jsonb_build_object(
    'ok', true, 'runner_online', v_online,
    'request_id', r.request_id, 'status', r.status, 'requested_at', r.requested_at,
    'requested_by', r.requested_by, 'claimed_at', r.claimed_at, 'finished_at', r.finished_at,
    'runner', r.runner, 'progress_done', r.progress_done, 'progress_total', r.progress_total,
    'progress_job', r.progress_job, 'rows_read', r.rows_read, 'rows_upserted', r.rows_upserted,
    'result', r.result, 'error_msg', r.error_msg, 'include_sensitive', r.include_sensitive);
end;
$$;

-- ── 4. 러너용 RPC (service_role 전용) ─────────────────────
-- 4-1. 하트비트
create or replace function public.erp_sync_runner_ping(p_runner text, p_note text default null)
returns void
language sql
security definer
set search_path = public, etl_meta, pg_temp
as $$
  insert into etl_meta.runner_heartbeat (runner, seen_at, note)
  values (p_runner, now(), p_note)
  on conflict (runner) do update set seen_at = now(), note = excluded.note;
$$;

-- 4-2. 대기 요청 1건 선점(없으면 null). 좀비·만료 정리도 겸한다.
create or replace function public.erp_sync_request_claim(p_runner text)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare
  r etl_meta.sync_request%rowtype;
begin
  update etl_meta.sync_request
     set status = 'failed', finished_at = now(),
         error_msg = coalesce(error_msg, '러너 응답 없음(2시간 타임아웃)')
   where status = 'running' and claimed_at < now() - interval '2 hours';

  update etl_meta.sync_request
     set status = 'failed', finished_at = now(),
         error_msg = coalesce(error_msg, '실행 러너 미가동으로 만료(4시간)')
   where status = 'queued' and requested_at < now() - interval '4 hours';

  update etl_meta.sync_request s
     set status = 'running', claimed_at = now(), runner = p_runner
   where s.request_id = (
     select q.request_id from etl_meta.sync_request q
      where q.status = 'queued'
      order by q.requested_at
      for update skip locked
      limit 1)
  returning * into r;

  if not found then return null; end if;

  return jsonb_build_object('request_id', r.request_id, 'jobs', r.jobs,
                            'requested_by', r.requested_by, 'requested_at', r.requested_at,
                            'include_sensitive', r.include_sensitive);
end;
$$;

-- 4-3. 진행률 갱신
create or replace function public.erp_sync_request_progress(
  p_request_id uuid, p_done int, p_total int, p_job text,
  p_rows_read int default null, p_rows_upserted int default null)
returns void
language sql
security definer
set search_path = public, etl_meta, pg_temp
as $$
  update etl_meta.sync_request
     set progress_done = p_done, progress_total = p_total, progress_job = p_job,
         rows_read     = coalesce(p_rows_read, rows_read),
         rows_upserted = coalesce(p_rows_upserted, rows_upserted)
   where request_id = p_request_id and status = 'running';
$$;

-- 4-4. 종료 기록
create or replace function public.erp_sync_request_finish(
  p_request_id uuid, p_status text, p_result jsonb default null,
  p_rows_read int default null, p_rows_upserted int default null, p_error text default null)
returns void
language sql
security definer
set search_path = public, etl_meta, pg_temp
as $$
  update etl_meta.sync_request
     set status        = case when p_status in ('done','failed') then p_status else 'failed' end,
         finished_at   = now(),
         progress_job  = null,
         result        = coalesce(p_result, result),
         rows_read     = coalesce(p_rows_read, rows_read),
         rows_upserted = coalesce(p_rows_upserted, rows_upserted),
         error_msg     = left(p_error, 1000)
   where request_id = p_request_id;
$$;

-- ── 5. 권한 ───────────────────────────────────────────────
revoke all on function public.erp_sync_caps()                          from public, anon;
revoke all on function public.erp_sync_request_create(text[], boolean) from public, anon;
revoke all on function public.erp_sync_request_status(uuid)            from public, anon;
grant execute on function public.erp_sync_caps()                          to authenticated, service_role;
grant execute on function public.erp_sync_request_create(text[], boolean) to authenticated, service_role;
grant execute on function public.erp_sync_request_status(uuid)            to authenticated, service_role;

revoke all on function public.erp_sync_runner_ping(text,text)                     from public, anon, authenticated;
revoke all on function public.erp_sync_request_claim(text)                        from public, anon, authenticated;
revoke all on function public.erp_sync_request_progress(uuid,int,int,text,int,int) from public, anon, authenticated;
revoke all on function public.erp_sync_request_finish(uuid,text,jsonb,int,int,text) from public, anon, authenticated;
grant execute on function public.erp_sync_runner_ping(text,text)                     to service_role;
grant execute on function public.erp_sync_request_claim(text)                        to service_role;
grant execute on function public.erp_sync_request_progress(uuid,int,int,text,int,int) to service_role;
grant execute on function public.erp_sync_request_finish(uuid,text,jsonb,int,int,text) to service_role;

-- 롤백:
-- drop function if exists public.erp_sync_request_finish(uuid,text,jsonb,int,int,text),
--                         public.erp_sync_request_progress(uuid,int,int,text,int,int),
--                         public.erp_sync_request_claim(text),
--                         public.erp_sync_runner_ping(text,text),
--                         public.erp_sync_request_status(uuid),
--                         public.erp_sync_request_create(text[], boolean),
--                         public.erp_sync_caps();
-- drop table if exists etl_meta.sync_request, etl_meta.runner_heartbeat;
