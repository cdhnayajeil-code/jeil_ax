-- ============================================================================
-- 45_offboard_schedule.sql — 퇴사 처리 예약: 일시 예약 · 도래 시 확인 · 자동 적용 (2026-09-11 · REQ-0029 · ADR-015)
--
-- 관리자 지시: "퇴사 처리에 예약 기능 — 일자(시간까지) 예약을 등록하고 일자가 되면 확인되게,
--              자동 적용 체크 시 자동으로 적용되게."
--
-- 지금까지의 큐(38·39·41)는 「언제 실행할지」라는 개념이 없었다 — 요청은 등록 즉시 queued 다.
-- 예약을 큐 행에 status='scheduled' 로 끼워 넣지 않고 **별도 표**로 둔다:
--   · 러너 claim(status='queued' 만 집음)·상태 폴링(화면은 queued/running 외 전부 종료로 봄)을 손대지 않는다.
--   · 예약은 「대상을 누구로 할지」를 저장하고, **도래 시 그 시점 기준으로 대상을 다시 산정**해 큐에 넣는다
--     (예약 뒤 인사 반영·계정 정리·퇴사 취소가 생겨도 옛 스냅샷으로 조작하지 않는다).
--   · 도래 승격은 세 곳에서 돈다 — ① pg_cron 1분(러너가 꺼져 있어도 정시 기록) ② 러너 claim 진입(20초)
--     ③ 목록 조회 진입(화면을 여는 순간). 실제 **실행은 러너**가 한다(관리자 결정: 러너는 당분간 수동 기동).
--     따라서 「자동 적용」= 도래 시각에 사람 확인 없이 큐에 넣는 것까지이고, 러너가 다음에 도는 순간 실행된다.
--   · 자동 건이 도래 후 7일이 지나도록 승격되지 못했으면(스케줄러·러너 모두 멈춘 경우) 자동을 풀고
--     「확인 필요」로 강등한다 — 며칠 지난 퇴사가 아무도 모르게 실행되지 않게.
--
-- 함께 고치는 것(같은 자리의 함정)
--   · offboard_request_create 의 「2시간 내 진행 건 있으면 새 요청 안 만들고 재사용」 규칙(41:257) —
--     예약 승격 건이 queued 인 동안 사람이 낸 요청이 흡수돼 그 사람이 처리되지 않는다. 러너가 한 번에
--     1건씩 순서대로 처리하므로 큐가 순서를 보장한다 → 규칙을 「같은 요청자·같은 대상 집합·5분 내」(더블클릭 방지)로 줄인다.
--   · offboard_request_claim 의 이중 선점 결함 — 바깥 update 에 status 조건이 없고 skip locked 도 없어
--     러너 두 개가 겹치면 같은 요청을 둘 다 실행할 수 있다(29번 sync_request 패턴으로 보강).
--   · 대상 산정 로직을 offboard_build_targets 로 뽑아 create·예약·승격이 **한 벌**을 쓴다.
--
-- 시간대: DB 는 UTC. 화면은 datetime-local(KST) 값에 '+09:00' 을 붙여 보내고 timestamptz 로 저장한다.
--         도래 판정은 scheduled_at <= now() (시간대 무관), 날짜 파생은 반드시 at time zone 'Asia/Seoul'.
-- 권한: 전부 SECURITY DEFINER · service_role 전용 — `from public` 포함 회수(42번 규칙). pg_cron 작업은 postgres 소유.
-- ============================================================================

-- 0) DB 스케줄러 — 관리자 결정(2026-09-11) 으로 설치. 러너가 꺼져 있어도 도래·강등 전이가 정시에 기록된다.
create extension if not exists pg_cron;

-- 1) 예약 표 + 큐 행의 출처 표시
create table if not exists etl_meta.offboard_schedule (
  schedule_id        uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  created_by         text not null,
  emails             text[] not null,                        -- 예약 대상(이메일). 대상 상세는 도래 시 재산정
  axes               text[] not null default '{erp,gw,ms}',
  retire_dt_override date,                                    -- 인사에 퇴사일이 없을 때 화면이 준 값
  scheduled_at       timestamptz not null,                    -- 적용 일시(KST 입력 → timestamptz)
  auto_apply         boolean not null default false,          -- 도래 시 사람 확인 없이 큐 투입
  memo               text,
  status             text not null default 'scheduled'
                       check (status in ('scheduled','promoted','cancelled','expired')),
  snapshot           jsonb,                                   -- 예약 시점 미리보기 {targets, rejected} — 화면 표시용(판정에 안 씀)
  promoted_at        timestamptz,
  promoted_by        text,
  promoted_kind      text check (promoted_kind in ('auto','manual')),
  request_id         uuid references etl_meta.offboard_request(request_id),
  cancelled_at       timestamptz,
  cancelled_by       text,
  cancel_reason      text,
  expire_reason      text,
  history            jsonb not null default '[]'::jsonb        -- [{at, by, act, note}] 누적
);
create index if not exists offboard_schedule_status_ix on etl_meta.offboard_schedule(status, scheduled_at);
comment on table etl_meta.offboard_schedule is
  '퇴사 처리 예약 — 일시가 되면 큐(offboard_request)에 넣는다. auto_apply 면 사람 확인 없이, 아니면 「도래 — 확인 필요」로 화면에 뜬다. '
  '대상은 도래 시 v_account_recon 으로 다시 산정한다(snapshot 은 예약 당시 미리보기).';

alter table etl_meta.offboard_request
  add column if not exists schedule_id uuid,
  add column if not exists origin      text not null default 'manual';   -- manual | schedule
comment on column etl_meta.offboard_request.origin is 'manual=화면에서 즉시 요청 · schedule=예약 승격(schedule_id 참조)';

-- 2) 대상 산정 — create(41) 의 본문을 그대로 뽑아 공용화. {targets, rejected} 를 돌려준다.
create or replace function public.offboard_build_targets(
  p_emails text[], p_axes text[], p_retire_dt date default null)
returns jsonb
language sql
security definer
set search_path = public, etl_meta, pg_temp
as $$
  with want as (select distinct lower(trim(e)) as email from unnest(p_emails) as e where e is not null and trim(e) <> ''),
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
      (case when 'erp' = any(p_axes) and coalesce(has_erp,false) then true else false end) as do_erp,
      (case when 'gw'  = any(p_axes) and coalesce(has_gw,false) and gw_login_id is not null then true else false end) as do_gw,
      -- has_ms(=accountEnabled) 가 아니라 ms_todo — 차단됐어도 라이선스가 남았으면 할 일이 있다(41번).
      (case when 'ms'  = any(p_axes) and coalesce(ms_todo,false) then true else false end) as do_ms
    from j
  ), t2 as (
    select *,
      (emp_nm is not null and coalesce(is_person,true) and retire_dt is not null and (do_erp or do_gw or do_ms)) as ok,
      case
        when emp_nm is null                then '대사에 없는 이메일'
        when not coalesce(is_person,true)  then '공용·설비 계정'
        when retire_dt is null             then '퇴사일 없음 — 인사에 없으면 화면에서 직접 입력하세요'
        else '선택한 축이 이미 모두 정리됨'
      end as why,
      case when coalesce(hr_active,false) then '인사상 재직 중 — 퇴사 반영 전입니다' end as warn
    from t
  )
  select jsonb_build_object(
    'targets', coalesce(jsonb_agg(jsonb_build_object(
        'email', email, 'emp_nm', emp_nm, 'dept_nm', dept_nm, 'acct_nm', acct_nm,
        'gw_login_id', gw_login_id, 'retire_dt', retire_dt, 'warn', warn,
        'axes', (case when do_erp then jsonb_build_array('erp') else '[]'::jsonb end)
             || (case when do_gw  then jsonb_build_array('gw')  else '[]'::jsonb end)
             || (case when do_ms  then jsonb_build_array('ms')  else '[]'::jsonb end)))
      filter (where ok), '[]'::jsonb),
    'rejected', coalesce(jsonb_agg(jsonb_build_object('email', email, 'reason', why)) filter (where not ok), '[]'::jsonb))
  from t2;
$$;
comment on function public.offboard_build_targets(text[], text[], date) is
  '퇴사 처리 대상 산정(공용) — 화면 값을 믿지 않고 v_account_recon/v_account_identity 로 만든다. 즉시 요청·예약·승격이 같은 함수를 쓴다.';

-- 3) 즉시 요청 — 시그니처 유지. 대상 산정은 공용 함수, 재사용 규칙은 「같은 요청자·같은 대상·5분 내」로 축소.
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
  v_axes    text[] := coalesce((select array_agg(a) from unnest(p_axes) a where a in ('erp','gw','ms')), '{gw}'::text[]);
  v_online  boolean;
  v_built   jsonb;
  v_targets jsonb;
  v_reject  jsonb;
  v_emails  text[];
  r         etl_meta.offboard_request%rowtype;
begin
  if p_emails is null or array_length(p_emails, 1) is null then
    return jsonb_build_object('ok', false, 'reason', 'empty', 'msg', '대상이 없습니다');
  end if;
  if array_length(p_emails, 1) > 50 then
    return jsonb_build_object('ok', false, 'reason', 'too_many', 'msg', '한 번에 50명까지만 요청할 수 있습니다');
  end if;
  select exists(select 1 from etl_meta.runner_heartbeat where seen_at > now() - interval '3 minutes') into v_online;

  -- 더블클릭 방지 — 같은 사람이 같은 대상 집합을 5분 안에 다시 내면 앞 요청을 돌려준다.
  -- (종전 「2시간 내 진행 건이면 무조건 재사용」은 다른 사람·다른 대상까지 삼켰다 — 45번에서 축소)
  select array_agg(e order by e) into v_emails from (select distinct lower(trim(x)) e from unnest(p_emails) x) s;
  select * into r from etl_meta.offboard_request
   where status in ('queued','running') and requested_at > now() - interval '5 minutes'
     and requested_by = coalesce(p_requested_by, 'unknown') and origin = 'manual'
     and (select array_agg(t->>'email' order by t->>'email') from jsonb_array_elements(targets) t) = v_emails
   order by requested_at limit 1;
  if found then
    return jsonb_build_object('ok', true, 'reused', true, 'runner_online', v_online,
      'request_id', r.request_id, 'status', r.status, 'mode', r.mode);
  end if;

  v_built   := public.offboard_build_targets(p_emails, v_axes, p_retire_dt);
  v_targets := v_built->'targets';
  v_reject  := v_built->'rejected';
  if jsonb_array_length(v_targets) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_valid_target', 'runner_online', v_online,
      'rejected', v_reject, 'msg', '처리할 수 있는 대상이 없습니다');
  end if;

  insert into etl_meta.offboard_request
      (requested_by, mode, axes, targets, progress_total, retire_dt_override, origin)
  values (coalesce(p_requested_by, 'unknown'), v_mode, v_axes, v_targets, jsonb_array_length(v_targets), p_retire_dt, 'manual')
  returning * into r;

  return jsonb_build_object('ok', true, 'reused', false, 'runner_online', v_online,
    'request_id', r.request_id, 'status', r.status, 'mode', r.mode, 'axes', v_axes,
    'targets', r.targets, 'rejected', v_reject);
end;
$$;

-- 4) 예약 등록
create or replace function public.offboard_schedule_create(
  p_actor        text,
  p_emails       text[],
  p_axes         text[],
  p_retire_dt    date,
  p_scheduled_at timestamptz,
  p_auto_apply   boolean default false,
  p_memo         text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare
  v_axes   text[] := coalesce((select array_agg(a) from unnest(p_axes) a where a in ('erp','gw','ms')), '{erp,gw,ms}'::text[]);
  v_built  jsonb;
  v_warn   text[] := '{}';
  v_kst    date;
  s        etl_meta.offboard_schedule%rowtype;
begin
  if p_actor is null or p_actor = '' then return jsonb_build_object('ok', false, 'reason', 'no_actor', 'msg', '요청자가 없습니다'); end if;
  if p_emails is null or array_length(p_emails, 1) is null then
    return jsonb_build_object('ok', false, 'reason', 'empty', 'msg', '대상이 없습니다');
  end if;
  if array_length(p_emails, 1) > 50 then
    return jsonb_build_object('ok', false, 'reason', 'too_many', 'msg', '한 번에 50명까지만 예약할 수 있습니다');
  end if;
  if p_scheduled_at is null then return jsonb_build_object('ok', false, 'reason', 'no_time', 'msg', '적용 일시를 입력하세요'); end if;
  if p_scheduled_at <= now() + interval '1 minute' then
    return jsonb_build_object('ok', false, 'reason', 'past', 'msg', '적용 일시는 지금보다 1분 이상 뒤여야 합니다(지금 처리하려면 「퇴사 처리」를 쓰세요)');
  end if;
  if p_scheduled_at > now() + interval '180 days' then
    return jsonb_build_object('ok', false, 'reason', 'too_far', 'msg', '적용 일시는 180일 이내여야 합니다');
  end if;

  -- 예약 시점 미리보기 — 지금 기준으로 무엇이 처리될지. 판정은 도래 시 다시 한다.
  v_built := public.offboard_build_targets(p_emails, v_axes, p_retire_dt);
  if jsonb_array_length(v_built->'targets') = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_valid_target', 'rejected', v_built->'rejected',
      'msg', '지금 기준으로 처리할 수 있는 대상이 없습니다(대사에 없는 이메일·퇴사일 없음·이미 정리됨)');
  end if;
  -- 예약 일시(KST 날짜)가 퇴사일보다 이르면 막지는 않되 경고를 남긴다 — 그룹웨어 자동화는 퇴사일이 지난 것을 전제로 한다.
  v_kst := (p_scheduled_at at time zone 'Asia/Seoul')::date;
  if exists (select 1 from jsonb_array_elements(v_built->'targets') t where (t->>'retire_dt')::date > v_kst) then
    v_warn := array_append(v_warn, '적용 일시가 일부 대상의 퇴사일보다 이릅니다 — 퇴사일 이후로 잡는 것을 권장합니다');  -- text[] || text 는 배열 리터럴로 해석돼 실패(실측)
  end if;

  insert into etl_meta.offboard_schedule
      (created_by, emails, axes, retire_dt_override, scheduled_at, auto_apply, memo, snapshot, history)
  values (p_actor,
          (select array_agg(distinct lower(trim(e))) from unnest(p_emails) e where e is not null and trim(e) <> ''),
          v_axes, p_retire_dt, p_scheduled_at, coalesce(p_auto_apply, false), nullif(trim(coalesce(p_memo,'')), ''),
          v_built,
          jsonb_build_array(jsonb_build_object('at', now(), 'by', p_actor, 'act', 'create',
            'note', case when coalesce(p_auto_apply,false) then '자동 적용' else '도래 시 확인' end)))
  returning * into s;

  return jsonb_build_object('ok', true, 'schedule_id', s.schedule_id, 'scheduled_at', s.scheduled_at,
    'auto_apply', s.auto_apply, 'targets', v_built->'targets', 'rejected', v_built->'rejected', 'warnings', to_jsonb(v_warn));
end;
$$;

-- 5) 승격 — 예약 1건을 큐에 넣는다(사람 확인 = manual, 도래 자동 = auto). 원자 선점 후 대상 재산정.
create or replace function public.offboard_schedule_promote(
  p_actor text, p_schedule_id uuid, p_kind text default 'manual')
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare
  s       etl_meta.offboard_schedule%rowtype;
  v_built jsonb;
  v_kind  text := case when p_kind = 'auto' then 'auto' else 'manual' end;
  r       etl_meta.offboard_request%rowtype;
begin
  -- 상태가 scheduled 인 행만 한 번에 하나가 집는다(같은 건을 cron·러너·화면이 동시에 승격하지 않게).
  update etl_meta.offboard_schedule
     set status = 'promoted', promoted_at = now(), promoted_by = p_actor, promoted_kind = v_kind
   where schedule_id = p_schedule_id and status = 'scheduled'
  returning * into s;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_scheduled', 'msg', '이미 처리됐거나 취소된 예약입니다');
  end if;

  v_built := public.offboard_build_targets(s.emails, s.axes, s.retire_dt_override);
  if jsonb_array_length(v_built->'targets') = 0 then
    -- 도래 시점에 할 일이 없다(이미 정리됨·대사에서 사라짐) → 큐에 넣지 않고 만료로 닫는다.
    update etl_meta.offboard_schedule
       set status = 'expired', expire_reason = 'no_valid_target', snapshot = v_built,
           history = history || jsonb_build_object('at', now(), 'by', p_actor, 'act', 'expire', 'note', '도래 시 처리 대상 없음')
     where schedule_id = p_schedule_id;
    return jsonb_build_object('ok', false, 'reason', 'no_valid_target', 'rejected', v_built->'rejected',
      'msg', '도래 시점에 처리할 대상이 없어 예약을 만료 처리했습니다');
  end if;

  insert into etl_meta.offboard_request
      (requested_by, mode, axes, targets, progress_total, retire_dt_override, origin, schedule_id)
  values (case when v_kind = 'auto' then s.created_by || ' (예약 자동)' else p_actor end,
          'apply', s.axes, v_built->'targets', jsonb_array_length(v_built->'targets'), s.retire_dt_override,
          'schedule', s.schedule_id)
  returning * into r;

  update etl_meta.offboard_schedule
     set request_id = r.request_id, snapshot = v_built,
         history = history || jsonb_build_object('at', now(), 'by', p_actor, 'act', 'promote', 'note',
                     case when v_kind = 'auto' then '도래 — 자동 큐 투입' else '확인 — 큐 투입' end)
   where schedule_id = p_schedule_id;

  return jsonb_build_object('ok', true, 'schedule_id', s.schedule_id, 'request_id', r.request_id,
    'kind', v_kind, 'targets', r.targets, 'rejected', v_built->'rejected');
end;
$$;

-- 6) 도래 자동 승격 — cron(1분)·러너 claim·목록 조회가 모두 이 함수를 부른다. 멱등.
create or replace function public.offboard_schedule_promote_due(p_grace interval default interval '7 days')
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare
  rec record; v_promoted int := 0; v_downgraded int := 0; v_expired int := 0; res jsonb;
begin
  for rec in
    select schedule_id, scheduled_at
      from etl_meta.offboard_schedule
     where status = 'scheduled' and auto_apply and scheduled_at <= now()
     order by scheduled_at
       for update skip locked
  loop
    if rec.scheduled_at + p_grace < now() then
      -- 너무 늦었다(스케줄러·러너가 모두 멈춰 있던 경우) — 자동을 풀고 사람 확인으로 돌린다.
      update etl_meta.offboard_schedule
         set auto_apply = false,
             history = history || jsonb_build_object('at', now(), 'by', 'system', 'act', 'downgrade',
                         'note', '도래 후 ' || p_grace::text || ' 초과 — 자동 적용 해제, 확인 필요')
       where schedule_id = rec.schedule_id;
      v_downgraded := v_downgraded + 1;
    else
      res := public.offboard_schedule_promote('system:auto', rec.schedule_id, 'auto');
      if coalesce((res->>'ok')::boolean, false) then v_promoted := v_promoted + 1;
      elsif res->>'reason' = 'no_valid_target' then v_expired := v_expired + 1;
      end if;
    end if;
  end loop;
  return jsonb_build_object('promoted', v_promoted, 'downgraded', v_downgraded, 'expired', v_expired, 'at', now());
end;
$$;

-- 7) 취소 — scheduled 인 것만. 이력은 남긴다(행 삭제 없음).
create or replace function public.offboard_schedule_cancel(p_actor text, p_schedule_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare s etl_meta.offboard_schedule%rowtype;
begin
  update etl_meta.offboard_schedule
     set status = 'cancelled', cancelled_at = now(), cancelled_by = p_actor, cancel_reason = nullif(trim(coalesce(p_reason,'')), ''),
         history = history || jsonb_build_object('at', now(), 'by', p_actor, 'act', 'cancel', 'note', coalesce(nullif(trim(coalesce(p_reason,'')), ''), '취소'))
   where schedule_id = p_schedule_id and status = 'scheduled'
  returning * into s;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_scheduled', 'msg', '이미 처리됐거나 취소된 예약입니다'); end if;
  return jsonb_build_object('ok', true, 'schedule_id', s.schedule_id);
end;
$$;

-- 8) 목록 — 화면용. 먼저 도래 자동 건을 승격하고(promote-on-read), 파생 상태를 붙여 돌려준다.
--    state: waiting(대기) · due(도래 — 확인 필요) · due_auto(도래 — 자동 승격 예정, 승격 직전 찰나)
--           · promoted(큐 투입됨 — 연결 요청 상태 동봉) · cancelled · expired
create or replace function public.offboard_schedule_list(p_days_back integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare v_rows jsonb; v_online boolean;
begin
  perform public.offboard_schedule_promote_due();
  select exists(select 1 from etl_meta.runner_heartbeat where seen_at > now() - interval '3 minutes') into v_online;
  select coalesce(jsonb_agg(jsonb_build_object(
      'schedule_id', s.schedule_id, 'created_at', s.created_at, 'created_by', s.created_by,
      'emails', to_jsonb(s.emails), 'axes', to_jsonb(s.axes), 'retire_dt_override', s.retire_dt_override,
      'scheduled_at', s.scheduled_at, 'auto_apply', s.auto_apply, 'memo', s.memo, 'status', s.status,
      'state', case
                 when s.status = 'scheduled' and s.scheduled_at <= now() and s.auto_apply then 'due_auto'
                 when s.status = 'scheduled' and s.scheduled_at <= now()                  then 'due'
                 when s.status = 'scheduled'                                              then 'waiting'
                 else s.status end,
      'due', (s.status = 'scheduled' and s.scheduled_at <= now()),
      'preview', s.snapshot,
      'promoted_at', s.promoted_at, 'promoted_by', s.promoted_by, 'promoted_kind', s.promoted_kind,
      'request_id', s.request_id,
      'request', case when r.request_id is null then null else jsonb_build_object(
          'status', r.status, 'progress_done', r.progress_done, 'progress_total', r.progress_total,
          'progress_target', r.progress_target, 'finished_at', r.finished_at, 'error_msg', r.error_msg,
          'ok_cnt', (select count(*) from jsonb_array_elements(coalesce(r.result->'targets','[]'::jsonb)) t where (t->>'ok')::boolean),
          'fail_cnt', (select count(*) from jsonb_array_elements(coalesce(r.result->'targets','[]'::jsonb)) t where not coalesce((t->>'ok')::boolean,false))) end,
      'cancelled_at', s.cancelled_at, 'cancelled_by', s.cancelled_by, 'cancel_reason', s.cancel_reason,
      'expire_reason', s.expire_reason, 'history', s.history) order by
        case when s.status = 'scheduled' then 0 when s.status = 'promoted' then 1 else 2 end, s.scheduled_at), '[]'::jsonb)
    into v_rows
    from etl_meta.offboard_schedule s
    left join etl_meta.offboard_request r on r.request_id = s.request_id
   where s.status in ('scheduled','promoted')
      or coalesce(s.cancelled_at, s.promoted_at, s.created_at) > now() - make_interval(days => greatest(coalesce(p_days_back,30), 1));
  return jsonb_build_object('rows', v_rows, 'runner_online', v_online, 'now', now(),
    'cron', exists(select 1 from cron.job where jobname = 'offboard_schedule_promote_due'));
end;
$$;

-- 9) 러너 선점 — 도래 승격 → 좀비 정리 → 원자 선점(status 재확인 + skip locked). 반환에 origin·schedule_id 추가.
create or replace function public.offboard_request_claim(p_runner text)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare r etl_meta.offboard_request%rowtype;
begin
  perform public.offboard_schedule_promote_due();   -- 러너가 돌 때마다 도래한 자동 예약을 큐에 넣는다(cron 이 멈춰 있어도)

  update etl_meta.offboard_request
     set status = 'failed', finished_at = now(),
         error_msg = coalesce(error_msg, '') || ' [자동종료: 30분 초과]'
   where status = 'running' and claimed_at < now() - interval '30 minutes';

  update etl_meta.offboard_request
     set status = 'running', claimed_at = now(), runner = p_runner
   where request_id = (select request_id from etl_meta.offboard_request
                        where status = 'queued' order by requested_at
                          for update skip locked limit 1)
     and status = 'queued'
  returning * into r;
  if not found then return null; end if;

  return jsonb_build_object('request_id', r.request_id, 'mode', r.mode,
    'axes', r.axes, 'targets', r.targets, 'requested_by', r.requested_by,
    'origin', r.origin, 'schedule_id', r.schedule_id);
end;
$$;

-- 10) 상태 조회에 출처 동봉(화면이 예약 승격 건임을 안다)
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
    'origin', r.origin, 'schedule_id', r.schedule_id,
    'runner_online', exists(select 1 from etl_meta.runner_heartbeat where seen_at > now() - interval '3 minutes'))
  from etl_meta.offboard_request r where r.request_id = p_request_id;
$$;

-- 11) 권한 — 전부 service_role 전용(42번 규칙: from public 포함)
revoke all on function public.offboard_build_targets(text[], text[], date)                              from public, anon, authenticated;
revoke all on function public.offboard_request_create(text[], text, text, text[], date)                  from public, anon, authenticated;
revoke all on function public.offboard_schedule_create(text, text[], text[], date, timestamptz, boolean, text) from public, anon, authenticated;
revoke all on function public.offboard_schedule_promote(text, uuid, text)                                from public, anon, authenticated;
revoke all on function public.offboard_schedule_promote_due(interval)                                    from public, anon, authenticated;
revoke all on function public.offboard_schedule_cancel(text, uuid, text)                                 from public, anon, authenticated;
revoke all on function public.offboard_schedule_list(integer)                                            from public, anon, authenticated;
revoke all on function public.offboard_request_claim(text)                                               from public, anon, authenticated;
revoke all on function public.offboard_request_status(uuid)                                              from public, anon, authenticated;
grant execute on function public.offboard_build_targets(text[], text[], date)                              to service_role;
grant execute on function public.offboard_request_create(text[], text, text, text[], date)                  to service_role;
grant execute on function public.offboard_schedule_create(text, text[], text[], date, timestamptz, boolean, text) to service_role;
grant execute on function public.offboard_schedule_promote(text, uuid, text)                                to service_role;
grant execute on function public.offboard_schedule_promote_due(interval)                                    to service_role;
grant execute on function public.offboard_schedule_cancel(text, uuid, text)                                 to service_role;
grant execute on function public.offboard_schedule_list(integer)                                            to service_role;
grant execute on function public.offboard_request_claim(text)                                               to service_role;
grant execute on function public.offboard_request_status(uuid)                                              to service_role;

-- 12) DB 스케줄러 작업 — 1분마다 도래 자동 승격·강등. 같은 이름이 있으면 갈아끼운다.
do $$
begin
  perform cron.unschedule('offboard_schedule_promote_due');
exception when others then null;
end $$;
select cron.schedule('offboard_schedule_promote_due', '* * * * *', $$select public.offboard_schedule_promote_due()$$);

-- ── 검증 ──────────────────────────────────────────────────────────────────
-- select jobname, schedule, active from cron.job;                       → offboard_schedule_promote_due · * * * * * · true
-- select public.offboard_schedule_list();                               → rows [] · runner_online · cron true
-- select public.offboard_schedule_create('tester', array['x@jeilm.co.kr'], '{erp,gw,ms}', '2026-09-30', now()+interval '2 hours', false, '테스트');
--   → 대사에 없으면 ok:false no_valid_target(rejected 에 사유) — 실대상은 화면에서.
-- select proname, has_function_privilege('anon', oid, 'EXECUTE') from pg_proc where proname like 'offboard_%';   → 전부 false
-- 롤백: cron.unschedule('offboard_schedule_promote_due'); drop function … offboard_schedule_*; drop table etl_meta.offboard_schedule;
--       alter table etl_meta.offboard_request drop column schedule_id, drop column origin; create 41번 정의로 복원.
