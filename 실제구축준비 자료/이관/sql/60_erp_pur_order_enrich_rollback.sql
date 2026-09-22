-- 60_erp_pur_order_enrich_rollback.sql
-- 되돌리기: 발주 스냅샷 확충 (REQ-0070)
--
-- 순서: 뷰 → ETL 지정 → 함수 → 컬럼. 반대로 하면 뷰가 없는 컬럼을 가리켜 깨진다.
-- ⚠ 컬럼을 지우면 적재된 값도 함께 사라진다. 되돌림이 아니라 「잠시 끄기」가 목적이면
--   etl_run.py 의 JOBS['pur_order']['rpc'] 한 줄만 지워도 된다(공유 upsert 로 돌아가 신규 컬럼만 안 채운다).

-- 1) 뷰를 확충 전 정의로 — 57_erp_pur_list.sql 의 「2026-09-22 확충 전」 판을 다시 실행한다.
--    (급하면 아래처럼 새 컬럼만 NULL 로 덮어 화면을 대기 표시로 되돌릴 수 있다)
-- create or replace view public.v_erp_pur_list ... (57 참조)

-- 2) ETL 이 공유 upsert 로 돌아가게 — etl_run.py 의 "rpc": "erp_etl_upsert_pur_order" 줄 제거

-- 3) 전용 함수 제거
drop function if exists public.erp_etl_upsert_pur_order(text, jsonb);

-- 4) 컬럼 제거 (적재된 값도 사라진다 — 정말 필요할 때만)
-- alter table erp_ro.pur_order_s
--   drop column if exists po_prc, drop column if exists dtl_remark, drop column if exists hdr_remark,
--   drop column if exists delivery_plce, drop column if exists sl_cd, drop column if exists agent_id,
--   drop column if exists applicant_id, drop column if exists insrt_user_id, drop column if exists po_type_cd,
--   drop column if exists ref_no, drop column if exists tracking_no;
