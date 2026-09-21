-- ============================================================================
-- 53_erp_role_company_read.sql — ERP 권한 현황 「전사 열람」 개방
-- REQ-0065 · 2026-09-21 · 화면 /work/erp-roles (pages/ERP권한_조직별현황.html)
--
-- 왜
--   portal_page.erp_role_matrix.visibility 를 「전사 공개」로 바꿨는데도 관리자 3명 외
--   전 사내 사용자가 「열람 권한이 필요합니다」를 봤다. 게이트가 2단인데
--   ② 행 범위(perm_grant scope_type='dept')가 라이브 전체 0건이라 전원 차단됐다(2026-09-21 실측).
--   관리자 지시(2026-09-21): 「권한에 대한 공개는 전사공개가 문제없으니 전사열람으로 변경」.
--
-- 설계 판단
--   1) 열람 개방의 스위치는 **페이지의 visibility 값**이다(perm_effective 의 allowed 가 아니라).
--      「전사 공개」인 동안에만 전 조직이 열린다. 「부서 전용」으로 되돌리면 옛 동작
--      (perm_grant dept 필요)으로 **자동 복귀**한다 — 코드를 다시 고칠 필요가 없다.
--      allowed 를 스위치로 삼으면, 나중에 부서 전용으로 바꿨을 때 그 부서원이
--      전사를 보게 되는 조용한 확대가 생긴다.
--   2) perm_grant(dept) 체계를 지우지 않는다. 조건을 `company_open() or <기존>` 으로 **더한다**.
--   3) 쓰기(권한정리 저장·상태변경)는 열람과 분리한다. cleanup_* 4종은 건드리지 않고,
--      화면이 숨길 수 있도록 org_tree 응답에 can_write 를 추가한다.
--   4) **라이브 정의를 읽어 문자열만 치환한다.** 정본 50·51 과 라이브가 어긋난 함수가 3종
--      (dept_detail·list·menu_detail — list 는 라이브에 검색 인자 2개가 더 있다) 있어
--      정본 텍스트로 create or replace 하면 라이브 개선분이 조용히 사라진다(REQ-0048·0039 유형).
--      앵커가 안 맞으면 패치가 **예외로 중단**된다 — 조용히 넘어가지 않는다.
--   5) 원본 정의는 erp_role_gate_backup 에 저장한다. 롤백은 그 텍스트를 그대로 되돌린다.
--
-- 개인정보: 반환 항목은 바꾸지 않는다. 사번·입퇴사일·직위코드·grw_id·MS object_id 는
--           여전히 반환하지 않는다(CLAUDE.md §1.7 — 이름은 마스킹 예외).
-- 롤백: 53_erp_role_company_read_rollback.sql
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────
-- §1. 헬퍼
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.erp_role_company_open()
returns boolean language sql stable security definer set search_path to '' as $fn$
  select exists (
    select 1 from public.portal_page p
     where p.page_key = 'erp_role_matrix' and p.active and p.visibility = '전사 공개');
$fn$;

comment on function public.erp_role_company_open() is
  'ERP 권한 현황이 「전사 공개」인가. 참이면 사내 로그인 사용자는 전 조직을 열람한다(REQ-0065). '
  '「부서 전용」으로 되돌리면 자동으로 perm_grant(dept) 기반 부서 열람으로 복귀한다.';

create or replace function public.erp_role_can_write(p_upn text)
returns boolean language sql stable security definer set search_path to '' as $fn$
  select coalesce((public.perm_effective(lower(btrim(coalesce(p_upn, '')))) ->> 'is_admin')::boolean, false)
      or exists (
           select 1 from public.perm_grant g
            where lower(g.upn) = lower(btrim(coalesce(p_upn, ''))) and g.revoked_at is null
              and g.scope_type = 'dept' and g.effect = 'allow'
              and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now()));
$fn$;

comment on function public.erp_role_can_write(text) is
  '권한정리 장부에 쓸 수 있는가 — 관리자이거나 부서 범위(perm_grant dept)를 받은 사람. '
  '전사 열람이 열려도 쓰기는 넓어지지 않는다(REQ-0065).';

revoke all on function public.erp_role_company_open() from public, anon, authenticated;
revoke all on function public.erp_role_can_write(text) from public, anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────
-- §2. 원본 백업 — 롤백 정확도를 위해 라이브 정의를 그대로 보관
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.erp_role_gate_backup (
  proname     text primary key,
  definition  text not null,
  saved_at    timestamptz not null default now(),
  note        text
);
alter table public.erp_role_gate_backup enable row level security;
revoke all on table public.erp_role_gate_backup from public, anon, authenticated;

insert into public.erp_role_gate_backup (proname, definition, note)
select p.proname, pg_get_functiondef(p.oid), 'REQ-0065 전사열람 패치 직전'
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('erp_role_org_tree','erp_role_dept_detail','erp_role_summary',
                     'erp_role_list','erp_role_menu_detail','erp_user_roles')
on conflict (proname) do nothing;


-- ─────────────────────────────────────────────────────────────────────────
-- §3. 게이트 치환기 — 앵커가 없으면 예외로 멈춘다
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.erp_role_gate_patch(p_fn regprocedure, p_old text, p_new text)
returns void language plpgsql as $fn$
declare d text; nd text;
begin
  d := pg_get_functiondef(p_fn);
  if position(p_old in d) = 0 then
    raise exception '앵커를 찾지 못했습니다 — 패치 중단: %', p_fn;
  end if;
  nd := replace(d, p_old, p_new);
  if nd = d then
    raise exception '치환이 일어나지 않았습니다: %', p_fn;
  end if;
  execute nd;
end $fn$;

revoke all on function public.erp_role_gate_patch(regprocedure, text, text) from public, anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────
-- §4. 읽기 RPC 6종 개방
-- ─────────────────────────────────────────────────────────────────────────
do $mig$
declare
  -- 부서 범위 계산 — 레이아웃 2종(A: org_tree·dept_detail / B: list·menu_detail·user_roles)
  old_a text := $a$    select coalesce(array_agg(distinct t.dept_cd), '{}') into v_scope
      from erp_ro.v_dept_tree t
     where t.org_change_id = v_ver
       and exists (
             select 1
               from public.perm_grant g
               join erp_ro.v_dept_tree a
                 on a.org_change_id = t.org_change_id and a.dept_cd = any (t.path_cd)
              where lower(g.upn) = v_upn and g.revoked_at is null
                and g.scope_type = 'dept' and g.effect = 'allow'
                and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
                and btrim(g.scope_key) in (a.dept_cd, a.dept_nm)
           );$a$;
  new_a text := $a$    select coalesce(array_agg(distinct t.dept_cd), '{}') into v_scope
      from erp_ro.v_dept_tree t
     where t.org_change_id = v_ver
       and (public.erp_role_company_open()   -- REQ-0065: 전사 공개면 전 조직
            or exists (
             select 1
               from public.perm_grant g
               join erp_ro.v_dept_tree a
                 on a.org_change_id = t.org_change_id and a.dept_cd = any (t.path_cd)
              where lower(g.upn) = v_upn and g.revoked_at is null
                and g.scope_type = 'dept' and g.effect = 'allow'
                and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
                and btrim(g.scope_key) in (a.dept_cd, a.dept_nm)
           ));$a$;
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
  -- 1) 조직 트리 — 범위 + 배지(scope·visible_dept_cds) + can_write
  perform public.erp_role_gate_patch('public.erp_role_org_tree(text)'::regprocedure, old_a, new_a);
  perform public.erp_role_gate_patch('public.erp_role_org_tree(text)'::regprocedure,
    $o$    'is_admin', v_admin,$o$,
    $o$    'is_admin', v_admin,
    'can_write', public.erp_role_can_write(v_upn),$o$);
  perform public.erp_role_gate_patch('public.erp_role_org_tree(text)'::regprocedure,
    $o$    'scope', case when v_admin then 'all' else 'dept' end,$o$,
    $o$    'scope', case when v_admin or public.erp_role_company_open() then 'all' else 'dept' end,$o$);
  perform public.erp_role_gate_patch('public.erp_role_org_tree(text)'::regprocedure,
    $o$    'visible_dept_cds', case when v_admin then null else to_jsonb(v_scope) end,$o$,
    $o$    'visible_dept_cds', case when v_admin or public.erp_role_company_open() then null else to_jsonb(v_scope) end,$o$);

  -- 2) 부서 상세 — 범위 + 「소속 미확인」 + 타부서 차단 해제
  perform public.erp_role_gate_patch('public.erp_role_dept_detail(text,text,boolean,boolean)'::regprocedure, old_a, new_a);
  perform public.erp_role_gate_patch('public.erp_role_dept_detail(text,text,boolean,boolean)'::regprocedure,
    $o$    if v_unassigned then
      raise exception 'forbidden: 「소속 미확인」 계정은 관리자만 열람할 수 있습니다.' using errcode = '42501';
    end if;$o$,
    $o$    if v_unassigned and not public.erp_role_company_open() then
      raise exception 'forbidden: 「소속 미확인」 계정은 관리자만 열람할 수 있습니다.' using errcode = '42501';
    end if;$o$);
  perform public.erp_role_gate_patch('public.erp_role_dept_detail(text,text,boolean,boolean)'::regprocedure,
    $o$    if not (v_cd = any (coalesce(v_scope, '{}'))) then$o$,
    $o$    if not (v_unassigned or public.erp_role_company_open() or v_cd = any (coalesce(v_scope, '{}'))) then$o$);

  -- 3) 역할 목록 · 4) 역할 메뉴 상세
  perform public.erp_role_gate_patch('public.erp_role_list(text,text,text,text)'::regprocedure, old_b, new_b);
  perform public.erp_role_gate_patch('public.erp_role_menu_detail(text,text)'::regprocedure, old_b, new_b);

  -- 5) 사람 한 명의 권한 — 부서 일치 요구 해제
  perform public.erp_role_gate_patch('public.erp_user_roles(text,text)'::regprocedure, old_b, new_b);
  perform public.erp_role_gate_patch('public.erp_user_roles(text,text)'::regprocedure,
    $o$    if v_dept is null or not (v_dept = any (coalesce(v_scope, '{}'))) then$o$,
    $o$    if not public.erp_role_company_open()
       and (v_dept is null or not (v_dept = any (coalesce(v_scope, '{}')))) then$o$);

  -- 6) 전사 요약 — 관리자 전용 → 전사 공개 시 개방
  perform public.erp_role_gate_patch('public.erp_role_summary(text)'::regprocedure,
    $o$  if not v_admin then
    raise exception 'forbidden: 전사 요약은 관리자 전용입니다.' using errcode = '42501';
  end if;$o$,
    $o$  if not (v_admin or public.erp_role_company_open()) then
    raise exception 'forbidden: 전사 요약은 관리자 전용입니다.' using errcode = '42501';
  end if;$o$);
end $mig$;


comment on function public.erp_role_org_tree(text) is
  'ERP 권한 조직 트리 + 부서별 분류 집계. 개인 행을 내려주지 않는다(집계만). '
  '전사 공개인 동안에는 사내 사용자 전원이 전 조직을 본다(REQ-0065). '
  '쓰기 가능 여부는 can_write 로 내려준다 — 쓰기는 관리자/부서 부여자만.';


-- ─────────────────────────────────────────────────────────────────────────
-- §5. 검증 (적용 후 실행)
--   select public.erp_role_company_open();                 -- true 여야 한다
--   -- 비관리자 시뮬레이션
--   set local role authenticated;
--   set local request.jwt.claims = '{"email":"<사내계정>","app_metadata":{"role":"internal"}}';
--   select (public.erp_role_org_tree() -> 'scope');         -- "all"
--   select jsonb_array_length(public.erp_role_org_tree() -> 'nodes');
-- ─────────────────────────────────────────────────────────────────────────
