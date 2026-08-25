# -*- coding: utf-8 -*-
r"""gl_apply_demo2.py — 포털 결의전표 초안 → ERP 데모DB(JEILMNS_DEMO2) 직접 투입 (1차 테스트)

결정 C-11(2026-08-19 관리자 지시): AI(포털) 생성 전표의 ERP 직접 투입을 **데모 DB 한정**으로 1차 테스트.
운영(JEILMNS) 쓰기는 여전히 금지(C-1 유지) — 이 스크립트는 운영에 절대 닿지 않도록 3중 가드를 건다.

레시피 근거(리허설 검증 완료, 2026-08-19):
  회계/260819_AX_결의전표_ERP연동_기회검토/test_demo2/ — 03_매핑표.md · 08_insert_ag_2건.sql
  · A_BATCH + A_BATCH_GL + A_BATCH_GL_ITEM 투입 → 표준 엔진 usp_a_create_gl_by_batch_01 호출 → 전표 생성
  · 전표번호는 **호출자가 사전 채번**(엔진이 만들지 않음) — AX 전용 접두어 'AG'(usp_a_tempgl_no_auto_gen)
  · 관리항목 슬롯 순서는 엔진이 재배치(코드만 정확하면 됨) · 라인은 엔진이 재정렬(계정+차대로 대조)

안전장치(테스트 킷 계승):
  1) 대상 DB 하드코딩(TARGET_DB) — CLI로 변경 불가
  2) 접속 직후 SELECT DB_NAME() 재확인 — 불일치 시 즉시 중단
  3) 단일 트랜잭션 — 검증(라인 대조) 실패 시 ROLLBACK, --dry-run 은 항상 ROLLBACK
  4) 멱등 — REF_NO(=draft_no) 선조회(A_BATCH·A_TEMP_GL) + 포털 적용 원장(gl_erp_apply_log) 이중 차단
  5) 1회 1건 — --draft 필수(기회검토 Do-Not 13: PoC 다건 일괄 투입 금지)

사용(이 폴더 기준):
  python gl_apply_demo2.py --list                        적용 대상(제출됨·미적용) 목록
  python gl_apply_demo2.py --draft DRAFT-... --dry-run   리허설(전 과정 실행 후 ROLLBACK)
  python gl_apply_demo2.py --draft DRAFT-...             확정 투입(COMMIT + 포털 회기입·확정)
  python gl_apply_demo2.py --draft DRAFT-... --cleanup   DEMO2에서 해당 건 삭제(정리) + 포털 상태 해제
  python gl_apply_demo2.py --queue                       화면 [ERP 전송] 대기(ready) 건 일괄 처리(1건씩 순차)
  python gl_apply_demo2.py --watch                       감시 모드 — 15초마다 대기 건 확인·처리(Ctrl+C 종료)

전송 흐름(v1.2): 회계 담당자가 화면 [ERP 전송] 탭에서 [🚀 ERP 전송] 클릭 → erp_apply_status='ready' 마킹
  → 이 스크립트(--queue/--watch, 사내 pull 중계)가 투입 → 결과 회기입 → 화면 자동 반영.
  성공 시 포털이 초안을 '확정됨(posted)'으로 닫고 ERP가 채번한 전표번호를 전표번호란에 기록한다
  (gl_apply_record v3 — 화면에 수기 번호 입력칸이 없다). --cleanup 은 이 확정까지 되돌린다.
"""
import argparse
import datetime
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request

from _env import load_env, need

# ═══════════ 고정 상수 — 변경 금지 ═══════════
TARGET_DB = "JEILMNS_DEMO2"          # 대상 DB 하드코딩. 운영(JEILMNS) 금지 — CLI 파라미터 없음
AG_TYPE = "AG"                        # AX 전용 전표번호 접두어(B_AUTO_NUMBERING 기존 유형 재사용)
BT_TYPE = "BT"                        # 배치번호 접두어
# AX 전용 거래유형 — 관리자가 ERP에 등록(2026-08-20, biz_admin): AX001 'AX자동전표',
#   GL_POSTING_FG='T'(결의전표 귀결) · BATCH_FG='A'. 채널 식별·킬스위치(1행 비활성화) 목적.
#   구 기본값 S0003(경비)은 차변이 무역·수입 수수료 중심 32계정뿐이라 일반 경비를 담지 못했다.
TRANS_TYPE_DEFAULT = "AX001"
VAT_ACCT = "11103301"                 # 부가세대급금 — 헤더 VAT 금액 산출 기준
# 코드형 JNL_CD 폴백 — '계정코드 자기참조'가 분개코드 마스터에 없는 계정에만 쓴다(실측 확인).
#   11103301·21100901 은 A_JNL_ITEM 에 자기참조 코드가 없고, 기존 거래유형이 쓰는 코드형이 정답이다.
JNL_FALLBACK = {
    "11103301": ("A", "A"),           # 부가세대급금 — 일반세금계산서(S0003·AN005 공통)
    "21100901": ("AP", ""),           # 미지급금(거래처) — S0003 실증
    "21100105": ("NP", ""),           # 지급어음
    "11100101": ("CS", ""),           # 현금
    "11100105": ("DP", ""),           # 보통예금
    "11102301": ("PP", ""),           # 선급금-원부재료
    "21100907": ("AP2", "CARDC"),     # 미지급금(법인카드) — 카드 채널 전용. AX 사용 금지(§이중계상)
}
# 법인카드 채널과의 이중계상 방지 — AX 채널은 이 대변 계정을 쓰지 않는다(기회검토 Do-Not 9)
FORBIDDEN_CR_ACCT = {"21100907"}


def rpc(url, key, fn, payload):
    """Supabase RPC 호출(etl_run.py 와 동일 방식)."""
    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    req = urllib.request.Request(
        f"{url}/rest/v1/rpc/{fn}", data=body, method="POST",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode().strip()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace").strip()
        except Exception:
            pass
        raise RuntimeError(f"HTTP {e.code} rpc/{fn}: {detail[:600]}") from e


def demo_conn():
    """ERP 접속 문자열의 DATABASE 를 TARGET_DB 로 치환해 연결. 접속 후 DB명 재확인(가드 2)."""
    import pyodbc
    from _erp_conn import erp_conn_str
    cs = erp_conn_str()
    if re.search(r"(?i)(DATABASE|Initial Catalog)\s*=", cs):
        cs = re.sub(r"(?i)(DATABASE|Initial Catalog)\s*=\s*[^;]*", rf"\1={TARGET_DB}", cs)
    else:
        cs = cs.rstrip(";") + f";DATABASE={TARGET_DB}"
    conn = pyodbc.connect(cs, timeout=30)
    conn.autocommit = False
    cur = conn.cursor()
    cur.execute("SELECT DB_NAME()")
    dbname = cur.fetchone()[0]
    if dbname != TARGET_DB:
        conn.close()
        raise SystemExit(f"[중단] 접속된 DB가 {TARGET_DB} 가 아닙니다(실제: {dbname}). 아무것도 실행하지 않았습니다.")
    print(f"[가드 통과] DB={dbname}")
    return conn


def first_resultset(cur):
    """SP 가 중간 결과셋·카운트를 흘려도 컬럼 있는 첫 결과셋의 첫 행을 찾는다."""
    while cur.description is None:
        if not cur.nextset():
            return None
    return cur.fetchone()


def autogen(cur, no_type, date_str, user_id):
    """ERP 표준 채번기 호출 — 출력 파라미터를 SELECT 로 회수."""
    cur.execute(
        "SET NOCOUNT ON; DECLARE @no nvarchar(30); "
        "EXEC dbo.usp_a_tempgl_no_auto_gen ?, ?, ?, @no OUTPUT; SELECT @no;",
        no_type, date_str, user_id)
    row = first_resultset(cur)
    no = row[0] if row else None
    if not no:
        raise RuntimeError(f"채번 실패({no_type})")
    return no


def fetch_draft(url, key, draft_no):
    d = rpc(url, key, "gl_apply_fetch", {"p_draft_no": draft_no})
    if not d or not d.get("header"):
        raise SystemExit(f"[중단] 포털에서 초안 {draft_no} 을(를) 찾지 못했습니다.")
    return d


def jnl_exists(cur, jnl_cd):
    """분개코드 마스터(A_JNL_ITEM) 존재 확인 — A_BATCH_GL_ITEM.JNL_CD 의 FK 위반을 사전 차단."""
    if not jnl_cd:
        return False
    cur.execute("SELECT COUNT(*) FROM dbo.A_JNL_ITEM WITH (NOLOCK) WHERE RTRIM(JNL_CD) = ?", jnl_cd)
    return cur.fetchone()[0] > 0


def cost_di_fg(cur, cost_cd):
    """코스트센터 직간접 구분 — EVENT_CD(간접 IZ / 직접 DZ) 산출 근거. AN005 규칙 계승."""
    if not cost_cd:
        return ""
    cur.execute("SELECT TOP 1 RTRIM(ISNULL(DI_FG,'')) FROM dbo.B_COST_CENTER WITH (NOLOCK) "
                "WHERE RTRIM(COST_CD) = ?", cost_cd)
    r = cur.fetchone()
    return (str(r[0]).strip().upper() if r else "")


def resolve_jnl(cur, trans_type, acct_cd, dr_cr, cost_cd):
    """분개코드(JNL_CD)·이벤트코드(EVENT_CD) 결정 — 3단계. 반환: (jnl, event, 출처) 또는 None.

       ① 거래유형×계정 매핑(A_JNL_ACCT_ASSN) — 등재돼 있으면 ERP 정의가 정답이다.
          AX001 에 매핑을 등록하면 이 경로로 자동 전환되고 아래 규칙은 쓰이지 않는다.
       ② 계정코드 자기참조(AN005 실사용 패턴) — 경비 계정은 분개코드 마스터에 계정코드와 같은
          JNL_CD 가 등재돼 있다(실측: 43000501·53010701·53014307 등). EVENT_CD 는 코스트센터
          직간접 구분으로 산출(I→IZ, D→DZ) — AN005 가 쓰는 것과 같은 규칙.
       ③ 코드형 폴백 — 자기참조가 없는 계정(부가세대급금·미지급금 등)은 기존 거래유형이 쓰는 코드형.

       어느 경로든 **분개코드 마스터에 실재하는 코드만** 반환한다. 없으면 None(fail-closed) —
       임의 코드를 만들어 넣지 않는다."""
    # ① 마스터 매핑
    try:
        cur.execute(
            "SELECT TOP 1 RTRIM(JNL_CD) FROM dbo.A_JNL_ACCT_ASSN WITH (NOLOCK) "
            "WHERE TRANS_TYPE = ? AND RTRIM(ACCT_CD) = ? AND RTRIM(ISNULL(DR_CR_FG,'')) = ? ORDER BY SEQ",
            trans_type, acct_cd, dr_cr)
        row = cur.fetchone()
        if not row:  # 차대 불문 재시도(설정에 차대 미구분 행이 있을 수 있음)
            cur.execute(
                "SELECT TOP 1 RTRIM(JNL_CD) FROM dbo.A_JNL_ACCT_ASSN WITH (NOLOCK) "
                "WHERE TRANS_TYPE = ? AND RTRIM(ACCT_CD) = ? ORDER BY SEQ", trans_type, acct_cd)
            row = cur.fetchone()
        if row and row[0]:
            jnl = str(row[0]).strip()
            cur.execute(
                "SELECT TOP 1 RTRIM(ISNULL(EVENT_CD,'')) FROM dbo.A_JNL_FORM WITH (NOLOCK) "
                "WHERE TRANS_TYPE = ? AND RTRIM(JNL_CD) = ? ORDER BY SEQ", trans_type, jnl)
            erow = cur.fetchone()
            if jnl_exists(cur, jnl):
                return jnl, (str(erow[0]).strip() if erow else ""), "매핑"
    except Exception:
        pass  # 스키마 상이 등 — 아래 규칙으로

    # ② 계정코드 자기참조 + 코스트센터 직간접
    if jnl_exists(cur, acct_cd):
        di = cost_di_fg(cur, cost_cd)
        event = "IZ" if di == "I" else ("DZ" if di == "D" else "")
        return acct_cd, event, "자기참조"

    # ③ 코드형 폴백
    if acct_cd in JNL_FALLBACK:
        jnl, event = JNL_FALLBACK[acct_cd]
        if jnl_exists(cur, jnl):
            return jnl, event, "코드형"
    return None


def guard_lines(cur, lines):
    """투입 전 입력검증 — 차단 사유 목록을 돌려준다(빈 리스트면 통과).

    근거: `15_AX전표_입력검증_및_차단규칙`(ERP_DB 발신 2026-08-25).

    서브원장 SP(`usp_a_check_acct`)가 반제방향을 이미 막지만 **두 구멍이 남는다**.
      · G1 부가세(TP/TR): SP 에 전용 검증 블록이 없다. DEMO2 수동입력분에 위반 8라인이 실재한다
        (부가세대급금 CR 7건·부가세예수금 DR 1건 — 결산 상계 전표로 보이나 `A_VAT` 가 생성되지 않는다).
      · G2 차대 균형: `113119` 검증이 `GL_INPUT_TYPE='GL'` 한정이라 결의전표(TG)는 대상이 아니다.
    G5(반제방향 사전차단)는 ERP 도 막지만 릴레이 실행 중에야 알게 된다 — 여기서 먼저 잡아
    사유를 남기면 화면에 그대로 뜬다.
    """
    out = []

    # ── G2 차대 균형 — 라인에서 재계산한다 ──
    # 헤더(dr_total/cr_total) 비교는 위에서 이미 하지만 그건 포털이 저장해 둔 값끼리의 비교다.
    # 실제 투입 라인에서 다시 더해야 값이 어긋난 채 들어가는 것을 막는다.
    dr = sum(l["amt"] for l in lines if l["fg"] == "DR")
    cr = sum(l["amt"] for l in lines if l["fg"] == "CR")
    if dr != cr:
        out.append({"seq": 0, "acct": "-", "fg": "-", "code": "G2",
                    "why": f"차대 균형 불일치 — 차변 {dr:,} / 대변 {cr:,} (차이 {abs(dr-cr):,}). "
                           "ERP 는 결의전표의 차대를 검증하지 않는다"})

    # ── 계정 속성 조회(서브시스템·기본차대) ──
    accts = sorted({l["acct"] for l in lines})
    attr = {}
    for a in accts:
        cur.execute("SELECT RTRIM(ISNULL(SUBSYS_TYPE,'')), RTRIM(ISNULL(BAL_FG,'')), "
                    "RTRIM(ISNULL(ACCT_NM,'')) FROM dbo.A_ACCT WITH (NOLOCK) WHERE RTRIM(ACCT_CD)=?", a)
        r = cur.fetchone()
        attr[a] = (r[0], r[1][:2], r[2]) if r else ("", "", "")

    for l in lines:
        sub, bal, nm = attr.get(l["acct"], ("", "", ""))
        if not sub:
            continue                                  # 서브원장 대상 아님 — 제약 없음
        fg = l["fg"][:2]                              # 'DR' | 'CR'
        base = {"seq": l["seq"], "acct": l["acct"], "fg": fg}

        # ── G1 부가세 반제방향 — ERP 미검증 구간 ──
        if sub in ("TP", "TR"):
            want = "DR" if sub == "TP" else "CR"
            if fg != want:
                out.append({**base, "code": "G1",
                            "why": f"{nm}({sub})는 {want} 만 허용 — 반대 차대는 부가세 원장(A_VAT)이 "
                                   "생성되지 않는다. ERP 가 막지 않으므로 AX 가 차단한다"})
            continue

        # ── 미결(OC/OD) — 계정 기본차대와 같아야 한다 ──
        if sub in ("OC", "OD"):
            if bal and fg != bal:
                out.append({**base, "code": "G5",
                            "why": f"{nm}({sub}) 미결 반제 — 미결반제 전용화면에서 처리해야 한다"})
            continue

        # ── G5 그 외(AP·AR·PP·PR·SS) — A_OBJECT 매칭(ERP와 같은 판정) ──
        cur.execute("SELECT COUNT(*) FROM dbo.A_OBJECT WITH (NOLOCK) "
                    "WHERE RTRIM(GL_INPUT_TYPE)='TG' AND RTRIM(SUBSYS_TYPE)=? "
                    "  AND (RTRIM(DR_CR_FG)='DC' OR RTRIM(DR_CR_FG)=?)", sub, fg)
        if not cur.fetchone()[0]:
            kind = {"AP": "채무", "AR": "채권", "PP": "선급금", "PR": "선수금", "SS": "가수금"}.get(sub, sub)
            out.append({**base, "code": "G5",
                        "why": f"{nm}({sub}) {kind} 반제 방향 — 결의전표로 반제하면 원장 잔액이 "
                               f"정리되지 않는다. {kind} 반제 전용화면에서 처리해야 한다(ERP 오류 119712)"})
    return out


def org_info(cur, dept_cd):
    """조직 정보 — ORG_CHANGE_ID(부서 최신) + BIZ_AREA/INTERNAL/GAAP(최근 '정상' 배치 승계).
       실사(2026-08-19): 최근 배치가 AX 테스트 잔재일 수 있어 REF_NO 'AX%' 는 승계 소스에서 제외한다."""
    cur.execute("SELECT TOP 1 ORG_CHANGE_ID FROM dbo.B_ACCT_DEPT WITH (NOLOCK) "
                "WHERE DEPT_CD = ? ORDER BY ORG_CHANGE_ID DESC", dept_cd)
    row = cur.fetchone()
    org = row[0] if row else None
    cur.execute("SELECT TOP 1 BIZ_AREA_CD, INTERNAL_CD, GAAP_GROUP_CD FROM dbo.A_BATCH WITH (NOLOCK) "
                "WHERE TEMP_GL_NO IS NOT NULL AND ISNULL(REF_NO,'') NOT LIKE 'AX%' "
                "AND ISNULL(REF_NO,'') NOT LIKE 'DRAFT-%' ORDER BY INSRT_DT DESC")
    row = cur.fetchone()
    biz, internal, gaap = (row[0], row[1], row[2]) if row else (None, None, None)
    if not org or not biz:
        raise SystemExit(f"[중단] 조직정보 확보 실패(ORG_CHANGE_ID={org}, BIZ_AREA={biz}) — 부서코드를 확인하세요.")
    return org, biz, internal, gaap


def apply_draft(args):
    load_env()
    url = need("SUPABASE_URL").rstrip("/")
    key = need("SUPABASE_SERVICE_ROLE_KEY")

    d = fetch_draft(url, key, args.draft)
    h, items, ctrls = d["header"], d["items"], d["ctrls"]

    # ── 포털측 사전 검증 ─────────────────────────────────────────────
    # 적용 성공 시 포털이 초안을 '확정됨(posted)'으로 닫는다(gl_apply_record v3) →
    # 여기서 'submitted' 만 통과시키는 것이 곧 재투입 방지선이다. 정리(--cleanup)는 이 경로를 타지 않는다.
    if h.get("status") != "submitted":
        raise SystemExit(f"[중단] 초안 상태가 '제출됨'이 아닙니다(현재: {h.get('status')}). 제출된 초안만 투입합니다.")
    if not items or len(items) < 2:
        raise SystemExit("[중단] 라인이 2줄 미만입니다.")
    if int(h.get("dr_total") or 0) != int(h.get("cr_total") or 0):
        raise SystemExit("[중단] 차대 합계 불일치 — 포털 데이터가 손상됐습니다.")
    user_id = (h.get("owner_erp_usr_id") or "").strip()
    if not user_id:
        raise SystemExit("[중단] 등록자 ERP 계정이 비어 있습니다.")
    dept_cd = (h.get("dept_cd") or "").strip()
    cost_cd = (h.get("cost_cd") or "").strip()
    if not dept_cd:
        raise SystemExit("[중단] 부서코드가 비어 있습니다.")
    if not cost_cd:
        # 라인 코스트센터가 전부 있으면 허용, 아니면 중단(엔진 요건)
        if not all((it.get("cost_cd") or "").strip() for it in items):
            raise SystemExit("[중단] 코스트센터가 없습니다(헤더 또는 전 라인에 필요).")

    # 다른 러너가 이미 선점(sending)한 건은 건드리지 않는다 — 중복 투입 차단.
    # 큐 경로는 자기가 방금 선점하고 들어오므로, 단건 수동 실행만 여기서 걸린다.
    if h.get("erp_apply_status") == "sending" and not args.cleanup \
            and not getattr(args, "claimed", False):
        who = (h.get("erp_apply_msg") or "다른 러너")
        raise SystemExit(f"[중단] {args.draft} 은(는) 현재 전송 처리 중입니다({who}). "
                         "중복 투입을 막기 위해 실행하지 않습니다 — 끝나기를 기다리거나 "
                         "장시간 멈춰 있으면 --queue 가 30분 뒤 자동 회수합니다.")

    # 포털 원장 멱등 확인(commit 성공 이력)
    ready = rpc(url, key, "gl_apply_ready", {"p_target": TARGET_DB}) or []
    if args.draft not in [r["draft_no"] for r in ready] and not args.cleanup:
        # ready 목록에 없다 = 이미 성공 적용됐거나 제출 상태가 아님(위에서 검증) → 안전하게 중단
        raise SystemExit(f"[중단] {args.draft} 은(는) 적용 대상 목록에 없습니다(이미 적용됐을 수 있음). --list 로 확인하세요.")

    trans_type = args.trans_type
    gl_dt = str(h["draft_dt"])[:10]
    date_str = gl_dt.replace("-", "")
    gl_dt_dt = datetime.datetime.strptime(gl_dt, "%Y-%m-%d")   # 레거시 드라이버 date 바인딩 이슈 → datetime
    tot = int(h["dr_total"])
    vat = sum(int(it["item_amt"]) for it in items
              if str(it.get("acct_cd", "")).strip() == VAT_ACCT and str(it.get("dr_cr_fg")) == "D")
    ref_no = h["draft_no"]
    gl_desc = (h.get("gl_desc") or "")[:200]

    # 라인별 관리항목(롱폼) 인덱싱 — 슬롯 순서는 엔진이 재배치하므로 코드·값만 정확히
    ctrl_by_seq = {}
    for c in ctrls:
        ctrl_by_seq.setdefault(int(c["item_seq"]), []).append(
            (str(c["ctrl_cd"]).strip(), str(c["ctrl_val"]).strip()))

    conn = demo_conn()
    cur = conn.cursor()
    result = {"draft_no": args.draft, "target_db": TARGET_DB, "ref_no": ref_no,
              "trans_type": trans_type, "mode": "dryrun" if args.dry_run else "commit",
              "status": "failed", "applied_by": "gl_apply_demo2.py",
              "lines_in": len(items), "detail": {}}
    try:
        # ── 거래유형 확인(TG 귀결 여부) ────────────────────────────
        cur.execute("SELECT GL_POSTING_FG FROM dbo.A_ACCT_TRANS_TYPE WITH (NOLOCK) WHERE TRANS_TYPE = ?", trans_type)
        row = cur.fetchone()
        if not row or str(row[0]).strip() != "T":
            raise SystemExit(f"[중단] 거래유형 {trans_type} 의 GL_POSTING_FG 가 'T'가 아닙니다"
                             f"(값: {row[0] if row else '없음'}) — TG로 귀결되지 않습니다.")

        # ── ERP측 멱등 확인 ────────────────────────────────────────
        cur.execute("SELECT COUNT(*) FROM dbo.A_BATCH WITH (NOLOCK) WHERE REF_NO = ?", ref_no)
        if cur.fetchone()[0] > 0:
            raise SystemExit(f"[중단] A_BATCH 에 REF_NO={ref_no} 가 이미 존재합니다(중복 투입 차단).")
        cur.execute("SELECT COUNT(*) FROM dbo.A_TEMP_GL WITH (NOLOCK) WHERE REF_NO = ?", ref_no)
        if cur.fetchone()[0] > 0:
            raise SystemExit(f"[중단] A_TEMP_GL 에 REF_NO={ref_no} 전표가 이미 존재합니다(중복 투입 차단).")

        # ── JNL/EVENT 결정(fail-closed) ────────────────────────────
        lines = []
        for it in items:
            acct = str(it["acct_cd"]).strip()
            fg = "DR" if str(it["dr_cr_fg"]).strip().upper().startswith("D") else "CR"
            line_cost = (it.get("cost_cd") or cost_cd or "").strip()
            # 법인카드 채널과의 이중계상 차단 — 대변 미지급금(법인카드)은 AX 채널에서 쓰지 않는다
            if fg == "CR" and acct in FORBIDDEN_CR_ACCT:
                raise SystemExit(f"[중단] {it['item_seq']}번 줄: 대변 계정 {acct}(미지급금-법인카드)는 "
                                 f"AX 채널에서 사용할 수 없습니다 — 카드 전용 채널과 이중계상 위험.")
            jnl = resolve_jnl(cur, trans_type, acct, fg, line_cost)
            if not jnl:
                raise SystemExit(f"[중단] {it['item_seq']}번 줄 계정 {acct} 의 분개코드(JNL_CD)를 정할 수 없습니다"
                                 f"(거래유형 {trans_type} 매핑·자기참조·코드형 모두 실패). "
                                 f"분개코드 마스터(A_JNL_ITEM) 등재 여부를 확인하거나 매핑을 등록하세요.")
            lines.append({"seq": int(it["item_seq"]), "acct": acct, "fg": fg,
                          "amt": int(it["item_amt"]), "desc": (it.get("item_desc") or gl_desc)[:200],
                          "cost": line_cost,
                          "jnl": jnl[0], "event": jnl[1], "src": jnl[2],
                          "ctrls": ctrl_by_seq.get(int(it["item_seq"]), [])})
        result["detail"]["resolved"] = [
            {"seq": l["seq"], "acct": l["acct"], "fg": l["fg"], "jnl": l["jnl"],
             "event": l["event"], "src": l["src"]} for l in lines]
        print(f"[거래유형] {trans_type}")
        print(f"[분개코드] " + " · ".join(
            f"{l['seq']}:{l['acct']}→{l['jnl']}/{l['event'] or '-'}({l['src']})" for l in lines))

        # ── 입력검증 가드(G1·G2·G5) ────────────────────────────────
        # 근거: 15_AX전표_입력검증_및_차단규칙(ERP_DB 발신 2026-08-25)
        # 서브원장 SP 호출로 반제방향 검증(119712)은 ERP가 자동 적용하지만, 두 구멍이 남는다.
        #   G1 부가세(TP/TR) 반제방향 — usp_a_check_acct 에 TP/TR 전용 블록이 없다(수동입력분 위반 8라인 실재)
        #   G2 차대 균형 — 113119 검증이 GL_INPUT_TYPE='GL' 한정이라 결의전표(TG)는 대상 밖
        # G5 는 ERP가 막아주더라도 릴레이 실행 중에야 알게 되므로, 여기서 먼저 잡아 사유를 명확히 남긴다.
        blocks = guard_lines(cur, lines)
        if blocks:
            result["detail"]["guard_blocks"] = blocks
            for b in blocks:
                print(f"[차단] {b['seq']}번 줄 {b['acct']} {b['fg']} — {b['why']}", file=sys.stderr)
            raise SystemExit(f"[중단] 입력검증 차단 {len(blocks)}건 — 위 사유를 확인하세요. 아무것도 투입하지 않았습니다.")

        # ── 조직정보·채번 ──────────────────────────────────────────
        org, biz, internal, gaap = org_info(cur, dept_cd)
        batch_no = autogen(cur, BT_TYPE, date_str, user_id)
        ag_no = autogen(cur, AG_TYPE, date_str, user_id)
        result["batch_no"], result["gl_no"] = batch_no, ag_no
        cur.execute("SELECT COUNT(*) FROM dbo.A_TEMP_GL WITH (NOLOCK) WHERE TEMP_GL_NO = ?", ag_no)
        if cur.fetchone()[0] > 0:
            raise SystemExit(f"[중단] 채번된 번호 {ag_no} 가 이미 존재합니다 — 채번 상태를 점검하세요.")
        print(f"[채번] BATCH_NO={batch_no} / 전표번호={ag_no} (AI 전용 AG 대역)")

        # ── 1) A_BATCH ────────────────────────────────────────────
        cur.execute("""
            INSERT INTO dbo.A_BATCH
                (BATCH_NO, GL_NO, TEMP_GL_NO, GL_DT, ISSUED_DT, DUE_DT, GL_TYPE, GL_INPUT_TYPE, REF_NO,
                 BIZ_AREA_CD, REPORT_BIZ_AREA_CD, ORG_CHANGE_ID, DEPT_CD, COST_CD, INTERNAL_CD,
                 DOC_CUR, XCH_RATE,
                 NET_AMT, NET_LOC_AMT, TOT_AMT, TOT_LOC_AMT,
                 VAT_AMT, VAT_LOC_AMT, DIFF_AMT, DIFF_LOC_AMT,
                 GL_DESC, AUTO_TRANS_FG, REVERSE_FG, ONLINE_BATCH_FG, SUCCESS_FG, GAAP_GROUP_CD,
                 INSRT_USER_ID, INSRT_DT, UPDT_USER_ID, UPDT_DT)
            VALUES (?,?,?,?,?,?,'03','TG',?,
                    ?,?,?,?,?,?,
                    'KRW',1.000000,
                    ?,?,?,?,
                    ?,?,0,0,
                    ?,'Y','N','O','N',?,
                    ?,GETDATE(),?,GETDATE())""",
            batch_no, ag_no, ag_no, gl_dt_dt, gl_dt_dt, gl_dt_dt, ref_no,
            biz, biz, org, dept_cd, cost_cd or lines[0]["cost"], internal,
            tot, tot, tot, tot, vat, vat,
            gl_desc, gaap, user_id, user_id)

        # ── 2) A_BATCH_GL ─────────────────────────────────────────
        cur.execute("""
            INSERT INTO dbo.A_BATCH_GL
                (BATCH_NO, SEQ, GL_NO, BIZ_AREA_CD, COST_CD, ORG_CHANGE_ID, DEPT_CD, INTERNAL_CD,
                 NET_AMT, NET_LOC_AMT, DR_AMT, DR_LOC_AMT, CR_AMT, CR_LOC_AMT,
                 VAT_AMT, VAT_LOC_AMT,
                 INSRT_USER_ID, INSRT_DT, UPDT_USER_ID, UPDT_DT)
            VALUES (?,1,?,?,?,?,?,?,
                    ?,?,?,?,?,?,
                    ?,?,
                    ?,GETDATE(),?,GETDATE())""",
            batch_no, ag_no, biz, cost_cd or lines[0]["cost"], org, dept_cd, internal,
            tot, tot, tot, tot, tot, tot, vat, vat, user_id, user_id)

        # ── 3) A_BATCH_GL_ITEM (라인별, CTRL 슬롯 평탄화 최대 8) ──
        for l in lines:
            slots = l["ctrls"][:8]
            if len(l["ctrls"]) > 8:
                raise SystemExit(f"[중단] {l['seq']}번 줄 관리항목이 8종을 넘습니다(ERP 슬롯 한계).")
            ctrl_cols = "".join(f", CTRL_CD{i+1}, CTRL_VAL{i+1}" for i in range(len(slots)))
            ctrl_q = "".join(",?,?" for _ in slots)
            ctrl_vals = [v for pair in slots for v in pair]
            is_dr = l["fg"] == "DR"
            cur.execute(f"""
                INSERT INTO dbo.A_BATCH_GL_ITEM
                    (BATCH_NO, SEQ, ITEM_SEQ, BIZ_AREA_CD, ORG_CHANGE_ID, DEPT_CD, COST_CD,
                     TRANS_TYPE, JNL_CD, EVENT_CD, ACCT_CD, DR_CR_FG,
                     ITEM_AMT, ITEM_LOC_AMT, VAT_AMT, VAT_LOC_AMT, VAT_TYPE, VAT_RATE, IO_FG,
                     ITEM_DESC, DOC_CUR, XCH_RATE, REVERSE_FG, INTERNAL_CD, MAKE_ACCT_FG, GL_ITEM_SEQ{ctrl_cols},
                     INSRT_USER_ID, INSRT_DT, UPDT_USER_ID, UPDT_DT)
                VALUES (?,1,?,?,?,?,?,
                        ?,?,?,?,?,
                        ?,?,0,0,?,?,?,
                        ?,'KRW',1.000000,'N',?,'Y',0{ctrl_q},
                        ?,GETDATE(),?,GETDATE())""",
                batch_no, l["seq"], biz, org, dept_cd, l["cost"],
                trans_type, l["jnl"], l["event"], l["acct"], l["fg"],
                l["amt"], l["amt"], ("A" if is_dr else ""), (1.00 if is_dr else 0), ("1" if is_dr else ""),
                l["desc"], internal, *ctrl_vals, user_id, user_id)

        # ── 4) 전표 생성 엔진 ─────────────────────────────────────
        cur.execute(
            "SET NOCOUNT ON; DECLARE @rc int, @msg nvarchar(100); "
            "EXEC @rc = dbo.usp_a_create_gl_by_batch_01 ?, ?, @msg OUTPUT; "
            "SELECT @rc, @msg;", ref_no, user_id)
        row = first_resultset(cur)
        rc, msg_cd = (row[0], row[1]) if row else (None, None)
        result["msg_cd"] = msg_cd
        print(f"[엔진] rc={rc} / MSG_CD={msg_cd or '(없음)'}")

        # ── 5) 검증 — 전표 생성 + 라인 완전 대조(계정+차대+금액) ──
        cur.execute("SELECT TEMP_GL_NO, CONF_FG, DR_AMT, CR_AMT FROM dbo.A_TEMP_GL WITH (NOLOCK) WHERE REF_NO = ?", ref_no)
        gl = cur.fetchone()
        if not gl:
            raise SystemExit(f"[실패] A_TEMP_GL 에 전표가 생성되지 않았습니다(MSG_CD={msg_cd}). 롤백합니다.")
        cur.execute("SELECT ACCT_CD, RTRIM(DR_CR_FG), ITEM_LOC_AMT FROM dbo.A_TEMP_GL_ITEM WITH (NOLOCK) "
                    "WHERE TEMP_GL_NO = ?", gl[0])
        out_lines = [(str(r[0]).strip(), str(r[1]).strip()[:1], int(r[2])) for r in cur.fetchall()]
        in_lines = sorted((l["acct"], l["fg"][:1], l["amt"]) for l in lines)
        out_sorted = sorted(out_lines)
        match = in_lines == out_sorted
        result["lines_out"] = len(out_lines)
        result["line_match"] = match
        result["detail"]["verify"] = {"gl_no": gl[0], "conf_fg": str(gl[1]).strip(),
                                      "dr_amt": float(gl[2]), "cr_amt": float(gl[3]),
                                      "out_lines": [list(x) for x in out_sorted]}
        print(f"[검증] 전표={gl[0]} CONF_FG={str(gl[1]).strip()} 차변={gl[2]:,.0f} 대변={gl[3]:,.0f}")
        print(f"[대조] 투입 {len(in_lines)}줄 ↔ 생성 {len(out_lines)}줄 → {'✅ 완전일치' if match else '❌ 불일치'}")
        if not match:
            for x in in_lines:
                print(f"   투입: {x}")
            for x in out_sorted:
                print(f"   생성: {x}")
            raise SystemExit("[실패] 라인 대조 불일치 — 대차 자동보정 개입 의심. 롤백합니다.")

        # ── 6) 서브원장 생성 ──────────────────────────────────────
        # 엔진(usp_a_create_gl_by_batch_01)은 전표만 만들고 **서브원장은 만들지 않는다**.
        # 호출자가 이 SP 를 따로 불러야 채무(A_OPEN_AP)·부가세(A_VAT)가 생기고,
        # 라인의 연결번호(SUBSYS_NO)가 역기록된다. 법인카드 래퍼도 엔진 뒤에 이걸 부른다.
        #
        # 이 호출이 빠져 있던 동안 만든 전표는 "전표·시산표는 멀쩡한데 채무·부가세 원장이 없는"
        # 상태였다 — 겉으로 드러나지 않아 더 위험하다(2026-08-24 실측: 대상 26라인 SUBSYS_NO
        # 전건 공백, 수기 5,483/5,483 대비. 2025년 이후 미채움 8건이 전부 AX 전표였다).
        #
        # ⚠ 파라미터명이 @GL_NO 지만 본문은 `a.temp_gl_no = @gl_no` 로 쓴다 — **결의전표번호**를 넘긴다.
        # ⚠ 반드시 엔진과 **같은 트랜잭션**에서. 실패하면 전표 생성까지 되돌려
        #    "전표만 있고 원장이 없는" 부분성공을 만들지 않는다.
        # 회계전표 직행(GL_POSTING_FG='G')은 위 거래유형 확인에서 이미 차단된다 —
        # 이 경로는 항상 결의전표라 _TEMP_GL_ 쪽 하나만 부르면 된다.
        slip_no = str(gl[0]).strip()
        sp = "usp_a_create_temp_gl_subsys"
        cur.execute(
            "SET NOCOUNT ON; DECLARE @rc2 int, @msg2 nvarchar(100); "
            f"EXEC @rc2 = dbo.{sp} ?, ?, '', '', @msg2 OUTPUT; "
            "SELECT @rc2, @msg2;", slip_no, user_id)
        row2 = first_resultset(cur)
        rc2, msg2 = (row2[0], row2[1]) if row2 else (None, None)
        msg2 = (str(msg2).strip() if msg2 else "")
        result["subsys"] = {"sp": sp, "rc": rc2, "msg_cd": msg2}
        print(f"[서브원장] {sp} rc={rc2} / MSG_CD={msg2 or '(없음)'}")
        if rc2 != 1:
            result["detail"]["subsys_error"] = msg2
            raise SystemExit(
                f"[실패] 서브원장 생성 실패(rc={rc2}, MSG_CD={msg2 or '(없음)'}). "
                "전표 생성까지 롤백합니다 — 채무·부가세 없는 전표를 남기지 않습니다.")

        # ── 7) 서브원장 검증 — 연결번호·원장 실적 ──────────────────
        # 호출이 성공(rc=1)해도 조건 불일치로 아무것도 안 만들어질 수 있어, 결과를 직접 확인한다.
        cur.execute(
            "SELECT i.ITEM_SEQ, RTRIM(i.ACCT_CD), RTRIM(i.DR_CR_FG), RTRIM(ISNULL(a.SUBSYS_TYPE,'')), "
            "       RTRIM(ISNULL(i.SUBSYS_NO,'')) "
            "FROM dbo.A_TEMP_GL_ITEM i WITH (NOLOCK) "
            "JOIN dbo.A_ACCT a WITH (NOLOCK) ON RTRIM(a.ACCT_CD) = RTRIM(i.ACCT_CD) "
            "WHERE i.TEMP_GL_NO = ? AND ISNULL(a.SUBSYS_TYPE,'') <> '' "
            "  AND a.SUBSYS_TYPE NOT IN ('OC','OD') ORDER BY i.ITEM_SEQ", slip_no)
        subs = [(r[0], str(r[1]).strip(), str(r[2]).strip()[:1], str(r[3]).strip(), str(r[4]).strip())
                for r in cur.fetchall()]
        empty = [s for s in subs if not s[4]]
        result["detail"]["subsys_lines"] = [
            {"seq": s[0], "acct": s[1], "dr_cr": s[2], "type": s[3], "no": s[4]} for s in subs]
        if subs:
            print("[연결번호] " + " · ".join(f"{s[0]}:{s[1]}/{s[3]}→{s[4] or '(비어있음)'}" for s in subs))
        else:
            print("[연결번호] 서브원장 대상 라인 없음(경비만 있는 전표) — 정상")
        if empty:
            raise SystemExit(
                f"[실패] 서브원장 연결번호가 비어 있습니다({len(empty)}/{len(subs)}줄). "
                "SP 는 성공했는데 라인이 채워지지 않았습니다 — 롤백합니다.")

        for tbl, label in (("A_OPEN_AP", "채무"), ("A_VAT", "부가세")):
            try:
                cur.execute(f"SELECT COUNT(*) FROM dbo.{tbl} WITH (NOLOCK) WHERE TEMP_GL_NO = ?", slip_no)
                n = cur.fetchone()[0]
            except Exception:
                n = None            # 환경별 컬럼 상이 — 검증 실패로 취급하지 않는다
            if n is not None:
                result["detail"].setdefault("subsys_rows", {})[tbl] = n
                print(f"[{label}] {tbl} {n}행")

        # ── 커밋/롤백 ─────────────────────────────────────────────
        if args.dry_run:
            conn.rollback()
            result["status"] = "rolled_back"
            print(f"[리허설 종료] 모든 변경을 ROLLBACK 했습니다. 확정하려면 --dry-run 없이 재실행하세요.")
        else:
            conn.commit()
            result["status"] = "success"
            print(f"✅ [확정 완료] {TARGET_DB} 에 전표 {gl[0]} 이(가) 생성·COMMIT 됐습니다.")
    except SystemExit as e:
        try:
            conn.rollback()
        except Exception:
            pass
        result["detail"]["error"] = str(e)
        print(str(e), file=sys.stderr)
    except Exception as e:  # 예기치 못한 오류도 반드시 롤백
        try:
            conn.rollback()
        except Exception:
            pass
        result["detail"]["error"] = f"{type(e).__name__}: {e}"
        print(f"[오류] {e}", file=sys.stderr)
    finally:
        conn.close()

    # ── 포털 원장 기록(리허설 포함 전 시도) ──────────────────────
    try:
        log_id = rpc(url, key, "gl_apply_record", {"p": result})
        print(f"[원장] gl_erp_apply_log #{log_id} 기록({result['mode']}/{result['status']})")
    except Exception as e:
        print(f"[경고] 포털 원장 기록 실패: {e}", file=sys.stderr)
    return 0 if result["status"] in ("success", "rolled_back") and "error" not in result["detail"] else 1


def cleanup_draft(args):
    """DEMO2 정리 — 해당 초안의 전표·배치를 삭제(승인 전표 CONF_FG='C' 는 거부). 포털 상태 해제."""
    load_env()
    url = need("SUPABASE_URL").rstrip("/")
    key = need("SUPABASE_SERVICE_ROLE_KEY")
    ref_no = args.draft
    conn = demo_conn()
    cur = conn.cursor()
    try:
        cur.execute("SELECT TEMP_GL_NO, RTRIM(CONF_FG) FROM dbo.A_TEMP_GL WITH (NOLOCK) WHERE REF_NO = ?", ref_no)
        rows = cur.fetchall()
        if any(str(r[1]).strip() == "C" for r in rows):
            raise SystemExit("[중단] 승인된 전표(CONF_FG='C')는 삭제하지 않습니다.")
        gl_nos = [str(r[0]).strip() for r in rows]
        n = {"dtl": 0, "item": 0, "gl": 0, "bitem": 0, "bgl": 0, "batch": 0}
        for g in gl_nos:
            cur.execute("DELETE FROM dbo.A_TEMP_GL_DTL WHERE TEMP_GL_NO = ?", g); n["dtl"] += cur.rowcount
            cur.execute("DELETE FROM dbo.A_TEMP_GL_ITEM WHERE TEMP_GL_NO = ?", g); n["item"] += cur.rowcount
            cur.execute("DELETE FROM dbo.A_TEMP_GL WHERE TEMP_GL_NO = ?", g); n["gl"] += cur.rowcount
        cur.execute("SELECT BATCH_NO FROM dbo.A_BATCH WITH (NOLOCK) WHERE REF_NO = ?", ref_no)
        for (b,) in cur.fetchall():
            cur.execute("DELETE FROM dbo.A_BATCH_GL_ITEM WHERE BATCH_NO = ?", b); n["bitem"] += cur.rowcount
            cur.execute("DELETE FROM dbo.A_BATCH_GL WHERE BATCH_NO = ?", b); n["bgl"] += cur.rowcount
            cur.execute("DELETE FROM dbo.A_BATCH WHERE BATCH_NO = ?", b); n["batch"] += cur.rowcount
        conn.commit()
        print(f"[정리 완료] 전표 {len(gl_nos)}건({', '.join(gl_nos) or '-'}) — "
              f"DTL {n['dtl']} / ITEM {n['item']} / GL {n['gl']} / 배치라인 {n['bitem']} / 배치 {n['batch']}")
    except SystemExit as e:
        conn.rollback(); print(str(e), file=sys.stderr); conn.close(); return 1
    except Exception as e:
        conn.rollback(); print(f"[오류] {e}", file=sys.stderr); conn.close(); return 1
    conn.close()
    try:
        rpc(url, key, "gl_apply_record", {"p": {
            "draft_no": ref_no, "target_db": TARGET_DB, "ref_no": ref_no,
            "mode": "cleanup", "status": "success", "applied_by": "gl_apply_demo2.py",
            "detail": {"action": "cleanup", "deleted": True}}})
        print("[원장] 정리 기록 + 포털 적용 상태 해제")
    except Exception as e:
        print(f"[경고] 포털 원장 기록 실패: {e}", file=sys.stderr)
    return 0


def list_ready():
    load_env()
    url = need("SUPABASE_URL").rstrip("/")
    key = need("SUPABASE_SERVICE_ROLE_KEY")
    rows = rpc(url, key, "gl_apply_ready", {"p_target": TARGET_DB}) or []
    if not rows:
        print("적용 대상이 없습니다(제출됨 상태 + 미적용 기준).")
        return 0
    print(f"적용 대상 {len(rows)}건 — 대상 DB: {TARGET_DB}")
    for r in rows:
        mark = "🚀 전송 대기" if r.get("erp_apply_status") == "ready" \
            else ("⚠ 이전 실패" if r.get("erp_apply_status") == "failed" else "")
        print(f"  {r['draft_no']}  {r['draft_dt']}  {int(r['dr_total']):>12,}원  "
              f"{r.get('dept_nm') or r.get('dept_cd') or '-'}  {r.get('gl_desc','')[:36]}  {mark}")
    print("\n다음: --queue(전송 대기 건 처리) 또는 --draft <초안번호> --dry-run")
    return 0


def queue_run(args, url, key):
    """화면 [ERP 전송] 대기 건을 1건씩 순차 처리.

    ⚠ 조회가 아니라 '선점'이다(gl_apply_claim). 큐를 단순 SELECT 로 읽으면 러너를 두 번
    띄웠을 때 같은 초안을 둘 다 집어 ERP 에 전표가 두 장 생길 수 있다 —
    적용기의 REF_NO 선조회는 읽고-나서-쓰기라 둘 다 통과하고, ERP 도 REF_NO 를
    유니크로 잡지 않으며(A_BATCH 비유니크 인덱스·A_TEMP_GL 인덱스 없음),
    포털 원장 유니크는 ERP 커밋이 끝난 뒤에야 걸린다(레드팀 실측 2026-08-20).
    선점하면 한 초안은 한 러너만 가져간다. 처리 못 한 건은 반드시 반납한다.
    """
    # 죽은 러너가 sending 에 가둬 둔 건을 먼저 회수(기본 30분 초과분)
    try:
        n = rpc(url, key, "gl_apply_reclaim", {"p_minutes": 30}) or 0
        if n:
            print(f"[회수] 중단된 선점 {n}건을 대기 상태로 되돌렸습니다.")
    except Exception as e:
        print(f"[경고] 선점 회수 실패(계속 진행): {e}", file=sys.stderr)

    worker = f"{socket.gethostname()}/{os.getpid()}"
    rows = rpc(url, key, "gl_apply_claim",
               {"p_target": TARGET_DB, "p_max": args.max, "p_worker": worker}) or []
    if not rows:
        return 0, 0
    ok = 0
    for r in rows:
        no = r["draft_no"]
        print(f"\n════ [전송 처리] {no} · {int(r['dr_total']):,}원 · {r.get('gl_desc','')[:36]} ════")
        # claimed=True — 이 건은 방금 내가 선점했으므로 'sending' 가드를 통과시킨다
        ns = argparse.Namespace(draft=no, dry_run=False, cleanup=False,
                                trans_type=args.trans_type, claimed=True)
        done = False
        try:
            if apply_draft(ns) == 0:
                ok += 1
            done = True          # 성공·실패 모두 gl_apply_record 가 상태를 확정한다
        except SystemExit as e:   # 개별 건 실패가 큐 전체를 멈추지 않게
            print(f"[건너뜀] {no}: {e}", file=sys.stderr)
        except Exception as e:
            print(f"[오류] {no}: {e}", file=sys.stderr)
        if not done:
            # 투입 자체를 못 했으면 선점을 반납해 다음 회차에 다시 잡히게 한다
            try:
                rpc(url, key, "gl_apply_release", {"p_draft_no": no})
                print(f"[반납] {no} — 전송 대기로 되돌렸습니다.")
            except Exception as e:
                print(f"[경고] {no} 선점 반납 실패: {e}", file=sys.stderr)
    return ok, len(rows)


def watch_run(args, url, key):
    print(f"[감시 모드] {args.interval}초 간격으로 전송 대기 건을 확인합니다 — 화면에서 [🚀 ERP 전송]을 누르면"
          f" 자동 처리됩니다. 종료: Ctrl+C")
    try:
        while True:
            ok, total = queue_run(args, url, key)
            now = datetime.datetime.now().strftime("%H:%M:%S")
            if total:
                print(f"[{now}] 처리 {ok}/{total}건 — 계속 감시 중…")
            else:
                print(f"[{now}] 대기 건 없음", end="\r")
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n[감시 종료]")
        return 0


def main():
    ap = argparse.ArgumentParser(description=f"포털 결의전표 → {TARGET_DB} 직접 투입(1차 테스트)")
    ap.add_argument("--list", action="store_true", help="적용 대상 목록")
    ap.add_argument("--draft", help="초안번호(DRAFT-...) — 1회 1건")
    ap.add_argument("--dry-run", action="store_true", help="리허설(전 과정 실행 후 ROLLBACK)")
    ap.add_argument("--cleanup", action="store_true", help="해당 초안의 DEMO2 전표·배치 삭제(정리)")
    ap.add_argument("--queue", action="store_true", help="화면 [ERP 전송] 대기 건 일괄 처리")
    ap.add_argument("--watch", action="store_true", help="감시 모드 — 대기 건을 주기적으로 자동 처리")
    ap.add_argument("--interval", type=int, default=15, help="감시 주기(초, 기본 15)")
    ap.add_argument("--max", type=int, default=5, help="1회 처리 상한(기본 5 — 대량 오전송 방지)")
    ap.add_argument("--trans-type", default=TRANS_TYPE_DEFAULT, help=f"거래유형(기본 {TRANS_TYPE_DEFAULT})")
    args = ap.parse_args()
    if args.list:
        return list_ready()
    if args.queue or args.watch:
        load_env()
        url = need("SUPABASE_URL").rstrip("/")
        key = need("SUPABASE_SERVICE_ROLE_KEY")
        if args.watch:
            return watch_run(args, url, key)
        ok, total = queue_run(args, url, key)
        print(f"\n[큐 처리 완료] {ok}/{total}건 성공" if total else "전송 대기 건이 없습니다 — 화면에서 [🚀 ERP 전송]을 먼저 누르세요.")
        return 0 if ok == total else 1
    if not args.draft:
        ap.error("--draft 초안번호가 필요합니다(--list 로 확인).")
    if args.cleanup:
        return cleanup_draft(args)
    return apply_draft(args)


if __name__ == "__main__":
    sys.exit(main())
