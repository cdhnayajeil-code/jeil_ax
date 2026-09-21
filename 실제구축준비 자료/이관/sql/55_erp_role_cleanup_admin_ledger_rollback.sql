-- ============================================================================
-- 55_erp_role_cleanup_admin_ledger_rollback.sql — 장부 화면 분리를 되돌린다(54 상태로)
--
-- 백업 테이블 복원을 쓰지 않는다 — 그 백업은 53 이전 정의라 되돌리면 54(권한정리 저장 개방)까지
-- 함께 사라진다. 그래서 **역치환**으로 55 가 넣은 검사 블록만 걷어낸다.
--
-- 참고: SQL 을 돌리지 않고도 열 수 있다 — 관리 화면에서 `erp_role_cleanup` 페이지를
--       「전사 공개」로 바꾸면 `erp_role_cleanup_open()` 이 참이 되어 전사 조회가 열린다.
-- ============================================================================

do $rb$
begin
  perform public.erp_role_gate_patch('public.erp_role_cleanup_list(text,text,integer,text)'::regprocedure,
    $o$                and btrim(g.scope_key) in (a.dept_cd, a.dept_nm)));

    -- 전사(부서 미지정) 조회는 관리자 장부 화면의 몫이다 — REQ-0065 후속.
    -- 부서 지정 조회는 계속 열려 있어 현업 권한정리 탭의 「확인 완료」 표시가 유지된다.
    if v_cd is null and not public.erp_role_cleanup_open() then
      raise exception 'forbidden: 전사 권한정리 내역은 관리자만 볼 수 있습니다.' using errcode = '42501';
    end if;
  end if;$o$,
    $o$                and btrim(g.scope_key) in (a.dept_cd, a.dept_nm)));
  end if;$o$);
end $rb$;

drop function if exists public.erp_role_cleanup_open();
