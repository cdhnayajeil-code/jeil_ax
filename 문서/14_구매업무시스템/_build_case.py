# -*- coding: utf-8 -*-
"""
구매 건 추적 예시(비공개) 빌더 — 사례 폴더의 case.json 을 읽어 「구매건_추적.html」을 그 폴더 안에 만든다.

    python 문서/14_구매업무시스템/_build_case.py "<사례 폴더>"            # 생성 + 점검 보고
    python 문서/14_구매업무시스템/_build_case.py "<사례 폴더>" --check    # 점검 보고만(파일을 쓰지 않는다)

원칙
  · 도식(스타일·흐름도·번호 사슬)은 정본 01_구매업무_프로세스_도식.html 의 표식 블록을 그대로 떠 온다 — 여기서 다시 그리지 않는다.
  · 이 스크립트는 공개 저장소에 있다. 실거래 값·사례 폴더 경로·거래처명을 소스에 적지 않는다 — 사례 폴더는 인자로만 받는다.
  · 결과물에는 실거래 자료가 들어간다. 출력 위치가 저장소 안인데 git 제외 대상이 아니면 쓰기를 거부한다.
  · DB 에 접속하지 않는다. 입력은 case.json(스키마 pur-case/1) 하나다. 조회문 틀은 case_queries.sql.
  · 상태·소요일·단가 비교·검산은 여기서 계산한다(case.json 에 적지 않는다) — 이 규칙이 「상태는 실적 문서의 존재로 판정」의 시험이다.
"""
import datetime as _dt
import html
import io
import json
import os
import re
import subprocess
import sys
import urllib.parse
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
MASTER = os.path.join(HERE, "01_구매업무_프로세스_도식.html")
OUT_NAME = "구매건_추적.html"
DATA_NAME = "case.json"
SITE = "https://ai.jeilm.co.kr"

e = html.escape
ST_LABEL = {"done": "완료", "cur": "지금 여기", "part": "일부", "todo": "아직", "norec": "기록 없음"}
DOC_LABEL = {"have": "있음", "zip": "ZIP 안", "dms": "문서중앙화", "missing": "없음", "not_yet": "아직"}
SEV_LABEL = {"bad": "결함", "warn": "주의", "info": "관찰"}
CHAIN_CODES = ["PR", "PU", "기안", "PO", "PG", "IV", "TG", "VT", "승인번호", "권-번호"]   # 정본 도식의 번호 사슬과 같아야 한다


def won(n):
    return "-" if n is None else format(int(round(n)), ",")


def md(s):
    """'2026-09-28 11:34' → '09-28'"""
    return (s or "")[5:10] if s else "-"


def to_date(s):
    return _dt.date.fromisoformat(s[:10]) if s else None


def fail(msg):
    print("[중단] " + msg)
    sys.exit(1)


# ── 정본 도식에서 블록 떠 오기 ─────────────────────────────────────────
def load_master():
    if not os.path.exists(MASTER):
        fail("정본 도식 파일이 없다: " + os.path.basename(MASTER))
    s = io.open(MASTER, encoding="utf-8").read()

    def cut(a, b, name):
        m = re.search(re.escape(a) + r"(.*?)" + re.escape(b), s, re.S)
        if not m:
            fail("정본 도식에 표식 블록이 없다: " + name)
        return m.group(1).strip("\n")

    style = cut("/* pur:style */", "/* /pur:style */", "pur:style")
    flow = cut("<!-- pur:flow -->", "<!-- /pur:flow -->", "pur:flow")
    chain = cut("<!-- pur:chain -->", "<!-- /pur:chain -->", "pur:chain")
    codes = re.findall(r'<div class="no[^"]*"><b>([^<]+)</b>', chain)
    if codes != CHAIN_CODES:
        fail("번호 사슬이 정본 도식과 다르다 — chain_html 을 정본에 맞춘다 · 정본 %s · 빌더 %s" % (codes, CHAIN_CODES))
    stages = [(int(n), nm) for n, nm in re.findall(r'data-step="(\d+)" data-name="([^"]+)"', flow)]
    if [n for n, _ in stages] != list(range(1, len(stages) + 1)) or not stages:
        fail("정본 흐름도의 단계 번호가 1부터 이어지지 않는다")
    return style, flow, [nm for _, nm in stages]


# ── 폴더·ZIP 에서 문서 찾기 ────────────────────────────────────────────
def scan_folder(case_dir):
    files, zips = [], []
    for dp, _dns, fns in os.walk(case_dir):
        for fn in fns:
            rel = os.path.relpath(os.path.join(dp, fn), case_dir).replace(os.sep, "/")
            if rel in (OUT_NAME, DATA_NAME):
                continue
            files.append(rel)
            if fn.lower().endswith(".zip"):
                try:
                    with zipfile.ZipFile(os.path.join(dp, fn)) as zf:
                        for i in zf.infolist():
                            try:
                                nm = i.filename.encode("cp437").decode("cp949")
                            except (UnicodeEncodeError, UnicodeDecodeError):
                                nm = i.filename
                            zips.append((rel, nm))
                except zipfile.BadZipFile:
                    pass
    return sorted(files), zips


def resolve_docs(case, files, zips, states):
    out, used = [], set()
    rounds = {r["id"]: r for r in case["rounds"]}
    for d in case.get("docs", []):
        d = dict(d)
        toks = d.get("find") or []
        r = rounds.get(d["round"], {})
        st = states[d["round"]][d["step"]]
        d["status"], d["file"], d["note"] = None, None, ""
        if d.get("where") == "zip":
            hit = [(z, m) for z, m in zips if all(t in m for t in toks)]
            if hit:
                d["status"], d["file"], d["note"] = "zip", hit[0][0], hit[0][1]
                used.add(hit[0][0])
        elif d.get("where") == "dms":
            sf = (r.get("ledger") or {}).get("scan_file")
            if sf and all(t in sf for t in toks):
                d["status"], d["note"] = "dms", sf
        else:
            hit = [f for f in files if all(t in f for t in toks) and (f.lower().endswith(".zip") == any(t == ".zip" for t in toks))]
            if hit:
                d["status"], d["file"] = "have", hit[0]
                used.add(hit[0])
        if not d["status"]:
            # 그 단계의 실적이 있는데 파일이 없으면 「없음」, 단계가 아직이면 「아직」
            d["status"] = "missing" if st in ("done", "part", "norec") else "not_yet"
        out.append(d)
    return out, [f for f in files if f not in used]


# ── 계산: 단계 상태 · 검산 · 소요일 · 단가 비교 ─────────────────────────
def stage_states(r):
    po = r.get("po") or {}
    lines = po.get("lines") or []
    gw = {g["step"]: g for g in r.get("gw", [])}
    st = {}
    has_pr = bool(r.get("pr_lines"))
    st[1] = "done" if has_pr and (r.get("pu") or {}).get("pr_sts") not in (None, "", "RQ") else ("part" if has_pr else "todo")
    st[2] = "done" if has_pr else "todo"
    st[3] = ("part" if r.get("quote") else "norec") if lines else "todo"
    st[4] = "norec" if lines else "todo"
    st[5] = "done" if lines else "todo"
    po_qty = sum(x["qty"] for x in lines)
    gr_qty = sum(g["qty"] for g in r.get("gr") or [])
    iv, slip = r.get("iv"), r.get("slip")
    iv_qty = sum(x["qty"] for x in (iv or {}).get("lines") or [])
    if lines and gr_qty >= po_qty and r.get("etax"):
        st[6] = "done"
    elif gr_qty > 0:
        st[6] = "part"
    elif lines and iv and iv_qty >= po_qty:
        # 입고 기록 없이 매입만 있는 줄(외주 가공·용역·진척 매입) — P0.5 검증에서 확인(2026-10-07).
        # 「아직」으로 두면 매입이 끝난 건이 6단계에 멈춰 보인다. 기록이 없는 것이지 안 끝난 것이 아니다.
        st[6] = "norec"
    else:
        st[6] = "todo"
    # 전표가 여러 장(분할 매입·진척 매입)이면 전부 승인돼야 끝 — parts 가 있으면 그것으로, 없으면 conf 하나로
    slip_ok = bool(slip) and (all(p.get("conf") == "C" for p in slip["parts"]) if (slip or {}).get("parts") else slip.get("conf") == "C")
    st[7] = "done" if (iv and slip and (slip_ok or (gw.get(7) or {}).get("done_at"))) else ("part" if iv else "todo")
    led = r.get("ledger")
    x = (led or {}).get("xlsx") or {}
    st[8] = "done" if (led and x.get("closed") == "Y" and x.get("slip") and led.get("scan_file")) else ("part" if led else "todo")
    # 지금 서 있는 단계: 기록이 남는 주 흐름(1·2·5·6·7·8)에서 처음 만나는 「아직/일부」
    cur = next((n for n in (1, 2, 5, 6, 7, 8) if st[n] in ("todo", "part")), None)
    if cur == 8 and st[7] != "done":
        cur = 7
    if cur and st[cur] == "todo":
        st[cur] = "cur"
    return st, cur, {"po_qty": po_qty, "gr_qty": gr_qty}


def checks(r):
    """합계 검산 — (이름, 통과 여부, 설명)"""
    out = []
    po = r.get("po") or {}
    if po.get("lines"):
        s = sum(x["amt"] for x in po["lines"])
        out.append(("발주 줄 합계 = 발주 금액", s == po.get("amt"), "%s / %s" % (won(s), won(po.get("amt")))))
        bad = [x["po_seq"] for x in po["lines"] if x["qty"] * x["price"] != x["amt"]]
        out.append(("발주 줄마다 수량×단가 = 금액", not bad, "어긋난 줄 %s" % bad if bad else "%d줄" % len(po["lines"])))
    iv = r.get("iv")
    if iv:
        s, v = sum(x["amt"] for x in iv["lines"]), sum(x["vat"] for x in iv["lines"])
        out.append(("매입 줄 합계 = 공급가 · 부가세", s == iv["supply_amt"] and v == iv["vat_amt"], "%s + %s" % (won(s), won(v))))
        # 매입이 여러 장으로 나뉘어도(분할·진척 매입) 발주 순번마다 **수량 합**이 발주 수량과 같으면 맞다 — 단가는 줄마다 본다
        pol = {x["po_seq"]: x for x in po.get("lines", [])}
        qsum, pbad = {}, set()
        for x in iv["lines"]:
            qsum[x["po_seq"]] = qsum.get(x["po_seq"], 0) + x["qty"]
            if (pol.get(x["po_seq"]) or {}).get("price") != x["price"]:
                pbad.add(x["po_seq"])
        qbad = [k for k, q in qsum.items() if (pol.get(k) or {}).get("qty") != q]
        diff = sorted(set(qbad) | pbad)
        out.append(("매입 줄 합 = 발주 줄(수량 합 · 단가)", not diff, "어긋난 순번 %s" % diff if diff else "%d줄 · 발주 순번 %d개 일치" % (len(iv["lines"]), len(qsum))))
    slip = r.get("slip")
    if slip:
        dr = sum(x["amt"] for x in slip["lines"] if x["drcr"] == "DR")
        cr = sum(x["amt"] for x in slip["lines"] if x["drcr"] == "CR")
        out.append(("전표 차변 = 대변 = 전표 금액", dr == cr == slip["amt"], "%s / %s" % (won(dr), won(cr))))
        if iv:
            parts = iv.get("parts") or []
            if parts and slip.get("parts"):
                # 전표 한 장은 매입 한 장 **전체**(다른 발주 몫 포함)와 맞는다 — 이 발주 몫만 더하면 어긋난다
                sp = {p["ref_no"]: p for p in slip["parts"]}
                bad = [p["iv_no"] for p in parts if not sp.get(p["iv_no"]) or sp[p["iv_no"]]["amt"] != (p.get("total_supply", p["supply_amt"]) + p.get("total_vat", p["vat_amt"]))]
                out.append(("전표 금액 = 매입 전체(공급가 + 부가세) · 장마다", not bad, "어긋남 %s" % bad if bad else "%d장 일치" % len(parts)))
                out.append(("전표 참조번호 = 매입번호 · 장마다", {p["iv_no"] for p in parts} == set(sp), ", ".join(sorted(sp))))
            else:
                out.append(("전표 금액 = 매입 공급가 + 부가세", slip["amt"] == iv["supply_amt"] + iv["vat_amt"], won(slip["amt"])))
                out.append(("전표 참조번호 = 매입번호", slip.get("ref_no") == iv["iv_no"], slip.get("ref_no") or "-"))
    et = r.get("etax")
    if et and iv:
        parts = iv.get("parts") or []
        if parts and et.get("parts"):
            ep = {p["vat_no"]: p for p in et["parts"] if p.get("vat_no")}
            bad = [p["iv_no"] for p in parts if p.get("vat_no") and (not ep.get(p["vat_no"]) or ep[p["vat_no"]]["supply_amt"] != p.get("total_supply", p["supply_amt"]))]
            out.append(("세금계산서 = 매입 전체(공급가) · 장마다", not bad, "어긋남 %s" % bad if bad else "%d장 일치" % len(et["parts"])))
        else:
            out.append(("세금계산서 = 매입(공급가 · 부가세)", et["supply_amt"] == iv["supply_amt"] and et["vat_amt"] == iv["vat_amt"], "%s + %s" % (won(et["supply_amt"]), won(et["vat_amt"]))))
    if r.get("gr") and po.get("lines"):
        g = {}
        for x in r["gr"]:
            g[x["po_seq"]] = g.get(x["po_seq"], 0) + x["qty"]
        short = [x["po_seq"] for x in po["lines"] if g.get(x["po_seq"], 0) < x["qty"]]
        out.append(("입고 수량 ≥ 발주 수량(줄마다)", not short, "모자란 순번 %s" % short if short else "%d줄 전량" % len(po["lines"])))
    led = r.get("ledger")
    if led and po.get("amt") is not None:
        out.append(("대장 금액 = 발주 금액", led.get("amt") == po["amt"], "%s / %s" % (won(led.get("amt")), won(po["amt"]))))
    lr = r.get("list_rows")
    if lr and po.get("amt") is not None:
        out.append(("엑셀 LIST 금액 합 = 발주 금액", lr.get("amt_sum") == po["amt"], won(lr.get("amt_sum"))))
    return out


def events(r):
    """(이름, 날짜, 출처, 계획값 여부) — 날짜순"""
    gw = {g["step"]: g for g in r.get("gw", [])}
    ev = []
    pu, po = r.get("pu") or {}, r.get("po") or {}
    if pu.get("req_dt"):
        ev.append(("구매요청 등록", pu["req_dt"], "ERP", False))
    if (gw.get(1) or {}).get("done_at"):
        ev.append(("요청 결재 완료", gw[1]["done_at"], "결재문서", False))
    if pu.get("need_dt"):
        ev.append(("요청 필요일", pu["need_dt"], "ERP", True))
    if r.get("advance"):
        ev.append(("선진행(먼저 진행)", r["advance"]["dt"], "엑셀 · 기안서", False))
    g5 = gw.get(5) or {}
    if g5.get("drafted_at"):
        ev.append(("구매기안 상신", g5["drafted_at"][:10], "결재문서 · 대장", False))
    if g5.get("done_at") and g5["done_at"][:10] != (g5.get("drafted_at") or "")[:10]:
        ev.append(("구매기안 결재 완료", g5["done_at"], "결재문서", False))
    if po.get("po_dt"):
        ev.append(("ERP 발주", po["po_dt"], "ERP", False))
    if po.get("dlvy_dt"):
        ev.append(("발주 납기", po["dlvy_dt"], "ERP", True))
    if r.get("gr"):
        days = sorted({g["dt"] for g in r["gr"]})
        if len(days) > 1:
            ev.append(("첫 입고(ERP 등록)", days[0], "ERP", False))
        ev.append(("입고(ERP 등록)" if len(days) == 1 else "마지막 입고(ERP 등록)", days[-1], "ERP", False))
    if r.get("iv"):
        parts = r["iv"].get("parts") or []
        if len(parts) > 1:
            for i, p in enumerate(parts, 1):
                ev.append(("매입 %d/%d 등록" % (i, len(parts)), p["iv_dt"], "ERP", False))
        else:
            ev.append(("매입 등록", r["iv"]["iv_dt"], "ERP", False))
    if r.get("etax"):
        ev.append(("세금계산서 작성", r["etax"]["write_dt"], "국세청", False))
    g7 = gw.get(7) or {}
    if g7.get("drafted_at"):
        ev.append(("매입전표 결재 상신", g7["drafted_at"][:10], "결재문서", False))
    if g7.get("done_at"):
        ev.append(("매입전표 결재 완료", g7["done_at"], "결재문서", False))
    order = {n: i for i, (n, _d, _s, _p) in enumerate(ev)}
    return sorted(ev, key=lambda x: (x[1], order[x[0]]))


def price_compare(case):
    rs = case["rounds"]
    if len(rs) < 2 or not (rs[0].get("po") and rs[1].get("po")):
        return None
    a = {x["item_cd"]: x for x in rs[0]["po"]["lines"]}
    rows, s_old, s_new = [], 0, 0
    for x in rs[1]["po"]["lines"]:
        p = a.get(x["item_cd"])
        if not p:
            rows.append((x, None))
            continue
        rows.append((x, p))
        s_old += p["price"] * x["qty"]
        s_new += x["price"] * x["qty"]
    only_old = [v for k, v in a.items() if k not in {x["item_cd"] for x in rs[1]["po"]["lines"]}]
    if s_old == 0:          # 두 차수에 같은 품목이 없으면(거래처가 다른 발주 묶음 등) 비교할 것이 없다
        return None
    return {"rows": rows, "old": s_old, "new": s_new, "only_old": only_old}


# ── 렌더 ──────────────────────────────────────────────────────────────
EXTRA_CSS = """
.trackgrid{display:grid;grid-template-columns:76px repeat(8,minmax(112px,1fr));gap:6px;min-width:1010px;margin-top:10px;padding-top:10px;border-top:2px solid var(--navy);}
.trackgrid .tl{font-size:12.5px;font-weight:700;color:var(--navy);display:flex;flex-direction:column;justify-content:center;padding:0 6px;line-height:1.3;}
.trackgrid .tl small{font-weight:400;color:var(--muted);font-size:10.5px;}
.trk{display:block;text-decoration:none;color:var(--ink);border:1.5px solid var(--line);border-radius:8px;padding:6px 7px;font-size:11.5px;line-height:1.45;background:var(--paper);min-width:0;}
.trk b{display:block;font-size:12px;}
.trk .d{display:block;color:var(--muted);font-size:10.8px;}
.trk.done{background:var(--okbg);border-color:var(--green);} .trk.done b{color:var(--green);}
.trk.cur{background:var(--erp);border-color:var(--accent);box-shadow:0 0 0 3px rgba(47,111,179,.2);} .trk.cur b{color:var(--accent);}
.trk.part{background:var(--warnbg);border-color:var(--amber);} .trk.part b{color:var(--amber);}
.trk.norec{border-style:dashed;border-color:var(--muted);} .trk.norec b{color:var(--muted);}
.trk.todo{opacity:.55;}
@media (max-width:860px){.trackgrid{grid-template-columns:1fr 1fr;min-width:0;}.trackgrid .tl{grid-column:1/-1;margin-top:8px;}.trk::before{content:attr(data-stage);display:block;font-size:10.5px;font-weight:700;color:var(--muted);}}
.two{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
@media (max-width:860px){.two{grid-template-columns:1fr;}}
.rcol{border:1px solid var(--line);border-radius:10px;padding:10px 12px;min-width:0;}
.rcol > h4{font-size:13.5px;margin-bottom:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.rcol .why{font-size:12.8px;color:var(--muted);margin:0 0 8px;}
.stt{display:inline-block;font-size:11.5px;font-weight:700;padding:1px 9px;border-radius:999px;border:1px solid var(--line);white-space:nowrap;}
.stt.done{color:var(--green);border-color:var(--green);background:var(--okbg);}
.stt.cur{color:var(--accent);border-color:var(--accent);background:var(--erp);}
.stt.part{color:var(--amber);border-color:var(--amber);background:var(--warnbg);}
.stt.norec{color:var(--muted);border-style:dashed;border-color:var(--muted);}
.stt.todo{color:var(--muted);}
.doc{font-size:12.8px;margin:3px 0;display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;}
.dk{display:inline-block;font-size:11px;font-weight:700;padding:0 7px;border-radius:999px;border:1px solid;white-space:nowrap;}
.dk.have,.dk.zip{color:var(--green);border-color:var(--green);background:var(--okbg);}
.dk.dms{color:var(--etcline);border-color:var(--etcline);background:var(--etc);}
.dk.missing{color:var(--red);border:1.5px dashed var(--red);background:var(--paper);}
.dk.not_yet{color:var(--muted);border-color:var(--line);background:var(--soft);}
.sub2{font-size:12px;font-weight:700;color:var(--navy2);margin:10px 0 3px;}
.mini{font-size:12.2px;min-width:0;}
.mini th{padding:5px 7px;font-size:11.3px;} .mini td{padding:5px 7px;}
.kv{font-size:12.6px;margin:2px 0;} .kv b{color:var(--navy2);font-weight:600;}
.appr{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0;}
.appr span{font-size:11.5px;border:1px solid var(--gwline);background:var(--gw);border-radius:6px;padding:1px 7px;}
.appr span + span::before{content:"→ ";color:var(--muted);}
.quote{font-size:12.6px;border-left:3px solid var(--gwline);padding:2px 0 2px 9px;margin:6px 0;color:var(--ink);}
.tbad{color:var(--red);font-weight:700;} .tgood{color:var(--green);font-weight:700;}
.find{border:1px solid var(--line);border-left:5px solid var(--muted);border-radius:0 10px 10px 0;padding:10px 14px;margin:10px 0;font-size:13.3px;}
.find.bad{border-left-color:var(--red);background:var(--badbg);} .find.warn{border-left-color:var(--amber);background:var(--warnbg);}
.find h4{font-size:14px;margin-bottom:4px;color:var(--ink);}
.find p{margin:2px 0;} .find .ev{color:var(--muted);font-size:12.6px;}
.chainrow{margin:6px 0 14px;}
.chainrow .no.off{opacity:.4;border-style:dashed;}
.chain .no small{display:block;font-family:Consolas,monospace;font-size:10.5px;color:var(--ink);word-break:break-all;}
.tline{display:grid;grid-template-columns:86px 1fr 86px 86px;gap:2px 10px;font-size:12.8px;align-items:center;}
.tline .h{font-size:11.3px;color:var(--muted);font-weight:700;border-bottom:1px solid var(--line);padding-bottom:2px;}
.tline .pl{color:var(--muted);font-style:italic;}
.tline .n{text-align:right;font-variant-numeric:tabular-nums;}
.private{background:var(--badbg);border:1.5px solid var(--red);border-radius:10px;padding:10px 14px;font-size:13px;margin:0 0 18px;}
"""


def table(head, rows, cls="mini", num=()):
    h = "".join("<th>%s</th>" % e(x) for x in head)
    b = ""
    for r in rows:
        b += "<tr>" + "".join('<td%s>%s</td>' % (' class="num"' if i in num else "", c) for i, c in enumerate(r)) + "</tr>"
    return '<div class="tw"><table class="%s"><tr>%s</tr>%s</table></div>' % (cls, h, b)


def doc_html(d, with_ref=True):
    s = d["status"]
    k = '<span class="dk %s">%s</span>' % (s, e(DOC_LABEL[s]))
    name = e(d["kind"]) + ((" <small>" + e(d["ref"]) + "</small>") if with_ref and d.get("ref") else "")
    if s == "have":
        tail = '<a href="%s" target="_blank">%s</a>' % (e(urllib.parse.quote(d["file"], safe="/")), e(d["file"].split("/")[-1]))
    elif s == "zip":
        tail = 'ZIP 안 「%s」 — <a href="%s" target="_blank">압축 파일</a>' % (e(d["note"]), e(urllib.parse.quote(d["file"], safe="/")))
    elif s == "dms":
        tail = "「%s」 — 이 폴더에는 없다" % e(d["note"])
    elif s == "missing":
        tail = "그룹웨어 · 업체에서 내려받아 보관"
    else:
        tail = "단계가 아직 오지 않았다"
    return '<div class="doc">%s<span>%s</span><span style="color:var(--muted)">· %s</span></div>' % (k, name, tail)


def gw_html(g):
    if not g:
        return ""
    ap = "".join("<span>%s %s <small>%s</small></span>" % (e(a["role"]), e(a["name"]), e(md(a.get("dt")))) for a in g.get("approvals", []))
    s = '<div class="sub2">결재 정보 <small style="font-weight:400;color:var(--muted)">— %s</small></div>' % e(g.get("src", ""))
    s += '<div class="kv"><b>양식</b> %s</div>' % e(g.get("form", ""))
    if g.get("doc_no"):
        s += '<div class="kv"><b>문서번호</b> %s</div>' % e(g["doc_no"])
    s += '<div class="kv"><b>제목</b> %s</div>' % e(g.get("title", ""))
    s += '<div class="kv"><b>상신</b> %s%s</div>' % (e(g.get("drafted_at") or "-"), (" · <b>완료</b> " + e(g["done_at"])) if g.get("done_at") else "")
    s += '<div class="appr">%s</div>' % ap
    if g.get("body_note"):
        s += '<div class="quote">%s</div>' % e(g["body_note"])
    return s


def step_body(n, r, items, st, calc, case):
    """단계 n 의 한 차수 칸 — (근거 문장, 본문 HTML)"""
    po = r.get("po") or {}
    pu = r.get("pu") or {}
    it = lambda c: items.get(c, {})
    why, body = "", ""
    if n == 1:
        why = "요청 %d줄이 ERP 에 있고 진행코드가 「%s」다. 결재가 끝났는지는 ERP 에 없다 — 결재문서로만 안다." % (len(r.get("pr_lines") or []), pu.get("pr_sts", "-"))
        body += '<div class="kv"><b>요청 결재번호</b> %s · <b>요청일</b> %s · <b>필요일</b> %s · <b>요청자</b> %s</div>' % (e(pu.get("pu_no", "-")), e(pu.get("req_dt", "-")), e(pu.get("need_dt", "-")), e(pu.get("req_user", "-")))
        body += '<div class="kv"><b>건명</b> %s</div>' % e(pu.get("title", ""))
        oth = "".join(" · %s %d줄(%s, %s원)" % (e(o["bp_nm"]), o["lines"], e(o["po_no"]), won(o["amt"])) for o in pu.get("other") or [])
        body += '<div class="kv"><b>이 요청 결재 전체</b> %d줄 — 이 거래처 %d줄%s</div>' % (pu.get("lines_total", 0), pu.get("lines_this_bp", 0), oth)
        un = pu.get("unordered") or []
        if un:
            rows = [(e(x["pr_no"]), e(x["item_cd"]), e(it(x["item_cd"]).get("nm", "")), won(x["qty"]), e(x.get("sts", ""))) for x in un]
            body += '<div class="kv"><span class="tbad">발주 없이 남은 요청 줄 %d개</span> — 진행코드가 「확정」인 채 발주가 없다(수량 0 은 취소로 보이나 ERP 에 취소 표시는 없다)</div>' % len(un)
            body += '<details><summary>발주 없는 요청 줄</summary>%s</details>' % table(["구매요청번호", "품번", "품목", "수량", "진행코드"], rows, num=(3,))
        rows = [(e(x["pr_no"]), e(x["item_cd"]), e(it(x["item_cd"]).get("nm", "")), e(it(x["item_cd"]).get("spec", "")), won(x["qty"]), "→ %s" % x["po_seq"]) for x in r.get("pr_lines") or []]
        body += '<details><summary>요청 줄 %d개</summary>%s</details>' % (len(rows), table(["구매요청번호", "품번", "품목", "규격", "수량", "발주 순번"], rows, num=(4,)))
    elif n == 2:
        lr, sc = r.get("list_rows") or {}, r.get("screen") or {}
        why = "요청이 중간DB 에 들어와 포털 LIST 에 자동으로 올라 있다. 엑셀 LIST 에도 %d줄이 있다." % lr.get("rows", 0)
        body += '<div class="sub2">엑셀 LIST 에 적힌 값(원문)</div>'
        body += table(["칸", "엑셀", "ERP"], [
            ("발주일자", e(lr.get("order_dt_raw") or "(빈칸)"), e(po.get("po_dt", "-"))),
            ("발주번호", e(lr.get("po_no_raw") or "(빈칸)"), e(po.get("po_no", "-"))),
            ("입고요청일", e(lr.get("need_dt_raw") or "(빈칸)"), e(pu.get("need_dt", "-"))),
            ("입고일", e(lr.get("rcpt_dt_raw") or "(빈칸)"), e(max([g["dt"] for g in r.get("gr") or []] or ["아직 없음"]))),
            ("비고", e(lr.get("remark_raw") or "(빈칸)"), "—"),
            ("금액 합", won(lr.get("amt_sum")), won(po.get("amt"))),
        ])
        if lr.get("note"):
            body += '<div class="kv" style="color:var(--muted)">%s</div>' % e(lr["note"])
        wrong = sc.get("unreceived") and calc["po_qty"] and calc["gr_qty"] >= calc["po_qty"]
        body += '<div class="sub2">포털 발주통합 LIST 에 보이는 상태</div>'
        body += '<div class="kv">상태 「%s」 · 미입고 표시 %s · 납기경과 표시 %s — 실입고 %s / 발주 %s, 매입 %s %s</div>' % (
            e(sc.get("status_kr", "-")), "켜짐" if sc.get("unreceived") else "꺼짐", "켜짐" if sc.get("overdue") else "꺼짐",
            won(sc.get("rcpt_qty_sum")), won(sc.get("po_qty")), won(sc.get("iv_qty_sum")),
            '<span class="tbad">← 실제와 다르다(전량 입고 · 매입 완료)</span>' if wrong else "")
    elif n == 3:
        q = r.get("quote")
        why = (r.get("manual") or {}).get("3", "")
        if q:
            rows = [(e(x["item_cd"]), e(it(x["item_cd"]).get("nm", "")), won(x["qty"]), won(x["price"]), won(x["qty"] * x["price"]), e(x.get("lead", ""))) for x in q["lines"]]
            body += '<div class="kv"><b>견적</b> 업체 %d곳 · 합계 %s원 <small>(%s)</small></div>' % (q.get("vendors", 1), won(q.get("amt")), e(q.get("src", "")))
            body += '<details><summary>견적 줄 %d개 · 예상 납기</summary>%s</details>' % (len(rows), table(["품번", "품목", "수량", "단가", "금액", "예상 납기"], rows, num=(2, 3, 4)))
    elif n == 4:
        why = (r.get("manual") or {}).get("4", "")
        if po.get("lines"):
            body += '<div class="kv">결정의 결과만 발주로 남아 있다 — 거래처 %s · 금액 %s원</div>' % (e(po.get("bp_nm") or case["case"]["bp_nm"]), won(po.get("amt")))
    elif n == 5:
        led = r.get("ledger") or {}
        why = "ERP 에 발주 %d줄이 있다(요청 줄과 줄 단위로 이어짐). 기안은 대장 %s 로 확인된다." % (len(po.get("lines") or []), led.get("vol_no", "-")) if po.get("lines") else "아직 발주가 없다."
        if po.get("lines"):
            body += '<div class="kv"><b>발주번호</b> %s · <b>발주일</b> %s · <b>납기</b> %s · <b>담당</b> %s · <b>금액</b> %s원</div>' % (e(po["po_no"]), e(po["po_dt"]), e(po.get("dlvy_dt", "-")), e(po.get("buyer", "-")), won(po["amt"]))
            if po.get("pay_method"):
                body += '<div class="kv"><b>결제방법(발주서)</b> %s</div>' % e(po["pay_method"])
            if r.get("advance"):
                body += '<div class="kv"><b>선진행</b> %s <small>(%s)</small> — 발주·기안보다 %d일 먼저</div>' % (e(r["advance"]["dt"]), e(r["advance"]["src"]), (to_date(po["po_dt"]) - to_date(r["advance"]["dt"])).days)
            rows = [(x["po_seq"], e(x["item_cd"]), e(it(x["item_cd"]).get("nm", "")), won(x["qty"]), won(x["price"]), won(x["amt"]), e(x["pr_no"])) for x in po["lines"]]
            body += '<details><summary>발주 줄 %d개</summary>%s</details>' % (len(rows), table(["순번", "품번", "품목", "수량", "단가", "금액", "구매요청번호"], rows, num=(3, 4, 5)))
    elif n == 6:
        gr, et = r.get("gr") or [], r.get("etax")
        if gr:
            days = sorted({g["dt"] for g in gr})
            why = "ERP 입고 %d건 · 수량 %s / 발주 %s. %s" % (len(gr), won(calc["gr_qty"]), won(calc["po_qty"]), "국세청 자료에 세금계산서가 있다." if et else "세금계산서는 아직 확인되지 않는다.")
            body += '<div class="kv"><b>입고일</b> %s · <b>입고번호</b> %s ~ %s</div>' % (e(", ".join(days)), e(gr[0]["pg_no"]), e(gr[-1]["pg_no"]))
            late = (to_date(days[-1]) - to_date(po["dlvy_dt"])).days if po.get("dlvy_dt") else None
            if late is not None:
                body += '<div class="kv"><b>납기 대비</b> %s</div>' % ("%d일 늦음(납기 %s)" % (late, e(po["dlvy_dt"])) if late > 0 else "납기 안")
            rows = [(e(g["pg_no"]), g["po_seq"], won(g["qty"]), e(g["dt"])) for g in gr]
            body += '<details><summary>입고 %d건</summary>%s</details>' % (len(rows), table(["입고번호", "발주 순번", "수량", "입고일"], rows, num=(2,)))
        elif st[6] == "norec":
            why = "ERP 에 입고 기록이 없는데 매입은 발주 수량만큼(%s) 끝났다 — 외주 가공·용역처럼 입고 등록을 거치지 않는 흐름이다. 끝나지 않은 것이 아니라 기록이 없는 것이다." % won(calc["po_qty"])
        else:
            why = "ERP 에 입고가 아직 없다(발주 수량 %s)." % won(calc["po_qty"]) if po.get("lines") else "아직 해당 없음."
        if et:
            body += '<div class="sub2">세금계산서(국세청 자료)</div>'
            body += '<div class="kv"><b>승인번호</b> %s · <b>작성일</b> %s · <b>공급가</b> %s · <b>부가세</b> %s</div>' % (e(et["approval_no"]), e(et["write_dt"]), won(et["supply_amt"]), won(et["vat_amt"]))
            if et.get("item_nm"):
                body += '<div class="kv"><b>품목란</b> %s</div>' % e(et["item_nm"])
        m = (r.get("manual") or {}).get("6_mail")
        if m:
            body += '<div class="sub2">계산서 발행요청 메일</div><div class="kv"><span class="stt norec">기록 없음</span> %s</div>' % e(m)
    elif n == 7:
        iv, slip, vat = r.get("iv"), r.get("slip"), r.get("vat")
        if iv:
            parts = iv.get("parts") or []
            n_ok = sum(1 for p in (slip or {}).get("parts") or [] if p.get("conf") == "C")
            why = "ERP 에 매입과 결의전표가 있다. 전표 승인 표시는 스냅샷에서 「%s」." % (("승인 %d/%d장" % (n_ok, len(slip["parts"]))) if (slip or {}).get("parts") else ("승인" if (slip or {}).get("conf") == "C" else "미승인"))
            body += '<div class="kv"><b>매입번호</b> %s · <b>매입일</b> %s · <b>공급가</b> %s · <b>부가세</b> %s · <b>합계</b> %s</div>' % (e(iv["iv_no"]), e(iv["iv_dt"]), won(iv["supply_amt"]), won(iv["vat_amt"]), won(iv["supply_amt"] + iv["vat_amt"]))
            if iv.get("pay_method"):
                body += '<div class="kv"><b>결제방법</b> %s · <b>지급예정일</b> %s <small>(결재문서)</small></div>' % (e(iv["pay_method"]), e(iv.get("pay_due", "-")))
            if len(parts) > 1 or any(p.get("other_pos") for p in parts):
                # 매입이 여러 장이거나(분할·진척) 한 장이 다른 발주까지 묶었으면 장마다 보여 준다 — 이 발주 몫과 전체가 다르다
                sp = {p["ref_no"]: p for p in (slip or {}).get("parts") or []}
                rows = []
                for p in parts:
                    s1 = sp.get(p["iv_no"]) or {}
                    rows.append((e(p["iv_no"]), e(p["iv_dt"]), won(p["supply_amt"]), won(p.get("total_supply", p["supply_amt"])),
                                 e(p.get("other_pos") or "—"), e(s1.get("slip_no", "-")), "승인" if s1.get("conf") == "C" else ("미승인" if s1 else "-")))
                body += '<div class="sub2">매입 %d장 — 이 발주 몫 / 매입 전체</div>' % len(parts)
                body += table(["매입번호", "매입일", "이 발주 몫(공급가)", "매입 전체(공급가)", "같은 매입에 묶인 다른 발주", "전표", "승인"], rows, num=(2, 3))
            if slip:
                body += '<div class="sub2">결의전표 %s <small style="font-weight:400">· 전표일 %s · 참조번호 %s</small></div>' % (e(slip["slip_no"]), e(slip["slip_dt"]), e(slip.get("ref_no", "-")))
                rows = [(x["seq"], e(x["acct_cd"]), e(x["acct_nm"]), won(x["amt"]) if x["drcr"] == "DR" else "", won(x["amt"]) if x["drcr"] == "CR" else "") for x in slip["lines"]]
                body += table(["#", "계정코드", "계정과목", "차변", "대변"], rows, num=(3, 4))
            if vat:
                body += '<div class="kv"><b>부가세번호</b> %s · <b>계산서일</b> %s · %s + %s</div>' % (e(vat["vat_no"]), e(vat["issue_dt"]), won(vat["supply_amt"]), won(vat["vat_amt"]))
            rows = [(x["iv_seq"], x["po_seq"], won(x["qty"]), won(x["price"]), won(x["amt"]), won(x["vat"]), e(x["pg_no"])) for x in iv["lines"]]
            body += '<details><summary>매입 줄 %d개</summary>%s</details>' % (len(rows), table(["순번", "발주 순번", "수량", "단가", "공급가", "부가세", "입고번호"], rows, num=(2, 3, 4, 5)))
        else:
            why = "ERP 에 매입이 아직 없다."
    elif n == 8:
        led = r.get("ledger")
        if led:
            x, d = led.get("xlsx") or {}, led.get("db") or {}
            why = "대장 %s 에 줄이 있고 묶음 파일 %s 이 있다. 엑셀 기준 종결 「%s」." % (led["vol_no"], led.get("scan_file") or "없음", x.get("closed", "-"))
            jn = led.get("job_no_raw", "")
            jn_bad = jn != (r.get("project_no") or case["case"]["project_no"])
            body += '<div class="kv"><b>권-번호</b> %s · <b>일자</b> %s · <b>기안자</b> %s · <b>금액</b> %s</div>' % (e(led["vol_no"]), e(led.get("draft_dt", "-")), e(led.get("drafter", "-")), won(led.get("amt")))
            body += '<div class="kv"><b>생산번호(대장)</b> %s %s</div>' % (e(jn), '<span class="tbad">← ERP · 기안서는 %s</span>' % e(r.get("project_no") or case["case"]["project_no"]) if jn_bad else "")
            if led.get("pay_plan"):
                # 계약금·중도금·잔금(대장의 지급 단계) — 전표와 비율을 그대로 보여 준다
                rows = [(e(p["name"]), e(p.get("rate") or "-"), e(p.get("slip") or "(빈칸)"), e(p.get("dt") or "(빈칸)")) for p in led["pay_plan"]]
                body += '<div class="sub2">지급 단계(대장)</div>' + table(["단계", "비율", "전표번호 칸", "일자"], rows)
            if led.get("others"):
                body += '<div class="kv"><span class="tbad">같은 전표로 묶여 「확정」 연결된 다른 기안 %d건</span> — %s</div>' % (len(led["others"]), e(" · ".join(led["others"])))
            body += table(["", "엑셀 대장", "포털(중간DB · %s 적재)" % e(d.get("loaded", "-"))], [
                ("종결", e(x.get("closed") or "-"), e(d.get("closed") or "-")),
                ("지급", e(x.get("pay") or "-"), "—"),
                ("전표번호", e(x.get("slip") or "(빈칸)"), e(d.get("slip") or "(없음)")),
                ("발행일", e(x.get("slip_dt") or "(빈칸)"), "—"),
                ("발주 자동 연결", "—", e(d.get("po_link") or "연결 안 됨")),
            ])
        else:
            why = "대장에 줄이 없다."
    return why, body


def build(case, style, flow, files, zips):
    items = case.get("items", {})
    stages = case["stages"]
    rounds = case["rounds"]
    states, curs, calcs = {}, {}, {}
    for r in rounds:
        states[r["id"]], curs[r["id"]], calcs[r["id"]] = stage_states(r)
    docs, unmatched = resolve_docs(case, files, zips, states)
    c = case["case"]
    snap = case["snapshot"]
    H = []
    H.append('<span class="doc-label">구매 건 추적 · 예시 · 비공개</span>')
    H.append("<h1>구매 건 추적 — %s × %s</h1>" % (e(c["project_no"]), e(c["bp_nm"])))
    H.append('<div class="sub">%s · %s · 고객 %s<br>ERP 값은 중간DB %s 적재분(스냅샷 %s) · 결재 정보는 폴더 PDF 에서 옮겨 적음 · 엑셀 값은 원문 그대로<br>'
             '전체 프로세스 설명은 <a href="%s/docs/purchase/process">구매업무 프로세스 도식</a> — 아래 도식은 그 문서와 같은 것이다.</div>'
             % (e(c.get("project_nm", "")), e(c.get("subject", "")), e(c.get("customer", "-")), e(snap.get("mirror_synced_kst", "-")), e(snap.get("taken_at", "-")), SITE))
    H.append('<div class="private"><b>실거래 자료가 들어 있다.</b> 거래처·단가·결재자 이름이 그대로 보인다. 이 파일과 case.json 은 이 폴더 안에만 두고, 메일·메신저·저장소로 옮기지 않는다. '
             'PDF 링크는 이 폴더 안의 파일을 가리키므로 폴더째 있어야 열린다.</div>')
    H.append('<nav class="toc"><a href="#c1">1 요약</a><a href="#c2">2 폴더 문서</a><a href="#c3">3 도식과 진행</a><a href="#c4">4 실제 번호</a><a href="#c5">5 단계별 자료</a><a href="#c6">6 단가 비교</a><a href="#c7">7 문서 보유</a><a href="#c8">8 불일치·관찰</a><a href="#c9">9 소요일</a><a href="#c10">10 ERP 에 없는 것</a></nav>')

    # 1 요약
    H.append('<h2 id="c1">1. 요약</h2><div class="hero">')
    for r in rounds:
        st, cur = states[r["id"]], curs[r["id"]]
        po = r.get("po") or {}
        pos = "끝까지 완료" if cur is None else "%d단계 「%s」에 서 있다" % (cur, stages[cur - 1])
        H.append('<div class="hcard %s"><div class="k">%s</div><div class="v">%s · %s원</div><p>요청 결재 %s → 발주 %s<br><b>%s</b></p></div>'
                 % ("etc" if cur is None else "erp", e(r["label"]), e(po.get("po_no", "-")), won(po.get("amt")), e((r.get("pu") or {}).get("pu_no", "-")), e(po.get("po_dt", "-")), e(pos)))
    nbad = sum(1 for f in case.get("findings", []) if f["sev"] == "bad")
    nwarn = sum(1 for f in case.get("findings", []) if f["sev"] == "warn")
    # 요약 문장은 발견 사항 제목에서 뽑는다(결함·주의 먼저, 최대 3개) — 예시마다 다르다
    heads = [f["title"] for f in sorted(case.get("findings", []), key=lambda x: {"bad": 0, "warn": 1}.get(x["sev"], 2))][:3]
    H.append('<div class="hcard gw"><div class="k">이 건에서 본 것</div><div class="v">결함 %d · 주의 %d · 관찰 %d</div><p>%s <a href="#c8">8절</a></p></div></div>'
             % (nbad, nwarn, len(case.get("findings", [])) - nbad - nwarn, e(" · ".join(heads)) + ("." if heads else "")))

    # 2 폴더 문서
    H.append('<h2 id="c2">2. 이 폴더의 문서 <span class="h2sub">어느 차수 · 어느 단계의 문서인가</span></h2>')
    top = [f for f in case.get("findings", []) if not f.get("round") and f.get("step") == 0]
    for f in top:
        H.append('<div class="callout warn"><span class="big">%s</span>%s<br><small>%s</small></div>' % (e(f["title"]), e(f["detail"]), e(f["evidence"])))
    rl = {r["id"]: r["label"] for r in rounds}
    rows = []
    for d in docs:
        if d["status"] in ("have", "zip"):
            link = '<a href="%s" target="_blank">%s</a>' % (e(urllib.parse.quote(d["file"], safe="/")), e(d["file"]))
            rows.append((link + (" <small>안의 「%s」</small>" % e(d["note"]) if d["status"] == "zip" else ""), e(rl[d["round"]]), "%d %s" % (d["step"], e(stages[d["step"] - 1])), e(d["kind"])))
    H.append(table(["파일", "차수", "단계", "문서"], rows, cls=""))
    if unmatched:
        H.append('<div class="cap">어느 단계에도 맞추지 못한 파일: %s</div>' % e(", ".join(unmatched)))

    # 3 도식 + 진행 트랙
    H.append('<h2 id="c3">3. 전체 도식과 진행 <span class="h2sub">위는 공용 도식, 아래 두 줄이 이 건의 차수별 위치</span></h2>')
    trk = ['<div class="trackgrid" aria-label="차수별 진행">']
    for r in rounds:
        st, cur = states[r["id"]], curs[r["id"]]
        trk.append('<div class="tl">%s<small>%s</small></div>' % (e(r["label"].split(" · ")[0]), e(r["label"].split(" · ")[-1])))
        for n in range(1, len(stages) + 1):
            dd = [d for d in docs if d["round"] == r["id"] and d["step"] == n and d.get("where") != "dms"]
            have = sum(1 for d in dd if d["status"] in ("have", "zip"))
            dtxt = ("문서 %d/%d" % (have, len(dd))) if dd else "문서 —"
            trk.append('<a class="trk %s" href="#st%d" data-stage="%d %s"><b>%s</b><span class="d">%s</span><span class="d">%s</span></a>'
                       % (st[n], n, n, e(stages[n - 1]), e(ST_LABEL[st[n]]), e(track_key(n, r)), e(dtxt)))
    trk.append("</div>")
    H.append('<div class="flowwrap">' + flow + "".join(trk) + "</div>")
    H.append('<div class="legend"><span><span class="stt done">완료</span> ERP 실적이나 문서로 확인됨</span><span><span class="stt cur">지금 여기</span> 다음에 할 단계</span>'
             '<span><span class="stt part">일부</span> 일부만 확인됨</span><span><span class="stt norec">기록 없음</span> 지나갔지만 했다는 기록이 없다</span><span><span class="stt todo">아직</span></span></div>')
    H.append('<div class="cap">「단계 상태」는 데이터(ERP 실적 · 대장)로, 「문서 n/m」은 이 폴더의 파일로 센다 — 둘은 다른 축이다. 1차는 데이터가 끝까지 있지만 폴더 문서는 한 장뿐이다.</div>')

    # 4 실제 번호 사슬
    H.append('<h2 id="c4">4. 실제 번호 사슬</h2>')
    for r in rounds:
        H.append('<div class="chainrow"><h3>%s</h3>%s</div>' % (e(r["label"]), chain_html(r)))
    H.append('<div class="cap">흐린 칸은 아직 생기지 않은 번호다. 같은 요청 결재의 나머지 줄은 다른 거래처로 따로 발주됐다(<a href="#st1">1단계</a> 참조).</div>')

    # 5 단계별 자료
    H.append('<h2 id="c5">5. 단계별 자료 <span class="h2sub">문서 · ERP 데이터 · 엑셀 · 대장</span></h2>')
    for n in range(1, len(stages) + 1):
        H.append('<div class="step" id="st%d"><div class="hd"><span class="n">%d</span><span class="t">%s</span></div><div class="bd"><div class="two">' % (n, n, e(stages[n - 1])))
        for r in rounds:
            st = states[r["id"]]
            why, body = step_body(n, r, items, st, calcs[r["id"]], case)
            dd = [d for d in docs if d["round"] == r["id"] and d["step"] == n]
            gw = next((g for g in r.get("gw", []) if g["step"] == n), None)
            H.append('<div class="rcol"><h4>%s <span class="stt %s">%s</span></h4><p class="why">%s</p>' % (e(r["label"]), st[n], e(ST_LABEL[st[n]]), e(why)))
            if dd:
                H.append('<div class="sub2">문서</div>' + "".join(doc_html(d) for d in dd))
            H.append(gw_html(gw))
            H.append(body + "</div>")
        H.append("</div>")
        fs = [f for f in case.get("findings", []) if f.get("step") == n]
        for f in fs:
            H.append('<div class="find %s" style="margin-top:12px"><h4><span class="dk %s" style="margin-right:6px">%s</span>%s</h4><p>%s</p></div>'
                     % (f["sev"], "missing" if f["sev"] == "bad" else "not_yet", e(SEV_LABEL[f["sev"]]), e(f["title"]), e(f["detail"])))
        H.append("</div></div>")

    # 6 단가 비교
    pc = price_compare(case)
    H.append('<h2 id="c6">6. 단가 비교 — %s 대 %s <span class="h2sub">같은 거래처 · 같은 품목</span></h2>' % (e(rounds[0]["label"].split(" · ")[0]), e(rounds[-1]["label"].split(" · ")[0])))
    if pc:
        rows = []
        for x, p in pc["rows"]:
            nm = e(items.get(x["item_cd"], {}).get("nm", ""))
            if not p:
                rows.append((e(x["item_cd"]), nm, "—", won(x["price"]), "—", "—", won(x["qty"]), "—"))
                continue
            dlt = x["price"] - p["price"]
            rows.append((e(x["item_cd"]), nm, won(p["price"]), won(x["price"]), ("+" if dlt > 0 else "") + won(dlt), "%+.1f%%" % (dlt / p["price"] * 100), won(x["qty"]), ("+" if dlt > 0 else "") + won(dlt * x["qty"])))
        gap = pc["new"] - pc["old"]
        rows.append(("<b>합계</b>", "2차 수량 기준", "<b>%s</b>" % won(pc["old"]), "<b>%s</b>" % won(pc["new"]), "", "<b>%+.2f%%</b>" % (gap / pc["old"] * 100), "", "<b>%s%s</b>" % ("+" if gap > 0 else "", won(gap))))
        H.append(table(["품번", "품목", "1차 실적 단가", "2차 단가", "차이", "비율", "2차 수량", "금액 차"], rows, cls="", num=(2, 3, 4, 5, 6, 7)))
        if pc["only_old"]:
            H.append('<div class="cap">1차에만 있는 품목: %s</div>' % e(", ".join("%s %s" % (v["item_cd"], items.get(v["item_cd"], {}).get("nm", "")) for v in pc["only_old"])))
        H.append('<div class="callout">2차 단가로 2차 수량을 사면 %s원, 1차 실적 단가였다면 %s원 — <b>%s원(%+.2f%%)</b> 차이다. '
                 'ERP 의 과거 발주 단가를 품의 전에 옆에 붙여 주기만 해도 보이는 차이다. 실제 경위(1차 때 깎은 금액인지, 2차에 견적가를 그대로 쓴 것인지)는 담당자 확인이 필요하다.</div>'
                 % (won(pc["new"]), won(pc["old"]), won(gap), gap / pc["old"] * 100))

    # 7 문서 보유
    H.append('<h2 id="c7">7. 문서 보유 체크</h2>')
    rows = [(e(rl[d["round"]]), "%d %s" % (d["step"], e(stages[d["step"] - 1])), e(d["kind"]) + (" <small>%s</small>" % e(d["ref"]) if d.get("ref") else ""),
             '<span class="dk %s">%s</span>' % (d["status"], e(DOC_LABEL[d["status"]])),
             e(d["file"] or d["note"] or ("단계가 아직" if d["status"] == "not_yet" else "폴더에 없음"))) for d in docs]
    H.append(table(["차수", "단계", "문서", "상태", "어디"], rows, cls=""))
    miss = [d for d in docs if d["status"] == "missing"]
    if miss:
        H.append('<div class="callout warn">없음 %d건 — %s. 이 문서들을 폴더에 넣고 빌더를 다시 돌리면 「있음」으로 바뀐다(파일 이름에 해당 번호가 들어 있으면 자동으로 찾는다).</div>'
                 % (len(miss), e(" · ".join("%s %s" % (rl[d["round"]].split(" · ")[0], d["kind"]) for d in miss))))

    # 8 불일치·관찰
    H.append('<h2 id="c8">8. 불일치 · 관찰</h2>')
    order = {"bad": 0, "warn": 1, "info": 2}
    for f in sorted(case.get("findings", []), key=lambda x: order[x["sev"]]):
        H.append('<div class="find %s"><h4><span class="dk %s" style="margin-right:6px">%s</span>%s%s</h4><p>%s</p><p class="ev">근거: %s</p><p><b>→</b> %s</p></div>'
                 % (f["sev"], "missing" if f["sev"] == "bad" else "not_yet", e(SEV_LABEL[f["sev"]]), e(f["title"]),
                    (' <small style="font-weight:400;color:var(--muted)">· %s%s</small>' % (e(rl.get(f.get("round"), "공통")), (" · %d단계" % f["step"]) if f.get("step") else "")),
                    e(f["detail"]), e(f["evidence"]), e(f["action"])))

    # 9 소요일
    H.append('<h2 id="c9">9. 소요일</h2><div class="two">')
    for r in rounds:
        ev = events(r)
        H.append('<div class="rcol"><h4>%s</h4><div class="tline"><span class="h">날짜</span><span class="h">일</span><span class="h n">앞에서부터</span><span class="h n">처음부터</span>' % e(r["label"]))
        first, prev = None, None
        for nm, dt, src, plan in ev:
            d0 = to_date(dt)
            if plan:
                H.append('<span class="pl">%s</span><span class="pl">%s <small>(%s · 계획)</small></span><span></span><span></span>' % (e(dt), e(nm), e(src)))
                continue
            first = first or d0
            H.append('<span>%s</span><span>%s <small style="color:var(--muted)">(%s)</small></span><span class="n">%s</span><span class="n">%s</span>'
                     % (e(dt), e(nm), e(src), ("+%d일" % (d0 - prev).days) if prev else "", "%d일" % (d0 - first).days))
            prev = d0
        H.append("</div></div>")
    H.append("</div>")

    # 10 ERP 에 없는 것
    H.append('<h2 id="c10">10. 이 건으로 본 「ERP 에 없는 것」</h2>')
    H.append(table(["무엇", "이 건에서는 어디서 알았나", "없으면 생기는 일"], [
        ("결재가 끝난 날 · 결재선", "폴더의 결재 PDF 에서 옮겨 적었다. ERP 에는 요청 결재번호만 있다", "결재에 며칠 걸렸는지, 지금 누구 차례인지 화면에서 알 수 없다"),
        ("구매기안 ↔ 발주 연결", "기안서 본문 · 첨부 발주서를 사람이 읽어 맞췄다. 대장에는 발주번호 칸이 없다", "자동 연결이 프로젝트 · 거래처 · 금액 짐작에 기대고, 번호가 한 글자만 달라도 끊긴다"),
        ("견적 · NEGO · 업체 선정", "2차는 견적서 한 부와 기안서의 한 줄뿐, 1차는 남은 것이 없다", "왜 이 업체 · 이 가격인지, 얼마를 깎았는지 돌아볼 수 없다"),
        ("선진행한 날", "엑셀 LIST 발주일자 칸의 글자와 기안서 본문", "결재 전에 먼저 진행한 건이 얼마나 되는지 셀 수 없다"),
        ("계산서 발행요청 메일", "어디에도 없다", "입고가 끝났는데 계산서를 못 받은 건을 따로 챙겨야 한다"),
        ("실제 예상 납기", "견적서(품목별 예상 납기)", "ERP 납기일이 발주일과 같아 「납기경과」 표시가 뜻을 잃는다"),
    ], cls=""))

    # 검산
    H.append('<h3>검산 <span class="h2sub" style="font-weight:400;color:var(--muted);font-size:12.5px">빌더가 case.json 의 숫자를 서로 맞춰 본 결과</span></h3>')
    rows = []
    for r in rounds:
        for nm, ok, txt in checks(r):
            rows.append((e(r["label"].split(" · ")[0]), e(nm), '<span class="%s">%s</span>' % ("tgood" if ok else "tbad", "일치" if ok else "불일치"), e(txt)))
    H.append(table(["차수", "항목", "결과", "값"], rows, cls="mini"))

    H.append('<div class="foot">구매건_추적.html · 생성물(손으로 고치지 않는다) — <code>_build_case.py</code> 가 <code>case.json</code> 과 정본 도식으로 만든다 · 생성 %s · 비공개</div>'
             % _dt.datetime.now().strftime("%Y-%m-%d %H:%M"))
    page = ("<!DOCTYPE html>\n<html lang=\"ko\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n"
            "<meta name=\"robots\" content=\"noindex,nofollow\">\n<title>구매 건 추적 — %s</title>\n<style>\n%s\n%s</style>\n</head>\n<body>\n<div class=\"page\">\n%s\n</div>\n"
            "<button class=\"theme\" type=\"button\" onclick=\"(function(){var r=document.documentElement,c=r.getAttribute('data-theme'),d=c?c==='dark':matchMedia('(prefers-color-scheme: dark)').matches;r.setAttribute('data-theme',d?'light':'dark');})()\">🌓 테마</button>\n</body>\n</html>\n"
            % (e(c["project_no"]), style, EXTRA_CSS, "\n".join(H)))
    return page, docs, states, curs


def track_key(n, r):
    """진행 트랙 칸의 둘째 줄 — 그 단계의 대표 번호·날짜"""
    po, pu = r.get("po") or {}, r.get("pu") or {}
    gw = {g["step"]: g for g in r.get("gw", [])}
    if n == 1:
        return "%s · PU…%s" % (md(pu.get("req_dt")), pu["pu_no"][-4:]) if pu.get("pu_no") else "-"
    if n == 2:
        return "LIST %d줄" % (r.get("list_rows") or {}).get("rows", 0)
    if n == 3:
        return "견적서 1부" if r.get("quote") else "견적 자료 없음"
    if n == 4:
        return "결과만 발주로"
    if n == 5:
        return "%s · PO…%s" % (md(po.get("po_dt")), po["po_no"][-4:]) if po.get("po_no") else "-"
    if n == 6:
        if r.get("gr"):
            days = sorted({g["dt"] for g in r["gr"]})
            return "%s 입고 %d건" % (md(days[-1]), len(r["gr"])) if len(days) == 1 else "%s~%s 입고 %d건" % (md(days[0]), md(days[-1]), len(r["gr"]))
        return "입고 기록 없음(매입으로 끝)" if r.get("iv") else "입고 대기"
    if n == 7:
        return "%s · TG…%s" % (md(r["iv"]["iv_dt"]), (r.get("slip") or {}).get("slip_no", "----")[-4:]) if r.get("iv") else "-"
    if n == 8:
        led = r.get("ledger")
        return "대장 %s · %s" % (led["vol_no"], "종결" if (led.get("xlsx") or {}).get("closed") == "Y" else "종결 전") if led else "-"
    return ""


def chain_html(r):
    po, pu = r.get("po") or {}, r.get("pu") or {}
    gr, iv, slip, vat, et, led = r.get("gr") or [], r.get("iv"), r.get("slip"), r.get("vat"), r.get("etax"), r.get("ledger")
    prs = r.get("pr_lines") or []

    def box(cls, code, label, val):
        return '<div class="no %s%s"><b>%s</b><span>%s</span><small>%s</small></div>' % (cls, "" if val else " off", e(code), e(label), e(val or "아직"))

    def lk(txt, cls=""):
        return '<div class="lk %s">%s</div>' % (cls, e(txt))

    pr_txt = "%s ~ %s" % (prs[0]["pr_no"], prs[-1]["pr_no"][-4:]) if prs else ""
    pg_txt = "%s ~ %s" % (gr[0]["pg_no"], gr[-1]["pg_no"][-4:]) if gr else ""
    s = '<div class="chain">'
    s += box("erp", "PR", "요청 %d줄" % len(prs), pr_txt) + lk("결재번호 칸")
    s += box("gw", "PU", "요청 결재", pu.get("pu_no")) + lk("기록 없음", "cut")
    s += box("gw", "기안", "구매기안 · 대장", (led or {}).get("vol_no")) + lk("칸 없음", "cut")
    s += box("erp", "PO", "발주 %d줄" % len(po.get("lines") or []), po.get("po_no")) + lk("발주번호+순번")
    s += box("erp", "PG", "입고 %d건" % len(gr), pg_txt) + lk("발주번호+순번")
    s += box("erp", "IV", "매입", (iv or {}).get("iv_no")) + lk("참조번호")
    s += box("erp", "TG", "결의전표", (slip or {}).get("slip_no")) + lk("전표번호")
    s += box("erp", "VT", "부가세", (vat or {}).get("vat_no")) + lk("값 네 개 대조", "weak")
    s += box("ext", "승인번호", "국세청", (et or {}).get("approval_no")) + lk("손으로 기재", "weak")
    s += box("etc", "권-번호", "보관 파일", (led or {}).get("scan_file"))
    return s + "</div>"


# ── 실행 ──────────────────────────────────────────────────────────────
def git_ignored_or_outside(path):
    """저장소 밖이거나 git 제외 대상이면 True — 실거래 자료를 추적 대상 위치에 쓰지 않기 위한 안전장치."""
    try:
        top = subprocess.run(["git", "-C", HERE, "rev-parse", "--show-toplevel"], capture_output=True, text=True, encoding="utf-8").stdout.strip()
    except OSError:
        return True
    if not top:
        return True
    top = os.path.normcase(os.path.abspath(top))
    ap = os.path.normcase(os.path.abspath(path))
    try:
        if os.path.commonpath([top, ap]) != top:
            return True
    except ValueError:      # 드라이브가 다르면 저장소 밖이다
        return True
    rel = os.path.relpath(ap, top).replace(os.sep, "/")
    r = subprocess.run(["git", "-C", top, "check-ignore", "-q", rel])
    return r.returncode == 0


def main():
    for stream in (sys.stdout, sys.stderr):        # 콘솔이 cp949 여도 한글·기호 출력에서 죽지 않게
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    check_only = "--check" in sys.argv
    if len(args) != 1:
        print(__doc__)
        return 2
    case_dir = os.path.abspath(args[0])
    data = os.path.join(case_dir, DATA_NAME)
    if not os.path.isfile(data):
        fail("사례 폴더에 %s 이 없다" % DATA_NAME)
    case = json.load(io.open(data, encoding="utf-8"))
    if case.get("schema") != "pur-case/1":
        fail("case.json 스키마가 pur-case/1 이 아니다")
    style, flow, stage_names = load_master()
    if case.get("stages") != stage_names:
        fail("단계 이름이 정본 도식과 다르다\n   정본: %s\n   case: %s" % (stage_names, case.get("stages")))
    files, zips = scan_folder(case_dir)
    page, docs, states, curs = build(case, style, flow, files, zips)

    print("단계 %d개 · 차수 %d개 · 폴더 파일 %d개(ZIP 안 %d개)" % (len(stage_names), len(case["rounds"]), len(files), len(zips)))
    bad = 0
    for r in case["rounds"]:
        st = states[r["id"]]
        print("  [%s] %s · 지금: %s" % (r["id"], " ".join("%d:%s" % (n, ST_LABEL[st[n]]) for n in sorted(st)), ("%d단계" % curs[r["id"]]) if curs[r["id"]] else "끝"))
        for nm, ok, txt in checks(r):
            if not ok:
                bad += 1
                print("    ✗ 검산 불일치 — %s (%s)" % (nm, txt))
    cnt = {}
    for d in docs:
        cnt[d["status"]] = cnt.get(d["status"], 0) + 1
    print("  문서: " + " · ".join("%s %d" % (DOC_LABEL[k], v) for k, v in cnt.items()))
    if bad and "--keep-mismatch" not in sys.argv:
        # 예시 검증(P0.5)에서는 불일치 자체가 관찰 결과다 — --keep-mismatch 로 화면에 「불일치」로 남기고 계속 만든다
        print("[중단] 검산 불일치 %d건 — case.json 을 확인한다(관찰로 남기려면 --keep-mismatch)" % bad)
        return 1
    if check_only:
        print("점검만 했다(파일을 쓰지 않았다).")
        return 0
    out = os.path.join(case_dir, OUT_NAME)
    if not git_ignored_or_outside(out):
        fail("출력 위치가 저장소 안인데 git 제외 대상이 아니다 — 실거래 자료를 여기에 쓰지 않는다: " + out)
    io.open(out, "w", encoding="utf-8", newline="\n").write(page)
    print("built: %s (%s bytes)" % (OUT_NAME, format(len(page.encode("utf-8")), ",")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
