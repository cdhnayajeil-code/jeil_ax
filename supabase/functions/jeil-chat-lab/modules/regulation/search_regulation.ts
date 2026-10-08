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
  prompt_hint: "사내규정(연차·휴가·근태·출장비·경비·결재권한 등 전사 규정류) 질문은 일반론으로 답하지 말고 먼저 search_regulation 으로 조문을 찾은 뒤 결론 한 문장 → 근거(규정명 제n조 · 시행일 + 조문 짧은 인용) → 유의사항 순으로 짧게 답하세요(목록·조문은 카드로 보이니 표를 다시 만들지 않는다). 전문이 필요하면 get_regulation. 해석·개별 적용은 담당 부서(인사팀·총무팀) 확인을 안내하고, 찾지 못하면 '포털의 규정 사본에서 찾지 못함'이라고 답하세요.",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    // 사내규정 조문 검색(REQ-0124) — 포털DB 사본(public.reg_* · definer RPC reg_search · 사내 전원). 본문은 HELPERS 만 쓴다(_port_modules 이식).
    // 2차(10-08 관리자 지시): 카드에 발췌(검색어 둘레 150자)를 같이 싣고, 「조문 ↗」은 조회 화면의 그 조문, 「PDF ↗」는 원본 파일
    // (비공개 버킷 사본 · 정본 SQL 108 · 화면이 사내 로그인 서명 URL 로 연다)로 보낸다. 그룹웨어 링크는 싣지 않는다(SSO 되돌림 · 10-08 실측).
    const SRC_LABEL = "사내규정 사본(그룹웨어 게시판 · 시행일 기준)";
    const q = String(args.q || "").replace(/[\u0000-\u001f\u007f%_\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
    if (q.length < 2) return { 오류: "검색어(q)는 두 글자 이상이어야 합니다." };
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
    const link = `https://ai.jeilm.co.kr/work/regulations?q=${encodeURIComponent(q)}`;
    const pageOf = (key: string, no: string | null, pdf: boolean) =>
      `https://ai.jeilm.co.kr/work/regulations?reg=${encodeURIComponent(key)}${no ? "&art=" + encodeURIComponent(no) : ""}${pdf ? "&view=pdf" : ""}`;
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
    const term0 = String(((res.terms || []) as unknown[])[0] || q.split(" ")[0] || "").toLowerCase();
    const snip = (s: string) => {   // 카드용 발췌 — 검색어 둘레 150자(도구 결과의 발췌는 320자 그대로 모델에 준다)
      const t = String(s || "").replace(/\s+/g, " ").trim();
      if (t.length <= 150) return t;
      const i = term0 ? t.toLowerCase().indexOf(term0) : -1;
      const st = Math.max(0, (i >= 0 ? i : 0) - 50);
      return (st > 0 ? "…" : "") + t.slice(st, st + 150) + (st + 150 < t.length ? "…" : "");
    };
    // deno-lint-ignore no-explicit-any
    const 목록 = ((res.rows || []) as any[]).map((r) => ({
      규정: r.name, reg_key: r.reg_key, 조문: r.article_no ? `제${r.article_no}조` : "전문", article_no: r.article_no || null,
      제목: r.title || "", 발췌: r.excerpt || "", 시행일: r.effective_date || null,
      조문보기: pageOf(String(r.reg_key), r.article_no || null, false),
      원본PDF: r.file_path ? pageOf(String(r.reg_key), r.article_no || null, true) : null, 원본파일: r.file_name || null,
    }));
    const columns = [{ key: "규정", label: "규정" }, { key: "조문", label: "조문" }, { key: "제목", label: "제목" }, { key: "발췌", label: "발췌", wrap: true },
                     { key: "시행일", label: "시행일" }, { key: "조문보기", label: "보기", link: true, linkLabel: "조문 ↗" }, { key: "원본PDF", label: "원본", link: true, linkLabel: "PDF ↗" }];
    const actions: { kind: string; label: string; url: string }[] = [{ kind: "link", label: "규정 조회 화면에서 보기", url: link }];
    if (!목록.length) return { 출처: SRC_LABEL, 기준시각: asOfReg || asOf, 검색어: q, 건수: 0, 목록: [],
      안내: `포털에 수집된 규정 조문에서 '${q}' 를 찾지 못했습니다. 낱말을 줄여 한 번만 다시 찾고, 그래도 없으면 '포털의 규정 사본에서 찾지 못함'이라고 답하고 담당 부서(인사팀·총무팀) 확인을 안내하세요. 조문을 추측해 만들지 마세요.`,
      __view: { view: "list", title: `사내규정 검색 — "${q}" (0건)`, asOf, columns, rows: [],
        note: "수집된 규정 사본 기준" + (asOfReg ? ` · 기준 ${asOfReg}` : "") + " — 낱말을 줄여 다시 찾아 보세요", actions } satisfies ViewPayload };
    const top = 목록[0];
    if (top.원본PDF) actions.push({ kind: "link", label: `원본 PDF — ${top.규정}`, url: top.원본PDF });
    return { 출처: SRC_LABEL, 기준시각: asOfReg || asOf, 검색어: q, 건수: 목록.length, 목록,
      안내: "답변 형식: ① 첫 줄에 결론 한 문장 ② 근거는 「규정명 제n조(제목) · 시행 YYYY-MM-DD」 꼴로 적고 해당 조문 문장을 짧게 그대로 인용 ③ 필요하면 유의사항 한두 줄. 위 목록은 카드(표)로 함께 보이니 글에서 표를 다시 만들지 마세요. 발췌 범위 밖은 추측하지 말고, 전문이 필요하면 get_regulation(reg=reg_key, article_no). 규정의 해석·예외 인정·개별 산정(금액·일수 계산)은 담당 부서(인사팀·총무팀) 확인을 안내하세요. 이 값은 그룹웨어 게시판의 포털 사본이라 수집 뒤 개정됐을 수 있습니다. 원본 PDF 는 카드의 「PDF ↗」로 열립니다.",
      __view: { view: "list", title: `사내규정 검색 — "${q}" (${목록.length}건)`, asOf, columns,
        rows: 목록.map((x) => ({ 규정: x.규정, 조문: x.조문, 제목: x.제목, 발췌: snip(x.발췌), 시행일: String(x.시행일 || "").slice(0, 10), 조문보기: x.조문보기, 원본PDF: x.원본PDF })),
        note: "그룹웨어 규정 게시판의 포털 사본" + (asOfReg ? ` · 기준 ${asOfReg}` : "") + " — 「조문 ↗」은 조회 화면의 그 조문, 「PDF ↗」는 원본 파일",
        actions } satisfies ViewPayload };
  }
