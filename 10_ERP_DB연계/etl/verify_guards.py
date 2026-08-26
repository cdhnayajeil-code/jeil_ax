# -*- coding: utf-8 -*-
r"""verify_guards.py — 실제 승인 전표 전량에 AX 가드를 돌려 로직을 재검증한다(읽기 전용).

무엇을 답하나
  「AX 가드가 **정상 업무를 막지는 않는가.**」

  가드는 잘못된 전표를 막으려고 넣었다. 그런데 기준이 과하면 사람이 매일 만들던
  정상 전표까지 막는다. 그건 테스트 전표 몇 건으로는 알 수 없다 —
  **ERP 에 이미 승인돼 있는 실제 수기 전표에 그대로 돌려 봐야** 안다.

  회계가 승인한 전표 = '정상'의 정의다. 거기서 가드가 걸리면
    · 정말 AX 로는 만들면 안 되는 유형이거나(기능 경계),
    · 가드가 과한 것이다(수정 대상).
  둘을 사유별로 갈라 보여준다.

읽기 전용
  전표를 만들지 않는다. `guard_lines()` 와 분개코드 해석만 호출하고,
  ERP 에는 SELECT 만 나간다.

사용
    python 10_ERP_DB연계/etl/verify_guards.py                 최근 승인 전표 2000건
    python 10_ERP_DB연계/etl/verify_guards.py --limit 500
    python 10_ERP_DB연계/etl/verify_guards.py --show G6       그 사유의 실제 사례 보기
"""
import argparse
import os
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _env import load_env  # noqa: E402
import gl_apply_demo2 as R  # noqa: E402


def load_slips(cur, limit):
    """승인된 수기 전표(TG)를 헤더·라인·관리항목까지 한 번에 읽는다."""
    cur.execute("""
        SELECT TOP (?) t.TEMP_GL_NO, RTRIM(ISNULL(t.DEPT_CD,'')), RTRIM(ISNULL(t.COST_CD,'')),
               CONVERT(varchar(10), t.TEMP_GL_DT, 120)
          FROM dbo.A_TEMP_GL t WITH (NOLOCK)
         WHERE t.TEMP_GL_NO LIKE 'TG%' AND RTRIM(ISNULL(t.CONF_FG,'')) = 'C'
         ORDER BY t.TEMP_GL_DT DESC, t.TEMP_GL_NO DESC""", limit)
    hdr = {r[0]: (r[1], r[2], r[3]) for r in cur.fetchall()}
    nos = list(hdr)

    items, ctrls = defaultdict(list), defaultdict(dict)
    CH = 300
    for i in range(0, len(nos), CH):
        part = nos[i:i + CH]
        q = ",".join("?" * len(part))
        cur.execute(f"""
            SELECT i.TEMP_GL_NO, i.ITEM_SEQ, RTRIM(i.DR_CR_FG), RTRIM(i.ACCT_CD),
                   -- 차대 균형은 **원화(LOC)** 로 본다. 외화 전표의 ITEM_AMT 는 외화 금액이라
                   -- 그대로 더하면 41억 대 326만 같은 허수 차이가 난다(2026-08-26 실측 버그).
                   -- 포털은 KRW 만 다루므로 릴레이 G2 는 이 문제가 없다 — 여기만 맞추면 된다.
                   ISNULL(i.ITEM_LOC_AMT, i.ITEM_AMT) AS amt_loc,
                   RTRIM(ISNULL(i.COST_CD,'')), RTRIM(ISNULL(i.DOC_CUR,''))
              FROM dbo.A_TEMP_GL_ITEM i WITH (NOLOCK)
             WHERE i.TEMP_GL_NO IN ({q}) ORDER BY i.TEMP_GL_NO, i.ITEM_SEQ""", *part)
        for r in cur.fetchall():
            items[r[0]].append(tuple(r[1:]))
        cur.execute(f"""
            SELECT TEMP_GL_NO, ITEM_SEQ, RTRIM(CTRL_CD), RTRIM(ISNULL(CTRL_VAL,''))
              FROM dbo.A_TEMP_GL_DTL WITH (NOLOCK)
             WHERE TEMP_GL_NO IN ({q}) AND RTRIM(ISNULL(CTRL_VAL,'')) <> ''""", *part)
        for no, seq, cd, val in cur.fetchall():
            ctrls[(no, int(seq))][cd] = val
    return hdr, items, ctrls


def main():
    ap = argparse.ArgumentParser(description="실제 승인 전표에 AX 가드 전량 재검증(읽기 전용)")
    ap.add_argument("--limit", type=int, default=2000, help="검사할 전표 수(최근 승인분)")
    ap.add_argument("--show", help="이 사유의 실제 사례를 보여준다(G1·G2·G5·G6·부서·금지계정·분개코드·마이너스·외화)")
    ap.add_argument("--trans-type", default=R.TRANS_TYPE_DEFAULT)
    a = ap.parse_args()
    load_env()
    conn = R.demo_conn()
    cur = conn.cursor()

    print(f"\n{'═'*78}\n 가드 재검증 — 실제 승인 전표에 그대로 돌린다\n{'═'*78}")
    hdr, items, ctrls = load_slips(cur, a.limit)
    print(f" 대상 {len(hdr)}전표 · {sum(len(v) for v in items.values())}라인 (승인 완료 · 수기)\n")

    # 부서 ↔ 현행 조직 판정은 부서마다 한 번만
    dept_ok, dept_why = {}, {}
    def check_dept(d):
        if d not in dept_ok:
            try:
                R.check_dept_org(cur, d); dept_ok[d] = True
            except SystemExit as e:
                dept_ok[d] = False; dept_why[d] = str(e).split("\n")[0]
        return dept_ok[d]

    tally = Counter()
    samples = defaultdict(list)
    passed = 0
    only_dept = 0   # '부서' 하나 때문에 막힌 건 — DEMO2 시점 문제라 운영에서는 통과한다

    for no, (dept, cost, dt) in hdr.items():
        ls = items.get(no) or []
        if not ls:
            continue
        reasons = []

        # ── 포털이 애초에 담을 수 없는 형태 ──
        if any(int(x[3]) <= 0 for x in ls):
            reasons.append(("마이너스", "음수·0원 라인 — 포털이 저장할 수 없다"))
        if any(x[5] and x[5] != "KRW" for x in ls):
            reasons.append(("외화", f"통화 {sorted({x[5] for x in ls if x[5] and x[5]!='KRW'})} — 포털에 통화 필드가 없다"))
        if not dept:
            reasons.append(("부서", "헤더 부서 없음"))
        elif not check_dept(dept):
            reasons.append(("부서", dept_why.get(dept, "현행 조직에 없는 부서")))

        # ── 분개코드 해석 + 가드 ──
        lines = []
        blocked_jnl = None
        for seq, fg, acct, amt, lcc, cur_cd in ls:
            fg2 = "DR" if fg.startswith("D") else "CR"
            if fg2 == "CR" and acct in R.FORBIDDEN_CR_ACCT:
                reasons.append(("금지계정", f"{seq}번 줄 {acct} 대변 — 법인카드 채널과 이중계상"))
            jnl = R.resolve_jnl(cur, a.trans_type, acct, fg2, lcc or cost)
            if not jnl:
                blocked_jnl = f"{seq}번 줄 {acct}"
                break
            lines.append({"seq": int(seq), "acct": acct, "fg": fg2, "amt": int(amt),
                          "cost": lcc or cost,
                          "ctrls": list((ctrls.get((no, int(seq))) or {}).items())})
        if blocked_jnl:
            reasons.append(("분개코드", f"{blocked_jnl} — 거래항목을 정할 수 없다"))
        elif lines:
            for b in R.guard_lines(cur, lines):
                reasons.append((b["code"], f"{b['seq']}번 줄 {b.get('nm') or b['acct']} — {b['what']}"))

        if reasons:
            # 사유는 **전표 기준**으로 센다 — 한 전표에 같은 사유가 여러 줄 걸려도 1건이다.
            # (라인 기준으로 세면 합계가 100%를 넘어 규모를 오해하게 된다)
            codes = {c for c, _ in reasons}
            if codes == {"부서"}:
                only_dept += 1
            for code in codes:
                tally[code] += 1
            for code, why in reasons:
                if len(samples[code]) < 5:
                    samples[code].append(f"{no} ({dt}) — {why}")
        else:
            passed += 1

    conn.close()
    total = len(hdr)
    blocked = total - passed
    dts = sorted(v[2] for v in hdr.values() if v[2])
    if dts:
        print(f" 전표 일자 범위: {dts[0]} ~ {dts[-1]}\n")
    print(f" 통과 {passed} / {total}  ({passed*100//max(total,1)}%)   차단 {blocked}")
    # '부서' 는 DEMO2 가 전표보다 나중 조직을 갖고 있어서 생기는 시점 차이다.
    # 운영에서 오늘 만드는 전표는 현행 부서를 쓰므로 이 사유가 붙지 않는다
    # (실측: 운영 미러에서 폐지 부서를 헤더로 쓴 마지막 전표가 2026-03-31, 개편 이후 0건).
    if only_dept:
        print(f" └ 그중 '부서' 하나 때문만: {only_dept}건 — 조직 시점 차이라 운영에서는 통과한다")
        print(f"   → 그 몫을 빼면 통과 {passed + only_dept} / {total}"
              f"  ({(passed+only_dept)*100//max(total,1)}%)")
    print()
    LABEL = {"G1": "G1 부가세 차대", "G2": "G2 차대 균형", "G5": "G5 반제 방향",
             "G6": "G6 필수 관리항목", "부서": "부서 ↔ 현행 조직",
             "금지계정": "금지계정(법인카드)", "분개코드": "거래항목 미결정",
             "마이너스": "음수 라인(포털 제약)", "외화": "외화(포털 제약)"}
    if tally:
        print(" 차단 사유 (전표 기준, 한 전표에 여러 사유 가능)")
        for code, n in tally.most_common():
            print(f"   {LABEL.get(code, code):<22} {n:>5}건  {n*100/max(total,1):>5.1f}%")
    # 사례는 한 번의 스캔으로 전 사유를 보여준다 — 사유마다 다시 훑지 않게
    for code, _ in tally.most_common():
        n = 5 if a.show == code else 2
        print(f"\n ── {LABEL.get(code, code)} 사례 ──")
        for ex in (samples.get(code) or [])[:n]:
            print(f"   {ex}")
    for code in ("G6", "G1"):
        if code not in tally:
            print(f"\n ── {LABEL[code]} ── 차단 0건 (정상 업무를 막지 않는다)")
    print(f"\n{'─'*78}")
    print(" 읽기 전용 — 전표를 만들지 않았습니다.")
    print(f"{'─'*78}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
