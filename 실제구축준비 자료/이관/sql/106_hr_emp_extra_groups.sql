-- 106_hr_emp_extra_groups.sql — 인사마스터 목록 보강 확장: 학력·자격·경력·가족 묶음 열 (REQ-0125 · 2026-10-08)
-- 마이그레이션: hr_emp_extra_groups_req0125
--
-- 화면 /work/hr-master 가 「학력·자격·경력·가족」을 열 묶음으로 켜고 끄며, 그 값으로 찾고 거를 수 있게
-- hr_emp_extra() 가 사번별 요약을 더 내준다. 권한 문은 그대로(인사팀·전체관리자·service_role).
--   학력: 최종학력 구분·학교·전공·졸업연월·학력 건수
--   자격: 건수·자격 이름 목록·최근 취득일
--   경력: 최근 직장·직장 목록·건수는 hr_emp_list 가 이미 준다
--   가족: 가족 수·관계 목록(이름은 목록 열에 내지 않는다 — 상세에서만)
-- 되돌리기: 105 번의 hr_emp_extra 정의를 다시 적용한다.

create or replace function public.hr_emp_extra()
returns jsonb language sql stable security definer set search_path to '' as $$
with ok as (
  select case when coalesce(auth.jwt() ->> 'role', '') = 'service_role' then true
              when public.is_internal() then public.perm_can(null, 'erp_module', 'payroll')
              else false end as allowed
),
code as (
  select upper(major_cd) as major_cd, minor_cd, max(minor_nm) as minor_nm
    from erp_ro.sys_code_s where upper(major_cd) in ('H0007', 'H0023', 'H0030')
   group by upper(major_cd), minor_cd
),
edu as (     -- 최종학력 = 입학일이 가장 늦은 학력
  select distinct on (e.emp_no) e.emp_no, coalesce(c.minor_nm, e.sch_ship) as sch_nm, e.school_nm, e.major_nm,
         to_char(e.grdut_dt, 'YYYY-MM') as grdut_ym
    from erp_ro.hr_edu_s e left join code c on c.major_cd = 'H0007' and c.minor_cd = e.sch_ship
   where e.revoked_at is null
   order by e.emp_no, e.admi_dt desc
),
educ as (select emp_no, count(*) as n from erp_ro.hr_edu_s where revoked_at is null group by emp_no),
lic as (
  select l.emp_no, count(*) as n, max(l.acq_dt) as last_dt,
         string_agg(coalesce(c.minor_nm, l.licn_kind), ', ' order by l.acq_dt desc) as names
    from erp_ro.hr_license_s l left join code c on c.major_cd = 'H0030' and c.minor_cd = l.licn_kind
   where l.revoked_at is null group by l.emp_no
),
car as (
  select emp_no,
         (array_agg(comp_nm order by career_end desc, career_start desc))[1] as last_comp,
         string_agg(comp_nm, ', ' order by career_end desc, career_start desc) as comps
    from erp_ro.hr_career_s where revoked_at is null group by emp_no
),
fam as (
  select f.emp_no, count(*) as n,
         string_agg(coalesce(c.minor_nm, f.rel_cd), ', ' order by f.rel_cd, f.family_nm) as rels
    from erp_ro.hr_family_s f left join code c on c.major_cd = 'H0023' and c.minor_cd = f.rel_cd
   where f.revoked_at is null group by f.emp_no
),
ids as (select emp_no from edu union select emp_no from lic union select emp_no from fam union select emp_no from car)
select jsonb_build_object(
  'allowed', ok.allowed,
  'as_of', (select max(s) from (select max(synced_at) s from erp_ro.hr_edu_s union all
                                 select max(synced_at) from erp_ro.hr_license_s union all
                                 select max(synced_at) from erp_ro.hr_family_s) z),
  'map', case when ok.allowed then coalesce((
           select jsonb_object_agg(i.emp_no, jsonb_build_object(
                    'edu_sch', e.sch_nm, 'edu_school', e.school_nm, 'edu_major', e.major_nm,
                    'edu_grdut', e.grdut_ym, 'edu_cnt', coalesce(ec.n, 0),
                    'license_cnt', coalesce(l.n, 0), 'license_names', l.names, 'license_last', l.last_dt,
                    'career_last_comp', c.last_comp, 'career_comps', c.comps,
                    'family_cnt', coalesce(f.n, 0), 'family_rels', f.rels))
             from ids i left join edu e on e.emp_no = i.emp_no
                        left join educ ec on ec.emp_no = i.emp_no
                        left join lic l on l.emp_no = i.emp_no
                        left join car c on c.emp_no = i.emp_no
                        left join fam f on f.emp_no = i.emp_no), '{}'::jsonb)
         else '{}'::jsonb end)
from ok
$$;
comment on function public.hr_emp_extra() is
  '인사마스터 목록 보강(사번별 학력·자격·경력·가족 묶음 요약). 허용: service_role 또는 payroll 모듈 권한자(인사팀·전체관리자). 가족 이름은 내지 않는다(관계 목록만). REQ-0123·0125.';
revoke all on function public.hr_emp_extra() from public, anon;
grant execute on function public.hr_emp_extra() to authenticated, service_role;
