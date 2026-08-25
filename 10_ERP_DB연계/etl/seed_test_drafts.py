# -*- coding: utf-8 -*-
r"""seed_test_drafts.py — ERP 연동 테스트용 결의전표 초안을 포털에 적재한다.

무엇을 만드나
  · **정상 케이스**(P…) — 통과해야 정상. 설계서 `14_AX전표_테스트범위_및_케이스설계` 의
    미수행 케이스(T2 미결·T5 복수선급·T6 매출·T7 선수금·T9 다중라인)와,
    거래항목 결정(C-15)에서 한 번도 타 보지 않은 **직접 코스트센터(DZ)** 경로를 덮는다.
  · **오류 케이스**(E…) — 차단돼야 정상. 차단규칙 `15_AX전표_입력검증_및_차단규칙` 의
    G1·G2·G5 와 법인카드 이중계상 금지를 각각 정면으로 친다.

왜 스크립트인가
  화면으로 14건을 손으로 넣으면 오타가 섞이고, 무엇을 왜 넣었는지가 남지 않는다.
  케이스 정의를 코드에 두면 **기대 결과와 함께** 반복 재현할 수 있다.

민감값을 저장소에 박지 않는다(CLAUDE.md §1)
  사번(EM)·거래처(BP)·프로젝트(PC) 같은 관리항목 값은 **실행 시 DEMO2 에서 해석**한다.
  각 계정에서 실제로 가장 많이 쓰인 값을 골라 쓰므로, 마스터가 바뀌어도 따라간다.
  값은 화면·로그에 마스킹해 출력한다.

사용
    python 10_ERP_DB연계/etl/seed_test_drafts.py --plan     설계만 출력(적재 안 함)
    python 10_ERP_DB연계/etl/seed_test_drafts.py --load     포털에 적재(제출됨 상태)
    python 10_ERP_DB연계/etl/seed_test_drafts.py --purge    이 배치 초안 삭제(적용된 건 제외)

적재 후 흐름
  화면 [ERP 전송] 탭 → 제출됨 목록에 14건이 뜬다 → 선택해서 [🚀 선택 건 ERP 전송]
  → 사내 중계가 처리 → 정상 6건은 전표번호(AG…), 오류 8건은 「손봐야 할 건」에 사유와 함께.

주의
  · **전송은 이 스크립트가 하지 않는다.** 상태는 `submitted` 까지만 만든다(사람이 누른다).
  · 대상은 DEMO2 뿐이다. 운영(JEILMNS) 은 어느 경로로도 닿지 않는다.
"""
import argparse
import datetime
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _env import load_env  # noqa: E402
import gl_apply_demo2 as R  # noqa: E402

BATCH = "TESTSET-2026-08-25"
DRAFT_DT = "2026-08-25"
OWNER_UPN = "dh.choi@jeilm.co.kr"
OWNER_NM = "최동혁"
DEPT_CD, DEPT_NM = "3200", "총무팀"
COST_INDIRECT = "C013200"      # 총무팀 — DI_FG='I' → EVENT_CD 'IZ'
COST_DIRECT = "C017100"        # 생산팀 — DI_FG='D' → EVENT_CD 'DZ' (미검증 경로)

# ── 관리항목 값 해석 규칙 ────────────────────────────────────────
# (계정, 관리항목) → DEMO2 에서 실제로 가장 많이 쓰인 값을 런타임에 고른다.
# 저장소에는 '어느 계정의 어느 항목을 쓸지'만 남고 값 자체는 남지 않는다.
RESOLVE = [
    ("21100902", "EM"), ("21100901", "BP"), ("11101701", "BP"),
    ("21101902", "BP"), ("11102301", "BP"), ("43000501", "PC"),
    ("11103301", "V5"), ("21102301", "V5"),
]
FALLBACK = {"V5": "TX1", "V4": "A", "PC": "9999-999"}


def mask(v: str) -> str:
    """관리항목 값 마스킹 — 길이와 앞 2자리만 보인다(사번·계좌가 로그에 남지 않게)."""
    s = str(v or "")
    return s if len(s) <= 2 else s[:2] + "*" * (len(s) - 2)


def resolve_ctrl_values(cur) -> dict:
    """DEMO2 실사용값에서 계정별 관리항목 대표값을 고른다."""
    got = {}
    for acct, ctrl in RESOLVE:
        cur.execute(
            """SELECT TOP 1 RTRIM(d.CTRL_VAL) FROM dbo.A_TEMP_GL_DTL d WITH (NOLOCK)
                 JOIN dbo.A_TEMP_GL_ITEM i WITH (NOLOCK)
                   ON i.TEMP_GL_NO = d.TEMP_GL_NO AND i.ITEM_SEQ = d.ITEM_SEQ
                WHERE RTRIM(i.ACCT_CD) = ? AND RTRIM(d.CTRL_CD) = ?
                  AND RTRIM(ISNULL(d.CTRL_VAL,'')) <> ''
                GROUP BY RTRIM(d.CTRL_VAL) ORDER BY COUNT(*) DESC""", acct, ctrl)
        r = cur.fetchone()
        got[(acct, ctrl)] = (str(r[0]).strip() if r else FALLBACK.get(ctrl, ""))
    # 선급금 2줄을 서로 다른 거래처로 나눠 연결번호가 각각 발급되는지 보려면 두 번째 값도 필요하다
    cur.execute(
        """SELECT TOP 2 RTRIM(d.CTRL_VAL) FROM dbo.A_TEMP_GL_DTL d WITH (NOLOCK)
             JOIN dbo.A_TEMP_GL_ITEM i WITH (NOLOCK)
               ON i.TEMP_GL_NO = d.TEMP_GL_NO AND i.ITEM_SEQ = d.ITEM_SEQ
            WHERE RTRIM(i.ACCT_CD) = '11102301' AND RTRIM(d.CTRL_CD) = 'BP'
              AND RTRIM(ISNULL(d.CTRL_VAL,'')) <> ''
            GROUP BY RTRIM(d.CTRL_VAL) ORDER BY COUNT(*) DESC""")
    rows = [str(r[0]).strip() for r in cur.fetchall()]
    got[("11102301", "BP2")] = rows[1] if len(rows) > 1 else got[("11102301", "BP")]
    return got


def vat_ctrls(cv, supply: int, tax: int, bp_key, *, sales: bool = False) -> dict:
    """부가세 라인 관리항목 한 벌. 매입(TP)·매출(TR) 모두 같은 V 계열을 쓴다."""
    acct = "21102301" if sales else "11103301"
    out = {"V1": str(supply), "V2": DRAFT_DT, "V4": "A",
           "V5": cv[(acct, "V5")], "V6": bp_key, "V11": "Y"}
    if not sales:
        out["V8"] = str(tax)          # 부가세액 — 매입 계정에만 있는 슬롯
    return out


def build_cases(cv) -> list:
    """케이스 정의. line = (차대, 계정, 금액, 적요, 관리항목dict, 코스트센터or None)"""
    BP_AP = cv[("21100901", "BP")]
    BP_AR = cv[("11101701", "BP")]
    BP_PR = cv[("21101902", "BP")]
    BP_PP = cv[("11102301", "BP")]
    BP_PP2 = cv[("11102301", "BP2")]
    EM = cv[("21100902", "EM")]
    PC = cv[("43000501", "PC")]
    due = {"C1": "2026-09-30"}

    C = []

    # ═══ 정상 케이스 — 통과해야 정상 ═══════════════════════════
    C.append(dict(
        sfx="P2", kind="정상", cost=COST_INDIRECT,
        title="T2 미결·개인경비(OC 발생)",
        why="설계서 범위의 24.6%(2위)인데 미수행. C-15 로 분개코드가 풀려 이제 열렸다",
        expect="성공 · SUBSYS_NO 는 **공란이 정상** · 승인 후 A_OPEN_ACCT 에 EM+사번 생성",
        lines=[
            ("D", "53010701", 500000, "판)복리후생비(식대)", {}, None),
            ("C", "21100902", 500000, "미지급금(개인)", {"EM": EM}, None),
        ]))
    C.append(dict(
        sfx="P5B", kind="정상", cost=COST_INDIRECT,
        title="T5 선급금 2건 + 부가세 + 채무",
        why="선급금 라인이 2건이면 PP 연결번호가 각각 발급되는지(설계서 T5 검증 포인트)",
        expect="성공 · PP 2건 + TP 1건 + AP 1건 = 연결번호 4개 · F_PRPAYM 2행",
        lines=[
            ("D", "11102301", 300000, "원부재료 선급(거래처1)", {"BP": BP_PP}, None),
            ("D", "11102301", 200000, "원부재료 선급(거래처2)", {"BP": BP_PP2}, None),
            ("D", "11103301", 50000, "매입 부가세", vat_ctrls(cv, 500000, 50000, BP_PP), None),
            ("C", "21100901", 550000, "미지급금(거래처)", {"BP": BP_AP, **due}, None),
        ]))
    C.append(dict(
        sfx="P6", kind="정상", cost=COST_INDIRECT,
        title="T6 매출(AR + TR)",
        why="채권·매출부가세는 한 번도 투입해 본 적이 없다. AX 범위 확인도 겸한다",
        expect="성공 · AR 1건 + TR 1건 연결번호 · A_VAT 에 **매출분** 1행",
        lines=[
            ("D", "11101701", 1100000, "폐자재 매각 미수", {"BP": BP_AR}, None),
            ("C", "54001905", 1000000, "잡이익(기타)", {}, None),
            ("C", "21102301", 100000, "매출 부가세",
             vat_ctrls(cv, 1000000, 100000, BP_AR, sales=True), None),
        ]))
    C.append(dict(
        sfx="P7", kind="정상", cost=COST_INDIRECT,
        title="T7 선수금(PR)",
        why="선수금 원장(F_PRRCPT) 생성 경로 미검증",
        expect="성공 · AR 1건 + PR 1건 연결번호 · F_PRRCPT 1행",
        lines=[
            ("D", "11101701", 2000000, "계약 선수 청구분 미수", {"BP": BP_AR}, None),
            ("C", "21101902", 2000000, "선수금(기타)", {"BP": BP_PR}, None),
        ]))
    C.append(dict(
        sfx="P9", kind="정상", cost=COST_INDIRECT,
        title="T9 다중 라인(25줄) — 성능",
        why="라인마다 채번 SP 를 부른다. 31줄 이상이 DEMO2 에 128전표 있는데 미검증",
        expect="성공 · 타임아웃 없이 25줄 대조 일치 · 소요시간 기록",
        lines=[("D", "53013501", 10000, f"소모품비 {i+1:02d}", {}, None) for i in range(24)]
              + [("C", "21100901", 240000, "미지급금(거래처)", {"BP": BP_AP, **due}, None)]))
    C.append(dict(
        sfx="PD", kind="정상", cost=COST_DIRECT,
        title="직접 코스트센터(DI_FG='D') — EVENT_CD 'DZ' 경로",
        why="C-15 규칙에서 서브원장 무관 계정은 코스트센터 직간접으로 IZ/DZ 가 갈리는데, "
            "지금까지 테스트는 전부 간접(C013200·IZ)이었다. **DZ 는 한 번도 안 타 봤다**",
        expect="성공 · 비용 라인 EVENT_CD 가 **DZ** 로 결정(로그 [분개코드] 확인)",
        lines=[
            ("D", "43000501", 300000, "제)복리후생비(식대)", {"PC": PC}, None),
            ("D", "11103301", 30000, "매입 부가세", vat_ctrls(cv, 300000, 30000, BP_AP), None),
            ("C", "21100901", 330000, "미지급금(거래처)", {"BP": BP_AP, **due}, None),
        ]))

    # ═══ 오류 케이스 — 차단돼야 정상 ═══════════════════════════
    C.append(dict(
        sfx="E1", kind="오류", cost=COST_INDIRECT,
        title="채무(AP) 차변 반제",
        why="결의전표로 채무를 반제하면 채무원장 잔액이 정리되지 않는다",
        expect="차단 G5 · ERP 도 119712 로 막는다 — 릴레이가 먼저 잡아 사유를 남긴다",
        lines=[
            ("D", "21100901", 500000, "미지급금 반제(오류)", {"BP": BP_AP, **due}, None),
            ("C", "53014307", 500000, "판)지급수수료", {}, None),
        ]))
    C.append(dict(
        sfx="E2", kind="오류", cost=COST_INDIRECT,
        title="채권(AR) 대변 반제",
        why="채권 회수는 채권반제 전용화면 소관",
        expect="차단 G5",
        lines=[
            ("D", "53014307", 500000, "판)지급수수료", {}, None),
            ("C", "11101701", 500000, "미수금 반제(오류)", {"BP": BP_AR}, None),
        ]))
    C.append(dict(
        sfx="E3", kind="오류", cost=COST_INDIRECT,
        title="선급금(PP) 대변 반제",
        why="선급금 정산은 전용화면 소관",
        expect="차단 G5",
        lines=[
            ("D", "53014307", 500000, "판)지급수수료", {}, None),
            ("C", "11102301", 500000, "선급금 정산(오류)", {"BP": BP_PP}, None),
        ]))
    C.append(dict(
        sfx="E4", kind="오류", cost=COST_INDIRECT,
        title="선수금(PR) 차변 반제",
        why="선수금 상계는 전용화면 소관",
        expect="차단 G5",
        lines=[
            ("D", "21101902", 500000, "선수금 상계(오류)", {"BP": BP_PR}, None),
            ("C", "54001905", 500000, "잡이익(기타)", {}, None),
        ]))
    C.append(dict(
        sfx="E5", kind="오류", cost=COST_INDIRECT,
        title="매입부가세(TP) 대변",
        why="**ERP 가 막지 않는 구간**이다(usp_a_check_acct 에 TP/TR 블록 없음). "
            "DEMO2 수동입력분에 위반 7라인이 실재하고 그 건들은 A_VAT 가 비어 있다",
        expect="차단 G1 — AX 가 대신 막는다",
        lines=[
            ("D", "53014307", 500000, "판)지급수수료", {}, None),
            ("C", "11103301", 500000, "부가세대급금 대변(오류)", {}, None),
        ]))
    C.append(dict(
        sfx="E6", kind="오류", cost=COST_INDIRECT,
        title="매출부가세(TR) 차변",
        why="G1 의 반대쪽. 역시 ERP 미검증 구간",
        expect="차단 G1",
        lines=[
            ("D", "21102301", 500000, "부가세예수금 차변(오류)", {}, None),
            ("C", "54001905", 500000, "잡이익(기타)", {}, None),
        ]))
    C.append(dict(
        sfx="E7", kind="오류", cost=COST_INDIRECT,
        title="라인 차대 불균형 (헤더 합계는 일치)",
        why="ERP 의 113119 차대검증은 GL_INPUT_TYPE='GL' 한정이라 **결의전표는 대상 밖**이다. "
            "헤더 합계만 보면 맞아 보이므로 라인에서 재계산해야 잡힌다",
        expect="차단 G2 · 차변 500,000 / 대변 450,000 (차이 50,000)",
        # 헤더 합계를 일부러 라인과 다르게 박는다 — '포털 데이터 손상' 상황 재현
        totals=(500000, 500000),
        lines=[
            ("D", "53014307", 500000, "판)지급수수료", {}, None),
            ("C", "21100901", 450000, "미지급금(라인 불일치)", {"BP": BP_AP, **due}, None),
        ]))
    C.append(dict(
        sfx="E8", kind="오류", cost=COST_INDIRECT,
        title="법인카드 미지급금 대변 (이중계상)",
        why="법인카드는 카드 전용 채널이 따로 전표를 만든다. AX 가 또 만들면 이중계상",
        expect="차단 · FORBIDDEN_CR_ACCT (분개코드 결정 이전 단계)",
        lines=[
            ("D", "53014307", 500000, "판)지급수수료", {}, None),
            ("C", "21100907", 500000, "미지급금(법인카드)(오류)", {}, None),
        ]))
    return C


# ── 포털 적재(PostgREST) ─────────────────────────────────────────
def rest(url, key, method, path, body=None, params=""):
    req = urllib.request.Request(
        f"{url}/rest/v1/{path}{params}",
        data=(json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None),
        method=method,
        headers={"apikey": key, "Authorization": f"Bearer {key}",
                 "Content-Type": "application/json",
                 # 조회는 본문이 필요하고 쓰기는 필요 없다 — 응답을 키우지 않는다
                 "Prefer": "return=representation" if method == "GET" else "return=minimal"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode("utf-8")
            return json.loads(raw) if raw.strip() else []
    except urllib.error.HTTPError as e:
        raise SystemExit(f"[중단] {method} {path} → HTTP {e.code}: "
                         f"{e.read().decode('utf-8','replace')[:400]}")


def draft_no(sfx: str) -> str:
    return f"DRAFT-TEST-{sfx}-0001"


def totals_of(case):
    if case.get("totals"):
        return case["totals"]
    dr = sum(l[2] for l in case["lines"] if l[0] == "D")
    cr = sum(l[2] for l in case["lines"] if l[0] == "C")
    return dr, cr


def print_plan(cases):
    print(f"\n{'═'*78}\n 테스트 전표 설계 — {BATCH}\n{'═'*78}")
    for grp, label in (("정상", "정상 케이스 (통과해야 정상)"), ("오류", "오류 케이스 (차단돼야 정상)")):
        sel = [c for c in cases if c["kind"] == grp]
        print(f"\n■ {label} — {len(sel)}건")
        for c in sel:
            dr, cr = totals_of(c)
            print(f"\n  [{c['sfx']}] {c['title']}   {draft_no(c['sfx'])}")
            print(f"      왜   : {c['why']}")
            print(f"      기대 : {c['expect']}")
            if c.get("totals"):
                ldr = sum(l[2] for l in c['lines'] if l[0] == 'D')
                lcr = sum(l[2] for l in c['lines'] if l[0] == 'C')
                print(f"      합계 : 헤더 {dr:,}/{cr:,}  ↔  라인 {ldr:,}/{lcr:,}  ← 일부러 불일치")
            else:
                print(f"      합계 : {dr:,} · 라인 {len(c['lines'])}줄 · 코스트센터 {c['cost']}")
            shown = c["lines"] if len(c["lines"]) <= 6 else c["lines"][:3] + [("…",)] + c["lines"][-2:]
            for l in shown:
                if l[0] == "…":
                    print(f"        … ({len(c['lines'])-5}줄 생략)")
                    continue
                fg, acct, amt, desc, ctrls, _ = l
                cs = " ".join(f"{k}={mask(v)}" for k, v in ctrls.items()) if ctrls else ""
                print(f"        {'차' if fg=='D' else '대'}) {acct} {amt:>10,}  {desc:<24} {cs}")
    print(f"\n{'─'*78}")
    print(f" 총 {len(cases)}건 · 적재 상태는 '제출됨' 까지 — **전송은 사람이 화면에서 누른다**")
    print(f"{'─'*78}\n")


def load(cases, url, key):
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    heads, items, ctrls = [], [], []
    for c in cases:
        no = draft_no(c["sfx"])
        dr, cr = totals_of(c)
        heads.append({
            "draft_no": no, "draft_dt": DRAFT_DT, "gl_type": "03",
            "dept_cd": DEPT_CD, "dept_nm": DEPT_NM, "cost_cd": c["cost"],
            "gl_desc": f"ax테스트_{c['sfx']} {c['title']}",
            "ref_no": BATCH,
            "owner_upn": OWNER_UPN, "owner_erp_usr_id": OWNER_UPN, "owner_nm": OWNER_NM,
            "dr_total": dr, "cr_total": cr, "status": "submitted",
            # PostgREST 는 JSON 본문의 'now()' 를 함수로 해석하지 않는다 — ISO 문자열로 넣는다
            "submitted_at": now_iso,
        })
        for i, (fg, acct, amt, desc, cc, cost) in enumerate(c["lines"], start=1):
            items.append({"draft_no": no, "item_seq": i, "dr_cr_fg": fg, "acct_cd": acct,
                          "item_amt": amt, "item_desc": f"ax테스트_{c['sfx']} {desc}",
                          "cost_cd": cost or c["cost"]})
            for cd, val in (cc or {}).items():
                ctrls.append({"draft_no": no, "item_seq": i, "ctrl_cd": cd, "ctrl_val": val})

    # 재적재를 위해 기존 동일 번호를 먼저 지운다(적용 완료분은 건드리지 않는다)
    nos = [h["draft_no"] for h in heads]
    existing = rest(url, key, "GET", "gl_draft",
                    params="?select=draft_no,erp_apply_status&draft_no=in.("
                           + ",".join(nos) + ")")
    locked = [e["draft_no"] for e in existing if e.get("erp_apply_status") == "applied"]
    if locked:
        raise SystemExit(f"[중단] 이미 ERP 에 적용된 초안이 있습니다({len(locked)}건): "
                         f"{', '.join(locked)} — 덮어쓰지 않습니다. --purge 로 정리하거나 "
                         "케이스 접미사를 바꾸세요.")
    if existing:
        rest(url, key, "DELETE", "gl_draft",
             params="?draft_no=in.(" + ",".join(e["draft_no"] for e in existing) + ")")
        print(f"[정리] 기존 동일 번호 {len(existing)}건 삭제(라인·관리항목 연쇄 삭제)")

    rest(url, key, "POST", "gl_draft", heads)
    rest(url, key, "POST", "gl_draft_item", items)
    if ctrls:
        rest(url, key, "POST", "gl_draft_item_ctrl", ctrls)
    print(f"[적재 완료] 초안 {len(heads)}건 · 라인 {len(items)}줄 · 관리항목 {len(ctrls)}건")
    print("           상태: 제출됨(submitted) — 화면 [ERP 전송] 탭에서 선택해 보내세요.")


def purge(url, key):
    rows = rest(url, key, "GET", "gl_draft",
                params="?select=draft_no,erp_apply_status,status&ref_no=eq."
                       + urllib.parse.quote(BATCH))
    if not rows:
        print("삭제할 배치 초안이 없습니다.")
        return
    keep = [r["draft_no"] for r in rows if r.get("erp_apply_status") == "applied"]
    kill = [r["draft_no"] for r in rows if r.get("erp_apply_status") != "applied"]
    if kill:
        rest(url, key, "DELETE", "gl_draft", params="?draft_no=in.(" + ",".join(kill) + ")")
    print(f"[삭제] {len(kill)}건" + (f" · [보존] ERP 적용된 {len(keep)}건은 남깁니다" if keep else ""))


def main():
    ap = argparse.ArgumentParser(description="ERP 연동 테스트용 결의전표 초안 적재")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--plan", action="store_true", help="설계만 출력(적재하지 않음)")
    g.add_argument("--load", action="store_true", help="포털에 적재(제출됨 상태)")
    g.add_argument("--purge", action="store_true", help="이 배치 초안 삭제(적용된 건 제외)")
    a = ap.parse_args()
    load_env()
    url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

    if a.purge:
        return purge(url, key)

    conn = R.demo_conn()
    try:
        cv = resolve_ctrl_values(conn.cursor())
    finally:
        conn.close()
    print("[관리항목 해석] " + " · ".join(f"{a_}/{c}={mask(v)}" for (a_, c), v in cv.items()))

    cases = build_cases(cv)
    print_plan(cases)
    if a.load:
        load(cases, url, key)
    return 0


if __name__ == "__main__":
    sys.exit(main())
