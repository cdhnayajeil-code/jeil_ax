-- 91_erp_pur_status_actual.sql
-- 발주 줄 상태를 실적(입고·매입 사본)으로 판정 — 발주 사본 입고수량·진행코드 갱신 지연 수정 (2026-10-07 · REQ-0110 · 결정 D-117 A안)
--
-- 왜: 발주 사본(erp_ro.pur_order_s)의 rcpt_qty·po_sts 는 입고가 등록돼도 갱신되지 않는다.
--     발주 적재(10_ERP_DB연계/etl/etl_run.py 의 pur_order)가 발주 머리 수정일(h.UPDT_DT) 기준으로 증분하는데,
--     입고·매입은 그 수정일을 바꾸지 않아 재추출되지 않는다.
--     2026-10-06 실측: 전량 입고된 182줄(발주 51건 · 그중 177줄은 매입까지 끝남)이 「발주 · 미입고 · 납기경과」로 표시.
--     같은 값을 쓰는 뷰 세 개 — v_erp_pur_list(발주통합 LIST · 에이전트 search_pur_list) ·
--     v_erp_pur_order_hdr(진행현황 · 외주 보드) · v_erp_po_pr_link(에이전트 미입고·발주 상세) — 가 함께 틀린다.
--     기록: 14_구매업무시스템/02 결함 ① · 10_ERP_DB연계/01 §4.18 · 02 진행상태.
--
-- 무엇: ① 상태 판정을 한 곳에 둔다 — public.v_erp_pur_line_status(발주 줄마다 실효 입고수량·진행코드·상태).
--       ② 세 뷰가 그 판정을 쓰도록 재정의한다. 기존 컬럼의 이름·타입·순서는 그대로(create or replace 호환 ·
--          v_pur_proposal_po_link 가 v_erp_pur_list 에 의존), 끝에 po_sts_raw·rcpt_qty_raw(발주 사본 원값)만 붙인다.
--     판정 규칙(14_구매업무시스템/03 §2 기준 2 — 「상태는 실적 문서의 존재로」):
--       실효 입고수량  = greatest(발주 사본 rcpt_qty, 입고 사본 합)   — 어느 쪽이 앞서든 큰 쪽(입고 사본이 비어도 종전대로)
--       실효 진행코드  = IV(매입 합 ≥ 발주수량 또는 사본이 IV) > GR(실효 입고 ≥ 발주수량 또는 사본이 GR) > 사본 값
--       status_kr      = 매입완료 / 입고완료 / 부분입고 / 발주  — 종전 4단계 그대로, 재료만 실적으로
--       is_unreceived  = 실효 입고수량 < 발주수량 · overdue_unreceived = 그것 AND 발주 납기 < 오늘
--     B안(적재 증분 기준 보완 — etl_run.py · EXE 재빌드)은 별건이다. 이 뷰가 먼저 서면 B안이 들어와도 결과는 같다.
--
-- ⚠ security_invoker 유지 — 하위 erp_ro RLS(internal)로 사내만 통과한다. 뷰 권한은 create or replace 로 보존되고,
--    새 판정 뷰에만 종전과 같게 부여한다.
-- ⚠ 입고 합은 72번과 같은 조건(rcpt_dt 있음 · rcpt_qty > 0)으로 센다 — 반품 행을 입고로 세지 않는다.
-- 선행: 71_erp_pur_goods_mvmt.sql · 72_erp_pur_list_v4.sql · 15 · 16
-- 되돌리기: 91_erp_pur_status_actual_rollback.sql (세 뷰를 72·16·15 정의로 복원한 뒤 판정 뷰 제거)

-- ── ① 발주 줄 상태 판정 — 한 곳 ──────────────────────────────────────────────
create or replace view public.v_erp_pur_line_status with (security_invoker = true) as
select
  o.po_no,
  o.po_seq,
  o.po_qty,
  o.dlvy_dt,
  o.po_sts   as po_sts_raw,            -- 발주 사본 원값(갱신 지연 확인용)
  o.rcpt_qty as rcpt_qty_raw,
  g.rcpt_first_dt, g.rcpt_last_dt, g.rcpt_cnt, g.rcpt_qty_sum,   -- 입고 사본 집계(72번 gmx 와 같은 조건)
  i.iv_first_dt,   i.iv_last_dt,   i.iv_cnt,   i.iv_qty_sum,     -- 매입 사본 집계(72번 ivx 와 같음)
  x.rcpt_qty::numeric(18,3) as rcpt_qty,   -- 실효 입고수량 — 원천 컬럼과 같은 타입(create or replace 호환: v_erp_po_pr_link.po_rcpt_qty 가 numeric(18,3))
  x.po_sts,                            -- 실효 진행코드 PO/GR/IV
  case when x.po_sts = 'IV'                                            then '매입완료'
       when coalesce(o.po_qty, 0) > 0 and x.rcpt_qty >= o.po_qty       then '입고완료'
       when x.rcpt_qty > 0                                              then '부분입고'
       else '발주' end                                                  as status_kr,
  (x.rcpt_qty < coalesce(o.po_qty, 0))                                  as is_unreceived,
  (x.rcpt_qty < coalesce(o.po_qty, 0) and o.dlvy_dt < current_date)     as overdue_unreceived
from erp_ro.pur_order_s o
left join (
  select po_no, po_seq_no, min(rcpt_dt) as rcpt_first_dt, max(rcpt_dt) as rcpt_last_dt,
         count(*) as rcpt_cnt, sum(rcpt_qty) as rcpt_qty_sum
    from erp_ro.pur_goods_mvmt_s
   where rcpt_dt is not null and coalesce(rcpt_qty, 0) > 0
   group by po_no, po_seq_no
) g on g.po_no = o.po_no and g.po_seq_no = o.po_seq
left join (
  select po_no, po_seq_no, min(iv_dt) as iv_first_dt, max(iv_dt) as iv_last_dt,
         count(*) as iv_cnt, sum(iv_qty) as iv_qty_sum
    from erp_ro.iv_dtl_s
   group by po_no, po_seq_no
) i on i.po_no = o.po_no and i.po_seq_no = o.po_seq
cross join lateral (
  select greatest(coalesce(o.rcpt_qty, 0), coalesce(g.rcpt_qty_sum, 0)) as rcpt_qty,
         case when o.po_sts = 'IV' or (coalesce(o.po_qty, 0) > 0 and coalesce(i.iv_qty_sum, 0) >= o.po_qty) then 'IV'
              when o.po_sts = 'GR' or (coalesce(o.po_qty, 0) > 0
                                       and greatest(coalesce(o.rcpt_qty, 0), coalesce(g.rcpt_qty_sum, 0)) >= o.po_qty) then 'GR'
              else coalesce(o.po_sts, 'PO') end as po_sts
) x;

comment on view public.v_erp_pur_line_status is
  '발주 줄 상태 판정(단일 정의 · REQ-0110) — 실효 입고수량 = greatest(발주 사본, 입고 사본 합), 진행코드 IV>GR>사본, status_kr·미입고·납기경과. 발주 사본의 rcpt_qty·po_sts 는 증분 적재에서 갱신되지 않으므로 직접 쓰지 않는다.';

grant select on public.v_erp_pur_line_status to authenticated, service_role;

-- ── ② 발주통합 LIST(v4 → v5) — 판정 뷰 사용 · 컬럼 끝에 원값 2개 추가 ──────────────
create or replace view public.v_erp_pur_list with (security_invoker = true) as
with prj_ref as (
  select distinct on (ref_cd) ref_cd, ref_nm
    from erp_ro.ctrl_ref_s
   where ctrl_cd in ('PC', 'TK')
   order by ref_cd, case ctrl_cd when 'PC' then 0 else 1 end
)
select
  'PO'::text as row_kind,
  o.po_no, o.po_seq, o.pr_no, r.pu_no, o.po_dt,
  coalesce(nullif(split_part(ag.usr_nm, '_', 2), ''), nullif(btrim(o.insrt_user_id), '')) as agent_nm,
  coalesce(nullif(btrim(o.tracking_no), ''), r.tracking_no)                                as p_code,
  prj.ref_nm                                                                                as prj_nm,
  o.bp_code,
  coalesce(nullif(btrim(o.bp_name), ''), nullif(btrim(o.bp_code), ''))                     as bp_name,
  coalesce(r.dlvy_dt, o.dlvy_dt)                                                            as dlvy_dt,
  st.iv_last_dt, st.iv_first_dt, coalesce(st.iv_cnt, 0::bigint) as iv_cnt, st.iv_qty_sum,
  st.rcpt_last_dt, st.rcpt_first_dt, coalesce(st.rcpt_cnt, 0::bigint) as rcpt_cnt, st.rcpt_qty_sum,
  nullif(btrim(wh.sl_nm), '')                                                               as whs_nm,
  nullif(btrim(o.hdr_remark), '')                                                           as hdr_remark,
  o.item_code,
  coalesce(nullif(o.item_name, ''), im.item_name)                                           as item_name,
  im.spec,
  o.po_qty                                                                                  as qty,
  nullif(btrim(o.po_unit), '')                                                              as unit,
  o.po_prc                                                                                  as price,
  o.po_amt                                                                                  as amt,
  coalesce(nullif(u.usr_nm, ''), r.req_prsn)                                                as req_user_nm,
  nullif(btrim(o.dtl_remark), '')                                                           as dtl_remark,
  case when o.item_code like 'ROS%' then '외주' else nullif(im.item_acct_nm, '') end          as gubun,
  im.item_class, im.item_acct_nm, o.subcontra_flg,
  st.po_sts,                                   -- 실효 진행코드(종전: 발주 사본 원값)
  st.rcpt_qty,                                 -- 실효 입고수량(종전: 발주 사본 원값)
  r.pr_sts, r.req_dt, r.req_qty,
  coalesce(nullif(r.req_dept, ''), split_part(u.usr_nm, '_', 1))                            as req_dept,
  r.so_no, o.cls_flg,
  st.status_kr,                                -- 종전과 같은 4단계 · 재료만 실적
  false                                                                                     as is_unordered,
  st.is_unreceived,
  st.overdue_unreceived,
  o.synced_at,
  coalesce(o.po_dt, r.req_dt)                                                               as list_dt,
  o.dlvy_dt                                                                                 as po_dlvy_dt,
  nullif(btrim(o.po_type_cd), '')                                                           as po_type_cd,
  nullif(btrim(ag.usr_nm), '')                                                              as agent_full,
  nullif(btrim(o.sl_cd), '')                                                                as whs_cd,
  r.req_title, r.dw_ref,
  st.po_sts_raw,                               -- 신규(끝에 추가) — 발주 사본 원값
  st.rcpt_qty_raw
from erp_ro.pur_order_s o
left join erp_ro.pur_req_s          r   on r.pr_no = o.pr_no
left join public.v_erp_item         im  on im.item_code = o.item_code
left join erp_ro.usr_master_s       u   on lower(u.usr_id) = lower(r.req_prsn)
left join erp_ro.usr_master_s       ag  on lower(ag.usr_id) = lower(o.insrt_user_id)
left join erp_ro.wh_master_s        wh  on wh.sl_cd = o.sl_cd
left join prj_ref                   prj on prj.ref_cd = coalesce(nullif(btrim(o.tracking_no), ''), r.tracking_no)
left join public.v_erp_pur_line_status st on st.po_no = o.po_no and st.po_seq = o.po_seq
union all
select
  'PR'::text,
  null::text, null::integer, r.pr_no, r.pu_no, null::date,
  null::text,
  r.tracking_no,
  prj.ref_nm,
  nullif(btrim(r.sppl_code), ''),
  coalesce(nullif(btrim(r.sppl_name), ''), nullif(btrim(r.sppl_code), '')),
  r.dlvy_dt,
  null::date, null::date, 0::bigint, null::numeric,
  null::date, null::date, 0::bigint, null::numeric,
  nullif(btrim(wh2.sl_nm), ''),
  null::text,
  r.item_code,
  coalesce(nullif(r.item_name, ''), im.item_name),
  im.spec,
  r.req_qty,
  nullif(btrim(r.req_unit), ''),
  null::numeric, null::numeric,
  coalesce(nullif(u.usr_nm, ''), r.req_prsn),
  null::text,
  case when r.item_code like 'ROS%' then '외주' else nullif(im.item_acct_nm, '') end,
  im.item_class, im.item_acct_nm, null::text,
  null::text,
  null::numeric,
  r.pr_sts, r.req_dt, r.req_qty,
  coalesce(nullif(r.req_dept, ''), split_part(u.usr_nm, '_', 1)),
  r.so_no, null::text,
  '미발주'::text,
  true, true,
  (r.dlvy_dt < current_date),
  r.synced_at,
  r.req_dt, null::date, null::text,
  null::text, nullif(btrim(r.sl_cd), ''),
  r.req_title, r.dw_ref,
  null::text,
  null::numeric
from erp_ro.pur_req_s r
left join public.v_erp_item   im  on im.item_code = r.item_code
left join erp_ro.usr_master_s u   on lower(u.usr_id) = lower(r.req_prsn)
left join erp_ro.wh_master_s  wh2 on wh2.sl_cd = r.sl_cd
left join prj_ref             prj on prj.ref_cd = r.tracking_no
where not exists (select 1 from erp_ro.pur_order_s o2 where o2.pr_no = r.pr_no);

comment on view public.v_erp_pur_list is
  '구매팀 발주통합관리 LIST(REQ-0069·0070·0071·0080·0110) — 발주 라인 + 발주 없는 구매요청. 엑셀 23칸 전부 대응. 담당자=등록자·외주=품번 ROS 접두·결재번호=M_PUR_REQ.EXT1_CD. 입고일은 실입고(rcpt_*) 기준이고 매입일(iv_*)은 보조. 상태·입고수량·미입고·납기경과는 v_erp_pur_line_status(실적 판정 · REQ-0110) — 발주 사본 원값은 po_sts_raw·rcpt_qty_raw.';

-- ── ③ 발주 헤더(진행현황 · 외주 보드) — 실효 입고수량·진행코드 ──────────────────────
create or replace view public.v_erp_pur_order_hdr with (security_invoker = true) as
select
  o.po_no,
  min(o.po_dt)            as po_dt,
  max(o.dlvy_dt)          as dlvy_dt,
  max(o.bp_code)          as bp_code,
  max(o.bp_name)          as bp_name,
  count(*)                as line_cnt,
  count(distinct o.item_name) as item_cnt,
  sum(o.po_amt)           as amt,
  sum(o.po_qty)           as po_qty,
  sum(st.rcpt_qty)        as rcpt_qty,          -- 실효 입고수량 합(종전: 발주 사본 원값 합)
  case min(case st.po_sts when 'IV' then 2 when 'GR' then 1 else 0 end)
       when 2 then 'IV' when 1 then 'GR' else 'PO' end as po_sts,   -- 줄 가운데 가장 뒤처진 실효 진행코드
  max(o.subcontra_flg)    as subcontra_flg,
  array_to_string((array_agg(distinct o.item_name order by o.item_name))[1:8], ', ') as items_txt,
  max(o.synced_at)        as synced_at,
  (array_agg(distinct so.so_no) filter (where so.so_no is not null))[1] as project_code,
  sum(o.rcpt_qty)         as rcpt_qty_raw,      -- 신규(끝에 추가) — 발주 사본 원값
  case min(case o.po_sts when 'IV' then 2 when 'GR' then 1 else 0 end)
       when 2 then 'IV' when 1 then 'GR' else 'PO' end as po_sts_raw
from erp_ro.pur_order_s o
left join lateral (
  select r.so_no from erp_ro.pur_req_s r
   where r.pr_no = o.pr_no and r.so_no is not null and r.so_no <> ''
   limit 1
) so on true
left join public.v_erp_pur_line_status st on st.po_no = o.po_no and st.po_seq = o.po_seq
where o.po_dt is not null
group by o.po_no;

-- ── ④ 발주↔구매요청 연결(에이전트 미입고·발주 상세) — 실효 값 ─────────────────────
create or replace view public.v_erp_po_pr_link with (security_invoker = true) as
select
  o.po_no, o.po_seq, o.pr_no, o.po_dt,
  o.bp_name       as po_vendor,
  o.item_code, o.item_name, o.po_qty, o.po_amt,
  st.po_sts,                                     -- 실효 진행코드
  o.dlvy_dt       as po_dlvy_dt,
  r.req_dt,
  r.dlvy_dt       as pr_dlvy_dt,
  r.req_qty, r.ord_qty, r.req_dept, r.req_prsn, r.pr_sts, r.pr_type,
  r.sppl_name     as pr_supplier,
  st.rcpt_qty     as po_rcpt_qty,                -- 실효 입고수량
  o.subcontra_flg, o.cls_flg,
  (st.po_sts = 'PO' and o.dlvy_dt < current_date and st.rcpt_qty < coalesce(o.po_qty, 0)) as overdue_unreceived,
  r.rcpt_qty      as pr_rcpt_qty,
  r.iv_qty,
  r.so_no,
  coalesce(nullif(r.req_dept, ''), u.dept_nm) as req_dept_resolved,
  o.po_sts        as po_sts_raw,                 -- 신규(끝에 추가) — 발주 사본 원값
  o.rcpt_qty      as rcpt_qty_raw
from erp_ro.pur_order_s o
left join erp_ro.pur_req_s       r  on r.pr_no = o.pr_no
left join public.v_erp_user_dept u  on lower(u.email) = lower(r.req_prsn)
left join public.v_erp_pur_line_status st on st.po_no = o.po_no and st.po_seq = o.po_seq;

comment on view public.v_erp_po_pr_link is
  'ERP 발주↔구매요청 연결 조회(사내 전용). PO번호·PR번호 어느 쪽으로도 조회. 진행코드·입고수량·납기경과는 v_erp_pur_line_status(실적 판정 · REQ-0110), 발주 사본 원값은 po_sts_raw·rcpt_qty_raw.';

-- ── 확인(적용 뒤) ───────────────────────────────────────────────────────────────
-- 1) 상태 분포 — 전량 입고됐는데 「발주」인 줄이 0 이어야 한다
-- select status_kr, count(*) from public.v_erp_pur_list where row_kind = 'PO' group by 1 order by 2 desc;
-- select count(*) from public.v_erp_pur_list
--  where row_kind = 'PO' and status_kr = '발주' and coalesce(rcpt_qty_sum, 0) >= qty and qty > 0;   -- 0
-- 2) 원값과 실효값이 다른 줄 = 갱신 지연분(적용 당시 182줄 · 발주 51건). 야간 전량 적재 뒤에도 남으면 B안 필요
-- select count(*), count(distinct po_no) from public.v_erp_pur_list
--  where row_kind = 'PO' and (po_sts <> po_sts_raw or rcpt_qty <> coalesce(rcpt_qty_raw, 0));
-- 3) 소요시간은 62번 주석의 do 블록으로 잰다(반드시 authenticated 로) — v4 와 같은 수준(0.1~0.2초)이어야 한다.
