// read_company_doc — 사내 보관소(NAS) 문서 한 건의 본문 읽기(REQ-0104 · ADR-110 v3 P3 · D-95). 손으로 쓴 모듈.
// search_company_docs 가 준 문서 번호로만 읽는다. 그 문서가 볼 수 있는 폴더에 있는지는 DB(범위 계산)와 워커가 다시 확인한다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { nasNotice, nasQuery, tidy } from "./_nas_query.ts";

export const manifest: ToolManifest = {
  id: "read_company_doc", version: "1.0.0", domain: "nas", kind: "read",
  title_ko: "사내 문서 읽기", summary_ko: "NAS 문서 한 건의 본문(토막 단위로 최대 6천 자)",
  description_llm: "search_company_docs 결과의 문서 번호(문서)로 그 문서의 본문을 읽는다. 발췌만으로 답하기 부족할 때 쓴다. " +
    "seq 에 검색 결과의 토막 번호를 주면 그 자리부터 읽는다. 한 번에 6천 자쯤 돌려주며, 더 있으면 '다음토막' 번호를 알려준다.",
  params: { type: "object", properties: {
    doc: { type: "string", description: "search_company_docs 가 돌려준 문서 번호(예: 'pur_team:12')" },
    seq: { type: "integer", description: "읽기 시작할 토막 번호(검색 결과의 토막, 생략하면 처음부터)" },
  }, required: ["doc"] },
  perm_module: null, perm_mode: "partial", sensitivity: "normal",
  view: ["notice"], erp: false, owner: "포털 관리", status: "pilot",
};

export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope } = ctx;
  const doc = tidy(args.doc, 60);
  if (!/^[a-z0-9_]{1,40}:\d{1,12}$/.test(doc)) return { 오류: "문서 번호가 올바르지 않습니다 — search_company_docs 결과의 '문서' 값을 그대로 넣으세요." };
  const seq = Math.min(Math.max(Math.trunc(Number(args.seq) || 0), 0), 100000);

  const a = await nasQuery(admin, scope, "doc_read", { doc, seq });
  if (a.state !== "done") return nasNotice(a, "문서 내용");

  const r = a.result || {};
  const body = String(r["내용"] || "");
  if (!body) {
    const why = String(r["사유"] || "문서를 읽지 못했습니다.");
    return { 확인여부: "확인하지 못함", 안내: why + " 다시 검색해서 문서 번호를 확인하세요.",
      __view: { view: "notice", title: "문서를 읽지 못함", kind: "info", text: why } satisfies ViewPayload };
  }
  const next = r["다음토막"];
  return {
    기준시각: asOf, 문서: r["문서"], 이름: r["이름"], 경로: r["경로"] || "", 수정일: r["수정일"],
    토막범위: r["토막범위"], 전체토막: r["전체토막"], 다음토막: next ?? null, 응답_ms: a.ms,
    내용: body,
    안내: (next != null ? `문서가 더 있습니다 — 이어 읽으려면 seq=${next} 로 다시 부르세요. ` : "문서 끝까지 읽었습니다. ") +
      "답할 때 문서 이름과 수정일을 근거로 밝히세요.",
  };
}
