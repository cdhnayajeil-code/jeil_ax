// modules/purchase/_agent_util.ts — 부서 에이전트용 손작성 모듈 공용 헬퍼(REQ-0087).

/** 사용자·모델이 준 검색어를 PostgREST or() 필터에 안전한 글자만 남긴다(쉼표·괄호·와일드카드 제거, 40자). */
export function clean(v: unknown): string {
  return String(v ?? "").replace(/[,()*%\\:"'`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}
export const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
export const isYm = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}$/.test(v);

/** 기안서 대장 페이지 권한(perm_effective.pages 의 purchase_proposal_2026) — 원 화면·RPC 와 같은 판정. */
// deno-lint-ignore no-explicit-any
export function canProposal(scope: any): boolean {
  return !!scope.isAdmin || (scope.pages || []).some((p: { page_key: string; allowed: boolean }) => p.page_key === "purchase_proposal_2026" && p.allowed);
}
export function proposalDeny() {
  const text = "기안서 대장은 「구매 기안서 대장」 화면 열람 권한이 있는 사용자만 볼 수 있습니다. 필요하면 포털 관리자에게 권한을 요청해 주세요.";
  return { 접근제한: true, 안내: text, __view: { view: "notice", title: "기안서 대장 권한 안내", kind: "deny", text } };
}

/** 대사 등급 — 기안서 대장 화면(RECON 표)과 같은 라벨. */
export const RECON_KO: Record<string, string> = {
  match: "일치", vat: "세액차", split: "합산·분할", noinv: "계산서없음", noslip: "전표없음", diff: "확인필요", none: "미기재", "": "—",
};
export const STAGE_KO: Record<string, string> = { dp: "선급", mp: "중도", bp: "잔금" };
