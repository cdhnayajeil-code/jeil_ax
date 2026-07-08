-- 10_erp_pur_req.sql
-- 구매요청(M_PUR_REQ) 연동 + 발주↔구매요청(PR_NO) 연결
-- 적용일 2026-07-08 · 마이그레이션: erp_pur_req_schema_and_po_pr_link, erp_etl_upsert_add_pr, erp_pur_req_views
-- (Supabase apply_migration으로 이미 적용된 DDL 사본. erp_ro는 REST 비노출·사내 RLS 유지)

-- ① 스키마: pur_order_s에 pr_no 추가 + pur_req_s(구매요청) 신설
alter table erp_ro.pur_order_s add column if not exists pr_no text;
create table if not exists erp_ro.pur_req_s (
  pr_no text primary key, pr_type text, pr_sts text, plant_cd text,
  item_code text, item_name text,
  req_qty numeric, req_unit text, ord_qty numeric, rcpt_qty numeric, iv_qty numeric,
  req_dt date, dlvy_dt date, pur_plan_dt date,
  req_dept text, req_prsn text, sppl_code text, sppl_name text, so_no text,
  synced_at timestamptz not null default now(), src_updated timestamptz, batch_id uuid
);
alter table erp_ro.pur_req_s enable row level security;
-- 사내(internal)만 SELECT (다른 erp_ro 테이블과 동일 패턴)
create policy internal_select_pur_req_s on erp_ro.pur_req_s
  for select to authenticated using (public.is_internal());
grant select on erp_ro.pur_req_s to authenticated, service_role;
create index if not exists idx_pur_order_pr_no on erp_ro.pur_order_s (pr_no);

-- ② erp_etl_upsert: pur_order_s에 pr_no 컬럼 추가, pur_req_s 브랜치 신설
--    (전체 함수 재정의는 마이그레이션 erp_etl_upsert_add_pr 참조 — 화이트리스트 방식)

-- ③ 노출 뷰(사내 전용, security_invoker + erp_ro RLS)
create or replace view public.v_erp_pur_order with (security_invoker=true) as
  select po_no, po_seq, po_dt, bp_code, bp_name, item_code, item_name,
         dlvy_dt, po_qty, po_unit, po_amt, po_sts, rcpt_qty, subcontra_flg, cls_flg, synced_at, pr_no
  from erp_ro.pur_order_s;
create or replace view public.v_erp_pur_req with (security_invoker=true) as
  select pr_no, pr_type, pr_sts, item_code, item_name, req_qty, req_unit, ord_qty, rcpt_qty, iv_qty,
         req_dt, dlvy_dt, pur_plan_dt, req_dept, req_prsn, sppl_code, sppl_name, so_no, synced_at
  from erp_ro.pur_req_s;
-- 발주↔구매요청 연결(PO번호·PR번호 어느 쪽으로도 조회)
create or replace view public.v_erp_po_pr_link with (security_invoker=true) as
  select o.po_no, o.po_seq, o.pr_no, o.po_dt, o.bp_name as po_vendor, o.item_code, o.item_name,
         o.po_qty, o.po_amt, o.po_sts, o.dlvy_dt as po_dlvy_dt,
         r.req_dt, r.dlvy_dt as pr_dlvy_dt, r.req_qty, r.ord_qty,
         r.req_dept, r.req_prsn, r.pr_sts, r.pr_type, r.sppl_name as pr_supplier
  from erp_ro.pur_order_s o
  left join erp_ro.pur_req_s r on r.pr_no = o.pr_no;
grant select on public.v_erp_pur_req, public.v_erp_po_pr_link to authenticated, service_role;

-- ETL: pur_order SQL에 d.PR_NO AS pr_no 추가, pur_req job(M_PUR_REQ, REQ_DT 연 필터, 증분 UPDT_DT) 신설
--   → 10_ERP_DB연계/etl/etl_run.py 참조. 실적재: pur_order --full(pr_no 백필) + pur_req.
-- 챗봇: get_erp_po_pr Tool(po_no/pr_no 조회) — jeil-chat v10.

-- 검증(참고): 사내(internal)만 데이터, 협력사/anon 0행
--   select po_no, pr_no, item_name, req_dt, req_prsn from public.v_erp_po_pr_link where pr_no is not null limit 5;
