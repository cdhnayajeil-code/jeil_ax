-- 15_erp_process_link_enrich.sql
-- 중간DB 노출 뷰 3종 보강 — 발주·구매요청·매입·입고 "프로세스 진행" 조회 품질 개선(챗봇 jeil-chat 응대 개선용)
-- 적용일 2026-07-08 · Supabase 마이그레이션: erp_process_link_enrich
-- 배경: jeil-chat 도구 오케스트레이션을 멀티라운드로 교체(index.ts, version 14)하면서, 도구가 돌려주는
--   발주/구매요청 데이터에 입고·매입 진행수량과 상태 해석에 필요한 신호(외주구분·납기경과·연결수주·요청부서)가
--   부족했던 것을 함께 보강. 기존 컬럼 순서·타입은 그대로 두고 뒤에 append만 한다(하위 호환).
--   검증: 확장 후에도 v_erp_po_pr_link 행수 불변(2,703행) — LEFT JOIN 추가로 인한 조인 뻥튀기 없음 확인.
-- 원칙(CLAUDE.md §4): erp_ro/etl_meta는 REST 비노출. 노출 진입점은 public.v_erp_* 뷰(security_invoker + RLS)뿐.
-- 재현/이관용 정본 — apply_migration으로 적용된 DDL의 사본.

-- ─────────────────────────────────────────────────────────────────────────
-- ① v_erp_po_pr_link — 기존 20컬럼(09_erp_user_dept_mapping.sql 이후 10_erp_pur_req.sql 기준) 뒤에
--    입고/매입 진행수량·외주구분·납기경과 플래그·연결수주·요청부서(이메일 해석) 8컬럼 append
-- ─────────────────────────────────────────────────────────────────────────
create or replace view public.v_erp_po_pr_link with (security_invoker=true) as
  select
    -- 기존 20컬럼(순서·타입 보존)
    o.po_no, o.po_seq, o.pr_no, o.po_dt, o.bp_name as po_vendor, o.item_code, o.item_name,
    o.po_qty, o.po_amt, o.po_sts, o.dlvy_dt as po_dlvy_dt,
    r.req_dt, r.dlvy_dt as pr_dlvy_dt, r.req_qty, r.ord_qty,
    r.req_dept, r.req_prsn, r.pr_sts, r.pr_type, r.sppl_name as pr_supplier,
    -- 신규 append(2026-07-08)
    o.rcpt_qty                                                        as po_rcpt_qty,      -- 발주 입고수량
    o.subcontra_flg,
    o.cls_flg,
    (o.po_sts = 'PO' and o.dlvy_dt < current_date and o.rcpt_qty < o.po_qty) as overdue_unreceived, -- 납기경과·미입고
    r.rcpt_qty                                                        as pr_rcpt_qty,      -- 구매요청 입고수량
    r.iv_qty,                                                                              -- 매입(송장)수량
    r.so_no,                                                                               -- 연결 수주
    coalesce(nullif(r.req_dept, ''), ud.dept_nm)                      as req_dept_resolved  -- 요청부서(공란이면 요청자 이메일→부서 매핑으로 보완)
  from erp_ro.pur_order_s o
  left join erp_ro.pur_req_s r on r.pr_no = o.pr_no
  left join erp_ro.v_user_dept ud on ud.email = r.req_prsn;

-- ─────────────────────────────────────────────────────────────────────────
-- ② v_erp_pur_req — req_dept_resolved 1컬럼 append(동일 이메일→부서 해석)
-- ─────────────────────────────────────────────────────────────────────────
create or replace view public.v_erp_pur_req with (security_invoker=true) as
  select
    r.pr_no, r.pr_type, r.pr_sts, r.item_code, r.item_name, r.req_qty, r.req_unit, r.ord_qty, r.rcpt_qty, r.iv_qty,
    r.req_dt, r.dlvy_dt, r.pur_plan_dt, r.req_dept, r.req_prsn, r.sppl_code, r.sppl_name, r.so_no, r.synced_at,
    coalesce(nullif(r.req_dept, ''), ud.dept_nm) as req_dept_resolved
  from erp_ro.pur_req_s r
  left join erp_ro.v_user_dept ud on ud.email = r.req_prsn;

-- ─────────────────────────────────────────────────────────────────────────
-- ③ v_erp_pur_top_po(신규) — 발주번호(po_no) 단위 총액 집계. 기존 v_erp_pur_order(라인기준)는
--    "최대/상위(top) 발주" 질의 시 동일 PO가 라인 수만큼 중복 등장하고 총액 순위가 틀리는 문제가 있었음.
-- ─────────────────────────────────────────────────────────────────────────
create or replace view public.v_erp_pur_top_po with (security_invoker=true) as
  select
    o.po_no,
    min(o.po_dt)                                                 as po_dt,
    max(o.bp_name)                                                as po_vendor,
    count(*)                                                      as line_cnt,
    sum(o.po_amt)                                                 as po_total,
    (array_agg(o.item_name order by o.po_amt desc nulls last))[1] as top_item,
    max(o.pr_no)                                                  as pr_no,
    bool_or(o.po_sts <> 'IV')                                     as has_open_line   -- 매입(IV)완료 전 라인이 하나라도 있으면 true
  from erp_ro.pur_order_s o
  group by o.po_no;

grant select on public.v_erp_pur_top_po to anon, authenticated, service_role;
-- 참고: security_invoker + erp_ro.pur_order_s RLS(internal만 SELECT 권한)로 실제 데이터 접근은
--   여전히 사내(internal) 세션에서만 가능(anon/vendor는 기저 테이블 권한 없음 → 조회 시 차단).

-- ── 검증(참고, 적용 시 확인됨) ────────────────────────────────────────────
--   select count(*) from public.v_erp_po_pr_link;                          -- 2,703행(보강 전과 동일, 뻥튀기 없음)
--   select po_no, po_total, line_cnt, has_open_line from public.v_erp_pur_top_po order by po_total desc limit 5;
--   select count(*) from public.v_erp_po_pr_link where overdue_unreceived; -- 납기경과·미입고 발주 건수

-- ── 롤백(필요 시) ──────────────────────────────────────────────────────
-- drop view if exists public.v_erp_pur_top_po;
-- 아래 2건은 append 이전 버전(10_erp_pur_req.sql §③)으로 되돌리는 create or replace 재적용 방식으로 롤백
