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

JOBS = {
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
                   h.UPDT_DT AS src_updated
            FROM JEILMNS.dbo.M_PUR_ORD_HDR h WITH (NOLOCK)
            JOIN JEILMNS.dbo.M_PUR_ORD_DTL d WITH (NOLOCK) ON d.PO_NO = h.PO_NO
            LEFT JOIN JEILMNS.dbo.B_BIZ_PARTNER b WITH (NOLOCK) ON b.BP_CD = h.BP_CD
            LEFT JOIN JEILMNS.dbo.B_ITEM i WITH (NOLOCK) ON i.ITEM_CD = d.ITEM_CD
            WHERE h.PO_DT >= ? AND h.PO_DT < ?
        """,
        "params": ["year_start", "year_end"],
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
    # ④ 자재 재고 입출고 일집계 ← M_PUR_GOODS_MVMT (롤링 31일)
    #    ⚠ in/out 분류(IO_TYPE_CD 체계: R01=입고, T62=이동 등)는 dry-run으로 코드 분포 확인 후 확정
    "inventory": {
        "table": "inventory_d",
        "sql": """
            SELECT CONVERT(date, MVMT_DT) AS ymd, ITEM_CD AS item_code,
                   ISNULL(MVMT_SL_CD, '-') AS wh_code,
                   SUM(CASE WHEN IO_TYPE_CD LIKE 'R%' THEN MVMT_BASE_QTY ELSE 0 END) AS in_qty,
                   SUM(CASE WHEN IO_TYPE_CD NOT LIKE 'R%' THEN MVMT_BASE_QTY ELSE 0 END) AS out_qty
            FROM JEILMNS.dbo.M_PUR_GOODS_MVMT WITH (NOLOCK)
            WHERE MVMT_DT >= ?
            GROUP BY CONVERT(date, MVMT_DT), ITEM_CD, ISNULL(MVMT_SL_CD, '-')
        """,
        "params": ["daily_start"],
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
    raise ValueError(name)


def run_job(name, spec, url, key, dry):
    import pyodbc  # 지연 import — dict 적재 등에서 불필요한 의존 방지
    from _erp_conn import erp_conn_str  # ERP_DB_CONN 비어 있으면 %USERPROFILE%\.erp\ DPAPI 폴백
    conn_str = erp_conn_str()
    print(f"[{name}] 추출 시작")
    batch_id = None if dry else rpc(url, key, "erp_etl_batch", {"p_action": "start", "p_payload": {"job_name": name}})
    rows_read = rows_up = 0
    try:
        with pyodbc.connect(conn_str, timeout=30) as conn:
            cur = conn.cursor()
            cur.execute(spec["sql"], *[param_value(p) for p in spec["params"]])
            cols = [c[0] for c in cur.description]
            buf = []
            for rec in cur:
                row = dict(zip(cols, rec))
                if not dry:
                    row["batch_id"] = batch_id
                buf.append(row)
                rows_read += 1
                if len(buf) >= CHUNK_ROWS and not dry:
                    rows_up += int(rpc(url, key, "erp_etl_upsert", {"p_table": spec["table"], "p_rows": buf}) or 0)
                    buf = []
            if buf and not dry:
                rows_up += int(rpc(url, key, "erp_etl_upsert", {"p_table": spec["table"], "p_rows": buf}) or 0)
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
    args = ap.parse_args()
    load_env()
    url = need("SUPABASE_URL").rstrip("/")
    key = need("SUPABASE_SERVICE_ROLE_KEY")
    targets = list(JOBS.items()) if args.job == "all" else [(args.job, JOBS[args.job])]
    fail = 0
    for name, spec in targets:
        try:
            run_job(name, spec, url, key, args.dry_run)
        except Exception:
            fail += 1
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
