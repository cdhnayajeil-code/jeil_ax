-- 13_payroll_module.sql
-- 급여(민감) 모듈 신설 + 인사팀 전용 게이트. 적용일 2026-07-08 · 마이그레이션 payroll_module_hr_gate
-- 급여는 민감 모듈(erp_secure/인사팀 전용). 카탈로그(코드): jeil-chat-admin CATALOG에
--   { key:'payroll', label:'급여', sensitive:true } 추가 — 콘솔 ⚠ 표시·일괄/제안(◆)에서 제외.
-- 판정: jeil-me가 dept_erp_scope로 사용자 erp_modules 산출 → hr_2026 페이지(erp_module='payroll')는
--   payroll 보유자(인사팀·관리자)만 접근. 데모(통합본)는 페이지 자체 마스킹 스크립트로 급여 마스킹.
-- 재현/이관용 정본.

-- 급여 모듈을 인사팀에만 부여(관리자는 jeil-me에서 항상 전 모듈)
insert into public.dept_erp_scope (dept_nm, module_key, updated_by)
values ('인사팀','payroll','system:payroll_seed')
on conflict (dept_nm, module_key) do nothing;

-- 인사 페이지를 payroll 모듈로 게이트(부서 전용 + 모듈 이중)
update public.portal_page
  set erp_module = 'payroll', updated_by = 'system:payroll_seed', updated_at = now()
where page_key = 'hr_2026';

-- ── 롤백(필요 시) ──────────────────────────────────────────────────────
-- delete from public.dept_erp_scope where dept_nm='인사팀' and module_key='payroll';
-- update public.portal_page set erp_module=null where page_key='hr_2026';
