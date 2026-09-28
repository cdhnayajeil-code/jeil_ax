// core/config.ts — 사용모델 설정 로드·라우팅(SSOT: ai_gateway_config / ai_model / ai_routing_rule).
// 운영 jeil-chat 의 loadAiConfig·usableModels·pickModel·priceFor 원본을 옮겼다. 벤더 판정만 어댑터 목록으로 일반화.
import { LEGACY_SYSTEM_PROMPT } from "./prompt.ts";

const MAX_MESSAGES = 20;
const MAX_TOTAL_CHARS = 24000;
const MAX_TOKENS = 1024;
const DEFAULT_TEMP = 0.3;

const PRICES: Record<string, { inp: number; out: number }> = {
  "gpt-4o-mini": { inp: 0.15, out: 0.60 },
  "gpt-4o": { inp: 2.50, out: 10.00 },
  "gpt-4.1-mini": { inp: 0.40, out: 1.60 },
};

export type AiModelRow = { model_id: string; vendor: string; label?: string; active: boolean; callable: boolean; price_in: number; price_out: number };
export type AiRuleRow = { seq: number; rule_type: string; match_keywords: string[] | null; min_chars: number | null; model_id: string; active: boolean };
export type AiConfig = {
  default_model: string; max_tokens: number; temperature: number;
  max_messages: number; max_total_chars: number; system_prompt: string; db_prompt_set: boolean;
  models: AiModelRow[]; rules: AiRuleRow[];
};

function fallbackConfig(): AiConfig {
  return {
    default_model: Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini",
    max_tokens: MAX_TOKENS, temperature: DEFAULT_TEMP,
    max_messages: MAX_MESSAGES, max_total_chars: MAX_TOTAL_CHARS,
    system_prompt: LEGACY_SYSTEM_PROMPT, db_prompt_set: false,
    models: [], rules: [],
  };
}

// deno-lint-ignore no-explicit-any
export async function loadAiConfig(admin: any): Promise<AiConfig> {
  try {
    const [cfgR, modR, rulR] = await Promise.all([
      admin.from("ai_gateway_config").select("default_model,max_tokens,temperature,max_messages,max_total_chars,system_prompt").eq("id", 1).maybeSingle(),
      admin.from("ai_model").select("model_id,vendor,label,active,callable,price_in,price_out"),
      admin.from("ai_routing_rule").select("seq,rule_type,match_keywords,min_chars,model_id,active").eq("active", true).order("seq"),
    ]);
    const c = cfgR.data;
    if (!c) return fallbackConfig();
    return {
      default_model: c.default_model || fallbackConfig().default_model,
      max_tokens: Number(c.max_tokens) || MAX_TOKENS,
      temperature: c.temperature != null ? Number(c.temperature) : DEFAULT_TEMP,
      max_messages: Number(c.max_messages) || MAX_MESSAGES,
      max_total_chars: Number(c.max_total_chars) || MAX_TOTAL_CHARS,
      system_prompt: c.system_prompt || LEGACY_SYSTEM_PROMPT,
      db_prompt_set: !!c.system_prompt,
      models: (modR.data as AiModelRow[]) || [],
      rules: (rulR.data as AiRuleRow[]) || [],
    };
  } catch {
    return fallbackConfig();
  }
}

/** 실제 호출 가능한 모델 — active+callable 이고 **어댑터가 있는 벤더**만. */
export function usableModels(ai: AiConfig, vendors: string[]): Map<string, AiModelRow> {
  return new Map(
    ai.models.filter((m) => m.active && m.callable && vendors.includes(String(m.vendor).toLowerCase()))
      .map((m) => [m.model_id, m]),
  );
}

// 라우팅: keyword_length 규칙만 실제 적용(대상 모델이 usable일 때). 미매칭이면 기본 모델(usable 검증·폴백).
export function pickModel(userText: string, ai: AiConfig, vendors: string[]): string {
  const usable = usableModels(ai, vendors);
  const envModel = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
  const safeDefault = usable.has(ai.default_model)
    ? ai.default_model
    : (usable.size ? [...usable.keys()][0] : envModel);
  const text = String(userText || "");
  for (const rule of ai.rules) {
    if (rule.rule_type !== "keyword_length") continue;
    const kwHit = (rule.match_keywords || []).some((k) => k && text.includes(k));
    const lenHit = rule.min_chars != null && rule.min_chars > 0 && text.length >= rule.min_chars;
    if ((kwHit || lenHit) && usable.has(rule.model_id)) return rule.model_id;
  }
  return safeDefault;
}

export function priceFor(model: string, ai: AiConfig): { inp: number; out: number } {
  const m = ai.models.find((x) => x.model_id === model);
  if (m && (m.price_in || m.price_out)) return { inp: Number(m.price_in), out: Number(m.price_out) };
  return PRICES[model] || PRICES["gpt-4o-mini"];
}
