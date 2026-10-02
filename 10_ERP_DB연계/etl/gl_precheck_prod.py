# -*- coding: utf-8 -*-
r"""gl_precheck_prod.py — 포털 결의전표를 **운영(JEILMNS) 마스터 기준**으로 판정만 한다 (읽기 전용)

왜 필요한가(2026-09-30):
  릴레이(gl_apply_demo2)는 투입 대상인 DEMO2(2025-06-25 스냅샷)의 마스터로 가드를 돈다.
  그 뒤 신설된 거래처(예: 4624·4659)는 DEMO2 에 없어 G7 로 막힌다 — 운영 ERP 에는 있는데도.
  「운영이었으면 통과했나」를 알려면 같은 판정을 운영 마스터로 한 번 더 돌려야 한다.
  이것이 곧 운영전환 게이트 G7(운영 마스터 기준 재판정, 17_운영전환_게이트)이다.

무엇을 하지 않나 — 이 스크립트의 존재 조건:
  · 운영에 **쓰지 않는다**(CLAUDE.md §1.2 · 결정 C-1). 커서 단에서 SELECT 외 문장을 거부한다.
    채번(EXEC)·INSERT·임시테이블까지 전부 막히므로 실수로도 쓰기가 나갈 수 없다.
  · 포털 상태를 **바꾸지 않는다** — gl_apply_record 를 부르지 않는다. 초안의 전송 상태·
    「사전점검 결과」는 DEMO2 기준 그대로 남는다(운영 판정이 화면 상태를 덮으면 혼란스럽다).
    결과는 콘솔과, 원하면 --json 파일로만 남긴다.

판정 항목 — 릴레이가 쓰기 직전까지 보는 것과 **같은 함수**를 그대로 쓴다(규칙 이중화 금지):
  ① 거래유형(AX001) 등록·결의전표 귀결   ② 부서 ↔ 현행 조직
  ③ 운영에 같은 참조번호가 이미 있나     ④ 법인카드 대변 계정 금지
  ⑤ 거래항목(분개코드) 결정              ⑥ 입력가드 G1·G2·G5·G6·G7(거래처 등 참조값 실존)
  릴레이와 달리 첫 문제에서 멈추지 않고 **전부 모아서** 보여준다.

사용(이 폴더 기준, 관리자 PC — %USERPROFILE%\.erp 읽기전용 계정):
  python gl_precheck_prod.py --draft AX260930-U001-001
  python gl_precheck_prod.py --all                     제출됨·미적용 초안 전건
  python gl_precheck_prod.py --draft ... --json out.json
  python gl_precheck_prod.py --accounts                포털이 쓰는 (계정, 차대) 전수 — 운영·DEMO2 비교(G7 닫힘 조건)
  jeil_runner.exe prodcheck --draft ...                (러너 서브커맨드)
"""
import argparse
import json
import re
import sys

from _env import load_env, need
import gl_apply_demo2 as relay

PROD_DB = "JEILMNS"                    # 판정 기준 DB — 읽기만 한다
DEMO2_DB = "JEILMNS_DEMO2"             # 비교 대상(2025-06-25 스냅샷) — 읽기만 한다

# SELECT 한 문장만 허용. 주석·세미콜론으로 뒤에 다른 문장을 붙이는 것도 막는다.
_WRITE_WORDS = re.compile(
    r"(?i)\b(insert|update|delete|merge|exec|execute|drop|alter|create|truncate|grant|revoke|"
    r"into|declare|set|dbcc|backup|restore|bulk|openrowset|opendatasource|sp_\w+|xp_\w+)\b")


class ReadOnlyCursor:
    """pyodbc 커서 감싸기 — SELECT 가 아니면 실행 전에 거부한다(방어선 1).
       방어선 2 는 트랜잭션을 한 번도 커밋하지 않고 끝에 반드시 롤백하는 것."""

    def __init__(self, cur):
        self._cur = cur

    def execute(self, sql, *params):
        s = str(sql).strip()
        if not s.upper().startswith("SELECT") or ";" in s.rstrip(";") or "--" in s \
                or "/*" in s or _WRITE_WORDS.search(s):
            raise PermissionError("운영 판정은 읽기 전용입니다 — SELECT 외 문장을 거부했습니다: "
                                  + s[:80].replace("\n", " "))
        self._cur.execute(s, *params)
        return self

    def __getattr__(self, name):          # fetchone·fetchall·description·nextset
        return getattr(self._cur, name)


def prod_conn():
    """운영(JEILMNS) 읽기 접속."""
    return _ro_conn(PROD_DB, "운영 기준")


def demo2_conn():
    """DEMO2 읽기 접속 — 비교용. 릴레이의 demo_conn 은 2026-09-30(D-113)부터 운영에 붙으므로 쓰지 않는다."""
    return _ro_conn(DEMO2_DB, "DEMO2 비교")


def _ro_conn(db, label):
    """읽기 판정용 접속 — DB명을 고정하고 접속 직후 재확인한다. 커밋하지 않는다(끝에 롤백)."""
    import pyodbc
    from _erp_conn import erp_conn_str
    cs = erp_conn_str()
    if re.search(r"(?i)(DATABASE|Initial Catalog)\s*=", cs):
        cs = re.sub(r"(?i)(DATABASE|Initial Catalog)\s*=\s*[^;]*", rf"\1={db}", cs)
    else:
        cs = cs.rstrip(";") + f";DATABASE={db}"
    conn = pyodbc.connect(cs, timeout=30)
    conn.autocommit = False               # 커밋하지 않는다 — 끝에 롤백
    cur = conn.cursor()
    cur.execute("SELECT DB_NAME()")
    name = cur.fetchone()[0]
    if name != db:
        conn.close()
        raise SystemExit(f"[중단] 접속된 DB가 {db} 가 아닙니다(실제: {name}). 아무것도 조회하지 않았습니다.")
    print(f"[{label} · 읽기 전용] DB={name}")
    return conn


def _reset_caches():
    """릴레이 모듈의 마스터 캐시를 비운다 — DEMO2 에서 읽은 값이 섞이면 판정이 오염된다."""
    relay._ACCT_ATTR.clear(); relay._REQ_CTRL.clear()
    relay._CTRL_REF.clear(); relay._REF_HIT.clear()
    relay._TG_ALLOW = None


def _draft_dt(h):
    """초안의 전표일자 — 없거나 못 읽으면 None(오늘 기준으로 본다)."""
    import datetime
    try:
        return datetime.datetime.strptime(str(h.get("draft_dt"))[:10], "%Y-%m-%d")
    except Exception:
        return None


def judge(cur, d, trans_type):
    """초안 1건 판정 — 문제 목록을 전부 모아 돌려준다(빈 목록 = 운영이면 통과)."""
    h, items, ctrls = d["header"], d["items"], d["ctrls"]
    issues = []

    def add(code, what, fix="", seq=0, acct="", fg=""):
        issues.append({"code": code, "seq": seq, "acct": acct, "fg": fg, "what": what, "fix": fix})

    # ① 거래유형
    cur.execute("SELECT GL_POSTING_FG FROM dbo.A_ACCT_TRANS_TYPE WITH (NOLOCK) WHERE TRANS_TYPE = ?",
                trans_type)
    row = cur.fetchone()
    if not row:
        add("TT", f"거래유형 {trans_type} 가 운영 ERP 에 등록돼 있지 않습니다",
            "운영 전환 전 ERP 관리자가 등록해야 합니다(DEMO2 에만 등록됨)")
    elif str(row[0]).strip() != "T":
        add("TT", f"거래유형 {trans_type} 가 결의전표로 연결돼 있지 않습니다(GL_POSTING_FG={row[0]})")

    # ② 부서 ↔ 전표일자 기준 조직(ERP 와 같은 규칙) · 내부부서코드 · 헤더 코스트센터
    hdr_cost = ""
    dept_cd = (h.get("dept_cd") or "").strip()
    if not dept_cd:
        add("DEPT", "부서가 비어 있습니다")
    else:
        try:
            org = relay.check_dept_org(cur, dept_cd, _draft_dt(h))
            relay.dept_internal_cd(cur, dept_cd, org)          # 내부부서코드·헤더 코스트센터가
            hdr_cost = relay.dept_cost_cd(cur, dept_cd, org)   # 부서 마스터에 있어야 보낼 수 있다
        except SystemExit as e:
            add("DEPT", str(e).split("\n→ ")[0], (str(e).split("\n→ ") + [""])[1])

    # ③ 운영 중복(같은 참조번호)
    ref_no = h["draft_no"]
    for tbl in ("A_BATCH", "A_TEMP_GL"):
        cur.execute(f"SELECT COUNT(*) FROM dbo.{tbl} WITH (NOLOCK) WHERE REF_NO = ?", ref_no)
        if cur.fetchone()[0]:
            add("DUP", f"운영 ERP 에 같은 참조번호({ref_no})가 이미 있습니다({tbl})")

    # ④⑤ 라인 — 법인카드 대변 금지 · 분개코드 결정
    cost_cd = (h.get("cost_cd") or "").strip() or hdr_cost   # 줄이 비면 부서 기본값(릴레이와 같다)
    by_seq = {}
    for c in ctrls:
        by_seq.setdefault(int(c["item_seq"]), []).append(
            (str(c["ctrl_cd"]).strip(), str(c["ctrl_val"]).strip()))
    lines = []
    for it in items:
        acct = str(it["acct_cd"]).strip()
        fg = "DR" if str(it["dr_cr_fg"]).strip().upper().startswith("D") else "CR"
        seq = int(it["item_seq"])
        line_cost = (it.get("cost_cd") or cost_cd or "").strip()
        if not line_cost:
            add("CC", "코스트센터가 비어 있습니다", seq=seq, acct=acct, fg=fg)
        if fg == "CR" and acct in relay.FORBIDDEN_CR_ACCT:
            add("CARD", "법인카드 대변 계정은 AX 채널에서 쓸 수 없습니다", seq=seq, acct=acct, fg=fg)
        jnl = relay.resolve_jnl(cur, trans_type, acct, fg, line_cost)
        if not jnl:
            add("JNL", "거래항목(분개코드)을 정할 수 없습니다 — 운영에 계정 또는 분개코드가 없습니다",
                seq=seq, acct=acct, fg=fg)
        lines.append({"seq": seq, "acct": acct, "fg": fg, "amt": int(it["item_amt"]),
                      "cost": line_cost, "ctrls": by_seq.get(seq, [])})

    # ⑥ 입력가드(G1·G2·G5·G6·G7) — 릴레이와 같은 함수
    for b in relay.guard_lines(cur, lines):
        add(b["code"], b["what"], b.get("fix", ""), b["seq"], b["acct"], b["fg"])

    for x in issues:                       # 계정은 이름으로 부른다
        if x["acct"]:
            x["nm"] = relay.acct_label(cur, x["acct"])
    return issues


# ═══════════ 계정 기준 판정(--accounts) — 게이트 G7 닫힘 조건 ═══════════
# 전표 단위 판정은 「지금 대기 중인 전표」만 본다. G7 이 요구하는 것은 **포털이 쓰는 계정 전수**를
# 운영 마스터로 다시 판정하는 것이다(17_운영전환_게이트 G7). 포털 전표(전송 완료분 포함)·템플릿에
# 나온 (계정, 차대) 쌍을 모아, 같은 판정 함수를 운영과 DEMO2 에 각각 돌려 나란히 비교한다.

def rest_get(url, key, path):
    """포털 테이블 읽기(GET 전용) — service role 로 RLS 를 우회해 전체 행을 본다. 쓰기 경로 없음."""
    import urllib.request
    req = urllib.request.Request(f"{url}/rest/v1/{path}", method="GET",
                                 headers={"apikey": key, "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode() or "[]")


def collect_pairs(url, key):
    """포털이 쓰는 (계정, DR|CR) 쌍 → {쓰인 횟수, 출처, 대표 코스트센터}."""
    pairs = {}

    def put(acct, fg, cost, src):
        acct = str(acct or "").strip()
        fg = "DR" if str(fg or "").strip().upper().startswith("D") else "CR"
        if not acct:
            return
        p = pairs.setdefault((acct, fg), {"n": 0, "src": set(), "costs": {}})
        p["n"] += 1
        p["src"].add(src)
        if cost:
            p["costs"][cost] = p["costs"].get(cost, 0) + 1

    for r in rest_get(url, key, "gl_draft_item?select=acct_cd,dr_cr_fg,cost_cd&limit=100000"):
        put(r.get("acct_cd"), r.get("dr_cr_fg"), (r.get("cost_cd") or "").strip(), "전표")
    for r in rest_get(url, key, "gl_template_item?select=acct_cd,dr_cr_fg&limit=100000"):
        put(r.get("acct_cd"), r.get("dr_cr_fg"), "", "템플릿")
    for p in pairs.values():
        p["cost"] = max(p["costs"], key=p["costs"].get) if p["costs"] else ""
    return pairs


def judge_account(cur, acct, fg, cost, trans_type):
    """(계정, 차대) 한 쌍 판정 — 릴레이 함수 그대로. 반환: 판정 dict."""
    cur.execute("SELECT RTRIM(ISNULL(ACCT_NM,'')), RTRIM(ISNULL(SUBSYS_TYPE,'')) "
                "FROM dbo.A_ACCT WITH (NOLOCK) WHERE RTRIM(ACCT_CD) = ?", acct)
    r = cur.fetchone()
    if not r:
        return {"exists": False, "nm": "", "sub": "", "jnl": "", "req": [], "blocks": ["계정 없음"]}
    out = {"exists": True, "nm": r[0], "sub": r[1], "jnl": "", "req": [], "blocks": []}
    # 법인카드 대변 — ERP 마스터가 아니라 AX 채널 규칙으로 막는다(릴레이 apply_draft 와 같은 상수)
    if fg == "CR" and acct in relay.FORBIDDEN_CR_ACCT:
        out["blocks"].append("CARD 법인카드 대변 — AX 채널에서 쓰지 않는 계정입니다(카드 채널 전용)")
    jnl = relay.resolve_jnl(cur, trans_type, acct, fg, cost)
    if jnl:
        out["jnl"] = f"{jnl[0]}/{jnl[1] or '-'}"
    else:
        out["blocks"].append("분개코드 결정 불가")
    # 반제방향(G1·G5)과 필수 관리항목(G6)은 guard_lines 에 한 줄짜리로 물어본다.
    # 관리항목을 비워 보내므로 G6 이 곧 「이 방향의 필수 항목 목록」이 되고, G7(참조값)은 돌지 않는다.
    # G2(차대 불균형)는 한 줄이라 당연히 뜨므로 버린다.
    for b in relay.guard_lines(cur, [{"seq": 1, "acct": acct, "fg": fg, "amt": 0,
                                      "cost": cost, "ctrls": []}]):
        if b["code"] in ("G1", "G5"):
            out["blocks"].append(f"{b['code']} {b['what']}")
    out["req"] = [cd for cd, _nm in relay._REQ_CTRL.get((acct, fg), [])]
    return out


def run_accounts(args, url, key):
    pairs = collect_pairs(url, key)
    if not pairs:
        print("포털 전표·템플릿에 계정이 없습니다.")
        return 0
    keys = sorted(pairs, key=lambda k: (k[0], k[1]))
    print(f"계정 기준 판정 — 포털이 쓰는 (계정, 차대) {len(keys)}쌍. ERP·포털 어디에도 쓰지 않습니다.\n")

    results = {}
    targets = [("prod", prod_conn)] + ([] if args.no_demo else [("demo", demo2_conn)])
    for tag, opener in targets:
        _reset_caches()                    # DB 가 바뀌면 마스터 캐시를 반드시 비운다
        conn = opener()
        cur = ReadOnlyCursor(conn.cursor())
        try:
            results[tag] = {k: judge_account(cur, k[0], k[1], pairs[k]["cost"], args.trans_type) for k in keys}
        finally:
            try:
                conn.rollback()
            finally:
                conn.close()
    _reset_caches()

    prod, demo = results["prod"], results.get("demo")

    def cell(j):
        if not j["exists"]:
            return "✖ 계정 없음"
        return ("✖ " + " · ".join(j["blocks"])) if j["blocks"] else f"✅ {j['jnl']}"

    rows, n_ok, n_diff = [], 0, 0
    for k in keys:
        p, d = prod[k], (demo or {}).get(k)
        ok = p["exists"] and not p["blocks"]
        n_ok += ok
        diff = bool(d) and (cell(p) != cell(d) or p["req"] != d["req"])
        n_diff += diff
        rows.append({"acct": k[0], "fg": k[1], "nm": p["nm"] or (d or {}).get("nm", ""),
                     "sub": p["sub"], "used": pairs[k]["n"], "src": "·".join(sorted(pairs[k]["src"])),
                     "prod": cell(p), "prod_req": p["req"],
                     "demo": cell(d) if d else None, "demo_req": d["req"] if d else None,
                     "diff": diff, "pass": ok})

    for r in rows:
        mark = "  " if not r["diff"] else "≠ "
        print(f"{mark}{r['acct']} {('차변' if r['fg'] == 'DR' else '대변')} {r['nm'][:14]:<14} "
              f"({r['sub'] or '일반'}, {r['used']}회·{r['src']})")
        print(f"     운영 : {r['prod']}  필수[{','.join(r['prod_req']) or '-'}]")
        if r["demo"] is not None:
            print(f"     DEMO2: {r['demo']}  필수[{','.join(r['demo_req']) or '-'}]")
    print(f"\n[계정 기준 판정 완료] {len(rows)}쌍 — 운영 통과 {n_ok} / 차단 {len(rows) - n_ok}"
          + (f" · DEMO2 와 결과가 다른 쌍 {n_diff}" if demo else ""))
    print("  ※ 거래유형 등록 여부·거래처 등 값 실존은 전표 단위 판정(--draft/--all)에서 본다.")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump({"mode": "accounts", "target": PROD_DB, "trans_type": args.trans_type, "rows": rows},
                      f, ensure_ascii=False, indent=2)
        print(f"  결과 파일: {args.json}")
    return 0


def main():
    ap = argparse.ArgumentParser(description="결의전표 운영(JEILMNS) 기준 판정 — 읽기 전용, ERP·포털 무변경")
    ap.add_argument("--draft", help="초안/참조번호 한 건")
    ap.add_argument("--all", action="store_true", help="제출됨·미적용 초안 전건")
    ap.add_argument("--accounts", action="store_true",
                    help="계정 기준 판정 — 포털 전표·템플릿의 (계정, 차대) 전수를 운영·DEMO2 로 비교(게이트 G7)")
    ap.add_argument("--no-demo", action="store_true", help="--accounts 에서 DEMO2 비교 생략")
    ap.add_argument("--json", help="결과를 JSON 파일로도 저장")
    ap.add_argument("--trans-type", default=relay.TRANS_TYPE_DEFAULT,
                    help=f"거래유형(기본 {relay.TRANS_TYPE_DEFAULT})")
    args = ap.parse_args()
    if not (args.draft or args.all or args.accounts):
        ap.error("--draft, --all, --accounts 중 하나를 주세요")

    load_env()
    url = need("SUPABASE_URL").rstrip("/")
    key = need("SUPABASE_SERVICE_ROLE_KEY")
    if args.accounts:
        return run_accounts(args, url, key)
    if args.draft:
        nos = [args.draft]
    else:
        rows = relay.rpc(url, key, "gl_apply_ready", {"p_target": relay.TARGET_DB}) or []
        nos = [r["draft_no"] for r in rows if r.get("erp_apply_status") != "applied"]
    if not nos:
        print("판정 대상이 없습니다(제출됨·미적용 초안 없음).")
        return 0

    _reset_caches()
    conn = prod_conn()
    cur = ReadOnlyCursor(conn.cursor())
    report = []
    try:
        print(f"운영 기준 판정 {len(nos)}건 — ERP·포털 어디에도 쓰지 않습니다.\n")
        for no in nos:
            d = relay.rpc(url, key, "gl_apply_fetch", {"p_draft_no": no})
            if not d or not d.get("header"):
                print(f"[건너뜀] {no}: 포털에서 초안을 찾지 못했습니다.\n")
                report.append({"draft_no": no, "error": "not_found"})
                continue
            h = d["header"]
            print(f"──── {no} · {int(h.get('dr_total') or 0):,}원 · {(h.get('gl_desc') or '')[:40]} "
                  f"(포털 상태 {h.get('status')}/{h.get('erp_apply_status') or '-'}) ────")
            issues = judge(cur, d, args.trans_type)
            if issues:
                for x in issues:
                    where = (f"{x['seq']}번 줄 {x.get('nm') or x['acct']} "
                             f"{'차변' if x['fg'] == 'DR' else '대변'} — ") if x["seq"] else ""
                    print(f"  [{x['code']}] {where}{x['what']}" + (f"\n       → {x['fix']}" if x["fix"] else ""))
                print(f"  ✖ 운영 기준으로도 {len(issues)}군데가 걸립니다.\n")
            else:
                print("  ✅ 운영 마스터 기준으로는 통과합니다(투입 직전 판정까지).\n")
            report.append({"draft_no": no, "pass": not issues, "issues": issues})
    finally:
        try:
            conn.rollback()                # 커밋은 어디서도 하지 않는다
        finally:
            conn.close()

    ok = sum(1 for r in report if r.get("pass"))
    print(f"[운영 기준 판정 완료] 통과 {ok} / 걸림 {len(report) - ok}")
    print("  ※ 채번·서브원장(채무·부가세) 생성 단계는 쓰기라 판정하지 않았습니다 — 실제 투입 때만 확인됩니다.")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump({"target": PROD_DB, "trans_type": args.trans_type, "results": report},
                      f, ensure_ascii=False, indent=2)
        print(f"  결과 파일: {args.json}")
    return 0


if __name__ == "__main__":
    for s in (sys.stdout, sys.stderr):
        if hasattr(s, "reconfigure"):
            s.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
