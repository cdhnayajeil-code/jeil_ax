-- 30_gl_apply_diag.sql
-- 결의전표 ERP 전송 — 실패 사유 보존 · 중계 생존 신호 · 적체 진단
-- 작성 2026-08-25 · 관리 최동혁 · 대상 프로젝트 jeilax(포털 DB)
--
-- ▣ 왜 필요한가 (2026-08-25 실측)
--   화면에서 [🚀 ERP 전송]을 누르면 "전송 대기 중 — 사내 중계가 곧 가져갑니다"만 표시된다.
--   그런데 중계(gl_apply_demo2.py)가 돌지 않으면 이 문구는 영원히 지켜지지 않는다.
--   실제로 05:51:58 apply_request → 05:52:03~05:53:21 화면 폴링 17회 무응답 → 그대로 방치됐다.
--   화면은 (a)중계가 살아 있는지 (b)얼마나 기다렸는지 (c)직전에 왜 실패했는지 를 전부 모른다.
--
--   더 나쁜 것은 재전송이 사유를 지운다는 점이다.
--   apply_request 는 erp_apply_msg 를 null 로 만든다 → 직전 실패 사유가 화면에서 사라지고,
--   상태만 'ready' 로 돌아가 "왜 대기만 하는지" 알 길이 없어진다.
--   (DRAFT-20260824-0015 실제 사례: 08-24 실패 사유가 08-25 재전송으로 소실)
--
-- ▣ 무엇을 바꾸는가
--   1) 실패 사유를 재전송에도 살아남는 자리(erp_last_error)로 옮긴다.
--   2) 대기 진입 시각(erp_ready_at)을 따로 잡는다 — erp_apply_at 은 중계 선점이 덮어써서 못 쓴다.
--   3) 중계 심박(gl_relay_heartbeat)을 신설한다 — 조용한 것과 죽은 것을 구분하는 유일한 방법.
--      원장(gl_erp_apply_log)은 '일이 있을 때만' 기록되므로 생존 신호로 쓸 수 없다.
--   4) 화면이 한 번에 물어볼 수 있는 진단 RPC 2종(health·problems)을 만든다.
--
-- ▣ 안전
--   기존 컬럼·데이터를 지우지 않는다. 전부 add column if not exists + 백필.
--   RPC 는 service_role 전용(포털은 Edge Function 의 admin 클라이언트로만 호출).

begin;

-- ══════════════════════════════════════════════════════════════
-- 1. gl_draft — 실패 사유·대기 시각·시도 횟수
-- ══════════════════════════════════════════════════════════════
alter table public.gl_draft
  add column if not exists erp_last_error    text,
  add column if not exists erp_last_error_at timestamptz,
  add column if not exists erp_attempts      integer not null default 0,
  add column if not exists erp_ready_at      timestamptz;

comment on column public.gl_draft.erp_last_error is
  '최근 전송 실패 사유. 재전송(ready 재마킹)해도 지워지지 않는다 — 전송 성공 시에만 비운다. '
  'erp_apply_msg 는 선점 워커명으로 덮어써지는 임시 칸이라 사유 보관에 쓸 수 없다.';
comment on column public.gl_draft.erp_last_error_at is '위 사유가 기록·재판정된 시각';
comment on column public.gl_draft.erp_attempts is 'commit 시도 횟수(성공·실패 합산). 반복 실패 감지용';
comment on column public.gl_draft.erp_ready_at is
  '전송 대기 진입 시각. 대기 경과는 반드시 이 값으로 계산한다 — '
  'erp_apply_at 은 gl_apply_claim 이 선점할 때 now() 로 덮어쓰므로 경과가 0으로 리셋된다.';

-- ── 백필 1: 현재 failed 건의 사유를 보존 칸으로 복사 ──
update public.gl_draft
   set erp_last_error    = erp_apply_msg,
       erp_last_error_at = coalesce(erp_apply_at, updated_at)
 where erp_apply_status = 'failed'
   and erp_last_error is null
   and coalesce(erp_apply_msg, '') <> '';

-- ── 백필 2: 재전송으로 지워진 사유를 원장에서 복원 ──
with last_fail as (
  select distinct on (draft_no)
         draft_no, detail->>'error' as err, created_at
    from public.gl_erp_apply_log
   where mode = 'commit' and status = 'failed'
   order by draft_no, created_at desc
)
update public.gl_draft d
   set erp_last_error    = lf.err,
       erp_last_error_at = lf.created_at
  from last_fail lf
 where d.draft_no = lf.draft_no
   and d.erp_last_error is null
   and coalesce(d.erp_apply_status, '') <> 'applied';

-- ── 백필 3: 시도 횟수 ──
with c as (
  select draft_no, count(*)::int as n
    from public.gl_erp_apply_log
   where mode = 'commit'
   group by draft_no
)
update public.gl_draft d
   set erp_attempts = c.n
  from c
 where d.draft_no = c.draft_no and d.erp_attempts = 0;

-- ── 백필 4: 대기 중인 건의 진입 시각(정확한 값이 없으므로 updated_at 으로 근사) ──
update public.gl_draft
   set erp_ready_at = updated_at
 where erp_apply_status = 'ready' and erp_ready_at is null;

-- 적체 조회용 — 대기/실패 건만 훑는다
create index if not exists gl_draft_erp_apply_status_idx
  on public.gl_draft (erp_apply_status, erp_ready_at)
  where erp_apply_status in ('ready', 'sending', 'failed');


-- ══════════════════════════════════════════════════════════════
-- 2. gl_relay_heartbeat — 중계 생존 신호
--    "대기 건이 없어서 조용한 것"과 "중계가 죽어서 조용한 것"을 구분한다.
-- ══════════════════════════════════════════════════════════════
create table if not exists public.gl_relay_heartbeat (
  worker     text primary key,
  target_db  text        not null,
  last_at    timestamptz not null default now(),
  version    text,
  note       text
);
comment on table public.gl_relay_heartbeat is
  '사내 중계(gl_apply_demo2.py)의 심박. --queue 매 회차마다 갱신한다. '
  '원장은 일이 있을 때만 쌓이므로 생존 판정에 쓸 수 없어 별도로 둔다.';

alter table public.gl_relay_heartbeat enable row level security;  -- 정책 없음 = service_role 만

create or replace function public.gl_relay_ping(
  p_worker  text,
  p_target  text default 'JEILMNS_DEMO2',
  p_version text default null,
  p_note    text default null
) returns timestamptz
  language sql security definer set search_path to ''
as $function$
  insert into public.gl_relay_heartbeat as h (worker, target_db, last_at, version, note)
  values (p_worker, p_target, now(), p_version, p_note)
  on conflict (worker) do update
     set last_at = now(), target_db = excluded.target_db,
         version = coalesce(excluded.version, h.version),
         note    = excluded.note
  returning last_at;
$function$;


-- ══════════════════════════════════════════════════════════════
-- 2-b. 원장에 precheck(재판정) 모드 허용
--      dryrun 과 다르다: dryrun 은 전표를 만들었다 되돌려 AG 채번을 소모하지만,
--      precheck 는 쓰기 직전(채번 앞)에서 멈추므로 ERP 에 아무 흔적도 남기지 않는다.
-- ══════════════════════════════════════════════════════════════
alter table public.gl_erp_apply_log drop constraint if exists gl_erp_apply_log_mode_check;
alter table public.gl_erp_apply_log add constraint gl_erp_apply_log_mode_check
  check (mode = any (array['dryrun'::text, 'commit'::text, 'cleanup'::text, 'precheck'::text]));


-- ══════════════════════════════════════════════════════════════
-- 3. gl_apply_record — 실패 사유를 보존 칸에도 기록 + precheck(재판정) 분기
--    기존 동작(성공 시 확정·cleanup 시 초기화)은 그대로 두고 필드만 늘린다.
-- ══════════════════════════════════════════════════════════════
create or replace function public.gl_apply_record(p jsonb)
 returns bigint
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_id bigint; v_err text; v_blocks text;
begin
  -- cleanup 성공 시: 기존 성공 커밋을 철회 처리(유니크 인덱스 해제 → 재적용 허용)
  if coalesce(p->>'mode','') = 'cleanup' and coalesce(p->>'status','') = 'success' then
    update public.gl_erp_apply_log
       set status = 'rolled_back',
           detail = coalesce(detail,'{}'::jsonb) || jsonb_build_object('superseded_by_cleanup', now())
     where draft_no = p->>'draft_no' and target_db = p->>'target_db'
       and mode = 'commit' and status = 'success';
  end if;

  insert into public.gl_erp_apply_log
    (draft_no, target_db, ref_no, batch_no, gl_no, trans_type, mode, status,
     msg_cd, lines_in, lines_out, line_match, detail, applied_by)
  values
    (p->>'draft_no', p->>'target_db', coalesce(p->>'ref_no', p->>'draft_no'),
     p->>'batch_no', p->>'gl_no', p->>'trans_type',
     coalesce(p->>'mode','dryrun'), coalesce(p->>'status','failed'),
     p->>'msg_cd',
     nullif(p->>'lines_in','')::int, nullif(p->>'lines_out','')::int,
     nullif(p->>'line_match','')::boolean,
     p->'detail', p->>'applied_by')
  returning id into v_id;

  -- 사람이 읽을 사유 한 줄.
  -- 가드 차단이면 '위 사유를 확인하세요'(콘솔 출력을 전제한 안내문)가 아니라 차단 내역 자체가 사유다.
  -- 화면은 콘솔을 볼 수 없으므로, 어느 줄의 어느 계정이 왜 막혔는지가 그대로 들어가야 한다.
  if p->'detail' ? 'guard_blocks' then
    select string_agg(format('%s번 줄 %s(%s) — %s', b->>'seq', b->>'acct', b->>'fg', b->>'why'), E'\n')
      into v_blocks from jsonb_array_elements(p->'detail'->'guard_blocks') b;
    v_err := format('입력검증 차단 %s건 — ERP에 아무것도 투입하지 않았습니다.',
                    jsonb_array_length(p->'detail'->'guard_blocks')) || E'\n' || v_blocks;
  else
    v_err := nullif(btrim(coalesce(p->>'msg_cd','') || ' ' || coalesce(p->'detail'->>'error','')), '');
  end if;

  if coalesce(p->>'mode','') = 'commit' and coalesce(p->>'status','') = 'success' then
    -- 전송 성공 = 확정. ERP가 채번한 번호를 그대로 전표번호로 기록한다.
    update public.gl_draft
       set erp_apply_target = p->>'target_db',
           erp_apply_status = 'applied',
           erp_apply_gl_no  = p->>'gl_no',
           erp_apply_at     = now(),
           erp_apply_msg    = null,
           erp_last_error   = null,          -- 성공했으므로 과거 사유는 유효하지 않다
           erp_last_error_at= null,
           erp_ready_at     = null,
           erp_attempts     = coalesce(erp_attempts,0) + 1,
           status           = case when status = 'submitted' then 'posted' else status end,
           erp_temp_gl_no   = coalesce(erp_temp_gl_no, p->>'gl_no'),
           posted_by        = coalesce(posted_by, p->>'applied_by'),
           posted_at        = coalesce(posted_at, now()),
           updated_at       = now()
     where draft_no = p->>'draft_no';

  elsif coalesce(p->>'mode','') = 'commit' then
    update public.gl_draft
       set erp_apply_target = p->>'target_db',
           erp_apply_status = 'failed',
           erp_apply_at     = now(),          -- 언제 실패했는지도 초안에 남긴다
           erp_apply_msg    = left(coalesce(v_err,'실패 사유 미기록'), 300),
           erp_last_error   = left(coalesce(v_err,'실패 사유 미기록'), 2000),
           erp_last_error_at= now(),
           erp_ready_at     = null,
           erp_attempts     = coalesce(erp_attempts,0) + 1,
           updated_at       = now()
     where draft_no = p->>'draft_no';

  elsif coalesce(p->>'mode','') = 'precheck' then
    -- 재판정(--recheck) — ERP 에 아무것도 넣지 않고 사유만 현행화한다.
    -- 규칙이 바뀌면(예: 결정 C-15) 옛 사유가 남아 사람을 엉뚱한 곳으로 보낸다.
    update public.gl_draft
       set erp_last_error = case
             when coalesce(p->>'status','') = 'success'
               then '(재판정 ' || to_char(now() at time zone 'Asia/Seoul', 'MM-DD HH24:MI')
                    || ') 현재 규칙으로는 차단되지 않습니다 — 재전송하면 투입됩니다.'
             else left(coalesce(v_err,'재판정 실패'), 2000) end,
           erp_last_error_at = now(),
           updated_at        = now()
     where draft_no = p->>'draft_no';

  elsif coalesce(p->>'mode','') = 'cleanup' and coalesce(p->>'status','') = 'success' then
    -- 데모 정리 — 적용 흔적과 확정을 함께 되돌린다(원장에는 이력이 남는다)
    update public.gl_draft
       set erp_apply_target = null, erp_apply_status = null,
           erp_apply_gl_no = null, erp_apply_at = null, erp_apply_msg = null,
           erp_last_error = null, erp_last_error_at = null, erp_ready_at = null,
           status = case when status = 'posted' then 'submitted' else status end,
           erp_temp_gl_no = null, posted_by = null, posted_at = null,
           updated_at = now()
     where draft_no = p->>'draft_no';
  end if;
  return v_id;
end $function$;


-- ══════════════════════════════════════════════════════════════
-- 4. gl_apply_claim — 선점 시 대기 진입 시각을 지우지 않는다
--    (실패로 되돌아갈 때 "언제부터 기다렸나"를 잃지 않기 위해)
-- ══════════════════════════════════════════════════════════════
create or replace function public.gl_apply_claim(p_target text, p_max integer default 5, p_worker text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v jsonb;
begin
  with cand as (
    select d.draft_no
    from public.gl_draft d
    where d.status = 'submitted'
      and d.erp_apply_status = 'ready'
      and coalesce(d.erp_apply_target, p_target) = p_target
      and not exists (select 1 from public.gl_erp_apply_log l
                       where l.draft_no = d.draft_no and l.target_db = p_target
                         and l.mode = 'commit' and l.status = 'success')
    order by d.submitted_at
    limit greatest(1, least(coalesce(p_max, 5), 20))
    for update skip locked          -- 다른 러너가 잡은 행은 건너뛴다
  ),
  upd as (
    update public.gl_draft d
       set erp_apply_status = 'sending',
           erp_apply_target = p_target,
           erp_apply_at     = now(),
           erp_apply_msg    = coalesce(p_worker, 'relay'),
           erp_ready_at     = coalesce(d.erp_ready_at, now()),   -- 유지(경과 계산의 기준점)
           updated_at       = now()
      from cand where d.draft_no = cand.draft_no
    returning d.draft_no, d.draft_dt, d.gl_desc, d.dept_nm, d.dr_total, d.submitted_at
  )
  select coalesce(jsonb_agg(u order by u.submitted_at), '[]'::jsonb) into v from upd u;
  return v;
end $function$;


-- ══════════════════════════════════════════════════════════════
-- 5. gl_apply_health — 화면 상단 배너용 한 방 조회
-- ══════════════════════════════════════════════════════════════
create or replace function public.gl_apply_health(
  p_target    text default 'JEILMNS_DEMO2',
  p_stale_min integer default 30      -- 이 시간 넘게 대기하면 '적체'
) returns jsonb
  language sql security definer set search_path to ''
as $function$
  with hb as (
    select max(last_at) as last_at from public.gl_relay_heartbeat where target_db = p_target
  ), q as (
    select
      count(*) filter (where erp_apply_status = 'ready')                        as waiting,
      count(*) filter (where erp_apply_status = 'sending')                      as sending,
      count(*) filter (where erp_apply_status = 'failed' and status='submitted') as failed,
      min(coalesce(erp_ready_at, updated_at)) filter (where erp_apply_status = 'ready') as oldest
    from public.gl_draft
  )
  select jsonb_build_object(
    'target',        p_target,
    'stale_min',     p_stale_min,
    'relay_last_at', hb.last_at,
    -- 심박이 아예 없으면(중계가 이 버전을 아직 안 씀) null → 화면은 '알 수 없음'으로 표시한다
    'relay_idle_min', case when hb.last_at is null then null
                           else floor(extract(epoch from (now() - hb.last_at)) / 60)::int end,
    'relay_alive',   case when hb.last_at is null then null
                           else hb.last_at > now() - interval '10 minutes' end,
    'waiting_cnt',   q.waiting,
    'sending_cnt',   q.sending,
    'failed_cnt',    q.failed,
    'waiting_oldest_min', case when q.oldest is null then null
                           else floor(extract(epoch from (now() - q.oldest)) / 60)::int end,
    'stalled',       coalesce(q.oldest < now() - make_interval(mins => greatest(1, p_stale_min)), false)
  ) from hb, q;
$function$;


-- ══════════════════════════════════════════════════════════════
-- 6. gl_apply_problems — 실패·적체 목록(화면 「손봐야 할 건」 패널)
-- ══════════════════════════════════════════════════════════════
create or replace function public.gl_apply_problems(
  p_target    text default 'JEILMNS_DEMO2',
  p_stale_min integer default 30
) returns jsonb
  language sql security definer set search_path to ''
as $function$
  select coalesce(jsonb_agg(t order by t.since), '[]'::jsonb) from (
    select d.draft_no, d.draft_dt, d.gl_desc, d.dept_nm, d.owner_nm,
           d.dr_total, d.erp_apply_status, d.erp_attempts,
           -- 사유는 보존 칸이 우선. erp_apply_msg 는 선점 중이면 워커명이라 신뢰할 수 없다.
           coalesce(d.erp_last_error,
                    case when d.erp_apply_status = 'failed' then d.erp_apply_msg end) as reason,
           d.erp_last_error_at,
           case when d.erp_apply_status = 'failed'  then 'failed'
                when d.erp_apply_status = 'sending' then 'stuck'
                else 'stale' end                                          as kind,
           coalesce(d.erp_ready_at, d.erp_apply_at, d.updated_at)         as since,
           floor(extract(epoch from (now() - coalesce(d.erp_ready_at, d.erp_apply_at, d.updated_at))) / 60)::int as wait_min
      from public.gl_draft d
     where d.status = 'submitted'
       and (
            d.erp_apply_status = 'failed'
         or (d.erp_apply_status = 'ready'
             and coalesce(d.erp_ready_at, d.updated_at) < now() - make_interval(mins => greatest(1, p_stale_min)))
         or (d.erp_apply_status = 'sending'
             and d.erp_apply_at < now() - interval '30 minutes')
       )
     limit 100
  ) t;
$function$;


-- ══════════════════════════════════════════════════════════════
-- 7. 권한 — 전부 service_role 전용(포털은 Edge Function 경유)
-- ══════════════════════════════════════════════════════════════
revoke all on function public.gl_relay_ping(text, text, text, text)   from public, anon, authenticated;
revoke all on function public.gl_apply_health(text, integer)          from public, anon, authenticated;
revoke all on function public.gl_apply_problems(text, integer)        from public, anon, authenticated;
grant execute on function public.gl_relay_ping(text, text, text, text) to service_role;
grant execute on function public.gl_apply_health(text, integer)        to service_role;
grant execute on function public.gl_apply_problems(text, integer)      to service_role;

commit;
