-- ============================================================================
-- 39_offboard_axes.sql — 퇴사 처리: 사원 검색 + 3축 일괄 (2026-09-09, 관리자 지시)
--
-- 38 에서 만든 큐는 「잔여 목록에서 고른 사람」의 「그룹웨어 축」만 받았다.
-- 관리자 요구는 **사원을 검색해서 ERP·그룹웨어·MS 를 한 번에** 처리하는 것이라 두 가지를 넓힌다.
--
--  ① 대상 — 잔여 목록에 없는 사람도 받는다.
--     퇴사 처리는 보통 **인사 반영보다 먼저 또는 동시에** 일어난다. 인사에 아직 퇴사가
--     안 찍힌 사람을 못 고르면, 정작 필요한 순간에 이 화면을 쓸 수 없다.
--     대신 재직자는 조용히 통과시키지 않고 `warn` 을 붙여 화면이 경고하게 한다.
--
--  ② 축 — erp · gw · ms 를 골라 담는다. 축마다 필요한 값이 다르므로 대상 스냅샷에
--     축별 가능 여부(`axes_ok`)와 못 하는 이유(`axes_skip`)를 함께 넣는다.
--     러너는 이 값만 보고 실행하면 되고, 화면은 왜 빠졌는지 말할 수 있다.
--
-- 퇴사일이 없으면 어느 축도 못 한다(ERP 는 USR_VALID_DT, 그룹웨어는 퇴사일 입력이 필수).
-- 인사에 있으면 그 값을 쓰고, 없으면 화면이 넘긴 `p_retire_dt` 를 쓴다. 둘 다 없으면 거부한다.
-- ============================================================================

alter table etl_meta.offboard_request
  add column if not exists retire_dt_override date;

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
           v.hr_active, v.is_person, v.has_erp, v.has_gw, v.has_ms,
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
      (case when 'ms'  = any(v_axes) and coalesce(has_ms,false) then true else false end) as do_ms
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
  'v_account_identity 에서 서버가 만든다. 축별로 남은 일이 있는 것만 담고, 못 하는 축은 이유를 붙인다. '
  '인사 반영 전(재직 중) 대상도 받되 warn 을 달아 화면이 경고하게 한다.';

revoke all on function public.offboard_request_create(text[], text, text, text[], date) from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 사원 검색 — 퇴사 처리 대상을 이름·이메일·부서로 찾는다.
-- 잔여 목록에 없는 사람(재직자 포함)도 나와야 하므로 대사 전체를 본다.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.offboard_search(p_q text, p_limit integer default 30)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.hr_active desc nulls last, x.emp_nm), '[]'::jsonb)
  from (
    select v.email, v.emp_nm, v.dept_nm, v.position_nm, v.emp_no,
           v.hr_active, v.retire_dt, v.has_erp, v.has_gw, v.has_ms,
           v.gw_login_id, v.is_person, v.recon_type
      from public.v_account_recon v
     where coalesce(v.is_person, true)
       and (coalesce(v.emp_nm,'')  ilike '%'||p_q||'%'
         or coalesce(v.email,'')   ilike '%'||p_q||'%'
         or coalesce(v.dept_nm,'') ilike '%'||p_q||'%'
         or coalesce(v.emp_no,'')  ilike '%'||p_q||'%')
     limit greatest(1, least(coalesce(p_limit, 30), 100))
  ) x;
$$;

comment on function public.offboard_search(text, integer) is
  '퇴사 처리 대상 검색 — 이름·이메일·부서·사번. 재직자도 나온다(퇴사 처리는 인사 반영보다 먼저 오는 일이 많다). '
  '공용·설비 계정은 제외.';

revoke all on function public.offboard_search(text, integer) from anon, authenticated;

-- ── 검증 ────────────────────────────────────────────────────────────────
-- select public.offboard_search('김우철', 5);
-- select public.offboard_request_create(array['wc.kim@jeilm.co.kr'], 'check', 'dh.choi@jeilm.co.kr',
--        array['erp','gw','ms'], null);
--   → targets[0].axes 에 실제로 남은 축만 담긴다(김우철은 gw 만)
