-- ============================================================================
-- 54_erp_role_cleanup_company_write_rollback.sql — 권한정리 전사 개방만 되돌리기
--
-- 53(열람 개방)은 그대로 두고 **권한정리 표시·저장만** 관리자/부서 부여자 전용으로 되돌린다.
-- 53 까지 통째로 되돌리려면 53_erp_role_company_read_rollback.sql 을 쓴다
-- (그 파일은 백업 테이블의 전 행을 복원하므로 54 분도 함께 되돌아간다).
--
-- 닫기만 하려면 SQL 없이 데이터 한 줄로도 된다:
--   update public.portal_page set visibility = '부서 전용' where page_key = 'erp_role_matrix';
--   → erp_role_company_open() 이 false 가 되어 열람·쓰기 모두 옛 규칙으로 복귀한다.
-- ============================================================================

-- §1. 권한정리 3종을 패치 직전 정의로 복원
do $rb$
declare r record; n int := 0;
begin
  for r in select definition from public.erp_role_gate_backup
            where proname in ('erp_role_cleanup_save','erp_role_cleanup_list','erp_role_cleanup_reopen')
            order by proname loop
    execute r.definition;
    n := n + 1;
  end loop;
  if n <> 3 then
    raise exception '권한정리 백업이 3건이 아닙니다(%건) — 복원 중단', n;
  end if;
  raise notice '권한정리 함수 %개 복원', n;
end $rb$;

-- §2. 쓰기 판정에서 전사 공개 조항을 뺀다(53 버전으로 복귀)
create or replace function public.erp_role_can_write(p_upn text)
returns boolean language sql stable security definer set search_path to '' as $fn$
  select coalesce((public.perm_effective(lower(btrim(coalesce(p_upn, '')))) ->> 'is_admin')::boolean, false)
      or exists (
           select 1 from public.perm_grant g
            where lower(g.upn) = lower(btrim(coalesce(p_upn, ''))) and g.revoked_at is null
              and g.scope_type = 'dept' and g.effect = 'allow'
              and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now()));
$fn$;

revoke all on function public.erp_role_can_write(text) from public, anon, authenticated;
