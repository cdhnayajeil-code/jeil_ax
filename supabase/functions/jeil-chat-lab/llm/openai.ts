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
    state.raw = null; state.stop = null;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, stream: true, max_tokens: maxTokens, ...(temperature != null ? { temperature } : {}), messages: toOpenAiMessages(messages),
        stream_options: { include_usage: true },
        ...(tools && tools.length ? { tools: toOpenAiTools(tools) } : {}),
      }),
    });
    if (!res.ok || !res.body) return { ok: false, status: res.status, detail: (await res.text().catch(() => "")).slice(0, 500) };
    await pump(res.body, emit, state);
    return { ok: true, status: res.status, detail: "" };
  },
};
