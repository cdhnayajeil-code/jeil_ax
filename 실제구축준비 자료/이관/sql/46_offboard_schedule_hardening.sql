-- ============================================================================
-- 46_offboard_schedule_hardening.sql — 퇴사 예약(45번) 적대 리뷰 반영 (2026-09-11 · REQ-0029 · ADR-015)
--
-- 45번을 적용한 뒤 3관점 리뷰 + 건별 3인 검증에서 확정된 결함을 고친다. 45번은 그대로 두고 이 파일이 덧댄다.
--   ① 즉시 요청의 재사용 키에 mode·축·요청 원문 이메일이 없어 「점검」이 「실행」을 삼키고(5분 내 재제출),
--      제외 대상이 하나라도 있으면 더블클릭 방지가 아예 안 걸렸다 → 원문 이메일 컬럼(req_emails) 추가 + mode·axes 비교.
--   ② pg_cron 이 매분 돌아 도래 즉시 큐에 넣으므로 45번의 「7일 강등」은 scheduled 단계에서만 작동하고,
--      큐(queued)에 들어간 예약 건은 러너가 며칠 뒤 켜져도 그대로 실행됐다 → claim 이 유예(7일) 초과 queued 예약 건을
--      failed 로 닫고 예약 이력에 남긴다(화면에는 「실패 — 유예 초과」로 보인다).
--   ③ 자동 승격이 「인사상 재직 중」 경고(hr_active)·화면 입력 퇴사일(override)로 통과된 대상을 걸러내지 않아
--      퇴사가 철회된 재직자를 무인으로 차단할 수 있었다 → 자동 승격은 경고 대상이 하나라도 있으면 승격하지 않고
--      자동을 풀어 「확인 필요」로 사람에게 넘긴다. 수동 확인용 미리보기(offboard_schedule_preview)를 둬 승인 전에
--      **현재 기준** 대상·경고를 보여 준다.
--   ④ 같은 사람이 같은 대상·같은 일시로 예약을 두 번 등록하면 두 건이 같은 틱에 승격돼 러너가 두 번 조작 → 재사용.
--   ⑤ 목록의 promoted 건이 기간 제한 없이 누적 → 최근 N일로 제한. cron.job_run_details 가 분당 1행씩 무한 누적 → 정리 job.
-- 권한: 42번 규칙(from public 포함).
-- ============================================================================

-- ① 요청 원문 이메일 보관
alter table etl_meta.offboard_request add column if not exists req_emails text[];
comment on column etl_meta.offboard_request.req_emails is '요청 원문 이메일(정규화·정렬) — 재사용(더블클릭) 판정용. targets 는 통과 대상만 담아 비교에 못 쓴다(46번)';

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
  v_axes    text[] := coalesce((select array_agg(a order by a) from (select distinct a from unnest(p_axes) a where a in ('erp','gw','ms')) x), '{gw}'::text[]);
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

  -- 더블클릭 방지 — 같은 사람이 **같은 모드·같은 축·같은 대상 원문**을 5분 안에 다시 내면 앞 요청을 돌려준다.
  -- (45번은 mode·axes 를 비교하지 않아 점검이 실행을 삼켰고, targets(통과 대상만)와 비교해 제외자가 있으면 아예 안 걸렸다)
  select array_agg(e order by e) into v_emails
    from (select distinct lower(trim(x)) e from unnest(p_emails) x where x is not null and trim(x) <> '') s;
  select * into r from etl_meta.offboard_request
   where status in ('queued','running') and requested_at > now() - interval '5 minutes'
     and requested_by = coalesce(p_requested_by, 'unknown') and origin = 'manual'
     and mode = v_mode and axes = v_axes and req_emails = v_emails
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
      (requested_by, mode, axes, targets, progress_total, retire_dt_override, origin, req_emails)
  values (coalesce(p_requested_by, 'unknown'), v_mode, v_axes, v_targets, jsonb_array_length(v_targets), p_retire_dt, 'manual', v_emails)
  returning * into r;

  return jsonb_build_object('ok', true, 'reused', false, 'runner_online', v_online,
    'request_id', r.request_id, 'status', r.status, 'mode', r.mode, 'axes', v_axes,
    'targets', r.targets, 'rejected', v_reject);
end;
$$;

-- ③ 승격 — auto 는 경고 대상(인사상 재직·퇴사일이 아직 미래)이 있으면 승격하지 않고 확인 필요로 강등
create or replace function public.offboard_schedule_promote(
  p_actor text, p_schedule_id uuid, p_kind text default 'manual')
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare
  s        etl_meta.offboard_schedule%rowtype;
  v_built  jsonb;
  v_kind   text := case when p_kind = 'auto' then 'auto' else 'manual' end;
  v_warned jsonb;
  r        etl_meta.offboard_request%rowtype;
begin
  update etl_meta.offboard_schedule
     set status = 'promoted', promoted_at = now(), promoted_by = p_actor, promoted_kind = v_kind
   where schedule_id = p_schedule_id and status = 'scheduled'
  returning * into s;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_scheduled', 'msg', '이미 처리됐거나 취소된 예약입니다');
  end if;

  v_built := public.offboard_build_targets(s.emails, s.axes, s.retire_dt_override);
  if jsonb_array_length(v_built->'targets') = 0 then
    update etl_meta.offboard_schedule
       set status = 'expired', expire_reason = 'no_valid_target', snapshot = v_built,
           history = history || jsonb_build_object('at', now(), 'by', p_actor, 'act', 'expire', 'note', '도래 시 처리 대상 없음')
     where schedule_id = p_schedule_id;
    return jsonb_build_object('ok', false, 'reason', 'no_valid_target', 'rejected', v_built->'rejected',
      'msg', '도래 시점에 처리할 대상이 없어 예약을 만료 처리했습니다');
  end if;

  -- 자동 승격 안전장치: 인사상 재직 중(warn)이거나 퇴사일이 아직 오지 않은 대상이 있으면 사람이 봐야 한다.
  --   (예약 뒤 퇴사가 철회됐는데 화면 입력 퇴사일(override)로 통과되는 경우 — 리뷰에서 확인)
  if v_kind = 'auto' then
    select coalesce(jsonb_agg(t), '[]'::jsonb) into v_warned
      from jsonb_array_elements(v_built->'targets') t
     where t->>'warn' is not null
        or (t->>'retire_dt')::date > (now() at time zone 'Asia/Seoul')::date;
    if jsonb_array_length(v_warned) > 0 then
      update etl_meta.offboard_schedule
         set status = 'scheduled', promoted_at = null, promoted_by = null, promoted_kind = null,
             auto_apply = false, snapshot = v_built,
             history = history || jsonb_build_object('at', now(), 'by', 'system', 'act', 'downgrade',
                         'note', '자동 적용 보류 — 인사상 재직 중이거나 퇴사일이 아직인 대상 ' || jsonb_array_length(v_warned) || '명, 확인 필요')
       where schedule_id = p_schedule_id;
      return jsonb_build_object('ok', false, 'reason', 'needs_review', 'warned', v_warned,
        'msg', '재직 중이거나 퇴사일이 아직인 대상이 있어 자동 적용을 보류하고 확인 필요로 돌렸습니다');
    end if;
  end if;

  insert into etl_meta.offboard_request
      (requested_by, mode, axes, targets, progress_total, retire_dt_override, origin, schedule_id, req_emails)
  values (case when v_kind = 'auto' then s.created_by || ' (예약 자동)' else p_actor end,
          'apply', s.axes, v_built->'targets', jsonb_array_length(v_built->'targets'), s.retire_dt_override,
          'schedule', s.schedule_id, (select array_agg(e order by e) from unnest(s.emails) e))
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

-- promote_due 의 집계에 needs_review 를 반영(강등 건수에 합산)
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
      elsif res->>'reason' = 'needs_review' then v_downgraded := v_downgraded + 1;
      end if;
    end if;
  end loop;
  return jsonb_build_object('promoted', v_promoted, 'downgraded', v_downgraded, 'expired', v_expired, 'at', now());
end;
$$;

-- ③ 수동 확인용 미리보기 — 승인 전에 **현재 기준** 대상·경고를 보여 준다(옛 snapshot 이 아니라)
create or replace function public.offboard_schedule_preview(p_schedule_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare s etl_meta.offboard_schedule%rowtype;
begin
  select * into s from etl_meta.offboard_schedule where schedule_id = p_schedule_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found', 'msg', '예약을 찾을 수 없습니다'); end if;
  return jsonb_build_object('ok', true, 'status', s.status, 'scheduled_at', s.scheduled_at, 'auto_apply', s.auto_apply,
    'current', public.offboard_build_targets(s.emails, s.axes, s.retire_dt_override));
end;
$$;

-- ④ 예약 재사용 — 같은 사람·같은 대상·같은 일시의 scheduled 건이 있으면 그것을 돌려준다(중복 등록 방지)
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
  v_axes   text[] := coalesce((select array_agg(a order by a) from (select distinct a from unnest(p_axes) a where a in ('erp','gw','ms')) x), '{erp,gw,ms}'::text[]);
  v_emails text[];
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

  select array_agg(e order by e) into v_emails
    from (select distinct lower(trim(x)) e from unnest(p_emails) x where x is not null and trim(x) <> '') q;

  -- 중복 등록 방지 — 같은 사람이 같은 대상·같은 일시로 이미 잡아 둔 예약이 있으면 그것을 돌려준다.
  select * into s from etl_meta.offboard_schedule
   where status = 'scheduled' and created_by = p_actor and scheduled_at = p_scheduled_at
     and (select array_agg(e order by e) from unnest(emails) e) = v_emails
   order by created_at limit 1;
  if found then
    return jsonb_build_object('ok', true, 'reused', true, 'schedule_id', s.schedule_id, 'scheduled_at', s.scheduled_at,
      'auto_apply', s.auto_apply, 'targets', coalesce(s.snapshot->'targets', '[]'::jsonb),
      'rejected', coalesce(s.snapshot->'rejected', '[]'::jsonb), 'warnings', to_jsonb(array['같은 대상·같은 일시의 예약이 이미 있어 그 예약을 그대로 둡니다']));
  end if;

  v_built := public.offboard_build_targets(p_emails, v_axes, p_retire_dt);
  if jsonb_array_length(v_built->'targets') = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_valid_target', 'rejected', v_built->'rejected',
      'msg', '지금 기준으로 처리할 수 있는 대상이 없습니다(대사에 없는 이메일·퇴사일 없음·이미 정리됨)');
  end if;
  v_kst := (p_scheduled_at at time zone 'Asia/Seoul')::date;
  if exists (select 1 from jsonb_array_elements(v_built->'targets') t where (t->>'retire_dt')::date > v_kst) then
    v_warn := array_append(v_warn, '적용 일시가 일부 대상의 퇴사일보다 이릅니다 — 퇴사일 이후로 잡는 것을 권장합니다');
  end if;
  if exists (select 1 from jsonb_array_elements(v_built->'targets') t where t->>'warn' is not null) then
    v_warn := array_append(v_warn, '인사상 재직 중인 대상이 있습니다 — 자동 적용을 켜도 도래 시 재직 중이면 자동 처리하지 않고 확인 필요로 돌립니다');
  end if;

  insert into etl_meta.offboard_schedule
      (created_by, emails, axes, retire_dt_override, scheduled_at, auto_apply, memo, snapshot, history)
  values (p_actor, v_emails, v_axes, p_retire_dt, p_scheduled_at, coalesce(p_auto_apply, false), nullif(trim(coalesce(p_memo,'')), ''),
          v_built,
          jsonb_build_array(jsonb_build_object('at', now(), 'by', p_actor, 'act', 'create',
            'note', case when coalesce(p_auto_apply,false) then '자동 적용' else '도래 시 확인' end)))
  returning * into s;

  return jsonb_build_object('ok', true, 'reused', false, 'schedule_id', s.schedule_id, 'scheduled_at', s.scheduled_at,
    'auto_apply', s.auto_apply, 'targets', v_built->'targets', 'rejected', v_built->'rejected', 'warnings', to_jsonb(v_warn));
end;
$$;

-- ⑤ 목록 — promoted 도 최근 N일로 제한(무한 누적 방지). 그 외는 45번과 같다.
create or replace function public.offboard_schedule_list(p_days_back integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare v_rows jsonb; v_online boolean; v_days integer := greatest(coalesce(p_days_back,30), 1);
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
        case when s.status = 'scheduled' then 0 when s.status = 'promoted' and r.status in ('queued','running') then 1 else 2 end, s.scheduled_at desc), '[]'::jsonb)
    into v_rows
    from etl_meta.offboard_schedule s
    left join etl_meta.offboard_request r on r.request_id = s.request_id
   where s.status = 'scheduled'
      or (s.status = 'promoted' and r.status in ('queued','running'))
      or coalesce(s.cancelled_at, s.promoted_at, s.created_at) > now() - make_interval(days => v_days);
  return jsonb_build_object('rows', v_rows, 'runner_online', v_online, 'now', now(),
    'cron', exists(select 1 from cron.job where jobname = 'offboard_schedule_promote_due'));
end;
$$;

-- ② 러너 선점 — 유예(7일) 초과한 큐의 예약 건은 실행하지 않고 실패로 닫는다(예약 이력에 남김)
create or replace function public.offboard_request_claim(p_runner text)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $$
declare r etl_meta.offboard_request%rowtype; rec record;
begin
  perform public.offboard_schedule_promote_due();

  -- 예약 승격 건이 큐에서 7일 넘게 기다렸다면(러너가 그동안 꺼져 있었다) 옛 대상으로 실행하지 않는다.
  for rec in
    update etl_meta.offboard_request
       set status = 'failed', finished_at = now(),
           error_msg = '예약 도래 후 유예 7일 초과 — 러너 미가동으로 미실행. 필요하면 다시 예약하거나 즉시 처리하세요'
     where status = 'queued' and origin = 'schedule' and requested_at < now() - interval '7 days'
     returning request_id, schedule_id
  loop
    update etl_meta.offboard_schedule
       set history = history || jsonb_build_object('at', now(), 'by', 'system', 'act', 'expired_in_queue',
                       'note', '큐 대기 7일 초과 — 실행하지 않고 닫음(요청 ' || left(rec.request_id::text, 8) || '…)')
     where schedule_id = rec.schedule_id;
  end loop;

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

-- 권한
revoke all on function public.offboard_request_create(text[], text, text, text[], date)                  from public, anon, authenticated;
revoke all on function public.offboard_schedule_promote(text, uuid, text)                                from public, anon, authenticated;
revoke all on function public.offboard_schedule_promote_due(interval)                                    from public, anon, authenticated;
revoke all on function public.offboard_schedule_preview(uuid)                                            from public, anon, authenticated;
revoke all on function public.offboard_schedule_create(text, text[], text[], date, timestamptz, boolean, text) from public, anon, authenticated;
revoke all on function public.offboard_schedule_list(integer)                                            from public, anon, authenticated;
revoke all on function public.offboard_request_claim(text)                                               from public, anon, authenticated;
grant execute on function public.offboard_request_create(text[], text, text, text[], date)                  to service_role;
grant execute on function public.offboard_schedule_promote(text, uuid, text)                                to service_role;
grant execute on function public.offboard_schedule_promote_due(interval)                                    to service_role;
grant execute on function public.offboard_schedule_preview(uuid)                                            to service_role;
grant execute on function public.offboard_schedule_create(text, text[], text[], date, timestamptz, boolean, text) to service_role;
grant execute on function public.offboard_schedule_list(integer)                                            to service_role;
grant execute on function public.offboard_request_claim(text)                                               to service_role;

-- ⑤ cron 실행 이력 정리 — 1분 job 은 하루 1,440행을 남긴다. 7일치만 둔다.
do $$
begin
  perform cron.unschedule('cron_run_details_purge');
exception when others then null;
end $$;
select cron.schedule('cron_run_details_purge', '15 18 * * *', $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);  -- 18:15 UTC = 03:15 KST

-- ── 검증 ──────────────────────────────────────────────────────────────────
-- select jobname, schedule from cron.job;   → offboard_schedule_promote_due(* * * * *) · cron_run_details_purge(15 18 * * *)
-- 재사용: 같은 사람이 check 후 5분 내 apply → reused:false(새 요청) · 같은 mode·축·대상이면 reused:true
-- 자동 승격 보류: hr_active 대상이 있는 auto 예약 도래 → promote_due 결과 downgraded 1 · 예약 status=scheduled·auto_apply=false·history downgrade
