// core/agent.ts — 부서 에이전트 프로필(14 기획 §2 · ADR-109 · REQ-0086).
//   에이전트 = 프로필(ai_agent) + 설정 버전(ai_agent_version) + 구성원(ai_agent_member) + 용어집(agent_glossary).
//   게이트웨이는 이 파일로 "누가 · 어느 에이전트를 · 어느 버전으로" 쓰는지 정하고, 나머지(권한·도구·어댑터)는 그대로 공유한다.
import type { ErpScope, ToolManifest, ToolModule } from "./types.ts";
import { assemblePrompt, todayPart, type PromptParts } from "./prompt.ts";

export type AgentRow = {
  agent_key: string; name_ko: string; summary_ko: string | null; icon: string | null; dept_nm: string | null;
  status: "dev" | "pilot" | "live" | "off"; current_version: number | null; daily_limit: number;
  monthly_budget_usd: number; collect_turns: boolean; retention_days: number; suggestions: { label: string; q: string }[];
};
export type AgentVersion = {
  agent_key: string; version: number; state: "draft" | "current" | "retired"; model_id: string; fallback_model_id: string | null;
  effort: string | null; max_tokens: number; temperature: number | null; prompt_caching: boolean;
  role_prompt: string; answer_rules: string; modules: { domains?: string[]; off?: string[] }; max_tool_rounds: number;
  note: string | null; golden_pass: number | null; golden_total: number | null; golden_run_at: string | null;
  created_by: string | null; created_at: string; approved_by: string | null; approved_at: string | null;
};
export type AgentRole = "reviewer" | "operator" | "user" | null;

export const VERSION_COLS = "agent_key,version,state,model_id,fallback_model_id,effort,max_tokens,temperature,prompt_caching,role_prompt,answer_rules,modules,max_tool_rounds,note,golden_pass,golden_total,golden_run_at,created_by,created_at,approved_by,approved_at";
export const AGENT_COLS = "agent_key,name_ko,summary_ko,icon,dept_nm,status,current_version,daily_limit,monthly_budget_usd,collect_turns,retention_days,suggestions";

// deno-lint-ignore no-explicit-any
export async function loadAgent(admin: any, key: string): Promise<AgentRow | null> {
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(key)) return null;
  const { data } = await admin.from("ai_agent").select(AGENT_COLS).eq("agent_key", key).maybeSingle();
  return (data as AgentRow) || null;
}
// deno-lint-ignore no-explicit-any
export async function loadVersion(admin: any, key: string, version: number | null): Promise<AgentVersion | null> {
  let q = admin.from("ai_agent_version").select(VERSION_COLS).eq("agent_key", key);
  q = version ? q.eq("version", version) : q.eq("state", "current");
  const { data } = await q.maybeSingle();
  return (data as AgentVersion) || null;
}

/** 이 사용자가 이 에이전트에서 가진 역할.
 *  reviewer = 포털 전체관리자 또는 구성원 reviewer(확인·점검·승인) · operator = 구성원 operator(실작업)
 *  user = live 에이전트의 일반 사용자 · null = 사용 불가(pilot 은 구성원·관리자만). */
// deno-lint-ignore no-explicit-any
export async function roleOf(admin: any, agent: AgentRow, scope: ErpScope): Promise<AgentRole> {
  const { data } = await admin.from("ai_agent_member").select("role").eq("agent_key", agent.agent_key).eq("upn", scope.upn).maybeSingle();
  const m = data?.role as string | undefined;
  if (scope.isAdmin || m === "reviewer") return "reviewer";
  if (m === "operator") return "operator";
  if (agent.status === "live") return "user";
  return null;
}

/** 버전의 모듈 묶음 → 이번 에이전트가 쓸 수 있는 모듈(권한 판정 전). */
export function agentModules(all: ToolModule[], v: AgentVersion): ToolModule[] {
  const doms = new Set(v.modules?.domains || []);
  const off = new Set(v.modules?.off || []);
  return all.filter((m) => m.manifest.status !== "off" && doms.has(m.manifest.domain) && !off.has(m.manifest.id));
}

/** 에이전트 프롬프트 = 역할 안내 + 이 부서의 답변 원칙 + 공통 머리말(정체 문장 제외 · 답변/도구/안전 절) + ERP·도메인·모듈 문구
 *  + 용어집 + 파일 보관 안내 + 오늘 날짜(가장 끝 — 캐시 앞부분을 흔들지 않게).
 *  순서가 곧 우선순위다: 부서 원칙이 공통 원칙보다 앞에 온다(같은 주제면 부서 원칙이 더 구체적). REQ-0114 에서 절(■) 구조로 통일. */
export function agentPrompt(agent: AgentRow, v: AgentVersion, mods: ToolManifest[], glossary: { term: string; meaning: string }[],
  denied: { id: string; title_ko: string }[], todayKst: string): PromptParts {
  const parts: PromptParts = [];
  if (v.role_prompt.trim()) parts.push({ key: "agent.role", label: `역할 안내 · ${agent.name_ko} v${v.version}`, text: "■ 역할\n" + v.role_prompt.trim() });
  if (v.answer_rules.trim()) parts.push({ key: "agent.rules", label: "이 부서의 답변 원칙", text: "■ 이 부서의 답변 원칙\n" + v.answer_rules.trim() });
  // 공통 머리말의 정체 문장(jeil-chat)은 에이전트 역할 안내와 겹치므로 뺀다. 오늘 날짜는 맨 끝에 따로 붙인다(todayKst 를 넘기지 않는다)
  assemblePrompt(mods, denied).filter((p) => p.key !== "common.identity").forEach((p) => parts.push(p));
  if (glossary.length) {
    parts.push({ key: "agent.glossary", label: `용어집 ${glossary.length}개`,
      text: "■ 이 부서에서 쓰는 용어\n" + glossary.map((g) => `- ${g.term}: ${g.meaning}`).join("\n") });
  }
  // 파일 보관 안내(REQ-0108) — 모델은 저장하지 못한다. 저장은 사용자가 화면 버튼으로 한다는 사실만 알려 준다
  parts.push({ key: "agent.files", label: "파일 보관 안내", text: FILE_NOTE });
  parts.push({ ...todayPart(todayKst), key: "agent.today" });
  return parts;
}
const FILE_NOTE = "■ 파일 보관\n사용자가 붙인 첨부 파일과 자료함의 자료는 사용자가 직접 버튼으로 부서 NAS 폴더(AI저장)에 보관할 수 있습니다 — 첨부는 보낸 메시지의 파일 이름 옆 「🗄 NAS 저장」, 자료함은 항목의 「NAS」 버튼입니다(기본 3년 보존, 부서 구성원 공유). "
  + "당신은 파일을 직접 저장·삭제할 수 없습니다. 저장을 요청받으면 그 버튼을 누르라고 안내하고, 버튼을 누르지 않은 첨부는 어디에도 저장되지 않으며 대화 기록에는 파일 이름만 남는다고 사실대로 답하세요. "
  + "저장됐는지는 화면 오른쪽 「부서 NAS 보관함」에서 확인한다고 안내하세요.";
export const joinAgentPrompt = (p: PromptParts) => p.map((x) => x.text).join("\n\n");

/** 한국시간 날짜 YYYY-MM-DD */
export const todayKst = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

/** 턴 자동 판정 → 개선 대장 후보 표시(14 기획 §5-1 flags). */
export function turnFlags(t: { tools: { outcome: string }[]; answer: string; latency_ms: number; stop?: string | null; toolCount: number }): string[] {
  const f = new Set<string>();
  if (t.tools.some((x) => x.outcome === "error")) f.add("tool_error");
  if (t.tools.some((x) => x.outcome === "empty")) f.add("zero_rows");
  if (t.tools.some((x) => x.outcome === "denied")) f.add("perm_denied");
  if (t.stop === "refusal") f.add("refusal");
  if (t.latency_ms > 45_000) f.add("slow");
  // 도구 없이 답했는데 "조회할 수 없다/모르겠다" 류 → 없는 기능 후보
  if (!t.toolCount && /(조회할 수 없|확인할 수 없|제공하지 않|도구가 없|알 수 없습니다|지원하지 않)/.test(t.answer)) f.add("no_tool");
  return [...f];
}
