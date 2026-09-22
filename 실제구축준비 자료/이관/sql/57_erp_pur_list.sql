-- 57_erp_pur_list.sql
-- 구매팀 「발주통합관리 LIST」 조회 뷰 (2026-09-22 · REQ-0069)
--
-- 배경: 구매팀이 손으로 유지하는 엑셀(`발주통합관리 LIST (2026).xlsx` · 23컬럼 5,179행)을
--       웹 화면으로 대체한다. 엑셀 1행 = 발주 1라인이고, 발주가 아직 안 난 요청 행도 섞여 있다
--       (엑셀 J PONO 빈칸 479 + '-' 175). 그래서 이 뷰는
--         ① 발주 라인(pur_order_s)  UNION ALL  ② 발주 없는 구매요청(pur_req_s)
--       두 갈래를 같은 컬럼 모양으로 합친다. 실측 4,609 + 985 = 5,594행.
--
-- 엑셀 컬럼 대응(A~W): 아래 SELECT 에 주석으로 표기했다.
--   지금 채워지는 것 16개 — B D E G H I J K L O P Q R S U V
--   ETL 확장 대기 6개 — F(담당자) M(입고처) N(비고) T(단가) W(적요) + G 발주기준 승격
--   원천 미확인 1개 — C(구매요청결재번호 `PU…`). ERP 구매 3테이블에 결재 컬럼이 없다(사전 실측).
--   → 대기 컬럼은 **자리를 비워 두고 NULL 로 노출한다.** 화면이 「ERP 연동 대기」로 표시하며,
--     나중에 값이 생기면 뷰만 바꾸면 되므로 화면·API 는 손대지 않는다.
--
-- 되돌리기: 57_erp_pur_list_rollback.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) ctrl_ref_s 읽기 개방 — 프로젝트명(엑셀 H 계약내역) 한 칸을 위해서만
-- ─────────────────────────────────────────────────────────────────────────────
-- `erp_ro.ctrl_ref_s`(관리항목 참조값 9,508행)는 27_gl_ctrl_ref.sql 에서 RLS 를 켜고
-- 정책을 하나도 두지 않아(= 전면 차단) service_role 만 읽는다. 결의전표 관리항목 중
-- 민감 5종이 섞여 있기 때문이다(19_ctrl_ref 계열 참조).
-- 그런데 프로젝트 코드→프로젝트명 대응(ctrl_cd 'PC'/'TK')은 민감정보가 아니고,
-- 발주통합 LIST 의 「계약내역」이 이 값이다. 실측: PC 710건이 요청 tracking_no 를 100%(5,534/5,534) 커버.
--
-- ⚠ security_invoker=true 뷰에서 권한 없는 테이블을 조인하면 오류(permission denied)로
--   화면 전체가 죽는다. 그래서 컬럼 하나를 위해 **범위를 좁힌** 정책을 새로 둔다 —
--   ctrl_cd 를 'PC','TK' 로 한정해 나머지 관리항목(민감 5종 포함)은 계속 닫아 둔다.
grant select on erp_ro.ctrl_ref_s to authenticated;

drop policy if exists internal_select_ctrl_ref_project on erp_ro.ctrl_ref_s;
create policy internal_select_ctrl_ref_project on erp_ro.ctrl_ref_s
  for select to authenticated
  using (public.is_internal() and ctrl_cd in ('PC', 'TK'));

comment on policy internal_select_ctrl_ref_project on erp_ro.ctrl_ref_s is
  '사내 사용자에게 프로젝트 코드↔명(ctrl_cd PC/TK)만 공개 — 발주통합 LIST 계약내역용(REQ-0069). 다른 관리항목은 계속 비공개.';

-- 조인 성능(발주 라인 4,609행 × lateral): ref_cd 기준 인덱스
create index if not exists idx_ctrl_ref_s_refcd on erp_ro.ctrl_ref_s (ref_cd, ctrl_cd);
-- 입고일(매입기준) lateral 집계용
create index if not exists idx_iv_dtl_s_po on erp_ro.iv_dtl_s (po_no, po_seq_no);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) 조회 뷰
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.v_erp_pur_list with (security_invoker = true) as
-- ① 발주 라인 기준 (엑셀의 대부분)
select
  'PO'::text                                             as row_kind,
  o.po_no,                                                            -- J PONO.
  o.po_seq,
  o.pr_no,                                                            -- D 구매요청번호
  null::text                                             as pu_no,    -- C 결재번호(원천 미확인)
  o.po_dt,                                                            -- E 발주일자
  null::text                                             as agent_nm, -- F 담당자(ETL 대기)
  r.tracking_no                                          as p_code,   -- G P-CODE
  prj.ref_nm                                             as prj_nm,   -- H 계약내역(ERP 프로젝트명 — 엑셀은 고객사명을 앞에 붙여 적어 문구가 다르다)
  o.bp_code,                                                          -- I 공급처(코드)
  coalesce(nullif(btrim(o.bp_name), ''), nullif(btrim(o.bp_code), '')) as bp_name,  -- I 공급처
  -- K 입고요청일 = **요청 희망납기 우선**. 엑셀 K 가 이 값이다(표본 대조로 확인).
  -- 발주 납기(o.dlvy_dt)는 협력사와 조정되며 실측 4,559건 중 3,997건이 요청 희망납기와 다르다
  -- → 둘을 한 칸에 섞지 않고 po_dlvy_dt 로 따로 내보낸다.
  coalesce(r.dlvy_dt, o.dlvy_dt)                         as dlvy_dt,  -- K 입고요청일
  ivx.iv_last_dt,                                                     -- L 입고일(매입기준)
  ivx.iv_first_dt,
  coalesce(ivx.iv_cnt, 0)                                as iv_cnt,
  ivx.iv_qty_sum,
  null::text                                             as whs_nm,   -- M 입고처(ETL 대기)
  null::text                                             as hdr_remark, -- N 비고(ETL 대기)
  o.item_code,                                                        -- O 품번
  coalesce(nullif(o.item_name, ''), im.item_name)        as item_name, -- P 품목명
  im.spec,                                                            -- Q 규격
  o.po_qty                                               as qty,      -- R 수량
  nullif(btrim(o.po_unit), '')                           as unit,     -- S 단위
  null::numeric                                          as price,    -- T 단가(ETL 대기)
  o.po_amt                                               as amt,      -- U 금액
  coalesce(nullif(u.usr_nm, ''), r.req_prsn)             as req_user_nm, -- V 요청자(부서명_이름)
  null::text                                             as dtl_remark,  -- W 적요(ETL 대기)
  -- B 구분: 품목계정(P1001 원자재/부자재/소모품…). 「외주」는 현재 미러로 판정 불가
  -- (subcontra_flg 전건 'N' — ERP PO_TYPE_CD 실측 대기). 규칙이 정해지면 이 CASE 만 고친다.
  case when o.subcontra_flg = 'Y' then '외주'
       else nullif(im.item_acct_nm, '') end              as gubun,
  im.item_class,
  im.item_acct_nm,
  o.subcontra_flg,
  o.po_sts,
  o.rcpt_qty,
  r.pr_sts,
  r.req_dt,
  r.req_qty,
  coalesce(nullif(r.req_dept, ''), split_part(u.usr_nm, '_', 1)) as req_dept,
  r.so_no,
  o.cls_flg,
  -- 상태 한 줄 표기(화면 상태 필터의 단일 출처)
  case
    when o.po_sts = 'IV'                                                             then '매입완료'
    when coalesce(o.po_qty, 0) > 0 and coalesce(o.rcpt_qty, 0) >= o.po_qty           then '입고완료'
    when coalesce(o.rcpt_qty, 0) > 0                                                 then '부분입고'
    else '발주'
  end                                                    as status_kr,
  false                                                  as is_unordered,
  (coalesce(o.rcpt_qty, 0) < coalesce(o.po_qty, 0))      as is_unreceived,
  (coalesce(o.rcpt_qty, 0) < coalesce(o.po_qty, 0) and o.dlvy_dt < current_date) as overdue_unreceived,
  o.synced_at,
  -- 기간 필터·기본 정렬의 단일 축. 발주일이 없는 행(미발주 요청)을 요청일로 받아 준다 —
  -- po_dt 로 직접 필터하면 NULL 비교 때문에 미발주 985행이 조용히 사라진다.
  coalesce(o.po_dt, r.req_dt)                            as list_dt,
  o.dlvy_dt                                              as po_dlvy_dt   -- 발주 납기(협력사 약속일)
from erp_ro.pur_order_s o
-- pr_no 는 pur_req_s 의 PK 라 1:1 — 행이 불어나지 않는다(15_erp_process_link_enrich 와 동일 근거)
left join erp_ro.pur_req_s     r  on r.pr_no = o.pr_no
left join public.v_erp_item    im on im.item_code = o.item_code
left join erp_ro.usr_master_s  u  on lower(u.usr_id) = lower(r.req_prsn)
-- 프로젝트명: PC·TK 양쪽에 같은 코드가 있어 그냥 조인하면 행이 2배가 된다 → lateral + limit 1
left join lateral (
  select c.ref_nm
  from erp_ro.ctrl_ref_s c
  where c.ref_cd = r.tracking_no and c.ctrl_cd in ('PC', 'TK')
  order by case c.ctrl_cd when 'PC' then 0 else 1 end
  limit 1
) prj on true
-- 입고일: 분할 매입은 라인당 여러 건이라 조인하면 엑셀 1행이 여러 행이 된다 → 집계로 흡수
left join lateral (
  select min(iv.iv_dt) as iv_first_dt, max(iv.iv_dt) as iv_last_dt,
         count(*) as iv_cnt, sum(iv.iv_qty) as iv_qty_sum
  from erp_ro.iv_dtl_s iv
  where iv.po_no = o.po_no and iv.po_seq_no = o.po_seq
) ivx on true

union all

-- ② 발주가 아직 안 난 구매요청 (엑셀에서 PONO 가 빈칸·'-' 인 행)
select
  'PR'::text                                             as row_kind,
  null::text                                             as po_no,
  null::integer                                          as po_seq,
  r.pr_no,
  null::text                                             as pu_no,
  null::date                                             as po_dt,
  null::text                                             as agent_nm,
  r.tracking_no                                          as p_code,
  prj.ref_nm                                             as prj_nm,
  -- ⚠ 구매요청의 공급처는 ERP 원천이 **전건 비어 있다**(5,535/5,535 실측 2026-09-22).
  -- 엑셀의 미발주 행 공급처는 구매팀이 손으로 적은 예정처 → 여기서는 NULL 로 두고 화면이 사유를 밝힌다.
  nullif(btrim(r.sppl_code), '')                         as bp_code,
  coalesce(nullif(btrim(r.sppl_name), ''), nullif(btrim(r.sppl_code), '')) as bp_name,
  r.dlvy_dt,
  null::date                                             as iv_last_dt,
  null::date                                             as iv_first_dt,
  0                                                      as iv_cnt,
  null::numeric                                          as iv_qty_sum,
  null::text                                             as whs_nm,
  null::text                                             as hdr_remark,
  r.item_code,
  coalesce(nullif(r.item_name, ''), im.item_name)        as item_name,
  im.spec,
  r.req_qty                                              as qty,
  nullif(btrim(r.req_unit), '')                          as unit,
  null::numeric                                          as price,
  null::numeric                                          as amt,
  coalesce(nullif(u.usr_nm, ''), r.req_prsn)             as req_user_nm,
  null::text                                             as dtl_remark,
  nullif(im.item_acct_nm, '')                            as gubun,
  im.item_class,
  im.item_acct_nm,
  null::text                                             as subcontra_flg,
  null::text                                             as po_sts,
  null::numeric                                          as rcpt_qty,
  r.pr_sts,
  r.req_dt,
  r.req_qty,
  coalesce(nullif(r.req_dept, ''), split_part(u.usr_nm, '_', 1)) as req_dept,
  r.so_no,
  null::text                                             as cls_flg,
  '미발주'::text                                          as status_kr,
  true                                                   as is_unordered,
  true                                                   as is_unreceived,
  (r.dlvy_dt < current_date)                             as overdue_unreceived,
  r.synced_at,
  r.req_dt                                               as list_dt,
  null::date                                             as po_dlvy_dt
from erp_ro.pur_req_s r
left join public.v_erp_item   im on im.item_code = r.item_code
left join erp_ro.usr_master_s u  on lower(u.usr_id) = lower(r.req_prsn)
left join lateral (
  select c.ref_nm
  from erp_ro.ctrl_ref_s c
  where c.ref_cd = r.tracking_no and c.ctrl_cd in ('PC', 'TK')
  order by case c.ctrl_cd when 'PC' then 0 else 1 end
  limit 1
) prj on true
where not exists (select 1 from erp_ro.pur_order_s o2 where o2.pr_no = r.pr_no);

comment on view public.v_erp_pur_list is
  '구매팀 발주통합관리 LIST(REQ-0069) — 발주 라인 + 발주 없는 구매요청. 엑셀 23컬럼 대응. NULL 컬럼(pu_no·agent_nm·whs_nm·hdr_remark·price·dtl_remark)은 ERP 추출 확장 대기.';

grant select on public.v_erp_pur_list to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) 확인
-- ─────────────────────────────────────────────────────────────────────────────
-- select row_kind, count(*) from public.v_erp_pur_list group by 1;              -- PO 4609 / PR 985 기대
-- select count(*) as 전체, count(prj_nm) as 계약내역_채움, count(req_user_nm) as 요청자_채움,
--        count(spec) as 규격_채움, count(gubun) as 구분_채움, count(iv_last_dt) as 입고일_채움
--   from public.v_erp_pur_list;
-- select gubun, count(*) from public.v_erp_pur_list group by 1 order by 2 desc; -- 엑셀 분포와 대조
-- select sum(amt) from public.v_erp_pur_list;                                   -- 엑셀 U 합계와 1% 이내
