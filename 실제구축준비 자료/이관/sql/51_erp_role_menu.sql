-- ============================================================================
-- 51_erp_role_menu.sql — ERP 역할↔메뉴 권한 미러 + 권한별 조회 RPC
-- REQ-0057 후속 · 2026-09-18 · 화면 /work/erp-roles 의 「Matrix」·「권한별」 탭
--
-- 왜 필요한가
--   지금까지 미러에 있던 메뉴 정보는 `erp_ro.usr_erp_module_s`(모듈 약어 4종: SD/MM/IM/MDM)뿐이고,
--   실측상 전원이 전 모듈을 갖고 있어 변별력이 0이었다. "이 role 이 실제로 어떤 화면을 열 수 있는가"는
--   답할 수 없었다 — 그래서 role 을 눌러도 보여줄 상세가 없었다.
--   ERP 원천에는 역할↔메뉴가 그대로 있고(`Z_USR_ROLE_MNU_AUTHZTN_ASSO`), 기존 `usr_erp_module` job 이
--   이미 같은 테이블을 읽고 있다. 축약하지 말고 그대로 받아 온다.
--
-- 적재 경로 (10_ERP_DB연계/etl/etl_run.py)
--   menu_master : Z_FULL_MENU(LANG_CD='KO')                    → erp_ro.menu_master_s
--   role_menu   : Z_USR_ROLE_MNU_AUTHZTN_ASSO ⋈ Z_CO_MAST_MNU  → erp_ro.role_menu_s
--   둘 다 전량 스냅샷이며, 원천에서 사라진 행은 reconcile 로 표시한다(usr_role 선례).
--
-- 코드값 (참조 프로젝트 `SQL/조회용 쿼리/query_role_menu.sql` 에서 확인한 ERP 정의)
--   ACTION_ID : A=전체권한 · E=조회/엑셀 · Q=조회 · NULL/N=권한없음
--   MNU_TYPE  : M=메뉴 · P=Program(실제 화면)
--
-- 개인정보: 이 파일이 다루는 것은 역할·메뉴 메타데이터다. 사람 정보는 기존 뷰에서만 온다(§1.7).
-- 롤백: 51_erp_role_menu_rollback.sql
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────
-- §1. 메뉴 트리 마스터
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists erp_ro.menu_master_s (
  mnu_id       text not null,
  mnu_type     text not null,
  mnu_nm       text,
  upper_mnu_id text,
  mnu_seq      text,          -- 정수가 아니다 — 'A7' 같은 값이 섞여 있다(2026-09-18 적재 실패로 확인)
  sys_lvl      text,
  revoked_at   timestamptz,
  synced_at    timestamptz not null default now(),
  batch_id     uuid,
  primary key (mnu_id, mnu_type)
);

comment on table erp_ro.menu_master_s is
  'ERP 메뉴 트리(Z_FULL_MENU · LANG_CD=KO). upper_mnu_id 로 계층, mnu_seq 로 정렬. '
  'MNU_TYPE 은 M=메뉴 · P=Program(실제 화면).';

create index if not exists menu_master_s_upper_ix on erp_ro.menu_master_s (upper_mnu_id);


-- ─────────────────────────────────────────────────────────────────────────
-- §2. 역할별 메뉴 권한
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists erp_ro.role_menu_s (
  role_id         text not null,
  mnu_id          text not null,
  mnu_type        text not null,
  action_id       text,
  module_initial  text,
  revoked_at      timestamptz,
  synced_at       timestamptz not null default now(),
  batch_id        uuid,
  primary key (role_id, mnu_id, mnu_type)
);

comment on table erp_ro.role_menu_s is
  'ERP 역할별 메뉴 권한(Z_USR_ROLE_MNU_AUTHZTN_ASSO, MNU_USE_YN=Y 만). '
  'action_id: A=전체권한 · E=조회/엑셀 · Q=조회. 원천에서 사라지면 revoked_at 이 찍힌다.';

create index if not exists role_menu_s_role_ix on erp_ro.role_menu_s (role_id) where revoked_at is null;

alter table erp_ro.menu_master_s enable row level security;
alter table erp_ro.role_menu_s   enable row level security;
revoke all on erp_ro.menu_master_s, erp_ro.role_menu_s from anon, authenticated;
grant select, insert, update, delete on erp_ro.menu_master_s, erp_ro.role_menu_s to service_role;


-- ─────────────────────────────────────────────────────────────────────────
-- §3. 적재 RPC — erp_identity_upsert 에 분기 2개 추가
--     (34번 정의 + 50번의 revoked_at 보정을 그대로 유지하고 아래 두 분기만 더한다)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.erp_identity_upsert(p_table text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to ''
as $fn$
declare n integer := 0;
begin
  if p_table = 'hr_emp_s' then
    insert into erp_ro.hr_emp_s (emp_no, emp_nm, dept_cd, dept_nm, roll_pstn, email,
                                 entr_dt, retire_dt, entr_cd, grw_id,
                                 src_updated, synced_at, batch_id)
    select x.emp_no, x.emp_nm, x.dept_cd, x.dept_nm, x.roll_pstn, x.email,
           x.entr_dt, x.retire_dt, x.entr_cd, x.grw_id, x.src_updated, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(emp_no text, emp_nm text, dept_cd text, dept_nm text,
                                         roll_pstn text, email text, entr_dt date, retire_dt date,
                                         entr_cd text, grw_id text,
                                         src_updated timestamptz, batch_id uuid)
    on conflict (emp_no) do update
      set emp_nm = excluded.emp_nm, dept_cd = excluded.dept_cd, dept_nm = excluded.dept_nm,
          roll_pstn = excluded.roll_pstn, email = excluded.email,
          entr_dt = excluded.entr_dt, retire_dt = excluded.retire_dt,
          entr_cd = excluded.entr_cd, grw_id = excluded.grw_id,
          src_updated = excluded.src_updated, synced_at = excluded.synced_at,
          batch_id = excluded.batch_id;

  elsif p_table = 'usr_role_s' then
    insert into erp_ro.usr_role_s (email, role_id, role_nm, synced_at, batch_id)
    select lower(trim(x.email)), x.role_id, x.role_nm, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(email text, role_id text, role_nm text, batch_id uuid)
    on conflict (email, role_id) do update
      set role_nm = excluded.role_nm, synced_at = excluded.synced_at, batch_id = excluded.batch_id,
          revoked_at = null;

  elsif p_table = 'menu_master_s' then
    insert into erp_ro.menu_master_s (mnu_id, mnu_type, mnu_nm, upper_mnu_id, mnu_seq, sys_lvl,
                                      synced_at, batch_id)
    select btrim(x.mnu_id), btrim(x.mnu_type), x.mnu_nm, nullif(btrim(coalesce(x.upper_mnu_id,'')), ''),
           nullif(btrim(coalesce(x.mnu_seq,'')), ''), x.sys_lvl, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(mnu_id text, mnu_type text, mnu_nm text, upper_mnu_id text,
                                         mnu_seq text, sys_lvl text, batch_id uuid)
    on conflict (mnu_id, mnu_type) do update
      set mnu_nm = excluded.mnu_nm, upper_mnu_id = excluded.upper_mnu_id,
          mnu_seq = excluded.mnu_seq, sys_lvl = excluded.sys_lvl,
          synced_at = excluded.synced_at, batch_id = excluded.batch_id, revoked_at = null;

  elsif p_table = 'role_menu_s' then
    insert into erp_ro.role_menu_s (role_id, mnu_id, mnu_type, action_id, module_initial,
                                    synced_at, batch_id)
    select btrim(x.role_id), btrim(x.mnu_id), btrim(x.mnu_type),
           nullif(btrim(coalesce(x.action_id,'')), ''),
           nullif(btrim(coalesce(x.module_initial,'')), ''), now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(role_id text, mnu_id text, mnu_type text,
                                         action_id text, module_initial text, batch_id uuid)
    on conflict (role_id, mnu_id, mnu_type) do update
      set action_id = excluded.action_id, module_initial = excluded.module_initial,
          synced_at = excluded.synced_at, batch_id = excluded.batch_id, revoked_at = null;

  else
    raise exception '허용되지 않은 테이블: %', p_table;
  end if;
  get diagnostics n = row_count;
  return n;
end $fn$;


-- ─────────────────────────────────────────────────────────────────────────
-- §4. 정합 — 원천에서 사라진 행 표시 (usr_role 선례)
--     키가 수천~수만 건이라 배열 대신 **배치 워터마크**로 판별한다.
--     두 job 모두 전량 스냅샷이므로 "이번 배치가 안 덮은 행 = 원천에 없는 행" 이다.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.erp_menu_reconcile(p_table text, p_batch_id uuid, p_min_rows int default 100)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_seen int := 0; v_off int := 0;
begin
  if p_batch_id is null then
    raise exception 'batch_id 가 필요합니다 — 전건 회수 표시를 막기 위해 거부합니다';
  end if;

  if p_table = 'menu_master_s' then
    select count(*) into v_seen from erp_ro.menu_master_s where batch_id = p_batch_id;
    if v_seen < p_min_rows then
      raise exception '이번 배치가 덮은 행이 %건뿐입니다 — 부분 적재로 보여 거부합니다', v_seen;
    end if;
    update erp_ro.menu_master_s set revoked_at = now()
     where revoked_at is null and batch_id is distinct from p_batch_id;
    get diagnostics v_off = row_count;

  elsif p_table = 'role_menu_s' then
    select count(*) into v_seen from erp_ro.role_menu_s where batch_id = p_batch_id;
    if v_seen < p_min_rows then
      raise exception '이번 배치가 덮은 행이 %건뿐입니다 — 부분 적재로 보여 거부합니다', v_seen;
    end if;
    update erp_ro.role_menu_s set revoked_at = now()
     where revoked_at is null and batch_id is distinct from p_batch_id;
    get diagnostics v_off = row_count;

  else
    raise exception '허용되지 않은 테이블: %', p_table;
  end if;

  return jsonb_build_object('table', p_table, 'seen', v_seen, 'revoked', v_off);
end $fn$;


-- ─────────────────────────────────────────────────────────────────────────
-- §5. 메뉴 경로 뷰 — 트리를 매번 재귀로 풀지 않도록 한 번에 만든다
-- ─────────────────────────────────────────────────────────────────────────
create or replace view erp_ro.v_menu_path with (security_invoker = true) as
with recursive src as (
  select m.mnu_id, m.mnu_type, coalesce(m.mnu_nm, m.mnu_id) as mnu_nm,
         m.upper_mnu_id, coalesce(m.mnu_seq, '') as mnu_seq
    from erp_ro.menu_master_s m
   where m.revoked_at is null
), t as (
  select s.mnu_id, s.mnu_type, s.mnu_nm, s.upper_mnu_id, s.mnu_seq,
         0 as depth,
         s.mnu_nm                          as path_nm,
         array[s.mnu_id]::text[]           as path_id,
         lpad(s.mnu_seq, 6, '0')           as sort_key
    from src s
   where s.upper_mnu_id is null
      or s.upper_mnu_id = '*'
      or not exists (select 1 from src p where p.mnu_id = s.upper_mnu_id)
  union all
  select c.mnu_id, c.mnu_type, c.mnu_nm, c.upper_mnu_id, c.mnu_seq,
         t.depth + 1,
         t.path_nm || ' > ' || c.mnu_nm,
         t.path_id || c.mnu_id,
         t.sort_key || '/' || lpad(c.mnu_seq, 6, '0')
    from src c
    join t on t.mnu_id = c.upper_mnu_id
   where c.mnu_id <> all (t.path_id) and t.depth < 12
)
select mnu_id, mnu_type, mnu_nm, upper_mnu_id, depth, path_nm, sort_key from t;


-- ─────────────────────────────────────────────────────────────────────────
-- §6. 화면 RPC
-- ─────────────────────────────────────────────────────────────────────────

-- 6-1. 권한(Role) 목록 — 전사 기본, p_dept_cd 를 주면 그 부서 보유분만
create or replace function public.erp_role_list(
  p_dept_cd       text default null,
  p_org_change_id text default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_upn   text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  v_eff   jsonb; v_admin boolean; v_ver text; v_scope text[] := null;
  v_cd    text := nullif(btrim(coalesce(p_dept_cd, '')), '');
begin
  if not public.is_internal() then
    raise exception 'forbidden: 사내 계정만 조회할 수 있습니다.' using errcode = '42501';
  end if;
  if v_upn = '' then
    raise exception 'unauthorized: 로그인 세션이 필요합니다.' using errcode = '28000';
  end if;

  v_ver := coalesce(nullif(btrim(coalesce(p_org_change_id, '')), ''),
                    (select max(d.org_change_id) from erp_ro.dept_master_s d
                      where d.org_change_id ~ '^[0-9]+$'));

  v_eff   := public.perm_effective(v_upn);
  v_admin := coalesce((v_eff ->> 'is_admin')::boolean, false);
  if not v_admin then
    if not exists (
      select 1 from jsonb_array_elements(coalesce(v_eff -> 'pages', '[]'::jsonb)) e
       where e ->> 'page_key' = 'erp_role_matrix' and coalesce((e ->> 'allowed')::boolean, false)
    ) then
      raise exception 'forbidden: ERP 권한현황 열람 권한이 필요합니다.' using errcode = '42501';
    end if;
    -- 비관리자는 부여받은 부서 범위의 보유자만 센다(전사 명단을 넘기지 않는다)
    select coalesce(array_agg(distinct t.dept_cd), '{}') into v_scope
      from erp_ro.v_dept_tree t
     where t.org_change_id = v_ver
       and exists (
             select 1 from public.perm_grant g
               join erp_ro.v_dept_tree a
                 on a.org_change_id = t.org_change_id and a.dept_cd = any (t.path_cd)
              where lower(g.upn) = v_upn and g.revoked_at is null
                and g.scope_type = 'dept' and g.effect = 'allow'
                and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
                and btrim(g.scope_key) in (a.dept_cd, a.dept_nm));
    if coalesce(array_length(v_scope, 1), 0) = 0 then
      raise exception 'forbidden: 열람 가능한 조직이 지정되지 않았습니다.' using errcode = '42501';
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'org_change_id', v_ver,
    'is_admin', v_admin,
    'dept_cd', v_cd,
    'menu_as_of', (select max(synced_at) from erp_ro.role_menu_s),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object(
               'role_id', t.role_id, 'role_nm', t.role_nm,
               'module', t.role_module_key, 'module_label', t.module_label,
               'is_write', t.is_write, 'sensitive', t.sensitive,
               'user_cnt', t.user_cnt, 'menu_cnt', t.menu_cnt)
             order by t.role_nm)
        from (
          select p.role_id,
                 max(p.role_nm)                                   as role_nm,
                 max(p.role_module_key)                           as role_module_key,
                 max(mm.label)                                    as module_label,
                 bool_or(p.is_write)                              as is_write,
                 bool_or(coalesce(mm.sensitive, false))           as sensitive,
                 count(distinct m.email) filter (
                   where m.account_active
                     and (v_admin or m.dept_cd = any (coalesce(v_scope, '{}')))
                     and (v_cd is null or m.dept_cd = v_cd))::int as user_cnt,
                 (select count(*)::int from erp_ro.role_menu_s rm
                   where rm.role_id = p.role_id and rm.revoked_at is null) as menu_cnt
            from erp_ro.v_usr_role_parsed p
            left join public.erp_role_module_map mm on mm.role_module_key = p.role_module_key
            left join erp_ro.v_dept_member m on m.email = p.email and m.org_change_id = v_ver
           where p.revoked_at is null
           group by p.role_id
          having v_cd is null
              or count(distinct m.email) filter (
                   where m.account_active and m.dept_cd = v_cd) > 0
        ) t), '[]'::jsonb)
  );
end $fn$;

comment on function public.erp_role_list(text, text) is
  'ERP 역할 목록(사용자수·메뉴수). p_dept_cd 를 주면 그 부서가 보유한 역할만. '
  '비관리자는 부여받은 부서 범위의 보유자만 집계에 들어간다.';


-- 6-2. 역할 상세 — 메뉴 권한 트리 + 보유자
create or replace function public.erp_role_menu_detail(
  p_role_id       text,
  p_org_change_id text default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_upn   text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  v_eff   jsonb; v_admin boolean; v_ver text; v_scope text[] := null;
  v_rid   text := btrim(coalesce(p_role_id, ''));
begin
  if not public.is_internal() then
    raise exception 'forbidden: 사내 계정만 조회할 수 있습니다.' using errcode = '42501';
  end if;
  if v_upn = '' then
    raise exception 'unauthorized: 로그인 세션이 필요합니다.' using errcode = '28000';
  end if;
  if v_rid = '' then
    raise exception 'role_id 가 필요합니다.' using errcode = '22023';
  end if;

  v_ver := coalesce(nullif(btrim(coalesce(p_org_change_id, '')), ''),
                    (select max(d.org_change_id) from erp_ro.dept_master_s d
                      where d.org_change_id ~ '^[0-9]+$'));

  v_eff   := public.perm_effective(v_upn);
  v_admin := coalesce((v_eff ->> 'is_admin')::boolean, false);
  if not v_admin then
    if not exists (
      select 1 from jsonb_array_elements(coalesce(v_eff -> 'pages', '[]'::jsonb)) e
       where e ->> 'page_key' = 'erp_role_matrix' and coalesce((e ->> 'allowed')::boolean, false)
    ) then
      raise exception 'forbidden: ERP 권한현황 열람 권한이 필요합니다.' using errcode = '42501';
    end if;
    select coalesce(array_agg(distinct t.dept_cd), '{}') into v_scope
      from erp_ro.v_dept_tree t
     where t.org_change_id = v_ver
       and exists (
             select 1 from public.perm_grant g
               join erp_ro.v_dept_tree a
                 on a.org_change_id = t.org_change_id and a.dept_cd = any (t.path_cd)
              where lower(g.upn) = v_upn and g.revoked_at is null
                and g.scope_type = 'dept' and g.effect = 'allow'
                and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
                and btrim(g.scope_key) in (a.dept_cd, a.dept_nm));
    if coalesce(array_length(v_scope, 1), 0) = 0 then
      raise exception 'forbidden: 열람 가능한 조직이 지정되지 않았습니다.' using errcode = '42501';
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'role', (select jsonb_build_object('role_id', v_rid, 'role_nm', max(p.role_nm),
                                       'module_label', max(mm.label))
               from erp_ro.v_usr_role_parsed p
               left join public.erp_role_module_map mm on mm.role_module_key = p.role_module_key
              where p.role_id = v_rid),
    'menu_cnt', (select count(*)::int from erp_ro.role_menu_s where role_id = v_rid and revoked_at is null),
    'menus', coalesce((
      select jsonb_agg(jsonb_build_object(
               'mnu_id', x.mnu_id, 'mnu_nm', x.mnu_nm, 'path_nm', x.path_nm,
               'depth', x.depth, 'action_id', x.action_id, 'action_nm', x.action_nm,
               'module', x.module_initial) order by x.sort_key)
        from (select rm.mnu_id,
                     coalesce(mp.mnu_nm, rm.mnu_id)  as mnu_nm,
                     coalesce(mp.path_nm, rm.mnu_id) as path_nm,
                     coalesce(mp.depth, 0)           as depth,
                     coalesce(mp.sort_key, rm.mnu_id) as sort_key,
                     rm.action_id,
                     case rm.action_id when 'A' then '전체권한' when 'E' then '조회/엑셀'
                                       when 'Q' then '조회' else coalesce(rm.action_id, '권한없음') end as action_nm,
                     rm.module_initial
                from erp_ro.role_menu_s rm
                left join erp_ro.v_menu_path mp
                       on mp.mnu_id = rm.mnu_id and mp.mnu_type = rm.mnu_type
               where rm.role_id = v_rid and rm.revoked_at is null) x), '[]'::jsonb),
    'holders', coalesce((
      select jsonb_agg(jsonb_build_object('email', m.email, 'emp_nm', m.emp_nm,
                                          'dept_nm', m.dept_nm_raw, 'title', m.gw_title)
                       order by m.dept_nm_raw, m.emp_nm)
        from erp_ro.v_dept_member m
        join erp_ro.v_usr_role_parsed p on p.email = m.email and p.revoked_at is null
       where p.role_id = v_rid and m.org_change_id = v_ver and m.account_active
         and (v_admin or m.dept_cd = any (coalesce(v_scope, '{}')))), '[]'::jsonb)
  );
end $fn$;

comment on function public.erp_role_menu_detail(text, text) is
  '역할 하나의 메뉴 권한 트리 + 보유자. 메뉴는 전사 공통(메타데이터)이고 보유자만 열람 범위로 제한한다.';


-- ─────────────────────────────────────────────────────────────────────────
-- §7. 권한
-- ─────────────────────────────────────────────────────────────────────────
revoke all on erp_ro.v_menu_path from anon, authenticated;
grant select on erp_ro.v_menu_path to service_role;

revoke all on function public.erp_role_list(text, text) from public, anon;
grant execute on function public.erp_role_list(text, text) to authenticated, service_role;

revoke all on function public.erp_role_menu_detail(text, text) from public, anon;
grant execute on function public.erp_role_menu_detail(text, text) to authenticated, service_role;

revoke all on function public.erp_menu_reconcile(text, uuid, int) from public, anon, authenticated;
grant execute on function public.erp_menu_reconcile(text, uuid, int) to service_role;


-- ============================================================================
-- 검증
--   select count(*) from erp_ro.menu_master_s where revoked_at is null;
--   select count(*) from erp_ro.role_menu_s   where revoked_at is null;
--   select role_id, count(*) from erp_ro.role_menu_s where revoked_at is null group by 1 order by 2 desc limit 5;
--     (참조 프로젝트 실측: ACCT_S_A 1578 · ACCT_J_S 238 · ACCT_J_I 199 · SALE_I 122 · STOC_I 49)
--   select * from erp_ro.v_menu_path order by sort_key limit 20;
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────
-- §8. 화면 2차 개선 (관리자 지시 2026-09-18)
--   · 「소속 미확인」 → 「외부」 로 부른다. 외부 회계사·ERP 관리자 계정이라 '미확인'이 아니라 '외부'가 사실이다.
--   · 권한별 탭에서 보유자를 누르면 그 사람의 권한을 본다 → erp_user_roles
--   · 그룹웨어 겸직 보관 → public.gw_member_dept
--     ⚠ 실측 결과 현재 원천(GW_TABLE_NAME 이 가리키는 뷰)에는 겸직이 없다 — 474행 전부 1인 1행이고
--       gw_member_dept_replace 의 multi_dept 가 0 이다. 주소록 화면의 「(겸)」 은 다른 테이블에서 오며
--       우리 DB 계정은 그 뷰 하나만 볼 수 있다. 원천이 확장되면 이 표가 그대로 받는다.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.erp_role_dept_label(p_cd text)
returns text language sql immutable set search_path to '' as $fn$
  select case when p_cd = '__unassigned__' then '외부' else p_cd end;
$fn$;

create table if not exists public.gw_member_dept (
  id           bigint generated always as identity primary key,
  email        text not null,
  login_id     text,
  emp_nm       text,
  dept_nm      text,
  position_nm  text,
  status       text,
  collected_at timestamptz not null default now()
);
create index if not exists gw_member_dept_email_ix on public.gw_member_dept (lower(email));
comment on table public.gw_member_dept is
  '그룹웨어 조직 배치 전량(겸직 포함). 1인 1행인 acct_groupware 와 달리 같은 이메일이 여러 행일 수 있다. '
  '2026-09-18 실측 시점에는 원천에 겸직이 없어 474행 전부 1인 1행이다.';

alter table public.gw_member_dept enable row level security;
revoke all on public.gw_member_dept from anon, authenticated;
grant select, insert, update, delete on public.gw_member_dept to service_role;

-- 전량 교체(517행 규모라 한 번에 보낸다). delete 에 where true 를 붙이는 건 플랫폼 안전장치 때문이다.
create or replace function public.gw_member_dept_replace(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_n int := coalesce(jsonb_array_length(p_rows), 0); v_ins int := 0;
begin
  if v_n = 0 then
    raise exception '그룹웨어 배치 목록이 비어 있습니다 — 전건 삭제를 막기 위해 거부합니다';
  end if;
  if v_n < 100 then
    raise exception '배치가 %건뿐입니다 — 부분 추출로 보여 거부합니다(실측 정상치 500건대)', v_n;
  end if;

  delete from public.gw_member_dept where true;
  insert into public.gw_member_dept (email, login_id, emp_nm, dept_nm, position_nm, status, collected_at)
  select lower(btrim(x.email)), x.login_id, x.emp_nm, x.dept_nm, x.position_nm, x.status, now()
    from jsonb_to_recordset(p_rows) as x(email text, login_id text, emp_nm text,
                                         dept_nm text, position_nm text, status text);
  get diagnostics v_ins = row_count;
  return jsonb_build_object('received', v_n, 'inserted', v_ins,
    'multi_dept', (select count(*) from (
        select lower(email) e from public.gw_member_dept where status = '사용'
         group by 1 having count(distinct dept_nm) > 1) t));
end $fn$;

-- 사람 한 명의 ERP 권한. 보유자 목록은 이미 열람 범위로 걸러져 오지만, 이 RPC 도 스스로 다시 확인한다
-- (화면을 우회해 직접 불러도 남의 부서 사람을 열지 못하게).
create or replace function public.erp_user_roles(
  p_email         text,
  p_org_change_id text default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_upn   text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  v_eff   jsonb; v_admin boolean; v_ver text; v_scope text[] := null;
  v_em    text := lower(btrim(coalesce(p_email, '')));
  v_dept  text;
begin
  if not public.is_internal() then
    raise exception 'forbidden: 사내 계정만 조회할 수 있습니다.' using errcode = '42501';
  end if;
  if v_upn = '' then
    raise exception 'unauthorized: 로그인 세션이 필요합니다.' using errcode = '28000';
  end if;
  if v_em = '' then
    raise exception '계정이 필요합니다.' using errcode = '22023';
  end if;

  v_ver := coalesce(nullif(btrim(coalesce(p_org_change_id, '')), ''),
                    (select max(d.org_change_id) from erp_ro.dept_master_s d
                      where d.org_change_id ~ '^[0-9]+$'));

  v_eff   := public.perm_effective(v_upn);
  v_admin := coalesce((v_eff ->> 'is_admin')::boolean, false);
  if not v_admin then
    if not exists (
      select 1 from jsonb_array_elements(coalesce(v_eff -> 'pages', '[]'::jsonb)) e
       where e ->> 'page_key' = 'erp_role_matrix' and coalesce((e ->> 'allowed')::boolean, false)
    ) then
      raise exception 'forbidden: ERP 권한현황 열람 권한이 필요합니다.' using errcode = '42501';
    end if;
    select coalesce(array_agg(distinct t.dept_cd), '{}') into v_scope
      from erp_ro.v_dept_tree t
     where t.org_change_id = v_ver
       and exists (
             select 1 from public.perm_grant g
               join erp_ro.v_dept_tree a
                 on a.org_change_id = t.org_change_id and a.dept_cd = any (t.path_cd)
              where lower(g.upn) = v_upn and g.revoked_at is null
                and g.scope_type = 'dept' and g.effect = 'allow'
                and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
                and btrim(g.scope_key) in (a.dept_cd, a.dept_nm));
    select m.dept_cd into v_dept from erp_ro.v_dept_member m
     where m.email = v_em and m.org_change_id = v_ver limit 1;
    if v_dept is null or not (v_dept = any (coalesce(v_scope, '{}'))) then
      raise exception 'forbidden: 이 사용자를 열람할 권한이 없습니다.' using errcode = '42501';
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'user', (select jsonb_build_object('email', m.email, 'emp_nm', m.emp_nm,
                                       'dept_nm', coalesce(m.dept_nm_raw, '외부'),
                                       'title', m.gw_title,
                                       'account_active', m.account_active,
                                       'gw_active', m.gw_active,
                                       'external', (m.dept_cd is null))
               from erp_ro.v_dept_member m
              where m.email = v_em and m.org_change_id = v_ver limit 1),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object(
               'role_id', p.role_id, 'role_nm', p.role_nm, 'role_label', p.role_label,
               'module', p.role_module_key, 'module_label', mm.label,
               'is_write', p.is_write, 'sensitive', coalesce(mm.sensitive, false),
               'menu_cnt', (select count(*)::int from erp_ro.role_menu_s rm
                             where rm.role_id = p.role_id and rm.revoked_at is null))
             order by mm.sort, p.role_nm)
        from erp_ro.v_usr_role_parsed p
        left join public.erp_role_module_map mm on mm.role_module_key = p.role_module_key
       where p.email = v_em and p.revoked_at is null), '[]'::jsonb)
  );
end $fn$;

revoke all on function public.gw_member_dept_replace(jsonb) from public, anon, authenticated;
grant execute on function public.gw_member_dept_replace(jsonb) to service_role;
revoke all on function public.erp_user_roles(text, text) from public, anon;
grant execute on function public.erp_user_roles(text, text) to authenticated, service_role;
revoke all on function public.erp_role_dept_label(text) from public, anon;
grant execute on function public.erp_role_dept_label(text) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- §9. 메뉴명 해석 (2026-09-21 · 관리자 지적 "A5101M1_KO174 처럼 코드로 보인다")
--
--   role_menu_s 가 쓰는 메뉴 코드 2,455종 중 76종이 Z_FULL_MENU(메뉴 마스터)에 없다.
--   ※ 참조 자료 ERP전체권한현황(ERP 직접 내보내기)도 같은 코드를 그대로 보여준다 —
--     우리 미러가 빠뜨린 게 아니라 원천에 이름이 없는 것이다.
--
--   실측 내역
--     · 2,379종 — 마스터와 정확히 일치 (name_src='exact')
--     ·    49종 — '_KO174' · '_CKO174' 같은 **법인 변형 접미사**만 다르고
--                 기본 코드는 마스터에 있다 (name_src='variant')
--                 예) A5101M1_KO174 → A5101M1 = 결의전표등록
--     ·    27종 — 기본 코드조차 없어 이름을 만들 수 없다 (name_src='code')
--                 예) CEXRATE · H6011Q1_KO174 · HA112M1
--
--   변형분은 기본 메뉴의 이름을 빌려 쓰되 **화면에 변형 코드를 함께 띄운다**.
--   이름이 없는 27종은 코드 그대로 두고 「메뉴명 미등록」이라고 적는다 —
--   모르는 것을 아는 척하지 않는다.
--
--   ⚠ 진단 쿼리를 쓸 때 주의: 상관 서브쿼리 안에서 컬럼명을 한정하지 않으면
--     안쪽 테이블에 먼저 묶인다. 이 조사에서 실제로
--       exists (select 1 from menu_master_s m2 where btrim(m2.mnu_id) = regexp_replace(mnu_id, ...))
--     가 m2 자기 자신과 비교되어 "76종 중 73종 해석 가능"이라는 틀린 수를 냈다(실제 49종).
--     반드시 바깥 별칭을 붙일 것.
-- ─────────────────────────────────────────────────────────────────────────
create or replace view erp_ro.v_menu_name with (security_invoker = true) as
select rm.mnu_id,
       rm.mnu_type,
       coalesce(hit.mnu_nm,   rm.mnu_id)  as mnu_nm,
       coalesce(hit.path_nm,  rm.mnu_id)  as path_nm,
       coalesce(hit.depth,    0)          as depth,
       coalesce(hit.sort_key, rm.mnu_id)  as sort_key,
       case when hit.mnu_id is null              then 'code'
            when btrim(hit.mnu_id) = rm.mnu_id   then 'exact'
            else 'variant' end             as name_src,
       case when hit.mnu_id is not null and btrim(hit.mnu_id) <> rm.mnu_id
            then substring(rm.mnu_id from '_(C?KO[0-9]+)$') end as variant_cd
  from (select distinct btrim(mnu_id) as mnu_id, mnu_type from erp_ro.role_menu_s) rm
  left join lateral (
       select p.mnu_id, p.mnu_nm, p.path_nm, p.depth, p.sort_key
         from erp_ro.v_menu_path p
        where btrim(p.mnu_id) in (rm.mnu_id, regexp_replace(rm.mnu_id, '_C?KO[0-9]+$', ''))
        order by (btrim(p.mnu_id) = rm.mnu_id) desc,
                 (p.mnu_type = rm.mnu_type)    desc,
                 p.sort_key
        limit 1) hit on true;

revoke all on erp_ro.v_menu_name from anon, authenticated;
grant select on erp_ro.v_menu_name to service_role;

-- 적용처 (본문은 라이브 정의와 동일 — 마이그레이션
--   req0057_menu_name_resolve / req0057_menu_detail_use_menu_name /
--   req0057_role_list_menu_search_via_menu_name 참조)
--   · erp_role_menu_detail — menus[] 에 name_src·variant_cd 를 함께 내려보낸다
--   · erp_role_list        — 메뉴명 검색이 변형 코드까지 찾아낸다
--                            (변형만 가진 역할이 검색에서 빠지던 문제)

-- 검증
--   select name_src, count(*) from erp_ro.v_menu_name group by 1;   -- exact 2379 / variant 49 / code 27
--   select mnu_nm, name_src, variant_cd from erp_ro.v_menu_name where mnu_id = 'A5101M1_KO174';
--                                                                   -- 결의전표등록 / variant / KO174
