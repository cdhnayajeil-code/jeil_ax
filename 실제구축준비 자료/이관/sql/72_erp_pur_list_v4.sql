-- 72_erp_pur_list_v4.sql
-- 발주통합관리 LIST 뷰 v4 — 입고일을 「매입(송장)」에서 「실제 입고」로 (2026-09-23 · REQ-0080)
--
-- 66번(v3)을 대체한다. 조인·성능 구조는 그대로고, **컬럼이 늘기만 한다.**
--   ① `rcpt_last_dt`·`rcpt_first_dt`·`rcpt_cnt`·`rcpt_qty_sum` 추가
--      ← erp_ro.pur_goods_mvmt_s (ERP M_PUR_GOODS_MVMT) 를 발주 라인으로 집계
--   ② 기존 `iv_*`(매입 기준)는 **그대로 둔다** — 회계 대조에 쓰이고, 적재 전 대체값이기도 하다
--
-- 왜: 「입고일」이 매입(송장) 날짜라 실제 입고일과 며칠씩 어긋났다. ERP 는 실제 입고일을
--     `MVMT_RCPT_DT` 에 갖고 있고 같은 행의 `PO_NO`+`PO_SEQ_NO` 로 발주 라인과 직결된다.
--     구매요청 기준은 발주를 거쳐 닿는다(o.pr_no) — 요청→발주→입출고가 한 줄로 꿰진다.
--
-- ⚠ 적재 전에도 안전하다. left join 이라 테이블이 비어 있으면 rcpt_* 가 NULL 이고,
--    화면은 그때 종전대로 매입일을 「매입」 꼬리표와 함께 보여 준다.
--
-- ⚠ 입고 건수는 `rcpt_qty > 0` 인 행만 센다. 반품(IO_TYPE_CD 가 반품인 행)을 입고 횟수에
--    넣으면 「3회 입고」가 거짓이 된다. 유형코드 값을 단정하지 않고 수량으로 가린다.
--
-- 선행: 71_erp_pur_goods_mvmt.sql (테이블·권한·RLS)
-- 되돌리기: 72_erp_pur_list_v4_rollback.sql (66번 v3 를 다시 만든다)

create or replace view public.v_erp_pur_list with (security_invoker = true) as
with prj_ref as (
  -- 프로젝트명 사전: ref_cd 당 1행(PC 우선). 조인 전에 한 번만 만든다.
  select distinct on (ref_cd) ref_cd, ref_nm
    from erp_ro.ctrl_ref_s
   where ctrl_cd in ('PC', 'TK')
   order by ref_cd, case ctrl_cd when 'PC' then 0 else 1 end
)
select
  'PO'::text as row_kind, o.po_no, o.po_seq, o.pr_no,
  r.pu_no,                                               -- C 결재번호 ← 요청의 EXT1_CD (65번에서 연결)
  o.po_dt,
  coalesce(nullif(split_part(ag.usr_nm, '_', 2), ''), nullif(btrim(o.insrt_user_id), '')) as agent_nm,  -- F 담당자
  coalesce(nullif(btrim(o.tracking_no), ''), r.tracking_no) as p_code,   -- G 발주 기준 우선
  prj.ref_nm as prj_nm, o.bp_code,                       -- H 계약내역 · I 공급처
  coalesce(nullif(btrim(o.bp_name), ''), nullif(btrim(o.bp_code), '')) as bp_name,
  coalesce(r.dlvy_dt, o.dlvy_dt) as dlvy_dt,             -- K 입고요청일(요청 희망납기 우선)
  ivx.iv_last_dt, ivx.iv_first_dt, coalesce(ivx.iv_cnt, 0) as iv_cnt, ivx.iv_qty_sum,   -- 매입일(송장 기준) — 보조
  gmx.rcpt_last_dt, gmx.rcpt_first_dt, coalesce(gmx.rcpt_cnt, 0) as rcpt_cnt, gmx.rcpt_qty_sum,  -- L 입고일(실입고)
  nullif(btrim(wh.sl_nm), '') as whs_nm,                 -- M 입고창고(ERP 저장위치)
  nullif(btrim(o.hdr_remark), '') as hdr_remark,         -- N 비고
  o.item_code,                                           -- O 품번
  coalesce(nullif(o.item_name, ''), im.item_name) as item_name, im.spec,   -- P 품목명 · Q 규격
  o.po_qty as qty, nullif(btrim(o.po_unit), '') as unit, -- R 수량 · S 단위
  o.po_prc as price, o.po_amt as amt,                    -- T 단가 · U 금액
  coalesce(nullif(u.usr_nm, ''), r.req_prsn) as req_user_nm,   -- V 요청자
  nullif(btrim(o.dtl_remark), '') as dtl_remark,         -- W 적요
  case when o.item_code like 'ROS%' then '외주'
       else nullif(im.item_acct_nm, '') end as gubun,    -- B 구분
  im.item_class, im.item_acct_nm, o.subcontra_flg, o.po_sts, o.rcpt_qty,
  r.pr_sts, r.req_dt, r.req_qty,
  coalesce(nullif(r.req_dept, ''), split_part(u.usr_nm, '_', 1)) as req_dept,
  r.so_no, o.cls_flg,
  case
    when o.po_sts = 'IV' then '매입완료'
    when coalesce(o.po_qty, 0) > 0 and coalesce(o.rcpt_qty, 0) >= o.po_qty then '입고완료'
    when coalesce(o.rcpt_qty, 0) > 0 then '부분입고'
    else '발주'
  end as status_kr,
  false as is_unordered,
  (coalesce(o.rcpt_qty, 0) < coalesce(o.po_qty, 0)) as is_unreceived,
  (coalesce(o.rcpt_qty, 0) < coalesce(o.po_qty, 0) and o.dlvy_dt < current_date) as overdue_unreceived,
  o.synced_at,
  coalesce(o.po_dt, r.req_dt) as list_dt,                -- 기간 필터·기본 정렬 축
  o.dlvy_dt as po_dlvy_dt,                               -- 발주 납기(협력사 약속일)
  nullif(btrim(o.po_type_cd), '') as po_type_cd,         -- 발주유형(외주 판정 근거 되짚기)
  nullif(btrim(ag.usr_nm), '') as agent_full,            -- 담당자 전체 표기(툴팁)
  nullif(btrim(o.sl_cd), '') as whs_cd,                  -- 입고창고 코드(툴팁)
  r.req_title, r.dw_ref                                  -- 건명 · 도번/품명(요청 확장슬롯 EXT2·EXT3)
from erp_ro.pur_order_s o
left join erp_ro.pur_req_s     r   on r.pr_no = o.pr_no
left join public.v_erp_item    im  on im.item_code = o.item_code
left join erp_ro.usr_master_s  u   on lower(u.usr_id) = lower(r.req_prsn)
left join erp_ro.usr_master_s  ag  on lower(ag.usr_id) = lower(o.insrt_user_id)
left join erp_ro.wh_master_s   wh  on wh.sl_cd = o.sl_cd
left join prj_ref              prj on prj.ref_cd = coalesce(nullif(btrim(o.tracking_no), ''), r.tracking_no)
-- 입고일: 분할 매입은 라인당 여러 건이라 조인하면 1행이 여러 행이 된다 → 집계로 흡수
left join lateral (
  select min(iv.iv_dt) as iv_first_dt, max(iv.iv_dt) as iv_last_dt,
         count(*) as iv_cnt, sum(iv.iv_qty) as iv_qty_sum
  from erp_ro.iv_dtl_s iv
  where iv.po_no = o.po_no and iv.po_seq_no = o.po_seq
) ivx on true
-- 실제 입고일: 한 발주 라인에 분할 입고가 여러 건 → 매입과 같은 방식으로 집계해 1행으로 흡수
left join lateral (
  select min(g.rcpt_dt) as rcpt_first_dt, max(g.rcpt_dt) as rcpt_last_dt,
         count(*) as rcpt_cnt, sum(g.rcpt_qty) as rcpt_qty_sum
  from erp_ro.pur_goods_mvmt_s g
  where g.po_no = o.po_no and g.po_seq_no = o.po_seq
    and g.rcpt_dt is not null and coalesce(g.rcpt_qty, 0) > 0   -- 반품은 입고 횟수에서 뺀다
) gmx on true

union all

-- 발주가 아직 안 난 구매요청 (엑셀에서 PONO 가 빈칸·'-' 인 행)
select
  'PR'::text, null::text, null::integer, r.pr_no,
  r.pu_no, null::date, null::text,
  r.tracking_no, prj.ref_nm,
  nullif(btrim(r.sppl_code), ''),
  coalesce(nullif(btrim(r.sppl_name), ''), nullif(btrim(r.sppl_code), '')),
  r.dlvy_dt,
  null::date, null::date, 0, null::numeric,        -- 매입 집계(발주가 없으니 없다)
  null::date, null::date, 0, null::numeric,        -- 실입고 집계(발주가 없으니 없다)
  nullif(btrim(wh2.sl_nm), ''),                          -- 요청 납입장소
  null::text, r.item_code,
  coalesce(nullif(r.item_name, ''), im.item_name), im.spec,
  r.req_qty, nullif(btrim(r.req_unit), ''), null::numeric, null::numeric,
  coalesce(nullif(u.usr_nm, ''), r.req_prsn), null::text,
  case when r.item_code like 'ROS%' then '외주' else nullif(im.item_acct_nm, '') end,
  im.item_class, im.item_acct_nm,
  null::text, null::text, null::numeric,
  r.pr_sts, r.req_dt, r.req_qty,
  coalesce(nullif(r.req_dept, ''), split_part(u.usr_nm, '_', 1)),
  r.so_no, null::text, '미발주'::text,
  true, true,
  (r.dlvy_dt < current_date), r.synced_at,
  r.req_dt, null::date, null::text,
  null::text, nullif(btrim(r.sl_cd), ''),
  r.req_title, r.dw_ref
from erp_ro.pur_req_s r
left join public.v_erp_item   im  on im.item_code = r.item_code
left join erp_ro.usr_master_s u   on lower(u.usr_id) = lower(r.req_prsn)
left join erp_ro.wh_master_s  wh2 on wh2.sl_cd = r.sl_cd
left join prj_ref             prj on prj.ref_cd = r.tracking_no
where not exists (select 1 from erp_ro.pur_order_s o2 where o2.pr_no = r.pr_no);

comment on view public.v_erp_pur_list is
  '구매팀 발주통합관리 LIST(REQ-0069·0070·0071) — 발주 라인 + 발주 없는 구매요청. 엑셀 23칸 전부 대응. 담당자=등록자·외주=품번 ROS 접두·결재번호=M_PUR_REQ.EXT1_CD.';

grant select on public.v_erp_pur_list to authenticated, service_role;

-- ── 확인 ─────────────────────────────────────────────────────────────────────
-- select count(*) 전체, count(pu_no) 결재번호, count(distinct pu_no) 결재고유,
--        count(req_title) 건명, count(dw_ref) 도번, count(price) 단가, count(agent_nm) 담당자,
--        count(whs_nm) 입고창고, count(prj_nm) 계약내역
--   from public.v_erp_pur_list;   -- 5,611 / 5,301 / 1,133 / 5,396 / 3,441 / 4,618 / 4,618 / 5,607 / 5,607
-- select gubun, count(*) from public.v_erp_pur_list group by 1 order by 2 desc;
--   -- 원자재 2,769 · 부자재 1,376 · 외주 800 · 소모품 663  ↔ 엑셀 2,478 / 1,156 / 738 / 638
-- 소요시간은 62번 주석의 do 블록으로 잰다(반드시 authenticated 로).
