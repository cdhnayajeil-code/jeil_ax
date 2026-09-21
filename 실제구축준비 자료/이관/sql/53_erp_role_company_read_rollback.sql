-- ============================================================================
-- 53_erp_role_company_read_rollback.sql — REQ-0065 「전사 열람」 되돌리기
--
-- 백업 테이블(public.erp_role_gate_backup)에 저장된 **패치 직전 라이브 정의**를
-- 그대로 복원한다. 정본 50·51 텍스트로 덮지 않는다 — 라이브에만 있던 개선분
-- (dept_detail·list·menu_detail)을 지키기 위함이다.
--
-- 되돌리지 않고 「닫기만」 하려면 SQL 이 아니라 데이터 한 줄이면 된다:
--   update public.portal_page set visibility = '부서 전용' where page_key = 'erp_role_matrix';
--   → erp_role_company_open() 이 false 가 되어 옛 동작(perm_grant dept 필요)으로 자동 복귀한다.
-- ============================================================================

do $rb$
declare r record; n int := 0;
begin
  for r in select definition from public.erp_role_gate_backup order by proname loop
    execute r.definition;
    n := n + 1;
  end loop;
  if n = 0 then
    raise exception '백업이 비어 있습니다 — 복원할 정의가 없습니다.';
  end if;
  raise notice '복원한 함수 %개', n;
end $rb$;

drop function if exists public.erp_role_gate_patch(regprocedure, text, text);
drop function if exists public.erp_role_can_write(text);
drop function if exists public.erp_role_company_open();

-- 백업 테이블은 이력으로 남긴다. 완전히 지우려면:
--   drop table public.erp_role_gate_backup;
