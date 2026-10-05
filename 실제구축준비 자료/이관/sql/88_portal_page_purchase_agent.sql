-- 88_portal_page_purchase_agent.sql
-- 구매팀 「구매 AI 에이전트(파일럿)」를 포털 운영페이지 레지스트리에 등재 (2026-10-06 · REQ-0106)
--
-- 배경: 화면(`pages/구매_AI에이전트_2026.html`)과 라우트(`/work/purchase-agent`)는 09-28 부터 라이브지만
--       `public.portal_page` 에 행이 없어 포털 구매팀 카드에 보이지 않았다(파일럿 중에는 주소로만 들어갔다).
--       관리자 지시(2026-10-06 「운영페이지에 적용해서 보여줘」)로 카드에 올린다.
--
-- ⚠ 67번(기안서 대장)과 같은 점 — `erp_module` 을 **null 로 둔다.**
--   `pur_order` 를 붙이면 그 ERP 모듈을 가진 다른 부서(자재물류·사업관리·사업운영·생산)까지 카드가 보인다.
--   구매팀 부서 전용으로만 연다.
--
-- ⚠ 카드가 보인다고 쓸 수 있는 것은 아니다 — 이 화면은 접근 게이트(`_access-gate.js`)를 쓰지 않고
--   **서버(jeil-chat-lab `boot`)가 파일럿 구성원·포털 관리자인지 판정**한다(§5.4).
--   구성원이 아닌 구매팀 직원이 카드를 누르면 「파일럿 구성원 전용」 안내 화면이 나온다.
--   구성원 추가는 `/admin/agents?agent=purchase` 「구성원」 탭에서 한다.
--
-- 되돌리기: 88_portal_page_purchase_agent_rollback.sql

insert into public.portal_page
  (page_key,               title,                       path,                    icon,
   dept_nm,   visibility,  shared_depts, erp_module, sort, active, updated_by, owner_dept_cd, note)
values
  ('purchase_agent_2026',  '구매 AI 에이전트(파일럿)',   '/work/purchase-agent',  '🛒',
   '구매팀', '부서 전용',   '{}',         null,       48,  true,  'dh.choi@jeilm.co.kr', '5200',
   '부서 에이전트 파일럿(REQ-0087·0106) · 사용 권한은 에이전트 구성원·포털 관리자(서버 판정) · 🧪 검증·테스트 탭 포함')
on conflict (page_key) do update
  set title = excluded.title, path = excluded.path, icon = excluded.icon,
      dept_nm = excluded.dept_nm, visibility = excluded.visibility,
      shared_depts = excluded.shared_depts, erp_module = excluded.erp_module,
      sort = excluded.sort, active = excluded.active, note = excluded.note,
      owner_dept_cd = excluded.owner_dept_cd,
      updated_by = excluded.updated_by, updated_at = now();

-- ── 확인 ─────────────────────────────────────────────────────────────────────
-- select page_key, title, path, dept_nm, visibility, erp_module, sort, active, owner_dept_cd
--   from public.portal_page where page_key like 'purchase%' order by sort;
