# -*- coding: utf-8 -*-
r"""seed_ledger_cases.py — 실제 장부 전표를 그대로 복제해 원장 검증용 초안을 만든다.

앞선 세트(`seed_test_drafts.py`)는 **가드가 잘 막는가**를 봤다. 이 세트는 다른 것을 본다:
**AX 로 만든 전표가 실제 장부에 수기 전표와 똑같이 반영되는가.**

방법
  DEMO2 에 이미 승인돼 있는 **실제 수기 전표(TG…)** 를 골라, 계정·차대·금액·관리항목을
  그대로 복제한 AX 초안을 만든다. 전송·승인 뒤 `verify_ledger.py` 로 원장 결과를
  원본과 나란히 놓고 비교한다 — 채무·부가세·선급·선수·미결 원장이 한 줄도 어긋나면 안 된다.

  발명한 전표로는 이 비교를 할 수 없다. 대조할 원본이 없기 때문이다.

민감값을 저장소에 두지 않는다(CLAUDE.md §1)
  거래처(BP)·사번(EM)·계좌(BA)·프로젝트(PC) 값은 코드에 없다.
  **실행할 때 원본 전표에서 읽어 온다.** 저장소에 남는 것은 원본 전표번호뿐이다.

날짜만 옮긴다
  전표일자는 오늘로 바꾸고, 날짜형 관리항목(계산서일·만기일)도 같이 맞춘다.
  회계기간이 닫힌 과거 날짜로 넣을 수 없기 때문이다.
  **금액·계정·차대·거래처는 원본 그대로** — 비교 대상은 그쪽이다.

사용
    python 10_ERP_DB연계/etl/seed_ledger_cases.py --plan
    python 10_ERP_DB연계/etl/seed_ledger_cases.py --load
    python 10_ERP_DB연계/etl/seed_ledger_cases.py --purge
"""
import argparse
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _env import load_env  # noqa: E402
import gl_apply_demo2 as R  # noqa: E402

BATCH = "LEDGERSET-2026-08-26"
OWNER_UPN = "dh.choi@jeilm.co.kr"
OWNER_NM = "최동혁"
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# 원장 조합별 대표 전표 — DEMO2 실측(2026-08-26)으로 고른 정상 승인 건.
# 코드에 남는 것은 전표번호뿐이고, 내용은 실행 시 읽는다.
CASES = [
    ("V1", "TG202505200022", "매입세금계산서 (채무+매입부가세)",
     "부가세 신고자료의 과세표준·세액, 채무 잔액, 판관비/제조원가 분리가 원본과 같은가"),
    ("V2", "TG202505210011", "선급금 (채무+선급+부가세)",
     "선급금 원장(F_PRPAYM)이 생기고 프로젝트·발주번호가 그대로 붙는가"),
    ("V3", "TG202505230003", "부가세 없는 채무",
     "부가세 라인이 없을 때 A_VAT 가 생기지 않고 채무만 정확히 서는가"),
    ("V4", "TG202505310074", "매출 (채권+제품매출)",
     "매출채권 원장과 프로젝트 매출 귀속이 원본과 같은가"),
    ("V5", "TG202505210004", "미결 (개인경비)",
     "미결원장(A_OPEN_ACCT)이 사번 기준으로 서는가 — 전표 라인 연결번호는 공란이 정상"),
    ("V6", "TG202505230013", "선수금 (수금)",
     "선수금 원장이 서고, 원 단위(6원·7원) 라인이 반올림 없이 그대로 들어가는가"),
    ("V7", "TG202505210013", "순수 대체 (서브원장 무관)",
     "서브원장 대상이 하나도 없을 때 총계정원장만 정확히 서는가"),
]


def rest(url, key, method, path, body=None, params=""):
    req = urllib.request.Request(
        f"{url}/rest/v1/{path}{params}",
        data=(json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None),
        method=method,
        headers={"apikey": key, "Authorization": f"Bearer {key}",
                 "Content-Type": "application/json",
                 "Prefer": "return=representation" if method == "GET" else "return=minimal"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode("utf-8")
            return json.loads(raw) if raw.strip() else []
    except urllib.error.HTTPError as e:
        raise SystemExit(f"[중단] {method} {path} → HTTP {e.code}: "
                         f"{e.read().decode('utf-8','replace')[:400]}")


def mask(v):
    s = str(v or "")
    return s if len(s) <= 2 else s[:2] + "*" * (len(s) - 2)


def read_origin(cur, tg_no):
    """원본 전표를 읽어 온다 — 헤더·라인·관리항목."""
    cur.execute("""SELECT CONVERT(varchar(10), TEMP_GL_DT, 120), RTRIM(ISNULL(DEPT_CD,'')),
                          RTRIM(ISNULL(COST_CD,'')), RTRIM(ISNULL(TEMP_GL_DESC,'')),
                          RTRIM(ISNULL(PROJECT_NO,'')), DR_AMT, RTRIM(ISNULL(CONF_FG,''))
                     FROM dbo.A_TEMP_GL WITH (NOLOCK) WHERE TEMP_GL_NO = ?""", tg_no)
    h = cur.fetchone()
    if not h:
        raise SystemExit(f"[중단] 원본 전표를 찾지 못했습니다: {tg_no}")
    cur.execute("""SELECT i.ITEM_SEQ, RTRIM(i.DR_CR_FG), RTRIM(i.ACCT_CD),
                          RTRIM(ISNULL(a.ACCT_NM,'')), i.ITEM_AMT, RTRIM(ISNULL(i.COST_CD,'')),
                          RTRIM(ISNULL(i.ITEM_DESC,'')), RTRIM(ISNULL(a.SUBSYS_TYPE,''))
                     FROM dbo.A_TEMP_GL_ITEM i WITH (NOLOCK)
                     JOIN dbo.A_ACCT a WITH (NOLOCK) ON RTRIM(a.ACCT_CD) = RTRIM(i.ACCT_CD)
                    WHERE i.TEMP_GL_NO = ? ORDER BY i.ITEM_SEQ""", tg_no)
    items = [tuple(r) for r in cur.fetchall()]
    cur.execute("""SELECT ITEM_SEQ, RTRIM(CTRL_CD), RTRIM(ISNULL(CTRL_VAL,''))
                     FROM dbo.A_TEMP_GL_DTL WITH (NOLOCK)
                    WHERE TEMP_GL_NO = ? AND RTRIM(ISNULL(CTRL_VAL,'')) <> ''
                    ORDER BY ITEM_SEQ, DTL_SEQ""", tg_no)
    ctrls = {}
    for seq, cd, val in cur.fetchall():
        ctrls.setdefault(int(seq), {})[cd] = val
    return {"hdr": tuple(h), "items": items, "ctrls": ctrls}


def dept_name(cur, dept_cd):
    try:
        cur.execute("SELECT TOP 1 RTRIM(ISNULL(DEPT_NM,'')) FROM dbo.B_DEPT WITH (NOLOCK) "
                    "WHERE RTRIM(DEPT_CD)=?", dept_cd)
        r = cur.fetchone()
        return (r[0] if r else "") or ""
    except Exception:
        return ""


def build(cur, today):
    """원본을 읽어 초안 형태로 옮긴다. 못 옮기는 건은 사유와 함께 남긴다."""
    made, skipped = [], []
    for cid, tg, title, checks in CASES:
        o = read_origin(cur, tg)
        dt, dept, cost, desc, proj, amt, conf = o["hdr"]
        # 포털은 음수 금액을 저장할 수 없다(gl_draft_item CHECK item_amt > 0).
        # 수정계산서·취소 전표가 이 형태다 — 옮길 수 없으면 사유를 남긴다(19번 문서 §4.1).
        neg = [i[0] for i in o["items"] if int(i[4]) <= 0]
        if neg:
            skipped.append((cid, tg, title, f"음수·0원 라인 {len(neg)}줄({', '.join(map(str, neg))}) — "
                                            "포털이 저장할 수 없는 형태"))
            continue
        lines, ctrls = [], []
        for seq, fg, acct, nm, a, lcc, ld, sub in o["items"]:
            lines.append({"seq": int(seq), "fg": "D" if fg.startswith("D") else "C",
                          "acct": acct, "nm": nm, "amt": int(a),
                          "cost": lcc or cost, "desc": ld or desc, "sub": sub})
            for cd, val in (o["ctrls"].get(int(seq)) or {}).items():
                # 날짜형 관리항목만 오늘로 옮긴다 — 닫힌 회계기간으로는 넣을 수 없다
                ctrls.append({"seq": int(seq), "cd": cd,
                              "val": today if DATE_RE.match(val) else val})
        made.append({"id": cid, "origin": tg, "title": title, "checks": checks,
                     "origin_dt": dt, "dept": dept, "dept_nm": dept_name(cur, dept),
                     "cost": cost, "proj": proj, "desc": desc,
                     "lines": lines, "ctrls": ctrls})
    return made, skipped


def draft_no(cid):
    return f"DRAFT-LDG-{cid}-0001"


def print_plan(made, skipped):
    print(f"\n{'═'*80}\n 원장 검증 전표 — {BATCH}\n"
          f" 실제 승인 전표를 그대로 복제한다(금액·계정·차대·거래처 동일, 날짜만 오늘로)\n{'═'*80}")
    for c in made:
        dr = sum(l["amt"] for l in c["lines"] if l["fg"] == "D")
        subs = sorted({l["sub"] for l in c["lines"] if l["sub"]}) or ["(무관)"]
        print(f"\n  [{c['id']}] {c['title']}   {draft_no(c['id'])}")
        print(f"      원본 : {c['origin']} ({c['origin_dt']}) · {c['desc'][:44]}")
        print(f"      확인 : {c['checks']}")
        print(f"      원장 : {'+'.join(subs)} · {dr:,}원 · {len(c['lines'])}줄 · 부서 {c['dept_nm'] or c['dept']}")
        for l in c["lines"]:
            cs = [x for x in c["ctrls"] if x["seq"] == l["seq"]]
            cst = " ".join(f"{x['cd']}={mask(x['val'])}" for x in cs)
            print(f"        {'차' if l['fg']=='D' else '대'}) {l['acct']} {l['nm'][:16]:<18}"
                  f"{l['amt']:>12,}  {l['sub'] or '-':<3} {cst}")
    if skipped:
        print(f"\n{'─'*80}\n  옮기지 못한 케이스 {len(skipped)}건")
        for cid, tg, title, why in skipped:
            print(f"    [{cid}] {title} ({tg})\n         → {why}")
    print(f"\n{'─'*80}\n 총 {len(made)}건 · 상태는 '제출됨' 까지 — 전송은 화면에서 사람이 누른다\n{'─'*80}\n")


def load(made, url, key, today):
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    heads, items, ctrls = [], [], []
    for c in made:
        no = draft_no(c["id"])
        dr = sum(l["amt"] for l in c["lines"] if l["fg"] == "D")
        cr = sum(l["amt"] for l in c["lines"] if l["fg"] == "C")
        heads.append({
            "draft_no": no, "draft_dt": today, "gl_type": "03",
            "dept_cd": c["dept"], "dept_nm": c["dept_nm"] or None, "cost_cd": c["cost"],
            "gl_desc": f"ax검증_{c['id']} {c['desc'][:80]} (원본 {c['origin']})",
            "project_no": c["proj"] or None, "ref_no": BATCH,
            "owner_upn": OWNER_UPN, "owner_erp_usr_id": OWNER_UPN, "owner_nm": OWNER_NM,
            "dr_total": dr, "cr_total": cr, "status": "submitted", "submitted_at": now_iso})
        for i, l in enumerate(c["lines"], start=1):
            items.append({"draft_no": no, "item_seq": i, "dr_cr_fg": l["fg"],
                          "acct_cd": l["acct"], "acct_nm": l["nm"], "item_amt": l["amt"],
                          "item_desc": f"ax검증_{c['id']} {l['desc'][:80]}", "cost_cd": l["cost"]})
        seqmap = {l["seq"]: i for i, l in enumerate(c["lines"], start=1)}
        for x in c["ctrls"]:
            ctrls.append({"draft_no": no, "item_seq": seqmap[x["seq"]],
                          "ctrl_cd": x["cd"], "ctrl_val": x["val"]})

    nos = [h["draft_no"] for h in heads]
    existing = rest(url, key, "GET", "gl_draft",
                    params="?select=draft_no,erp_apply_status&draft_no=in.(" + ",".join(nos) + ")")
    locked = [e["draft_no"] for e in existing if e.get("erp_apply_status") == "applied"]
    if locked:
        raise SystemExit(f"[중단] 이미 ERP 에 적용된 초안이 있습니다: {', '.join(locked)} — 덮어쓰지 않습니다.")
    if existing:
        rest(url, key, "DELETE", "gl_draft",
             params="?draft_no=in.(" + ",".join(e["draft_no"] for e in existing) + ")")
        print(f"[정리] 기존 동일 번호 {len(existing)}건 삭제")
    rest(url, key, "POST", "gl_draft", heads)
    rest(url, key, "POST", "gl_draft_item", items)
    if ctrls:
        rest(url, key, "POST", "gl_draft_item_ctrl", ctrls)
    print(f"[적재 완료] 초안 {len(heads)}건 · 라인 {len(items)}줄 · 관리항목 {len(ctrls)}건")
    print("           상태: 제출됨 — 화면 [ERP 전송] 탭에서 보내고, 승인 뒤 verify_ledger.py 로 대조하세요.")


def purge(url, key):
    rows = rest(url, key, "GET", "gl_draft",
                params="?select=draft_no,erp_apply_status&ref_no=eq." + BATCH)
    kill = [r["draft_no"] for r in rows if r.get("erp_apply_status") != "applied"]
    keep = len(rows) - len(kill)
    if kill:
        rest(url, key, "DELETE", "gl_draft", params="?draft_no=in.(" + ",".join(kill) + ")")
    print(f"[삭제] {len(kill)}건" + (f" · [보존] 적용된 {keep}건" if keep else ""))


def main():
    ap = argparse.ArgumentParser(description="실제 장부 전표 복제 — 원장 검증용 초안 적재")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--plan", action="store_true")
    g.add_argument("--load", action="store_true")
    g.add_argument("--purge", action="store_true")
    a = ap.parse_args()
    load_env()
    url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    if a.purge:
        return purge(url, key)
    today = datetime.date.today().isoformat()
    conn = R.demo_conn()
    try:
        made, skipped = build(conn.cursor(), today)
    finally:
        conn.close()
    print_plan(made, skipped)
    if a.load:
        load(made, url, key, today)
    return 0


if __name__ == "__main__":
    sys.exit(main())
