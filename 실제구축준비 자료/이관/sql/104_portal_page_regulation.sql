-- 104_portal_page_regulation.sql — 「사내규정 조회」 운영페이지 포털 등재 (REQ-0124 · 2026-10-08 · 관리자 결정 D-153·D-154)
-- 마이그레이션: portal_page_regulation_req0124
--
-- 무엇을: public.portal_page 에 page_key 'regulation_lookup' 1행. 전사 공개(사내 로그인 전원) · erp_module 없음 · dept_nm null
--         → 포털 메인 「🌐 전사 공통」 묶음(REQ-0121 · 선례 erp_role_matrix)에 들어간다.
-- 권한: visibility='전사 공개' 이면 perm_effective_v2 가 erp_module null → 전원 allowed(SQL 69). owner_dept_cd 는 판정에 쓰이지 않고
--       「담당 부서」 표시·부서 관리자 범위용 — 총무팀 3200 가정(D-155 · 인사팀이면 '3150' 으로 바꾼다).
-- 데이터: 화면은 definer RPC reg_list/reg_get/reg_search/reg_status(정본 SQL 103)만 읽는다.
-- 되돌리기: 104_portal_page_regulation_rollback.sql (active=false — 행 삭제 아님)

insert into public.portal_page
  (page_key,            title,          path,                icon,
   dept_nm, visibility,  shared_depts, erp_module, sort, active, updated_by,            owner_dept_cd, note)
values
  ('regulation_lookup', '사내규정 조회', '/work/regulations', '📚',
   null,    '전사 공개',  '{}',         null,       7,    true,   'dh.choi@jeilm.co.kr', '3200',
   '사내규정 조회(REQ-0124) · 그룹웨어 규정 게시판 사본(public.reg_* · 정본 SQL 103) · 전 직원 열람 · 원본·첨부 정본은 NAS·그룹웨어')
on conflict (page_key) do update
  set title = excluded.title, path = excluded.path, icon = excluded.icon,
      dept_nm = excluded.dept_nm, visibility = excluded.visibility,
      shared_depts = excluded.shared_depts, erp_module = excluded.erp_module,
      sort = excluded.sort, active = excluded.active, note = excluded.note,
      owner_dept_cd = excluded.owner_dept_cd,
      updated_by = excluded.updated_by, updated_at = now();

-- ── 확인 ─────────────────────────────────────────────────────────────────────
-- select page_key, title, path, dept_nm, visibility, erp_module, sort, active, owner_dept_cd
--   from public.portal_page where page_key = 'regulation_lookup';
-- 일반 사내 사용자 1명으로 판정 확인(true · '전사 공개'):
-- select p ->> 'allowed', p ->> 'reason' from jsonb_array_elements(public.perm_effective('<upn>') -> 'pages') p
--  where p ->> 'page_key' = 'regulation_lookup';
