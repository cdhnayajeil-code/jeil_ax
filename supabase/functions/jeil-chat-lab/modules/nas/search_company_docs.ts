// search_company_docs — 사내 보관소(NAS) 문서 **내용** 검색(REQ-0104 · ADR-110 v3 P3 · D-95 승인 2026-10-02). 손으로 쓴 모듈.
// 색인은 사내 NAS 워커 쪽에만 있다. 여기로 오는 것은 질문에 걸린 발췌 몇 토막뿐이고, 조회 큐에서 읽히면 지워진다.
// 볼 수 있는 폴더는 DB(nas_query_submit)가 「허용 폴더 등록 ∩ 본인 부서·전사공유」로 계산한다.
import type { ToolCtx, ToolManifest } from "../../core/types.ts";
import { nasList, nasNotice, nasQuery, tidy } from "./_nas_query.ts";

export const manifest: ToolManifest = {
  id: "search_company_docs", version: "1.0.0", domain: "nas", kind: "read",
  title_ko: "사내 문서 내용 검색", summary_ko: "NAS 허용 폴더(본인 부서·전사공유) 문서의 본문 검색 — 발췌와 문서 번호",
  description_llm: "사내 보관소(NAS)의 부서 폴더·전사공유 폴더에 있는 규정·양식·매뉴얼 문서의 **본문**에서 낱말을 찾는다. " +
    "'구매 규정에서 수의계약 기준', '출장비 숙박 상한이 얼마야', '검수 절차 문서 찾아줘' 류. " +
    "문서 이름·수정일·관련 발췌와 함께 read_company_doc 호출용 문서 번호(문서)와 토막 번호(토막)를 돌려준다. " +
    "q 에는 문서에 실제로 적혀 있을 낱말을 1~3개 넣는다(문장 전체를 넣지 말 것). 본인 부서 폴더와 전사공유 폴더만 검색된다.",
  params: { type: "object", properties: {
    q: { type: "string", description: "찾을 낱말 1~3개(띄어 쓰면 모두 포함된 토막을 찾는다). 예: '수의계약 기준'" },
    limit: { type: "integer", description: "표시 건수(기본 8, 최대 15)" },
  }, required: ["q"] },
  perm_module: null, perm_mode: "partial", sensitivity: "normal",
  view: ["list", "notice"], erp: false, owner: "포털 관리", status: "pilot",
  prompt_hint: "사내 문서 검색 결과로 답할 때는 반드시 문서 이름과 수정일을 근거로 밝히세요. 발췌에 없는 내용은 덧붙이지 말고, " +
    "발췌만으로 부족하면 read_company_doc 으로 그 문서를 더 읽은 뒤 답하세요. 검색 결과가 없으면 문서에 없다고 단정하지 말고 " +
    "'볼 수 있는 폴더의 색인된 문서에서는 찾지 못했다'고 답하세요(스캔본·구형 한글 파일은 내용 검색이 되지 않습니다).",
};

export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope } = ctx;
  const q = tidy(args.q, 80);
  if (!q) return { 오류: "검색어(q)가 필요합니다." };
  const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 8), 1), 15);

  const a = await nasQuery(admin, scope, "doc_search", { q, limit });
  if (a.state !== "done") return nasNotice(a, "문서 검색");

  const r = a.result || {};
  // deno-lint-ignore no-explicit-any
  let rows = (Array.isArray(r["목록"]) ? r["목록"] : []) as any[];
  let nDocs = Number(r["해당문서수"]) || 0;
  // 색인은 낱말을 「모두 포함」으로 찾는다. 「품의서 관리 방법」처럼 문장으로 물으면 한 낱말만 없어도 0건이 된다
  // → 0건이면 긴 낱말부터 두 개까지 하나씩 다시 찾아 합친다(볼 수 있는 범위는 그대로 — DB 가 정한다).
  let widened = "";
  const words = [...new Set(q.split(/\s+/).filter((w) => w.length >= 2))].sort((x, y) => y.length - x.length);
  if (!rows.length && words.length > 1) {
    const seen = new Set<string>();
    const used: string[] = [];
    for (const w of words.slice(0, 2)) {
      const b = await nasQuery(admin, scope, "doc_search", { q: w, limit }, 5000);
      if (b.state !== "done") break;
      // deno-lint-ignore no-explicit-any
      const more = (Array.isArray(b.result?.["목록"]) ? b.result!["목록"] : []) as any[];
      if (more.length) used.push(w);
      for (const x of more) {
        const k = `${x["문서"]}#${x["토막"]}`;
        if (!seen.has(k) && rows.length < limit) { seen.add(k); rows = [...rows, x]; }
      }
    }
    nDocs = new Set(rows.map((x) => x["문서"])).size;
    if (used.length) widened = `'${q}' 전체로는 없어 낱말(${used.join("·")})로 넓혀 찾았습니다 — 질문과 맞는 내용인지 발췌를 확인하고 답하세요.`;
  }
  const 안내 = [
    widened,
    rows.length
      ? "발췌는 문서의 일부입니다. 근거로 문서 이름·수정일을 밝히고, 더 필요하면 read_company_doc 으로 이어 읽으세요."
      : "볼 수 있는 폴더의 색인된 문서에서는 찾지 못했습니다. 낱말을 바꿔 다시 찾아보세요 — 스캔본·구형 한글(hwp)은 내용 검색이 되지 않습니다.",
    r["잘림"] === true ? `걸린 문서가 더 있습니다(${nDocs}건 이상) — 낱말을 더 좁혀 보세요.` : "",
    r["사유"] ? String(r["사유"]) : "",
  ].filter(Boolean).join(" ");
  return {
    기준시각: asOf, 색인기준: r["색인기준"] || null, 검색어: q, 해당문서수: nDocs, 반환수: rows.length, 응답_ms: a.ms,
    목록: rows.map((x) => ({ 문서: x["문서"], 토막: x["토막"], 폴더: x["폴더"], 경로: x["경로"] || "", 이름: x["이름"], 수정일: x["수정일"], 발췌: x["발췌"] })),
    안내,
    __view: nasList(`사내 문서 검색 — '${q}'`, asOf, ["폴더", "문서", "수정일", "발췌"],
      rows.map((x) => [x["폴더"], (x["경로"] ? x["경로"] + "/" : "") + x["이름"], x["수정일"], x["발췌"]]),
      rows.length ? `색인 기준 ${r["색인기준"] || "-"} · 본인 부서·전사공유 폴더만` : "찾지 못함 — 낱말을 바꿔 보세요(스캔본·hwp 는 내용 검색 불가)"),
  };
}
