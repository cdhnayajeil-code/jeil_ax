// llm/index.ts — 벤더 → 어댑터 등록부. 새 벤더는 여기에 한 줄.
import type { LlmAdapter } from "./types.ts";
import { openaiAdapter } from "./openai.ts";
import { anthropicAdapter } from "./anthropic.ts";

export const ADAPTERS: Record<string, LlmAdapter> = { openai: openaiAdapter, anthropic: anthropicAdapter };

/** 이 서버에서 실제로 부를 수 있는 벤더 — 어댑터가 있고 **키 시크릿이 등록된** 것만. */
export function readyVendors(): string[] {
  return Object.values(ADAPTERS).filter((a) => !!Deno.env.get(a.keyEnv)).map((a) => a.vendor);
}
export type { ChatMsg, LlmAdapter, StreamState, ToolCall } from "./types.ts";
