-- 08_erp_pub_reporting_views.sql
-- P4: ERP 중간DB(erp_ro) → 앱/챗봇 노출 계층 (사내 전용 리포팅 뷰)
-- 적용일 2026-07-08 · Supabase 마이그레이션: erp_pub_reporting_views + erp_ro_grant_service_role_read
-- 원칙: erp_ro/etl_meta는 REST 비노출 유지. 노출 진입점은 public.v_erp_* 뷰뿐.
--   - authenticated: security_invoker 뷰 + erp_ro RLS(internal_select_*)로 사내(role=internal)만 통과(협력사/anon 0행).
--   - service_role(챗봇 Edge Function 전용, 서버에만 존재): 별도 read GRANT로 뷰 조회(RLS bypass).
-- 재현/이관용 정본. 이 파일은 Supabase에 apply_migration으로 이미 적용된 DDL의 사본이다.

-- ── 마이그레이션 1: erp_pub_reporting_views ──────────────────────────────

-- 1) erp_ro 최소 권한(REST 비노출이라 직접 접근 불가, 뷰 경유만 유효)
grant usage on schema erp_ro to authenticated;
grant select on
  erp_ro.sales_orders_m, erp_ro.purchase_m, erp_ro.inventory_d,
  erp_ro.item_master_s, erp_ro.pur_order_s
to authenticated;

-- 2) 데이터 기준시각(batch_run): 사내 SELECT 정책 추가(기존 RLS enabled·정책없음 → 사내만 허용)
grant usage on schema etl_meta to authenticated;
grant select on etl_meta.batch_run to authenticated;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='etl_meta' and tablename='batch_run' and policyname='internal_select_batch_run'
  ) then
    create policy internal_select_batch_run on etl_meta.batch_run
      for select to authenticated using (public.is_internal());
  end if;
end $$;

-- 3) 리포팅 뷰(사내 한정) — 화이트리스트 컬럼만, 집계/스냅샷
create or replace view public.v_erp_sales_monthly with (security_invoker=true) as
  select ym, bp_code, bp_name, order_amt, sales_amt, collect_amt, order_cnt, synced_at
  from erp_ro.sales_orders_m;

create or replace view public.v_erp_purchase_monthly with (security_invoker=true) as
  select ym, bp_code, bp_name, purchase_amt, iv_cnt, synced_at
  from erp_ro.purchase_m;

create or replace view public.v_erp_inventory_daily with (security_invoker=true) as
  select ymd, item_code, wh_code, in_qty, out_qty, stock_qty, synced_at
  from erp_ro.inventory_d;

create or replace view public.v_erp_item with (security_invoker=true) as
  select item_code, item_name, spec, unit, item_class, use_yn, synced_at
  from erp_ro.item_master_s;

create or replace view public.v_erp_pur_order with (security_invoker=true) as
  select po_no, po_seq, po_dt, bp_code, bp_name, item_code, item_name,
         dlvy_dt, po_qty, po_unit, po_amt, po_sts, rcpt_qty, subcontra_flg, cls_flg, synced_at
  from erp_ro.pur_order_s;

create or replace view public.v_erp_data_asof with (security_invoker=true) as
  select job_name,
         max(finished_at) filter (where status='success') as last_success,
         max(rows_upserted) filter (where status='success') as rows_upserted
  from etl_meta.batch_run
  group by job_name;

-- 4) 뷰 노출(authenticated만; anon 미부여 → 사내 로그인 사용자만)
grant select on
  public.v_erp_sales_monthly, public.v_erp_purchase_monthly, public.v_erp_inventory_daily,
  public.v_erp_item, public.v_erp_pur_order, public.v_erp_data_asof
to authenticated;

-- ── 마이그레이션 2: erp_ro_grant_service_role_read ──────────────────────
-- 챗봇(jeil-chat)이 service_role로 ERP 집계를 읽을 수 있게 서버 전용 읽기 권한 부여.
-- service_role은 서버(Edge Function Deno.env)에만 존재, REST 클라이언트 미노출.
grant usage on schema erp_ro to service_role;
grant select on
  erp_ro.sales_orders_m, erp_ro.purchase_m, erp_ro.inventory_d,
  erp_ro.item_master_s, erp_ro.pur_order_s
to service_role;
grant usage on schema etl_meta to service_role;
grant select on etl_meta.batch_run to service_role;

-- ── 마이그레이션 3: erp_sync_overview_view (연동 현황 페이지용) ──────────
-- 소스별 최신 연동시점·적재건수·기간. 사내(internal)만 실제 값(security_invoker + RLS).
create or replace view public.v_erp_sync_overview with (security_invoker=true) as
  select 'pur_order' as source_key, '발주(2026)' as source_label, 'M_PUR_ORD' as erp_src,
    (select max(finished_at) from etl_meta.batch_run where job_name='pur_order' and status='success') as last_sync,
    (select count(*) from erp_ro.pur_order_s) as row_count,
    (select min(po_dt)::text from erp_ro.pur_order_s) as period_min,
    (select max(po_dt)::text from erp_ro.pur_order_s) as period_max
  union all select 'item_master','품목 마스터','B_ITEM',
    (select max(finished_at) from etl_meta.batch_run where job_name='item_master' and status='success'),
    (select count(*) from erp_ro.item_master_s), null, null
  union all select 'sales','매출 월집계','S_BILL_HDR',
    (select max(finished_at) from etl_meta.batch_run where job_name='sales' and status='success'),
    (select count(*) from erp_ro.sales_orders_m),
    (select min(ym) from erp_ro.sales_orders_m), (select max(ym) from erp_ro.sales_orders_m)
  union all select 'purchase','매입 월집계','M_IV_HDR',
    (select max(finished_at) from etl_meta.batch_run where job_name='purchase' and status='success'),
    (select count(*) from erp_ro.purchase_m),
    (select min(ym) from erp_ro.purchase_m), (select max(ym) from erp_ro.purchase_m)
  union all select 'inventory','재고 입출고','M_PUR_GOODS_MVMT',
    (select max(finished_at) from etl_meta.batch_run where job_name='inventory' and status='success'),
    (select count(*) from erp_ro.inventory_d),
    (select min(ymd)::text from erp_ro.inventory_d), (select max(ymd)::text from erp_ro.inventory_d);
grant select on public.v_erp_sync_overview to authenticated, service_role;

-- ── 검증(참고) ─────────────────────────────────────────────────────────
-- 사내(internal)만 데이터, 협력사(vendor)/anon은 0행이어야 정상:
--   set local role authenticated;
--   set local request.jwt.claims = '{"app_metadata":{"role":"internal"}}';
--   select count(*) from public.v_erp_sales_monthly;   -- 사내: N행
--   set local request.jwt.claims = '{"app_metadata":{"role":"vendor","vendor_bp":["100001"]}}';
--   select count(*) from public.v_erp_sales_monthly;   -- 협력사: 0행

-- ── 롤백(필요 시) ──────────────────────────────────────────────────────
-- drop view if exists public.v_erp_sales_monthly, public.v_erp_purchase_monthly,
--   public.v_erp_inventory_daily, public.v_erp_item, public.v_erp_pur_order, public.v_erp_data_asof;
-- drop policy if exists internal_select_batch_run on etl_meta.batch_run;
-- revoke usage on schema erp_ro from authenticated, service_role;
-- (테이블 GRANT는 revoke select on ... from authenticated, service_role;)
