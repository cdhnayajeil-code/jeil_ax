-- 56_portal_page_purchase_order.sql
-- 구매팀 「발주·구매요청 진행현황」 운영페이지를 포털 레지스트리에 등재 (2026-09-22 · REQ-0068)
--
-- 배경: 화면 파일(`pages/구매_발주관리_2026.html`)과 라우트(`/work/purchase-orders`)는 배포됐지만,
--       `public.portal_page` 에 행이 없으면 접근 게이트(`pages/_access-gate.js` → `jeil-me`)가
--       **전원을 차단**하고 포털 메인에도 카드가 나타나지 않는다. 이 INSERT 가 화면의 스위치다.
--
-- 권한 판정 경로(참고 · public.perm_effective):
--   visibility='부서 전용'  → (소속·겸직 부서 = dept_nm) 또는 (그 부서의 부서관리자)
--   AND erp_module 보유     → dept_erp_scope 에 'pur_order' 가 있는 부서
--   실측(2026-09-22): pur_order 모듈 보유 부서 = 구매팀·자재물류팀·사업관리팀·사업운영팀·생산팀
--   'pur_order' = perm_module_catalog 「발주·구매요청」(sort 50, sensitive=false) — 이미 정의돼 있고
--   이 페이지가 첫 사용처다. 매입 집계 화면(purchase_2026)은 'purchase' 를 쓴다(다른 축).
--
-- ⚠ 공개범위는 **최소 노출(구매팀 부서 전용)** 로 넣는다. 요청부서(생산팀 4,572건 · 사업운영팀 756건
--   · 사업관리팀 142건)에도 열어 줄지는 관리자 결정 사항이며, 아래 「선택 2」로 바꿀 수 있다.
--
-- 되돌리기: 56_portal_page_purchase_order_rollback.sql

-- ── 선택 1 (기본) · 구매팀 부서 전용 ─────────────────────────────────────────
insert into public.portal_page
  (page_key,               title,                          path,                     icon,
   dept_nm,   visibility,      shared_depts, erp_module,  sort, active, updated_by)
values
  ('purchase_order_2026', '발주·구매요청 진행현황 2026',   '/work/purchase-orders',  '📋',
   '구매팀', '부서 전용',      '{}',         'pur_order',   45, true,  'dh.choi@jeilm.co.kr')
on conflict (page_key) do update
  set title = excluded.title, path = excluded.path, icon = excluded.icon,
      dept_nm = excluded.dept_nm, visibility = excluded.visibility,
      shared_depts = excluded.shared_depts, erp_module = excluded.erp_module,
      sort = excluded.sort, active = excluded.active,
      updated_by = excluded.updated_by, updated_at = now();

-- ── 선택 2 · 요청부서와 공유(원하면 위 대신/뒤에 실행) ───────────────────────
-- update public.portal_page
--    set visibility   = '지정 부서 공유',
--        shared_depts = array['생산팀','사업운영팀','사업관리팀','자재물류팀'],
--        updated_by   = 'dh.choi@jeilm.co.kr', updated_at = now()
--  where page_key = 'purchase_order_2026';

-- ── 확인 ─────────────────────────────────────────────────────────────────────
-- select page_key, title, path, dept_nm, visibility, shared_depts, erp_module, sort, active
--   from public.portal_page where page_key = 'purchase_order_2026';
-- select (public.perm_effective('<확인할 계정 upn>') -> 'pages') as pages;   -- allowed/reason 확인
