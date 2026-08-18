# -*- coding: utf-8 -*-
r"""결의전표 월반복 패턴 분석 — 읽기전용 SELECT만 (CLAUDE.md §4 준수).

ERP운영DB A_TEMP_GL / A_TEMP_GL_ITEM / A_TEMP_GL_DTL 의 수기(TG) 전표를
읽기전용으로 조회해, 매달 같은 형태로 반복되는 전표 패밀리를 발굴한다.
템플릿 플랫폼 v2(월반복 자동화)의 시드 후보 생성·재분석 도구
(기획: 10_ERP_DB연계/10_반복전표_자동화_기획.md §6.6 — 분기 1회 재실행 권장).

원칙:
- WITH (NOLOCK) + 파라미터 바인딩, DDL/DML 없음 (운영 DB 부하·변경 금지)
- 민감값 미수집: 은행계좌·사원번호·카드·어음번호는 컬럼 미조회 또는 값 마스킹
  (관리항목 EM/BA/D1/CP/NN 은 고유값 '개수'만 기록 — 고정/변동 판별에 충분)
- 출력(JSON)은 실전표 데이터 포함 → OneDrive 밖 %LOCALAPPDATA%\jeilax\erp_analysis\
  에만 저장(커밋·중간DB 적재 금지)

패밀리 판정: 부서 + 정렬된 (계정,차대) 조합 + 거래처 집합이 동일한 전표 묶음.
  - n_months >= --min-months(기본 3) 이면 반복 패밀리
  - monthly_one: n_months>=6 이고 전표수==월수 (순수 월반복 — 1차 시드 후보)
  - type 분류 규칙(문서 §3.3과 동일):
      T1/T2 = 부가세대급금(11103301) 포함, 총액 완전고정이면 T1 아니면 T2
      T5 = 예수금·미지급세금·미지급급여 계정 포함(원천세·보험·급여)
      T3 = 미지급금(개인) 등 '개인' 계정 포함
      T6 = 보통예금 포함 + 자산/비용 계정만(자금 이체·수수료)
      T7 = 그 외(계산서 없는 거래처 지급 등)
  - month_offset: 제목의 월 표기 − 결의월 (0=당월형, -1=전월형, None=월표기 없음)

사용: python analyze_repeat_gl.py [--year 2026] [--min-months 3]
"""
import argparse
import datetime
import json
import os
import re
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from _env import load_env  # noqa: E402
from _erp_conn import erp_conn_str  # noqa: E402

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

# 값을 기록하지 않는 관리항목(고유값 개수만): 사번·계좌·신용카드·구매카드·어음
SENSITIVE_CTRL = {"EM", "BA", "D1", "CP", "NN"}

Q_HEADERS = """
SELECT h.TEMP_GL_NO, CONVERT(date, h.TEMP_GL_DT) AS TEMP_GL_DT,
       h.GL_NO, h.DEPT_CD, h.COST_CD, h.GL_TYPE, h.GL_INPUT_TYPE, h.CONF_FG,
       h.DR_LOC_AMT, h.TEMP_GL_DESC, h.INSRT_USER_ID, h.REF_NO,
       CONVERT(date, h.ISSUED_DT) AS ISSUED_DT, h.attach_cnt
FROM JEILMNS.dbo.A_TEMP_GL h WITH (NOLOCK)
WHERE h.TEMP_GL_DT >= ? AND h.TEMP_GL_DT < ? AND h.GL_INPUT_TYPE = ?
"""

Q_ITEMS = """
SELECT i.TEMP_GL_NO, i.ITEM_SEQ, i.ACCT_CD, i.DR_CR_FG, i.DEPT_CD, i.COST_CD,
       i.VAT_TYPE, i.ITEM_LOC_AMT, i.VAT_LOC_AMT, i.ITEM_DESC, i.BP_CD,
       i.TAX_BIZ_AREA, i.ISSUED_DT, i.RELATIVE_ACCT_CD, i.ITEM_CD, i.PROJECT_NO, i.IO_FG
FROM JEILMNS.dbo.A_TEMP_GL_ITEM i WITH (NOLOCK)
JOIN JEILMNS.dbo.A_TEMP_GL h WITH (NOLOCK) ON h.TEMP_GL_NO = i.TEMP_GL_NO
WHERE h.TEMP_GL_DT >= ? AND h.TEMP_GL_DT < ? AND h.GL_INPUT_TYPE = ?
"""

Q_DTL = """
SELECT d.TEMP_GL_NO, d.ITEM_SEQ, d.DTL_SEQ, d.CTRL_CD, d.CTRL_VAL
FROM JEILMNS.dbo.A_TEMP_GL_DTL d WITH (NOLOCK)
JOIN JEILMNS.dbo.A_TEMP_GL h WITH (NOLOCK) ON h.TEMP_GL_NO = d.TEMP_GL_NO
WHERE h.TEMP_GL_DT >= ? AND h.TEMP_GL_DT < ? AND h.GL_INPUT_TYPE = ?
"""

Q_CTRL_ITEM = "SELECT * FROM JEILMNS.dbo.A_CTRL_ITEM WITH (NOLOCK)"
Q_ACCT_CTRL = "SELECT * FROM JEILMNS.dbo.A_ACCT_CTRL_ASSN WITH (NOLOCK)"
Q_ACCT = "SELECT ACCT_CD, ACCT_NM FROM JEILMNS.dbo.A_ACCT WITH (NOLOCK) WHERE ISNULL(DEL_FG,'N') <> 'Y'"
Q_BP = "SELECT BP_CD, BP_NM FROM JEILMNS.dbo.B_BIZ_PARTNER WITH (NOLOCK)"
Q_DEPT = "SELECT DEPT_CD, DEPT_NM FROM JEILMNS.dbo.B_ACCT_DEPT WITH (NOLOCK)"


def rows_to_dicts(cur):
    cols = [c[0] for c in cur.description]
    out = []
    for r in cur.fetchall():
        d = {}
        for k, v in zip(cols, r):
            if isinstance(v, (datetime.date, datetime.datetime)):
                v = v.isoformat()[:10]
            elif hasattr(v, "quantize"):  # Decimal
                v = float(v)
            elif isinstance(v, str):
                v = v.strip()
            d[k] = v
        out.append(d)
    return out


def norm_title(t):
    """제목에서 연/월 표기를 제거해 반복 전표의 '제목 줄기'를 만든다."""
    if not t:
        return ""
    s = t
    s = re.sub(r"20\d{2}[-./년\s]*\d{1,2}[월분]*", " ", s)   # 2026년 7월 / 2026-07
    s = re.sub(r"\d{2}년\s*\d{1,2}월분?", " ", s)             # 26년7월분
    s = re.sub(r"\d{1,2}월분?", " ", s)                        # 7월분 / 7월
    s = re.sub(r"[\(\[]?\d{4}[-./]?\d{1,2}[-./]?\d{0,2}[\)\]]?", " ", s)
    s = re.sub(r"\d+", "#", s)                                  # 남은 숫자는 #
    s = re.sub(r"[\s_\-/,.·]+", " ", s).strip()
    return s


def title_month(t):
    m = re.search(r"(\d{1,2})월", t or "")
    return int(m.group(1)) if m else None


def classify_family(line_detail, amt_fixed):
    """문서 §3.3 유형 분류 규칙 (T4 결번 — 급여형은 T5에 통합)."""
    accts = {l["acct_cd"] for l in line_detail}
    names = {l["acct_cd"]: l["acct_nm"] or "" for l in line_detail}
    if "11103301" in accts:
        return "T1" if amt_fixed else "T2"
    if any(names[a].startswith("예수금") or names[a] in ("미지급세금", "미지급급여") for a in accts):
        return "T5"
    if any("개인" in names[a] for a in accts):
        return "T3"
    if any(names[a] == "보통예금" for a in accts) and \
       all(a.startswith("111") or names[a].startswith(("판)", "제)", "연)")) for a in accts):
        return "T6"
    return "T7"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=2026)
    ap.add_argument("--min-months", type=int, default=3, help="반복 판정 최소 월수")
    args = ap.parse_args()
    year_start = f"{args.year}-01-01"
    year_end = f"{args.year + 1}-01-01"

    load_env()
    import pyodbc
    conn = pyodbc.connect(erp_conn_str(), timeout=30)
    conn.autocommit = True  # 읽기전용 SELECT만 — 트랜잭션 잔류 방지
    cur = conn.cursor()

    params = (year_start, year_end, "TG")
    print("[1/6] 헤더 조회...", flush=True)
    cur.execute(Q_HEADERS, params)
    headers = rows_to_dicts(cur)
    print(f"  headers={len(headers)}", flush=True)

    print("[2/6] 라인 조회...", flush=True)
    cur.execute(Q_ITEMS, params)
    items = rows_to_dicts(cur)
    print(f"  items={len(items)}", flush=True)

    print("[3/6] 관리항목(DTL) 조회...", flush=True)
    cur.execute(Q_DTL, params)
    dtls = rows_to_dicts(cur)
    print(f"  dtls={len(dtls)}", flush=True)

    print("[4/6] 마스터(관리항목·계정·거래처·부서) 조회...", flush=True)
    cur.execute(Q_CTRL_ITEM)
    ctrl_items = rows_to_dicts(cur)
    cur.execute(Q_ACCT_CTRL)
    acct_ctrl = rows_to_dicts(cur)
    cur.execute(Q_ACCT)
    accts = {r["ACCT_CD"]: r["ACCT_NM"] for r in rows_to_dicts(cur)}
    cur.execute(Q_BP)
    bps = {r["BP_CD"]: r["BP_NM"] for r in rows_to_dicts(cur)}
    cur.execute(Q_DEPT)
    depts = {}
    for r in rows_to_dicts(cur):
        depts.setdefault(r["DEPT_CD"], r["DEPT_NM"])
    conn.close()
    print(f"  ctrl_items={len(ctrl_items)} acct_ctrl={len(acct_ctrl)} accts={len(accts)} bps={len(bps)}", flush=True)

    # ---- 인덱싱 ----
    items_by_gl = defaultdict(list)
    for it in items:
        items_by_gl[it["TEMP_GL_NO"]].append(it)
    dtl_by_gl = defaultdict(list)
    for d in dtls:
        dtl_by_gl[d["TEMP_GL_NO"]].append(d)

    print("[5/6] 반복 패밀리 탐지...", flush=True)
    fam = defaultdict(list)
    for h in headers:
        gl = h["TEMP_GL_NO"]
        lines = items_by_gl.get(gl, [])
        if not lines:
            continue
        sig = tuple(sorted((l["ACCT_CD"] or "", (l["DR_CR_FG"] or "").strip()) for l in lines))
        bpset = tuple(sorted({l["BP_CD"] for l in lines if l.get("BP_CD")}))
        key = (h.get("DEPT_CD") or "", sig, bpset)
        h["_month"] = (h["TEMP_GL_DT"] or "")[:7]
        h["_title_stem"] = norm_title(h.get("TEMP_GL_DESC"))
        fam[key].append(h)

    families = []
    for (dept, sig, bpset), hs in fam.items():
        months = sorted({h["_month"] for h in hs})
        if len(months) < args.min_months:
            continue
        amts = [h["DR_LOC_AMT"] or 0 for h in hs]
        amt_fixed = len({round(a) for a in amts}) == 1
        sample = sorted(hs, key=lambda x: x["TEMP_GL_DT"] or "")[-1]
        sample_lines = sorted(items_by_gl[sample["TEMP_GL_NO"]], key=lambda l: l["ITEM_SEQ"])
        line_amounts = defaultdict(list)  # (acct, drcr) -> [amt,...] 모든 전표
        for h in hs:
            for l in items_by_gl[h["TEMP_GL_NO"]]:
                line_amounts[(l["ACCT_CD"], (l["DR_CR_FG"] or "").strip())].append(l["ITEM_LOC_AMT"] or 0)
        line_detail = []
        for l in sample_lines:
            k = (l["ACCT_CD"], (l["DR_CR_FG"] or "").strip())
            vals = line_amounts[k]
            line_detail.append({
                "acct_cd": l["ACCT_CD"], "acct_nm": accts.get(l["ACCT_CD"], ""),
                "dr_cr": (l["DR_CR_FG"] or "").strip(),
                "bp_cd": l.get("BP_CD") or "", "bp_nm": bps.get(l.get("BP_CD") or "", ""),
                "vat_type": (l.get("VAT_TYPE") or "").strip(),
                "sample_amt": l["ITEM_LOC_AMT"], "sample_vat": l.get("VAT_LOC_AMT"),
                "amt_min": min(vals), "amt_max": max(vals),
                "amt_distinct": len({round(v) for v in vals}),
                "cost_cd": l.get("COST_CD") or "", "desc": l.get("ITEM_DESC") or "",
            })
        # 관리항목: 전 전표에서 CTRL_CD별 고유값(고정/변동 판별). 민감 항목은 개수만.
        ctrl_var_raw = defaultdict(set)
        for h in hs:
            for d in dtl_by_gl.get(h["TEMP_GL_NO"], []):
                ctrl_var_raw[(d["CTRL_CD"] or "").strip()].add((d["CTRL_VAL"] or "").strip())
        ctrl_var = {}
        for cd, vals in ctrl_var_raw.items():
            if cd in SENSITIVE_CTRL:
                ctrl_var[cd] = {"distinct": len(vals)}          # 값 미기록(민감)
            elif len(vals) <= 8:
                ctrl_var[cd] = {"distinct": len(vals), "values": sorted(vals)}
            else:
                ctrl_var[cd] = {"distinct": len(vals)}
        # 제목 월표기 오프셋(0=당월형, -1=전월형) — 최빈값
        offs = Counter()
        for h in hs:
            tm = title_month(h.get("TEMP_GL_DESC"))
            if tm is None or not h["_month"]:
                continue
            d = (tm - int(h["_month"][5:7])) % 12
            offs[0 if d == 0 else (-1 if d == 11 else 99)] += 1
        month_offset = offs.most_common(1)[0][0] if offs else None
        if month_offset == 99:
            month_offset = None
        titles = sorted({h.get("TEMP_GL_DESC") or "" for h in hs})
        ftype = classify_family(line_detail, amt_fixed)
        families.append({
            "dept_cd": dept, "dept_nm": depts.get(dept, ""),
            "type": ftype,
            "monthly_one": len(months) >= 6 and len(hs) == len(months),
            "month_offset": month_offset,
            "sig": ["{}|{}".format(a, dc) for a, dc in sig],
            "bp": [{"cd": b, "nm": bps.get(b, "")} for b in bpset],
            "n_vouchers": len(hs), "months": months, "n_months": len(months),
            "users": sorted({h["INSRT_USER_ID"] for h in hs}),
            "amt_fixed": amt_fixed,
            "amt_min": min(amts), "amt_max": max(amts),
            "titles": titles[:14],
            "title_stem": sample["_title_stem"],
            "sample_no": sample["TEMP_GL_NO"],
            "line_detail": line_detail,
            "ctrl_var": ctrl_var,
            "vouchers": [{"no": h["TEMP_GL_NO"], "dt": h["TEMP_GL_DT"], "amt": h["DR_LOC_AMT"],
                          "conf": (h["CONF_FG"] or "").strip(), "title": h.get("TEMP_GL_DESC") or ""}
                         for h in sorted(hs, key=lambda x: x["TEMP_GL_DT"] or "")],
        })
    families.sort(key=lambda f: (-f["n_months"], -f["n_vouchers"]))

    # 제목 줄기 기반 보조 탐지(계정 조합이 조금씩 달라 시그니처로 안 묶인 반복 건)
    covered = {v["no"] for f in families for v in f["vouchers"]}
    stem_fam = defaultdict(list)
    for h in headers:
        if not h.get("_title_stem") or len(h["_title_stem"]) < 4:
            continue
        stem_fam[(h.get("DEPT_CD") or "", h["_title_stem"])].append(h)
    stem_only = []
    for (dept, stem), hs in stem_fam.items():
        rem = [h for h in hs if h["TEMP_GL_NO"] not in covered]
        if len({h["_month"] for h in rem}) < args.min_months:
            continue
        stem_only.append({
            "dept_cd": dept, "dept_nm": depts.get(dept, ""), "title_stem": stem,
            "n_vouchers": len(rem), "months": sorted({h["_month"] for h in rem}),
            "users": sorted({h["INSRT_USER_ID"] for h in rem}),
            "sample": [{"no": h["TEMP_GL_NO"], "dt": h["TEMP_GL_DT"], "amt": h["DR_LOC_AMT"],
                        "title": h.get("TEMP_GL_DESC") or ""} for h in sorted(rem, key=lambda x: x["TEMP_GL_DT"] or "")[:10]],
        })
    stem_only.sort(key=lambda f: -f["n_vouchers"])

    print("[6/6] 저장...", flush=True)
    month_cnt = defaultdict(int)
    for h in headers:
        month_cnt[h["_month"]] += 1
    fam_voucher_nos = {v["no"] for f in families for v in f["vouchers"]}
    # 계정별 사용 집계(패밀리 기준 — 문서 §4.1 재현용)
    acct_usage = defaultdict(lambda: {"families": 0, "vouchers": 0})
    for f in families:
        for a in {l["acct_cd"] for l in f["line_detail"]}:
            acct_usage[a]["families"] += 1
            acct_usage[a]["vouchers"] += f["n_vouchers"]
    type_cnt = defaultdict(lambda: [0, 0])
    for f in families:
        type_cnt[f["type"]][0] += 1
        type_cnt[f["type"]][1] += f["n_vouchers"]
    stats = {
        "period": [year_start, year_end],
        "tg_total": len(headers),
        "line_total": len(items),
        "ctrl_total": len(dtls),
        "acct_master_total": len(accts),
        "bp_master_total": len(bps),
        "acct_ctrl_assn_total": len(acct_ctrl),
        "tg_by_month": dict(sorted(month_cnt.items())),
        "families": len(families),
        "vouchers_in_families": len(fam_voucher_nos),
        "coverage_pct": round(100.0 * len(fam_voucher_nos) / max(1, len(headers)), 1),
        "monthly_one_families": sum(1 for f in families if f["monthly_one"]),
        "families_by_type": {k: {"families": v[0], "vouchers": v[1]} for k, v in sorted(type_cnt.items())},
        "distinct_accts_in_families": len(acct_usage),
        "accts_in_3plus_families": sum(1 for a in acct_usage.values() if a["families"] >= 3),
        "stem_only_families": len(stem_only),
        "users_total": len({h["INSRT_USER_ID"] for h in headers}),
        "dept_total": len({h.get("DEPT_CD") for h in headers}),
    }
    out = {
        "stats": stats,
        "acct_usage": {a: dict(v, acct_nm=accts.get(a, "")) for a, v in
                       sorted(acct_usage.items(), key=lambda x: -x[1]["vouchers"])},
        "families": families,
        "stem_only": stem_only,
        "ctrl_item_master": ctrl_items,
        "acct_ctrl_assn": acct_ctrl,
    }
    # 출력은 OneDrive 밖 로컬 전용 경로 (커밋·클라우드 동기화 금지)
    out_dir = os.path.join(os.environ.get("LOCALAPPDATA", HERE), "jeilax", "erp_analysis")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"repeat_gl_{args.year}.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1, default=str)
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    print(f"완료: {out_path} (로컬 전용 — 커밋·적재 금지)")


if __name__ == "__main__":
    main()
