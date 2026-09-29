// llm/anthropic.ts — Claude 어댑터(14 기획 §6 · REQ-0085). OpenAI 어댑터와 같은 LlmAdapter 인터페이스.
//
// OpenAI 와 다른 점(여기서 흡수한다 — 게이트웨이·모듈은 모른다)
//   · 시스템 프롬프트는 messages 가 아니라 top-level system. 도구 결과는 한 user 메시지에 tool_result 블록으로 **모아서** 준다.
//   · Sonnet 5 는 temperature 를 받지 않는다(보내면 400) → 보내지 않는다. 깊이는 추론강도(output_config.effort)로 조절.
//   · 추론(thinking)이 켜진 채 도구를 부르면, 다음 요청에 그 턴의 assistant 내용(thinking 블록 포함)을 **바꾸지 않고** 돌려줘야 한다
//     → finalMessage().content 를 state.raw 에 담고, 게이트웨이가 assistant_tools.raw 로 되돌려 준다.
//   · 프롬프트 캐싱: 도구 정의 + 시스템 프롬프트는 매 질문 같다 → system 블록 끝에 cache_control(도구가 system 앞에 렌더되므로 함께 캐시).
//   · Haiku 4.5 는 effort·adaptive thinking 을 받지 않는다 → 보내지 않는다(분류·채점 전용).
import Anthropic from "npm:@anthropic-ai/sdk";
import type { ToolManifest } from "../core/types.ts";
import type { ChatMsg, LlmAdapter, RoundOpts } from "./types.ts";

// deno-lint-ignore no-explicit-any
type Block = Record<string, any>;

function toClaude(msgs: ChatMsg[]): { system: string; messages: Block[] } {
  const system = msgs.filter((m) => m.role === "system").map((m) => ("content" in m ? String(m.content) : "")).join("\n\n");
  const out: Block[] = [];
  for (const m of msgs) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const blk = { type: "tool_result", tool_use_id: m.call_id, content: m.content };
      const last = out[out.length - 1];
      // 병렬 호출 결과는 **한 메시지**에 모은다 — 나눠 보내면 모델이 병렬 호출을 덜 하게 된다
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every((b: Block) => b.type === "tool_result")) {
        last.content.push(blk);
      } else out.push({ role: "user", content: [blk] });
      continue;
    }
    if (m.role === "assistant_tools") {
      const content = m.raw && m.raw.vendor === "anthropic" && Array.isArray(m.raw.content)
        ? m.raw.content
        : m.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: safeJson(c.args) }));
      out.push({ role: "assistant", content });
      continue;
    }
    if (m.role === "user" && m.parts && m.parts.length) {
      // 첨부는 질문보다 앞에 둔다(긴 자료 → 질문 순서가 답이 좋다). PDF 는 document 블록으로 Claude 가 직접 읽는다.
      const blocks: Block[] = m.parts.map((p) =>
        p.kind === "pdf" ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: p.data }, title: p.name }
        : p.kind === "image" ? { type: "image", source: { type: "base64", media_type: p.media, data: p.data } }
        : { type: "text", text: `[첨부 파일: ${p.name}]\n${p.text}` });
      blocks.push({ type: "text", text: m.content });
      out.push({ role: "user", content: blocks });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return { system, messages: out };
}
function safeJson(s: string): unknown { try { return JSON.parse(s || "{}"); } catch { return {}; } }

const toClaudeTools = (ts: ToolManifest[]) =>
  ts.map((t) => ({ name: t.id, description: t.description_llm, input_schema: t.params }));

const isHaiku = (model: string) => model.startsWith("claude-haiku");

export const anthropicAdapter: LlmAdapter = {
  vendor: "anthropic",
  keyEnv: "ANTHROPIC_API_KEY",
  async round({ apiKey, model, messages, tools, maxTokens, effort, caching, signal, emit, state }: RoundOpts) {
    state.raw = null; state.stop = null;
    const client = new Anthropic({ apiKey, maxRetries: 1 });
    const { system, messages: msgs } = toClaude(messages);
    const params: Block = {
      model, max_tokens: maxTokens, messages: msgs,
      system: [{ type: "text", text: system, ...(caching !== false ? { cache_control: { type: "ephemeral" } } : {}) }],
      ...(tools && tools.length ? { tools: toClaudeTools(tools) } : {}),
      ...(!isHaiku(model) && effort ? { output_config: { effort } } : {}),
    };
    try {
      // deno-lint-ignore no-explicit-any
      const stream = client.messages.stream(params as any, { signal });
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta" && ev.delta.text) await emit(ev.delta.text);
      }
      const msg = await stream.finalMessage();
      // deno-lint-ignore no-explicit-any
      const u = msg.usage as any;
      state.pt += u?.input_tokens || 0;
      state.ct += u?.output_tokens || 0;
      state.cr = (state.cr || 0) + (u?.cache_read_input_tokens || 0);
      state.cw = (state.cw || 0) + (u?.cache_creation_input_tokens || 0);
      state.stop = msg.stop_reason || null;
      if (msg.stop_reason === "refusal") {
        await emit("\n\n⚠ 이 요청은 모델이 답하지 않았습니다. 질문을 바꿔 다시 시도해 주세요.");
        return { ok: true, status: 200, detail: "" };
      }
      const uses = (msg.content as Block[]).filter((b) => b.type === "tool_use");
      // 출력 한도에 걸려 잘린 도구 호출은 실행하지 않는다(입력이 잘렸을 수 있다)
      if (msg.stop_reason === "max_tokens" && uses.length) return { ok: true, status: 200, detail: "" };
      uses.forEach((b, i) => { state.toolCalls[i] = { id: String(b.id), name: String(b.name), args: JSON.stringify(b.input ?? {}) }; });
      if (uses.length) state.raw = { vendor: "anthropic", content: msg.content };
      return { ok: true, status: 200, detail: "" };
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        return { ok: false, status: Number(e.status) || 500, detail: String(e.message || "").slice(0, 500) };
      }
      throw e; // 중지(Abort)·네트워크 오류는 게이트웨이가 처리
    }
  },
};
