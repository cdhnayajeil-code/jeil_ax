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
/** 사용자 첨부(REQ-0089). text = 화면이 글자로 푼 파일(CSV·엑셀·워드·텍스트), image·pdf = base64 원본.
 *  note = 예산 초과·벤더 미지원으로 원본 대신 넣는 안내 문구. */
export type Attachment =
  | { kind: "text"; name: string; text: string }
  | { kind: "image"; name: string; media: string; data: string }
  | { kind: "pdf"; name: string; data: string }
  | { kind: "note"; name: string; text: string };

/** 대화 메시지 — 벤더 중립 표현. 어댑터가 자기 형식으로 바꾼다. */
export type ChatMsg =
  | { role: "system" | "assistant"; content: string }
  | { role: "user"; content: string; parts?: Attachment[] }
  | { role: "assistant_tools"; calls: ToolCall[]; raw?: { vendor: string; content: unknown } | null }
  | { role: "tool"; call_id: string; content: string };

/** 1라운드 결과 — 실패면 ok=false 와 상태코드·요약. */
export type LlmRoundResult = { ok: boolean; status: number; detail: string };

export type RoundOpts = {
  apiKey: string; model: string; messages: ChatMsg[]; tools: ToolManifest[] | null;
  /** "none" = 도구 정의는 보내되 호출은 막는다(마무리 라운드 · REQ-0114). Claude 는 대화에 tool_use 가 남아 있으면 tools 없는 요청을 400 으로 거부하므로
   *  마지막 라운드에 tools 를 빼는 대신 이 값을 쓴다. 생략·"auto" = 모델이 고른다. */
  toolChoice?: "auto" | "none";
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
