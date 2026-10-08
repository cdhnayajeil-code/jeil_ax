-- 102_hr_edu_license_family_rollback.sql — REQ-0123 되돌리기 (ETL 도 r1.13 으로 함께 되돌린다)
drop function if exists public.hr_emp_detail(text);
drop function if exists public.hr_emp_extra();
drop function if exists public.erp_hr_sub_reconcile(text, uuid, integer);
drop function if exists public.erp_hr_sub_upsert(text, jsonb);
drop table if exists erp_ro.hr_family_s;
drop table if exists erp_ro.hr_license_s;
drop table if exists erp_ro.hr_edu_s;
-- sys_code_s 의 H0007·H0023·H0024·H0030·H0031 행은 코드 사전이라 그대로 둬도 무해하다.
