// read_company_table — 사내 보관소(NAS)의 엑셀·CSV 한 건을 표 구조로 읽기(REQ-0117 S1 · 정본 SQL 97 · CLAUDE.md §19). 손으로 쓴 모듈.
// read_company_doc 은 색인된 글자를 토막으로 돌려줘 열 위치·머리글·날짜가 사라진다. 이 도구는 시트 이름·머리글(추정)·열 문자·
// 행 번호를 살리고 날짜 서식 셀을 날짜로 되돌려 준다. 값은 어디에도 쌓지 않는다 — 조회 큐에 잠깐 머물다 지워진다(D-95).
// 볼 수 있는 폴더인지는 DB(범위 계산)와 워커가 다시 확인한다. 출처는 항상 「문서」다 — ERP 값과 섞어 말하지 않게 결과에 적는다(§19-3).
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { nasNotice, nasQuery, tidy } from "./_nas_query.ts";

export const manifest: ToolManifest = {
  id: "read_company_table", version: "1.0.0", domain: "nas", kind: "read",
  title_ko: "사내 문서 표 읽기", summary_ko: "NAS 엑셀·CSV 한 건을 시트·머리글·열·행 번호가 살아 있는 표로",
  description_llm: "search_company_docs 결과의 문서 번호(문서)로 엑셀(xlsx·xlsm)·CSV 파일을 표로 읽는다. " +
    "견적서·단가표·목록처럼 열과 행이 중요한 파일은 read_company_doc 대신 이 도구를 쓴다. " +
    "결과의 '행'은 [엑셀 행 번호, 열 순서대로의 셀 값…] 이고 '열'이 그 순서(A, B, C…), '머리글'이 열 이름(추정)이다. " +
    "'머리글위'는 표 위쪽의 제목·업체명·작성일 같은 줄이다(칸 주소: 값). " +
    "시트가 여러 개면 '시트목록'을 보고 sheet 에 번호나 이름을 준다. 더 있으면 '다음행' 을 start 에 넣어 이어 읽는다. " +
    "이 값은 문서에서 읽은 것이지 ERP 값이 아니다 — 답할 때 출처(문서 이름·시트·행 번호)를 밝히고, ERP 조회 결과와 한 표에 섞거나 합산하지 않는다.",
  params: { type: "object", properties: {
    doc: { type: "string", description: "search_company_docs 가 돌려준 문서 번호(예: 'pur_team:12')" },
    sheet: { type: "string", description: "시트 이름 또는 번호(1부터). 같은 글자의 이름이 있으면 이름이 먼저다. 생략하면 첫 시트" },
    start: { type: "integer", description: "읽기 시작할 엑셀 행 번호. 생략하면 머리글 다음 행부터" },
    rows: { type: "integer", description: "읽을 행 수(기본 60, 최대 200 — 글자가 많으면 더 적게 돌아온다)" },
  }, required: ["doc"] },
  perm_module: null, perm_mode: "partial", sensitivity: "normal",
  view: ["notice"], erp: false, owner: "포털 관리", status: "pilot",
};

export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope } = ctx;
  const doc = tidy(args.doc, 60);
  if (!/^[a-z0-9_]{1,40}:\d{1,12}$/.test(doc)) return { 오류: "문서 번호가 올바르지 않습니다 — search_company_docs 결과의 '문서' 값을 그대로 넣으세요." };
  const params: Record<string, unknown> = { doc, rows: Math.min(Math.max(Math.trunc(Number(args.rows) || 60), 1), 200) };
  const sheet = tidy(args.sheet, 60);
  if (sheet) params.sheet = sheet;
  const start = Math.trunc(Number(args.start) || 0);
  if (start > 0) params.start = Math.min(start, 2_000_000);

  const a = await nasQuery(admin, scope, "doc_table", params);
  if (a.state !== "done") return nasNotice(a, "문서의 표");

  const r = a.result || {};
  const rows = Array.isArray(r["행"]) ? (r["행"] as unknown[]) : [];
  if (!rows.length) {
    const why = String(r["사유"] || (r["시트"] ? "이 범위에는 값이 있는 행이 없습니다." : "표를 읽지 못했습니다."));
    return { 확인여부: "확인하지 못함", 시트목록: r["시트목록"] ?? null, 안내: why + " 확인하지 못한 값을 추측해서 답하지 마세요.",
      __view: { view: "notice", title: "표를 읽지 못함", kind: "info", text: why } satisfies ViewPayload };
  }
  const next = r["다음행"];
  return {
    출처: "문서 추출·미확인", 기준시각: asOf,
    문서: r["문서"], 이름: r["이름"], 경로: r["경로"] || "", 수정일: r["수정일"],
    시트목록: r["시트목록"], 시트: r["시트"], 끝까지읽음: r["끝까지읽음"] === true, ...(r["앞부분만읽음"] === true ? { 앞부분만읽음: true } : {}),
    머리글행: r["머리글행"] ?? null, 머리글: r["머리글"], 머리글위: r["머리글위"] ?? [], 열: r["열"], 열잘림: !!r["열잘림"],
    행범위: r["행범위"], 다음행: next ?? null, 병합수: r["병합수"] ?? 0, 병합: r["병합"] ?? [], 응답_ms: a.ms,
    행: rows,
    안내: (next != null ? `행이 더 있습니다 — 이어 읽으려면 start=${next} 로 다시 부르세요. `
        : r["앞부분만읽음"] === true ? "파일이 커서 앞부분만 읽었습니다 — 전체가 아니라고 밝히세요. "
        : "이 시트의 끝까지 읽었습니다. ") +
      "'행'의 첫 값은 엑셀 행 번호입니다. 머리글행은 추정이니 어긋나 보이면 start 로 직접 지정하세요. " +
      "이 값은 문서에서 읽은 것(미확인)입니다 — 문서 이름·시트·행 번호를 근거로 밝히고, ERP 값과 다르면 고치지 말고 차이로 알려 주세요.",
  };
}
