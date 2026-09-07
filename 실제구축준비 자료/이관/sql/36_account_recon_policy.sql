-- ============================================================================
-- 36_account_recon_policy.sql — 계정 대사 판정 정책 2건 (2026-09-07, 관리자 지시)
--
-- 대사 화면이 "조치해야 할 것"만 보여주려면, **조치가 필요 없는 것**을 판정에서
-- 걸러내야 한다. 지금은 두 종류가 계속 빨간 줄로 남아 화면을 흐리고 있었다.
--
--  ① ERP 계정이 없는 생산팀 — 결함이 아니라 정상이다.
--     생산 현장 인원은 ERP를 쓰지 않아 계정을 만들지 않는다. 그런데 대사는
--     "인사 재직인데 ERP 계정 없음 = 계정없음(조치 필요)"으로 찍었다(6명).
--     → 부서 정책 테이블을 두고, 등재된 부서면 '정상'으로 본다.
--
--  ② 사람이 아닌 MS 계정 — 회의실·차량·공유메일함·시스템 계정.
--     차량관리·법인차량예약·서울 2층 대회의실처럼 **사람이 아닌 ID**가
--     '현재 인원'에 섞여 인원수를 부풀리고 'ERP·인사없음'으로 조치 대상에 잡혔다.
--     → 비사람 계정 목록을 두고 현재 인원에서 제외한다.
--
-- 왜 하드코딩이 아니라 테이블인가: 회의실·차량은 계속 늘고 줄고, ERP 면제 부서도
-- 조직개편으로 바뀐다. 뷰 정의를 고치는 대신 **한 줄 INSERT/DELETE 로 운영**한다.
-- 등재하지 않은 새 계정은 그대로 'ERP·인사없음'으로 드러나므로, 누락은 화면이 알려준다
-- (자동 규칙으로 이름·이메일 패턴을 추정하면 사람 계정을 조용히 숨길 위험이 있어 쓰지 않는다).
--
-- 적용 후 예상: 현재 인원 135 → 109, 계정없음 8 → 2, ERP·인사없음 32 → 6
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- 1. ERP 계정 면제 부서 — 여기 등재된 부서는 ERP 계정이 없어도 '정상'
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.acct_erp_optional_dept (
  dept_nm  text primary key,
  note     text,
  added_at timestamptz not null default now()
);

comment on table public.acct_erp_optional_dept is
  'ERP 계정이 없어도 정상으로 보는 부서(인사 부서명 기준). 생산 현장처럼 ERP를 쓰지 않는 조직. '
  '대사에서 "계정없음" 판정을 면제한다 — 부서명이 바뀌면 이 표도 함께 고쳐야 한다.';

insert into public.acct_erp_optional_dept (dept_nm, note) values
  ('생산팀', 'ERP를 쓰지 않는 생산 현장 인원 — 계정 미발급이 정상(관리자 지시 2026-09-07)')
on conflict (dept_nm) do nothing;

alter table public.acct_erp_optional_dept enable row level security;
revoke all on public.acct_erp_optional_dept from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. 사람이 아닌 계정 — 현재 인원에서 제외
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.acct_nonhuman (
  email    text primary key,
  kind     text not null,      -- 회의실 · 차량 · 공유메일함 · 시스템 · 테스트
  note     text,
  added_at timestamptz not null default now()
);

comment on table public.acct_nonhuman is
  '사람이 아닌 계정(회의실·차량·공유메일함·시스템/테스트). 대사에서 is_person=false 로 표시하고 '
  '현재 인원 집계에서 뺀다. 등재하지 않은 계정은 그대로 조치 대상으로 보이므로 누락은 화면이 알려준다. '
  '사람(외부 회계사·외부인 포함)은 여기 넣지 않는다 — 인원에서 감추면 계정 관리 사각지대가 된다.';

insert into public.acct_nonhuman (email, kind, note) values
  ('seoul_2f_meeting@jeilm.co.kr', '회의실',    '서울 2층 대회의실'),
  ('seoul_3fmeeting@jeilm.co.kr',  '회의실',    '서울 3층 대회의실'),
  ('seoul_2fmeeting@jeilm.co.kr',  '회의실',    '서울 3층 소회의실'),
  ('gh_room@jeilm.co.kr',          '회의실',    '김해 회의실'),
  ('bookings@jeilm.co.kr',         '차량',      '차량관리'),
  ('bookings1@jeilm.co.kr',        '차량',      '법인차량예약'),
  ('seoulniro@jeilm.co.kr',        '차량',      '서울_니로'),
  ('seoultusan@jeilm.co.kr',       '차량',      '서울_투싼'),
  ('ichun_ray@jeilm.co.kr',        '차량',      '이천_레이'),
  ('purshare@jeilm.co.kr',         '공유메일함', '구매팀 공유메일'),
  ('osshare@jeilm.co.kr',          '공유메일함', '운영지원팀 공유메일'),
  ('hrshare@jeilm.co.kr',          '공유메일함', '인사팀 대표메일'),
  ('hrjeil@jeilm.co.kr',           '공유메일함', '인사'),
  ('itsupport@jeilm.co.kr',        '공유메일함', '전산 대표메일'),
  ('ithelp@jeilm.co.kr',           '공유메일함', 'IT 헬프데스크'),
  ('it@jeilm.co.kr',               '공유메일함', 'IT팀 일정'),
  ('scanmail@jeilm.co.kr',         '시스템',    '복합기 스캔 메일'),
  ('noreply@jeilm.co.kr',          '시스템',    '발신전용'),
  ('production@jeilm.co.kr',       '시스템',    '이천_생산(N100001)'),
  ('samsungsdi@jeilm.co.kr',       '시스템',    '거래처 전용 메일함'),
  ('data12@jeilm.co.kr',           '시스템',    '마이그레이션1'),
  ('jeil_ms@jeilm.co.kr',          '시스템',    'jeil_ms'),
  ('jeil_ms2@jeilm.co.kr',         '시스템',    'jeil_ms2'),
  ('ai.jeil@jeilm.co.kr',          '시스템',    'AI 포털 연동'),
  ('ai.test@jeilm.co.kr',          '테스트',    'aitest'),
  ('test12@jeilm.co.kr',           '테스트',    'test12')
on conflict (email) do nothing;

alter table public.acct_nonhuman enable row level security;
revoke all on public.acct_nonhuman from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. 대사 뷰 — 위 두 정책 반영 (34_identity_accounts.sql §14 정의를 대체)
--
--    바뀐 것만 요약:
--      · is_person   (신규) — acct_nonhuman 에 없으면 true
--      · erp_exempt  (신규) — 면제 부서라서 ERP 계정 없음을 정상으로 본 경우 true
--      · is_current  — 기존 조건 AND is_person  (사람이 아니면 현재 인원에서 뺀다)
--      · recon_type  — 비사람은 '공용·설비계정', 면제 부서는 '계정없음' 분기를 건너뛴다
-- ─────────────────────────────────────────────────────────────────────────
drop view if exists public.v_account_recon;

create view public.v_account_recon
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
  -- ERP 계정이 없어도 정상인 경우(면제 부서의 재직자). 화면이 '정상' 옆에 근거를 보여준다.
  (a.email is null and h.email is not null and h.hr_active and ed.dept_nm is not null)
                                                              as erp_exempt,
  (nh.email is null and (
     coalesce(a.acct_active, false) or coalesce(h.hr_active, false)
     or (g.email is not null and g.status = '사용')
     or (m.email is not null and m.account_enabled)))         as is_current,
  case
    -- ⓪ 사람이 아닌 계정은 대사 대상이 아니다 — 인원에서 빠지고 구분만 남긴다.
    when nh.email is not null                                            then '공용·설비계정'
    -- ① 이력 먼저 걸러낸다. 그래야 남은 분류가 '지금 조치할 것'만 남는다.
    when a.email is null and h.email is not null and not h.hr_active
         and not (g.email is not null and g.status = '사용')
         and not (m.email is not null and m.account_enabled)             then '퇴사이력'
    when a.email is null and h.email is null
         and not (g.email is not null and g.status = '사용')
         and not (m.email is not null and m.account_enabled)             then '비활성이력'
    when a.email is not null and not a.acct_active                       then '계정비활성'
    -- ② 조치 대상 — 면제 부서(생산팀 등)는 '계정없음'에서 빼고 아래로 흘린다.
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
  end                                                         as recon_type
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
  'is_person=false(공용·설비계정)와 is_current=false(이력)는 현재 인원에서 빠진다. '
  'erp_exempt=true 는 ERP를 쓰지 않는 부서(acct_erp_optional_dept)라 계정 미발급이 정상인 경우다.';

revoke all on public.v_account_recon from anon, authenticated;

-- ── 검증 ────────────────────────────────────────────────────────────────
-- select recon_type, count(*) from public.v_account_recon where is_current group by 1 order by 2 desc;
--   → 계정없음 2(구매팀·자재물류팀만), '공용·설비계정' 은 is_current=false 라 안 나온다
-- select email, emp_nm, dept_nm from public.v_account_recon where erp_exempt;   → 생산팀 6명
-- select count(*) from public.v_account_recon where not is_person;              → 26
