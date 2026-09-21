-- ============================================================================
-- 55_erp_role_cleanup_admin_ledger.sql — 권한정리 「장부 화면」을 관리자 전용으로 분리
-- REQ-0065 후속 · 2026-09-21 · 화면 /admin/role-cleanup
--
-- 왜
--   53·54 로 ERP 권한 현황을 전사 공개하면서, 같은 RPC(`erp_role_cleanup_list`)를 쓰는
--   **관리자 장부 화면 `/admin/role-cleanup` 까지 읽기가 열리는 부수효과**가 생겼다.
--   관리자 지시(2026-09-21): 「권한정리 장부 화면은 관리자 전용으로 적용반영 —
--   페이지 공개설정에 구분해서 되어있기에 분리」.
--
-- 근거가 이미 데이터에 있다 — `portal_page` 에 두 페이지가 따로 있고 설정이 다르다:
--   · erp_role_matrix  (/work/erp-roles)     = 「전사 공개」  ← 현황 화면
--   · erp_role_cleanup (/admin/role-cleanup) = 「부서 전용」  ← 장부 화면
--   따라서 판정도 **각 페이지의 공개설정을 따로** 본다. 화면 경로가 아니라 데이터가 기준이다.
--
-- 어떻게 나누나 — 호출 형태가 이미 둘을 구분한다(실측)
--   · 현업 권한정리 탭   : erp_role_cleanup_list(p_dept_cd = 선택 부서)  → **부서 지정**
--   · 관리자 장부 화면   : erp_role_cleanup_list(전사, limit 2000)        → **부서 미지정(null)**
--   그래서 **부서 미지정(전사) 조회만** `erp_role_cleanup` 페이지 설정(부서 전용)에 걸어 막는다.
--   부서 지정 조회는 종전대로 열려 있어, 현업이 방금 저장한 「확인 완료」·「정리완료」 표시가
--   계속 보인다(이걸 같이 막으면 54 로 연 저장 기능이 반쪽이 된다).
--
-- 쓰기 권한은 이 파일에서 건드리지 않는다:
--   save·reopen = 전사(54) · mark = 관리자 전용(50·52) · cancel = 본인 요청만.
--
-- 롤백: 55_erp_role_cleanup_admin_ledger_rollback.sql (역치환 — 54 상태로 되돌린다)
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────
-- §1. 장부 화면 공개 여부 — erp_role_cleanup 페이지 자신의 설정
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.erp_role_cleanup_open()
returns boolean language sql stable security definer set search_path to '' as $fn$
  select exists (
    select 1 from public.portal_page p
     where p.page_key = 'erp_role_cleanup' and p.active and p.visibility = '전사 공개');
$fn$;

comment on function public.erp_role_cleanup_open() is
  '권한정리 장부(/admin/role-cleanup)가 「전사 공개」인가. 거짓이면 전사(부서 미지정) 조회는 관리자만. '
  'erp_role_company_open() 과 별개 — 현황 화면과 장부 화면은 portal_page 에서 따로 관리된다(REQ-0065).';

revoke all on function public.erp_role_cleanup_open() from public, anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────
-- §2. 전사(부서 미지정) 조회를 장부 페이지 설정에 건다
-- ─────────────────────────────────────────────────────────────────────────
do $mig$
begin
  perform public.erp_role_gate_patch('public.erp_role_cleanup_list(text,text,integer,text)'::regprocedure,
    $o$                and btrim(g.scope_key) in (a.dept_cd, a.dept_nm)));
  end if;$o$,
    $o$                and btrim(g.scope_key) in (a.dept_cd, a.dept_nm)));

    -- 전사(부서 미지정) 조회는 관리자 장부 화면의 몫이다 — REQ-0065 후속.
    -- 부서 지정 조회는 계속 열려 있어 현업 권한정리 탭의 「확인 완료」 표시가 유지된다.
    if v_cd is null and not public.erp_role_cleanup_open() then
      raise exception 'forbidden: 전사 권한정리 내역은 관리자만 볼 수 있습니다.' using errcode = '42501';
    end if;
  end if;$o$);
end $mig$;


-- ─────────────────────────────────────────────────────────────────────────
-- §3. 검증 (적용 후)
--   -- 비관리자: 부서 지정은 되고, 전사는 막힌다
--   do $$ begin
--     perform set_config('request.jwt.claims',
--       '{"email":"<비관리자 사내계정>","app_metadata":{"role":"internal"}}', true);
--     raise exception 'dept_ok=%', (public.erp_role_cleanup_list('3200') ->> 'ok');
--   end $$;
--   do $$ begin
--     perform set_config('request.jwt.claims', '{"email":"<비관리자>","app_metadata":{"role":"internal"}}', true);
--     perform public.erp_role_cleanup_list(null);   -- 42501 이어야 한다
--   end $$;
--   -- 되돌리려면(장부도 전사 공개로): 관리 화면에서 erp_role_cleanup 을 「전사 공개」로 바꾸면 된다.
-- ─────────────────────────────────────────────────────────────────────────
