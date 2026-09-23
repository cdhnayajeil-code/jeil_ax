-- ============================================================================
-- 69 · 권한 부서 키 = 부서코드(dept_cd) + 조직도 상속(하위 포함 선택형)   (REQ-0078 · ADR-107)
-- ----------------------------------------------------------------------------
-- 왜: 권한 설정의 부서가 「글자」였다. 공유 부서는 쉼표 텍스트, 판정은 부서명 완전일치라
--     오타·옛 부서명이 조용히 0명에게 적용되고 있었다(라이브 실측 유령 5종). 조직 계층도 쓸 수 없어
--     부서 27행이 같은 기본 5모듈을 반복 저장했다.
-- 무엇:
--   ① 현행 조직 뷰 v_perm_org_node(erp_ro.v_dept_tree 현행 org + 권한 대상 인원) — 관리 화면 전용
--   ② 이름→현행 코드 함수 perm_dept_cd_of(name)
--   ③ 새 표 portal_page_scope(페이지 공유 범위) · dept_module_scope(부서 ERP 모듈) + portal_page.owner_dept_cd
--      · 민감 모듈은 「하위 포함」 금지(트리거)
--   ④ 저장 RPC perm_page_scope_save · perm_dept_module_save — 서버 검증 + 감사 + 옛 컬럼 미러(롤백용)
--   ⑤ 미리보기 RPC perm_preview_page — 저장 전 「누가 보게 되나」를 판정과 같은 규칙으로
--   ⑥ 이관: 옛 이름 값 → 코드(유령은 관리자 결정대로 매핑, 영업팀은 삭제)
--   ⑦ perm_effective 교체 — 판정 규칙은 그대로, 부서 비교만 코드 + 하위 포함.
--      사용자 소속은 **기존과 같은 원천**(v_erp_user_dept.dept_nm)을 현행 코드로 바꿔 쓴다
--      → 같은 사람이 같은 부서로 잡힌다(판정 결과 동일성 — 교체 전 전원 대조로 확인).
-- 옛 컬럼(portal_page.dept_nm·shared_depts, dept_erp_scope)은 **남긴다**. 저장 RPC가 미러로 계속 써서
-- 롤백(69_rollback)만 하면 옛 판정이 그대로 돈다.
-- 함정: v_dept_tree 의 dept_cd 는 이미 btrim 되어 있다. 원천 char(10) 을 직접 볼 때는 btrim 필수.
-- ============================================================================

-- ① 현행 조직 노드 --------------------------------------------------------------
create or replace view public.v_perm_org_node as
with t as (
  select dept_cd, dept_nm, par_dept_cd, lvl, path_cd, path_nm, sort_key, has_child, org_change_id
    from erp_ro.v_dept_tree where is_current
), m as (   -- 권한 대상 인원 = 판정이 쓰는 원천(v_erp_user_dept)과 같은 기준
  select u.dept_nm, count(*)::int cnt from public.v_erp_user_dept u group by u.dept_nm
), h as (   -- 참고: 인사 재직 인원(코드 원천)
  select dept_cd, count(*) filter (where hr_active)::int cnt from erp_ro.v_dept_member where dept_cd is not null group by dept_cd
)
select t.dept_cd, t.dept_nm, t.par_dept_cd, t.lvl, t.path_cd, t.path_nm, t.sort_key, t.has_child, t.org_change_id,
       coalesce(m.cnt, 0) as member_cnt,
       coalesce(h.cnt, 0) as hr_cnt,
       -- 원가부서(공통예산·제조공통 …): 최상위 바로 아래 말단 + 사람 0 — 화면 기본 숨김용 표시
       (t.lvl = 2 and not t.has_child and coalesce(m.cnt,0) = 0 and coalesce(h.cnt,0) = 0) as is_cost
  from t left join m on m.dept_nm = t.dept_nm left join h on btrim(h.dept_cd) = t.dept_cd;
revoke all on public.v_perm_org_node from anon, authenticated;

-- ② 이름 → 현행 코드 ------------------------------------------------------------
create or replace function public.perm_dept_cd_of(p_name text)
returns text language sql stable security definer set search_path = '' as $$
  select t.dept_cd from erp_ro.v_dept_tree t
   where t.is_current and t.dept_nm = btrim(coalesce(p_name,'')) limit 1;
$$;
revoke all on function public.perm_dept_cd_of(text) from public, anon, authenticated;

-- ③ 새 표 ----------------------------------------------------------------------
alter table public.portal_page add column if not exists owner_dept_cd text;
comment on column public.portal_page.owner_dept_cd is '소유 부서 코드(현행 조직). dept_nm 은 표시·롤백용 미러 — 판정은 이 칸(ADR-107)';

create table if not exists public.portal_page_scope (
  page_key      text not null references public.portal_page(page_key) on delete cascade,
  dept_cd       text not null,
  include_sub   boolean not null default true,
  org_change_id text,
  updated_by    text,
  updated_at    timestamptz not null default now(),
  primary key (page_key, dept_cd)
);
comment on table public.portal_page_scope is '페이지 공유 범위 — 「지정 부서 공유」일 때만 판정에 쓰인다. include_sub=상위 조직 지정 시 하위 전부 포함(ADR-107)';

create table if not exists public.dept_module_scope (
  dept_cd       text not null,
  module_key    text not null references public.perm_module_catalog(module_key),
  include_sub   boolean not null default false,
  org_change_id text,
  updated_by    text,
  updated_at    timestamptz not null default now(),
  primary key (dept_cd, module_key)
);
comment on table public.dept_module_scope is '부서 ERP 모듈 — include_sub=하위 조직 상속. 민감 모듈은 상속 금지(트리거)';

create or replace function public.dept_module_scope_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.include_sub and exists (select 1 from public.perm_module_catalog c where c.module_key = new.module_key and c.sensitive) then
    raise exception '민감 모듈(%)은 하위 조직에 상속할 수 없습니다 — 부서마다 직접 지정하세요.', new.module_key using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists trg_dept_module_scope_guard on public.dept_module_scope;
create trigger trg_dept_module_scope_guard before insert or update on public.dept_module_scope
  for each row execute function public.dept_module_scope_guard();

alter table public.portal_page_scope enable row level security;
alter table public.dept_module_scope enable row level security;
drop policy if exists internal_select_portal_page_scope on public.portal_page_scope;
create policy internal_select_portal_page_scope on public.portal_page_scope for select to authenticated
  using ((select coalesce((auth.jwt() -> 'app_metadata') ->> 'role', '') = 'internal'));
drop policy if exists internal_select_dept_module_scope on public.dept_module_scope;
create policy internal_select_dept_module_scope on public.dept_module_scope for select to authenticated
  using ((select coalesce((auth.jwt() -> 'app_metadata') ->> 'role', '') = 'internal'));
revoke insert, update, delete on public.portal_page_scope, public.dept_module_scope from anon, authenticated;

-- ⑥ 이관 (옛 이름 → 코드) --------------------------------------------------------
--   유령 부서명은 관리자 결정(2026-09-23)대로: 회계·재무회계팀→재무팀(2100) · 내부회계팀→내부회계관리팀(2400)
--   · 헝가리지원팀→헝가리법인(9910) · 영업팀→삭제(매핑 없음).
create temp table _ghost(nm text primary key, cd text) on commit drop;
insert into _ghost values ('회계','2100'),('재무회계팀','2100'),('내부회계팀','2400'),('헝가리지원팀','9910'),('영업팀',null);

update public.portal_page p set owner_dept_cd = coalesce(public.perm_dept_cd_of(p.dept_nm), g.cd)
  from (select p2.page_key, g2.cd from public.portal_page p2 left join _ghost g2 on g2.nm = p2.dept_nm) g
 where g.page_key = p.page_key and p.owner_dept_cd is null and p.dept_nm is not null;

-- 공유 범위는 「지정 부서 공유」 페이지만 옮긴다 — 다른 공개범위에서는 지금도 판정에 안 쓰이는 값이다.
insert into public.portal_page_scope (page_key, dept_cd, include_sub, org_change_id, updated_by)
select distinct p.page_key, x.cd, false, (select max(org_change_id) from public.v_perm_org_node), 'migration-69'
  from public.portal_page p
  cross join lateral unnest(coalesce(p.shared_depts,'{}')) sd(nm)
  cross join lateral (select coalesce(public.perm_dept_cd_of(sd.nm), (select g.cd from _ghost g where g.nm = btrim(sd.nm))) cd) x
 where p.visibility = '지정 부서 공유' and x.cd is not null and x.cd is distinct from p.owner_dept_cd
on conflict do nothing;

insert into public.dept_module_scope (dept_cd, module_key, include_sub, org_change_id, updated_by)
select distinct x.cd, s.module_key, false, (select max(org_change_id) from public.v_perm_org_node), 'migration-69'
  from public.dept_erp_scope s
  cross join lateral (select coalesce(public.perm_dept_cd_of(s.dept_nm), (select g.cd from _ghost g where g.nm = btrim(s.dept_nm))) cd) x
 where x.cd is not null
on conflict do nothing;

-- ⑦ 판정 함수 — 규칙은 옛 함수와 같고, 부서 비교만 코드 + 하위 포함 --------------------
create or replace function public.perm_effective_v2(p_upn text)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare
  v_upn   text := lower(btrim(coalesce(p_upn,'')));
  v_dept  text; v_emp text; v_dept_cd text;
  v_roles text[]; v_gdept text[]; v_amod text[]; v_dmod text[]; v_apage text[]; v_dpage text[]; v_aone text[];
  v_admin boolean; v_auditor boolean;
  v_cds text[]; v_paths text[]; v_depts text[]; v_deptadmin text[]; v_da_cds text[]; v_mods text[];
  v_tree jsonb; v_byname jsonb;   -- 현행 조직을 호출당 한 번만 읽는다(재귀 뷰 ~4ms — 반복 조회하면 판정이 5배 느려졌다, 실측)
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

  -- 소속 코드 = 계정 부서(현행 코드) + 개인 예외 「부서 추가」(코드 또는 이름 — 이름은 현행 코드로)
  select coalesce(array_agg(distinct c),'{}') into v_cds from (
    select v_dept_cd c
    union all
    select case when v_tree ? btrim(g) then btrim(g) else v_byname ->> btrim(g) end
      from unnest(coalesce(v_gdept,'{}')) g
  ) z where c is not null and c <> '';
  -- 상위 경로(하위 포함 판정용) — 소속 부서들의 조상 전부(자기 포함)
  select coalesce(array_agg(distinct pc),'{}') into v_paths
    from unnest(v_cds) c cross join lateral jsonb_array_elements_text(v_tree -> c -> 'path') pc;
  -- 표시용 부서명(옛 응답 호환): 코드 이름 + 코드로 못 바꾼 원래 이름
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
          coalesce(p.owner_dept_cd = any(v_cds), false) as own,         -- null 이면 CASE 가 null(=허용 아님)을 내던 옛 함수와 같게 false 로
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
revoke all on function public.perm_effective_v2(text) from public, anon, authenticated;

-- ⑤ 미리보기 — 저장하지 않은 페이지 설정으로 「부서별로 볼 수 있나」 ------------------------
--   부서 단위 판정(개인 예외·전체 관리자는 제외 — 화면이 그 사실을 적는다). 규칙은 perm_effective 와 같다.
create or replace function public.perm_preview_page(p_page jsonb)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_owner text := nullif(btrim(coalesce(p_page->>'owner_dept_cd','')),'');
  v_vis   text := coalesce(p_page->>'visibility','부서 전용');
  v_mod   text := nullif(btrim(coalesce(p_page->>'erp_module','')),'');
  v_res   jsonb;
begin
  with sc as (
    select btrim(e->>'dept_cd') cd, coalesce((e->>'include_sub')::boolean, false) sub
      from jsonb_array_elements(coalesce(p_page->'scopes','[]'::jsonb)) e
  ), n as (select * from public.v_perm_org_node)
  , r as (
    select n.dept_cd, n.dept_nm, n.member_cnt, n.sort_key,
      case
        when v_vis = '전사 공개' then '전사 공개'
        when n.dept_cd = v_owner then '소유 부서'
        when v_vis = '지정 부서 공유' and exists (select 1 from sc where sc.cd = n.dept_cd) then '공유(직접)'
        when v_vis = '지정 부서 공유' then (select '공유 — ' || a.dept_nm || ' 하위 포함' from sc join n a on a.dept_cd = sc.cd
                                           where sc.sub and sc.cd = any(n.path_cd) order by a.lvl desc limit 1)
      end as why,
      (v_mod is null or exists (select 1 from public.dept_module_scope s
          where s.module_key = v_mod and (s.dept_cd = n.dept_cd or (s.include_sub and s.dept_cd = any(n.path_cd))))) as mod_ok
    from n
  )
  select jsonb_build_object(
    'depts', coalesce(jsonb_agg(jsonb_build_object('dept_cd',dept_cd,'dept_nm',dept_nm,'member_cnt',member_cnt,'why',why,'mod_ok',mod_ok) order by sort_key)
                      filter (where why is not null), '[]'::jsonb),
    'dept_cnt', count(*) filter (where why is not null and mod_ok),
    'member_cnt', coalesce(sum(member_cnt) filter (where why is not null and mod_ok), 0),
    'blocked_by_module', count(*) filter (where why is not null and not mod_ok),
    'sensitive', coalesce((select c.sensitive from public.perm_module_catalog c where c.module_key = v_mod), false)
  ) into v_res from r;
  return v_res;
end $$;
revoke all on function public.perm_preview_page(jsonb) from public, anon, authenticated;

-- ④ 저장 RPC — 페이지 1건 ----------------------------------------------------------
create or replace function public.perm_page_scope_save(p_actor text, p_page jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_key   text := btrim(coalesce(p_page->>'page_key',''));
  v_owner text := nullif(btrim(coalesce(p_page->>'owner_dept_cd','')),'');
  v_vis   text := coalesce(p_page->>'visibility','부서 전용');
  v_mod   text := nullif(btrim(coalesce(p_page->>'erp_module','')),'');
  v_act   boolean := coalesce((p_page->>'active')::boolean, true);
  v_reason text := nullif(btrim(coalesce(p_page->>'reason','')),'');
  v_org   text := (select max(org_change_id) from public.v_perm_org_node);
  v_before jsonb; v_after jsonb; v_bad text; v_sens boolean; v_n int;
begin
  if coalesce(btrim(p_actor),'') = '' then raise exception '저장자(actor)가 필요합니다.' using errcode='22023'; end if;
  if not exists (select 1 from public.portal_page where page_key = v_key) then raise exception '없는 페이지: %', v_key using errcode='22023'; end if;
  if v_vis not in ('부서 전용','전사 공개','지정 부서 공유') then raise exception '공개범위 값이 올바르지 않습니다: %', v_vis using errcode='22023'; end if;
  if v_owner is not null and not exists (select 1 from public.v_perm_org_node where dept_cd = v_owner) then
    raise exception '현행 조직에 없는 소유 부서 코드: %', v_owner using errcode='22023'; end if;
  if v_mod is not null and not exists (select 1 from public.perm_module_catalog where module_key = v_mod) then
    raise exception '없는 ERP 모듈: %', v_mod using errcode='22023'; end if;
  select count(*) into v_n from jsonb_array_elements(coalesce(p_page->'scopes','[]'::jsonb));
  if v_vis <> '지정 부서 공유' and v_n > 0 then
    raise exception '「%」에서는 공유 부서를 둘 수 없습니다 — 공유하려면 「지정 부서 공유」를 고르세요.', v_vis using errcode='22023'; end if;
  select string_agg(btrim(e->>'dept_cd'), ', ') into v_bad from jsonb_array_elements(coalesce(p_page->'scopes','[]'::jsonb)) e
   where not exists (select 1 from public.v_perm_org_node n where n.dept_cd = btrim(e->>'dept_cd'));
  if v_bad is not null then raise exception '현행 조직에 없는 공유 부서 코드: %', v_bad using errcode='22023'; end if;
  v_sens := coalesce((select sensitive from public.perm_module_catalog where module_key = v_mod), false);
  if v_sens and (v_vis = '전사 공개' or v_n > 0) and v_reason is null then
    raise exception '민감 모듈(%) 페이지를 공유·전사 공개할 때는 사유가 필요합니다.', v_mod using errcode='22023'; end if;

  select jsonb_build_object('owner_dept_cd', p.owner_dept_cd, 'visibility', p.visibility, 'erp_module', p.erp_module, 'active', p.active,
           'scopes', coalesce((select jsonb_agg(jsonb_build_object('dept_cd', s.dept_cd, 'include_sub', s.include_sub) order by s.dept_cd)
                                 from public.portal_page_scope s where s.page_key = p.page_key), '[]'::jsonb))
    into v_before from public.portal_page p where p.page_key = v_key;

  delete from public.portal_page_scope where page_key = v_key;
  insert into public.portal_page_scope (page_key, dept_cd, include_sub, org_change_id, updated_by)
  select v_key, btrim(e->>'dept_cd'), coalesce((e->>'include_sub')::boolean, false), v_org, p_actor
    from jsonb_array_elements(coalesce(p_page->'scopes','[]'::jsonb)) e
   where btrim(e->>'dept_cd') is distinct from v_owner
  on conflict (page_key, dept_cd) do update set include_sub = excluded.include_sub;

  update public.portal_page p set
    owner_dept_cd = v_owner,
    dept_nm       = (select dept_nm from public.v_perm_org_node where dept_cd = v_owner),   -- 표시·롤백 미러
    visibility    = v_vis,
    shared_depts  = coalesce((select array_agg(n.dept_nm order by n.sort_key) from public.portal_page_scope s
                                join public.v_perm_org_node n on n.dept_cd = s.dept_cd where s.page_key = v_key), '{}'),
    erp_module    = v_mod,
    active        = v_act,
    updated_by    = p_actor, updated_at = now()
  where p.page_key = v_key;

  select jsonb_build_object('owner_dept_cd', v_owner, 'visibility', v_vis, 'erp_module', v_mod, 'active', v_act,
           'scopes', coalesce((select jsonb_agg(jsonb_build_object('dept_cd', s.dept_cd, 'include_sub', s.include_sub) order by s.dept_cd)
                                 from public.portal_page_scope s where s.page_key = v_key), '[]'::jsonb))
    into v_after;
  insert into public.perm_audit (actor, action, target, detail)
  values (p_actor, 'page_scope', v_key, jsonb_build_object('before', v_before, 'after', v_after, 'reason', v_reason));
  return jsonb_build_object('ok', true, 'page_key', v_key, 'after', v_after);
end $$;
revoke all on function public.perm_page_scope_save(text, jsonb) from public, anon, authenticated;

-- ④ 저장 RPC — 부서 1건의 ERP 모듈 ---------------------------------------------------
create or replace function public.perm_dept_module_save(p_actor text, p_dept_cd text, p_rows jsonb, p_reason text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_cd  text := btrim(coalesce(p_dept_cd,''));
  v_nm  text;
  v_org text := (select max(org_change_id) from public.v_perm_org_node);
  v_before jsonb; v_after jsonb; v_bad text;
begin
  if coalesce(btrim(p_actor),'') = '' then raise exception '저장자(actor)가 필요합니다.' using errcode='22023'; end if;
  select dept_nm into v_nm from public.v_perm_org_node where dept_cd = v_cd;
  -- 현행 조직에 없는 코드는 「비우기」만 허용한다(개편으로 사라진 부서의 설정 정리용)
  if v_nm is null and jsonb_array_length(coalesce(p_rows,'[]'::jsonb)) > 0 then
    raise exception '현행 조직에 없는 부서 코드: %', v_cd using errcode='22023'; end if;
  select string_agg(e->>'module_key', ', ') into v_bad from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) e
   where not exists (select 1 from public.perm_module_catalog c where c.module_key = e->>'module_key');
  if v_bad is not null then raise exception '없는 ERP 모듈: %', v_bad using errcode='22023'; end if;
  -- 민감 모듈을 「새로」 주는 경우에만 사유 필수(이미 있던 민감 모듈을 유지하는 저장은 사유 없이 통과)
  if exists (select 1 from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) e join public.perm_module_catalog c on c.module_key = e->>'module_key'
              where c.sensitive
                and not exists (select 1 from public.dept_module_scope s where s.dept_cd = v_cd and s.module_key = c.module_key))
     and nullif(btrim(coalesce(p_reason,'')),'') is null then
    raise exception '민감 모듈을 새로 부여할 때는 사유가 필요합니다.' using errcode='22023'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('module_key', module_key, 'include_sub', include_sub) order by module_key), '[]'::jsonb)
    into v_before from public.dept_module_scope where dept_cd = v_cd;
  delete from public.dept_module_scope where dept_cd = v_cd;
  insert into public.dept_module_scope (dept_cd, module_key, include_sub, org_change_id, updated_by)
  select v_cd, e->>'module_key', coalesce((e->>'include_sub')::boolean, false), v_org, p_actor
    from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) e
  on conflict (dept_cd, module_key) do update set include_sub = excluded.include_sub;   -- 민감+하위포함은 트리거가 거부

  -- 옛 표 미러(롤백용): 이 부서 이름의 직접 지정만
  if v_nm is not null then
    delete from public.dept_erp_scope where dept_nm = v_nm;
    insert into public.dept_erp_scope (dept_nm, module_key, updated_by, updated_at)
    select v_nm, module_key, p_actor, now() from public.dept_module_scope where dept_cd = v_cd;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('module_key', module_key, 'include_sub', include_sub) order by module_key), '[]'::jsonb)
    into v_after from public.dept_module_scope where dept_cd = v_cd;
  insert into public.perm_audit (actor, action, target, detail)
  values (p_actor, 'dept_module', v_cd, jsonb_build_object('dept_nm', v_nm, 'before', v_before, 'after', v_after, 'reason', nullif(btrim(coalesce(p_reason,'')),'')));
  return jsonb_build_object('ok', true, 'dept_cd', v_cd, 'after', v_after);
end $$;
revoke all on function public.perm_dept_module_save(text, text, jsonb, text) from public, anon, authenticated;

-- ⑦-2 교체 — 전원 대조 통과 뒤 실행(2026-09-23 실측: 99명 · 모듈·허용 페이지·부서·역할 차이 0).
--   판정 본문은 perm_effective_v2 한 곳에 두고, 모든 게이트가 부르는 perm_effective 는 위임만 한다
--   (이름·권한(service_role 전용)이 그대로라 jeil-me·jeil-chat·jeil-hr·jeil-gl-draft·jeil-portal-request·
--    erp_finance_overview 무수정). 되돌리기: 69_perm_org_scope_rollback.sql
create or replace function public.perm_effective(p_upn text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select public.perm_effective_v2(p_upn);
$$;

-- ⑧ 69b(2026-09-23 핫픽스) — 권한 화면이 「조직 정보를 불러오지 못했습니다 — permission denied for view v_hr_by_email」.
--   Edge Function 은 service_role 로 v_perm_org_node 를 읽는데, 안쪽 erp_ro.v_dept_tree·v_dept_member·v_hr_by_email 이
--   security_invoker 라 호출자(service_role) 권한으로 검사되고 service_role 에는 erp_ro 권한이 없다.
--   적용 전 시험을 postgres 로만 돌려 못 잡았다 → **권한 경계 시험은 실제 호출 역할(set local role service_role)로 한다.**
--   erp_ro 권한을 넓히지 않고, 본문을 SECURITY DEFINER 함수로 옮겨 뷰는 그 함수를 읽기만 한다.
create or replace function public.perm_org_nodes()
returns table (dept_cd text, dept_nm text, par_dept_cd text, lvl int, path_cd text[], path_nm text, sort_key text,
               has_child boolean, org_change_id text, member_cnt int, hr_cnt int, is_cost boolean)
language sql stable security definer set search_path = '' as $$
  with t as (
    select v.dept_cd, v.dept_nm, v.par_dept_cd, v.lvl, v.path_cd, v.path_nm, v.sort_key, v.has_child, v.org_change_id
      from erp_ro.v_dept_tree v where v.is_current
  ), m as (
    select u.dept_nm, count(*)::int cnt from public.v_erp_user_dept u group by u.dept_nm
  ), h as (
    select d.dept_cd, count(*) filter (where d.hr_active)::int cnt from erp_ro.v_dept_member d where d.dept_cd is not null group by d.dept_cd
  )
  select t.dept_cd, t.dept_nm, t.par_dept_cd, t.lvl, t.path_cd, t.path_nm, t.sort_key, t.has_child, t.org_change_id,
         coalesce(m.cnt, 0), coalesce(h.cnt, 0),
         (t.lvl = 2 and not t.has_child and coalesce(m.cnt,0) = 0 and coalesce(h.cnt,0) = 0)
    from t left join m on m.dept_nm = t.dept_nm left join h on btrim(h.dept_cd) = t.dept_cd;
$$;
revoke all on function public.perm_org_nodes() from public, anon, authenticated;
grant execute on function public.perm_org_nodes() to service_role;

create or replace view public.v_perm_org_node as
  select dept_cd, dept_nm, par_dept_cd, lvl, path_cd, path_nm, sort_key, has_child, org_change_id, member_cnt, hr_cnt, is_cost
    from public.perm_org_nodes();
revoke all on public.v_perm_org_node from anon, authenticated;
grant select on public.v_perm_org_node to service_role;
