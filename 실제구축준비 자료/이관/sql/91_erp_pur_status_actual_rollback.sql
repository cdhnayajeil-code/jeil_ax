-- 91_erp_pur_status_actual_rollback.sql
-- 91번 되돌리기 — 세 뷰를 적용 직전 정의(72 v4 · 16 · 15 — 2026-10-07 라이브 pg_get_viewdef 그대로)로 복원한 뒤
-- 판정 뷰 v_erp_pur_line_status 를 제거한다. 순서 주의: 세 뷰가 판정 뷰에 의존하므로 복원이 먼저다.
-- 권한은 create or replace 로 보존된다. security_invoker 유지.

-- ① 발주통합 LIST — 72번 v4 정의(발주 사본 원값으로 판정)
create or replace view public.v_erp_pur_list with (security_invoker = true) as
 WITH prj_ref AS (
         SELECT DISTINCT ON (ctrl_ref_s.ref_cd) ctrl_ref_s.ref_cd,
            ctrl_ref_s.ref_nm
           FROM erp_ro.ctrl_ref_s
          WHERE ctrl_ref_s.ctrl_cd = ANY (ARRAY['PC'::text, 'TK'::text])
          ORDER BY ctrl_ref_s.ref_cd, (
                CASE ctrl_ref_s.ctrl_cd
                    WHEN 'PC'::text THEN 0
                    ELSE 1
                END)
        )
 SELECT 'PO'::text AS row_kind,
    o.po_no,
    o.po_seq,
    o.pr_no,
    r.pu_no,
    o.po_dt,
    COALESCE(NULLIF(split_part(ag.usr_nm, '_'::text, 2), ''::text), NULLIF(btrim(o.insrt_user_id), ''::text)) AS agent_nm,
    COALESCE(NULLIF(btrim(o.tracking_no), ''::text), r.tracking_no) AS p_code,
    prj.ref_nm AS prj_nm,
    o.bp_code,
    COALESCE(NULLIF(btrim(o.bp_name), ''::text), NULLIF(btrim(o.bp_code), ''::text)) AS bp_name,
    COALESCE(r.dlvy_dt, o.dlvy_dt) AS dlvy_dt,
    ivx.iv_last_dt,
    ivx.iv_first_dt,
    COALESCE(ivx.iv_cnt, 0::bigint) AS iv_cnt,
    ivx.iv_qty_sum,
    gmx.rcpt_last_dt,
    gmx.rcpt_first_dt,
    COALESCE(gmx.rcpt_cnt, 0::bigint) AS rcpt_cnt,
    gmx.rcpt_qty_sum,
    NULLIF(btrim(wh.sl_nm), ''::text) AS whs_nm,
    NULLIF(btrim(o.hdr_remark), ''::text) AS hdr_remark,
    o.item_code,
    COALESCE(NULLIF(o.item_name, ''::text), im.item_name) AS item_name,
    im.spec,
    o.po_qty AS qty,
    NULLIF(btrim(o.po_unit), ''::text) AS unit,
    o.po_prc AS price,
    o.po_amt AS amt,
    COALESCE(NULLIF(u.usr_nm, ''::text), r.req_prsn) AS req_user_nm,
    NULLIF(btrim(o.dtl_remark), ''::text) AS dtl_remark,
        CASE
            WHEN o.item_code ~~ 'ROS%'::text THEN '외주'::text
            ELSE NULLIF(im.item_acct_nm, ''::text)
        END AS gubun,
    im.item_class,
    im.item_acct_nm,
    o.subcontra_flg,
    o.po_sts,
    o.rcpt_qty,
    r.pr_sts,
    r.req_dt,
    r.req_qty,
    COALESCE(NULLIF(r.req_dept, ''::text), split_part(u.usr_nm, '_'::text, 1)) AS req_dept,
    r.so_no,
    o.cls_flg,
        CASE
            WHEN o.po_sts = 'IV'::text THEN '매입완료'::text
            WHEN COALESCE(o.po_qty, 0::numeric) > 0::numeric AND COALESCE(o.rcpt_qty, 0::numeric) >= o.po_qty THEN '입고완료'::text
            WHEN COALESCE(o.rcpt_qty, 0::numeric) > 0::numeric THEN '부분입고'::text
            ELSE '발주'::text
        END AS status_kr,
    false AS is_unordered,
    COALESCE(o.rcpt_qty, 0::numeric) < COALESCE(o.po_qty, 0::numeric) AS is_unreceived,
    COALESCE(o.rcpt_qty, 0::numeric) < COALESCE(o.po_qty, 0::numeric) AND o.dlvy_dt < CURRENT_DATE AS overdue_unreceived,
    o.synced_at,
    COALESCE(o.po_dt, r.req_dt) AS list_dt,
    o.dlvy_dt AS po_dlvy_dt,
    NULLIF(btrim(o.po_type_cd), ''::text) AS po_type_cd,
    NULLIF(btrim(ag.usr_nm), ''::text) AS agent_full,
    NULLIF(btrim(o.sl_cd), ''::text) AS whs_cd,
    r.req_title,
    r.dw_ref,
    o.po_sts AS po_sts_raw,      -- 91번이 끝에 붙인 두 컬럼은 create or replace 가 지우지 못해 그대로 둔다(원값 = 종전 값)
    o.rcpt_qty AS rcpt_qty_raw
   FROM erp_ro.pur_order_s o
     LEFT JOIN erp_ro.pur_req_s r ON r.pr_no = o.pr_no
     LEFT JOIN v_erp_item im ON im.item_code = o.item_code
     LEFT JOIN erp_ro.usr_master_s u ON lower(u.usr_id) = lower(r.req_prsn)
     LEFT JOIN erp_ro.usr_master_s ag ON lower(ag.usr_id) = lower(o.insrt_user_id)
     LEFT JOIN erp_ro.wh_master_s wh ON wh.sl_cd = o.sl_cd
     LEFT JOIN prj_ref prj ON prj.ref_cd = COALESCE(NULLIF(btrim(o.tracking_no), ''::text), r.tracking_no)
     LEFT JOIN LATERAL ( SELECT min(iv.iv_dt) AS iv_first_dt,
            max(iv.iv_dt) AS iv_last_dt,
            count(*) AS iv_cnt,
            sum(iv.iv_qty) AS iv_qty_sum
           FROM erp_ro.iv_dtl_s iv
          WHERE iv.po_no = o.po_no AND iv.po_seq_no = o.po_seq) ivx ON true
     LEFT JOIN LATERAL ( SELECT min(g.rcpt_dt) AS rcpt_first_dt,
            max(g.rcpt_dt) AS rcpt_last_dt,
            count(*) AS rcpt_cnt,
            sum(g.rcpt_qty) AS rcpt_qty_sum
           FROM erp_ro.pur_goods_mvmt_s g
          WHERE g.po_no = o.po_no AND g.po_seq_no = o.po_seq AND g.rcpt_dt IS NOT NULL AND COALESCE(g.rcpt_qty, 0::numeric) > 0::numeric) gmx ON true
UNION ALL
 SELECT 'PR'::text AS row_kind,
    NULL::text AS po_no,
    NULL::integer AS po_seq,
    r.pr_no,
    r.pu_no,
    NULL::date AS po_dt,
    NULL::text AS agent_nm,
    r.tracking_no AS p_code,
    prj.ref_nm AS prj_nm,
    NULLIF(btrim(r.sppl_code), ''::text) AS bp_code,
    COALESCE(NULLIF(btrim(r.sppl_name), ''::text), NULLIF(btrim(r.sppl_code), ''::text)) AS bp_name,
    r.dlvy_dt,
    NULL::date AS iv_last_dt,
    NULL::date AS iv_first_dt,
    0 AS iv_cnt,
    NULL::numeric AS iv_qty_sum,
    NULL::date AS rcpt_last_dt,
    NULL::date AS rcpt_first_dt,
    0 AS rcpt_cnt,
    NULL::numeric AS rcpt_qty_sum,
    NULLIF(btrim(wh2.sl_nm), ''::text) AS whs_nm,
    NULL::text AS hdr_remark,
    r.item_code,
    COALESCE(NULLIF(r.item_name, ''::text), im.item_name) AS item_name,
    im.spec,
    r.req_qty AS qty,
    NULLIF(btrim(r.req_unit), ''::text) AS unit,
    NULL::numeric AS price,
    NULL::numeric AS amt,
    COALESCE(NULLIF(u.usr_nm, ''::text), r.req_prsn) AS req_user_nm,
    NULL::text AS dtl_remark,
        CASE
            WHEN r.item_code ~~ 'ROS%'::text THEN '외주'::text
            ELSE NULLIF(im.item_acct_nm, ''::text)
        END AS gubun,
    im.item_class,
    im.item_acct_nm,
    NULL::text AS subcontra_flg,
    NULL::text AS po_sts,
    NULL::numeric AS rcpt_qty,
    r.pr_sts,
    r.req_dt,
    r.req_qty,
    COALESCE(NULLIF(r.req_dept, ''::text), split_part(u.usr_nm, '_'::text, 1)) AS req_dept,
    r.so_no,
    NULL::text AS cls_flg,
    '미발주'::text AS status_kr,
    true AS is_unordered,
    true AS is_unreceived,
    r.dlvy_dt < CURRENT_DATE AS overdue_unreceived,
    r.synced_at,
    r.req_dt AS list_dt,
    NULL::date AS po_dlvy_dt,
    NULL::text AS po_type_cd,
    NULL::text AS agent_full,
    NULLIF(btrim(r.sl_cd), ''::text) AS whs_cd,
    r.req_title,
    r.dw_ref,
    NULL::text AS po_sts_raw,
    NULL::numeric AS rcpt_qty_raw
   FROM erp_ro.pur_req_s r
     LEFT JOIN v_erp_item im ON im.item_code = r.item_code
     LEFT JOIN erp_ro.usr_master_s u ON lower(u.usr_id) = lower(r.req_prsn)
     LEFT JOIN erp_ro.wh_master_s wh2 ON wh2.sl_cd = r.sl_cd
     LEFT JOIN prj_ref prj ON prj.ref_cd = r.tracking_no
  WHERE NOT (EXISTS ( SELECT 1
           FROM erp_ro.pur_order_s o2
          WHERE o2.pr_no = r.pr_no));

comment on view public.v_erp_pur_list is
  '구매팀 발주통합관리 LIST — 발주 라인 + 발주 없는 구매요청. 엑셀 23칸 대응. 담당자=등록자·외주=품번 ROS 접두·결재번호=M_PUR_REQ.EXT1_CD. 입고일은 실입고(rcpt_*, M_PUR_GOODS_MVMT) 기준이고 매입일(iv_*)은 보조 — REQ-0080.';

-- ② 발주 헤더 — 16번 정의
create or replace view public.v_erp_pur_order_hdr with (security_invoker = true) as
 SELECT o.po_no,
    min(o.po_dt) AS po_dt,
    max(o.dlvy_dt) AS dlvy_dt,
    max(o.bp_code) AS bp_code,
    max(o.bp_name) AS bp_name,
    count(*) AS line_cnt,
    count(DISTINCT o.item_name) AS item_cnt,
    sum(o.po_amt) AS amt,
    sum(o.po_qty) AS po_qty,
    sum(o.rcpt_qty) AS rcpt_qty,
        CASE min(
            CASE o.po_sts
                WHEN 'IV'::text THEN 2
                WHEN 'GR'::text THEN 1
                ELSE 0
            END)
            WHEN 2 THEN 'IV'::text
            WHEN 1 THEN 'GR'::text
            ELSE 'PO'::text
        END AS po_sts,
    max(o.subcontra_flg) AS subcontra_flg,
    array_to_string((array_agg(DISTINCT o.item_name ORDER BY o.item_name))[1:8], ', '::text) AS items_txt,
    max(o.synced_at) AS synced_at,
    (array_agg(DISTINCT so.so_no) FILTER (WHERE so.so_no IS NOT NULL))[1] AS project_code,
    sum(o.rcpt_qty) AS rcpt_qty_raw,
        CASE min(
            CASE o.po_sts
                WHEN 'IV'::text THEN 2
                WHEN 'GR'::text THEN 1
                ELSE 0
            END)
            WHEN 2 THEN 'IV'::text
            WHEN 1 THEN 'GR'::text
            ELSE 'PO'::text
        END AS po_sts_raw
   FROM erp_ro.pur_order_s o
     LEFT JOIN LATERAL ( SELECT r.so_no
           FROM erp_ro.pur_req_s r
          WHERE r.pr_no = o.pr_no AND r.so_no IS NOT NULL AND r.so_no <> ''::text
         LIMIT 1) so ON true
  WHERE o.po_dt IS NOT NULL
  GROUP BY o.po_no;

-- ③ 발주↔구매요청 연결 — 15번 정의
create or replace view public.v_erp_po_pr_link with (security_invoker = true) as
 SELECT o.po_no,
    o.po_seq,
    o.pr_no,
    o.po_dt,
    o.bp_name AS po_vendor,
    o.item_code,
    o.item_name,
    o.po_qty,
    o.po_amt,
    o.po_sts,
    o.dlvy_dt AS po_dlvy_dt,
    r.req_dt,
    r.dlvy_dt AS pr_dlvy_dt,
    r.req_qty,
    r.ord_qty,
    r.req_dept,
    r.req_prsn,
    r.pr_sts,
    r.pr_type,
    r.sppl_name AS pr_supplier,
    o.rcpt_qty AS po_rcpt_qty,
    o.subcontra_flg,
    o.cls_flg,
    o.po_sts = 'PO'::text AND o.dlvy_dt < CURRENT_DATE AND COALESCE(o.rcpt_qty, 0::numeric) < COALESCE(o.po_qty, 0::numeric) AS overdue_unreceived,
    r.rcpt_qty AS pr_rcpt_qty,
    r.iv_qty,
    r.so_no,
    COALESCE(NULLIF(r.req_dept, ''::text), u.dept_nm) AS req_dept_resolved,
    o.po_sts AS po_sts_raw,
    o.rcpt_qty AS rcpt_qty_raw
   FROM erp_ro.pur_order_s o
     LEFT JOIN erp_ro.pur_req_s r ON r.pr_no = o.pr_no
     LEFT JOIN v_erp_user_dept u ON lower(u.email) = lower(r.req_prsn);

comment on view public.v_erp_po_pr_link is
  'ERP 발주↔구매요청 연결 조회(사내 전용). PO번호·PR번호 어느 쪽으로도 조회.';

-- ④ 판정 뷰 제거(의존이 풀린 뒤)
drop view if exists public.v_erp_pur_line_status;
