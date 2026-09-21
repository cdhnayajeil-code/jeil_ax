-- ============================================================================
-- 54_erp_role_cleanup_company_write.sql — 권한정리 「표시·저장」을 전사 개방
-- REQ-0065 후속 · 2026-09-21 · 화면 /work/erp-roles 권한정리 탭
--
-- 왜
--   53 번으로 열람만 전사 개방했더니 권한정리 탭이 읽기 전용 사용자에게 숨겨졌다.
--   관리자 지시(2026-09-21): 「권한정리 저장기능도 가능하도록 반영 —
--   해당 권한 정리는 내역을 보고 관리자가 정리하기에 적용반영」.
--   즉 **표시·저장은 현업이 하고, 실제 정리(ERP 회수·상태 반영)는 관리자가 장부를 보고 한다.**
--   장부에 남기는 행위 자체는 ERP 를 바꾸지 않으므로(CLAUDE.md §1.6 — 실거래는 사람이 실행)
--   전사에 열어도 위험이 없다.
--
-- 무엇을 열고 무엇을 닫아 두나
--   연다  : erp_role_cleanup_save   (제외 표시 저장 · 「권한확인 완료」 기록)
--           erp_role_cleanup_list   (부서 정리 내역 읽기)
--           erp_role_cleanup_reopen (확인완료 → 수정)
--   닫는다: erp_role_cleanup_mark   (applied/cancelled 상태 변경 = 관리자가 실제 정리했다는 표시)
--           → 관리자 전용 그대로. 이 경계가 「현업이 표시 / 관리자가 정리」를 만든다.
--   erp_role_cleanup_cancel 는 이미 **본인이 올린 요청만** 취소 가능(requested_by = 본인)이라 손대지 않는다.
--
-- 방식은 53 과 같다 — 라이브 정의를 읽어 게이트 문자열만 치환하고, 원본은
-- erp_role_gate_backup 에 보관한다(정본↔라이브 드리프트 보존).
-- 롤백: 54_erp_role_cleanup_company_write_rollback.sql
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────
-- §1. 쓰기 판정 확장 — 전사 공개면 표시·저장까지 가능
--     (화면은 이 값으로 권한정리 탭을 보이거나 숨긴다)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.erp_role_can_write(p_upn text)
returns boolean language sql stable security definer set search_path to '' as $fn$
  select public.erp_role_company_open()
      or coalesce((public.perm_effective(lower(btrim(coalesce(p_upn, '')))) ->> 'is_admin')::boolean, false)
      or exists (
           select 1 from public.perm_grant g
            where lower(g.upn) = lower(btrim(coalesce(p_upn, ''))) and g.revoked_at is null
              and g.scope_type = 'dept' and g.effect = 'allow'
              and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now()));
$fn$;

comment on function public.erp_role_can_write(text) is
  '권한정리 장부에 표시·저장할 수 있는가 — 전사 공개이거나, 관리자이거나, 부서 범위(perm_grant dept) 보유자. '
  '실제 정리 반영(erp_role_cleanup_mark)은 여기 포함되지 않는다 — 관리자 전용(REQ-0065).';

revoke all on function public.erp_role_can_write(text) from public, anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────
-- §2. 원본 백업 (54 분)
-- ─────────────────────────────────────────────────────────────────────────
insert into public.erp_role_gate_backup (proname, definition, note)
select p.proname, pg_get_functiondef(p.oid), 'REQ-0065 권한정리 전사개방 패치 직전'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('erp_role_cleanup_save','erp_role_cleanup_list','erp_role_cleanup_reopen')
on conflict (proname) do nothing;


-- ─────────────────────────────────────────────────────────────────────────
-- §3. 게이트 치환
-- ─────────────────────────────────────────────────────────────────────────
do $mig$
declare
  old_b text := $b$    select coalesce(array_agg(distinct t.dept_cd), '{}') into v_scope
      from erp_ro.v_dept_tree t
     where t.org_change_id = v_ver
       and exists (
             select 1 from public.perm_grant g
               join erp_ro.v_dept_tree a
                 on a.org_change_id = t.org_change_id and a.dept_cd = any (t.path_cd)
              where lower(g.upn) = v_upn and g.revoked_at is null
                and g.scope_type = 'dept' and g.effect = 'allow'
                and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
                and btrim(g.scope_key) in (a.dept_cd, a.dept_nm));$b$;
  new_b text := $b$    select coalesce(array_agg(distinct t.dept_cd), '{}') into v_scope
      from erp_ro.v_dept_tree t
     where t.org_change_id = v_ver
       and (public.erp_role_company_open()   -- REQ-0065: 전사 공개면 전 조직
            or exists (
             select 1 from public.perm_grant g
               join erp_ro.v_dept_tree a
                 on a.org_change_id = t.org_change_id and a.dept_cd = any (t.path_cd)
              where lower(g.upn) = v_upn and g.revoked_at is null
                and g.scope_type = 'dept' and g.effect = 'allow'
                and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
                and btrim(g.scope_key) in (a.dept_cd, a.dept_nm)));$b$;
begin
  -- 1) 정리 내역 읽기 — 범위만 넓히면 된다(거부 분기 없음)
  perform public.erp_role_gate_patch('public.erp_role_cleanup_list(text,text,integer,text)'::regprocedure, old_b, new_b);

  -- 2) 제외 표시 저장
  perform public.erp_role_gate_patch('public.erp_role_cleanup_save(text,jsonb,text,text,text)'::regprocedure, old_b, new_b);
  perform public.erp_role_gate_patch('public.erp_role_cleanup_save(text,jsonb,text,text,text)'::regprocedure,
    $o$    if not (v_cd = any (coalesce(v_scope, '{}'))) then
      raise exception 'forbidden: 이 조직의 권한을 정리할 수 없습니다.' using errcode = '42501';
    end if;$o$,
    $o$    if not (public.erp_role_company_open() or v_cd = any (coalesce(v_scope, '{}'))) then
      raise exception 'forbidden: 이 조직의 권한을 정리할 수 없습니다.' using errcode = '42501';
    end if;$o$);

  -- 3) 확인완료 → 수정
  perform public.erp_role_gate_patch('public.erp_role_cleanup_reopen(text,text)'::regprocedure, old_b, new_b);
  perform public.erp_role_gate_patch('public.erp_role_cleanup_reopen(text,text)'::regprocedure,
    $o$    if not (v_cd = any (coalesce(v_scope, '{}'))) then
      raise exception 'forbidden: 이 조직을 수정할 수 없습니다.' using errcode = '42501';
    end if;$o$,
    $o$    if not (public.erp_role_company_open() or v_cd = any (coalesce(v_scope, '{}'))) then
      raise exception 'forbidden: 이 조직을 수정할 수 없습니다.' using errcode = '42501';
    end if;$o$);
end $mig$;


-- ─────────────────────────────────────────────────────────────────────────
-- §4. 검증 (적용 후)
--   -- 비관리자 시뮬레이션에서 저장이 통과하는지 — 트랜잭션을 되감아 흔적을 남기지 않는다
--   do $$ begin
--     perform public.erp_role_cleanup_save('3200', '[]'::jsonb, '권한확인 완료', null, null);
--     raise exception 'ROLLBACK_TEST';   -- 여기 도달하면 권한 통과 + 저장분은 되감김
--   end $$;
--   -- 상태 변경은 여전히 관리자만:
--   select public.erp_role_cleanup_mark(array[]::bigint[], 'applied');  -- 42501 이어야 한다
-- ─────────────────────────────────────────────────────────────────────────
