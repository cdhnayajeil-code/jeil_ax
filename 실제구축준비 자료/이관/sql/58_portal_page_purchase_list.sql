-- 58_portal_page_purchase_list.sql
-- 구매팀 「발주통합관리 LIST」 운영페이지를 포털 레지스트리에 등재 (2026-09-22 · REQ-0069)
--
-- 배경: 화면(`pages/구매_발주통합LIST_2026.html`)과 라우트(`/work/purchase-list`)는 배포됐지만,
--       `public.portal_page` 에 행이 없으면 접근 게이트가 전원을 차단하고 포털 카드도 없다.
--       56번(요약 화면 `purchase_order_2026`)과 같은 모양이며, 같은 `erp_module='pur_order'` 를 쓴다
--       → `dept_erp_scope` 변경 불필요(pur_order 보유: 구매팀·자재물류팀·사업관리팀·사업운영팀·생산팀).
--
-- ⚠ 구매팀에 카드가 2장(요약 `/work/purchase-orders` + 목록 `/work/purchase-list`)이 된다.
--   sort=46 으로 매입집계(40)·요약(45) 다음에 놓인다.
--
-- 되돌리기: 58_portal_page_purchase_list_rollback.sql

-- ── 선택 1 (기본) · 구매팀 부서 전용 ─────────────────────────────────────────
insert into public.portal_page
  (page_key,              title,                      path,                   icon,
   dept_nm,   visibility,  shared_depts, erp_module,  sort, active, updated_by)
values
  ('purchase_list_2026', '발주통합관리 LIST 2026',    '/work/purchase-list',  '📑',
   '구매팀', '부서 전용',   '{}',         'pur_order',  46, true,  'dh.choi@jeilm.co.kr')
on conflict (page_key) do update
  set title = excluded.title, path = excluded.path, icon = excluded.icon,
      dept_nm = excluded.dept_nm, visibility = excluded.visibility,
      shared_depts = excluded.shared_depts, erp_module = excluded.erp_module,
      sort = excluded.sort, active = excluded.active,
      updated_by = excluded.updated_by, updated_at = now();

-- ── 선택 2 · 요청부서와 공유(엑셀을 함께 보던 부서가 있으면) ─────────────────
-- update public.portal_page
--    set visibility   = '지정 부서 공유',
--        shared_depts = array['생산팀','사업운영팀','사업관리팀','자재물류팀'],
--        updated_by   = 'dh.choi@jeilm.co.kr', updated_at = now()
--  where page_key = 'purchase_list_2026';

-- ── 확인 ─────────────────────────────────────────────────────────────────────
-- select page_key, title, path, dept_nm, visibility, erp_module, sort, active
--   from public.portal_page where page_key like 'purchase%' order by sort;
