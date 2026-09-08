-- ============================================================================
-- 38_offboard_request.sql — 퇴사 처리 요청 큐 (2026-09-08, 관리자 지시)
--
-- 화면에서 인원을 골라 「퇴사 처리」를 누르면 실제로 처리되게 한다.
-- 브라우저는 그룹웨어 관리자 화면에 붙을 수 없다(사외 호스트 + 화면 자동화가 필요).
-- 「데이터 업데이트」에서 이미 검증된 구조를 그대로 쓴다 —
--   화면은 **요청만 남기고**, 그룹웨어에 붙을 수 있는 호스트의 러너가 집어가 실행한다.
--
-- 축은 셋인데 지금 큐가 받는 것은 **그룹웨어 한 축**이다.
--   · 그룹웨어 : 러너의 Playwright 자동화로 처리 가능(2026-09-07 실증) → **큐 대상**
--   · ERP      : SharePoint 등재가 필요한데 Graph `Sites.ReadWrite.All` 미부여 → 화면이 지시서로 안내
--   · MS       : Graph `User.ReadWrite.All` 미부여(403) → 화면이 지시서로 안내
-- `axes` 컬럼을 둔 이유는 권한이 열리면 같은 큐에 축만 늘리면 되게 하려는 것이다.
--
-- 안전 설계 — **화면이 보낸 값을 믿지 않는다.**
--   화면은 이메일 목록만 보내고, 대상의 이름·로그인ID·퇴사일은 서버가 `v_account_recon` 에서
--   직접 만든다. 퇴사자가 아니거나 그룹웨어가 이미 정리된 사람은 조용히 버리지 않고
--   `rejected` 로 돌려준다(왜 빠졌는지 화면이 말할 수 있어야 한다).
-- ============================================================================

create table if not exists etl_meta.offboard_request (
  request_id      uuid primary key default gen_random_uuid(),
  requested_at    timestamptz not null default now(),
  requested_by    text,
  mode            text not null default 'check'
                    check (mode in ('check','apply')),   -- check = 저장 직전까지만(점검)
  axes            text[] not null default '{gw}',
  targets         jsonb  not null,                       -- 서버가 만든 대상 스냅샷
  status          text not null default 'queued'
                    check (status in ('queued','running','done','failed')),
  claimed_at      timestamptz,
  finished_at     timestamptz,
  runner          text,
  progress_done   integer not null default 0,
  progress_total  integer not null default 0,
  progress_target text,
  result          jsonb,
  error_msg       text
);

comment on table etl_meta.offboard_request is
  '퇴사 처리 요청 큐. 화면(/admin/offboarding)이 요청을 남기면 그룹웨어에 붙을 수 있는 호스트의 '
  '러너(etl_watch.py)가 집어가 gw_offboard.py 로 실행하고 결과를 되쓴다. '
  'mode=check 는 저장 직전까지만 하는 점검 실행이다.';

create index if not exists offboard_request_status_idx
  on etl_meta.offboard_request (status, requested_at);

alter table etl_meta.offboard_request enable row level security;
revoke all on etl_meta.offboard_request from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. 요청 생성 — Edge Function(jeil-accounts) 이 Entra 인증 + 관리자 확인을 마친 뒤 호출한다.
--    그래서 이 함수는 service_role 전용이고 요청자 이메일을 인자로 받는다.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.offboard_request_create(
  p_emails text[], p_mode text default 'check', p_requested_by text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare
  v_mode    text := case when lower(coalesce(p_mode,'check')) = 'apply' then 'apply' else 'check' end;
  v_online  boolean;
  v_targets jsonb;
  v_reject  jsonb;
  r         etl_meta.offboard_request%rowtype;
begin
  if p_emails is null or array_length(p_emails, 1) is null then
    return jsonb_build_object('ok', false, 'reason', 'empty', 'msg', '대상이 없습니다');
  end if;
  if array_length(p_emails, 1) > 50 then
    return jsonb_build_object('ok', false, 'reason', 'too_many', 'msg', '한 번에 50명까지만 요청할 수 있습니다');
  end if;

  select exists(select 1 from etl_meta.runner_heartbeat where seen_at > now() - interval '3 minutes')
    into v_online;

  -- 진행 중 요청이 있으면 새로 만들지 않는다(러너는 한 번에 하나만 처리한다).
  select * into r from etl_meta.offboard_request
   where status in ('queued','running') and requested_at > now() - interval '2 hours'
   order by requested_at limit 1;
  if found then
    return jsonb_build_object('ok', true, 'reused', true, 'runner_online', v_online,
      'request_id', r.request_id, 'status', r.status, 'mode', r.mode);
  end if;

  -- 대상 스냅샷은 **서버가 만든다**. 화면이 보낸 이름·퇴사일은 쓰지 않는다.
  with want as (select lower(trim(e)) as email from unnest(p_emails) as e),
  j as (
    select w.email,
           v.emp_nm, v.dept_nm, v.gw_login_id, v.retire_dt,
           v.has_hr, v.hr_active, v.is_person, v.has_gw
      from want w left join public.v_account_recon v on v.email = w.email
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
        'email', email, 'emp_nm', emp_nm, 'dept_nm', dept_nm,
        'gw_login_id', gw_login_id, 'retire_dt', retire_dt))
      filter (where ok), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object('email', email, 'reason', why))
      filter (where not ok), '[]'::jsonb)
    into v_targets, v_reject
  from (
    select *,
      (emp_nm is not null and coalesce(has_hr,false) and hr_active is false
       and coalesce(is_person,true) and coalesce(has_gw,false)
       and gw_login_id is not null and retire_dt is not null) as ok,
      case
        when emp_nm is null                      then '대사에 없는 이메일'
        when not coalesce(has_hr,false)          then '인사 기록 없음'
        when hr_active is not false              then '인사상 재직 중'
        when not coalesce(is_person,true)        then '공용·설비 계정'
        when not coalesce(has_gw,false)          then '그룹웨어가 이미 정리됨'
        when gw_login_id is null                 then '그룹웨어 로그인ID 없음(이메일 미등록)'
        when retire_dt is null                   then '퇴사일 없음'
        else '알 수 없음'
      end as why
    from j
  ) t;

  if jsonb_array_length(v_targets) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_valid_target', 'runner_online', v_online,
      'rejected', v_reject, 'msg', '처리할 수 있는 대상이 없습니다');
  end if;

  insert into etl_meta.offboard_request (requested_by, mode, axes, targets, progress_total)
  values (coalesce(p_requested_by, 'unknown'), v_mode, '{gw}', v_targets, jsonb_array_length(v_targets))
  returning * into r;

  return jsonb_build_object('ok', true, 'reused', false, 'runner_online', v_online,
    'request_id', r.request_id, 'status', r.status, 'mode', r.mode,
    'targets', r.targets, 'rejected', v_reject);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. 상태 조회 / 러너용 선점·진행·종료
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.offboard_request_status(p_request_id uuid)
returns jsonb
language sql
security definer
set search_path = public, etl_meta, pg_temp
as $$
  select jsonb_build_object(
    'request_id', r.request_id, 'status', r.status, 'mode', r.mode,
    'requested_at', r.requested_at, 'requested_by', r.requested_by,
    'claimed_at', r.claimed_at, 'finished_at', r.finished_at, 'runner', r.runner,
    'progress_done', r.progress_done, 'progress_total', r.progress_total,
    'progress_target', r.progress_target, 'targets', r.targets,
    'result', r.result, 'error_msg', r.error_msg,
    'runner_online', exists(select 1 from etl_meta.runner_heartbeat
                             where seen_at > now() - interval '3 minutes'))
  from etl_meta.offboard_request r where r.request_id = p_request_id;
$$;

create or replace function public.offboard_request_claim(p_runner text)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare r etl_meta.offboard_request%rowtype;
begin
  -- 좀비 정리: running 인데 30분 넘게 소식 없으면 실패로 닫는다(브라우저 자동화는 오래 걸릴 수 있어 넉넉히).
  update etl_meta.offboard_request
     set status = 'failed', finished_at = now(),
         error_msg = coalesce(error_msg, '') || ' [자동종료: 30분 초과]'
   where status = 'running' and claimed_at < now() - interval '30 minutes';

  update etl_meta.offboard_request
     set status = 'running', claimed_at = now(), runner = p_runner
   where request_id = (select request_id from etl_meta.offboard_request
                        where status = 'queued' order by requested_at limit 1)
  returning * into r;
  if not found then return null; end if;

  return jsonb_build_object('request_id', r.request_id, 'mode', r.mode,
    'axes', r.axes, 'targets', r.targets, 'requested_by', r.requested_by);
end;
$$;

create or replace function public.offboard_request_progress(
  p_request_id uuid, p_done integer, p_total integer, p_target text)
returns void
language sql
security definer
set search_path = public, etl_meta, pg_temp
as $$
  update etl_meta.offboard_request
     set progress_done = p_done, progress_total = p_total, progress_target = p_target
   where request_id = p_request_id;
$$;

create or replace function public.offboard_request_finish(
  p_request_id uuid, p_status text, p_result jsonb default null, p_error text default null)
returns void
language sql
security definer
set search_path = public, etl_meta, pg_temp
as $$
  update etl_meta.offboard_request
     set status = case when p_status = 'done' then 'done' else 'failed' end,
         finished_at = now(), result = p_result, error_msg = p_error,
         progress_target = null
   where request_id = p_request_id;
$$;

comment on function public.offboard_request_create(text[], text, text) is
  '퇴사 처리 요청 생성 — service_role 전용(Edge Function jeil-accounts 가 Entra 인증·관리자 확인 후 호출). '
  '대상 정보는 화면 값이 아니라 v_account_recon 에서 서버가 만든다. 조건 미달은 rejected 로 돌려준다.';

revoke all on function public.offboard_request_create(text[], text, text)  from anon, authenticated;
revoke all on function public.offboard_request_status(uuid)                from anon, authenticated;
revoke all on function public.offboard_request_claim(text)                 from anon, authenticated;
revoke all on function public.offboard_request_progress(uuid,integer,integer,text) from anon, authenticated;
revoke all on function public.offboard_request_finish(uuid,text,jsonb,text) from anon, authenticated;

-- ── 검증 ────────────────────────────────────────────────────────────────
-- select public.offboard_request_create(array['wc.kim@jeilm.co.kr'], 'check', 'dh.choi@jeilm.co.kr');
--   → ok:true · targets 1건(김우철, gw_login_id=wc.kim, retire_dt=2023-12-22)
-- select public.offboard_request_create(array['no.such@jeilm.co.kr'], 'check', 'x');
--   → ok:false · rejected 에 '대사에 없는 이메일'
