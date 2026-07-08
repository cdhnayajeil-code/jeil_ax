-- 14_erp_secure_hr.sql
-- 민감 데이터 분리 스키마 erp_secure + 인사 급여 월집계(hr_payroll_m) + 감사로그.
-- 적용일 2026-07-08 · 마이그레이션 erp_secure_hr_schema (승인-준비 빈 구조).
--
-- ⚠ 거버넌스 게이트(CLAUDE.md §1.7·§4·§6, 설계 07 §L206, 10_ERP_DB연계 P5):
--   · 인사·급여는 '집계만'(총액·인원) 반입. 개인별 급여·주민번호·계좌는 중간DB 미연계.
--   · 실 적재는 **경영 승인 + 유니포인트 View 협의 + (권장) AI-Portal-HR Entra 그룹** 선행.
--   · erp_secure는 REST 비노출·service_role 전용. 조회는 인사팀 전용 게이트 API(jeil-hr, 아래 설계)만.
--   · 커넥터 검증(2026-07-08): 인사 테이블(HAA010T·HDF070T·HGA070T·TH101BA1)은 실존하나 로컬 메타에
--     컬럼 문서가 없어 컬럼 스펙은 유니포인트 확인 후 확정. 아래 추출 SQL은 '초안'(문서 추정치).
-- 재현/이관용 정본.

create schema if not exists erp_secure;

create table if not exists erp_secure.hr_payroll_m (
  ym          text not null,          -- 귀속월 YYYY-MM (HDF070T.PAY_YYMM)
  dept_nm     text not null default '전사',
  headcount   int,                    -- 급여대상 인원(COUNT)
  pay_tot_amt numeric,                -- 급여총액(SUM PAY_TOT_AMT) — 집계만
  retire_amt  numeric,                -- 퇴직급여 집계(HGA070T) — 집계만
  synced_at   timestamptz not null default now(),
  batch_id    uuid,
  primary key (ym, dept_nm)
);

alter table erp_secure.hr_payroll_m enable row level security;   -- authenticated 정책 없음 = 전면 차단
grant usage on schema erp_secure to service_role;
grant select, insert, update, delete on erp_secure.hr_payroll_m to service_role;

create table if not exists erp_secure.hr_access_log (
  id      bigint generated always as identity primary key,
  upn     text not null, dept_nm text, action text not null default 'view_hr_payroll',
  ok      boolean not null, at timestamptz not null default now()
);
alter table erp_secure.hr_access_log enable row level security;
grant select, insert on erp_secure.hr_access_log to service_role;

-- ── 승인 후 구축 예정(설계) ──────────────────────────────────────────────
-- 1) 적재 RPC(public, security definer, service_role 전용) — erp_secure는 REST 비노출이므로 게이트 API가
--    이 RPC로만 읽는다:
--      create function public.hr_payroll_get() returns setof erp_secure.hr_payroll_m
--        language sql security definer set search_path='' as $$ select * from erp_secure.hr_payroll_m $$;
--      revoke all on function public.hr_payroll_get() from public, authenticated;  grant execute to service_role;
-- 2) ETL job(집계 전용 초안 — 컬럼명 유니포인트 확인 후 보정, 개인 행·주민·계좌 절대 미추출):
--      SELECT PAY_YYMM AS ym, DEPT_NM AS dept_nm, COUNT(*) AS headcount, SUM(PAY_TOT_AMT) AS pay_tot_amt
--      FROM JEILMNS.dbo.HDF070T WITH (NOLOCK) WHERE PAY_YYMM LIKE '2026%' GROUP BY PAY_YYMM, DEPT_NM
--    → erp_secure_upsert(service_role) 로 적재. 관리자 `!` 직접 실행(승인 후).
-- 3) 게이트 API `jeil-hr`(Edge Function, verify_jwt=false): Entra 검증 → v_erp_user_dept로 dept 확인
--    → dept='인사팀' 또는 portal_admin 만 허용(아니면 403). hr_access_log 기록. hr_payroll_get() 반환.
--    인사 페이지는 권한자면 이 API로 실 집계 표시(마스킹 해제), 비권한/데모는 샘플·마스킹 유지.

-- ── 롤백(필요 시) ──────────────────────────────────────────────────────
-- drop schema if exists erp_secure cascade;
