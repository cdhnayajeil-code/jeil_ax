-- 105_hr_edu_license_family.sql — ERP 인사 학력·자격/면허·가족 미러 + 조회 RPC (REQ-0123 · 2026-10-08)
-- 마이그레이션: hr_edu_license_family_req0123
--
-- 원천(2026-10-08 구조 조사 — 열 이름·형·행수만):
--   학력 HAA030T  PK (EMP_NO, SCH_SHIP, ADMI_DT)      · 학력구분 H0007
--   자격 HAA060T  PK (EMP_NO, LICN_KIND, ACQ_DT)      · 종류 H0030 · 발행기관 H0031
--   가족 HAA020T  PK (EMP_NO, FAMILY_NM, REL_CD)      · 관계 H0023 · 부양 H0024
-- 받지 않는 것(CLAUDE.md §1.7): 가족 주민등록번호(RES_NO·RES_NO_PRVC)·가족의 직업·직장·학력, 자격증 번호(LICN_NO),
--   일용직(HAA011T — 주민번호·계좌)·신원보증(HAA040T)·여권(HAA080T)·사진(HAA070T).
--   가족 테이블에는 출생연도 열이 따로 없다(주민번호뿐) — 나이·출생연도는 만들지 않는다.
-- 구조: 전량 스냅샷 + 배치 정합(revoked_at) · RLS 전면차단 · 읽기는 RPC 두 개뿐(payroll 모듈 권한자·전체관리자·service_role).
-- 되돌리기: 105_hr_edu_license_family_rollback.sql

create table if not exists erp_ro.hr_edu_s (
  emp_no text not null, sch_ship text not null, admi_dt date not null,
  grdut_dt date, school_nm text, major_nm text,
  src_updated timestamptz, synced_at timestamptz not null default now(), batch_id uuid, revoked_at timestamptz,
  primary key (emp_no, sch_ship, admi_dt)
);
create table if not exists erp_ro.hr_license_s (
  emp_no text not null, licn_kind text not null, acq_dt date not null,
  licn_grade text, publ_office text, fnsh_dt date,
  src_updated timestamptz, synced_at timestamptz not null default now(), batch_id uuid, revoked_at timestamptz,
  primary key (emp_no, licn_kind, acq_dt)
);
create table if not exists erp_ro.hr_family_s (
  emp_no text not null, family_nm text not null, rel_cd text not null,
  supp_cd text, reside_type text,
  src_updated timestamptz, synced_at timestamptz not null default now(), batch_id uuid, revoked_at timestamptz,
  primary key (emp_no, family_nm, rel_cd)
);
comment on table erp_ro.hr_edu_s is 'ERP 인사 학력 미러(HAA030T · 학력구분 H0007). 전량 스냅샷 + 배치 정합. 읽기는 hr_emp_detail·hr_emp_extra 만. REQ-0123.';
comment on table erp_ro.hr_license_s is 'ERP 인사 자격/면허 미러(HAA060T · 종류 H0030 · 발행기관 H0031). 자격증 번호는 적재하지 않는다. REQ-0123.';
comment on table erp_ro.hr_family_s is 'ERP 인사 가족사항 미러(HAA020T · 관계 H0023 · 부양 H0024). 관계·이름·부양·동거만 — 주민등록번호·직업·직장·학력은 적재하지 않는다(CLAUDE.md §1.7). REQ-0123.';

alter table erp_ro.hr_edu_s     enable row level security;
alter table erp_ro.hr_license_s enable row level security;
alter table erp_ro.hr_family_s  enable row level security;
revoke all on erp_ro.hr_edu_s, erp_ro.hr_license_s, erp_ro.hr_family_s from anon, authenticated;
grant select, insert, update, delete on erp_ro.hr_edu_s, erp_ro.hr_license_s, erp_ro.hr_family_s to service_role;

-- ── 적재 RPC(service_role 전용) — erp_identity_upsert 를 또 다시 통째로 고치지 않으려고 분리 ──
create or replace function public.erp_hr_sub_upsert(p_table text, p_rows jsonb)
returns integer language plpgsql security definer set search_path to '' as $$
declare n integer := 0;
begin
  if p_table = 'hr_edu_s' then
    insert into erp_ro.hr_edu_s (emp_no, sch_ship, admi_dt, grdut_dt, school_nm, major_nm, src_updated, synced_at, batch_id)
    select btrim(x.emp_no), btrim(x.sch_ship), x.admi_dt, x.grdut_dt, x.school_nm, x.major_nm, x.src_updated, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(emp_no text, sch_ship text, admi_dt date, grdut_dt date, school_nm text,
                                         major_nm text, src_updated timestamptz, batch_id uuid)
    where x.emp_no is not null and x.sch_ship is not null and x.admi_dt is not null
    on conflict (emp_no, sch_ship, admi_dt) do update
      set grdut_dt = excluded.grdut_dt, school_nm = excluded.school_nm, major_nm = excluded.major_nm,
          src_updated = excluded.src_updated, synced_at = excluded.synced_at, batch_id = excluded.batch_id, revoked_at = null;
  elsif p_table = 'hr_license_s' then
    insert into erp_ro.hr_license_s (emp_no, licn_kind, acq_dt, licn_grade, publ_office, fnsh_dt, src_updated, synced_at, batch_id)
    select btrim(x.emp_no), btrim(x.licn_kind), x.acq_dt, x.licn_grade, x.publ_office, x.fnsh_dt, x.src_updated, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(emp_no text, licn_kind text, acq_dt date, licn_grade text, publ_office text,
                                         fnsh_dt date, src_updated timestamptz, batch_id uuid)
    where x.emp_no is not null and x.licn_kind is not null and x.acq_dt is not null
    on conflict (emp_no, licn_kind, acq_dt) do update
      set licn_grade = excluded.licn_grade, publ_office = excluded.publ_office, fnsh_dt = excluded.fnsh_dt,
          src_updated = excluded.src_updated, synced_at = excluded.synced_at, batch_id = excluded.batch_id, revoked_at = null;
  elsif p_table = 'hr_family_s' then
    insert into erp_ro.hr_family_s (emp_no, family_nm, rel_cd, supp_cd, reside_type, src_updated, synced_at, batch_id)
    select btrim(x.emp_no), btrim(x.family_nm), btrim(x.rel_cd), x.supp_cd, x.reside_type, x.src_updated, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(emp_no text, family_nm text, rel_cd text, supp_cd text, reside_type text,
                                         src_updated timestamptz, batch_id uuid)
    where x.emp_no is not null and x.family_nm is not null and x.rel_cd is not null
    on conflict (emp_no, family_nm, rel_cd) do update
      set supp_cd = excluded.supp_cd, reside_type = excluded.reside_type,
          src_updated = excluded.src_updated, synced_at = excluded.synced_at, batch_id = excluded.batch_id, revoked_at = null;
  else
    raise exception '허용되지 않은 테이블: %', p_table;
  end if;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.erp_hr_sub_upsert(text, jsonb) from public, anon, authenticated;
grant execute on function public.erp_hr_sub_upsert(text, jsonb) to service_role;

-- ── 정합 RPC — 이번 배치가 덮지 않은 행을 revoked_at 표시(erp_menu_reconcile 과 같은 규약) ──
create or replace function public.erp_hr_sub_reconcile(p_table text, p_batch_id uuid, p_min_rows integer default 10)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_seen integer := 0; v_off integer := 0;
begin
  if p_batch_id is null then raise exception 'batch_id 가 필요합니다 — 전건 회수 표시를 막기 위해 거부합니다'; end if;
  if p_table not in ('hr_edu_s', 'hr_license_s', 'hr_family_s') then raise exception '허용되지 않은 테이블: %', p_table; end if;
  execute format('select count(*) from erp_ro.%I where batch_id = $1', p_table) into v_seen using p_batch_id;
  if v_seen < p_min_rows then raise exception '이번 배치가 덮은 행이 %건뿐입니다 — 부분 적재로 보여 거부합니다', v_seen; end if;
  execute format('update erp_ro.%I set revoked_at = now() where revoked_at is null and batch_id is distinct from $1', p_table) using p_batch_id;
  get diagnostics v_off = row_count;
  return jsonb_build_object('table', p_table, 'seen', v_seen, 'revoked', v_off);
end $$;
revoke all on function public.erp_hr_sub_reconcile(text, uuid, integer) from public, anon, authenticated;
grant execute on function public.erp_hr_sub_reconcile(text, uuid, integer) to service_role;

-- ── 조회 ① 목록 보강 — 사번별 최종학력·자격 건수·가족 수(화면이 hr_emp_list 결과에 붙인다) ──
create or replace function public.hr_emp_extra()
returns jsonb language sql stable security definer set search_path to '' as $$
with ok as (
  select case when coalesce(auth.jwt() ->> 'role', '') = 'service_role' then true
              when public.is_internal() then public.perm_can(null, 'erp_module', 'payroll')
              else false end as allowed
),
code as (
  select upper(major_cd) as major_cd, minor_cd, max(minor_nm) as minor_nm
    from erp_ro.sys_code_s where upper(major_cd) = 'H0007' group by upper(major_cd), minor_cd
),
edu as (     -- 최종학력 = 입학일이 가장 늦은 학력
  select distinct on (e.emp_no) e.emp_no, coalesce(c.minor_nm, e.sch_ship) as sch_nm, e.school_nm, e.major_nm
    from erp_ro.hr_edu_s e left join code c on c.minor_cd = e.sch_ship
   where e.revoked_at is null
   order by e.emp_no, e.admi_dt desc
),
lic as (select emp_no, count(*) as n from erp_ro.hr_license_s where revoked_at is null group by emp_no),
fam as (select emp_no, count(*) as n from erp_ro.hr_family_s  where revoked_at is null group by emp_no),
ids as (select emp_no from edu union select emp_no from lic union select emp_no from fam)
select jsonb_build_object(
  'allowed', ok.allowed,
  'as_of', (select max(s) from (select max(synced_at) s from erp_ro.hr_edu_s union all
                                 select max(synced_at) from erp_ro.hr_license_s union all
                                 select max(synced_at) from erp_ro.hr_family_s) z),
  'map', case when ok.allowed then coalesce((
           select jsonb_object_agg(i.emp_no, jsonb_build_object(
                    'edu_sch', e.sch_nm, 'edu_school', e.school_nm, 'edu_major', e.major_nm,
                    'license_cnt', coalesce(l.n, 0), 'family_cnt', coalesce(f.n, 0)))
             from ids i left join edu e on e.emp_no = i.emp_no
                        left join lic l on l.emp_no = i.emp_no
                        left join fam f on f.emp_no = i.emp_no), '{}'::jsonb)
         else '{}'::jsonb end)
from ok
$$;
comment on function public.hr_emp_extra() is
  '인사마스터 목록 보강(사번별 최종학력·자격 건수·가족 수). 허용: service_role 또는 payroll 모듈 권한자(인사팀·전체관리자). REQ-0123.';
revoke all on function public.hr_emp_extra() from public, anon;
grant execute on function public.hr_emp_extra() to authenticated, service_role;

-- ── 조회 ② 한 사람 상세 — 학력·자격·가족(코드 이름 포함) ──
create or replace function public.hr_emp_detail(p_emp_no text)
returns jsonb language sql stable security definer set search_path to '' as $$
with ok as (
  select case when coalesce(auth.jwt() ->> 'role', '') = 'service_role' then true
              when public.is_internal() then public.perm_can(null, 'erp_module', 'payroll')
              else false end as allowed
),
k as (select nullif(btrim(coalesce(p_emp_no, '')), '') as emp_no),
code as (
  select upper(major_cd) as major_cd, minor_cd, max(minor_nm) as minor_nm
    from erp_ro.sys_code_s
   where upper(major_cd) in ('H0007', 'H0023', 'H0024', 'H0030', 'H0031')
   group by upper(major_cd), minor_cd
)
select jsonb_build_object(
  'allowed', ok.allowed,
  'edu', case when ok.allowed then coalesce((
      select jsonb_agg(jsonb_build_object('sch_nm', coalesce(c.minor_nm, e.sch_ship), 'school_nm', e.school_nm,
                                          'major_nm', e.major_nm, 'admi_dt', e.admi_dt, 'grdut_dt', e.grdut_dt)
                       order by e.admi_dt desc)
        from erp_ro.hr_edu_s e left join code c on c.major_cd = 'H0007' and c.minor_cd = e.sch_ship, k
       where e.emp_no = k.emp_no and e.revoked_at is null), '[]'::jsonb) else '[]'::jsonb end,
  'license', case when ok.allowed then coalesce((
      select jsonb_agg(jsonb_build_object('kind_nm', coalesce(c.minor_nm, l.licn_kind), 'grade', l.licn_grade,
                                          'office_nm', coalesce(o.minor_nm, l.publ_office), 'acq_dt', l.acq_dt, 'fnsh_dt', l.fnsh_dt)
                       order by l.acq_dt desc)
        from erp_ro.hr_license_s l
        left join code c on c.major_cd = 'H0030' and c.minor_cd = l.licn_kind
        left join code o on o.major_cd = 'H0031' and o.minor_cd = l.publ_office, k
       where l.emp_no = k.emp_no and l.revoked_at is null), '[]'::jsonb) else '[]'::jsonb end,
  'family', case when ok.allowed then coalesce((
      select jsonb_agg(jsonb_build_object('rel_nm', coalesce(c.minor_nm, f.rel_cd), 'family_nm', f.family_nm,
                                          'supp_nm', coalesce(s.minor_nm, f.supp_cd), 'reside', f.reside_type)
                       order by f.rel_cd, f.family_nm)
        from erp_ro.hr_family_s f
        left join code c on c.major_cd = 'H0023' and c.minor_cd = f.rel_cd
        left join code s on s.major_cd = 'H0024' and s.minor_cd = f.supp_cd, k
       where f.emp_no = k.emp_no and f.revoked_at is null), '[]'::jsonb) else '[]'::jsonb end)
from ok
$$;
comment on function public.hr_emp_detail(text) is
  '인사마스터 한 사람의 학력·자격/면허·가족(코드 이름 포함). 허용: service_role 또는 payroll 모듈 권한자(인사팀·전체관리자). 주민등록번호·자격증 번호 없음. REQ-0123.';
revoke all on function public.hr_emp_detail(text) from public, anon;
grant execute on function public.hr_emp_detail(text) to authenticated, service_role;

-- ETL(etl_run.py): job hr_edu·hr_license·hr_family(rpc=erp_hr_sub_upsert · reconcile mode=batch rpc=erp_hr_sub_reconcile)
--   + sys_code 화이트리스트에 H0007·H0023·H0024·H0030·H0031. 러너 r1.14 재빌드·3경로(§17.5).
