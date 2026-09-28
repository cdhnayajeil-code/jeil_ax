// llm/types.ts — 벤더 어댑터 공통 타입(13 기획 §2 · 14 기획 §6). 게이트웨이는 이 인터페이스만 안다.
import type { ToolManifest } from "../core/types.ts";

export type ToolCall = { id: string; name: string; args: string };
/** 1라운드 동안 어댑터가 채우는 상태. raw = 벤더 고유의 assistant 내용(도구 호출 턴을 되돌려 줄 때 그대로 쓴다). */
export type StreamState = {
  pt: number; ct: number;           // 입력(캐시 제외)·출력 토큰
  cr?: number; cw?: number;         // 캐시 읽기·쓰기 토큰(Claude)
  toolCalls: Record<number, ToolCall>;
  raw?: { vendor: string; content: unknown } | null;
  stop?: string | null;             // 벤더 stop_reason(refusal·max_tokens 판단용)
};
/** 대화 메시지 — 벤더 중립 표현. 어댑터가 자기 형식으로 바꾼다. */
export type ChatMsg =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant_tools"; calls: ToolCall[]; raw?: { vendor: string; content: unknown } | null }
  | { role: "tool"; call_id: string; content: string };

/** 1라운드 결과 — 실패면 ok=false 와 상태코드·요약. */
export type LlmRoundResult = { ok: boolean; status: number; detail: string };

export type RoundOpts = {
  apiKey: string; model: string; messages: ChatMsg[]; tools: ToolManifest[] | null;
  maxTokens: number;
  temperature: number | null;       // 벤더·모델이 받지 않으면 어댑터가 버린다(Claude Sonnet 5)
  effort?: string | null;           // Claude 추론강도(low~max). OpenAI 는 무시
  caching?: boolean;                // Claude 프롬프트 캐싱(도구+시스템 프롬프트)
  signal?: AbortSignal;
  emit: (c: string) => Promise<void>;
  state: StreamState;
};

export interface LlmAdapter {
  vendor: string;
  keyEnv: string;
  /** 스트리밍 1라운드. 본문 조각은 emit, 도구 호출·토큰은 state 에 쌓는다. */
  round(opts: RoundOpts): Promise<LlmRoundResult>;
}
