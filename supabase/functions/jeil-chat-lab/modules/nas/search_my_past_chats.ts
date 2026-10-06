// search_my_past_chats — 사내 보관소(NAS)에 쌓인 **본인** 과거 대화 찾기(REQ-0103 · ADR-110 v3 P2). 손으로 쓴 모듈.
// 누구의 대화를 볼지는 DB(nas_query_submit)가 로그인 계정으로 박는다 — 인자로 남의 계정을 줄 수 없다.
// sensitivity=personal: 이 도구가 쓰인 턴은 답변을 기록에 남기지 않는다(과거 대화 내용이 다시 쌓이는 것을 막는다).
import type { ToolCtx, ToolManifest } from "../../core/types.ts";
import { nasList, nasNotice, nasQuery, tidy } from "./_nas_query.ts";

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export const manifest: ToolManifest = {
  id: "search_my_past_chats", version: "1.0.0", domain: "nas", kind: "read",
  title_ko: "내 과거 대화 찾기", summary_ko: "사내 보관소에 보관된 본인의 에이전트 대화 검색",
  description_llm: "로그인한 본인이 예전에 에이전트와 나눈 대화를 사내 보관소(NAS)에서 찾는다. '지난주에 물어본 미입고 건', " +
    "'전에 거래처 매입 물어봤던 답변 다시 보여줘' 류. q 로 질문·답변에 들어 있던 낱말을, date_from·date_to 로 기간을 좁힌다. " +
    "다른 사람의 대화는 조회되지 않는다. 보관소에는 하루 한 번 쌓이므로 오늘 나눈 대화는 아직 없을 수 있다.",
  params: { type: "object", properties: {
    q: { type: "string", description: "질문·답변에 포함된 낱말(부분일치)" },
    date_from: { type: "string", description: "시작일 YYYY-MM-DD" },
    date_to: { type: "string", description: "종료일 YYYY-MM-DD" },
    limit: { type: "integer", description: "표시 건수(기본 10, 최대 20)" },
  }, required: [] },
  perm_module: null, perm_mode: "self", sensitivity: "personal",
  view: ["list", "notice"], erp: false, owner: "포털 관리", status: "pilot",
  prompt_hint: "과거 대화는 그때의 답변입니다. 숫자가 들어 있으면 '당시 답변 기준'이라고 밝히고, 지금 값이 필요하면 해당 조회 도구를 다시 부르세요.",
};

export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope } = ctx;
  const q = tidy(args.q, 60);
  const from = tidy(args.date_from, 10);
  const to = tidy(args.date_to, 10);
  if ((from && !isDate(from)) || (to && !isDate(to))) return { 오류: "날짜는 YYYY-MM-DD 형식이어야 합니다." };
  const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 10), 1), 20);
  const params: Record<string, unknown> = { limit };
  if (q) params.q = q;
  if (from) params.date_from = from;
  if (to) params.date_to = to;

  const a = await nasQuery(admin, scope, "turn_history", params);
  if (a.state !== "done") return nasNotice(a, "과거 대화");

  const r = a.result || {};
  // deno-lint-ignore no-explicit-any
  const rows = (Array.isArray(r["목록"]) ? r["목록"] : []) as any[];
  const total = Number(r["해당"]) || rows.length;
  const 조건 = [q && `'${q}'`, (from || to) && `${from || "처음"}~${to || "지금"}`].filter(Boolean).join(" · ") || "전체";
  const cut = r["잘림"] === true;
  return {
    기준시각: asOf, 조건, 해당: total, 반환수: rows.length, 잘림: cut, 응답_ms: a.ms,
    목록: rows.map((x) => ({ 일시: x["일시"], 에이전트: x["에이전트"], 질문: x["질문"], 답변발췌: x["답변발췌"] })),
    안내: [
      "본인 대화만 조회했습니다. 답변은 당시 기준이며 발췌입니다.",
      "보관소에는 하루 한 번 쌓이므로 오늘 대화는 아직 없을 수 있습니다.",
      cut ? `조건에 맞는 대화는 ${total}건이고 그중 최근 ${rows.length}건만 보였습니다.` : "",
      rows.length === 0 ? "조건에 맞는 과거 대화가 없습니다." : "",
    ].filter(Boolean).join(" "),
    __view: nasList(`내 과거 대화 — ${조건}`, asOf, ["일시", "질문", "답변(발췌)"],
      rows.map((x) => [x["일시"], x["질문"], x["답변발췌"]]),
      cut ? `전체 ${total}건 중 최근 ${rows.length}건 · 본인 대화만` : "본인 대화만 · 당시 답변 기준"),
  };
}
