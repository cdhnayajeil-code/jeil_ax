# etl_run.py — ERP(UNIERP MSSQL) → 중간DB(Supabase erp_ro) 야간배치 (03 실행기획 §5)
# 원칙(CLAUDE.md §4): 운영 MSSQL은 읽기 전용 SELECT만(파라미터 바인딩), 포털은 중간DB만 조회.
#   ⚠ 아래 추출 SQL은 유니포인트 뷰 스펙 협의 전 초안 — 실행 전 사용자(관리자) 확인 필수.
# 실행: python etl_run.py --job all            (전체)
#       python etl_run.py --job item_master    (개별: item_master|sales|purchase|inventory)
#       python etl_run.py --job all --dry-run  (추출·건수만 확인, 적재 안 함)
import argparse
import datetime
import json
import sys
import urllib.request

from _env import load_env, need

# ===== 화이트리스트 추출 SQL (읽기 전용) =====
# 테이블·컬럼명은 erp_ro.table_dict(ERP 스키마 사전 2,658개)로 검증함(2026-07-07):
#   B_ITEM(품목), B_BIZ_PARTNER(거래처 BP_CD·BP_NM), S_BILL_HDR(매출), M_IV_HDR(매입), M_PUR_GOODS_MVMT(수불)
# 집계 기준(금액 컬럼 선택·수불 in/out 분류)은 유니포인트/현업 확인 대상 — --dry-run으로 먼저 검증.
ROLLING_MONTHS = 3  # (레거시·현재 미사용) 예전 매출·매입 롤링 윈도. 2026-07-08부터 연 전체 적재로 전환
TARGET_YEAR = 2026  # 연도 필터 — pur_order·sales·purchase 공통(2026년 전체 적재, 관리자 결정 2026-07-08)
LOOKBACK_DAYS = 2   # 증분 안전버퍼 — watermark보다 이만큼 앞선 변경분까지 재추출(경계 유실·지연도착 방지)

JOBS = {
    # ⑤ 사용자 마스터 스냅샷 ← Z_USR_MAST_REC (사용·이메일 계정만 — 사용자↔부서↔사원 대사용)
    #    usr_id=MS 이메일(SSOT), usr_nm='부서명_이름[(휴직)|(퇴사)]'. 부서/사원 파싱은 중간DB 뷰(v_user_dept_map).
    #    ⚠ EMP_NO/DEPT_CD 컬럼 없음 — 부서 정보는 usr_nm 텍스트가 유일 소스(구조 확인 2026-07-08).
    "usr_master": {
        "table": "usr_master_s",
        "sql": """
            SELECT USR_ID AS usr_id, USR_NM AS usr_nm,
                   CONVERT(bit, CASE WHEN USE_YN = 'Y' THEN 1 ELSE 0 END) AS use_yn,
                   UPDT_DT AS src_updated
            FROM JEILMNS.dbo.Z_USR_MAST_REC WITH (NOLOCK)
            WHERE USE_YN = 'Y' AND USR_ID LIKE '%@%'
        """,
        "params": [],
        "incr_sql": " AND UPDT_DT >= ?",   # 증분: 변경된 계정만(watermark 이후). 미사용 전환분은 --full 정합으로 정리
    },
    # ⑥ 부서 마스터 스냅샷 ← B_ACCT_DEPT (파싱 부서명 대사·부서-사원 관계 기준, 소형·전량 upsert)
    "dept_master": {
        "table": "dept_master_s",
        "sql": """
            SELECT ISNULL(ORG_CHANGE_ID, '') AS org_change_id, DEPT_CD AS dept_cd,
                   DEPT_NM AS dept_nm, PAR_DEPT_CD AS par_dept_cd,
                   DEPT_FULL_NM AS dept_full_nm, END_DEPT_FG AS end_dept_fg,
                   UPDT_DT AS src_updated
            FROM JEILMNS.dbo.B_ACCT_DEPT WITH (NOLOCK)
        """,
        "params": [],
    },
    # ⑦ 사용자별 ERP 접근 모듈 ← 역할·메뉴 권한(참고 제안값용) — 부서별 ERP 모듈 제안(v_dept_erp_suggest)
    #    조인: Z_USR_MAST_REC_USR_ROLE_ASSO → Z_USR_ROLE_MNU_AUTHZTN_ASSO(MNU_USE_YN='Y') → Z_CO_MAST_MNU(ModuleInitial)
    #    관련 포털 모듈(SD/MM/IM/MDM)만 추출. 소형·전량 upsert. 자동 덮어쓰기 아님(관리자 참고용).
    "usr_erp_module": {
        "table": "usr_erp_module_s",
        "sql": """
            SELECT DISTINCT a.USR_ID AS email, mm.ModuleInitial AS module_initial
            FROM JEILMNS.dbo.Z_USR_MAST_REC_USR_ROLE_ASSO a WITH (NOLOCK)
            JOIN JEILMNS.dbo.Z_USR_ROLE_MNU_AUTHZTN_ASSO m WITH (NOLOCK)
                 ON m.USR_ROLE_ID = a.USR_ROLE_ID AND m.MNU_USE_YN = 'Y'
            JOIN JEILMNS.dbo.Z_CO_MAST_MNU mm WITH (NOLOCK)
                 ON mm.MNU_ID = m.MNU_ID AND mm.MNU_TYPE = m.MNU_TYPE
            WHERE a.USR_ID LIKE '%@%' AND mm.ModuleInitial IN ('SD','MM','IM','MDM')
        """,
        "params": [],
    },
    # ⑧ 인사 급여 '집계' ← HDF070T(월급여대장)·HGA070T(퇴직) — erp_secure(민감·인사팀 전용)
    #    ⚠ 집계만(월×부서 인원·급여총액, 월×전사 퇴직). 개인 행·이름·주민번호(RES_NO)·계좌 절대 미추출.
    #    퇴직은 부서 breakdown 시 셀이 작아 재식별 위험 → 회사 전체(전사) 월별 합계만(커넥터 검증 2026-07-08).
    #    적재 대상은 erp_secure.hr_payroll_m → 전용 RPC erp_secure_upsert(service_role). 컬럼은 실스키마 확정.
    "hr_payroll": {
        "table": "hr_payroll_m",
        "rpc": "erp_secure_upsert",
        "sql": """
            SELECT PAY_YYMM AS ym, DEPT_NM AS dept_nm,
                   COUNT(*) AS headcount, SUM(PAY_TOT_AMT) AS pay_tot_amt,
                   CAST(NULL AS numeric) AS retire_amt
            FROM JEILMNS.dbo.HDF070T WITH (NOLOCK)
            WHERE PAY_YYMM >= ? AND PAY_YYMM < ?
            GROUP BY PAY_YYMM, DEPT_NM
            UNION ALL
            SELECT CONVERT(char(6), RETIRE_DT, 112) AS ym, N'전사' AS dept_nm,
                   CAST(NULL AS int) AS headcount, CAST(NULL AS numeric) AS pay_tot_amt,
                   SUM(RETIRE_AMT) AS retire_amt
            FROM JEILMNS.dbo.HGA070T WITH (NOLOCK)
            WHERE RETIRE_DT >= ? AND RETIRE_DT < ?
            GROUP BY CONVERT(char(6), RETIRE_DT, 112)
        """,
        "params": ["ym_start", "ym_end", "year_start", "year_end"],
    },
    # ⓪ 발주현황 스냅샷 ← M_PUR_ORD_HDR/DTL (2026년도만 우선연동 — 협력사 포털·챗봇용)
    "pur_order": {
        "table": "pur_order_s",
        "sql": """
            SELECT h.PO_NO AS po_no, d.PO_SEQ_NO AS po_seq,
                   CONVERT(date, h.PO_DT) AS po_dt,
                   h.BP_CD AS bp_code, ISNULL(b.BP_NM, h.BP_CD) AS bp_name,
                   d.ITEM_CD AS item_code, i.ITEM_NM AS item_name,
                   CONVERT(date, d.DLVY_DT) AS dlvy_dt,
                   d.PO_QTY AS po_qty, d.PO_UNIT AS po_unit,
                   d.PO_LOC_AMT AS po_amt, d.PO_STS AS po_sts,
                   d.RCPT_QTY AS rcpt_qty,
                   h.SUBCONTRA_FLG AS subcontra_flg, h.CLS_FLG AS cls_flg,
                   d.PR_NO AS pr_no,
                   h.UPDT_DT AS src_updated
            FROM JEILMNS.dbo.M_PUR_ORD_HDR h WITH (NOLOCK)
            JOIN JEILMNS.dbo.M_PUR_ORD_DTL d WITH (NOLOCK) ON d.PO_NO = h.PO_NO
            LEFT JOIN JEILMNS.dbo.B_BIZ_PARTNER b WITH (NOLOCK) ON b.BP_CD = h.BP_CD
            LEFT JOIN JEILMNS.dbo.B_ITEM i WITH (NOLOCK) ON i.ITEM_CD = d.ITEM_CD
            WHERE h.PO_DT >= ? AND h.PO_DT < ?
        """,
        "params": ["year_start", "year_end"],
        "incr_sql": " AND h.UPDT_DT >= ?",   # 증분: 연 범위 내 변경분만(watermark 이후)
    },
    # ⓪-2 구매요청 원장 ← M_PUR_REQ (2026년 요청분, PR_NO 기준) — 발주(pur_order_s.pr_no)와 연결
    "pur_req": {
        "table": "pur_req_s",
        "sql": """
            SELECT r.PR_NO AS pr_no, r.PR_TYPE AS pr_type, r.PR_STS AS pr_sts, r.PLANT_CD AS plant_cd,
                   r.ITEM_CD AS item_code, i.ITEM_NM AS item_name,
                   r.REQ_QTY AS req_qty, r.REQ_UNIT AS req_unit, r.ORD_QTY AS ord_qty,
                   r.RCPT_QTY AS rcpt_qty, r.IV_QTY AS iv_qty,
                   CONVERT(date, r.REQ_DT) AS req_dt, CONVERT(date, r.DLVY_DT) AS dlvy_dt,
                   CONVERT(date, r.PUR_PLAN_DT) AS pur_plan_dt,
                   r.REQ_DEPT AS req_dept, r.REQ_PRSN AS req_prsn,
                   r.SPPL_CD AS sppl_code, b.BP_NM AS sppl_name, r.SO_NO AS so_no,
                   -- 상세 확충(2026-07-21): 조달구분·확정/릴리즈 수량·구매조직·도면·추적번호·생성/수정자
                   r.PROCURE_TYPE AS procure_type, r.REQ_CFM_QTY AS req_cfm_qty, r.RLS_ORD_QTY AS rls_ord_qty,
                   r.PUR_GRP AS pur_grp, r.PUR_ORG AS pur_org, r.SL_CD AS sl_cd, r.SO_SEQ_NO AS so_seq_no,
                   r.DW_NO1 AS dw_no1, r.TRACKING_NO AS tracking_no, r.CHANGE_ORDER AS change_order,
                   r.MRP_ORD_NO AS mrp_ord_no, r.INSRT_DT AS insrt_dt,
                   r.INSRT_USER_ID AS insrt_user_id, r.UPDT_USER_ID AS updt_user_id,
                   r.UPDT_DT AS src_updated
            FROM JEILMNS.dbo.M_PUR_REQ r WITH (NOLOCK)
            LEFT JOIN JEILMNS.dbo.B_ITEM i WITH (NOLOCK) ON i.ITEM_CD = r.ITEM_CD
            LEFT JOIN JEILMNS.dbo.B_BIZ_PARTNER b WITH (NOLOCK) ON b.BP_CD = r.SPPL_CD
            WHERE r.REQ_DT >= ? AND r.REQ_DT < ?
        """,
        "params": ["year_start", "year_end"],
        "incr_sql": " AND r.UPDT_DT >= ?",   # 증분: 변경분만(watermark 이후)
    },
    # ① 품목 마스터 스냅샷 ← B_ITEM (전체 재적재)
    "item_master": {
        "table": "item_master_s",
        "sql": """
            SELECT ITEM_CD AS item_code, ITEM_NM AS item_name, SPEC AS spec,
                   BASIC_UNIT AS unit, ITEM_ACCT AS item_class,
                   CONVERT(bit, CASE WHEN VALID_FLG = 'Y' THEN 1 ELSE 0 END) AS use_yn,
                   UPDT_DT AS src_updated
            FROM JEILMNS.dbo.B_ITEM WITH (NOLOCK)
        """,
        "params": [],
        "incr_sql": " WHERE UPDT_DT >= ?",   # 증분: 변경된 품목만(watermark 이후)
    },
    # ② 영업 매출/수금 월집계 ← S_BILL_HDR (TARGET_YEAR 전체) ※ 수주(order_amt)는 S_SO 확정 후 추가
    "sales": {
        "table": "sales_orders_m",
        "sql": """
            SELECT CONVERT(char(7), h.BILL_DT, 120) AS ym,
                   h.SOLD_TO_PARTY AS bp_code,
                   ISNULL(MAX(b.BP_NM), h.SOLD_TO_PARTY) AS bp_name,
                   SUM(h.BILL_AMT_LOC) AS sales_amt,
                   SUM(h.COLLECT_AMT_LOC) AS collect_amt,
                   COUNT(DISTINCT h.BILL_NO) AS order_cnt
            FROM JEILMNS.dbo.S_BILL_HDR h WITH (NOLOCK)
            LEFT JOIN JEILMNS.dbo.B_BIZ_PARTNER b WITH (NOLOCK) ON b.BP_CD = h.SOLD_TO_PARTY
            WHERE h.BILL_DT >= ? AND h.BILL_DT < ?
            GROUP BY CONVERT(char(7), h.BILL_DT, 120), h.SOLD_TO_PARTY
        """,
        "params": ["year_start", "year_end"],
    },
    # ③ 구매 거래처별 매입 월집계 ← M_IV_HDR (TARGET_YEAR 전체)
    # 매입 상세(라인) — M_IV_DTL + M_IV_HDR. 월집계(purchase_m)만으로는 '무엇을 얼마에' 매입했는지 알 수 없어 신설.
    # 발주(PO_NO·PO_SEQ_NO)·입고(MVMT_NO) 연결키를 함께 적재 → 발주→입고→매입 추적 연결.
    "iv_dtl": {
        "table": "iv_dtl_s",
        "sql": """
            SELECT d.IV_NO AS iv_no, d.IV_SEQ_NO AS iv_seq_no,
                   CONVERT(date, h.IV_DT) AS iv_dt, h.BP_CD AS bp_code, b.BP_NM AS bp_name,
                   d.PO_NO AS po_no, d.PO_SEQ_NO AS po_seq_no,
                   d.ITEM_CD AS item_code, i.ITEM_NM AS item_name,
                   d.IV_QTY AS iv_qty, d.IV_UNIT AS iv_unit, d.IV_PRC AS iv_prc,
                   d.IV_LOC_AMT AS iv_loc_amt, d.VAT_LOC_AMT AS vat_loc_amt,
                   d.MVMT_NO AS mvmt_no, d.MVMT_QTY AS mvmt_qty,
                   d.PLANT_CD AS plant_cd, d.REMARK AS remark,
                   d.UPDT_DT AS src_updated
            FROM JEILMNS.dbo.M_IV_DTL d WITH (NOLOCK)
            JOIN JEILMNS.dbo.M_IV_HDR h WITH (NOLOCK) ON h.IV_NO = d.IV_NO
            LEFT JOIN JEILMNS.dbo.B_ITEM i WITH (NOLOCK) ON i.ITEM_CD = d.ITEM_CD
            LEFT JOIN JEILMNS.dbo.B_BIZ_PARTNER b WITH (NOLOCK) ON b.BP_CD = h.BP_CD
            WHERE h.IV_DT >= ? AND h.IV_DT < ?
        """,
        "params": ["year_start", "year_end"],
        "incr_sql": " AND d.UPDT_DT >= ?",   # 증분: 변경분만(watermark 이후)
    },
    "purchase": {
        "table": "purchase_m",
        "sql": """
            SELECT CONVERT(char(7), h.IV_DT, 120) AS ym,
                   h.BP_CD AS bp_code,
                   ISNULL(MAX(b.BP_NM), h.BP_CD) AS bp_name,
                   SUM(h.NET_LOC_AMT) AS purchase_amt,
                   COUNT(DISTINCT h.IV_NO) AS iv_cnt
            FROM JEILMNS.dbo.M_IV_HDR h WITH (NOLOCK)
            LEFT JOIN JEILMNS.dbo.B_BIZ_PARTNER b WITH (NOLOCK) ON b.BP_CD = h.BP_CD
            WHERE h.IV_DT >= ? AND h.IV_DT < ?
            GROUP BY CONVERT(char(7), h.IV_DT, 120), h.BP_CD
        """,
        "params": ["year_start", "year_end"],
    },
    # ④ 자재 재고 입출고 일집계 ← M_PUR_GOODS_MVMT (2026년 전체)
    #    ⚠ in/out 분류(IO_TYPE_CD 체계: R01=입고, T62=이동 등)는 dry-run으로 코드 분포 확인 후 확정
    "inventory": {
        "table": "inventory_d",
        "sql": """
            SELECT CONVERT(date, MVMT_DT) AS ymd, ITEM_CD AS item_code,
                   ISNULL(MVMT_SL_CD, '-') AS wh_code,
                   SUM(CASE WHEN IO_TYPE_CD LIKE 'R%' THEN MVMT_BASE_QTY ELSE 0 END) AS in_qty,
                   SUM(CASE WHEN IO_TYPE_CD NOT LIKE 'R%' THEN MVMT_BASE_QTY ELSE 0 END) AS out_qty
            FROM JEILMNS.dbo.M_PUR_GOODS_MVMT WITH (NOLOCK)
            WHERE MVMT_DT >= ? AND MVMT_DT < ?
            GROUP BY CONVERT(date, MVMT_DT), ITEM_CD, ISNULL(MVMT_SL_CD, '-')
        """,
        "params": ["year_start", "year_end"],
    },
}

CHUNK_ROWS = 500


def rpc(url, key, fn, payload):
    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    req = urllib.request.Request(
        f"{url}/rest/v1/rpc/{fn}", data=body, method="POST",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read().decode().strip().strip('"')
        return raw


def parse_ts(raw):
    """RPC(timestamptz) 반환 문자열 → datetime. null/빈값이면 None."""
    if not raw or raw.lower() == "null":
        return None
    try:
        return datetime.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def watermark(url, key, name):
    """job 대상 테이블의 최신 src_updated - LOOKBACK_DAYS. 최초 적재(값 없음)면 None."""
    wm = parse_ts(rpc(url, key, "erp_etl_watermark", {"p_job": name}))
    return (wm - datetime.timedelta(days=LOOKBACK_DAYS)) if wm else None


def param_value(name):
    today = datetime.date.today()
    if name == "rolling_start":
        y, m = today.year, today.month - (ROLLING_MONTHS - 1)
        while m <= 0:
            y, m = y - 1, m + 12
        return datetime.date(y, m, 1)
    if name == "daily_start":
        return today - datetime.timedelta(days=31)
    if name == "year_start":
        return datetime.date(TARGET_YEAR, 1, 1)
    if name == "year_end":
        return datetime.date(TARGET_YEAR + 1, 1, 1)
    if name == "ym_start":            # 급여 귀속월 문자열 필터(YYYYMM)
        return f"{TARGET_YEAR}01"
    if name == "ym_end":
        return f"{TARGET_YEAR + 1}01"
    raise ValueError(name)


def run_job(name, spec, url, key, dry, full=False):
    import pyodbc  # 지연 import — dict 적재 등에서 불필요한 의존 방지
    from _erp_conn import erp_conn_str  # ERP_DB_CONN 비어 있으면 %USERPROFILE%\.erp\ DPAPI 폴백
    conn_str = erp_conn_str()
    print(f"[{name}] 추출 시작")

    # 증분 모드: incr_sql 있는 job은 watermark 이후 변경분만 추출(--full 이면 전량)
    sql = spec["sql"]
    params = [param_value(p) for p in spec["params"]]
    incr = spec.get("incr_sql")
    if incr and not full:
        wm = watermark(url, key, name)
        if wm:
            sql = sql + incr
            params.append(wm)
            print(f"[{name}] 증분 — {wm:%Y-%m-%d %H:%M} 이후 변경분만")
        else:
            print(f"[{name}] 최초 전량 적재(watermark 없음)")
    elif incr and full:
        print(f"[{name}] --full 전량 재적재")

    batch_id = None if dry else rpc(url, key, "erp_etl_batch", {"p_action": "start", "p_payload": {"job_name": name}})
    upsert_fn = spec.get("rpc", "erp_etl_upsert")  # job별 적재 RPC(민감은 erp_secure_upsert)
    rows_read = rows_up = 0
    try:
        with pyodbc.connect(conn_str, timeout=30) as conn:
            cur = conn.cursor()
            cur.execute(sql, *params)
            cols = [c[0] for c in cur.description]
            buf = []
            for rec in cur:
                row = dict(zip(cols, rec))
                if not dry:
                    row["batch_id"] = batch_id
                buf.append(row)
                rows_read += 1
                if len(buf) >= CHUNK_ROWS and not dry:
                    rows_up += int(rpc(url, key, upsert_fn, {"p_table": spec["table"], "p_rows": buf}) or 0)
                    buf = []
            if buf and not dry:
                rows_up += int(rpc(url, key, upsert_fn, {"p_table": spec["table"], "p_rows": buf}) or 0)
        if dry:
            print(f"[{name}] (dry-run) 추출 {rows_read}행 — 적재 생략")
        else:
            rpc(url, key, "erp_etl_batch", {"p_action": "finish", "p_payload": {
                "batch_id": batch_id, "status": "success", "rows_read": rows_read, "rows_upserted": rows_up}})
            print(f"[{name}] 완료 — 추출 {rows_read} / 적재 {rows_up}")
    except Exception as e:
        if batch_id:
            rpc(url, key, "erp_etl_batch", {"p_action": "finish", "p_payload": {
                "batch_id": batch_id, "status": "failed", "rows_read": rows_read, "error_msg": str(e)[:500]}})
        print(f"[{name}] 실패: {e}", file=sys.stderr)
        raise


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", default="all", choices=["all", *JOBS.keys()])
    ap.add_argument("--dry-run", action="store_true", help="추출·건수만 확인(적재 안 함)")
    ap.add_argument("--full", action="store_true", help="증분 무시하고 전량 재적재(주기적 정합·초기 적재용)")
    args = ap.parse_args()
    load_env()
    url = need("SUPABASE_URL").rstrip("/")
    key = need("SUPABASE_SERVICE_ROLE_KEY")
    targets = list(JOBS.items()) if args.job == "all" else [(args.job, JOBS[args.job])]
    fail = 0
    for name, spec in targets:
        try:
            run_job(name, spec, url, key, args.dry_run, args.full)
        except Exception:
            fail += 1
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
