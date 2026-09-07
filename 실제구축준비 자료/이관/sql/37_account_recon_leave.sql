-- ============================================================================
-- 37_account_recon_leave.sql — 휴직 상태를 대사에 표현 (2026-09-07, 관리자 지시)
--
-- 관리자 확인: "wh.choi 는 휴직인데 ERP 사용자명에 휴직이라고 적혀 있다. 이런 경우 휴직으로 표현."
--
-- 두 가지가 겹쳐 있었다.
--
--  ① 원천을 덜 긁고 있었다 — ETL `usr_master` 가 `USE_YN='Y'` 만 가져왔다.
--     휴직자는 ERP 계정을 **비활성(USE_YN='N')** 하고 usr_nm 에 '(휴직)' 을 붙이는 운영이라,
--     활성만 긁으면 그 행이 미러에 아예 없다. 그래서 화면은 "인사 재직인데 ERP 계정 없음"
--     = **계정없음(조치 필요)** 으로 오판했다. 실측: 미러 101행 → 전량 434행(활성 94),
--     그중 '(휴직)' 표기 5건이 그때까지 한 건도 들어와 있지 않았다.
--     → `etl_run.py` 의 usr_master WHERE 에서 USE_YN 조건을 뺐다(상태는 use_yn 컬럼이 들고 있다).
--
--  ② 파싱은 이미 돼 있었다 — `v_account_identity.acct_status_note` 가 usr_nm 의
--     '(퇴사)'·'(휴직)' 을 이미 읽고 있었는데, 대사 분류(recon_type)에 휴직 갈래가 없어
--     계정이 들어온 뒤에도 '계정비활성'(=정리 대상)으로 보였다.
--     → recon_type 에 '휴직' 을 신설한다. **이력 판정 뒤, 계정비활성 앞**이다 —
--       휴직은 "지금 사람이 있고 계정만 잠긴" 상태라 이력이 아니고, 조치 대상도 아니다.
--
-- 판정 근거는 ERP usr_nm 표기 하나뿐이다(인사마스터에 휴직 컬럼이 없다). 표기가 지워지면
-- 판정도 사라지므로, 복직 시 ERP 에서 '(휴직)' 을 떼는 운영이 그대로 대사에 반영된다.
-- '(휴직)(퇴사)' 처럼 둘 다 붙은 계정은 acct_status_note 가 '퇴사' 를 우선하므로 이력으로 남는다.
--
-- 적용 후: 현재 인원 109 유지 · '휴직' 4명 신설(김윤호·지민규·임소리·최원호)
--          · 계정없음 2 → 0 · 정상 90 → 88(생산팀 김윤호·지민규가 휴직으로 이동)
-- ============================================================================

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
  'on_leave=true(휴직)와 erp_exempt=true(ERP 미사용 부서)는 현재 인원이되 조치 대상이 아니다.';

revoke all on public.v_account_recon from anon, authenticated;

-- ── 검증 ────────────────────────────────────────────────────────────────
-- select recon_type, count(*) from public.v_account_recon where is_current group by 1 order by 2 desc;
--   → 휴직 4 · 계정없음 0
-- select email, emp_nm, dept_nm, acct_status_note from public.v_account_recon where on_leave;
