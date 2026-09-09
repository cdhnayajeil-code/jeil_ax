-- ============================================================================
-- 41_ms_license.sql — MS 라이선스를 미러에 담고 퇴사 판정에 넣는다 (2026-09-09, 관리자 지시)
--
-- 관리자 지시: "라이선스 회수는 기본으로 적용하고, 이 페이지에서 전체 권한도 업데이트되게".
--
-- 여기서 고치는 진짜 문제는 **대사가 라이선스를 아예 몰랐다**는 것이다.
--   v_account_recon.has_ms = (accountEnabled = true) 하나뿐이었다.
--   그래서 로그인만 차단하면 MS 축이 '완료'로 보였고, 라이선스는 그대로 남아
--   좌석과 비용이 계속 나갔다. 테스트 계정에서 실제로 그 상태를 확인했다
--   (차단됨 + O365_BUSINESS_PREMIUM 유지).
--
-- 바꾸는 것
--   ① acct_ms 에 라이선스 4열 — 건수 / 직접할당 / 그룹상속 / 이름배열.
--      Graph `/users?$select=assignedLicenses,licenseAssignmentStates` 로 **목록 한 번에** 읽는다.
--      (테넌트 SKU 목록 `/subscribedSkus` 는 403 이라 이름은 licenseDetails 로 보완한다.)
--   ② v_account_recon 에 ms_license_* 4열 + **ms_todo** — "MS 축에 아직 남은 일".
--      is_current 는 건드리지 않는다. 라이선스만 남은 차단 계정을 현재 인원으로 세면 안 된다.
--   ③ offboard_request_create 의 do_ms 판정을 has_ms → ms_todo 로.
--   ④ 화면에서 계정·권한 전량 재수집을 걸 수 있는 서비스롤 RPC 2종.
--
-- 그룹 상속 라이선스(assignedByGroup)는 ms_todo 에 넣지 않는다 — assignLicense API 로
-- 뗄 수 없어서, 담으면 영영 안 끝나는 일이 된다. 대신 건수를 보여주고 사람이 그룹에서 뺀다.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- 1. acct_ms — 라이선스 열
-- ─────────────────────────────────────────────────────────────────────────
alter table public.acct_ms
  add column if not exists license_cnt    integer not null default 0,
  add column if not exists license_direct integer not null default 0,
  add column if not exists license_group  integer not null default 0,
  add column if not exists license_names  text[];

comment on column public.acct_ms.license_direct is
  '직접 할당된 라이선스 수 — 퇴사 처리 때 assignLicense 로 회수할 수 있는 것.';
comment on column public.acct_ms.license_group is
  '그룹으로 상속된 라이선스 수 — API 로 못 뗀다. 사람이 해당 그룹에서 사용자를 빼야 한다.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. 적재 RPC — ms 분기에 라이선스 4열 추가 (34 의 정의를 대체)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.acct_source_upsert(p_source text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_up integer := 0; v_del integer := 0; v_in integer;
begin
  v_in := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));
  if v_in = 0 then
    raise exception '원천 행이 0건입니다 — 전건 삭제를 막기 위해 거부합니다';
  end if;

  if p_source = 'gw' then
    insert into public.acct_groupware (email, login_id, emp_nm, dept_nm, position_nm, status, source, collected_at)
    select lower(trim(x.email)), x.login_id, x.emp_nm, x.dept_nm, x.position_nm,
           x.status, coalesce(x.source, 'onulware'), now()
    from jsonb_to_recordset(p_rows) as x(email text, login_id text, emp_nm text, dept_nm text,
                                         position_nm text, status text, source text)
    where x.email like '%@%'
    on conflict (email) do update
      set login_id = excluded.login_id, emp_nm = excluded.emp_nm, dept_nm = excluded.dept_nm,
          position_nm = excluded.position_nm, status = excluded.status,
          source = excluded.source, collected_at = excluded.collected_at;
    get diagnostics v_up = row_count;

    delete from public.acct_groupware
     where email not in (select lower(trim(y.email))
                           from jsonb_to_recordset(p_rows) as y(email text)
                          where y.email like '%@%');
    get diagnostics v_del = row_count;

  elsif p_source = 'ms' then
    insert into public.acct_ms (email, display_name, dept_nm, job_title, account_enabled,
                                user_type, object_id, license_cnt, license_direct,
                                license_group, license_names, collected_at)
    select lower(trim(x.email)), x.display_name, x.dept_nm, x.job_title,
           x.account_enabled, x.user_type, x.object_id,
           coalesce(x.license_cnt, 0), coalesce(x.license_direct, 0),
           coalesce(x.license_group, 0), x.license_names, now()
    from jsonb_to_recordset(p_rows) as x(email text, display_name text, dept_nm text, job_title text,
                                         account_enabled boolean, user_type text, object_id text,
                                         license_cnt integer, license_direct integer,
                                         license_group integer, license_names text[])
    where x.email like '%@%'
    on conflict (email) do update
      set display_name = excluded.display_name, dept_nm = excluded.dept_nm,
          job_title = excluded.job_title, account_enabled = excluded.account_enabled,
          user_type = excluded.user_type, object_id = excluded.object_id,
          license_cnt = excluded.license_cnt, license_direct = excluded.license_direct,
          license_group = excluded.license_group, license_names = excluded.license_names,
          collected_at = excluded.collected_at;
    get diagnostics v_up = row_count;

    delete from public.acct_ms
     where email not in (select lower(trim(y.email))
                           from jsonb_to_recordset(p_rows) as y(email text)
                          where y.email like '%@%');
    get diagnostics v_del = row_count;

  else
    raise exception '허용되지 않은 source: %', p_source;
  end if;

  return jsonb_build_object('source', p_source, 'received', v_in, 'upserted', v_up, 'deleted', v_del);
end $fn$;


comment on function public.acct_source_upsert(text, jsonb) is
  '그룹웨어·MS 계정 전량 스냅샷 적재 — 원천에 없는 행은 삭제한다. 0건은 거부(전건 삭제 방지). '
  'ms 는 라이선스(건수·직접·그룹상속·이름)도 함께 받는다(2026-09-09).';

revoke all on function public.acct_source_upsert(text, jsonb) from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. 대사 뷰 — ms_license_* + ms_todo (37 의 정의를 대체)
-- ─────────────────────────────────────────────────────────────────────────
create or replace view public.v_account_recon
with (security_invoker = true) as
with emails as (
  select lower(trim(usr_id)) as email from erp_ro.usr_master_s where usr_id like '%@%'
  union select email from erp_ro.v_hr_by_email
  union select lower(trim(email)) from public.acct_groupware
  union select lower(trim(email)) from public.acct_ms
)
select
  e.email,
  coalesce(a.acct_emp_nm, h.emp_nm, g.emp_nm, m.display_name) as emp_nm,
  coalesce(h.dept_nm, a.acct_dept_nm, g.dept_nm, m.dept_nm)   as dept_nm,
  coalesce(h.roll_pstn, g.position_nm, m.job_title)           as position_nm,
  a.acct_dept_nm,
  a.acct_status_note,
  h.hr_active,
  coalesce(h.rehire_cnt, 0)                                   as rehire_cnt,
  h.emp_no,
  h.emp_no_list,
  h.first_entr_dt,
  h.retire_dt,
  (a.email is not null and a.acct_active)                     as has_erp,
  (h.email is not null)                                       as has_hr,
  (g.email is not null and g.status = '사용')                  as has_gw,
  (m.email is not null and m.account_enabled)                 as has_ms,
  g.status                                                    as gw_status,
  g.login_id                                                  as gw_login_id,
  (m.email is not null)                                       as ms_exists,
  m.account_enabled                                           as ms_enabled,
  m.user_type                                                 as ms_user_type,
  coalesce(a.erp_role_cnt, 0)                                 as erp_role_cnt,
  coalesce(a.erp_perm_registered, false)                      as erp_perm_registered,
  (pa.email is not null)                                      as portal_admin,
  coalesce(a.dept_mismatch, false)                            as dept_mismatch,
  (nh.email is null)                                          as is_person,
  nh.kind                                                     as nonhuman_kind,
  -- 휴직 — 사람은 있고 ERP 계정만 잠긴 상태. 근거는 usr_nm '(휴직)' 표기 하나뿐이다.
  (a.acct_status_note = '휴직')                                as on_leave,
  (a.email is null and h.email is not null and h.hr_active and ed.dept_nm is not null)
                                                              as erp_exempt,
  (nh.email is null and (
     coalesce(a.acct_active, false) or coalesce(h.hr_active, false)
     or (g.email is not null and g.status = '사용')
     or (m.email is not null and m.account_enabled)))         as is_current,
  case
    when nh.email is not null                                            then '공용·설비계정'
    -- ① 이력 먼저 걸러낸다. 그래야 남은 분류가 '지금 조치할 것'만 남는다.
    when a.email is null and h.email is not null and not h.hr_active
         and not (g.email is not null and g.status = '사용')
         and not (m.email is not null and m.account_enabled)             then '퇴사이력'
    when a.email is null and h.email is null
         and not (g.email is not null and g.status = '사용')
         and not (m.email is not null and m.account_enabled)             then '비활성이력'
    -- ② 휴직 — 이력도 아니고 조치 대상도 아니다. 계정비활성보다 먼저 본다.
    when a.acct_status_note = '휴직'                                      then '휴직'
    when a.email is not null and not a.acct_active                       then '계정비활성'
    -- ③ 조치 대상
    when a.email is null and h.email is not null and h.hr_active
         and ed.dept_nm is null                                          then '계정없음'
    when a.email is null and h.email is null                             then 'ERP·인사없음'
    when a.email is not null and h.email is null                         then '인사없음'
    when h.email is not null and not h.hr_active
         and a.email is not null and a.acct_active                       then '퇴사자계정활성'
    when a.email is not null and a.acct_active
         and not (g.email is not null and g.status = '사용')              then '그룹웨어없음'
    when a.email is not null and a.acct_active
         and not (m.email is not null and m.account_enabled)             then 'MS없음'
    when coalesce(a.dept_mismatch, false)                                then '부서표기불일치'
    when a.email is not null and a.acct_active
         and not coalesce(a.erp_perm_registered, false)                  then '권한미등록'
    when coalesce(h.rehire_cnt, 0) > 0                                   then '재입사'
    else '정상'
  end                                                         as recon_type,
  -- ── 라이선스 (2026-09-09 신설) ──────────────────────────────────────
  --   차단(accountEnabled=false)만으로 "MS 정리 완료"라고 보면 **라이선스가 그대로 남는다**.
  --   실제로 테스트 계정이 그 상태였다 — 로그인은 막혔는데 좌석과 비용은 계속 나갔다.
  coalesce(m.license_cnt, 0)                                  as ms_license_cnt,
  coalesce(m.license_direct, 0)                               as ms_license_direct,
  coalesce(m.license_group, 0)                                as ms_license_group,
  m.license_names                                             as ms_license_names,
  -- MS 축에 아직 남은 일이 있는가 — 차단 안 됨 **또는** 직접 할당 라이선스가 남음.
  -- 그룹 상속분은 여기 넣지 않는다. API 로 뗄 수 없어 담아 봐야 영영 안 끝나는 일이 된다.
  (nh.email is null
   and ((m.email is not null and m.account_enabled)
        or coalesce(m.license_direct, 0) > 0))                as ms_todo
from emails e
left join public.v_account_identity      a  on a.email = e.email
left join erp_ro.v_hr_by_email           h  on h.email = e.email
left join public.acct_groupware          g  on lower(trim(g.email)) = e.email
left join public.acct_ms                 m  on lower(trim(m.email)) = e.email
left join public.portal_admin            pa on lower(trim(pa.email)) = e.email
left join public.acct_nonhuman           nh on lower(trim(nh.email)) = e.email
left join public.acct_erp_optional_dept  ed on ed.dept_nm = h.dept_nm;


comment on view public.v_account_recon is
  '계정 대사 — 이메일 1행에 ERP계정/인사/그룹웨어/MS 보유 여부와 권한 등록 여부를 붙인다. '
  '보유는 "쓸 수 있는 상태"만 센다(그룹웨어 status=사용, MS accountEnabled=true). '
  'ms_todo 는 그와 별개로 "MS 축에 남은 일"이다 — 차단 안 됨 또는 직접 할당 라이선스 잔존. '
  'is_person=false(공용·설비계정)와 is_current=false(이력)는 현재 인원에서 빠진다. '
  'on_leave=true(휴직)와 erp_exempt=true(ERP 미사용 부서)는 현재 인원이되 조치 대상이 아니다.';

revoke all on public.v_account_recon from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. 퇴사 요청 생성 — MS 축 판정을 ms_todo 로 (39 의 정의를 대체)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.offboard_request_create(
  p_emails       text[],
  p_mode         text default 'check',
  p_requested_by text default null,
  p_axes         text[] default '{gw}',
  p_retire_dt    date default null)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare
  v_mode    text := case when lower(coalesce(p_mode,'check')) = 'apply' then 'apply' else 'check' end;
  v_axes    text[] := coalesce(
                        (select array_agg(a) from unnest(p_axes) a where a in ('erp','gw','ms')),
                        '{gw}'::text[]);
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

  select * into r from etl_meta.offboard_request
   where status in ('queued','running') and requested_at > now() - interval '2 hours'
   order by requested_at limit 1;
  if found then
    return jsonb_build_object('ok', true, 'reused', true, 'runner_online', v_online,
      'request_id', r.request_id, 'status', r.status, 'mode', r.mode);
  end if;

  with want as (select lower(trim(e)) as email from unnest(p_emails) as e),
  j as (
    select w.email,
           v.emp_nm, v.dept_nm, v.gw_login_id,
           coalesce(v.retire_dt, p_retire_dt) as retire_dt,
           v.hr_active, v.is_person, v.has_erp, v.has_gw, v.has_ms, v.ms_todo,
           a.acct_nm_raw as acct_nm
      from want w
      left join public.v_account_recon    v on v.email = w.email
      left join public.v_account_identity a on a.email = w.email
  ), t as (
    select *,
      -- 축별로 "지금 할 일이 남아 있는가". 이미 정리된 축은 담지 않는다(불필요한 조작 방지).
      (case when 'erp' = any(v_axes) and coalesce(has_erp,false) then true else false end) as do_erp,
      (case when 'gw'  = any(v_axes) and coalesce(has_gw,false) and gw_login_id is not null
            then true else false end) as do_gw,
      -- ⚠ has_ms(=accountEnabled)가 아니라 ms_todo 를 본다.
      --   차단은 됐는데 라이선스가 남은 계정을 has_ms 로 보면 '이미 완료'로 빠져나간다.
      (case when 'ms'  = any(v_axes) and coalesce(ms_todo,false) then true else false end) as do_ms
    from j
  ), t2 as (
    select *,
      (emp_nm is not null and coalesce(is_person,true) and retire_dt is not null
       and (do_erp or do_gw or do_ms)) as ok,
      case
        when emp_nm is null                then '대사에 없는 이메일'
        when not coalesce(is_person,true)  then '공용·설비 계정'
        when retire_dt is null             then '퇴사일 없음 — 인사에 없으면 화면에서 직접 입력하세요'
        else '선택한 축이 이미 모두 정리됨'
      end as why,
      case when coalesce(hr_active,false) then '인사상 재직 중 — 퇴사 반영 전입니다' end as warn
    from t
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
        'email', email, 'emp_nm', emp_nm, 'dept_nm', dept_nm, 'acct_nm', acct_nm,
        'gw_login_id', gw_login_id, 'retire_dt', retire_dt, 'warn', warn,
        'axes', (case when do_erp then jsonb_build_array('erp') else '[]'::jsonb end)
             || (case when do_gw  then jsonb_build_array('gw')  else '[]'::jsonb end)
             || (case when do_ms  then jsonb_build_array('ms')  else '[]'::jsonb end)))
      filter (where ok), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object('email', email, 'reason', why))
      filter (where not ok), '[]'::jsonb)
    into v_targets, v_reject
  from t2;

  if jsonb_array_length(v_targets) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_valid_target', 'runner_online', v_online,
      'rejected', v_reject, 'msg', '처리할 수 있는 대상이 없습니다');
  end if;

  insert into etl_meta.offboard_request
      (requested_by, mode, axes, targets, progress_total, retire_dt_override)
  values (coalesce(p_requested_by, 'unknown'), v_mode, v_axes, v_targets,
          jsonb_array_length(v_targets), p_retire_dt)
  returning * into r;

  return jsonb_build_object('ok', true, 'reused', false, 'runner_online', v_online,
    'request_id', r.request_id, 'status', r.status, 'mode', r.mode, 'axes', v_axes,
    'targets', r.targets, 'rejected', v_reject);
end;
$$;


comment on function public.offboard_request_create(text[], text, text, text[], date) is
  '퇴사 처리 요청 생성(3축) — service_role 전용. 대상 정보는 화면 값이 아니라 v_account_recon/'
  'v_account_identity 에서 서버가 만든다. MS 축은 ms_todo(차단 미완 또는 직접 라이선스 잔존)로 '
  '판정한다 — 차단만 보면 라이선스가 남은 계정을 완료로 놓친다(2026-09-09).';

revoke all on function public.offboard_request_create(text[], text, text, text[], date) from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. 화면에서 계정·권한 전량 재수집 걸기 (service_role 전용)
--
--    기존 erp_sync_request_create 는 auth.jwt() 의 이메일과 is_internal() 을 본다.
--    퇴사 처리 화면은 Entra 토큰을 엣지 함수가 검증하고 **service_role** 로 들어오므로
--    그 함수를 그대로 쓸 수 없다(jwt 가 없어 forbidden). 그래서 같은 큐에 넣되
--    **계정 수집기 2종으로만 범위를 좁힌** 전용 함수를 둔다. ERP 전체 배치를 끌고 오지 않는다.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.offboard_refresh_accounts(p_requested_by text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare
  v_online boolean;
  v_last   timestamptz;
  r        etl_meta.sync_request%rowtype;
begin
  select exists(select 1 from etl_meta.runner_heartbeat where seen_at > now() - interval '3 minutes')
    into v_online;

  -- 진행 중 요청이 있으면 새로 만들지 않고 그 건에 붙인다(연타로 큐가 쌓이지 않게).
  select * into r from etl_meta.sync_request
   where status in ('queued','running') and requested_at > now() - interval '2 hours'
   order by requested_at limit 1;
  if found then
    return jsonb_build_object('ok', true, 'reused', true, 'runner_online', v_online,
      'request_id', r.request_id, 'status', r.status, 'jobs', r.jobs);
  end if;

  select max(finished_at) into v_last from etl_meta.sync_request where status in ('done','failed');
  if v_last is not null and v_last > now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'cooldown', true, 'runner_online', v_online,
      'wait_sec', ceil(extract(epoch from (v_last + interval '60 seconds' - now())))::int,
      'msg', '방금 갱신했습니다 — 잠시 후 다시 눌러주세요');
  end if;

  insert into etl_meta.sync_request (requested_by, jobs, include_sensitive)
  values (coalesce(nullif(trim(coalesce(p_requested_by, '')), ''), 'unknown'),
          array['ms_account', 'gw_account'], false)
  returning * into r;

  return jsonb_build_object('ok', true, 'reused', false, 'runner_online', v_online,
    'request_id', r.request_id, 'status', r.status, 'jobs', r.jobs);
end $$;

comment on function public.offboard_refresh_accounts(text) is
  'MS·그룹웨어 계정/권한 전량 재수집 요청 — service_role 전용(엣지 함수 경유). '
  'ERP job 은 부르지 않는다. 진행 중 요청이 있으면 재사용하고 60초 쿨다운을 둔다.';

revoke all on function public.offboard_refresh_accounts(text) from anon, authenticated;

create or replace function public.offboard_refresh_status(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare
  v_online boolean;
  r        etl_meta.sync_request%rowtype;
begin
  select exists(select 1 from etl_meta.runner_heartbeat where seen_at > now() - interval '3 minutes')
    into v_online;
  select * into r from etl_meta.sync_request where request_id = p_request_id;
  if not found then
    return jsonb_build_object('ok', false, 'msg', '요청을 찾을 수 없습니다');
  end if;
  return jsonb_build_object('ok', true, 'runner_online', v_online,
    'request_id', r.request_id, 'status', r.status, 'progress_job', r.progress_job,
    'progress_done', r.progress_done, 'progress_total', r.progress_total,
    'rows_upserted', r.rows_upserted, 'error_msg', r.error_msg,
    'finished_at', r.finished_at, 'result', r.result);
end $$;

comment on function public.offboard_refresh_status(uuid) is
  '계정/권한 재수집 요청 진행 상태 — service_role 전용(엣지 함수 경유).';

revoke all on function public.offboard_refresh_status(uuid) from anon, authenticated;

-- ── 검증 ────────────────────────────────────────────────────────────────
-- select count(*) filter (where ms_license_direct > 0)  as 직접할당,
--        count(*) filter (where ms_license_group  > 0)  as 그룹상속,
--        count(*) filter (where ms_todo and not has_ms) as 차단됐지만_라이선스잔존
--   from public.v_account_recon;
-- select email, emp_nm, ms_enabled, ms_license_names
--   from public.v_account_recon where ms_todo and not has_ms order by emp_nm;
