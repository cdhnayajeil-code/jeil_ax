// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "get_regulation", version: "1.0.0", domain: "regulation", kind: "read",
  title_ko: "사내규정 조문 읽기", summary_ko: "규정 1건의 목차·조문 전문 또는 조문 1개(이어 읽기)",
  description_llm: "사내규정 1건의 조문 전문 또는 특정 조문 1개 읽기(포털DB 사본). reg(search_regulation 결과의 reg_key 또는 규정명 일부)로 찾고, article_no 를 주면 그 조문만, 없으면 목차 전체와 앞부분 조문을 돌려준다(길면 '다음조문' 값을 start 에 넣어 이어 읽는다). 답할 때 규정명·조문 번호(제n조)·시행일을 밝히고, 해석·개별 적용은 담당 부서(인사팀·총무팀) 확인을 안내한다.",
  params: { type: "object", properties: { reg: { type: "string", description: "reg_key(예: 'rules:취업규칙') 또는 규정명 일부(예: '취업규칙', '출장여비')" }, article_no: { type: "string", description: "조문 번호(예: '15', '15의2', '부칙-1'). 생략하면 목차+앞부분" }, start: { type: "integer", description: "이어 읽기 시작 조문 순번(이전 결과의 '다음조문')" } }, required: ["reg"] },
  perm_module: null, perm_mode: "partial", sensitivity: "normal",
  view: ["record", "list", "notice"], erp: false, owner: "총무팀", status: "live",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    // 사내규정 조문 읽기(REQ-0124) — reg_key 또는 규정명 부분일치 → definer RPC reg_get. 본문은 8,000자 창으로 잘라 이어 읽는다.
    // 2차(10-08): 조문 1개 카드는 짧은 메타 + 긴 본문 칸(long) · 「원본 PDF 열기」(비공개 버킷 사본 · SQL 108) · 그룹웨어 링크는 싣지 않는다.
    const SRC_LABEL = "사내규정 사본(그룹웨어 게시판 · 시행일 기준)";
    const regIn = String(args.reg || "").replace(/[\u0000-\u001f\u007f%\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!regIn) return { 오류: "규정(reg)이 필요합니다 — search_regulation 결과의 reg_key 또는 규정명 일부." };
    const artNo = String(args.article_no || "").trim().slice(0, 20) || null;
    const start = Math.max(1, Number(args.start) || 1);
    const WINDOW = 8000;
    const timeout = () => new Promise<{ data: null; error: { message: string } }>((r) => setTimeout(() => r({ data: null, error: { message: "timeout" } }), 8000));
    const deny = () => ({ 접근제한: true, 안내: "사내 계정으로 로그인한 사용자만 사내규정을 조회할 수 있습니다.",
      __view: { view: "notice", title: "사내규정 접근 안내", kind: "deny", text: "사내 계정으로 로그인한 사용자만 사내규정을 조회할 수 있습니다." } satisfies ViewPayload });
    let regKey = regIn;
    if (!/^[a-z0-9_]{1,40}:.+$/i.test(regIn)) {
      // 규정명으로 들어왔다 — 현행 목록에서 부분일치로 찾는다(후보가 여럿이면 되묻기)
      // deno-lint-ignore no-explicit-any
      const { data: ld, error: le } = (await Promise.race([admin.rpc("reg_list", { p_category: null, p_q: regIn }), timeout()])) as { data: any; error: any };
      if (le) return le.message === "timeout" ? { 확인여부: "확인하지 못함", 안내: "사내규정 목록 조회가 8초 안에 끝나지 않았습니다. 잠시 뒤 다시 시도하세요." } : { 오류: "사내규정 목록 조회 실패: " + String(le.message || "") };
      if (ld && ld.allowed === false) return deny();
      // deno-lint-ignore no-explicit-any
      const cands = ((ld && ld.rows) || []) as any[];
      if (!cands.length) return { 출처: SRC_LABEL, 기준시각: asOf, 규정: regIn, 건수: 0,
        안내: `'${regIn}' 에 맞는 규정이 포털 사본에 없습니다. search_regulation 으로 낱말을 바꿔 찾거나, '포털의 규정 사본에서 찾지 못함'이라고 답하고 담당 부서 확인을 안내하세요.`,
        __view: { view: "notice", title: "사내규정 없음", kind: "info", text: `'${regIn}' 에 맞는 규정이 포털 사본에 없습니다.` } satisfies ViewPayload };
      if (cands.length > 1) return { 출처: SRC_LABEL, 기준시각: asOf, 규정: regIn, 건수: cands.length,
        후보: cands.slice(0, 10).map((c) => ({ 규정: c.name, reg_key: c.reg_key, 분류: c.category || null, 시행일: c.effective_date || null, 조문수: c.article_count })),
        안내: "규정이 여럿입니다 — 사용자에게 어느 규정인지 묻거나, 가장 맞는 reg_key 로 get_regulation 을 다시 부르세요.",
        __view: { view: "list", title: `사내규정 후보 — "${regIn}" (${cands.length}건)`, asOf,
          columns: [{ key: "규정", label: "규정" }, { key: "분류", label: "분류" }, { key: "시행일", label: "시행일" }, { key: "조문수", label: "조문" }, { key: "보기", label: "보기", link: true, linkLabel: "열기 ↗" }],
          rows: cands.slice(0, 10).map((c) => ({ 규정: c.name, 분류: c.category || "", 시행일: String(c.effective_date || "").slice(0, 10), 조문수: c.article_count,
                                                보기: `https://ai.jeilm.co.kr/work/regulations?reg=${encodeURIComponent(String(c.reg_key))}` })) } satisfies ViewPayload };
      regKey = String(cands[0].reg_key);
    }
    // deno-lint-ignore no-explicit-any
    const { data, error } = (await Promise.race([admin.rpc("reg_get", { p_reg_key: regKey, p_article_no: artNo, p_from_seq: start, p_limit: 300 }), timeout()])) as { data: any; error: any };
    if (error) {
      const msg = String(error.message || "");
      if (msg === "timeout") return { 확인여부: "확인하지 못함", 안내: "사내규정 읽기가 8초 안에 끝나지 않았습니다. 조문 번호(article_no)를 지정해 다시 시도하세요." };
      if (error.code === "42501" || /forbidden|permission denied/i.test(msg)) return deny();
      return { 오류: "사내규정 읽기 실패: " + msg };
    }
    // deno-lint-ignore no-explicit-any
    const res = (data || {}) as any;
    if (res.allowed === false) return deny();
    if (!res.found) return { 출처: SRC_LABEL, 기준시각: asOf, 규정: regKey, 건수: 0,
      안내: "이 규정의 현행 판이 포털 사본에 없습니다(삭제됐거나 아직 수집 전). 담당 부서 확인을 안내하세요.",
      __view: { view: "notice", title: "사내규정 없음", kind: "info", text: "이 규정의 현행 판이 포털 사본에 없습니다." } satisfies ViewPayload };
    const r = res.reg || {};
    const asOfReg = res.as_of ? String(res.as_of).slice(0, 16).replace("T", " ") : null;
    const linkOf = (no: string | null, pdf = false) => `https://ai.jeilm.co.kr/work/regulations?reg=${encodeURIComponent(regKey)}${no ? "&art=" + encodeURIComponent(no) : ""}${pdf ? "&view=pdf" : ""}`;
    const 규정 = { 규정명: r.name, reg_key: r.reg_key, 분류: r.category || null, 제정일: r.enact_date || null, 개정일: r.revise_date || null, 시행일: r.effective_date || null,
      개정차수: r.revision_no || null, 주관부서: r.owner_dept || null, 판독: r.parse_status, 조문원천: r.text_source,
      원본파일: r.file_name || null, 원본PDF: r.file_path ? linkOf(null, true) : null };
    // deno-lint-ignore no-explicit-any
    const 첨부 = ((res.attachments || []) as any[]).map((a) => ({ 파일: a.file_name, 판독: a.text_status, 사유: a.text_reason || null, 포털사본: a.storage_path ? "있음" : "없음" }));
    // deno-lint-ignore no-explicit-any
    const arts = (res.articles || []) as any[];
    const 안내공통 = "답변 형식: 결론 한 문장 → 근거 「규정명 제n조(제목) · 시행 YYYY-MM-DD」 + 조문 문장 짧은 인용 → 유의사항 한두 줄. 조문은 카드에 보이니 본문을 통째로 다시 적지 마세요. 해석·예외 인정·개별 산정은 담당 부서(인사팀·총무팀) 확인을 안내하세요. 이 값은 그룹웨어 게시판의 포털 사본이라 수집 뒤 개정됐을 수 있습니다(판독 불가 첨부의 내용은 들어 있지 않습니다). 원본 PDF 는 카드의 「원본 PDF 열기」로 볼 수 있습니다.";
    const pdfAct = (no: string | null) => (r.file_path ? [{ kind: "link", label: "원본 PDF 열기", url: linkOf(no, true) }] : []);
    if (artNo) {
      const a = arts[0];
      if (!a) return { 출처: SRC_LABEL, 기준시각: asOfReg || asOf, 규정, 조문번호: artNo, 건수: 0,
        안내: `제${artNo}조가 이 규정의 사본에 없습니다. get_regulation(reg) 으로 목차를 보고 번호를 확인하세요.`,
        __view: { view: "notice", title: `${r.name} 제${artNo}조 없음`, kind: "info", text: "그 조문 번호가 사본에 없습니다 — 목차에서 확인하세요.",
          actions: [{ kind: "link", label: "목차 보기", url: linkOf(null) }] } satisfies ViewPayload };
      const body = String(a.body || "");
      return { 출처: SRC_LABEL, 기준시각: asOfReg || asOf, 규정,
        조문: { 조문번호: a.article_no, 장: a.chapter || null, 절: a.section || null, 제목: a.title || null, 본문: body.slice(0, WINDOW), 개정꼬리표: a.amended_tag || null, 삭제됨: !!a.is_deleted },
        첨부, 안내: 안내공통,
        __view: { view: "record", title: `${r.name} 제${a.article_no}조${a.title ? "(" + a.title + ")" : ""}`, asOf,
          fields: [{ k: "규정", v: String(r.name || "") + (r.category ? ` · ${r.category}` : "") }, { k: "조문", v: `제${a.article_no}조` + (a.title ? ` ${a.title}` : "") + (a.chapter ? ` · ${a.chapter}` : "") },
                   { k: "시행일", v: String(r.effective_date || "").slice(0, 10) || "—" }, { k: "개정", v: a.amended_tag || (r.revise_date ? String(r.revise_date).slice(0, 10) + (r.revision_no ? ` (${r.revision_no}차)` : "") : "—") },
                   { k: "주관부서", v: r.owner_dept || "—" }, { k: "원본", v: r.file_name ? `${r.file_name} (PDF 사본)` : "포털 사본 없음 — 그룹웨어 게시판" },
                   { k: "본문", v: body.slice(0, 1200) + (body.length > 1200 ? " …(이하 생략 — 화면에서 전체 보기)" : ""), long: true }],
          note: "그룹웨어 규정 게시판의 포털 사본" + (asOfReg ? ` · 기준 ${asOfReg}` : ""),
          actions: [{ kind: "link", label: "화면에서 이 조문 보기", url: linkOf(String(a.article_no)) }, ...pdfAct(String(a.article_no))] } satisfies ViewPayload };
    }
    // 전체 — 목차는 전부, 본문은 start 부터 8,000자 창까지(결과 절단 12,000자 안쪽). 남으면 다음조문.
    // deno-lint-ignore no-explicit-any
    const 목차 = ((res.toc || []) as any[]).map((t) => ({ seq: t.seq, 조문번호: t.article_no, 제목: t.title || null, 장: t.chapter || null, 삭제됨: !!t.is_deleted }));
    const 조문: { seq: number; 조문번호: string | null; 제목: string | null; 본문: string; 개정꼬리표: string | null }[] = [];
    let used = 0, nextSeq: number | null = res.next_seq || null;
    for (const a of arts) {
      const body = String(a.body || "");
      if (조문.length && used + body.length > WINDOW) { nextSeq = a.seq; break; }
      조문.push({ seq: a.seq, 조문번호: a.article_no || null, 제목: a.title || null, 본문: body.slice(0, WINDOW), 개정꼬리표: a.amended_tag || null });
      used += body.length;
    }
    return { 출처: SRC_LABEL, 기준시각: asOfReg || asOf, 규정, 조문수: res.total_articles || 목차.length, 목차, 조문, 다음조문: nextSeq, 첨부,
      안내: 안내공통 + (nextSeq ? ` 조문이 더 있습니다 — 이어 읽으려면 start=${nextSeq} 로 다시 부르세요. 목차의 조문 번호를 article_no 로 바로 읽어도 됩니다.` : ""),
      __view: { view: "list", title: `${r.name} — 목차 (${목차.length}개 조문)`, asOf,
        columns: [{ key: "조문", label: "조문" }, { key: "제목", label: "제목" }, { key: "장", label: "장" }, { key: "보기", label: "보기", link: true, linkLabel: "조문 ↗" }],
        rows: 목차.slice(0, 60).map((t) => ({ 조문: t.조문번호 ? `제${t.조문번호}조` : "전문", 제목: (t.제목 || "") + (t.삭제됨 ? " (삭제)" : ""), 장: t.장 || "",
                                             보기: t.조문번호 ? linkOf(String(t.조문번호)) : linkOf(null) })),
        note: `시행 ${String(r.effective_date || "").slice(0, 10) || "—"} · 판독 ${r.parse_status}` + (asOfReg ? ` · 기준 ${asOfReg}` : "") + (목차.length > 60 ? ` · 표시 60건 / 전체 ${목차.length}건` : ""),
        actions: [{ kind: "link", label: "화면에서 보기", url: linkOf(null) }, ...pdfAct(null)] } satisfies ViewPayload };
  }
