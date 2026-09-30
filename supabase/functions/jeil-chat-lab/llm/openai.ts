// llm/openai.ts — OpenAI 어댑터(13 기획 §2 · 벤더 중립). 게이트웨이는 LlmAdapter 인터페이스만 안다.
// 원본: 운영 jeil-chat 의 callOpenAI·pumpStream(동작 동일). 다른 벤더는 같은 인터페이스로 llm/<vendor>.ts 를 추가한다.
import type { ToolManifest } from "../core/types.ts";
import type { ChatMsg, LlmAdapter, StreamState } from "./types.ts";
export type { ChatMsg, LlmAdapter, LlmRoundResult, StreamState, ToolCall } from "./types.ts";

function toOpenAiMessages(msgs: ChatMsg[]): unknown[] {
  return msgs.map((m) => {
    if (m.role === "assistant_tools") {
      return { role: "assistant", content: null,
        tool_calls: m.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })) };
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.call_id, content: m.content };
    if (m.role === "user" && m.parts && m.parts.length) {
      // 첨부(REQ-0089): 글자·이미지는 그대로, PDF 는 이 어댑터에서 읽지 않는다 → 안내 문구로 바꾼다(Claude 연결 시 원본 판독)
      const content: unknown[] = m.parts.map((p) =>
        p.kind === "image" ? { type: "image_url", image_url: { url: `data:${p.media};base64,${p.data}` } }
        : p.kind === "pdf" ? { type: "text", text: `[첨부 파일: ${p.name}] (PDF — 지금 연결된 모델은 PDF 를 읽지 못합니다. 사용자에게 엑셀·CSV 로 다시 올리거나 Claude 연결 후 시도하라고 안내하세요.)` }
        : { type: "text", text: `[첨부 파일: ${p.name}]\n${p.text}` });
      content.push({ type: "text", text: m.content });
      return { role: "user", content };
    }
    return { role: m.role, content: m.content };
  });
}
const toOpenAiTools = (ts: ToolManifest[]) =>
  ts.map((t) => ({ type: "function", function: { name: t.id, description: t.description_llm, parameters: t.params } }));

/* ===== 요청 모양 자동 적응 (모델 세대 차이 흡수) =====
   세대에 따라 `temperature` 를 거부하거나 `max_tokens` 대신 `max_completion_tokens` 를 요구하고,
   추론 모델은 도구와 함께 부를 때 `reasoning_effort:"none"` 을 요구한다(2026-09-30 gpt-6-luna 실측 · REQ-0095).
   모델 목록을 코드에 박지 않는다 — 400 사유를 읽어 고쳐 한 번 더 보내고, 통한 모양을 모델별로 기억한다.
   공식 가격표는 파라미터를 알려 주지 않으므로 「어느 모델이 무엇을 받는지」를 우리가 단정하지 않는 편이 안전하다.
   ※ 아래 `type OaShape` ~ `oaAdjust` 는 운영 jeil-chat/index.ts 의 사본 — **글자 단위로 같아야 한다**(`node _test_oa_shape.mjs` 가 검사). */
type OaShape = { temp: boolean; maxKey: "max_tokens" | "max_completion_tokens"; reasoning: "none" | null };
const OA_SHAPE = new Map<string, OaShape>();
const oaShape = (model: string): OaShape => OA_SHAPE.get(model) || { temp: true, maxKey: "max_tokens", reasoning: null };

/** 400 사유의 파라미터 이름 — 본문 JSON 의 error.param 우선, JSON 이 아니면 문구 정규식 폴백(벤더 문구 변경 내성) */
function oaParam(detail: string): string {
  try {
    const p = JSON.parse(detail)?.error?.param;
    if (typeof p === "string" && p) return p.toLowerCase();
  } catch { /* JSON 아님 — 문구로 판독 */ }
  const d = detail.toLowerCase();
  if (/reasoning_effort/.test(d)) return "reasoning_effort";
  if (/max_completion_tokens|max_tokens/.test(d)) return "max_tokens";
  if (/temperature/.test(d)) return "temperature";
  return "";
}

/** 400 사유를 보고 요청 모양을 한 단계 고친다. 고칠 게 없으면 null(=포기).
    이미 적용한 손잡이를 또 요구하면 null — 같은 사유로 무한 재시도하지 않는다. */
function oaAdjust(model: string, detail: string): OaShape | null {
  const p = oaParam(detail);
  const cur = oaShape(model);
  if (p === "temperature" && cur.temp) {
    const next: OaShape = { ...cur, temp: false };
    OA_SHAPE.set(model, next);
    console.log("openai shape: " + model + " → temperature 미전송");
    return next;
  }
  if ((p === "max_tokens" || p === "max_completion_tokens") && cur.maxKey === "max_tokens") {
    const next: OaShape = { ...cur, maxKey: "max_completion_tokens" };
    OA_SHAPE.set(model, next);
    console.log("openai shape: " + model + " → max_completion_tokens 사용");
    return next;
  }
  // 추론 모델(gpt-6 계열)은 chat/completions 에서 도구와 reasoning_effort 를 함께 받지 않는다 — 벤더 오류문이 none 을 지시(2026-09-30 실측)
  if (p === "reasoning_effort" && !cur.reasoning) {
    const next: OaShape = { ...cur, reasoning: "none" };
    OA_SHAPE.set(model, next);
    console.log("openai shape: " + model + " → reasoning_effort none(도구 병용 · 추론 끔)");
    return next;
  }
  return null;
}

async function pump(body: ReadableStream<Uint8Array>, emit: (c: string) => Promise<void>, state: StreamState) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const ln of lines) {
      const t = ln.trim();
      if (!t.startsWith("data:")) continue;
      const p = t.slice(5).trim();
      if (p === "[DONE]") continue;
      // deno-lint-ignore no-explicit-any
      let ev: any; try { ev = JSON.parse(p); } catch { continue; }
      if (ev.usage) { state.pt += ev.usage.prompt_tokens || 0; state.ct += ev.usage.completion_tokens || 0; }
      const d = ev.choices?.[0]?.delta;
      if (!d) continue;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          const cur = (state.toolCalls[i] = state.toolCalls[i] || { id: "", name: "", args: "" });
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
        }
      }
      if (typeof d.content === "string" && d.content) await emit(d.content);
    }
  }
}

export const openaiAdapter: LlmAdapter = {
  vendor: "openai",
  keyEnv: "OPENAI_API_KEY",
  async round({ apiKey, model, messages, tools, maxTokens, temperature, signal, emit, state }) {
    state.raw = null; state.stop = null;
    // 400 이면 요청 모양을 고쳐 최대 3회까지 다시 보낸다(temperature → max_completion_tokens → reasoning_effort). 그 외 오류는 그대로 돌려준다.
    let shape = oaShape(model);
    let res = await send(shape);
    for (let i = 0; i < 3 && res.status === 400; i++) {
      const detail = await res.clone().text().catch(() => "");
      const next = oaAdjust(model, detail);
      if (!next) break;
      shape = next;
      res = await send(shape);
    }
    if (!res.ok || !res.body) return { ok: false, status: res.status, detail: (await res.text().catch(() => "")).slice(0, 500) };
    await pump(res.body, emit, state);
    return { ok: true, status: res.status, detail: "" };

    function send(sh: OaShape) {
      return fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model, stream: true, messages: toOpenAiMessages(messages),
          [sh.maxKey]: maxTokens,
          ...(sh.temp && temperature != null ? { temperature } : {}),
          ...(sh.reasoning ? { reasoning_effort: sh.reasoning } : {}),   // 학습된 뒤에는 도구 유무와 무관하게 유지
          stream_options: { include_usage: true },
          ...(tools && tools.length ? { tools: toOpenAiTools(tools) } : {}),
        }),
      });
    }
  },
};
