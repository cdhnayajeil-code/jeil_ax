-- ============================================================================
-- 48_item_acct_p1001.sql — 품목계정 이름을 ERP 종합코드 P1001 에서 가져온다 (2026-09-11 · REQ-0045)
-- 적용: 마이그레이션 `item_acct_p1001` (Supabase MCP)
--
-- 관리자 지시: "품목계정은 숫자가 아닌 명칭으로 인지하기 좋게 반영 적용"
--
-- 원천 확인(2026-09-11)
--   · 40번·47번은 품목계정(B_ITEM.ITEM_ACCT) 이름 원천을 "ERP 에 없음"으로 보고 사용자정의 코드표(B_USER_DEFINED_*)와
--     수동 매핑표(item_acct_name)로 우회했다 — 화면은 코드(10·20·30·33·35·F0) + 「이름 매핑 전」.
--   · 사내 ERP 메타의 화면 도움말에 명시돼 있었다:
--       「품목계정 : 품목계정을 선택합니다. 종합코드(P1001)에 등록된 항목들이 표시 됩니다.」
--       「[기준정보>>공통기준정보]에서 Major Code P1001 에 등록한 품목계정의 Minor코드」
--     → 원천은 **시스템 종합코드 B_MINOR ⋈ B_MAJOR**(테이블 사전: B_MAJOR 1,588 · B_MINOR 13,293행, MINOR_NM nvarchar(200)).
--     교훈: 사전에서 "이름 칼럼이 있는 표"만 찾지 말고 **화면 도움말의 「종합코드(XXXXX)에 등록된 항목」 문구**부터 찾는다.
--   · 도움말 표준값은 10 제품 · 20 반제품 · 25 재공품 · 30 원자재 · 33 저장품 · 35 부자재 · 50 상품이지만
--     회사가 이름을 바꿨을 수 있고 F0 은 표준에 없다 → 표준값을 적어 넣지 않고 실제 B_MINOR 를 적재한다(40번 「추측 금지」 유지).
--
-- 바꾸는 것
--   1) erp_ro.sys_code_s — 종합코드 미러(ETL job `sys_code`, **화이트리스트 major 만** — 지금은 P1001) + RLS internal + v_erp_sys_code
--   2) erp_master_upsert 분기 'sys_code_s' · 연동 현황 등재
--   3) public.v_item_acct — 이름 원천 우선순위 **ERP P1001 > item_acct_name(수동 보충) > ud_code**, 정렬 = 코드 순(숫자 코드 → 그 값, 그 외 900).
--      열 구성 동일(create or replace) → v_erp_item · item_dup_search · v_erp_item_category_stat 는 수정 없이 새 이름을 받는다.
--      수동표는 이제 **P1001 에 없는 코드(F0 등)를 보충**하는 용도다(ERP 이름을 덮어쓰지 않는다).
-- 되돌리기: 47번의 v_item_acct 정의를 다시 실행한다(미러·분기·job 은 남겨도 무해).
-- ============================================================================

-- 1) 종합코드 미러
create table if not exists erp_ro.sys_code_s (
  major_cd    text not null,        -- B_MINOR.MAJOR_CD (P1001 = 품목계정)
  major_nm    text,                 -- B_MAJOR.MAJOR_NM
  minor_cd    text not null,        -- B_MINOR.MINOR_CD
  minor_nm    text,                 -- B_MINOR.MINOR_NM
  minor_type  text,                 -- B_MINOR.MINOR_TYPE (정의 형태)
  src_updated timestamptz,          -- B_MINOR.UPDT_DT
  synced_at   timestamptz not null default now(),
  batch_id    uuid,
  primary key (major_cd, minor_cd)
);
comment on table erp_ro.sys_code_s is
  'ERP 시스템 종합코드 미러(B_MINOR ⋈ B_MAJOR) — 화이트리스트 major 만 적재(ETL job sys_code). P1001 = 품목계정 이름. 48번(REQ-0045).';
alter table erp_ro.sys_code_s enable row level security;
revoke all on erp_ro.sys_code_s from anon, authenticated;
grant select on erp_ro.sys_code_s to authenticated, service_role;
drop policy if exists internal_select_sys_code_s on erp_ro.sys_code_s;
create policy internal_select_sys_code_s on erp_ro.sys_code_s
  for select to authenticated
  using (coalesce(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) = 'internal'::text);
create or replace view public.v_erp_sys_code with (security_invoker = true) as
  select major_cd, major_nm, minor_cd, minor_nm, minor_type, src_updated, synced_at from erp_ro.sys_code_s;
grant select on public.v_erp_sys_code to authenticated, service_role;

-- 2) erp_master_upsert 에 sys_code_s 분기 — 40·47번과 같은 방식(현재 정의를 읽어 마지막 else 앞에 끼워 넣는다)
do $mig$
declare src text; needle text; branch text;
begin
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'erp_master_upsert';
  if src is null then raise exception 'erp_master_upsert 를 찾지 못했습니다'; end if;
  if position('sys_code_s' in src) > 0 then raise notice '이미 등재됨'; return; end if;
  needle := '  else' || chr(10) || '    raise exception ''허용되지 않은 테이블: %'', p_table;';
  if position(needle in src) = 0 then raise exception 'erp_master_upsert 의 마지막 else 를 찾지 못했습니다'; end if;
  branch := $branch$  elsif p_table = 'sys_code_s' then
    insert into erp_ro.sys_code_s (major_cd, major_nm, minor_cd, minor_nm, minor_type, src_updated, synced_at, batch_id)
    select x.major_cd, x.major_nm, x.minor_cd, x.minor_nm, x.minor_type, x.src_updated, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(major_cd text, major_nm text, minor_cd text, minor_nm text,
                                         minor_type text, src_updated timestamptz, batch_id uuid)
    on conflict (major_cd, minor_cd) do update
      set major_nm = excluded.major_nm, minor_nm = excluded.minor_nm, minor_type = excluded.minor_type,
          synced_at = excluded.synced_at, src_updated = excluded.src_updated, batch_id = excluded.batch_id;
$branch$;
  execute replace(src, needle, branch || needle);
end $mig$;

-- 연동 현황 뷰 등재
do $sync$
declare body text; addon text;
begin
  select pg_get_viewdef('public.v_erp_sync_overview'::regclass, true) into body;
  if position('''sys_code''' in body) > 0 then raise notice '이미 등재됨'; return; end if;
  body := rtrim(body);
  if right(body, 1) = ';' then body := left(body, length(body) - 1); end if;
  addon := $add$
UNION ALL
 SELECT 'sys_code'::text AS source_key, '종합코드(품목계정 등)'::text AS source_label,
    'B_MINOR/B_MAJOR (P1001)'::text AS erp_src,
    ( SELECT last_ok.finished_at FROM last_ok WHERE last_ok.job_name = 'sys_code'::text) AS last_sync,
    ( SELECT count(*) AS count FROM erp_ro.sys_code_s) AS row_count,
    NULL::text AS period_min, NULL::text AS period_max, false AS sensitive, 33 AS sort$add$;
  execute 'create or replace view public.v_erp_sync_overview with (security_invoker = true) as ' || body || addon;
end $sync$;

-- 3) 품목계정 코드 → 이름: ERP P1001 > 수동 보충표 > 사용자정의 코드표. 열 구성은 47번과 동일.
create or replace view public.v_item_acct with (security_invoker = true) as
  with used as (select distinct item_class as item_acct from erp_ro.item_master_s where item_class is not null),
  p1001 as (
    select s.minor_cd as item_acct, nullif(btrim(s.minor_nm), '') as item_acct_nm
    from erp_ro.sys_code_s s
    where s.major_cd = 'P1001'
  ),
  ud as (
    select u.ud_minor_cd as item_acct, u.ud_minor_nm as item_acct_nm
    from erp_ro.ud_code_s u
    where u.ud_major_nm ~ '품목\s*계정' or u.ud_major_cd ~* 'ITEM_?ACCT'
  )
  select used.item_acct,
         coalesce(p.item_acct_nm, m.item_acct_nm, ud.item_acct_nm) as item_acct_nm,
         case when p.item_acct_nm is not null then 'erp_p1001'
              when m.item_acct is not null then 'manual'
              when ud.item_acct is not null then 'ud_code' end as name_src,
         coalesce(m.sort, case when used.item_acct ~ '^[0-9]+$' then used.item_acct::integer else 900 end) as sort
  from used
  left join p1001 p on p.item_acct = used.item_acct
  left join public.item_acct_name m on m.item_acct = used.item_acct
  left join ud on ud.item_acct = used.item_acct;
comment on view public.v_item_acct is
  '품목계정 코드 → 이름. 원천 우선순위 ERP 종합코드 P1001(erp_ro.sys_code_s) > item_acct_name(수동 보충) > ud_code. 이름이 없으면 null(화면은 코드). 47·48번.';
grant select on public.v_item_acct to authenticated, service_role;

-- ── 실적재·검증 결과(2026-09-11) ─────────────────────────────────────────────
-- ETL `--job sys_code` : dry-run 8행 → 실적재 8/8(관리자 승인, 세션 실행)
-- P1001 = 10 제품 · 20 반제품 · 25 재공품 · 30 원자재 · **33 소모품** · 35 부자재 · 50 상품 · **F0 설비수리자재**
--   → 도움말 표준과 달리 33 은 「저장품」이 아니라 「소모품」, F0 은 표준에 없던 「설비수리자재」 — 표준값을 적었다면 틀렸다.
-- v_item_acct : 사용 코드 6개 전부 name_src = erp_p1001 (10 1,095 · 20 11,191 · 30 26,843 · 33 1,599 · 35 18,538 · F0 1)
-- 화면(헤드리스 실데이터 9항목 통과): 계정 필터 「원자재 (26,843)」 이름·코드 순 · 결과 배지 이름 + 툴팁 코드 · CSV 코드·이름 둘 다
--
-- ── 검증 쿼리 ──────────────────────────────────────────────────────────────
-- ETL: python 10_ERP_DB연계/etl/etl_run.py --job sys_code  → erp_ro.sys_code_s (P1001 행 수만큼)
-- select * from public.v_item_acct order by sort;                         → 이름·name_src='erp_p1001'
-- select kind, code, name, item_cnt from public.v_erp_item_category_stat where kind='acct' order by sort;
-- select item_code, item_acct, item_acct_nm from public.item_dup_search(null, null, '볼트', 5);
