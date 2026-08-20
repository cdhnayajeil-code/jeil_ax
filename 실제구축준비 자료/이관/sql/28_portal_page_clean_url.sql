-- 28_portal_page_clean_url.sql
-- 포털 페이지 레지스트리 경로를 클린 URL로 전환 (2026-08-20)
--
-- 배경: 로그인 후 포털 메인의 "부서 운영 페이지" 카드는 public.portal_page.path 를 그대로
--       href 로 쓴다. 파일명 기반 상대경로("pages/자금_결의전표_입력_2026.html")를
--       루트 절대 클린 URL("/work/voucher")로 바꿔 화면·문서·DB의 주소 표기를 통일한다.
-- 라우트 정의 단일 출처: 저장소 루트 `_routes.py` (→ vercel.json 리라이트 생성)
-- 되돌리기: 아래 값을 예전 파일 경로로 되돌리면 된다. 실제 파일은 그대로 있으므로
--           구 .html 주소도 계속 동작한다(vercel cleanUrls 자동 리다이렉트).

update public.portal_page p set path = m.route
from (values
  ('cost_dashboard_095', '/work/project-cost-detail'),
  ('cost_summary_095',   '/work/project-cost'),
  ('finance_daily',      '/work/cash-daily'),
  ('finance_dashboard',  '/work/cash-status'),
  ('gl_draft',           '/work/voucher'),
  ('hr_2026',            '/work/hr-payroll'),
  ('inventory_2026',     '/work/inventory'),
  ('item_search',        '/work/item-duplicates'),
  ('purchase_2026',      '/work/purchase-vendor'),
  ('sales_2026',         '/work/sales-orders')
) as m(page_key, route)
where p.page_key = m.page_key;
