# -*- coding: utf-8 -*-
r"""verify_ledger.py — AX 전표와 원본 수기 전표의 **장부 결과**를 대조한다(읽기 전용).

무엇을 답하나
  「AX 로 만든 전표가 사람이 손으로 만든 전표와 장부상 똑같은가?」

  라인 대조(릴레이가 투입 직후 하는 것)는 *전표 안*만 본다. 이 도구는 그 바깥,
  **전표가 만들어 낸 원장**을 본다 — 채무·부가세·선급·선수·미결.
  회계가 실제로 쓰는 것은 전표가 아니라 그 원장이다.

방법
  `seed_ledger_cases.py` 가 실제 승인 전표(TG…)를 복제해 만든 AX 전표(AG…)를
  원본과 나란히 놓고 다음을 비교한다.

    ① 전표 라인   계정 · 차대 · 금액          (다중집합 비교 — 엔진이 순서를 바꾼다)
    ② 관리항목    코드 · 값                   (날짜형은 제외 — 복제할 때 오늘로 옮겼다)
    ③ 부가세      A_VAT     건수 · 과세표준 · 세액
    ④ 채무        A_OPEN_AP 건수 · 금액 · 거래처
    ⑤ 선급        F_PRPAYM  건수 · 금액
    ⑥ 선수        F_PRRCPT  건수 · 금액
    ⑦ 미결        A_OPEN_ACCT 건수 · 금액 · 관리값(사번)   ← 승인 후에만 생긴다

사용
    python 10_ERP_DB연계/etl/verify_ledger.py            배치 전건
    python 10_ERP_DB연계/etl/verify_ledger.py --case V1
"""
import argparse
import json
import os
import sys
import urllib.request
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _env import load_env  # noqa: E402
import gl_apply_demo2 as R  # noqa: E402

BATCH = "LEDGERSET-2026-08-26"
DATE_CTRL = {"V2", "C1", "XC1", "C2"}      # 복제 시 오늘로 옮긴 항목 — 값 비교에서 뺀다


def portal_rows(url, key):
    """포털에서 이 배치의 초안과 ERP 전표번호를 읽는다."""
    req = urllib.request.Request(
        f"{url}/rest/v1/gl_draft?select=draft_no,gl_desc,erp_apply_status,erp_apply_gl_no"
        f"&ref_no=eq.{BATCH}&order=draft_no",
        headers={"apikey": key, "Authorization": f"Bearer {key}",
                 "Prefer": "return=representation"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def slip_lines(cur, no):
    cur.execute("""SELECT RTRIM(ACCT_CD), RTRIM(DR_CR_FG), CAST(ITEM_AMT AS bigint)
                     FROM dbo.A_TEMP_GL_ITEM WITH (NOLOCK) WHERE TEMP_GL_NO = ?""", no)
    return Counter((r[0], r[1][:1], int(r[2])) for r in cur.fetchall())


def slip_ctrls(cur, no):
    """관리항목을 (계정, 차대, 코드, 값) 다중집합으로. 라인 순서에 의존하지 않는다."""
    cur.execute("""SELECT RTRIM(i.ACCT_CD), RTRIM(i.DR_CR_FG), RTRIM(d.CTRL_CD),
                          RTRIM(ISNULL(d.CTRL_VAL,''))
                     FROM dbo.A_TEMP_GL_DTL d WITH (NOLOCK)
                     JOIN dbo.A_TEMP_GL_ITEM i WITH (NOLOCK)
                       ON i.TEMP_GL_NO = d.TEMP_GL_NO AND i.ITEM_SEQ = d.ITEM_SEQ
                    WHERE d.TEMP_GL_NO = ? AND RTRIM(ISNULL(d.CTRL_VAL,'')) <> ''""", no)
    return Counter((r[0], r[1][:1], r[2], r[3].replace(",", ""))
                   for r in cur.fetchall() if r[2] not in DATE_CTRL)


def ledgers(cur, no):
    """전표가 만든 원장 요약. 승인 전이면 미결(A_OPEN_ACCT)은 비어 있는 것이 정상."""
    out = {}
    cur.execute("""SELECT COUNT(*), ISNULL(SUM(CAST(NET_AMT AS bigint)),0),
                          ISNULL(SUM(CAST(VAT_AMT AS bigint)),0)
                     FROM dbo.A_VAT WITH (NOLOCK) WHERE TEMP_GL_NO = ?""", no)
    n, base, vat = cur.fetchone()
    out["부가세"] = (int(n), f"과세표준 {int(base):,} · 세액 {int(vat):,}")
    cur.execute("""SELECT COUNT(*), ISNULL(SUM(CAST(AP_AMT AS bigint)),0),
                          ISNULL(COUNT(DISTINCT RTRIM(ISNULL(DEAL_BP_CD,''))),0)
                     FROM dbo.A_OPEN_AP WITH (NOLOCK) WHERE TEMP_GL_NO = ?""", no)
    n, amt, bp = cur.fetchone()
    out["채무"] = (int(n), f"{int(amt):,}원 · 거래처 {int(bp)}곳")
    cur.execute("""SELECT COUNT(*), ISNULL(SUM(CAST(PRPAYM_AMT AS bigint)),0)
                     FROM dbo.F_PRPAYM WITH (NOLOCK) WHERE TEMP_GL_NO = ?""", no)
    n, amt = cur.fetchone()
    out["선급"] = (int(n), f"{int(amt):,}원")
    cur.execute("""SELECT COUNT(*), ISNULL(SUM(CAST(PRRCPT_AMT AS bigint)),0)
                     FROM dbo.F_PRRCPT WITH (NOLOCK) WHERE TEMP_GL_NO = ?""", no)
    n, amt = cur.fetchone()
    out["선수"] = (int(n), f"{int(amt):,}원")
    # 미결은 전표번호가 아니라 정식전표번호(GL_NO)로 선다 — 승인 뒤에야 생긴다
    cur.execute("SELECT RTRIM(ISNULL(GL_NO,'')) FROM dbo.A_TEMP_GL WITH (NOLOCK) WHERE TEMP_GL_NO=?", no)
    r = cur.fetchone()
    gl_no = (r[0] if r else "") or ""
    if gl_no:
        cur.execute("""SELECT COUNT(*), ISNULL(SUM(CAST(OPEN_AMT AS bigint)),0),
                              COUNT(DISTINCT RTRIM(ISNULL(MGNT_VAL1,'')))
                         FROM dbo.A_OPEN_ACCT WITH (NOLOCK) WHERE GL_NO = ?""", gl_no)
        n, amt, mv = cur.fetchone()
        out["미결"] = (int(n), f"{int(amt):,}원 · 관리값 {int(mv)}종")
    else:
        out["미결"] = (0, "(승인 전)")
    return out, gl_no


def conf_of(cur, no):
    cur.execute("SELECT RTRIM(ISNULL(CONF_FG,'')) FROM dbo.A_TEMP_GL WITH (NOLOCK) WHERE TEMP_GL_NO=?", no)
    r = cur.fetchone()
    return (r[0] if r else "") or "?"


def diff_counter(a, b, label, fmt):
    """다중집합 차이. 양쪽에만 있는 항목을 사람이 읽을 형태로."""
    only_a, only_b = (a - b), (b - a)
    if not only_a and not only_b:
        return []
    out = []
    for k, c in sorted(only_a.items()):
        out.append(f"      원본에만 {label}: {fmt(k)}" + (f" ×{c}" if c > 1 else ""))
    for k, c in sorted(only_b.items()):
        out.append(f"      AX에만  {label}: {fmt(k)}" + (f" ×{c}" if c > 1 else ""))
    return out


def main():
    ap = argparse.ArgumentParser(description="AX 전표 ↔ 원본 수기 전표 장부 대조(읽기 전용)")
    ap.add_argument("--case", help="케이스 하나만(V1 …)")
    a = ap.parse_args()
    load_env()
    url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

    rows = portal_rows(url, key)
    if a.case:
        rows = [r for r in rows if f"-{a.case}-" in r["draft_no"]]
    if not rows:
        print("대조할 초안이 없습니다. seed_ledger_cases.py --load 를 먼저 실행하세요.")
        return 0

    conn = R.demo_conn()
    cur = conn.cursor()
    ok_all, pending, bad = 0, 0, 0
    print(f"\n{'═'*80}\n 장부 대조 — AX 전표 ↔ 원본 수기 전표\n{'═'*80}")
    for r in rows:
        cid = r["draft_no"].split("-")[2]
        origin = ""
        if "(원본 " in (r["gl_desc"] or ""):
            origin = r["gl_desc"].split("(원본 ")[1].rstrip(")").strip()
        ag = (r.get("erp_apply_gl_no") or "").strip()
        print(f"\n  [{cid}] {r['draft_no']}  ↔  원본 {origin or '?'}")
        if not ag:
            print(f"      아직 ERP 로 보내지 않았습니다(상태: {r.get('erp_apply_status') or '미전송'})")
            pending += 1
            continue
        print(f"      AX 전표 {ag} (승인 {conf_of(cur, ag)})  ·  원본 승인 {conf_of(cur, origin)}")

        problems = []
        problems += diff_counter(slip_lines(cur, origin), slip_lines(cur, ag), "라인",
                                 lambda k: f"{k[0]} {'차' if k[1]=='D' else '대'} {k[2]:,}")
        problems += diff_counter(slip_ctrls(cur, origin), slip_ctrls(cur, ag), "관리항목",
                                 lambda k: f"{k[0]} {'차' if k[1]=='D' else '대'} {k[2]}={k[3]}")

        lo, _ = ledgers(cur, origin)
        la, gl_ax = ledgers(cur, ag)
        for name in ("부가세", "채무", "선급", "선수", "미결"):
            if lo[name] == la[name]:
                if lo[name][0]:
                    print(f"      ✅ {name:<4} {lo[name][0]}행 · {lo[name][1]}")
            else:
                # 미결은 승인 시점에 생긴다 — 한쪽만 승인이면 차이가 아니라 '아직'이다
                if name == "미결" and (not gl_ax or la[name][1] == "(승인 전)"):
                    print(f"      ⏳ {name:<4} AX 승인 후에 생깁니다(원본 {lo[name][0]}행)")
                    continue
                problems.append(f"      ❌ {name}: 원본 {lo[name][0]}행 {lo[name][1]}"
                                f"  ↔  AX {la[name][0]}행 {la[name][1]}")
        if problems:
            bad += 1
            print("      ── 차이 ──")
            for p in problems:
                print(p)
        else:
            ok_all += 1
            print("      ✅ 라인·관리항목·원장 전부 일치")

    conn.close()
    print(f"\n{'─'*80}\n 일치 {ok_all} · 차이 {bad} · 미전송 {pending}\n{'─'*80}\n")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
