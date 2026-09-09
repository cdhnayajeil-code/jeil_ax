-- 39. 창고(저장위치) 마스터 미러 — 화면에서 창고코드를 이름으로 보여주기 위한 코드 사전
-- 적용: 마이그레이션 `erp_wh_master_mirror` · `erp_master_upsert_wh_master` (2026-09-09, Supabase MCP)
-- 배경: 자재 출고현황 「창고별 출고」가 PL120·PL170 같은 코드만 보여주고 있었다(관리자 지적).
--       중간DB에 창고 마스터가 없어 이름을 붙일 수 없었다.
-- 원천: JEILMNS.dbo.B_STORAGE_LOCATION (53행) — SL_CD(PK)=창고코드 · SL_NM=창고명
--       ERP 운영DB에 접속하지 않고, 사내 ERP 테이블 사전(erp_chat/data/module-base.json)에서 확인했다.
--       자재 수불의 wh_code 는 M_PUR_GOODS_MVMT.MVMT_SL_CD(입출고창고)이며 같은 코드 체계다.
-- 규약: 기존 코드 마스터(acct_master_s·cost_center_s·item_master_s)와 동일 —
--       RLS ON + internal_select_* 정책, 적재는 erp_master_upsert(service_role) 단일 경로,
--       노출은 public.v_erp_* (security_invoker) 경유. 코드 마스터만(수량·금액 없음).

create table if not exists erp_ro.wh_master_s (
  sl_cd       text primary key,   -- 창고코드 (= inventory_d.wh_code)
  sl_nm       text,               -- 창고명
  sl_type     text,               -- 창고유형
  sl_group_cd text,               -- 창고그룹코드
  plant_cd    text,               -- 공장코드
  src_updated timestamptz,
  synced_at   timestamptz not null default now(),
  batch_id    uuid
);
comment on table erp_ro.wh_master_s is
  'ERP 창고(저장위치) 마스터 미러(B_STORAGE_LOCATION) — 자재 화면에서 wh_code(=MVMT_SL_CD)를 창고명으로 표시하기 위한 코드 사전. 코드 마스터만.';

alter table erp_ro.wh_master_s enable row level security;
revoke all on erp_ro.wh_master_s from anon, authenticated;
grant select on erp_ro.wh_master_s to authenticated, service_role;

drop policy if exists internal_select_wh_master_s on erp_ro.wh_master_s;
create policy internal_select_wh_master_s on erp_ro.wh_master_s
  for select to authenticated
  using (coalesce(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text), ''::text) = 'internal'::text);

create or replace view public.v_erp_wh with (security_invoker = true) as
  select sl_cd, sl_nm, sl_type, sl_group_cd, plant_cd, synced_at
  from erp_ro.wh_master_s;

-- erp_master_upsert 에 wh_master_s 분기 추가.
-- 기존 7개 분기(acct_master_s·cost_center_s·ctrl_item_s·acct_ctrl_assn_s·gl_slip_s·gl_slip_item_s·gl_slip_ctrl_s)를
-- 손으로 옮겨 적으면 오타 위험이 있어, 현재 정의를 읽어 마지막 else 앞에 새 분기만 끼워 넣었다.
do $mig$
declare src text; needle text; branch text;
begin
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'erp_master_upsert';

  if src is null then raise exception 'erp_master_upsert 를 찾지 못했습니다'; end if;
  if position('wh_master_s' in src) > 0 then
    raise notice 'wh_master_s 분기가 이미 있습니다 — 건너뜁니다'; return;
  end if;

  needle := '  else' || chr(10) || '    raise exception ''허용되지 않은 테이블: %'', p_table;';
  if position(needle in src) = 0 then
    raise exception '마지막 else 분기를 찾지 못했습니다 — 함수 형태가 바뀌었습니다';
  end if;

  branch := $branch$  elsif p_table = 'wh_master_s' then
    insert into erp_ro.wh_master_s (sl_cd, sl_nm, sl_type, sl_group_cd, plant_cd,
                                    src_updated, synced_at, batch_id)
    select x.sl_cd, x.sl_nm, x.sl_type, x.sl_group_cd, x.plant_cd, x.src_updated, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(sl_cd text, sl_nm text, sl_type text, sl_group_cd text,
                                         plant_cd text, src_updated timestamptz, batch_id uuid)
    on conflict (sl_cd) do update
      set sl_nm = excluded.sl_nm, sl_type = excluded.sl_type,
          sl_group_cd = excluded.sl_group_cd, plant_cd = excluded.plant_cd,
          synced_at = excluded.synced_at, src_updated = excluded.src_updated, batch_id = excluded.batch_id;
$branch$;

  execute replace(src, needle, branch || needle);
end $mig$;

-- 적용 후 확인(2026-09-09): 분기 8개(기존 7 + wh_master_s), 정책 1, 뷰 security_invoker=true.
--
-- ■ 실적재 완료(2026-09-09, 관리자 직접 실행) — 추출 53 / 적재 53, 유실 0.
--     python 10_ERP_DB연계/etl/etl_run.py --job wh_master
--   화면 확인: 「창고별 출고」가 제조_부자재창고(이천) PL120 / 제조_원자재창고(이천) PL170 …
--   형태로 바뀌었고, 적재 전 폴백 안내("이름은 아직 연계 전")는 자동으로 사라졌다.
--   내부창고(SL_TYPE='I') 6곳에 수불이 있고, 나머지 47곳은 외주처 창고(SL_TYPE='E')로 2026년 출고 0.

-- 연동 현황 뷰 등재 — 마이그레이션 `erp_sync_overview_wh_master` (2026-09-09), 16→17종.
-- 기존 16개 소스 블록을 손으로 옮겨 적지 않고 현재 정의를 읽어 UNION ALL 한 덩어리만 덧붙였다.
do $sync$
declare body text; addon text;
begin
  select pg_get_viewdef('public.v_erp_sync_overview'::regclass, true) into body;
  if position('wh_master' in body) > 0 then raise notice '이미 등재됨'; return; end if;
  body := rtrim(body);
  if right(body, 1) = ';' then body := left(body, length(body) - 1); end if;
  addon := $add$
UNION ALL
 SELECT 'wh_master'::text AS source_key, '창고 마스터'::text AS source_label,
    'B_STORAGE_LOCATION'::text AS erp_src,
    ( SELECT last_ok.finished_at FROM last_ok WHERE last_ok.job_name = 'wh_master'::text) AS last_sync,
    ( SELECT count(*) AS count FROM erp_ro.wh_master_s) AS row_count,
    NULL::text AS period_min, NULL::text AS period_max, false AS sensitive, 130 AS sort$add$;
  execute 'create or replace view public.v_erp_sync_overview with (security_invoker = true) as '
          || body || addon;
end $sync$;
