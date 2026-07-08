-- 15_erp_secure_hr_load.sql
-- erp_secure 인사 급여 '집계' 적재/조회 RPC + 게이트 API + ETL(확정) — 2026년도부터.
-- 적용일 2026-07-08 · 마이그레이션 erp_secure_rpcs + hr_access_log_rpc.
-- ⚠ 집계만: 개인 행·이름·주민번호(RES_NO)·계좌 절대 미포함. 커넥터 검증(2026-07-08)으로 실컬럼 확정.
--   HDF070T(PAY_YYMM·DEPT_NM·PAY_TOT_AMT), HGA070T(RETIRE_DT·RETIRE_AMT, 부서없음→전사 월별).
-- 재현/이관용 정본.

-- 1) 적재 RPC (service_role 전용) — erp_secure.hr_payroll_m
create or replace function public.erp_secure_upsert(p_table text, p_rows jsonb)
  returns integer language plpgsql security definer set search_path to ''
as $function$
declare n integer := 0;
begin
  if p_table = 'hr_payroll_m' then
    insert into erp_secure.hr_payroll_m (ym, dept_nm, headcount, pay_tot_amt, retire_amt, synced_at, batch_id)
    select x.ym, coalesce(nullif(btrim(x.dept_nm),''),'전사'), x.headcount, x.pay_tot_amt, x.retire_amt, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(ym text, dept_nm text, headcount int, pay_tot_amt numeric, retire_amt numeric, batch_id uuid)
    on conflict (ym, dept_nm) do update
      set headcount = excluded.headcount, pay_tot_amt = excluded.pay_tot_amt,
          retire_amt = excluded.retire_amt, synced_at = excluded.synced_at, batch_id = excluded.batch_id;
  else raise exception '허용되지 않은 erp_secure 테이블: %', p_table; end if;
  get diagnostics n = row_count; return n;
end $function$;
revoke all on function public.erp_secure_upsert(text, jsonb) from public, anon, authenticated;
grant execute on function public.erp_secure_upsert(text, jsonb) to service_role;

-- 2) 조회 RPC (게이트 API jeil-hr 전용, service_role만)
create or replace function public.hr_payroll_get()
  returns setof erp_secure.hr_payroll_m language sql security definer set search_path to ''
as $function$ select * from erp_secure.hr_payroll_m order by ym, dept_nm $function$;
revoke all on function public.hr_payroll_get() from public, anon, authenticated;
grant execute on function public.hr_payroll_get() to service_role;

-- 3) 감사 기록 RPC (jeil-hr 전용)
create or replace function public.hr_access_log_add(p_upn text, p_dept text, p_ok boolean)
  returns void language sql security definer set search_path to ''
as $function$ insert into erp_secure.hr_access_log (upn, dept_nm, ok) values (p_upn, p_dept, p_ok) $function$;
revoke all on function public.hr_access_log_add(text, text, boolean) from public, anon, authenticated;
grant execute on function public.hr_access_log_add(text, text, boolean) to service_role;

-- 4) 게이트 API: Edge Function jeil-hr(verify_jwt=false) — Entra 검증 → dept='인사팀' 또는 portal_admin만,
--    hr_access_log 기록 → hr_payroll_get() 반환. 소스: supabase/functions/jeil-hr/index.ts (배포 v1).

-- 5) ETL(확정, etl_run.py JOB 'hr_payroll', rpc=erp_secure_upsert, 집계 전용):
--    급여(월×부서): SELECT PAY_YYMM ym, DEPT_NM dept_nm, COUNT(*) headcount, SUM(PAY_TOT_AMT) pay_tot_amt,
--                   CAST(NULL AS numeric) retire_amt FROM HDF070T WHERE PAY_YYMM 2026 GROUP BY PAY_YYMM, DEPT_NM
--    퇴직(월×전사): SELECT CONVERT(char(6),RETIRE_DT,112) ym, N'전사' dept_nm, NULL headcount, NULL pay_tot_amt,
--                   SUM(RETIRE_AMT) retire_amt FROM HGA070T WHERE RETIRE_DT 2026 GROUP BY CONVERT(char(6),RETIRE_DT,112)
--    dry-run 검증: 143행(급여 137 월×부서 + 퇴직 6 월×전사). 실 적재는 관리자 ! 직접 실행(거버넌스 게이트).

-- ── 롤백(필요 시) ──────────────────────────────────────────────────────
-- drop function if exists public.erp_secure_upsert(text, jsonb), public.hr_payroll_get(), public.hr_access_log_add(text, text, boolean);
