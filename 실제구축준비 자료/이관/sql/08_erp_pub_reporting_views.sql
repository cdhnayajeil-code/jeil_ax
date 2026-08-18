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
--
-- ⚠ 이 정의는 이후 마이그레이션으로 5종 → 14종까지 확장됐다. 정본을 라이브와 일치시키기 위해
--   아래 최신 정의(erp_sync_overview_add_bp_master, 2026-08-10)로 대체한다. 확장 이력:
--     erp_sync_overview_v2(sensitive·sort 컬럼 추가, 급여 집계 등재)
--     erp_sync_overview_accounting_master(2026-08-03, acct_master·cost_center 등재 → 13종)
--     erp_sync_overview_add_bp_master(2026-08-10, bp_master 등재 → 14종)
--
-- ⚠ 설계 주의 — row_count 산출 방식이 두 갈래인 이유:
--   security_invoker 뷰라 호출자 권한으로 실행된다. 따라서 실테이블 count(*)는
--   해당 테이블에 authenticated GRANT가 있는 경우에만 쓸 수 있다.
--   · GRANT 있음(pur_order_s·pur_req_s·item_master_s·bp_master_s·iv_dtl_s 등) → 실테이블 count(*)
--   · GRANT 없음(fail-closed: hr_payroll_m·acct_master_s·cost_center_s) → batch_run 최근 성공건수
--   GRANT 없는 테이블을 count 하면 사내 사용자에게 permission denied가 발생해
--   연동현황 화면 전체가 403이 된다(2026-07-21 iv_dtl 사고 유형). 권한을 열어 우회하지 말 것.
create or replace view public.v_erp_sync_overview with (security_invoker=true) as
  with last_ok as (
    select job_name, max(finished_at) as finished_at
      from etl_meta.batch_run where status='success' group by job_name
  ), last_rows as (
    select distinct on (b.job_name) b.job_name, b.rows_upserted
      from etl_meta.batch_run b where b.status='success'
     order by b.job_name, b.finished_at desc
  )
  select 'pur_order'::text as source_key, '발주(2026)'::text as source_label,
         'M_PUR_ORD_HDR + M_PUR_ORD_DTL'::text as erp_src,
         (select finished_at from last_ok where job_name='pur_order') as last_sync,
         (select count(*) from erp_ro.pur_order_s) as row_count,
         (select min(po_dt)::text from erp_ro.pur_order_s) as period_min,
         (select max(po_dt)::text from erp_ro.pur_order_s) as period_max,
         false as sensitive, 10 as sort
  union all select 'pur_req','구매요청(2026)','M_PUR_REQ',
         (select finished_at from last_ok where job_name='pur_req'),
         (select count(*) from erp_ro.pur_req_s),
         (select min(req_dt)::text from erp_ro.pur_req_s),
         (select max(req_dt)::text from erp_ro.pur_req_s), false, 20
  union all select 'item_master','품목 마스터','B_ITEM',
         (select finished_at from last_ok where job_name='item_master'),
         (select count(*) from erp_ro.item_master_s), null, null, false, 30
  union all select 'bp_master','거래처 마스터','B_BIZ_PARTNER',
         (select finished_at from last_ok where job_name='bp_master'),
         (select count(*) from erp_ro.bp_master_s), null, null, false, 35
  union all select 'sales','매출 월집계','S_BILL_HDR',
         (select finished_at from last_ok where job_name='sales'),
         (select count(*) from erp_ro.sales_orders_m),
         (select min(ym) from erp_ro.sales_orders_m),
         (select max(ym) from erp_ro.sales_orders_m), false, 40
  union all select 'purchase','매입 월집계(거래처)','M_IV_HDR',
         (select finished_at from last_ok where job_name='purchase'),
         (select count(*) from erp_ro.purchase_m),
         (select min(ym) from erp_ro.purchase_m),
         (select max(ym) from erp_ro.purchase_m), false, 45
  union all select 'iv_dtl','매입 상세(라인)','M_IV_DTL + M_IV_HDR',
         (select finished_at from last_ok where job_name='iv_dtl'),
         (select count(*) from erp_ro.iv_dtl_s),
         (select min(iv_dt)::text from erp_ro.iv_dtl_s),
         (select max(iv_dt)::text from erp_ro.iv_dtl_s), false, 46
  union all select 'inventory','재고 입출고','M_PUR_GOODS_MVMT',
         (select finished_at from last_ok where job_name='inventory'),
         (select count(*) from erp_ro.inventory_d),
         (select min(ymd)::text from erp_ro.inventory_d),
         (select max(ymd)::text from erp_ro.inventory_d), false, 60
  union all select 'dept_master','부서 마스터','B_ACCT_DEPT',
         (select finished_at from last_ok where job_name='dept_master'),
         (select count(*) from erp_ro.dept_master_s), null, null, false, 70
  union all select 'usr_master','사용자 마스터(계정↔부서)','Z_USR_MAST_REC',
         (select finished_at from last_ok where job_name='usr_master'),
         (select count(*) from erp_ro.usr_master_s), null, null, false, 80
  union all select 'usr_erp_module','ERP 메뉴 권한','Z_USR_ROLE_MNU_AUTHZTN_ASSO 외',
         (select finished_at from last_ok where job_name='usr_erp_module'),
         (select count(*) from erp_ro.usr_erp_module_s), null, null, false, 90
  union all select 'hr_payroll','급여 집계(민감)','HDF070T + HGA070T',
         (select finished_at from last_ok where job_name='hr_payroll'),
         (select rows_upserted from last_rows where job_name='hr_payroll')::bigint,
         null, null, true, 100
  union all select 'acct_master','계정과목 마스터(회계)','A_ACCT',
         (select finished_at from last_ok where job_name='acct_master'),
         (select rows_upserted from last_rows where job_name='acct_master')::bigint,
         null, null, false, 110
  union all select 'cost_center','코스트센터 마스터(회계)','B_COST_CENTER',
         (select finished_at from last_ok where job_name='cost_center'),
         (select rows_upserted from last_rows where job_name='cost_center')::bigint,
         null, null, false, 120;
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
