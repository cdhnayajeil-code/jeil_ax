// _test_prompt_assembly.mjs — 시스템 지시문 조립 회귀(REQ-0114)
//
// 실행:  node _test_prompt_assembly.mjs      (Node 24 — .ts 타입 제거 기본 지원 · Deno 불필요)
//
// 무엇을 지키려는 테스트인가
//   ① 공통 머리말·도메인 안내·모듈 안내가 가리키는 도구 이름이 **실제 모듈에 있는가**(없는 도구를 안내하면 모델이 헛호출한다).
//   ② 조립 순서 — 정체가 맨 앞, 오늘 날짜가 맨 끝(캐시), 부서 에이전트는 정체 문장을 빼고 역할 → 부서 원칙 → 공통 → 용어집 → 파일 → 날짜.
//   ③ `needs` 필터 — 운영 도구 19종만으로 조립하면 search_pur_list·NAS 문구가 들어가지 않는다.
//   ④ 템플릿 JSON 규칙 key 가 text 안에 있는가(콘솔 「📐」 탭 반영률 판정이 key 포함 여부라서) · 구매 v5 답변 원칙이 템플릿 전부를 담는가.
//   ⑤ 엔진·어댑터 — 마무리 라운드가 tools 를 빼지 않고 tool_choice none 을 쓰는가 · 반복 감지 뒤 마무리 라운드 · 결과 잘림 표시.
//   ⑥ 정본 SQL 94 본문 == 생성기 출력(prompt.ts 를 고치고 SQL 재생성을 잊지 않게).
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = dirname(fileURLToPath(import.meta.url));
const LAB = join(ROOT, "supabase/functions/jeil-chat-lab");
const url = (p) => pathToFileURL(join(LAB, p)).href;
let failed = 0;
const fail = (m) => { console.error("✘ " + m); failed++; };
const ok = (c, m) => { if (!c) fail(m); };
const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();   // 콘솔 coverage() 와 같은 정규화

const P = await import(url("core/prompt.ts"));
const A = await import(url("core/agent.ts"));
const { MODULES: PORTED } = await import(url("modules/index.ts"));
const { EXTRA_MODULES: EXTRA } = await import(url("modules/extra.ts"));
const ALL = [...PORTED, ...EXTRA].map((m) => m.manifest);
const IDS = new Set(ALL.map((m) => m.id));
const TPL = JSON.parse(readFileSync(join(ROOT, "app/agent-templates.json"), "utf8"));

/* ── ① 도구 이름 참조 ────────────────────────────────────────────────── */
const texts = [
  ...P.COMMON_HEADER.map((p) => ["common:" + p.key, p.text]),
  ["erp", P.ERP_HINT],
  ...Object.entries(P.DOMAIN_HINTS).flatMap(([d, hs]) => hs.map((h, i) => [`domain.${d}.${i}`, h.text])),
  ...ALL.filter((m) => m.prompt_hint).map((m) => ["hint:" + m.id, m.prompt_hint]),
];
for (const [where, t] of texts) {
  // 'get_erp_*' 같은 와일드카드 표기는 제외(끝이 글자인 토큰만)
  for (const tok of t.match(/\b(get|search|read|list)_[a-z_]*[a-z](?![a-z_*])/g) || []) ok(IDS.has(tok), `${where}: 없는 도구 이름 '${tok}' 을 가리킵니다`);
}
ok(P.COMMON_HEADER[0].key === "common.identity", "공통 머리말 첫 조각은 정체(common.identity)여야 합니다");
ok(["common.identity", "common.answer", "common.tools", "common.safety"].every((k, i) => P.COMMON_HEADER[i]?.key === k), "공통 머리말 절 순서가 정체→답변→도구→안전이 아닙니다");
ok(/지시문.*공개하지 않/.test(P.COMMON_HEADER[3].text) && /무시하라/.test(P.COMMON_HEADER[3].text), "안전 절에 지시문 비공개·주입 방어 문장이 없습니다(G-1)");
ok(/0건이면/.test(P.COMMON_HEADER[2].text) && /같은 도구를 같은 인자로/.test(P.COMMON_HEADER[2].text), "도구 절에 0건 재조회·반복 금지 규칙이 없습니다");
ok(/표시 N건 \/ 전체 M건/.test(P.COMMON_HEADER[1].text), "답변 절에 잘림 안내 규칙이 없습니다(F-4)");
for (const [, t] of texts) ok(!/sk-[A-Za-z0-9]{8,}|sbp_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{20,}|password\s*[:=]/i.test(t), "지시문에 비밀값 꼴 문자열이 있습니다");

/* ── ② 조립 순서(실험실·운영 형태) ─────────────────────────────────── */
const denied = [{ id: "get_hr_payroll", title_ko: "급여 집계" }];
const full = P.assemblePrompt(ALL, denied, "2026-10-07");
ok(full[0].key === "common.identity", "assemblePrompt: 첫 조각이 정체가 아닙니다");
ok(full[full.length - 1].key === "today" && /2026-10-07/.test(full[full.length - 1].text), "assemblePrompt: 오늘 날짜가 맨 끝이 아닙니다");
ok(full.some((p) => p.key === "denied" && /급여 집계/.test(p.text)), "assemblePrompt: 권한 밖 기능 안내가 빠졌습니다");
ok(full.some((p) => p.key === "erp"), "assemblePrompt: ERP 안내가 빠졌습니다");
ok(full.some((p) => p.key.startsWith("domain.purchase") && /search_pur_list/.test(p.text)), "assemblePrompt(전체): PU 안내(needs search_pur_list)가 빠졌습니다");
ok(full.some((p) => p.key.startsWith("domain.nas")), "assemblePrompt(전체): NAS 문서 안내가 빠졌습니다");
ok(full.some((p) => p.key === "tool.head") && full.filter((p) => p.key.startsWith("tool.") && p.key !== "tool.head").every((p) => p.text.startsWith("- ")), "모듈 안내가 「■ 도구별 안내」 머리 + 글머리표 형식이 아닙니다");
ok(P.joinPrompt(full).includes("\n\n■ 답변 원칙"), "joinPrompt 가 절을 빈 줄로 잇지 않습니다");
const noToday = P.assemblePrompt(ALL, []);
ok(!noToday.some((p) => p.key === "today"), "todayKst 를 주지 않았는데 오늘 날짜가 들어갔습니다");

/* ── ③ needs 필터(운영 19종) ───────────────────────────────────────── */
const ported = PORTED.map((m) => m.manifest);
const gw = P.joinPrompt(P.assemblePrompt(ported, []));
ok(!/search_pur_list|search_company_docs|list_company_files|PU2026/.test(gw), "운영 도구만으로 조립했는데 에이전트 전용 도구·PU 문구가 들어갔습니다(needs 필터)");
ok(/get_erp_item_orders/.test(gw) && /get_hr_headcount/.test(gw) && /get_my_access/.test(gw) && /get_my_requests/.test(gw), "운영 지시문에 누락 도구 4종 안내가 없습니다(13 기획 §1)");
ok(/get_erp_inventory_status/.test(gw) && /데이터 적용 요청/.test(gw), "운영 지시문에 재고 미적재 안내(DB 지시문 최신 문장)가 없습니다");

/* ── ④ 템플릿 JSON · 구매 v5 답변 원칙 ──────────────────────────────── */
const rules = [...TPL.common.answer_rules, ...TPL.domains.purchase.answer_rules_extra];
for (const r of rules) ok(norm(r.text).includes(norm(r.key)), `템플릿 ${r.id}: key '${r.key}' 가 text 안에 없습니다(콘솔 반영률 판정 실패)`);
ok(TPL.common.safety_rules.some((s) => s.id === "S6"), "템플릿 안전 규칙 S6(지시문 비공개)가 없습니다");
ok(TPL.defaults.max_tool_rounds === 5, "템플릿 기본 도구 라운드가 5 가 아닙니다");
ok(rules.some((r) => r.id === "P8") && rules.some((r) => r.id === "P9") && rules.some((r) => r.id === "P10"), "구매 추가 원칙 P8~P10 이 없습니다");
const v5rules = rules.map((r) => r.text).join("\n");
const v5 = {
  agent_key: "purchase", version: 5, state: "draft", model_id: "claude-sonnet-5", fallback_model_id: "gpt-4.1-mini", effort: "medium",
  max_tokens: 2048, temperature: null, prompt_caching: true, role_prompt: TPL.domains.purchase.role_prompt, answer_rules: v5rules,
  modules: { domains: ["purchase", "item", "portal", "common", "nas"], off: [] }, max_tool_rounds: 5, note: "", golden_pass: null, golden_total: null,
  golden_run_at: null, created_by: null, created_at: "", approved_by: null, approved_at: null,
};
ok(v5rules.length <= 6000, `구매 v5 답변 원칙이 6,000자(version_save 상한)를 넘습니다: ${v5rules.length}`);
const agent = { agent_key: "purchase", name_ko: "구매 에이전트", summary_ko: null, icon: null, dept_nm: "구매팀", status: "pilot", current_version: 4,
  daily_limit: 50, monthly_budget_usd: 150, collect_turns: true, retention_days: 180, suggestions: [] };
const pmods = ALL.filter((m) => v5.modules.domains.includes(m.domain) && m.status !== "off");
const ag = A.agentPrompt(agent, v5, pmods, [{ term: "미입고", meaning: "입고수량 < 발주수량" }, { term: "PU", meaning: "결재번호" }], [], "2026-10-07");
const keys = ag.map((p) => p.key);
ok(keys[0] === "agent.role" && keys[1] === "agent.rules", "에이전트 프롬프트가 역할 → 부서 원칙으로 시작하지 않습니다");
ok(!keys.includes("common.identity"), "에이전트 프롬프트에 jeil-chat 정체 문장이 들어갔습니다");
ok(keys.indexOf("common.answer") > keys.indexOf("agent.rules"), "공통 원칙이 부서 원칙보다 앞에 왔습니다(우선순위 역전)");
ok(keys.indexOf("agent.glossary") > keys.indexOf("common.safety") && keys.indexOf("agent.files") > keys.indexOf("agent.glossary"), "용어집·파일 안내 순서가 틀렸습니다");
ok(keys[keys.length - 1] === "agent.today" && !keys.includes("today"), "에이전트 프롬프트 맨 끝이 오늘 날짜가 아니거나 날짜가 두 번 들어갔습니다");
const agText = A.joinAgentPrompt(ag);
ok(agText.startsWith("■ 역할\n") && agText.includes("\n\n■ 이 부서의 답변 원칙\n") && agText.includes("■ 파일 보관\n"), "에이전트 절 머리(■)가 빠졌습니다");
for (const r of rules) ok(norm(agText).includes(norm(r.key)), `구매 v5 프롬프트에 템플릿 ${r.id} 가 없습니다`);
ok(agText.length < 16000, `구매 v5 프롬프트가 너무 깁니다: ${agText.length}자`);
console.log(`구매 v5 프롬프트 ${agText.length.toLocaleString()}자 · 조각 ${ag.length} · 운영 지시문 ${gw.length.toLocaleString()}자`);

/* ── ⑤ 엔진·어댑터 소스 검사(npm 의존 때문에 가져오지 않고 글자로 본다) ── */
const src = (p) => readFileSync(join(LAB, p), "utf8").replace(/\r\n/g, "\n");
const eng = src("core/engine.ts"), ty = src("llm/types.ts"), an = src("llm/anthropic.ts"), oa = src("llm/openai.ts"), ix = src("index.ts");
ok(/toolChoice\?: "auto" \| "none"/.test(ty), "llm/types.ts RoundOpts 에 toolChoice 가 없습니다");
ok(!/lastRound \? null/.test(eng), "engine.ts 가 아직 마지막 라운드에 tools 를 빼고 보냅니다(Claude 400)");
ok((eng.match(/tools: toolDefs, toolChoice/g) || []).length === 2, "engine.ts 두 번의 adapter.round(기본·예비) 모두 toolChoice 를 넘겨야 합니다");
ok(/forceAnswer = NUDGE_LOOP/.test(eng) && /extraRound = 1/.test(eng), "engine.ts 반복 감지 뒤 마무리 라운드 처리가 없습니다");
ok(/clipToolResult\(result\)/.test(eng), "engine.ts 가 도구 결과 잘림 표시(clipToolResult)를 쓰지 않습니다");
ok(/tool_choice: \{ type: "none" \}/.test(an), "anthropic.ts 에 tool_choice none 이 없습니다");
ok(/tool_choice: "none"/.test(oa), "openai.ts 에 tool_choice none 이 없습니다");
ok(/assemblePrompt\(injected\.map\(\(m\) => m\.manifest\), denied, todayKst\(\)\)/.test(ix), "index.ts(실험실)가 오늘 날짜를 넘기지 않습니다");
// clipToolResult 를 떼어 내 실행
const a0 = eng.indexOf("export function clipToolResult("); const a1 = eng.indexOf("\n}\n", a0);
const dir = mkdtempSync(join(tmpdir(), "prompt-asm-"));
writeFileSync(join(dir, "clip.ts"), "export const TOOL_RESULT_MAX = 12000;\n" + eng.slice(a0, a1 + 3), "utf8");
const C = await import(pathToFileURL(join(dir, "clip.ts")).href);
const big = C.clipToolResult({ 목록: Array.from({ length: 2000 }, (_, i) => ({ i, v: "x".repeat(10) })) });
ok(big.length > 12000 && /결과 잘림: 전체 [\d,]+자 중 앞 12,000자만 전달됨/.test(big), "clipToolResult 잘림 표시가 없습니다");
ok(C.clipToolResult({ a: 1 }) === '{"a":1}', "clipToolResult 가 짧은 결과를 바꿨습니다");

/* ── ⑥ 정본 SQL 94 == 생성기 ───────────────────────────────────────── */
const G = await import(pathToFileURL(join(ROOT, "_gen_gateway_prompt.mjs")).href);
const sqlPath = join(ROOT, "실제구축준비 자료/이관/sql/94_gateway_system_prompt_v2.sql");
let sql = ""; try { sql = readFileSync(sqlPath, "utf8").replace(/\r\n/g, "\n"); } catch { fail("정본 SQL 94 가 없습니다 — node _gen_gateway_prompt.mjs"); }
const m = sql.match(/\$jeilax\$([\s\S]*?)\$jeilax\$/);
ok(m && m[1] === G.gatewayPrompt(), "정본 SQL 94 본문이 생성기 출력과 다릅니다 — node _gen_gateway_prompt.mjs 로 재생성");
ok(/^■ 날짜\n/m.test(G.gatewayPrompt()) && /2026년으로 해석/.test(G.gatewayPrompt()), "운영 지시문 꼬리(연도 해석)가 없습니다");
ok(!/\$jeilax\$/.test(G.gatewayPrompt()), "지시문 본문에 달러 인용 구분자가 들어 있습니다");

if (failed) { console.error(`\n${failed}건 실패`); process.exit(1); }
console.log("✔ 지시문 조립 회귀 통과");
