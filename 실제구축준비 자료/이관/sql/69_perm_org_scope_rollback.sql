-- ============================================================================
-- 69 롤백 · 권한 판정을 부서명(옛 방식)으로 되돌린다   (REQ-0078)
-- ----------------------------------------------------------------------------
-- 저장 RPC(perm_page_scope_save · perm_dept_module_save)가 옛 컬럼(portal_page.dept_nm·shared_depts,
-- dept_erp_scope)에 미러를 계속 써 왔으므로, 판정 함수만 되돌리면 마지막 저장 상태가 그대로 옛 판정에 쓰인다.
-- 단 두 가지는 옛 방식으로 표현할 수 없어 **사라진다** — 되돌리기 전에 화면에서 확인할 것:
--   · 「하위 포함」 공유·모듈 상속(옛 판정에는 하위 개념이 없다 — 직접 지정한 부서만 남는다)
--   · 상속으로만 받던 모듈(dept_erp_scope 미러는 그 부서에 직접 지정한 것만 가진다)
-- 순서: ① 옛 판정 함수 복원  ② (선택) 새 객체 삭제 — 새 화면(/admin/permissions v2)도 함께 되돌려야 한다.
-- ============================================================================

-- ① 옛 판정 함수(2026-09-23 교체 직전 라이브 정의 그대로)
CREATE OR REPLACE FUNCTION public.perm_effective(p_upn text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_upn   text := lower(btrim(coalesce(p_upn,'')));
  v_dept  text; v_emp text;
  v_roles text[]; v_gdept text[]; v_amod text[]; v_dmod text[]; v_apage text[]; v_dpage text[]; v_aone text[];
  v_admin boolean; v_auditor boolean;
  v_depts text[]; v_deptadmin text[]; v_mods text[];
begin
  if v_upn = '' then raise exception 'perm_effective: upn이 필요합니다.' using errcode='22023'; end if;
  select dept_nm, emp_nm into v_dept, v_emp from public.v_erp_user_dept where lower(email) = v_upn;
  select
    coalesce(array_agg(scope_key) filter (where scope_type='role'       and effect='allow'),'{}'),
    coalesce(array_agg(scope_key) filter (where scope_type='dept'       and effect='allow'),'{}'),
    coalesce(array_agg(scope_key) filter (where scope_type='erp_module' and effect='allow'),'{}'),
    coalesce(array_agg(scope_key) filter (where scope_type='erp_module' and effect='deny' ),'{}'),
    coalesce(array_agg(scope_key) filter (where scope_type='page'       and effect='allow'),'{}'),
    coalesce(array_agg(scope_key) filter (where scope_type='page'       and effect='deny' ),'{}'),
    coalesce(array_agg(scope_key) filter (where scope_type='onedrive'   and effect='allow'),'{}')
  into v_roles, v_gdept, v_amod, v_dmod, v_apage, v_dpage, v_aone
  from public.perm_grant
  where lower(upn) = v_upn and revoked_at is null
    and valid_from <= now() and (valid_to is null or valid_to > now());

  v_admin   := exists (select 1 from public.portal_admin where lower(email) = v_upn) or ('admin' = any(v_roles));
  v_auditor := 'auditor' = any(v_roles);
  v_depts := (select coalesce(array_agg(distinct d),'{}') from unnest(coalesce(v_gdept,'{}') || case when v_dept is null then '{}'::text[] else array[v_dept] end) d where d is not null and d <> '');
  select coalesce(array_agg(dept_nm),'{}') into v_deptadmin from public.dept_permission where lower(dept_admin_email) = v_upn;

  if v_admin then
    select coalesce(array_agg(module_key order by sort),'{}') into v_mods from public.perm_module_catalog;
  else
    select coalesce(array_agg(distinct m),'{}') into v_mods from (
      select s.module_key m from public.dept_erp_scope s where s.dept_nm = any(v_depts)
      union select unnest(coalesce(v_amod,'{}'))
    ) u where m is not null and m <> '' and not (m = any(coalesce(v_dmod,'{}')));
  end if;

  return jsonb_build_object(
    'upn', v_upn, 'emp_nm', v_emp, 'dept_nm', v_dept, 'depts', to_jsonb(v_depts),
    'is_admin', v_admin, 'is_auditor', v_auditor,
    'role', case when v_admin then 'admin' when array_length(v_deptadmin,1) > 0 then 'dept_admin' else 'user' end,
    'dept_admin_of', to_jsonb(v_deptadmin),
    'erp_modules', to_jsonb(v_mods),
    'grants', coalesce((
      select jsonb_agg(jsonb_build_object('id',id,'scope_type',scope_type,'scope_key',scope_key,'effect',effect,
                                          'valid_to',valid_to,'reason',reason,'granted_by',granted_by,'granted_at',granted_at)
                       order by scope_type, scope_key)
      from public.perm_grant
      where lower(upn) = v_upn and revoked_at is null and valid_from <= now() and (valid_to is null or valid_to > now())
    ), '[]'::jsonb),
    'pages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'page_key', p.page_key, 'title', p.title, 'path', p.path, 'icon', p.icon,
               'dept_nm', p.dept_nm, 'visibility', p.visibility, 'erp_module', p.erp_module,
               'allowed', x.allowed, 'reason', x.reason) order by p.sort)
      from public.portal_page p
      cross join lateral (
        select y.allowed,
          case
            when p.page_key = any(coalesce(v_dpage,'{}')) then '개인 차단(deny)'
            when v_admin then '전체 관리자'
            when y.allowed and p.page_key = any(coalesce(v_apage,'{}')) then '개인 예외 허용'
            when not y.allowed and p.erp_module is not null and not (p.erp_module = any(coalesce(v_mods,'{}')))
              then 'ERP 모듈 권한 없음(' || p.erp_module || ')'
            when y.allowed and p.visibility = '전사 공개' then '전사 공개'
            when y.allowed and p.dept_nm = any(v_depts) then '소속·겸직 부서'
            when y.allowed and p.dept_nm = any(v_deptadmin) then '부서 관리자'
            when y.allowed then '공유 부서'
            else '부서 범위 밖' end as reason
        from (select
          case
            when p.page_key = any(coalesce(v_dpage,'{}')) then false
            when v_admin then true
            when p.page_key = any(coalesce(v_apage,'{}'))
              and not (p.erp_module is not null
                       and exists (select 1 from public.perm_module_catalog c where c.module_key = p.erp_module and c.sensitive)
                       and not (p.erp_module = any(coalesce(v_mods,'{}')))) then true
            when p.visibility = '전사 공개' then coalesce(p.erp_module is null or p.erp_module = any(coalesce(v_mods,'{}')), false)
            when p.visibility = '부서 전용' then (p.dept_nm = any(v_depts) or p.dept_nm = any(v_deptadmin))
                 and coalesce(p.erp_module is null or p.erp_module = any(coalesce(v_mods,'{}')), false)
            when p.visibility = '지정 부서 공유' then (p.dept_nm = any(v_depts) or p.dept_nm = any(v_deptadmin)
                 or exists (select 1 from unnest(p.shared_depts) sd where sd = any(v_depts)))
                 and coalesce(p.erp_module is null or p.erp_module = any(coalesce(v_mods,'{}')), false)
            else false end as allowed) y
      ) x
      where p.active
    ), '[]'::jsonb),
    'onedrive', to_jsonb(coalesce(v_aone,'{}')),
    'as_of', now()
  );
end $function$;

-- ② (선택) 새 객체 삭제 — 판정만 되돌리고 데이터를 남겨 두려면 이 절은 실행하지 않는다.
-- drop function if exists public.perm_effective_v2(text);
-- drop function if exists public.perm_preview_page(jsonb);
-- drop function if exists public.perm_page_scope_save(text, jsonb);
-- drop function if exists public.perm_dept_module_save(text, text, jsonb, text);
-- drop table if exists public.portal_page_scope;
-- drop table if exists public.dept_module_scope;
-- drop function if exists public.dept_module_scope_guard();
-- drop view if exists public.v_perm_org_node;
-- drop function if exists public.perm_dept_cd_of(text);
-- alter table public.portal_page drop column if exists owner_dept_cd;
