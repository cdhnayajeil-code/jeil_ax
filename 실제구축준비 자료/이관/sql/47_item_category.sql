-- ============================================================================
-- 47_item_category.sql — 품목분류 4개 카테고리(품목계정 + 대·중·소분류) 반영 (2026-09-11 · REQ-0044)
--
-- 관리자 지시: "품목분류 4개 카테고리 적용해서 ERP 테이블 반영하여 표현 적용정리" → 확인 결과
--   4개 = **품목계정(B_ITEM.ITEM_ACCT) + 품목그룹 대·중·소(B_ITEM_GROUP 3단)**. 표현은 품목중복 조회·자재 상위 품목.
--
-- 실측(2026-09-11)
--   · 품목그룹은 3단(레벨 0 대분류 53 · 1 중분류 382 · 2 소분류 1,953)이고 품목 59,264건 전부 소분류에 매달림.
--     레벨 0·1 에도 leaf 가 7개 있어(대분류가 곧 잎) 경로 뷰는 잎의 레벨에 따라 대/중/소를 채운다.
--   · 품목계정은 10·20·30·33·35·F0 6값. 이름 원천이 ERP 사전에 보이지 않아(40번 조사) 두 갈래를 둔다:
--       ① ERP 사용자정의 코드표(B_USER_DEFINED_MAJOR 24 · MINOR 703)를 미러(erp_ro.ud_code_s)로 받아 찾아본다.
--       ② 못 찾으면 관리자 매핑표 public.item_acct_name 에 이름을 적는다(화면은 이 표를 우선 본다).
--     → 어느 쪽이든 「추측해 이름을 붙이지 않는다」(40번 원칙). 이름이 없으면 코드 그대로 보인다.
--
-- 바꾸는 것
--   1) erp_ro.ud_code_s 미러 + erp_master_upsert 분기 + 연동 현황 등재(ETL job `ud_code`)
--   2) public.item_acct_name 매핑표(관리자 편집) + public.v_item_acct(ud_code 자동 탐색 ∪ 매핑표)
--   3) public.v_erp_item_group_path — 잎 그룹코드 → 대/중/소 코드·이름
--   4) public.v_erp_item 에 4카테고리 컬럼 추가(끝에 덧붙여 create or replace 가능)
--   5) public.item_dup_search 반환에 4카테고리 추가 + 계정/대분류 필터 인자 2개 (반환 형이 바뀌어 drop 후 재생성, 권한 재부여)
-- 권한: 42번 규칙(service_role 전용 함수는 from public 포함 회수). 조회 뷰는 security_invoker + RLS internal.
-- ============================================================================

-- 1) 사용자정의 코드표 미러 — 코드 사전 전반에 쓸 수 있는 소형 표(727행)
create table if not exists erp_ro.ud_code_s (
  ud_major_cd  text not null,        -- 코드 그룹(major)
  ud_major_nm  text,
  ud_minor_cd  text not null,        -- 코드(minor)
  ud_minor_nm  text,
  ud_reference text,
  src_updated  timestamptz,          -- 원천에 갱신일 컬럼이 없어 null
  synced_at    timestamptz not null default now(),
  batch_id     uuid,
  primary key (ud_major_cd, ud_minor_cd)
);
comment on table erp_ro.ud_code_s is
  'ERP 사용자정의 코드표 미러(B_USER_DEFINED_MAJOR ⋈ MINOR) — 코드값에 이름을 붙일 때 첫 번째로 뒤지는 사전. 47번(REQ-0044).';
alter table erp_ro.ud_code_s enable row level security;
revoke all on erp_ro.ud_code_s from anon, authenticated;
grant select on erp_ro.ud_code_s to authenticated, service_role;
drop policy if exists internal_select_ud_code_s on erp_ro.ud_code_s;
create policy internal_select_ud_code_s on erp_ro.ud_code_s
  for select to authenticated
  using (coalesce(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) = 'internal'::text);
create or replace view public.v_erp_ud_code with (security_invoker = true) as
  select ud_major_cd, ud_major_nm, ud_minor_cd, ud_minor_nm, ud_reference, synced_at from erp_ro.ud_code_s;
grant select on public.v_erp_ud_code to authenticated, service_role;

-- erp_master_upsert 에 ud_code_s 분기 — 40번과 같은 방식(현재 정의를 읽어 마지막 else 앞에 끼워 넣는다)
do $mig$
declare src text; needle text; branch text;
begin
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'erp_master_upsert';
  if src is null then raise exception 'erp_master_upsert 를 찾지 못했습니다'; end if;
  if position('ud_code_s' in src) > 0 then raise notice '이미 등재됨'; return; end if;
  needle := '  else' || chr(10) || '    raise exception ''허용되지 않은 테이블: %'', p_table;';
  if position(needle in src) = 0 then raise exception 'erp_master_upsert 의 마지막 else 를 찾지 못했습니다'; end if;
  branch := $branch$  elsif p_table = 'ud_code_s' then
    insert into erp_ro.ud_code_s (ud_major_cd, ud_major_nm, ud_minor_cd, ud_minor_nm, ud_reference, src_updated, synced_at, batch_id)
    select x.ud_major_cd, x.ud_major_nm, x.ud_minor_cd, x.ud_minor_nm, x.ud_reference, x.src_updated, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(ud_major_cd text, ud_major_nm text, ud_minor_cd text, ud_minor_nm text,
                                         ud_reference text, src_updated timestamptz, batch_id uuid)
    on conflict (ud_major_cd, ud_minor_cd) do update
      set ud_major_nm = excluded.ud_major_nm, ud_minor_nm = excluded.ud_minor_nm, ud_reference = excluded.ud_reference,
          synced_at = excluded.synced_at, src_updated = excluded.src_updated, batch_id = excluded.batch_id;
$branch$;
  execute replace(src, needle, branch || needle);
end $mig$;

-- 연동 현황 뷰 등재(18→19종)
do $sync$
declare body text; addon text;
begin
  select pg_get_viewdef('public.v_erp_sync_overview'::regclass, true) into body;
  if position('''ud_code''' in body) > 0 then raise notice '이미 등재됨'; return; end if;
  body := rtrim(body);
  if right(body, 1) = ';' then body := left(body, length(body) - 1); end if;
  addon := $add$
UNION ALL
 SELECT 'ud_code'::text AS source_key, '사용자정의 코드표'::text AS source_label,
    'B_USER_DEFINED_MAJOR/MINOR'::text AS erp_src,
    ( SELECT last_ok.finished_at FROM last_ok WHERE last_ok.job_name = 'ud_code'::text) AS last_sync,
    ( SELECT count(*) AS count FROM erp_ro.ud_code_s) AS row_count,
    NULL::text AS period_min, NULL::text AS period_max, false AS sensitive, 32 AS sort$add$;
  execute 'create or replace view public.v_erp_sync_overview with (security_invoker = true) as ' || body || addon;
end $sync$;

-- 2) 품목계정 이름 — 관리자 매핑표(우선) ∪ 사용자정의 코드표 자동 탐색(보조)
create table if not exists public.item_acct_name (
  item_acct    text primary key,      -- B_ITEM.ITEM_ACCT (10·20·30·33·35·F0 …)
  item_acct_nm text not null,
  sort         integer not null default 100,
  note         text,
  updated_by   text,
  updated_at   timestamptz not null default now()
);
comment on table public.item_acct_name is
  '품목계정(ITEM_ACCT) 코드명 — ERP 에 이름 표가 없어 관리자가 적는 매핑표. 비어 있으면 화면은 코드를 그대로 보여 준다(추측 금지). 47번(REQ-0044).';
alter table public.item_acct_name enable row level security;
revoke all on public.item_acct_name from anon, authenticated;
grant select on public.item_acct_name to authenticated, service_role;
drop policy if exists internal_select_item_acct_name on public.item_acct_name;
create policy internal_select_item_acct_name on public.item_acct_name
  for select to authenticated
  using (coalesce(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) = 'internal'::text);

-- 품목계정 코드 → 이름. 매핑표가 있으면 그것, 없으면 ud_code 에서 "품목계정" 이라는 major 를 찾아 쓴다(있을 때만).
create or replace view public.v_item_acct with (security_invoker = true) as
  with used as (select distinct item_class as item_acct from erp_ro.item_master_s where item_class is not null),
  ud as (
    select u.ud_minor_cd as item_acct, u.ud_minor_nm as item_acct_nm
    from erp_ro.ud_code_s u
    where u.ud_major_nm ~ '품목\s*계정' or u.ud_major_cd ~* 'ITEM_?ACCT'
  )
  select used.item_acct,
         coalesce(m.item_acct_nm, ud.item_acct_nm) as item_acct_nm,
         case when m.item_acct is not null then 'manual' when ud.item_acct is not null then 'ud_code' else null end as name_src,
         coalesce(m.sort, 100) as sort
  from used
  left join public.item_acct_name m on m.item_acct = used.item_acct
  left join ud on ud.item_acct = used.item_acct;
grant select on public.v_item_acct to authenticated, service_role;

-- 3) 품목그룹 경로 — 잎 그룹코드 하나로 대/중/소를 한 줄에
create or replace view public.v_erp_item_group_path with (security_invoker = true) as
  select leaf.item_group_cd,
         case leaf.group_level when 0 then leaf.item_group_cd when 1 then p1.item_group_cd else p2.item_group_cd end as grp1_cd,
         case leaf.group_level when 0 then leaf.item_group_nm when 1 then p1.item_group_nm else p2.item_group_nm end as grp1_nm,
         case leaf.group_level when 0 then null when 1 then leaf.item_group_cd else p1.item_group_cd end as grp2_cd,
         case leaf.group_level when 0 then null when 1 then leaf.item_group_nm else p1.item_group_nm end as grp2_nm,
         case leaf.group_level when 2 then leaf.item_group_cd else null end as grp3_cd,
         case leaf.group_level when 2 then leaf.item_group_nm else null end as grp3_nm,
         leaf.group_level
  from erp_ro.item_group_s leaf
  left join erp_ro.item_group_s p1 on p1.item_group_cd = leaf.upper_group_cd
  left join erp_ro.item_group_s p2 on p2.item_group_cd = p1.upper_group_cd;
comment on view public.v_erp_item_group_path is '품목그룹(3단) 경로 — 잎 코드 → 대분류(grp1)·중분류(grp2)·소분류(grp3). 잎이 상위 레벨이면 아래 칸은 비운다. 47번.';
grant select on public.v_erp_item_group_path to authenticated, service_role;

-- 4) v_erp_item — 4카테고리 컬럼을 끝에 덧붙인다(기존 컬럼 순서 유지 → create or replace 가능)
create or replace view public.v_erp_item with (security_invoker = true) as
  select i.item_code, i.item_name, i.spec, i.unit, i.item_class,
         i.item_group_cd, g.item_group_nm, i.use_yn, i.synced_at,
         a.item_acct_nm,
         gp.grp1_cd, gp.grp1_nm, gp.grp2_cd, gp.grp2_nm, gp.grp3_cd, gp.grp3_nm
  from erp_ro.item_master_s i
  left join erp_ro.item_group_s g on g.item_group_cd = i.item_group_cd
  left join public.v_erp_item_group_path gp on gp.item_group_cd = i.item_group_cd
  left join public.v_item_acct a on a.item_acct = i.item_class;
grant select on public.v_erp_item to anon, authenticated, service_role;

-- 5) item_dup_search — 반환에 4카테고리 + 필터(계정·대분류). 반환 형이 바뀌므로 drop 후 재생성(44번 본문 유지).
drop function if exists public.item_dup_search(text, text, text, integer);
create or replace function public.item_dup_search(
  p_name  text    default null,
  p_spec  text    default null,
  p_all   text    default null,
  p_limit integer default 1000,
  p_acct  text    default null,      -- 품목계정 코드 필터(47번)
  p_grp1  text    default null       -- 대분류 코드 필터(47번)
)
returns table (
  item_code      text,
  item_name      text,
  spec           text,
  unit           text,
  item_group_cd  text,
  item_group_nm  text,
  use_yn         boolean,
  forbid         boolean,
  dup_key        text,
  spec_key       text,
  matched        boolean,
  dup_cnt        integer,
  dup_valid_cnt  integer,
  spec_cnt       integer,
  spec_name_cnt  integer,
  match_total    integer,
  row_total      integer,
  item_acct      text,      -- 47번: 품목계정 코드
  item_acct_nm   text,      --       품목계정 이름(매핑표/코드표, 없으면 null)
  grp1_cd        text,
  grp1_nm        text,      --       대분류
  grp2_cd        text,
  grp2_nm        text,      --       중분류
  grp3_cd        text,
  grp3_nm        text       --       소분류
)
language sql
stable
security invoker
set search_path = ''
as $$
  with tok as (
    select erp_ro.item_search_tokens(p_name) as tn,
           erp_ro.item_search_tokens(p_spec) as ts,
           erp_ro.item_search_tokens(p_all)  as ta
  ), ok as (
    select tok.tn, tok.ts, tok.ta
    from tok
    where exists (select 1 from unnest(tok.tn || tok.ts || tok.ta) as u(t) where length(u.t) >= 2)
  ), hit as materialized (
    select i.item_code, i.name_key, i.spec_key
    from erp_ro.item_master_s i
    cross join ok
    where not exists (select 1 from unnest(ok.tn) as u(t) where strpos(i.name_key, u.t) = 0)
      and not exists (select 1 from unnest(ok.ts) as u(t) where strpos(i.spec_key, u.t) = 0)
      and not exists (
        select 1 from unnest(ok.ta) as u(t)
        where strpos(pg_catalog.translate(pg_catalog.upper(i.item_code), '０１２３４５６７８９-', '0123456789')
                     || '|' || i.name_key || '|' || i.spec_key, u.t) = 0)
      -- 47번: 분류 필터 — 계정은 품목 컬럼, 대분류는 그룹 경로로
      and (p_acct is null or p_acct = '' or i.item_class = p_acct)
      and (p_grp1 is null or p_grp1 = '' or exists (
             select 1 from public.v_erp_item_group_path gp where gp.item_group_cd = i.item_group_cd and gp.grp1_cd = p_grp1))
  ), mem as (
    select i.item_code, i.item_name, i.spec, i.unit, i.item_group_cd, i.item_class, i.use_yn, i.name_key, i.spec_key,
           (coalesce(i.item_name, '') ~ '사용\s*금지' or coalesce(i.spec, '') ~ '^\s*1?사용\s*금지') as forbid,
           (i.item_code in (select h.item_code from hit h)) as matched
    from erp_ro.item_master_s i
    where (i.name_key, i.spec_key) in (select h.name_key, h.spec_key from hit h)
  ), agg as (
    select m.*,
           (count(*) over w)::integer as dup_cnt,
           (count(*) filter (where m.use_yn and not m.forbid) over w)::integer as dup_valid_cnt,
           (count(*) over ())::integer as row_total
    from mem m
    window w as (partition by m.name_key, m.spec_key)
  ), page as (
    select a.*,
           row_number() over (
             order by (a.dup_cnt > 1) desc,
                      (case when a.dup_valid_cnt >= 2 then 0 when a.dup_valid_cnt = 1 then 1 else 2 end),
                      a.dup_cnt desc, a.name_key, a.spec_key, (not a.matched), a.item_code) as rn
    from agg a
    order by rn
    limit greatest(1, least(coalesce(p_limit, 1000), 3000))
  )
  select p.item_code, p.item_name, p.spec, p.unit, p.item_group_cd, ig.item_group_nm, p.use_yn, p.forbid,
         p.name_key || '|' || p.spec_key, p.spec_key, p.matched,
         p.dup_cnt, p.dup_valid_cnt, coalesce(s.spec_cnt, 0), coalesce(s.spec_name_cnt, 0),
         (select count(*) from hit)::integer, p.row_total,
         p.item_class, ac.item_acct_nm,
         gp.grp1_cd, gp.grp1_nm, gp.grp2_cd, gp.grp2_nm, gp.grp3_cd, gp.grp3_nm
  from page p
  left join lateral (
    select count(*)::integer as spec_cnt, count(distinct i.name_key)::integer as spec_name_cnt
    from erp_ro.item_master_s i
    where p.spec_key <> '' and i.spec_key = p.spec_key
  ) s on true
  left join erp_ro.item_group_s ig on ig.item_group_cd = p.item_group_cd
  left join public.v_erp_item_group_path gp on gp.item_group_cd = p.item_group_cd
  left join public.v_item_acct ac on ac.item_acct = p.item_class
  order by p.rn;
$$;
comment on function public.item_dup_search(text, text, text, integer, text, text) is
  'REQ-0030 품목 존재/중복 조회 + REQ-0044 4카테고리(품목계정·대·중·소) 반환·필터. SECURITY INVOKER(RLS 적용). 44·47번.';
revoke all on function public.item_dup_search(text, text, text, integer, text, text) from public, anon;
grant execute on function public.item_dup_search(text, text, text, integer, text, text) to authenticated, service_role;

-- 분류 필터 선택지(화면 셀렉트용) — 계정별·대분류별 품목 수
create or replace view public.v_erp_item_category_stat with (security_invoker = true) as
  select 'acct' as kind, i.item_class as code, a.item_acct_nm as name, count(*)::integer as item_cnt, coalesce(a.sort, 100) as sort
  from erp_ro.item_master_s i left join public.v_item_acct a on a.item_acct = i.item_class
  group by i.item_class, a.item_acct_nm, a.sort
  union all
  select 'grp1', gp.grp1_cd, gp.grp1_nm, count(*)::integer, 100
  from erp_ro.item_master_s i join public.v_erp_item_group_path gp on gp.item_group_cd = i.item_group_cd
  group by gp.grp1_cd, gp.grp1_nm;
grant select on public.v_erp_item_category_stat to authenticated, service_role;

-- ── 검증 ──────────────────────────────────────────────────────────────────
-- select * from public.v_erp_item_group_path where group_level < 2;          → 잎이 상위 레벨인 7건, 아래 칸 null
-- select grp1_nm, grp2_nm, grp3_nm, count(*) from public.v_erp_item group by 1,2,3 order by 4 desc limit 5;
-- select * from public.v_item_acct;                                           → 6행, name_src null(코드표 적재 전)
-- select item_code, item_acct, item_acct_nm, grp1_nm, grp2_nm, grp3_nm from public.item_dup_search(null,null,'볼트',5);
-- ETL: python 10_ERP_DB연계/etl/etl_run.py --job ud_code  (관리자 `!` 실행) → erp_ro.ud_code_s 727행 기대
--      적재 후 select * from public.v_item_acct 로 이름이 붙었는지 확인. 안 붙으면 public.item_acct_name 에 관리자 값 insert.
