-- 71_erp_pur_goods_mvmt_rollback.sql — 71번 되돌리기 (REQ-0080)
--
-- ⚠ 순서 주의: 뷰(72번)가 이 테이블을 읽는다. **72 를 먼저 되돌린 뒤** 이 파일을 실행한다.
--   그러지 않으면 `cannot drop table … because other objects depend on it` 로 막힌다
--   (막히는 편이 안전하다 — 뷰가 깨진 채로 남지 않는다).
--
-- 적재된 행도 함께 사라진다. 다시 채우려면 ETL `--job pur_goods_mvmt --full` 을 돌린다.

drop function if exists public.erp_etl_upsert_pur_goods_mvmt(jsonb);

drop policy if exists internal_select_pur_goods_mvmt on erp_ro.pur_goods_mvmt_s;

drop index if exists erp_ro.ix_pur_goods_mvmt_rcpt_dt;
drop index if exists erp_ro.ix_pur_goods_mvmt_po;

drop table if exists erp_ro.pur_goods_mvmt_s;   -- restrict(기본) — 뷰가 남아 있으면 일부러 막힌다
