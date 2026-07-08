-- 11_portal_page_perm.sql
-- 권한 enforcement 기반 — 페이지 레지스트리 + 부서별 ERP 모듈 권한.
-- 적용일 2026-07-08 · Supabase 마이그레이션: portal_page_perm
-- 판정은 Edge Function jeil-me(서버 권위, verify_jwt=false)가 수행:
--   Entra 토큰 → Graph 재검증 upn → v_erp_user_dept(내 부서) → portal_admin/dept_permission(역할)
--   → portal_page + dept_permission(페이지 접근) → dept_erp_scope(허용 ERP 모듈).
-- 부서명 기준은 ERP 사용자-부서 매핑(v_erp_dept_roster, 09 참조).
-- 재현/이관용 정본 — apply_migration으로 적용된 DDL의 사본.

create table if not exists public.portal_page (
  page_key     text primary key,
  title        text not null,
  path         text not null,
  icon         text,
  dept_nm      text,                              -- 소유(주무) 부서
  visibility   text not null default '부서 전용',   -- 부서 전용 | 전사 공개 | 지정 부서 공유
  shared_depts text[] not null default '{}',      -- 지정 부서 공유 대상
  erp_module   text,                              -- ERP 데이터 페이지면 모듈키(sales/purchase/inventory/item/pur_order/user_dept)
  note         text,
  sort         int not null default 100,
  active       boolean not null default true,
  updated_by   text,
  updated_at   timestamptz not null default now()
);
comment on table public.portal_page is '부서 운영 페이지 레지스트리 — 포털 카드/페이지 게이트의 접근 판정 단일 출처.';

create table if not exists public.dept_erp_scope (
  dept_nm    text not null,
  module_key text not null,   -- sales|purchase|inventory|item|pur_order|user_dept
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (dept_nm, module_key)
);
comment on table public.dept_erp_scope is '부서별 허용 ERP 데이터 모듈 — 챗봇/페이지 ERP 접근 강제(erp_scope). 기본값 ERP 기준, 관리자 편집.';

alter table public.portal_page    enable row level security;
alter table public.dept_erp_scope enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='portal_page' and policyname='internal_select_portal_page') then
    create policy internal_select_portal_page on public.portal_page for select to authenticated
      using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='dept_erp_scope' and policyname='internal_select_dept_erp_scope') then
    create policy internal_select_dept_erp_scope on public.dept_erp_scope for select to authenticated
      using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
  end if;
end $$;
grant select on public.portal_page, public.dept_erp_scope to authenticated;
grant select, insert, update, delete on public.portal_page, public.dept_erp_scope to service_role;

-- ── 시드: 현재 8개 부서 운영 페이지(04 배지 기준) ──────────────────────
insert into public.portal_page (page_key, title, path, icon, dept_nm, visibility, shared_depts, erp_module, sort) values
  ('cost_dashboard_095','프로젝트 원가관리 시스템 (2025-095-SUL-EC)','pages/2025-095-SUL-EC_원가현황_20260514.html','📊','사업관리팀','부서 전용','{}',null,10),
  ('cost_summary_095','프로젝트 원가 요약 (ERP DB 추출)','pages/프로젝트원가_요약_2025-095-SUL-EC.html','📑','사업관리팀','부서 전용','{}',null,20),
  ('sales_2026','수주현황 대시보드 2026','pages/영업_수주현황_2026.html','📈','영업팀','부서 전용','{}','sales',30),
  ('purchase_2026','거래처별 매입금액 집계 2026','pages/구매_거래처별매입집계_2026.html','📦','구매팀','부서 전용','{}','purchase',40),
  ('hr_2026','인원 및 급여 추이 2026','pages/인사_인원급여추이_2026.html','👥','인사팀','부서 전용','{}',null,50),
  ('finance_daily','자금일보 대시보드 (일 단위)','pages/자금_자금일보_대시보드_2026.html','💰','자금팀','부서 전용','{}',null,60),
  ('inventory_2026','재고 입·출고 현황 2026','pages/자재물류_재고입출고_2026.html','🚚','자재물류팀','지정 부서 공유','{구매팀,사업관리팀}','inventory',70),
  ('item_search','품목 존재/중복 조회','pages/품목중복_조회_2026.html','🔍','사업관리팀','지정 부서 공유','{구매팀,자재물류팀,생산팀,기계설계팀,공정설계팀}','item',80)
on conflict (page_key) do nothing;

-- ── 시드: 부서별 ERP 모듈 권한(ERP 기준 기본값 — 관리자 편집 가능) ────────
insert into public.dept_erp_scope (dept_nm, module_key) values
  ('영업팀','sales'),
  ('구매팀','purchase'),('구매팀','inventory'),('구매팀','pur_order'),
  ('자재물류팀','inventory'),('자재물류팀','pur_order'),('자재물류팀','item'),
  ('사업관리팀','sales'),('사업관리팀','purchase'),('사업관리팀','inventory'),('사업관리팀','item'),('사업관리팀','pur_order'),
  ('사업운영팀','sales'),('사업운영팀','purchase'),('사업운영팀','inventory'),('사업운영팀','item'),('사업운영팀','pur_order'),
  ('생산팀','item'),('생산팀','inventory'),
  ('품질팀','item'),('품질팀','inventory'),
  ('기계설계팀','item'),('공정설계팀','item'),
  ('자금팀','sales'),('자금팀','purchase'),
  ('인사팀','user_dept')
on conflict (dept_nm, module_key) do nothing;

-- ── 롤백(필요 시) ──────────────────────────────────────────────────────
-- drop table if exists public.portal_page, public.dept_erp_scope;
