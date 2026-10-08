// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "search_regulation", version: "1.0.0", domain: "regulation", kind: "read",
  title_ko: "사내규정 검색", summary_ko: "그룹웨어 규정 게시판 사본에서 조문·제목·규정명 검색(규정명·조문·발췌·시행일)",
  description_llm: "사내규정(취업규칙·인사·복무·휴가·경비·출장·결재권한 등 전사 규정류) 조문 검색 — 그룹웨어 규정 게시판의 포털DB 사본에서 규정명·조문 제목·본문을 찾아 규정명·조문 번호·제목·발췌·시행일·원본 링크를 돌려준다. '연차 며칠', '출장비 기준', '결재 한도', '규정에 어떻게 돼 있어' 류 질의에 반드시 먼저 사용(일반론 답변 금지). 결과의 reg_key·article_no 로 get_regulation 을 부르면 조문 전문을 읽는다. 규정 질의에 OneDrive 문서 검색(search_my_documents)은 쓰지 않는다.",
  params: { type: "object", properties: { q: { type: "string", description: "검색어 — 핵심 낱말 1~3개(예: '연차', '출장 숙박비', '전결')" }, limit: { type: "integer", description: "최대 건수(기본 10, 최대 30)" } }, required: ["q"] },
  perm_module: null, perm_mode: "partial", sensitivity: "normal",
  view: ["list", "notice"], erp: false, owner: "총무팀", status: "live",
  prompt_hint: "사내규정(연차·휴가·근태·출장비·경비·결재권한 등 전사 규정류) 질문은 일반론으로 답하지 말고 먼저 search_regulation 으로 조문을 찾은 뒤, 규정명·조문 번호(제n조)·시행일을 밝혀 답하세요. 전문이 필요하면 get_regulation. 해석·개별 적용은 담당 부서(인사팀·총무팀) 확인을 안내하고, 찾지 못하면 '포털의 규정 사본에서 찾지 못함'이라고 답하세요.",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    // 사내규정 조문 검색(REQ-0124) — 포털DB 사본(public.reg_* · definer RPC reg_search · 사내 전원). 본문은 HELPERS 만 쓴다(_port_modules 이식).
    const SRC_LABEL = "사내규정 사본(그룹웨어 게시판 · 시행일 기준)";
    const q = String(args.q || "").replace(/[\u0000-\u001f\u007f%_\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
    if (q.length < 2) return { 오류: "검색어(q)는 두 글자 이상이어야 합니다." };
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
    const link = `https://ai.jeilm.co.kr/work/regulations?q=${encodeURIComponent(q)}`;
    // 엔진에 도구 타임아웃이 없다 — 도구가 스스로 8초 상한을 건다(NAS 도구와 같은 값). 초과는 「오류」가 아니라 「확인하지 못함」(개선 대장 자동 적재 방지).
    const timeout = new Promise<{ data: null; error: { message: string } }>((r) => setTimeout(() => r({ data: null, error: { message: "timeout" } }), 8000));
    // deno-lint-ignore no-explicit-any
    const { data, error } = (await Promise.race([admin.rpc("reg_search", { p_q: q, p_limit: limit }), timeout])) as { data: any; error: any };
    if (error) {
      const msg = String(error.message || "");
      if (msg === "timeout") return { 확인여부: "확인하지 못함", 검색어: q, 안내: "사내규정 검색이 8초 안에 끝나지 않았습니다. 낱말을 줄여 한 번만 다시 시도하고, 그래도 안 되면 규정 조회 화면에서 확인하도록 안내하세요.",
        __view: { view: "notice", title: "사내규정 검색 지연", kind: "info", text: "검색이 제한 시간 안에 끝나지 않았습니다. 낱말을 줄여 다시 시도해 보세요.",
          actions: [{ kind: "link", label: "규정 조회 화면에서 보기", url: link }] } satisfies ViewPayload };
      if (error.code === "42501" || /forbidden|permission denied/i.test(msg)) return { 접근제한: true, 안내: "사내 계정으로 로그인한 사용자만 사내규정을 조회할 수 있습니다.",
        __view: { view: "notice", title: "사내규정 접근 안내", kind: "deny", text: "사내 계정으로 로그인한 사용자만 사내규정을 조회할 수 있습니다." } satisfies ViewPayload };
      return { 오류: "사내규정 검색 실패: " + msg };
    }
    // deno-lint-ignore no-explicit-any
    const res = (data || {}) as any;
    if (res.allowed === false) return { 접근제한: true, 안내: "사내 계정으로 로그인한 사용자만 사내규정을 조회할 수 있습니다.",
      __view: { view: "notice", title: "사내규정 접근 안내", kind: "deny", text: "사내 계정으로 로그인한 사용자만 사내규정을 조회할 수 있습니다." } satisfies ViewPayload };
    const asOfReg = res.as_of ? String(res.as_of).slice(0, 16).replace("T", " ") : null;
    // deno-lint-ignore no-explicit-any
    const 목록 = ((res.rows || []) as any[]).map((r) => ({
      규정: r.name, reg_key: r.reg_key, 조문: r.article_no ? `제${r.article_no}조` : "전문", article_no: r.article_no || null,
      제목: r.title || "", 발췌: r.excerpt || "", 시행일: r.effective_date || null, 원본: r.gw_url || null,
    }));
    const columns = [{ key: "규정", label: "규정" }, { key: "조문", label: "조문" }, { key: "제목", label: "제목" }, { key: "시행일", label: "시행일" }, { key: "원본", label: "원본", link: true }];
    if (!목록.length) return { 출처: SRC_LABEL, 기준시각: asOfReg || asOf, 검색어: q, 건수: 0, 목록: [],
      안내: `포털에 수집된 규정 조문에서 '${q}' 를 찾지 못했습니다. 낱말을 줄여 한 번만 다시 찾고, 그래도 없으면 '포털의 규정 사본에서 찾지 못함'이라고 답하고 담당 부서(인사팀·총무팀) 확인을 안내하세요. 조문을 추측해 만들지 마세요.`,
      __view: { view: "list", title: `사내규정 검색 — "${q}" (0건)`, asOf, columns, rows: [],
        note: "수집된 규정 사본 기준" + (asOfReg ? ` · 기준 ${asOfReg}` : "") + " — 낱말을 줄여 다시 찾아 보세요",
        actions: [{ kind: "link", label: "규정 조회 화면에서 보기", url: link }] } satisfies ViewPayload };
    return { 출처: SRC_LABEL, 기준시각: asOfReg || asOf, 검색어: q, 건수: 목록.length, 목록,
      안내: "답변에는 규정명·조문 번호(제n조)·시행일을 밝히고 발췌 범위 안에서만 말하세요. 조문 전문이 필요하면 get_regulation(reg=reg_key, article_no). 규정의 해석·개별 적용(예외 인정·금액 산정)은 담당 부서(인사팀·총무팀) 확인을 안내하세요. 이 값은 그룹웨어 게시판의 포털 사본이라 수집 뒤 개정됐을 수 있습니다.",
      __view: { view: "list", title: `사내규정 검색 — "${q}" (${목록.length}건)`, asOf, columns,
        rows: 목록.map((x) => ({ 규정: x.규정, 조문: x.조문, 제목: x.제목, 시행일: String(x.시행일 || "").slice(0, 10), 원본: x.원본 })),
        note: "그룹웨어 규정 게시판의 포털 사본" + (asOfReg ? ` · 기준 ${asOfReg}` : "") + " — 원본·첨부 정본은 그룹웨어",
        actions: [{ kind: "link", label: "규정 조회 화면에서 보기", url: link }] } satisfies ViewPayload };
  }
