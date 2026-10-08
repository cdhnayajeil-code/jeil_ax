-- 102_portal_page_grp_rollback.sql — 102 되돌리기(REQ-0121)
-- 함수는 'grp' 한 칸만 뺀 69 정의로 되돌리고, 묶음 칸은 지운다(화면은 grp 가 없으면 dept_nm → 「전사 공통」으로 동작하므로 깨지지 않는다).
CREATE OR REPLACE FUNCTION public.perm_effective_v2(p_upn text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_upn   text := lower(btrim(coalesce(p_upn,'')));
  v_dept  text; v_emp text; v_dept_cd text;
  v_roles text[]; v_gdept text[]; v_amod text[]; v_dmod text[]; v_apage text[]; v_dpage text[]; v_aone text[];
  v_admin boolean; v_auditor boolean;
  v_cds text[]; v_paths text[]; v_depts text[]; v_deptadmin text[]; v_da_cds text[]; v_mods text[];
  v_tree jsonb; v_byname jsonb;
begin
  if v_upn = '' then raise exception 'perm_effective: upn이 필요합니다.' using errcode='22023'; end if;
  select coalesce(jsonb_object_agg(t.dept_cd, jsonb_build_object('nm', t.dept_nm, 'path', to_jsonb(t.path_cd))), '{}'::jsonb),
         coalesce(jsonb_object_agg(t.dept_nm, t.dept_cd), '{}'::jsonb)
    into v_tree, v_byname from erp_ro.v_dept_tree t where t.is_current;
  select dept_nm, emp_nm into v_dept, v_emp from public.v_erp_user_dept where lower(email) = v_upn;
  v_dept_cd := v_byname ->> btrim(coalesce(v_dept,''));
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

  select coalesce(array_agg(distinct c),'{}') into v_cds from (
    select v_dept_cd c
    union all
    select case when v_tree ? btrim(g) then btrim(g) else v_byname ->> btrim(g) end
      from unnest(coalesce(v_gdept,'{}')) g
  ) z where c is not null and c <> '';
  select coalesce(array_agg(distinct pc),'{}') into v_paths
    from unnest(v_cds) c cross join lateral jsonb_array_elements_text(v_tree -> c -> 'path') pc;
  select coalesce(array_agg(distinct d),'{}') into v_depts from (
    select v_tree -> c ->> 'nm' d from unnest(v_cds) c
    union all select v_dept where v_dept is not null and v_dept_cd is null
  ) z where d is not null and d <> '';
  select coalesce(array_agg(dept_nm),'{}'), coalesce(array_agg(v_byname ->> dept_nm) filter (where v_byname ? dept_nm),'{}')
    into v_deptadmin, v_da_cds from public.dept_permission where lower(dept_admin_email) = v_upn;

  if v_admin then
    select coalesce(array_agg(module_key order by sort),'{}') into v_mods from public.perm_module_catalog;
  else
    select coalesce(array_agg(distinct m),'{}') into v_mods from (
      select s.module_key m from public.dept_module_scope s
       where s.dept_cd = any(v_cds) or (s.include_sub and s.dept_cd = any(v_paths))
      union select unnest(coalesce(v_amod,'{}'))
    ) u where m is not null and m <> '' and not (m = any(coalesce(v_dmod,'{}')));
  end if;

  return jsonb_build_object(
    'upn', v_upn, 'emp_nm', v_emp, 'dept_nm', v_dept, 'dept_cd', v_dept_cd,
    'depts', to_jsonb(v_depts), 'dept_cds', to_jsonb(v_cds),
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
               'dept_nm', p.dept_nm, 'owner_dept_cd', p.owner_dept_cd, 'visibility', p.visibility, 'erp_module', p.erp_module,
               'allowed', x.allowed, 'reason', x.reason) order by p.sort)
      from public.portal_page p
      cross join lateral (
        select
          coalesce(p.owner_dept_cd = any(v_cds), false) as own,
          coalesce(p.owner_dept_cd = any(v_da_cds), false) as own_admin,
          (select s.dept_cd || case when s.dept_cd = any(v_cds) then '' else '+' end
             from public.portal_page_scope s
            where s.page_key = p.page_key and (s.dept_cd = any(v_cds) or (s.include_sub and s.dept_cd = any(v_paths)))
            order by (s.dept_cd = any(v_cds)) desc limit 1) as shared_by,
          coalesce(p.erp_module is null or p.erp_module = any(coalesce(v_mods,'{}')), false) as mod_ok
      ) f
      cross join lateral (
        select y.allowed,
          case
            when p.page_key = any(coalesce(v_dpage,'{}')) then '개인 차단(deny)'
            when v_admin then '전체 관리자'
            when y.allowed and p.page_key = any(coalesce(v_apage,'{}')) then '개인 예외 허용'
            when not y.allowed and p.erp_module is not null and not f.mod_ok
              then 'ERP 모듈 권한 없음(' || p.erp_module || ')'
            when y.allowed and p.visibility = '전사 공개' then '전사 공개'
            when y.allowed and f.own then '소속·겸직 부서'
            when y.allowed and f.own_admin then '부서 관리자'
            when y.allowed and right(f.shared_by,1) = '+' then '공유 부서(' ||
                 coalesce(v_tree -> rtrim(f.shared_by,'+') ->> 'nm', rtrim(f.shared_by,'+')) || ' 하위 포함)'
            when y.allowed then '공유 부서'
            else '부서 범위 밖' end as reason
        from (select
          case
            when p.page_key = any(coalesce(v_dpage,'{}')) then false
            when v_admin then true
            when p.page_key = any(coalesce(v_apage,'{}'))
              and not (p.erp_module is not null
                       and exists (select 1 from public.perm_module_catalog c where c.module_key = p.erp_module and c.sensitive)
                       and not f.mod_ok) then true
            when p.visibility = '전사 공개' then f.mod_ok
            when p.visibility = '부서 전용' then (f.own or f.own_admin) and f.mod_ok
            when p.visibility = '지정 부서 공유' then (f.own or f.own_admin or f.shared_by is not null) and f.mod_ok
            else false end as allowed) y
      ) x
      where p.active
    ), '[]'::jsonb),
    'onedrive', to_jsonb(coalesce(v_aone,'{}')),
    'as_of', now()
  );
end $function$;

alter table public.portal_page drop column if exists grp;
