// llm/openai.ts — OpenAI 어댑터(13 기획 §2 · 벤더 중립). 게이트웨이는 LlmAdapter 인터페이스만 안다.
// 원본: 운영 jeil-chat 의 callOpenAI·pumpStream(동작 동일). 다른 벤더는 같은 인터페이스로 llm/<vendor>.ts 를 추가한다.
import type { ToolManifest } from "../core/types.ts";

export type ToolCall = { id: string; name: string; args: string };
export type StreamState = { pt: number; ct: number; toolCalls: Record<number, ToolCall> };
/** 대화 메시지 — 벤더 중립 표현. 어댑터가 자기 형식으로 바꾼다. */
export type ChatMsg =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant_tools"; calls: ToolCall[] }
  | { role: "tool"; call_id: string; content: string };

/** 1라운드 결과 — 실패면 ok=false 와 상태코드·요약. */
export type LlmRoundResult = { ok: boolean; status: number; detail: string };

export interface LlmAdapter {
  vendor: string;
  /** 스트리밍 1라운드. 본문 조각은 emit, 도구 호출·토큰은 state 에 쌓는다. 실패하면 {ok:false,status,detail}. */
  round(opts: {
    apiKey: string; model: string; messages: ChatMsg[]; tools: ToolManifest[] | null;
    maxTokens: number; temperature: number; signal?: AbortSignal;
    emit: (c: string) => Promise<void>; state: StreamState;
  }): Promise<LlmRoundResult>;
  keyEnv: string;
}

function toOpenAiMessages(msgs: ChatMsg[]): unknown[] {
  return msgs.map((m) => {
    if (m.role === "assistant_tools") {
      return { role: "assistant", content: null,
        tool_calls: m.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })) };
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.call_id, content: m.content };
    return { role: m.role, content: m.content };
  });
}
const toOpenAiTools = (ts: ToolManifest[]) =>
  ts.map((t) => ({ type: "function", function: { name: t.id, description: t.description_llm, parameters: t.params } }));

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
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, stream: true, max_tokens: maxTokens, temperature, messages: toOpenAiMessages(messages),
        stream_options: { include_usage: true },
        ...(tools && tools.length ? { tools: toOpenAiTools(tools) } : {}),
      }),
    });
    if (!res.ok || !res.body) return { ok: false, status: res.status, detail: (await res.text().catch(() => "")).slice(0, 500) };
    await pump(res.body, emit, state);
    return { ok: true, status: res.status, detail: "" };
  },
};

/** 벤더 → 어댑터. 새 벤더는 여기에 한 줄. */
export const ADAPTERS: Record<string, LlmAdapter> = { openai: openaiAdapter };
