// list_company_files — 사내 보관소(NAS) 허용 폴더의 파일 목록(REQ-0103 · ADR-110 v3 P2). 손으로 쓴 모듈.
// 파일 **이름·수정일·크기**만 본다. 내용은 읽지 않는다(문서 내용 검색은 P3 — D-95 승인 뒤).
// 볼 수 있는 폴더는 DB(nas_query_submit)가 「허용 폴더 등록 ∩ 본인 부서·전사공유」로 계산한다 — 여기서 정하지 않는다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { nasNotice, nasQuery, tidy } from "./_nas_query.ts";

export const manifest: ToolManifest = {
  id: "list_company_files", version: "1.0.0", domain: "nas", kind: "read",
  title_ko: "사내 보관소 파일 목록", summary_ko: "NAS 허용 폴더(본인 부서·전사공유)의 파일 이름·수정일·크기",
  description_llm: "사내 보관소(NAS)의 부서 폴더·전사공유 폴더에 있는 파일 목록을 본다. 파일 이름·하위 경로·수정일·크기만 알 수 있고 " +
    "파일 내용은 읽지 못한다. '우리 부서 폴더에 최근 올라온 파일', '○○ 양식 파일 있어?', '이번 주 바뀐 문서' 류. " +
    "q 로 파일 이름 일부를, days 로 최근 며칠 안에 수정된 것만 좁힌다. 본인 부서 폴더와 전사공유 폴더만 조회된다.",
  params: { type: "object", properties: {
    q: { type: "string", description: "파일 이름에 포함된 글자(부분일치)" },
    days: { type: "integer", description: "최근 며칠 안에 수정된 파일만(예: 7). 생략하면 전체" },
    limit: { type: "integer", description: "표시 건수(기본 20, 최대 50)" },
  }, required: [] },
  perm_module: null, perm_mode: "partial", sensitivity: "normal",
  view: ["list", "notice"], erp: false, owner: "포털 관리", status: "pilot",
  prompt_hint: "사내 보관소 파일 목록은 이름·수정일만 알려 줍니다. 파일 안의 내용은 읽지 못했으니 내용을 아는 것처럼 말하지 마세요. " +
    "보관소가 '점검 중'이거나 '응답 지연'이면 확인하지 못했다고만 답하세요.",
};

export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope } = ctx;
  const q = tidy(args.q, 60);
  const days = Math.min(Math.max(Math.trunc(Number(args.days) || 0), 0), 3650);
  const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 20), 1), 50);
  const params: Record<string, unknown> = { limit };
  if (q) params.q = q;
  if (days) params.days = days;

  const a = await nasQuery(admin, scope, "file_list", params);
  if (a.state !== "done") return nasNotice(a, "파일 목록");

  const r = a.result || {};
  // deno-lint-ignore no-explicit-any
  const rows = (Array.isArray(r["목록"]) ? r["목록"] : []) as any[];
  const total = Number(r["해당"]) || rows.length;
  const 조건 = [q && `이름에 '${q}'`, days && `최근 ${days}일`].filter(Boolean).join(" · ") || "전체";
  const cut = r["잘림"] === true;
  const capped = r["훑기상한도달"] === true;
  const 안내 = [
    "파일 이름·수정일만 확인했습니다. 파일 내용은 읽지 않았습니다.",
    cut ? `조건에 맞는 파일은 ${total}건이고 그중 최근 ${rows.length}건만 보였습니다 — 전부가 아닙니다.` : "",
    capped ? "폴더가 커서 일부만 훑었습니다 — 없다고 단정하지 말고 이름·기간으로 좁혀 다시 조회하세요." : "",
    rows.length === 0 ? "조건에 맞는 파일이 없습니다(볼 수 있는 폴더 안에서)." : "",
  ].filter(Boolean).join(" ");
  return {
    기준시각: asOf, 조회폴더: r["폴더"] || [], 조건, 해당: total, 반환수: rows.length, 잘림: cut, 응답_ms: a.ms,
    목록: rows.map((x) => ({ 폴더: x["폴더"], 경로: x["경로"] || "", 이름: x["이름"], 수정일: x["수정일"], 크기_KB: x["크기_KB"] })),
    안내,
    __view: { view: "list", title: `사내 보관소 파일 — ${조건}`, asOf,
      columns: ["폴더", "하위 경로", "파일", "수정일", "크기(KB)"],
      rows: rows.map((x) => [x["폴더"], x["경로"] || "", x["이름"], x["수정일"], x["크기_KB"]]),
      note: cut ? `전체 ${total}건 중 최근 ${rows.length}건 · 이름·수정일만(내용 미확인)` : "이름·수정일만(내용 미확인) · 본인 부서·전사공유 폴더" } satisfies ViewPayload,
  };
}
