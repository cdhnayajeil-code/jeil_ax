-- 71_erp_pur_goods_mvmt.sql — 입출고(실입고) 미러 테이블 신설 (REQ-0080 · 2026-09-23)
--
-- 왜: 「입고일」이 지금은 **매입(송장) 날짜**다. 물건이 들어온 날이 아니라 세금계산서가 끊긴
--     날이라 며칠씩 어긋난다. ERP 는 실제 입고일을 `M_PUR_GOODS_MVMT.MVMT_RCPT_DT` 에 갖고
--     있고, 같은 행의 `PO_NO`+`PO_SEQ_NO` 로 발주 라인과 **직접** 이어진다.
--     구매요청 기준은 발주를 거쳐 닿는다(pur_order_s.pr_no) — 요청→발주→입출고가 한 줄로 꿰진다.
--
-- 안전: 테이블을 **새로 만들기만** 한다. 기존 테이블·뷰·정책을 건드리지 않는다.
--       뷰(72번)가 left join 으로 붙으므로 적재 전(빈 테이블)에도 화면은 종전대로 돈다.
--
-- 적용 순서: 71 → 72(뷰) → ETL 적재(관리자, §17.5). 되돌리기는 71_..._rollback.sql
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists erp_ro.pur_goods_mvmt_s (
  mvmt_no        text primary key,          -- 입출고 번호 (ERP M_PUR_GOODS_MVMT.MVMT_NO, PK)
  po_no          text,                      -- Ref PO번호     → pur_order_s.po_no
  po_seq_no      integer,                   -- Ref PO SEQ번호 → pur_order_s.po_seq
  item_code      text,
  io_type_cd     text,                      -- 입출고유형 (입고/반품 구분)
  mvmt_dt        date,                      -- 입출고일
  rcpt_dt        date,                      -- ★ 입고일 (MVMT_RCPT_DT) — 이 건을 위해 가져온다
  rcpt_qty       numeric,                   -- 입고수량
  rcpt_sl_cd     text,                      -- 입고창고 → wh_master_s.sl_cd
  mvmt_qty       numeric,                   -- 재고 POSTING 수량
  inspect_req_no text,                      -- 검사요청번호 (향후 Q_INSPECTION 연계용)
  src_updated    timestamptz,               -- ERP UPDT_DT (증분 watermark)
  synced_at      timestamptz default now(),
  batch_id       text
);

comment on table erp_ro.pur_goods_mvmt_s is
  'ERP 입출고(M_PUR_GOODS_MVMT) 미러 — 발주 라인(po_no+po_seq_no)별 실제 입고일. REQ-0080';
comment on column erp_ro.pur_goods_mvmt_s.rcpt_dt is
  '실제 입고일(MVMT_RCPT_DT). 매입일(iv_dtl_s.iv_dt)과 다르다 — 매입은 송장 기준';

-- 뷰가 발주 라인으로 집계하므로 그 축에 인덱스를 둔다
create index if not exists ix_pur_goods_mvmt_po
  on erp_ro.pur_goods_mvmt_s (po_no, po_seq_no);
create index if not exists ix_pur_goods_mvmt_rcpt_dt
  on erp_ro.pur_goods_mvmt_s (rcpt_dt);

-- ── 권한 ──
-- authenticated 에 SELECT 가 없으면 화면이 「permission denied for table …」 로 떨어진다(2026-09-23 실제 사고).
grant select on erp_ro.pur_goods_mvmt_s to authenticated;
grant select on erp_ro.pur_goods_mvmt_s to service_role;

-- ── RLS ──
-- ⚠ 술어를 `(select …)` 로 **감싼다.** 안 감싸면 행마다 재계산되고 행 추정이 무너져
--   조회가 100배 느려진다(2026-09-22 실측: 63초 → 0.46초). erp_ro 17종이 모두 이 모양이다.
alter table erp_ro.pur_goods_mvmt_s enable row level security;

drop policy if exists internal_select_pur_goods_mvmt on erp_ro.pur_goods_mvmt_s;
create policy internal_select_pur_goods_mvmt on erp_ro.pur_goods_mvmt_s
  for select to authenticated
  using ((select public.is_internal()));

-- ── ETL 적재 경로 ──
-- 공용 RPC `erp_etl_upsert(p_table, p_rows)` 는 테이블마다 if/elsif 가지가 달린 한 덩어리 함수다.
-- 거기에 가지를 더하려면 **19개 job 이 함께 쓰는 함수를 통째로 다시 써야** 하고, 그 과정에서
-- 다른 가지를 건드릴 위험이 있다. 그래서 이 job 은 **전용 RPC** 를 둔다 —
-- `pur_order`(REQ-0070)가 컬럼이 늘었을 때 택한 방식과 같다.
create or replace function public.erp_etl_upsert_pur_goods_mvmt(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare n integer := 0;
begin
  insert into erp_ro.pur_goods_mvmt_s (
    mvmt_no, po_no, po_seq_no, item_code, io_type_cd,
    mvmt_dt, rcpt_dt, rcpt_qty, rcpt_sl_cd, mvmt_qty, inspect_req_no,
    src_updated, synced_at
  )
  select x.mvmt_no, x.po_no, x.po_seq_no, x.item_code, x.io_type_cd,
         x.mvmt_dt, x.rcpt_dt, x.rcpt_qty, x.rcpt_sl_cd, x.mvmt_qty, x.inspect_req_no,
         x.src_updated, now()
  from jsonb_to_recordset(p_rows) as x(
    mvmt_no text, po_no text, po_seq_no integer, item_code text, io_type_cd text,
    mvmt_dt date, rcpt_dt date, rcpt_qty numeric, rcpt_sl_cd text, mvmt_qty numeric,
    inspect_req_no text, src_updated timestamptz
  )
  where x.mvmt_no is not null
  on conflict (mvmt_no) do update set
    po_no = excluded.po_no, po_seq_no = excluded.po_seq_no,
    item_code = excluded.item_code, io_type_cd = excluded.io_type_cd,
    mvmt_dt = excluded.mvmt_dt, rcpt_dt = excluded.rcpt_dt,
    rcpt_qty = excluded.rcpt_qty, rcpt_sl_cd = excluded.rcpt_sl_cd,
    mvmt_qty = excluded.mvmt_qty, inspect_req_no = excluded.inspect_req_no,
    src_updated = excluded.src_updated, synced_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.erp_etl_upsert_pur_goods_mvmt(jsonb) from public, anon, authenticated;
grant execute on function public.erp_etl_upsert_pur_goods_mvmt(jsonb) to service_role;

-- ── 적용 후 확인 ──
-- select count(*) from erp_ro.pur_goods_mvmt_s;                       -- 적재 전 0
-- select tablename, policyname, qual from pg_policies
--  where schemaname='erp_ro' and tablename='pur_goods_mvmt_s';        -- (select is_internal()) 모양인지
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema='erp_ro' and table_name='pur_goods_mvmt_s';     -- authenticated SELECT 있는지
