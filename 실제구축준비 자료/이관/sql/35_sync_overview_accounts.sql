-- ============================================================================
-- 35_sync_overview_accounts.sql — 연동현황에 MS·그룹웨어 계정 축 등재 (2026-09-07)
--
-- 왜: 「ERP 데이터 연동 현황」(app/erp-status.html)의 **데이터 업데이트** 버튼이
--     ERP 21종만 갱신하고 MS(Entra)·그룹웨어 계정은 손대지 않았다. 그래서 계정 대사
--     화면(admin-accounts)이 ERP 는 새 데이터, 계정은 며칠 전 데이터인 상태로 조용히
--     어긋났다(실제로 그룹웨어 사용중지 처리 직후 미러가 그대로였다).
--     → 러너(etl_watch.py)가 ERP job 뒤에 계정 수집기 2종을 이어 돌리도록 바꿨고,
--       이 파일은 그 두 축을 연동현황 표에 **보이게** 한다. (관리자 지시 2026-09-07)
--
-- ⚠ row_count 는 실테이블 count(*) 를 쓰지 않는다.
--     v_erp_sync_overview 는 security_invoker 뷰라 호출자(authenticated) 권한으로 돈다.
--     public.acct_ms · public.acct_groupware 는 authenticated 에 SELECT 가 없고(RLS on,
--     정책 0개 — 34_identity_accounts.sql 의 fail-closed 설계) 열어줄 생각도 없다.
--     여기서 count(*) 를 하면 사내 사용자 전원이 permission denied 로 연동현황 화면
--     전체를 못 본다(2026-07-21 iv_dtl 사고와 같은 유형). 급여·계정과목처럼
--     batch_run 의 최근 성공 적재건수를 쓴다.
--
-- 적용: 이 파일만 단독 실행해도 된다(뷰 재정의 + grant).
-- ============================================================================

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
         null, null, false, 120
  -- ── 계정 대사(REQ-0018)의 ERP 밖 두 축 — 원천이 ERP MSSQL 이 아니라서 erp_src 에
  --    시스템 이름을 적는다. 「데이터 업데이트」로 ERP job 과 함께 갱신된다.
  union all select 'ms_account','MS(Entra) 계정','Microsoft Graph /users',
         (select finished_at from last_ok where job_name='ms_account'),
         (select rows_upserted from last_rows where job_name='ms_account')::bigint,
         null, null, false, 200
  union all select 'gw_account','그룹웨어 계정','ONUL Ware 인사정보 뷰',
         (select finished_at from last_ok where job_name='gw_account'),
         (select rows_upserted from last_rows where job_name='gw_account')::bigint,
         null, null, false, 210;

grant select on public.v_erp_sync_overview to authenticated, service_role;

-- ── 검증 ────────────────────────────────────────────────────────────────
-- 1) 행 수 16종(ERP 14 + 계정 2), 계정 2종이 맨 뒤:
--    select source_key, source_label, last_sync, row_count from public.v_erp_sync_overview order by sort;
-- 2) 사내 사용자 권한으로도 403 이 안 나는지(핵심 회귀):
--    set local role authenticated; select count(*) from public.v_erp_sync_overview; reset role;
