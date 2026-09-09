-- 40. 품목그룹 마스터 미러 — 품목 분류를 코드가 아니라 이름으로 보여주기 위한 코드 사전
-- 적용: 마이그레이션 `erp_item_group_mirror` · `erp_master_upsert_item_group` · `erp_sync_overview_item_group`
--       (2026-09-09, Supabase MCP)
--
-- 배경: 품목중복 화면의 「분류」가 10·20·30·33·35·F0 코드만 보여 의미를 알 수 없어 컬럼을 제거해 뒀다.
--       그 코드는 B_ITEM.ITEM_ACCT(품목계정, nchar(2))인데, 사내 ERP 테이블 사전(138테이블)을 뒤진 결과
--       **품목계정에는 코드명 마스터가 없다**:
--         · B_ITEM_ACCT_INF (8행) — ITEM_ACCT(PK)·ITEM_ACCT_GROUP 뿐, 이름 컬럼 없음
--         · B_USER_DEFINED_MINOR(703행)는 사용자정의 코드용이고, A_CTRL_ITEM 이 품목계정을 참조하지 않는다
--           (참조하는 것은 MG=품목그룹→B_ITEM_GROUP, MK=품목코드→B_ITEM, X12=대체계정→UV_UD_MAJOR_CD3)
--       대신 **이름이 붙은 분류 체계**가 따로 있었다 — B_ITEM.ITEM_GROUP_CD → B_ITEM_GROUP.
--       그래서 품목계정 코드를 억지로 해석하지 않고, 이름이 확실한 품목그룹을 화면에 쓴다.
--
-- 원천: JEILMNS.dbo.B_ITEM_GROUP — ITEM_GROUP_CD(PK) · ITEM_GROUP_NM · UPPER_ITEM_GROUP_CD ·
--       ITEM_GROUP_LEVEL · LEAF_FLG · DEL_FLG (계층형). ERP 운영DB 접속 없이 사전으로 확인.
-- 규약: 창고 마스터(39번)와 동일 — RLS ON + internal_select 정책,
--       적재는 erp_master_upsert 단일 경로, 노출은 public.v_erp_* (security_invoker).

create table if not exists erp_ro.item_group_s (
  item_group_cd  text primary key,   -- 품목그룹코드 (= B_ITEM.ITEM_GROUP_CD)
  item_group_nm  text,               -- 품목그룹명
  upper_group_cd text,               -- 상위품목그룹코드(계층)
  group_level    integer,            -- 품목그룹레벨
  leaf_flg       text,               -- 최하위 여부
  del_flg        text,               -- 삭제여부
  src_updated    timestamptz,
  synced_at      timestamptz not null default now(),
  batch_id       uuid
);
comment on table erp_ro.item_group_s is
  'ERP 품목그룹 마스터 미러(B_ITEM_GROUP) — 품목계정(ITEM_ACCT) 2자리 코드에는 이름 원천이 없어, 사람이 읽을 수 있는 분류명은 이 표에서 온다. 코드 마스터만.';

alter table erp_ro.item_group_s enable row level security;
revoke all on erp_ro.item_group_s from anon, authenticated;
grant select on erp_ro.item_group_s to authenticated, service_role;

drop policy if exists internal_select_item_group_s on erp_ro.item_group_s;
create policy internal_select_item_group_s on erp_ro.item_group_s
  for select to authenticated
  using (coalesce(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) = 'internal'::text);

create or replace view public.v_erp_item_group with (security_invoker = true) as
  select item_group_cd, item_group_nm, upper_group_cd, group_level, leaf_flg, synced_at
  from erp_ro.item_group_s
  where coalesce(del_flg, 'N') <> 'Y';

-- 품목 마스터에 그룹코드 컬럼 추가(추가 전용)
alter table erp_ro.item_master_s add column if not exists item_group_cd text;
comment on column erp_ro.item_master_s.item_group_cd is 'B_ITEM.ITEM_GROUP_CD — erp_ro.item_group_s 조인키';

-- v_erp_item 에 품목그룹명을 실어 준다(화면이 조인을 또 하지 않게).
-- ⚠ 컬럼을 중간에 끼워 넣는 것이라 create or replace 로는 안 된다
--   (ERROR 42P16: cannot change name of view column) — drop 후 재생성하고 권한을 다시 준다.
drop view if exists public.v_erp_item;
create view public.v_erp_item with (security_invoker = true) as
  select i.item_code, i.item_name, i.spec, i.unit, i.item_class,
         i.item_group_cd, g.item_group_nm, i.use_yn, i.synced_at
  from erp_ro.item_master_s i
  left join erp_ro.item_group_s g on g.item_group_cd = i.item_group_cd;
grant select on public.v_erp_item to anon, authenticated, service_role;

-- erp_master_upsert 에 item_group_s 분기 추가 + erp_etl_upsert 의 item_master_s 분기에 item_group_cd 반영.
-- 기존 분기를 손으로 옮겨 적지 않고, 현재 정의를 읽어 필요한 부분만 바꿔 넣는다(39번과 같은 방식).
do $mig$
declare src text; needle text; branch text;
begin
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'erp_master_upsert';
  if src is null then raise exception 'erp_master_upsert 를 찾지 못했습니다'; end if;

  if position('item_group_s' in src) = 0 then
    needle := '  else' || chr(10) || '    raise exception ''허용되지 않은 테이블: %'', p_table;';
    if position(needle in src) = 0 then
      raise exception 'erp_master_upsert 의 마지막 else 를 찾지 못했습니다';
    end if;
    branch := $branch$  elsif p_table = 'item_group_s' then
    insert into erp_ro.item_group_s (item_group_cd, item_group_nm, upper_group_cd, group_level,
                                     leaf_flg, del_flg, src_updated, synced_at, batch_id)
    select x.item_group_cd, x.item_group_nm, x.upper_group_cd, x.group_level,
           x.leaf_flg, x.del_flg, x.src_updated, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(item_group_cd text, item_group_nm text, upper_group_cd text,
                                         group_level integer, leaf_flg text, del_flg text,
                                         src_updated timestamptz, batch_id uuid)
    on conflict (item_group_cd) do update
      set item_group_nm = excluded.item_group_nm, upper_group_cd = excluded.upper_group_cd,
          group_level = excluded.group_level, leaf_flg = excluded.leaf_flg, del_flg = excluded.del_flg,
          synced_at = excluded.synced_at, src_updated = excluded.src_updated, batch_id = excluded.batch_id;
$branch$;
    execute replace(src, needle, branch || needle);
  end if;

  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'erp_etl_upsert';
  if position('item_group_cd' in src) > 0 then return; end if;

  src := replace(src,
    'insert into erp_ro.item_master_s (item_code, item_name, spec, unit, item_class, use_yn, synced_at, src_updated, batch_id)',
    'insert into erp_ro.item_master_s (item_code, item_name, spec, unit, item_class, item_group_cd, use_yn, synced_at, src_updated, batch_id)');
  src := replace(src,
    'select x.item_code, x.item_name, x.spec, x.unit, x.item_class, x.use_yn, now(), x.src_updated, x.batch_id',
    'select x.item_code, x.item_name, x.spec, x.unit, x.item_class, x.item_group_cd, x.use_yn, now(), x.src_updated, x.batch_id');
  src := replace(src,
    'as x(item_code text, item_name text, spec text, unit text, item_class text, use_yn boolean, src_updated timestamptz, batch_id uuid)',
    'as x(item_code text, item_name text, spec text, unit text, item_class text, item_group_cd text, use_yn boolean, src_updated timestamptz, batch_id uuid)');
  src := replace(src,
    'set item_name = excluded.item_name, spec = excluded.spec, unit = excluded.unit,' || chr(10) ||
    '          item_class = excluded.item_class, use_yn = excluded.use_yn,',
    'set item_name = excluded.item_name, spec = excluded.spec, unit = excluded.unit,' || chr(10) ||
    '          item_class = excluded.item_class, item_group_cd = excluded.item_group_cd, use_yn = excluded.use_yn,');
  if position('item_group_cd' in src) = 0 then
    raise exception 'erp_etl_upsert 의 item_master_s 분기 형태가 예상과 달라 교체하지 못했습니다';
  end if;
  execute src;
end $mig$;

-- 연동 현황 뷰 등재 — 17→18종.
do $sync$
declare body text; addon text;
begin
  select pg_get_viewdef('public.v_erp_sync_overview'::regclass, true) into body;
  if position('item_group' in body) > 0 then raise notice '이미 등재됨'; return; end if;
  body := rtrim(body);
  if right(body, 1) = ';' then body := left(body, length(body) - 1); end if;
  addon := $add$
UNION ALL
 SELECT 'item_group'::text AS source_key, '품목그룹 마스터'::text AS source_label,
    'B_ITEM_GROUP'::text AS erp_src,
    ( SELECT last_ok.finished_at FROM last_ok WHERE last_ok.job_name = 'item_group'::text) AS last_sync,
    ( SELECT count(*) AS count FROM erp_ro.item_group_s) AS row_count,
    NULL::text AS period_min, NULL::text AS period_max, false AS sensitive, 31 AS sort$add$;
  execute 'create or replace view public.v_erp_sync_overview with (security_invoker = true) as '
          || body || addon;
end $sync$;

-- ■ 실적재 완료(2026-09-09):
--     python 10_ERP_DB연계/etl/etl_run.py --job item_group       → 추출 2,387 / 적재 2,387
--     python 10_ERP_DB연계/etl/etl_run.py --job item_master --full → 추출 59,212 / 적재 59,212
--   (item_master 는 UPDT_DT 증분이라 --full 이 없으면 기존 행의 item_group_cd 가 채워지지 않는다)
--
--   결과: 품목 59,212건 중 59,209건(99.995%)이 그룹명으로 해석된다. 미해석 3건은 그룹코드 자체가 비어 있다.
--   화면: 품목중복 조회 「품목그룹」 컬럼 — 예) M16*80 중복 3건이 렌치 볼트 / 전산 볼트 / 육각 볼트로 갈린다.
--         자재 출고 상위 품목 「품목그룹」 컬럼 — 예) 기계 배관용 튜빙 → FITTING.
--
-- ■ 남은 것: 품목계정(ITEM_ACCT 10·20·30·33·35·F0)의 코드명은 여전히 원천이 없다.
--   화면에서는 쓰지 않으므로 급하지 않다. 필요해지면 유니포인트 확인 대상.
