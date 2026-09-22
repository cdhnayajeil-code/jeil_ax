-- 65_erp_pur_req_approval_no.sql
-- 구매요청 결재번호(PU…) 연결 — 엑셀 C열의 마지막 빈칸 (2026-09-22 · REQ-0071)
--
-- ── 무엇을 찾았나 ───────────────────────────────────────────────────────────
-- 엑셀 「구매요청결재번호 PU2026…」의 원천은 **`M_PUR_REQ.EXT1_CD`** 였다. ERP 확장슬롯이다.
--
-- 왜 오래 못 찾았나 — **이름에 '결재'가 없어서**다.
--   · 구매 3테이블 230컬럼에 결재문서번호라는 이름의 칸이 없다
--     ('결재'가 붙은 PAY_DUR·PAY_METH 는 대금지급 조건이지 전자결재가 아니다)
--   · 미러 후보 5개(ref_no·tracking_no·dw_no1·mrp_ord_no·change_order) 모두 PU 형식 0건
--   · 그룹웨어 전자결재 연동표 `INTERFACE_KO174`(IF_TYPE='PR0', 8,074행)에는 KEY1=PU 가 있지만
--     **KEY2~KEY7 이 전건 비어 있어 구매요청번호를 주지 못한다** → 그쪽만으로는 이을 수 없다
--   결국 값으로 찾았다 — 구매·요청 계열 테이블의 문자열 컬럼 1,203개에 표본값
--   'PU202607240005' 를 직접 대조해 3곳(INTERFACE_KO174.KEY1 · M_PUR_REQ.EXT1_CD ·
--   M_PUR_GOODS_MVMT.EXT1_CD)을 찾았고, 그중 요청 단위로 붙는 것이 M_PUR_REQ.EXT1_CD 다.
--
-- ── 실측(2026년) ────────────────────────────────────────────────────────────
--   요청 5,551라인 · 결재번호 5,292(95.3%) · 고유 1,133   ↔ 엑셀 고유 1,060
--   KO174 2026 PU 1,169 / M_PUR_REQ 2026 PU 1,133 / 양쪽 공통 1,123 — 잘 맞물린다
--   한 결재당 요청 라인 1~25개(1건 530 · 2건 223 · 3건 91 …) — 엑셀의 헤더:명세 구조 그대로
--   빈 259건은 **ERP 에 결재번호가 없는 건**이다. 지어내지 않고 NULL 로 둔다.
--
-- 같은 확장슬롯의 나머지 둘도 쓸모가 있어 함께 가져온다:
--   EXT2_CD = 건명   「2024-114-HAS_한화 UAE VPM 1GAL 설계변경」  5,387/5,551
--   EXT3_CD = 도번/품명 「H-4886-R201/COUPLING COVER」            3,439/5,551
--
-- ⚠ 발주(PO) 행의 결재번호는 **요청에서 따라온다**(`r.pu_no`). 발주 자체에는 결재번호가 없고
--    엑셀도 같은 구조다. 발주 라인의 pr_no 가 비면 결재번호도 빈다.
--
-- 되돌리기: 65_erp_pur_req_approval_no_rollback.sql

-- ── ① 미러 컬럼 ─────────────────────────────────────────────────────────────
alter table erp_ro.pur_req_s add column if not exists pu_no     text;
alter table erp_ro.pur_req_s add column if not exists req_title text;
alter table erp_ro.pur_req_s add column if not exists dw_ref    text;

comment on column erp_ro.pur_req_s.pu_no     is '구매요청 결재번호(M_PUR_REQ.EXT1_CD · PU2026… · 그룹웨어 전자결재 KO174.KEY1 과 동일)';
comment on column erp_ro.pur_req_s.req_title is '건명(M_PUR_REQ.EXT2_CD · 프로젝트_설명)';
comment on column erp_ro.pur_req_s.dw_ref    is '도번/품명(M_PUR_REQ.EXT3_CD)';

-- 결재번호로 찾는 것이 이 화면의 주 용도다. 빈칸 259행이 있어 부분 인덱스로 둔다.
create index if not exists idx_pur_req_s_pu_no on erp_ro.pur_req_s (pu_no) where pu_no is not null;

-- ── ② job 전용 upsert ───────────────────────────────────────────────────────
-- 공용 `erp_etl_upsert`(19개 job 공용)를 고치지 않는다 — 컬럼이 37개로 늘어 통째로 재작성하면
-- 다른 job 분기를 잘못 건드릴 위험이 있다. pur_order(60번) 때와 같은 방식으로 분리한다.
-- ⚠ 반환형은 **integer** 여야 한다. 처음 void 로 만들었더니 러너가 「적재 0」으로 기록했다
--    (데이터는 정상 적재됐다). 공용 함수·pur_order 전용 함수와 모양을 맞춘다.
drop function if exists public.erp_etl_upsert_pur_req(text, jsonb);

create function public.erp_etl_upsert_pur_req(p_table text, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public, erp_ro as $$
declare n integer;
begin
  if p_table <> 'pur_req_s' then
    raise exception 'erp_etl_upsert_pur_req 는 pur_req_s 전용이다 (요청: %)', p_table;
  end if;

  insert into erp_ro.pur_req_s (
    pr_no, pr_type, pr_sts, plant_cd, item_code, item_name, req_qty, req_unit, ord_qty, rcpt_qty, iv_qty,
    req_dt, dlvy_dt, pur_plan_dt, req_dept, req_prsn, sppl_code, sppl_name, so_no,
    procure_type, req_cfm_qty, rls_ord_qty, pur_grp, pur_org, sl_cd, so_seq_no, dw_no1, tracking_no,
    change_order, mrp_ord_no, insrt_dt, insrt_user_id, updt_user_id,
    pu_no, req_title, dw_ref,
    synced_at, src_updated, batch_id)
  select
    x.pr_no, x.pr_type, x.pr_sts, x.plant_cd, x.item_code, x.item_name, x.req_qty, x.req_unit, x.ord_qty, x.rcpt_qty, x.iv_qty,
    x.req_dt, x.dlvy_dt, x.pur_plan_dt, x.req_dept, x.req_prsn, x.sppl_code, x.sppl_name, x.so_no,
    x.procure_type, x.req_cfm_qty, x.rls_ord_qty, x.pur_grp, x.pur_org, x.sl_cd, x.so_seq_no, x.dw_no1, x.tracking_no,
    x.change_order, x.mrp_ord_no, x.insrt_dt, x.insrt_user_id, x.updt_user_id,
    nullif(btrim(x.pu_no), ''), nullif(btrim(x.req_title), ''), nullif(btrim(x.dw_ref), ''),
    now(), x.src_updated, x.batch_id
  from jsonb_to_recordset(p_rows) as x(
    pr_no text, pr_type text, pr_sts text, plant_cd text, item_code text, item_name text,
    req_qty numeric, req_unit text, ord_qty numeric, rcpt_qty numeric, iv_qty numeric,
    req_dt date, dlvy_dt date, pur_plan_dt date, req_dept text, req_prsn text,
    sppl_code text, sppl_name text, so_no text,
    procure_type text, req_cfm_qty numeric, rls_ord_qty numeric, pur_grp text, pur_org text,
    sl_cd text, so_seq_no text, dw_no1 text, tracking_no text, change_order text, mrp_ord_no text,
    insrt_dt timestamptz, insrt_user_id text, updt_user_id text,
    pu_no text, req_title text, dw_ref text,
    src_updated timestamptz, batch_id uuid)
  on conflict (pr_no) do update
    set pr_type = excluded.pr_type, pr_sts = excluded.pr_sts, plant_cd = excluded.plant_cd,
        item_code = excluded.item_code, item_name = excluded.item_name, req_qty = excluded.req_qty,
        req_unit = excluded.req_unit, ord_qty = excluded.ord_qty, rcpt_qty = excluded.rcpt_qty,
        iv_qty = excluded.iv_qty, req_dt = excluded.req_dt, dlvy_dt = excluded.dlvy_dt,
        pur_plan_dt = excluded.pur_plan_dt, req_dept = excluded.req_dept, req_prsn = excluded.req_prsn,
        sppl_code = excluded.sppl_code, sppl_name = excluded.sppl_name, so_no = excluded.so_no,
        procure_type = excluded.procure_type, req_cfm_qty = excluded.req_cfm_qty, rls_ord_qty = excluded.rls_ord_qty,
        pur_grp = excluded.pur_grp, pur_org = excluded.pur_org, sl_cd = excluded.sl_cd, so_seq_no = excluded.so_seq_no,
        dw_no1 = excluded.dw_no1, tracking_no = excluded.tracking_no, change_order = excluded.change_order,
        mrp_ord_no = excluded.mrp_ord_no, insrt_dt = excluded.insrt_dt,
        insrt_user_id = excluded.insrt_user_id, updt_user_id = excluded.updt_user_id,
        pu_no = excluded.pu_no, req_title = excluded.req_title, dw_ref = excluded.dw_ref,
        synced_at = excluded.synced_at, src_updated = excluded.src_updated, batch_id = excluded.batch_id;

  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.erp_etl_upsert_pur_req(text, jsonb) from public, anon, authenticated;
grant execute on function public.erp_etl_upsert_pur_req(text, jsonb) to service_role;

-- ── ③ 뷰는 66번에서 ─────────────────────────────────────────────────────────
-- `public.v_erp_pur_list` 의 pu_no 실체화는 `66_erp_pur_list_v3.sql` 에 있다.
--
-- ── ④ 적재(관리자) ──────────────────────────────────────────────────────────
-- 신규 컬럼은 증분(UPDT_DT >= watermark)으로 기존 행이 안 채워진다 → 최초 1회 전량:
--   python 10_ERP_DB연계/etl/etl_run.py --job pur_req --full      (관리자 PC · 저장소 소스)
--   jeil_runner.exe etl --job pur_req --full                      (서버 · EXE 교체 후)
-- 2026-09-22 관리자 PC 에서 실행 완료 — 추출 5,551 / 적재 5,551.
--
-- ── 확인 ─────────────────────────────────────────────────────────────────────
-- select count(*) 전체, count(pu_no) 결재번호, count(distinct pu_no) 고유,
--        count(req_title) 건명, count(dw_ref) 도번
--   from erp_ro.pur_req_s;              -- 5,552 / 5,292 / 1,133 / 5,387 / 3,439
