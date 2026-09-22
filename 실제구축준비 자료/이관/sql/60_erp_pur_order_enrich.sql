-- 60_erp_pur_order_enrich.sql
-- 발주 스냅샷 확충 — 구매팀 엑셀의 빈 6칸을 배치가 채우게 (2026-09-22 · REQ-0070)
--
-- 배경: `/work/purchase-list`(REQ-0069)는 엑셀 23칸 중 6칸이 비어 있다
--       (담당자·입고처·비고·단가·적요 + 발주기준 P-CODE). ERP 원천에는 다 있는데
--       미러 추출이 헤더 100컬럼 중 5개, 명세 81컬럼 중 9개만 가져오기 때문이다.
--
-- ⚠ 두 칸은 **어느 원천 컬럼인지 확정 전**이다 — 담당자(AGENT/APPLICANT/INSRT_USER_ID),
--   입고처(HDR.DELIVERY_PLCE 자유입력 / DTL.SL_CD 코드). 조사 왕복(관리자 실행)을 기다리는 대신
--   **후보를 전부 가져와 미러에서 판정한다.** 셋 다 좁은 텍스트라 비용이 미미하다.
--   판정 쿼리는 `10_ERP_DB연계/etl/sql/ERP원천조사_구매.sql §7`.
--
-- ⚠ **신규 컬럼은 증분 적재로 안 채워진다.** 증분은 `UPDT_DT >= watermark` 로 변경분만 읽으므로
--   기존 4,609행은 그대로 NULL 이다 → 최초 1회 **`--full` 백필**이 필요하다(§적용 절차).
--
-- 되돌리기: 60_erp_pur_order_enrich_rollback.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) 미러 컬럼 11개 추가 (전부 nullable — 적재 전에는 NULL, 화면은 「ERP 연동 대기」로 표시)
-- ─────────────────────────────────────────────────────────────────────────────
alter table erp_ro.pur_order_s add column if not exists po_prc        numeric;  -- 엑셀 T 단가        ← DTL.PO_PRC
alter table erp_ro.pur_order_s add column if not exists dtl_remark    text;     -- 엑셀 W 적요        ← DTL.REMRK
alter table erp_ro.pur_order_s add column if not exists hdr_remark    text;     -- 엑셀 N 비고        ← HDR.REMARK
alter table erp_ro.pur_order_s add column if not exists delivery_plce text;     -- 엑셀 M 입고처 후보A ← HDR.DELIVERY_PLCE
alter table erp_ro.pur_order_s add column if not exists sl_cd         text;     -- 엑셀 M 입고처 후보B ← DTL.SL_CD(→ wh_master_s.sl_nm)
alter table erp_ro.pur_order_s add column if not exists agent_id      text;     -- 엑셀 F 담당자 후보A ← HDR.AGENT
alter table erp_ro.pur_order_s add column if not exists applicant_id  text;     -- 엑셀 F 담당자 후보B ← HDR.APPLICANT
alter table erp_ro.pur_order_s add column if not exists insrt_user_id text;     -- 엑셀 F 담당자 후보C ← HDR.INSRT_USER_ID
alter table erp_ro.pur_order_s add column if not exists po_type_cd    text;     -- 엑셀 B 「외주」 판정 후보 ← HDR.PO_TYPE_CD
alter table erp_ro.pur_order_s add column if not exists ref_no        text;     -- 엑셀 C 결재번호 후보     ← HDR.REF_NO
alter table erp_ro.pur_order_s add column if not exists tracking_no   text;     -- 엑셀 G P-CODE(발주기준)  ← DTL/HDR.TRACKING_NO

comment on column erp_ro.pur_order_s.agent_id is
  '발주 담당자 후보 A(M_PUR_ORD_HDR.AGENT) — 엑셀 「담당자」의 원천 확정 전이라 후보 3종을 모두 적재(REQ-0070)';
comment on column erp_ro.pur_order_s.delivery_plce is
  '납품장소(HDR.DELIVERY_PLCE) — 엑셀 「입고처」 후보 A. 코드형이면 sl_cd → wh_master_s 를 쓴다';
comment on column erp_ro.pur_order_s.ref_no is
  '참조번호(HDR.REF_NO) — 엑셀 「요청번호(결재)」 PU… 후보. 형식이 확인되기 전까지 화면에서 결재번호로 쓰지 않는다';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) 이 job 전용 upsert RPC
--    공유 `erp_etl_upsert`(19개 job 공용)를 건드리지 않고 분리했다 — 컬럼이 27개로 늘었고,
--    공용 함수를 통째로 재작성하면 다른 job 분기를 잘못 건드릴 위험이 있다.
--    ETL 호출부는 항상 {p_table, p_rows} 로 부르므로(etl_run.py) 시그니처를 맞춘다.
--    ⚠ insert 컬럼목록 / select x.… / jsonb_to_recordset 타입 / on conflict — 네 곳을 모두 맞춰야 한다.
--       하나라도 빠지면 오류 없이 NULL 로 들어가 원인을 찾기 어렵다.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.erp_etl_upsert_pur_order(p_table text, p_rows jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  if p_table <> 'pur_order_s' then
    raise exception 'erp_etl_upsert_pur_order: 이 RPC 는 pur_order_s 전용입니다(받은 값: %)', p_table
      using errcode = '22023';
  end if;

  insert into erp_ro.pur_order_s (
    po_no, po_seq, po_dt, bp_code, bp_name, item_code, item_name, dlvy_dt,
    po_qty, po_unit, po_amt, po_sts, rcpt_qty, subcontra_flg, cls_flg, pr_no,
    po_prc, dtl_remark, hdr_remark, delivery_plce, sl_cd,
    agent_id, applicant_id, insrt_user_id, po_type_cd, ref_no, tracking_no,
    synced_at, src_updated, batch_id)
  select x.po_no, x.po_seq, x.po_dt, x.bp_code, x.bp_name, x.item_code, x.item_name, x.dlvy_dt,
         x.po_qty, x.po_unit, x.po_amt, x.po_sts, x.rcpt_qty, x.subcontra_flg, x.cls_flg, x.pr_no,
         x.po_prc, x.dtl_remark, x.hdr_remark, x.delivery_plce, x.sl_cd,
         x.agent_id, x.applicant_id, x.insrt_user_id, x.po_type_cd, x.ref_no, x.tracking_no,
         now(), x.src_updated, x.batch_id
  from jsonb_to_recordset(p_rows) as x(
    po_no text, po_seq int, po_dt date, bp_code text, bp_name text, item_code text, item_name text,
    dlvy_dt date, po_qty numeric, po_unit text, po_amt numeric, po_sts text, rcpt_qty numeric,
    subcontra_flg text, cls_flg text, pr_no text,
    po_prc numeric, dtl_remark text, hdr_remark text, delivery_plce text, sl_cd text,
    agent_id text, applicant_id text, insrt_user_id text, po_type_cd text, ref_no text, tracking_no text,
    src_updated timestamptz, batch_id uuid)
  on conflict (po_no, po_seq) do update
    set po_dt = excluded.po_dt, bp_code = excluded.bp_code, bp_name = excluded.bp_name,
        item_code = excluded.item_code, item_name = excluded.item_name, dlvy_dt = excluded.dlvy_dt,
        po_qty = excluded.po_qty, po_unit = excluded.po_unit, po_amt = excluded.po_amt,
        po_sts = excluded.po_sts, rcpt_qty = excluded.rcpt_qty,
        subcontra_flg = excluded.subcontra_flg, cls_flg = excluded.cls_flg, pr_no = excluded.pr_no,
        po_prc = excluded.po_prc, dtl_remark = excluded.dtl_remark, hdr_remark = excluded.hdr_remark,
        delivery_plce = excluded.delivery_plce, sl_cd = excluded.sl_cd,
        agent_id = excluded.agent_id, applicant_id = excluded.applicant_id,
        insrt_user_id = excluded.insrt_user_id, po_type_cd = excluded.po_type_cd,
        ref_no = excluded.ref_no, tracking_no = excluded.tracking_no,
        synced_at = excluded.synced_at, src_updated = excluded.src_updated, batch_id = excluded.batch_id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.erp_etl_upsert_pur_order(text, jsonb) from public, anon, authenticated;
grant execute on function public.erp_etl_upsert_pur_order(text, jsonb) to service_role;

comment on function public.erp_etl_upsert_pur_order(text, jsonb) is
  '발주 스냅샷 전용 upsert(REQ-0070) — 컬럼 27개. etl_run.py JOBS["pur_order"]["rpc"] 가 이 이름을 가리킨다.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) 노출 뷰 — 새 컬럼을 엑셀 칸에 연결. **적재 전에는 전부 NULL 이라 화면은 지금과 똑같다.**
--    (뷰 전문은 57_erp_pur_list.sql 을 이 파일 기준으로 갱신해 두었다 — 여기서는 연결 규칙만 적는다)
--      F 담당자  = usr_master_s(AGENT → APPLICANT → 등록자) 로 '부서명_이름' 해석, 못 찾으면 계정 그대로
--      M 입고처  = DELIVERY_PLCE 있으면 그대로, 없으면 SL_CD → wh_master_s.sl_nm
--                  (미발주 요청 행은 요청 납입장소 pur_req_s.sl_cd 를 쓴다 — 실측 984행 이미 채워짐)
--      G P-CODE  = 발주 기준(DTL/HDR.TRACKING_NO) 우선, 없으면 요청 기준
--      T 단가    = PO_PRC · N 비고 = HDR.REMARK · W 적요 = DTL.REMRK
--      보조 노출 = ref_no(결재번호 후보) · po_type_cd(외주 판정 후보) — **엑셀 칸에 붙이지 않고** 원문만 보여준다
-- ─────────────────────────────────────────────────────────────────────────────
-- (뷰 정의는 57_erp_pur_list.sql 참조 — 이 파일 적용 후 57 을 다시 실행하면 같은 상태가 된다)

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) 적용 절차 (관리자 직접 실행 · §1.5)
-- ─────────────────────────────────────────────────────────────────────────────
--   ① 추출이 ERP 에서 도는지 확인(쓰기 없음)
--        python etl_run.py --job pur_order --dry-run
--   ② 신규 컬럼 백필 — **최초 1회는 반드시 --full**(증분은 기존 행을 안 건드린다)
--        python etl_run.py --job pur_order --full
--      (서버 러너라면  jeil_runner.exe etl --job pur_order --full)
--   ③ 이후는 평소대로 증분이 돈다(웹 「데이터 업데이트」 큐 포함 — 이 job 은 민감이 아니라 SAFE_JOBS)
--   ④ 적재 후 판정(§ERP원천조사_구매.sql §7): 담당자 3후보 중 엑셀 분포와 맞는 것,
--      po_type_cd 분포 vs 엑셀 외주 738, ref_no 가 PU 형식인지 → 뷰 CASE 한 줄 수정

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) 확인
-- ─────────────────────────────────────────────────────────────────────────────
-- select count(*) 전체,
--        count(po_prc) 단가, count(dtl_remark) 적요, count(hdr_remark) 비고,
--        count(delivery_plce) 입고처자유, count(sl_cd) 창고코드,
--        count(agent_id) agent, count(applicant_id) applicant, count(insrt_user_id) 등록자,
--        count(po_type_cd) 발주유형, count(ref_no) 참조번호, count(tracking_no) 추적번호
--   from erp_ro.pur_order_s;
