// _nas_query.ts — 사내 NAS 실시간 조회 공용 헬퍼(REQ-0103 · ADR-110 v3 · 정본 SQL 86). 손으로 쓴 모듈.
// NAS 는 사내 내부망 안이라 여기서 직접 부를 수 없다. 그래서 「요청 한 줄 넣기 → 사내 워커가 물고 있던 연결로
// 받아 처리 → 결과를 되쓰면 여기서 읽기」 순서로 간다. 엔진에는 도구 타임아웃이 없으므로(core/engine.ts)
// **이 헬퍼가 스스로 상한을 건다** — 넘으면 지어내지 않고 「보관소 점검 중」으로 답한다(§16.6).
import type { ErpScope, ViewPayload } from "../../core/types.ts";

export type NasState = "done" | "offline" | "timeout" | "no_scope" | "denied" | "busy" | "failed" | "error";
export interface NasAnswer { state: NasState; result?: Record<string, unknown>; ms?: number; message?: string }

const POLL_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 요청을 넣고 결과를 기다린다. deadlineMs 를 넘기면 timeout. 볼 수 있는 범위는 DB 함수가 계산한다. */
// deno-lint-ignore no-explicit-any
export async function nasQuery(admin: any, scope: ErpScope, kind: "file_list" | "turn_history" | "doc_search" | "doc_read",
  params: Record<string, unknown>, deadlineMs = 8000): Promise<NasAnswer> {
  const t0 = Date.now();
  const sub = await admin.rpc("nas_query_submit", {
    p_upn: scope.upn, p_kind: kind, p_params: params, p_depts: scope.depts || [], p_is_admin: !!scope.isAdmin,
  });
  if (sub.error) return { state: "error", message: sub.error.message };
  const st = String(sub.data?.status || "");
  if (st !== "queued") return { state: (["offline", "no_scope", "denied", "busy"].includes(st) ? st : "error") as NasState };
  const id = sub.data.query_id;

  while (Date.now() - t0 + POLL_MS < deadlineMs) {
    await sleep(POLL_MS);
    const p = await admin.rpc("nas_query_poll", { p_query_id: id });
    if (p.error) return { state: "error", message: p.error.message };
    const s = String(p.data?.status || "");
    if (s === "done") return { state: "done", result: (p.data.result || {}) as Record<string, unknown>, ms: Date.now() - t0 };
    if (s === "failed") return { state: "failed", message: String(p.data.error || "") };
    if (s === "expired" || s === "missing") return { state: "timeout" };
  }
  return { state: "timeout" };
}

/** done 이 아닐 때의 답. 「오류」 키를 쓰지 않는다 — 보관소가 꺼진 것은 답변 품질 문제가 아니라서
 *  개선 대장(자동 플래그)에 쌓이면 안 된다. 모델에는 사실만 알려 지어내지 않게 한다. */
export function nasNotice(a: NasAnswer, what: string): Record<string, unknown> {
  const T: Record<string, [string, string]> = {
    offline: ["사내 보관소 점검 중", `사내 보관소(NAS)와 연결이 닿지 않아 ${what}을(를) 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.`],
    timeout: ["사내 보관소 응답 지연", `사내 보관소(NAS)가 제때 응답하지 않아 ${what}을(를) 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.`],
    no_scope: ["조회 폴더 미등록", "에이전트가 볼 수 있는 사내 보관소 폴더가 아직 등록되지 않았습니다. 관리자에게 폴더 등록을 요청하세요."],
    denied: ["볼 수 있는 폴더 없음", "등록된 폴더 가운데 지금 계정으로 볼 수 있는 폴더가 없습니다(본인 부서 폴더·전사공유 폴더만 조회됩니다)."],
    busy: ["요청이 너무 잦음", "짧은 시간에 조회가 많아 잠시 막았습니다. 1분 뒤 다시 시도해 주세요."],
    failed: ["사내 보관소 조회 실패", `사내 보관소에서 ${what}을(를) 읽는 중 문제가 생겼습니다. 관리자에게 알려 주세요.`],
    error: ["사내 보관소 조회 실패", `${what} 요청을 접수하지 못했습니다. 관리자에게 알려 주세요.`],
  };
  const [title, text] = T[a.state] || T.error;
  return {
    상태: title, 확인여부: "확인하지 못함", 안내: text + " 확인하지 못한 내용을 추측해서 답하지 마세요.",
    __view: { view: "notice", title, kind: a.state === "denied" || a.state === "no_scope" ? "deny" : "info", text } satisfies ViewPayload,
  };
}

/** 모델이 준 문자열 인자 정리 — 제어문자 제거·길이 제한. */
export function tidy(v: unknown, max = 80): string {
  // deno-lint-ignore no-control-regex
  return String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}
