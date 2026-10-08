# -*- coding: utf-8 -*-
"""_port_modules.py — 운영 jeil-chat/index.ts 의 도구 19종을 modules/ 로 옮긴다(REQ-0084 · 13 기획 P1).

손으로 옮기면 오탈자가 생긴다. 그래서 원본에서 **기계적으로** 뽑는다:
  · TOOLS 배열의 description / parameters 원문 → manifest.description_llm / params
  · runTool() 의 `if (name === "…") { … }` 본문 → run(ctx) 본문(한 글자도 바꾸지 않는다)
  · manifest 의 나머지(도메인·유형·권한·민감도·담당·prompt_hint)는 아래 META 표 — 이 파일이 정본이다.

사용: python supabase/functions/jeil-chat-lab/_port_modules.py
      (운영 index.ts 가 바뀌면 다시 돌린다. 생성 파일 머리에 "자동 생성" 이 적힌다 — 손으로 고치지 않는다.)
"""
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "jeil-chat", "index.ts")
OUT = os.path.join(HERE, "modules")

# id: (domain, title_ko, summary_ko, perm_module, perm_mode, sensitivity, view, erp, owner, prompt_hint)
META = {
    "get_order_summary": ("portal", "협력사 외주검사 발주 현황", "포털에 등록된 외주검사 발주의 상태별 건수·납기임박", "pur_order", "gate", "amount", ["record"], False, "구매팀", None),
    "get_order_detail": ("portal", "외주검사 발주 상세", "외주검사 발주 1건의 진행단계·검사결과·사진·메시지", "pur_order", "gate", "amount", ["record"], False, "구매팀", None),
    "get_inspection_pending": ("portal", "검사 판정 대기", "검수요청 후 합/부 판정 전인 발주 목록", "pur_order", "gate", "normal", ["list"], False, "구매팀", None),
    "get_erp_sales_monthly": ("sales", "월별 매출", "거래처×월 매출액·건수", "sales", "gate", "amount", ["series"], True, "영업팀",
        "매출의 수금액·수주액은 미매핑(0)이니 매출액만 답하세요."),
    "get_erp_purchase_monthly": ("purchase", "월별 매입(송장)", "송장 기준 거래처×월 매입액", "purchase", "gate", "amount", ["series", "list"], True, "구매팀",
        "'매입'의 공식 집계는 송장 기준 get_erp_purchase_monthly(거래처×월)입니다. 개별 발주의 상태 IV는 그 발주의 '매입완료' 진행표시로만 해석하고, 두 수치를 합산·혼동하지 마세요."),
    "get_erp_inventory_status": ("inventory", "재고 입출고", "품목×창고 최근 31일 입출고(결측 배지 포함)", "inventory", "gate", "normal", ["record"], True, "자재팀",
        "재고·입고 수치(get_erp_inventory_status)는 현재 중간DB에 출고만 유효하고 입고량·재고량은 미적재입니다 — '입고 0/재고 없음'을 실적으로 단정하지 말고 미적재 상태임을 밝히며, 특정 발주의 입고 여부는 발주 조회(get_erp_po_pr)의 입고수량으로 답하세요."),
    "get_erp_item": ("item", "품목 검색", "품목코드·품목명 부분일치 검색(사용금지 표시)", "item", "gate", "normal", ["list"], True, "구매팀",
        "품목명에 '사용금지' 표기가 있는 코드는 신규 발주용으로 제시하지 말고 대체코드 확인을 안내하세요."),
    "get_erp_item_orders": ("purchase", "품목별 구매 이력", "품목의 구매요청→발주→매입 이력", "pur_order", "gate", "amount", ["list", "notice"], True, "구매팀",
        "★'품목코드(예: S3041-00065)나 품목명으로 그 품목의 발주·구매요청·매입 이력을 조회'하려면 반드시 get_erp_item_orders 를 쓰세요. 품목코드는 발주번호가 아니므로 get_erp_po_pr 의 po_no/pr_no 에 품목코드를 절대 넣지 마세요(넣으면 '없음'으로 오답). 품목코드로 물었는데 발주가 있으면 있다고 정확히 답하고, 품목코드를 발주번호처럼 답하지 마세요. 도구가 '재시도도구'를 반환하면 그 도구로 다시 조회하세요."),
    "get_erp_pur_order": ("purchase", "월별 발주 현황", "월별 발주건수·금액, 특정 월 거래처 Top10", "pur_order", "gate", "amount", ["series", "ranking"], True, "구매팀", None),
    "get_erp_po_pr": ("purchase", "발주·구매요청 상세", "PO/PR 번호로 상세 + 연결 + 진행단계", "pur_order", "gate", "amount", ["record"], True, "구매팀", None),
    "get_erp_pur_top": ("purchase", "발주 금액 상위", "발주번호별 총액 상위 N", "pur_order", "gate", "amount", ["ranking"], True, "구매팀", None),
    "get_erp_receipt_pending": ("purchase", "미입고 발주", "발주완료·입고전 라인(납기경과 필터)", "pur_order", "gate", "amount", ["list"], True, "구매팀", None),
    "get_erp_pur_req": ("purchase", "구매요청 목록", "상태·부서별 구매요청", "pur_order", "gate", "normal", ["list"], True, "구매팀", None),
    "get_my_access": ("common", "내 권한", "본인 역할·부서·ERP 모듈·페이지 권한", None, "self", "normal", ["record"], False, "포털 관리",
        "'내 권한 확인', '나 뭐 볼 수 있어?', '이 페이지 왜 안 보여?' 류 권한 질의는 일반론으로 답하지 말고 반드시 get_my_access 도구로 로그인 본인의 실제 역할·부서·ERP 모듈·페이지 권한을 조회해 답하세요(관리자면 관리자라고 정확히 알릴 것). 본인 외 타인의 권한은 조회할 수 없습니다."),
    "get_hr_headcount": ("hr", "인원현황", "월별 급여대상 인원(부서별은 payroll 보유자만)", "payroll", "partial", "normal", ["series", "notice"], True, "인사팀", None),
    "get_hr_payroll": ("hr", "급여 집계", "월별 급여총액·퇴직급여(인사팀·관리자 전용, 접근 감사)", "payroll", "gate", "personal", ["series", "notice"], True, "인사팀", None),
    "get_my_requests": ("common", "내 요청 진행", "본인 접수·동조한 포털 요청 진행상황", None, "self", "normal", ["list"], False, "포털 관리",
        "[신규] '내 요청 어떻게 됐어?', '권한 요청 진행상황' 류 질의는 get_my_requests 로 본인이 접수·동조한 요청만 조회해 답하세요."),
    "search_my_documents": ("docs", "내 문서 검색", "승인 폴더 ∩ 본인 권한 문서 검색(Graph)", None, "docs", "normal", ["list", "notice"], False, "포털 관리", None),
    "read_document": ("docs", "문서 본문 판독", "Excel 셀값·텍스트 본문(승인 폴더만)", None, "docs", "normal", ["notice"], False, "포털 관리", None),
    # 사내규정 2종(REQ-0124 · 포털DB public.reg_* 사본 · 정본 SQL 103 · 전 직원) — 도메인 안내는 core/prompt.ts DOMAIN_HINTS.regulation
    "search_regulation": ("regulation", "사내규정 검색", "그룹웨어 규정 게시판 사본에서 조문·제목·규정명 검색(규정명·조문·발췌·시행일)", None, "partial", "normal", ["list", "notice"], False, "총무팀",
        "사내규정(연차·휴가·근태·출장비·경비·결재권한 등 전사 규정류) 질문은 일반론으로 답하지 말고 먼저 search_regulation 으로 조문을 찾은 뒤, 규정명·조문 번호(제n조)·시행일을 밝혀 답하세요. 전문이 필요하면 get_regulation. 해석·개별 적용은 담당 부서(인사팀·총무팀) 확인을 안내하고, 찾지 못하면 '포털의 규정 사본에서 찾지 못함'이라고 답하세요."),
    "get_regulation": ("regulation", "사내규정 조문 읽기", "규정 1건의 목차·조문 전문 또는 조문 1개(이어 읽기)", None, "partial", "normal", ["record", "list", "notice"], False, "총무팀", None),
}

HELPERS = ("STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, "
           "graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr")

# 정본 전환(손수정) 모듈 — 다시 돌려도 덮어쓰지 않는다. 2026-09-30 실측(12_에이전트관리/05 F-2·F-3·F-4·F-8)으로
# 운영 jeil-chat 원본과 갈라졌다: 전체 건수·2차 정렬·거래처 조건·합계/라인 수·검사결과.
HAND_TUNED = {"get_erp_receipt_pending", "get_erp_pur_req", "get_erp_po_pr", "get_order_summary"}


def match_brace(s: str, i: int) -> int:
    """s[i] == '{' 에서 짝이 맞는 '}' 의 위치. 문자열·템플릿·정규식 리터럴 안의 괄호는 건너뛴다."""
    depth, j, n = 0, i, len(s)
    while j < n:
        c = s[j]
        if c in "\"'`":
            q = c; j += 1
            while j < n and s[j] != q:
                if s[j] == "\\": j += 1
                elif q == "`" and s[j] == "$" and j + 1 < n and s[j + 1] == "{":
                    j = match_brace(s, j + 1)
                j += 1
        elif c == "/" and s[j + 1:j + 2] == "/":
            j = s.index("\n", j)
            continue
        elif c == "/" and s[j + 1:j + 2] == "*":
            j = s.index("*/", j) + 1
        elif c == "/" and re.match(r"[(,=:!&|?{};\s]", s[j - 1] if j else " ") and s[j + 1:j + 2] not in ("/", "*"):
            # 정규식 리터럴(앞 글자가 연산자·괄호일 때만) — 문자 클래스 안의 '/' 도 건너뛴다
            k = j + 1; cls = False
            while k < n and (s[k] != "/" or cls):
                if s[k] == "\\": k += 1
                elif s[k] == "[": cls = True
                elif s[k] == "]": cls = False
                elif s[k] == "\n": break
                k += 1
            if k < n and s[k] == "/": j = k
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return j
        j += 1
    raise ValueError("unbalanced")


def tool_schema(src: str, name: str):
    k = src.index(f'name: "{name}",')
    d0 = src.index("description:", k) + len("description:")
    p0 = src.index("parameters:", d0)
    desc = src[d0:p0].strip().rstrip(",").strip()
    b = src.index("{", p0)
    params = src[b:match_brace(src, b) + 1]
    return desc, params


def run_body(src: str, cond: str) -> str:
    k = src.index(f"  if ({cond}) {{")
    b = src.index("{", k)
    return src[b + 1:match_brace(src, b)]


def emit(path: str, text: str):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    io.open(path, "w", encoding="utf-8", newline="\n").write(text)


def main() -> int:
    src = io.open(SRC, encoding="utf-8").read()
    rt = src.index("async function runTool(")
    body_src = src[rt:]
    written = []
    # 인사 2종은 원본이 한 분기를 공유한다 → 공용 구현 1개 + 얇은 모듈 2개
    hr_body = run_body(body_src, 'name === "get_hr_headcount" || name === "get_hr_payroll"')
    emit(os.path.join(OUT, "hr", "_hr_impl.ts"),
         "// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts runTool 의 인사 2종 공유 분기. 손으로 고치지 말 것.\n"
         "import type { ToolCtx, ViewPayload } from \"../../core/types.ts\";\n"
         f"import {{ {HELPERS} }} from \"../../core/util.ts\";\n"
         "import type { ScopeRow } from \"../../core/util.ts\";\n\n"
         "// deno-lint-ignore no-unused-vars\n"
         "export async function runHr(ctx: ToolCtx, name: string): Promise<unknown> {\n"
         "  const { admin, args, asOf, scope } = ctx;\n"
         + hr_body + "}\n")
    for tid, meta in META.items():
        domain, title, summary, pm, mode, sens, view, erp, owner, hint = meta
        if tid in HAND_TUNED:
            # 파일은 그대로 두고 등록 목록(index.ts)에는 넣는다
            print("skip(정본 전환 — 손수정 모듈 유지):", tid)
            written.append((domain, tid))
            continue
        desc, params = tool_schema(src, tid)
        head = (f"// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.\n"
                "import type { ToolCtx, ToolManifest, ViewPayload } from \"../../core/types.ts\";\n")
        manifest = (
            "export const manifest: ToolManifest = {\n"
            f"  id: \"{tid}\", version: \"1.0.0\", domain: \"{domain}\", kind: \"read\",\n"
            f"  title_ko: \"{title}\", summary_ko: \"{summary}\",\n"
            f"  description_llm: {desc},\n"
            f"  params: {params},\n"
            f"  perm_module: {('\"' + pm + '\"') if pm else 'null'}, perm_mode: \"{mode}\", sensitivity: \"{sens}\",\n"
            f"  view: {json.dumps(view)}, erp: {'true' if erp else 'false'}, owner: \"{owner}\", status: \"live\",\n"
            + (f"  prompt_hint: \"{hint}\",\n" if hint else "")
            + "};\n\n"
        )
        if domain == "hr":
            text = (head.replace(", ViewPayload", "") + "import { runHr } from \"./_hr_impl.ts\";\n\n" + manifest +
                    "export const run = (ctx: ToolCtx) => runHr(ctx, manifest.id);\n")
        else:
            body = run_body(body_src, f'name === "{tid}"')
            text = (head + f"import {{ {HELPERS} }} from \"../../core/util.ts\";\n"
                    "import type { ScopeRow } from \"../../core/util.ts\";\n\n" + manifest +
                    "// deno-lint-ignore require-await\n"
                    "export async function run(ctx: ToolCtx): Promise<unknown> {\n"
                    "  const { admin, args, asOf, scope, userToken } = ctx;\n"
                    + body + "}\n")
        path = os.path.join(OUT, domain, f"{tid}.ts")
        emit(path, text)
        written.append((domain, tid))
    # 등록 목록 — Edge Function 은 동적 로딩이 없다(정적 import)
    lines = ["// 자동 생성(_port_modules.py) — 모듈 등록 목록. 새 모듈은 META 에 한 줄 + 모듈 파일.",
             "import type { ToolModule } from \"../core/types.ts\";"]
    for i, (d, t) in enumerate(written):
        lines.append(f"import * as m{i} from \"./{d}/{t}.ts\";")
    lines.append("")
    lines.append("export const MODULES: ToolModule[] = [" + ", ".join(f"m{i}" for i in range(len(written))) + "];")
    emit(os.path.join(OUT, "index.ts"), "\n".join(lines) + "\n")
    print(f"모듈 {len(written)}종 생성 → {os.path.relpath(OUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
