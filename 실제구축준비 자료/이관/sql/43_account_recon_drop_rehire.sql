-- ============================================================================
-- 43_account_recon_drop_rehire.sql — 대사 구분에서 「재입사」를 뺀다 (2026-09-11, 관리자 지시 · REQ-0028)
--
-- 왜
--   「재입사」는 "같은 이메일에 인사 레코드(사번)가 2건 이상"이라는 뜻이었는데(rehire_cnt = 건수−1),
--   실측하니 조치할 일이 아니었다 — 라이브에서 「재입사」로 보이던 1명은 입사일이 같은 **사번 재등록**이고,
--   이력 10건 중 1건은 **다른 두 사람이 이메일을 공유**한 경우였다(RE_ENTR_DT 는 전건 비어 있어 못 쓴다).
--   구분에 남겨 두면 조치 대상 집계에 섞여 들어가므로(정상·휴직만 제외) 구분에서 뺀다.
--
-- 바꾸는 것
--   v_account_recon 의 recon_type 분기에서 `when rehire_cnt > 0 then '재입사'` 한 줄 제거 → 그 사람은 「정상」.
--   컬럼(rehire_cnt·emp_no_list 포함)·순서·권한은 그대로 — create or replace 로 교체 가능.
--   화면(app/admin-accounts.html)에서는 대사 표 「재입사」열과 인사 카드의 「재입사 N」 표기를 지운다.
--   인사 탭의 「인사행 N행」·「사번 이력」은 사실 그대로라 남긴다(이메일 공유 같은 이상을 드러내는 데 쓸모).
--
-- 근거: 41_ms_license.sql §3 의 정의에서 한 줄만 뺀 것. 검증 쿼리는 아래.
-- ============================================================================

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

-- ── 검증 ──────────────────────────────────────────────────────────────────
-- select recon_type, count(*) from public.v_account_recon group by 1 order by 2 desc;
-- 기대: '재입사' 행 0건, 종전 재입사 1명은 '정상'. 컬럼 수 변화 없음.
