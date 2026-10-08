-- 101_hr_master_page.sql — 인사마스터 조회 화면(/work/hr-master)용 조회 RPC + 포털 카드 (REQ-0122 · 2026-10-08)
-- 마이그레이션: hr_master_page_req0122
--
-- 무엇을
--   1) public.hr_emp_list() — 인사마스터 전량(재직·퇴직) 한 번에. 화면은 받아서 거르고·찾고·정렬만 한다.
--      허용: service_role 또는 사내 사용자 중 ERP 모듈 payroll 권한자(= 인사팀 · 전체관리자) — hr_career_get 과 같은 문(D-152).
--      그 밖은 allowed:false 와 빈 목록.
--      행: 사번·이름·부서·직위·직책·입사구분(코드 이름)·입사일·퇴사일·재직구분·이메일·그룹웨어ID
--          + 인정경력 개월 · 입사 전 경력 건수/개월(경력 미러 합) · 같은 이메일의 사번 수(재입사 이력) · ERP 계정 상태.
--      주민번호·주소·연락처·급여는 미러에 없다(CLAUDE.md §1.7) — 이 함수도 만들지 않는다.
--   2) hr_career_get 보정 — 종합코드 그룹이 ERP 에 소문자(h0002)로 들어온 행이 있어(직위 11) upper(major_cd) 로 붙인다.
--   3) 포털 카드 hr_master_2026 — 인사팀 부서 전용(erp_module payroll).
--
-- 되돌리기: 101_hr_master_page_rollback.sql

create or replace function public.hr_emp_list()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
with ok as (
  select case
           when coalesce(auth.jwt() ->> 'role', '') = 'service_role' then true
           when public.is_internal() then public.perm_can(null, 'erp_module', 'payroll')
           else false
         end as allowed
),
code as (     -- ERP 에 소문자 그룹(h0002)이 섞여 있다 → 대문자로 모은다
  select upper(major_cd) as major_cd, minor_cd, max(minor_nm) as minor_nm
    from erp_ro.sys_code_s
   where upper(major_cd) in ('H0002', 'H0016', 'H0026')
   group by upper(major_cd), minor_cd
),
car as (
  select emp_no, count(*) as career_cnt,
         sum(coalesce(career_yy, 0) * 12 + coalesce(career_mm, 0)) as prior_mm
    from erp_ro.hr_career_s
   where revoked_at is null
   group by emp_no
),
mail as (     -- 같은 이메일에 사번이 여럿 = 재입사(새 사번 발급)
  select lower(btrim(email)) as email, count(*) as emp_rec_cnt
    from erp_ro.hr_emp_s
   where email like '%@%'
   group by lower(btrim(email))
),
acct as (
  select lower(btrim(usr_id)) as email,
         bool_or(use_yn = 'Y' and deactivated_at is null) as active
    from erp_ro.usr_master_s
   group by lower(btrim(usr_id))
),
rows_ as (
  select jsonb_build_object(
           'emp_no', m.emp_no, 'emp_nm', m.emp_nm,
           'dept_cd', m.dept_cd, 'dept_nm', m.dept_nm,
           'pstn_cd', m.roll_pstn, 'pstn_nm', coalesce(p.minor_nm, m.roll_pstn),
           'role_cd', m.role_cd,   'role_nm', coalesce(r.minor_nm, m.role_cd),
           'entr_cd', m.entr_cd,   'entr_nm', coalesce(e.minor_nm, m.entr_cd),
           'entr_dt', m.entr_dt, 'retire_dt', m.retire_dt,
           'status', case when m.retire_dt is null or m.retire_dt > current_date then '재직' else '퇴직' end,
           'email', m.email, 'grw_id', m.grw_id,
           'career_mm', m.career_mm,
           'career_cnt', coalesce(c.career_cnt, 0), 'prior_mm', coalesce(c.prior_mm, 0),
           'emp_rec_cnt', coalesce(ml.emp_rec_cnt, 1),
           'erp_acct', case when m.email is null or m.email not like '%@%' then '이메일 없음'
                            when a.email is null then '계정 없음'
                            when a.active then '사용' else '중지' end,
           'src_updated', m.src_updated
         ) as j, m.emp_nm, m.emp_no, (m.retire_dt is null or m.retire_dt > current_date) as active
    from erp_ro.hr_emp_s m
    left join code p on p.major_cd = 'H0002' and p.minor_cd = m.roll_pstn
    left join code r on r.major_cd = 'H0026' and r.minor_cd = m.role_cd
    left join code e on e.major_cd = 'H0016' and e.minor_cd = m.entr_cd
    left join car  c on c.emp_no = m.emp_no
    left join mail ml on ml.email = lower(btrim(m.email))
    left join acct a  on a.email  = lower(btrim(m.email))
)
select jsonb_build_object(
         'allowed', ok.allowed,
         'as_of',   (select max(synced_at) from erp_ro.hr_emp_s),
         'career_as_of', (select max(synced_at) from erp_ro.hr_career_s),
         'count',   case when ok.allowed then (select count(*) from rows_) else 0 end,
         'rows',    case when ok.allowed
                         then coalesce((select jsonb_agg(j order by active desc, emp_nm, emp_no) from rows_), '[]'::jsonb)
                         else '[]'::jsonb end)
  from ok
$$;

comment on function public.hr_emp_list() is
  '인사마스터 조회(화면 /work/hr-master). 허용: service_role 또는 사내 사용자 중 ERP 모듈 payroll 권한자(인사팀·전체관리자). '
  '그 밖은 allowed:false·빈 목록. 코드 이름(직위 H0002·직책 H0026·입사구분 H0016)·경력 건수·재입사 사번 수·ERP 계정 상태 포함. '
  '주민번호·주소·연락처·급여 없음. REQ-0122.';

revoke all on function public.hr_emp_list() from public, anon;
grant execute on function public.hr_emp_list() to authenticated, service_role;

-- ── hr_career_get 보정 — 코드 그룹 대소문자(REQ-0120 후속) ───────────────────────────────────
create or replace function public.hr_career_get(p_emp_no text default null,
                                                p_q text default null,
                                                p_include_revoked boolean default false)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
with ok as (
  select case
           when coalesce(auth.jwt() ->> 'role', '') = 'service_role' then true
           when public.is_internal() then public.perm_can(null, 'erp_module', 'payroll')
           else false
         end as allowed
),
q as (
  select nullif(btrim(coalesce(p_emp_no, '')), '') as emp_no,
         nullif(btrim(coalesce(p_q, '')), '')      as q
),
code as (
  select upper(major_cd) as major_cd, minor_cd, max(minor_nm) as minor_nm
    from erp_ro.sys_code_s
   where upper(major_cd) in ('H0002', 'H0016', 'H0026')
   group by upper(major_cd), minor_cd
),
emp as (     -- 경력이 있는 사람만 · 마스터가 없는 사번(사번 변경 건)도 보인다
  select c.emp_no,
         m.emp_nm, m.dept_cd, m.dept_nm, m.entr_dt, m.retire_dt,
         case when m.emp_no is null then '마스터없음'
              when m.retire_dt is null or m.retire_dt > current_date then '재직'
              else '퇴직' end as status,
         m.roll_pstn as roll_pstn_cd, p.minor_nm as roll_pstn_nm,
         m.role_cd,                  r.minor_nm as role_nm,
         m.entr_cd,                  e.minor_nm as entr_nm,
         m.career_mm as master_career_mm,
         count(*) filter (where c.revoked_at is null) as career_cnt
    from erp_ro.hr_career_s c
    left join erp_ro.hr_emp_s m on m.emp_no = c.emp_no
    left join code p on p.major_cd = 'H0002' and p.minor_cd = m.roll_pstn
    left join code r on r.major_cd = 'H0026' and r.minor_cd = m.role_cd
    left join code e on e.major_cd = 'H0016' and e.minor_cd = m.entr_cd
   group by c.emp_no, m.emp_no, m.emp_nm, m.dept_cd, m.dept_nm, m.entr_dt, m.retire_dt,
            m.roll_pstn, p.minor_nm, m.role_cd, r.minor_nm, m.entr_cd, e.minor_nm, m.career_mm
),
pick as (
  select emp.* from emp, q
   where (q.emp_no is null or emp.emp_no = q.emp_no)
     and (q.q is null or emp.emp_nm ilike '%' || q.q || '%' or emp.dept_nm ilike '%' || q.q || '%')
),
rows_ as (
  select jsonb_build_object(
           'emp_no', pk.emp_no, 'emp_nm', pk.emp_nm, 'dept_cd', pk.dept_cd, 'dept_nm', pk.dept_nm,
           'status', pk.status, 'entr_dt', pk.entr_dt, 'retire_dt', pk.retire_dt,
           'roll_pstn', coalesce(pk.roll_pstn_nm, pk.roll_pstn_cd), 'role_nm', coalesce(pk.role_nm, pk.role_cd),
           'entr_nm', coalesce(pk.entr_nm, pk.entr_cd), 'master_career_mm', pk.master_career_mm,
           'career_cnt', pk.career_cnt,
           'careers', (select coalesce(jsonb_agg(jsonb_build_object(
                          'comp_nm', c.comp_nm, 'career_start', c.career_start, 'career_end', c.career_end,
                          'roll_pstn', c.roll_pstn, 'func_nm', c.func_nm,
                          'career_yy', c.career_yy, 'career_mm', c.career_mm, 'apply_yn', c.apply_yn,
                          'revoked_at', c.revoked_at) order by c.career_start, c.career_end), '[]'::jsonb)
                         from erp_ro.hr_career_s c
                        where c.emp_no = pk.emp_no and (p_include_revoked or c.revoked_at is null))
         ) as j, pk.emp_nm, pk.emp_no
    from pick pk
)
select jsonb_build_object(
         'allowed', ok.allowed,
         'as_of',   (select max(synced_at) from erp_ro.hr_career_s),
         'count',   case when ok.allowed then (select count(*) from rows_) else 0 end,
         'rows',    case when ok.allowed
                         then coalesce((select jsonb_agg(j order by emp_nm, emp_no) from rows_), '[]'::jsonb)
                         else '[]'::jsonb end)
  from ok
$$;

revoke all on function public.hr_career_get(text, text, boolean) from public, anon;
grant execute on function public.hr_career_get(text, text, boolean) to authenticated, service_role;

-- ── 포털 카드 — 인사팀 부서 전용 ─────────────────────────────────────────────────────────────
insert into public.portal_page
  (page_key, title, path, icon, dept_nm, visibility, shared_depts, erp_module, sort, active, updated_by, owner_dept_cd, note)
values
  ('hr_master_2026', '인사마스터 조회', '/work/hr-master', '🪪', '인사팀', '부서 전용', '{}', 'payroll', 51, true,
   'dh.choi@jeilm.co.kr', '3150',
   'ERP 인사마스터(HAA010T)·경력정보(HAA050T) 미러 조회(REQ-0122) · 표준 그리드 · 조회 전용 · 인사팀·전체관리자')
on conflict (page_key) do update
  set title = excluded.title, path = excluded.path, icon = excluded.icon,
      dept_nm = excluded.dept_nm, visibility = excluded.visibility,
      shared_depts = excluded.shared_depts, erp_module = excluded.erp_module,
      sort = excluded.sort, active = excluded.active, note = excluded.note,
      owner_dept_cd = excluded.owner_dept_cd,
      updated_by = excluded.updated_by, updated_at = now();
