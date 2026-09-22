-- 61_erp_pur_list_v2.sql
-- 발주통합관리 LIST 뷰 v2 — 적재 후 판정 반영 (2026-09-22 · REQ-0070)
--
-- 57번(1차 정의)을 대체한다. 2026-09-22 `--full` 백필(4,618행) 뒤 미러에서 가린 결과:
--
--   F 담당자  = **INSRT_USER_ID(등록자)**
--               AGENT 전건 빈값 · APPLICANT 전건 'CKOET00174'(법인코드) · 등록자 분포가 엑셀과 일치
--               (장민지 2,067·정희원 1,900·김윤정 383·박태랑 223 ↔ 엑셀 2,138·2,029·506·266)
--               usr_master_s 로 '부서명_이름[(퇴사)]' → 이름만 쓰고 전체는 agent_full(툴팁)
--   M 입고창고 = **DTL.SL_CD → wh_master_s.sl_nm**. HDR.DELIVERY_PLCE 는 전건 빈값이었다.
--               ⚠ 엑셀 「입고처」(본사·이천 2공장·협력사명)와 **다른 개념** — 그쪽 값은 ERP 에 없다.
--   B 외주    = **품번 ROS 접두**(발주 578 + 미발주 요청 221 = 799 ↔ 엑셀 738)
--               SUBCONTRA_FLG 는 전건 'N' 이라 못 쓴다. 발주유형 SE1·SF(514)의 품번도 512행이 ROS 라
--               같은 것을 가리키지만, ROS 규칙은 **발주 전 요청에도 적용**돼 목록 전체를 덮는다.
--   C 결재번호 = **여전히 미확인**. REF_NO 는 전건 빈값이라 후보에서 탈락 → pu_no 는 NULL 유지.
--               남은 추적은 `10_ERP_DB연계/etl/sql/ERP원천조사_구매.sql §4~§5`(관리자 실행).
--   T/N/W    = 단가 4,618 · 비고 2,713 · 적요 3,234 로 채워졌다.
--
-- 컬럼 순서가 바뀌고(agent_full·whs_cd 추가) 늘 빈 컬럼(ref_no)을 빼므로 replace 가 아니라 재생성한다.
-- 이 뷰에 의존하는 DB 객체는 없다(화면·api 만 읽는다).
--
-- 되돌리기: 57번을 다시 실행하면 1차 정의로 돌아간다(신규 컬럼은 NULL 로 보인다).

drop view if exists public.v_erp_pur_list;

create view public.v_erp_pur_list with (security_invoker = true) as
select
  'PO'::text as row_kind, o.po_no, o.po_seq, o.pr_no,
  null::text as pu_no,                                   -- C 결재번호: REF_NO 전건 빈값(실측) → 원천 미확인 유지
  o.po_dt,
  coalesce(nullif(split_part(ag.usr_nm, '_', 2), ''), nullif(btrim(o.insrt_user_id), '')) as agent_nm,  -- F 담당자
  coalesce(nullif(btrim(o.tracking_no), ''), r.tracking_no) as p_code,   -- G 발주 기준 우선
  prj.ref_nm as prj_nm, o.bp_code,                       -- H 계약내역 · I 공급처
  coalesce(nullif(btrim(o.bp_name), ''), nullif(btrim(o.bp_code), '')) as bp_name,
  coalesce(r.dlvy_dt, o.dlvy_dt) as dlvy_dt,             -- K 입고요청일(요청 희망납기 우선)
  ivx.iv_last_dt, ivx.iv_first_dt, coalesce(ivx.iv_cnt, 0) as iv_cnt, ivx.iv_qty_sum,   -- L 입고일(매입기준)
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
  nullif(btrim(o.sl_cd), '') as whs_cd                   -- 입고창고 코드(툴팁)
from erp_ro.pur_order_s o
left join erp_ro.pur_req_s     r  on r.pr_no = o.pr_no
left join public.v_erp_item    im on im.item_code = o.item_code
left join erp_ro.usr_master_s  u  on lower(u.usr_id) = lower(r.req_prsn)
left join erp_ro.usr_master_s  ag on lower(ag.usr_id) = lower(o.insrt_user_id)
left join erp_ro.wh_master_s   wh on wh.sl_cd = o.sl_cd
-- 프로젝트명: PC·TK 양쪽에 같은 코드가 있어 그냥 조인하면 행이 2배가 된다 → lateral + limit 1
left join lateral (
  select c.ref_nm from erp_ro.ctrl_ref_s c
  where c.ref_cd = coalesce(nullif(btrim(o.tracking_no), ''), r.tracking_no) and c.ctrl_cd in ('PC', 'TK')
  order by case c.ctrl_cd when 'PC' then 0 else 1 end limit 1
) prj on true
-- 입고일: 분할 매입은 라인당 여러 건이라 조인하면 1행이 여러 행이 된다 → 집계로 흡수
left join lateral (
  select min(iv.iv_dt) as iv_first_dt, max(iv.iv_dt) as iv_last_dt,
         count(*) as iv_cnt, sum(iv.iv_qty) as iv_qty_sum
  from erp_ro.iv_dtl_s iv
  where iv.po_no = o.po_no and iv.po_seq_no = o.po_seq
) ivx on true

union all

-- 발주가 아직 안 난 구매요청 (엑셀에서 PONO 가 빈칸·'-' 인 행)
select
  'PR'::text, null::text, null::integer, r.pr_no,
  null::text, null::date, null::text,
  r.tracking_no, prj.ref_nm,
  nullif(btrim(r.sppl_code), ''),
  coalesce(nullif(btrim(r.sppl_name), ''), nullif(btrim(r.sppl_code), '')),
  r.dlvy_dt,
  null::date, null::date, 0, null::numeric,
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
  null::text, nullif(btrim(r.sl_cd), '')
from erp_ro.pur_req_s r
left join public.v_erp_item   im on im.item_code = r.item_code
left join erp_ro.usr_master_s u  on lower(u.usr_id) = lower(r.req_prsn)
left join erp_ro.wh_master_s  wh2 on wh2.sl_cd = r.sl_cd
left join lateral (
  select c.ref_nm from erp_ro.ctrl_ref_s c
  where c.ref_cd = r.tracking_no and c.ctrl_cd in ('PC', 'TK')
  order by case c.ctrl_cd when 'PC' then 0 else 1 end limit 1
) prj on true
where not exists (select 1 from erp_ro.pur_order_s o2 where o2.pr_no = r.pr_no);

comment on view public.v_erp_pur_list is
  '구매팀 발주통합관리 LIST(REQ-0069·0070) — 발주 라인 + 발주 없는 구매요청. 엑셀 23칸 대응. 담당자=등록자·외주=품번 ROS 접두(2026-09-22 적재 후 판정). 결재번호(pu_no)만 원천 미확인.';

grant select on public.v_erp_pur_list to authenticated, service_role;

-- ── 확인 ─────────────────────────────────────────────────────────────────────
-- select count(*) 전체, count(price) 단가, count(agent_nm) 담당자, count(whs_nm) 입고창고,
--        count(hdr_remark) 비고, count(dtl_remark) 적요, count(pu_no) 결재번호
--   from public.v_erp_pur_list;                                   -- 5,609 / 4,618 / 4,618 / 5,607 / 2,713 / 3,234 / 0
-- select gubun, count(*) from public.v_erp_pur_list group by 1 order by 2 desc;
--   -- 원자재 2,768 · 부자재 1,376 · 외주 799 · 소모품 663  ↔ 엑셀 2,478 / 1,156 / 738 / 638
