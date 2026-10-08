-- 100_hr_career_mirror_rollback.sql — REQ-0120 되돌리기 (경력 미러·인사마스터 보강 해제)
-- ⚠ erp_identity_upsert 는 live 4분기(SQL 34·50·51) 정의로 되돌린다 — role_cd·career_mm 없이.
--    ETL 쪽도 함께 r1.12 로 되돌려야 한다(hr_emp 가 role_cd 를 보내도 jsonb_to_recordset 이 무시하므로 적재는 깨지지 않는다).

drop function if exists public.hr_career_get(text, text, boolean);
drop function if exists public.erp_hr_career_reconcile(text, uuid, integer);

create or replace function public.erp_identity_upsert(p_table text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare n integer := 0;
begin
  if p_table = 'hr_emp_s' then
    insert into erp_ro.hr_emp_s (emp_no, emp_nm, dept_cd, dept_nm, roll_pstn, email,
                                 entr_dt, retire_dt, entr_cd, grw_id,
                                 src_updated, synced_at, batch_id)
    select x.emp_no, x.emp_nm, x.dept_cd, x.dept_nm, x.roll_pstn, x.email,
           x.entr_dt, x.retire_dt, x.entr_cd, x.grw_id, x.src_updated, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(emp_no text, emp_nm text, dept_cd text, dept_nm text,
                                         roll_pstn text, email text, entr_dt date, retire_dt date,
                                         entr_cd text, grw_id text,
                                         src_updated timestamptz, batch_id uuid)
    on conflict (emp_no) do update
      set emp_nm = excluded.emp_nm, dept_cd = excluded.dept_cd, dept_nm = excluded.dept_nm,
          roll_pstn = excluded.roll_pstn, email = excluded.email,
          entr_dt = excluded.entr_dt, retire_dt = excluded.retire_dt,
          entr_cd = excluded.entr_cd, grw_id = excluded.grw_id,
          src_updated = excluded.src_updated, synced_at = excluded.synced_at,
          batch_id = excluded.batch_id;

  elsif p_table = 'usr_role_s' then
    insert into erp_ro.usr_role_s (email, role_id, role_nm, synced_at, batch_id)
    select lower(trim(x.email)), x.role_id, x.role_nm, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(email text, role_id text, role_nm text, batch_id uuid)
    on conflict (email, role_id) do update
      set role_nm = excluded.role_nm, synced_at = excluded.synced_at, batch_id = excluded.batch_id,
          revoked_at = null;

  elsif p_table = 'menu_master_s' then
    insert into erp_ro.menu_master_s (mnu_id, mnu_type, mnu_nm, upper_mnu_id, mnu_seq, sys_lvl,
                                      synced_at, batch_id)
    select btrim(x.mnu_id), btrim(x.mnu_type), x.mnu_nm, nullif(btrim(coalesce(x.upper_mnu_id,'')), ''),
           nullif(btrim(coalesce(x.mnu_seq,'')), ''), x.sys_lvl, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(mnu_id text, mnu_type text, mnu_nm text, upper_mnu_id text,
                                         mnu_seq text, sys_lvl text, batch_id uuid)
    on conflict (mnu_id, mnu_type) do update
      set mnu_nm = excluded.mnu_nm, upper_mnu_id = excluded.upper_mnu_id,
          mnu_seq = excluded.mnu_seq, sys_lvl = excluded.sys_lvl,
          synced_at = excluded.synced_at, batch_id = excluded.batch_id, revoked_at = null;

  elsif p_table = 'role_menu_s' then
    insert into erp_ro.role_menu_s (role_id, mnu_id, mnu_type, action_id, module_initial,
                                    synced_at, batch_id)
    select btrim(x.role_id), btrim(x.mnu_id), btrim(x.mnu_type),
           nullif(btrim(coalesce(x.action_id,'')), ''),
           nullif(btrim(coalesce(x.module_initial,'')), ''), now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(role_id text, mnu_id text, mnu_type text,
                                         action_id text, module_initial text, batch_id uuid)
    on conflict (role_id, mnu_id, mnu_type) do update
      set action_id = excluded.action_id, module_initial = excluded.module_initial,
          synced_at = excluded.synced_at, batch_id = excluded.batch_id, revoked_at = null;

  else
    raise exception '허용되지 않은 테이블: %', p_table;
  end if;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.erp_identity_upsert(text, jsonb) from public, anon, authenticated;
grant execute on function public.erp_identity_upsert(text, jsonb) to service_role;

drop table if exists erp_ro.hr_career_s;
alter table erp_ro.hr_emp_s drop column if exists role_cd;
alter table erp_ro.hr_emp_s drop column if exists career_mm;
-- sys_code_s 의 H0002·H0016·H0026 행은 코드 사전이라 그대로 둬도 무해하다(지우려면: delete from erp_ro.sys_code_s where major_cd in ('H0002','H0016','H0026')).
