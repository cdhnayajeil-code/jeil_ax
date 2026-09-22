-- 67_portal_page_proposal_ledger.sql
-- 구매팀 「기안서 대장 2026」 운영페이지를 포털 레지스트리에 등재 (2026-09-22 · REQ-0077)
--
-- 배경: 화면(`pages/구매_기안서대장_2026.html`)과 라우트(`/work/purchase-proposals`)는 준비됐지만,
--       `public.portal_page` 에 행이 없으면 접근 게이트(`pages/_access-gate.js`)가 전원을 차단하고
--       포털 카드도 생기지 않는다. 58번(발주통합 LIST)과 같은 모양이다.
--
-- ⚠ 58번과 다른 점 — `erp_module` 을 **null 로 둔다.**
--   이 화면의 원천은 ERP 가 아니라 **구매팀 Teams 엑셀 대장**이다. `pur_order` 를 붙이면
--   ERP 모듈 보유 부서(자재물류·사업관리·사업운영·생산)까지 열람 대상이 되어 범위가 넓어진다.
--   구매팀 부서 전용으로만 열고, 공유가 필요해지면 아래 선택 2 로 부서를 명시한다.
--
-- ⚠ 실행 전 확인 — 화면에는 관리 대상 169건(업체명·금액 포함)이 정적으로 들어 있다.
--   정적 HTML 은 URL 을 아는 사람이면 소스를 읽을 수 있다(게이트는 렌더만 막는다).
--   **커밋·배포 승인과 이 등재는 같은 판단**이다(REQ-0077 작업로그 참조).
--
-- 되돌리기: 67_portal_page_proposal_ledger_rollback.sql

-- ── 선택 1 (기본) · 구매팀 부서 전용 ─────────────────────────────────────────
insert into public.portal_page
  (page_key,                   title,                  path,                        icon,
   dept_nm,   visibility,    shared_depts, erp_module, sort, active, updated_by, note)
values
  ('purchase_proposal_2026',  '기안서 대장 2026',      '/work/purchase-proposals',  '📝',
   '구매팀', '부서 전용',      '{}',         null,       47,  true,  'dh.choi@jeilm.co.kr',
   '원천: 구매팀 Teams 기안서 목록대장(2026) · 스캔본은 문서중앙화 검색어로 연결 · 초안(관리대상 169건)')
on conflict (page_key) do update
  set title = excluded.title, path = excluded.path, icon = excluded.icon,
      dept_nm = excluded.dept_nm, visibility = excluded.visibility,
      shared_depts = excluded.shared_depts, erp_module = excluded.erp_module,
      sort = excluded.sort, active = excluded.active, note = excluded.note,
      updated_by = excluded.updated_by, updated_at = now();

-- ── 선택 2 · 대장을 함께 보는 부서와 공유(필요해지면) ────────────────────────
-- update public.portal_page
--    set visibility   = '지정 부서 공유',
--        shared_depts = array['사업관리팀','자금팀'],
--        updated_by   = 'dh.choi@jeilm.co.kr', updated_at = now()
--  where page_key = 'purchase_proposal_2026';

-- ── 확인 ─────────────────────────────────────────────────────────────────────
-- select page_key, title, path, dept_nm, visibility, erp_module, sort, active
--   from public.portal_page where page_key like 'purchase%' order by sort;
