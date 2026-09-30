// core/engine.ts — 대화 루프 1개(실험실 · 부서 에이전트 · 골든셋 회귀가 공유). REQ-0084 의 index.ts 루프를 옮겼다(동작 동일)
// + 벤더 선택·예비 모델 전환·Claude 캐시 토큰·thinking 원문 되돌리기(REQ-0085)를 더했다.
import type { ErpScope, ToolModule } from "./types.ts";
import { gateDeny } from "./scope.ts";
import { ADAPTERS, type ChatMsg, type StreamState } from "../llm/index.ts";

export type ToolTrace = {
  round: number; tool: string; version: string | null; kind: string | null; perm_module: string | null;
  args: Record<string, unknown>; ms: number; outcome: string; rows: number | null; gated: boolean; has_view: boolean;
  result_chars: number; result_preview: string; sensitivity: string | null;
};
export type ConverseResult = {
  model: string; vendor: string; fallbackUsed: boolean; answer: string; tools: ToolTrace[]; rounds: number;
  stopped: boolean; state: StreamState; llmError: { status: number; detail: string } | null;
  // 예비 전환이 있었으면 왜(벤더 오류 본문 앞부분) — 09-30 실측에서 SSE 로만 흘러 원인 추적이 안 됐다. 턴 기록에 남긴다.
  fallbackNote: { from: string; to: string; status: number; detail: string } | null;
};
export type ConverseOpts = {
  // deno-lint-ignore no-explicit-any
  admin: any; userToken: string; scope: ErpScope;
  model: string; vendorOf: (model: string) => string; fallbackModel?: string | null;
  modules: ToolModule[]; system: string; messages: ChatMsg[];
  maxTokens: number; temperature: number | null; effort?: string | null; caching?: boolean; maxRounds: number;
  signal?: AbortSignal; isGone?: () => boolean;
  emit?: (c: string) => Promise<void>;                      // 본문 조각(없으면 모음만)
  onView?: (view: unknown) => Promise<void>;                // 구조화 뷰(카드)
  onTool?: (t: ToolTrace) => Promise<void>;                 // 추적
  onNote?: (o: Record<string, unknown>) => Promise<void>;   // 모델 오류·반복 중단·예비 전환
};

/** 결과에서 건수·결과 유형을 뽑는다(추적·턴 기록용). */
export function outcomeOf(result: unknown, view: unknown): { outcome: string; rows: number | null } {
  // deno-lint-ignore no-explicit-any
  const r = (result || {}) as any; const v = (view || {}) as any;
  if (r.접근제한) return { outcome: "denied", rows: null };
  if (r.오류) return { outcome: "error", rows: null };
  const n = Array.isArray(v.rows) ? v.rows.length
    : Array.isArray(v.fields) ? v.fields.length
    : Array.isArray(r.목록) ? r.목록.length
    : typeof r.건수 === "number" ? r.건수 : null;
  return { outcome: n === 0 ? "empty" : "ok", rows: n };
}

export async function converse(o: ConverseOpts): Promise<ConverseResult> {
  const state: StreamState = { pt: 0, ct: 0, cr: 0, cw: 0, toolCalls: {} };
  const tools: ToolTrace[] = [];
  const byId = new Map(o.modules.map((m) => [m.manifest.id, m]));
  let answer = "";
  let model = o.model;
  let vendor = o.vendorOf(model);
  let fallbackUsed = false;
  let rounds = 0; let stopped = false;
  let llmError: { status: number; detail: string } | null = null;
  let fallbackNote: ConverseResult["fallbackNote"] = null;
  let emitted = false;
  const emit = async (c: string) => { emitted = true; answer += c; if (o.emit) await o.emit(c); };
  const convo: ChatMsg[] = [{ role: "system", content: o.system }, ...o.messages];
  let lastSig = "";

  for (let round = 0; round < o.maxRounds; round++) {
    if (o.isGone && o.isGone()) { stopped = true; break; }
    rounds = round + 1;
    const lastRound = round === o.maxRounds - 1;
    state.toolCalls = {};
    let adapter = ADAPTERS[vendor];
    let apiKey = adapter ? Deno.env.get(adapter.keyEnv) : undefined;
    let r = adapter && apiKey
      ? await adapter.round({ apiKey, model, messages: convo, tools: lastRound ? null : o.modules.map((m) => m.manifest),
          maxTokens: o.maxTokens, temperature: o.temperature, effort: o.effort, caching: o.caching, signal: o.signal, emit, state })
      : { ok: false, status: 503, detail: `${vendor} 키 미등록` };
    // 예비 모델 — 아직 아무것도 내보내지 않았고 첫 라운드에서 실패했을 때만 1회 전환(대화 중간에 벤더를 바꾸면 도구 턴 형식이 어긋난다)
    if (!r.ok && round === 0 && !emitted && o.fallbackModel && o.fallbackModel !== model) {
      const fbVendor = o.vendorOf(o.fallbackModel);
      const fb = ADAPTERS[fbVendor]; const fbKey = fb ? Deno.env.get(fb.keyEnv) : undefined;
      if (fb && fbKey) {
        fallbackNote = { from: model, to: o.fallbackModel, status: r.status, detail: r.detail.slice(0, 300) };
        console.error(`llm fallback ${model} → ${o.fallbackModel} (${r.status}) ${r.detail.slice(0, 300)}`);
        if (o.onNote) await o.onNote({ type: "fallback", from: model, to: o.fallbackModel, status: r.status, detail: r.detail.slice(0, 200) });
        model = o.fallbackModel; vendor = fbVendor; adapter = fb; apiKey = fbKey; fallbackUsed = true;
        state.toolCalls = {};
        r = await adapter.round({ apiKey, model, messages: convo, tools: lastRound ? null : o.modules.map((m) => m.manifest),
          maxTokens: o.maxTokens, temperature: fbVendor === "openai" ? (o.temperature ?? 0.3) : null, effort: null,
          caching: o.caching, signal: o.signal, emit, state });
      }
    }
    if (!r.ok) {
      llmError = { status: r.status, detail: r.detail };
      console.error(`llm error ${model} (${r.status}) ${r.detail.slice(0, 300)}`);
      await emit(r.status === 401 ? "⚠ AI 키가 유효하지 않습니다(만료/오입력)."
        : r.status === 429 ? "⚠ AI 사용량 한도 초과 — 잠시 후 다시 시도하세요."
        : r.status === 503 ? "⚠ AI 연결이 아직 설정되지 않았습니다(관리자 확인 필요)."
        : "⚠ AI 응답 생성에 실패했습니다.");
      if (o.onNote) await o.onNote({ type: "llm_error", status: r.status, detail: r.detail.slice(0, 300) });
      break;
    }
    const calls = Object.values(state.toolCalls).filter((c) => c.name);
    if (!calls.length) break;
    const sig = calls.map((c) => c.name + ":" + c.args).sort().join("|");
    if (sig === lastSig) { if (o.onNote) await o.onNote({ type: "loop_stop", round: rounds }); break; }
    lastSig = sig;
    convo.push({ role: "assistant_tools", calls, raw: state.raw || null });
    for (const c of calls) {
      const mod = byId.get(c.name);
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(c.args || "{}"); } catch { /* 빈 인자 */ }
      const ts = Date.now();
      let result: unknown; let gated = false;
      if (!mod) result = { 오류: `알 수 없는 도구: ${c.name}` };
      else {
        // 실행 직전 2차 방어선 — 주입 단계와 무관하게 권한을 다시 본다(13 기획 §2-5 ④)
        const deny = gateDeny(mod.manifest, o.scope);
        if (deny) { result = deny; gated = true; }
        else {
          try { result = await mod.run({ admin: o.admin, args, asOf: new Date().toISOString(), scope: o.scope, userToken: o.userToken }); }
          catch (e) { result = { 오류: "조회 실패: " + (e instanceof Error ? e.message : String(e)) }; }
        }
      }
      const ms = Date.now() - ts;
      const ro = result as Record<string, unknown> | null;
      const view = ro && typeof ro === "object" ? ro.__view : null;
      if (ro && view) { delete ro.__view; if (o.onView) await o.onView(view); }
      const modelText = JSON.stringify(result).slice(0, 12000);
      const oc = outcomeOf(result, view);
      const t: ToolTrace = { round: rounds, tool: c.name, version: mod?.manifest.version ?? null, kind: mod?.manifest.kind ?? null,
        perm_module: mod?.manifest.perm_module ?? null, args, ms, outcome: oc.outcome, rows: oc.rows, gated, has_view: !!view,
        result_chars: modelText.length, result_preview: modelText.slice(0, 1500), sensitivity: mod?.manifest.sensitivity ?? null };
      tools.push(t);
      if (o.onTool) await o.onTool(t);
      convo.push({ role: "tool", call_id: c.id, content: modelText });
    }
  }
  return { model, vendor, fallbackUsed, answer, tools, rounds, stopped, state, llmError, fallbackNote };
}
