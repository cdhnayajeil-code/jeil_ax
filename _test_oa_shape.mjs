// _test_oa_shape.mjs — OpenAI 요청 모양 자동 적응(oaAdjust) 회귀 + 두 사본 동일성 (REQ-0095)
//
// 실행:  node _test_oa_shape.mjs      (Node 24 — .ts 타입 제거 기본 지원)
//
// 무엇을 지키려는 테스트인가
//   운영 챗봇(jeil-chat)과 부서 에이전트(jeil-chat-lab/llm/openai.ts)는 같은 적응 코드를 **사본**으로 갖는다
//   (배포 스크립트가 함수 폴더만 올려 공유 모듈을 둘 수 없다). 한쪽만 고치면 다른 쪽이 조용히 낡는다 —
//   그래서 ① `type OaShape` ~ `oaAdjust` 끝까지 두 파일이 글자 단위로 같은지 본다.
//   ② 실측 400 원문(2026-09-30 function_logs)으로 세 단계(temperature → max_completion_tokens → reasoning_effort)가
//      순서와 무관하게 수렴하고, 같은 사유가 다시 오면 포기(null)해 무한 재시도가 없는지 본다.
//   ③ jeil-chat 의 DB 시드 화이트리스트(sanitizeShape)가 이상한 jsonb 를 정규화하는지 본다.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CHAT = join(ROOT, "supabase/functions/jeil-chat/index.ts");
const LAB = join(ROOT, "supabase/functions/jeil-chat-lab/llm/openai.ts");
let failed = 0;
const fail = (m) => { console.error("✘ " + m); failed++; };
const ok = (c, m) => { if (!c) fail(m); };

/* ── 1. 두 사본 추출·비교 ─────────────────────────────────────────────── */
function extract(src, label) {
  const a = src.indexOf("type OaShape = {");
  if (a < 0) throw new Error(label + ": `type OaShape` 를 찾지 못했습니다.");
  const f = src.indexOf("function oaAdjust(", a);
  if (f < 0) throw new Error(label + ": `function oaAdjust` 를 찾지 못했습니다.");
  const end = src.indexOf("\n}\n", src.indexOf("  return null;", f));
  if (end < 0) throw new Error(label + ": oaAdjust 의 닫는 괄호를 찾지 못했습니다.");
  return src.slice(a, end + 3);
}
/* CRLF 체크아웃(core.autocrlf)에서도 "\n}\n" 마커가 잡히게 줄끝을 먼저 정규화한다 */
const chatSrc = readFileSync(CHAT, "utf8").replace(/\r\n/g, "\n"), labSrc = readFileSync(LAB, "utf8").replace(/\r\n/g, "\n");
const bChat = extract(chatSrc, "jeil-chat"), bLab = extract(labSrc, "jeil-chat-lab");
const norm = (s) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
ok(norm(bChat) === norm(bLab), "jeil-chat 과 jeil-chat-lab 의 OaShape~oaAdjust 사본이 다릅니다 — 한쪽만 고쳤습니다.");
ok(/reasoning_effort/.test(bChat), "3단계(reasoning_effort) 적응이 사본에 없습니다.");
ok(/OA_MAX_ADJUST = 3|i < 3 && res\.status === 400/.test(chatSrc), "jeil-chat 재시도 상한이 3 이 아닙니다.");
ok(/i < 3 && res\.status === 400/.test(labSrc), "lab 재시도 상한이 3 이 아닙니다.");
ok(/reasoning_effort: shape\.reasoning/.test(chatSrc) && /reasoning_effort: sh\.reasoning/.test(labSrc), "요청 body 에 reasoning_effort 전송 줄이 없습니다.");

/* ── 2. 블록을 모듈로 만들어 실행 ─────────────────────────────────────── */
const san = (() => {
  const a = chatSrc.indexOf("function sanitizeShape(");
  const end = chatSrc.indexOf("\n}\n", a);
  return chatSrc.slice(a, end + 3);
})();
const dir = mkdtempSync(join(tmpdir(), "oa-shape-"));
const modPath = join(dir, "oa.ts");
writeFileSync(modPath, bChat + "\n" + san + "\nexport { OA_SHAPE, oaShape, oaParam, oaAdjust, sanitizeShape };\n", "utf8");
const M = await import(pathToFileURL(modPath).href);
/* 학습 로그는 oaAdjust 호출 시점에 찍힌다 — 시나리오 동안 잡아 두고 끝에 되돌린다 */
const origLog = console.log; const logs = []; console.log = (...a) => logs.push(a.join(" "));

/* ── 3. 실측 400 원문 ─────────────────────────────────────────────────── */
const E_MAX = JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: "invalid_request_error", param: "max_tokens", code: "unsupported_parameter" } });
const E_REASON = JSON.stringify({ error: { message: "Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.", type: "invalid_request_error", param: "reasoning_effort", code: null } });
const E_TEMP = JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0.3 with this model. Only the default (1) value is supported.", type: "invalid_request_error", param: "temperature", code: "unsupported_value" } });
const E_OTHER = JSON.stringify({ error: { message: "Invalid 'messages[0].role': expected one of 'system', 'assistant', 'user', 'function', 'tool', or 'developer'.", type: "invalid_request_error", param: "messages[0].role", code: "invalid_value" } });

ok(M.oaParam(E_MAX) === "max_tokens", "oaParam: max_tokens 원문 판독 실패");
ok(M.oaParam(E_REASON) === "reasoning_effort", "oaParam: reasoning_effort 원문 판독 실패");
ok(M.oaParam(E_TEMP) === "temperature", "oaParam: temperature 원문 판독 실패");
ok(M.oaParam(E_OTHER) === "messages[0].role", "oaParam: 무관 param 은 그대로 돌려줘야 합니다");
ok(M.oaParam("plain text mentioning reasoning_effort only") === "reasoning_effort", "oaParam: JSON 아닌 본문의 정규식 폴백 실패");
ok(M.oaParam("") === "", "oaParam: 빈 본문은 빈 문자열");

// 실측 순서(gpt-6-luna): max_tokens → reasoning_effort
ok(M.oaShape("gpt-6-luna").reasoning === null && M.oaShape("gpt-6-luna").maxKey === "max_tokens", "초기 모양이 기본값이 아닙니다");
const s1 = M.oaAdjust("gpt-6-luna", E_MAX);
ok(s1 && s1.maxKey === "max_completion_tokens" && s1.reasoning === null, "1단계(max_completion_tokens) 실패");
const s2 = M.oaAdjust("gpt-6-luna", E_REASON);
ok(s2 && s2.reasoning === "none" && s2.maxKey === "max_completion_tokens" && s2.temp === true, "2단계(reasoning none) 실패 — 앞 단계 학습을 잃었거나 none 이 안 들어갔습니다");
ok(M.oaAdjust("gpt-6-luna", E_REASON) === null, "같은 사유(reasoning_effort)가 다시 오면 포기(null)해야 합니다 — 무한 재시도");
ok(M.oaAdjust("gpt-6-luna", E_MAX) === null, "이미 max_completion_tokens 인데 또 요구하면 포기(null)");
ok(M.oaShape("gpt-4o-mini").reasoning === null && M.oaShape("gpt-4o-mini").maxKey === "max_tokens", "모델별 독립 — gpt-4o-mini 가 영향을 받았습니다");

// 다른 순서(temperature → reasoning → max_tokens)도 같은 최종 모양, 호출 ≤ 4
const seq = [E_TEMP, E_REASON, E_MAX];
let calls = 0, cur = M.oaShape("gpt-x");
for (const e of seq) { calls++; const n = M.oaAdjust("gpt-x", e); ok(n, "순서 바꾼 시나리오에서 적응이 끊겼습니다: " + M.oaParam(e)); if (n) cur = n; }
ok(cur.temp === false && cur.maxKey === "max_completion_tokens" && cur.reasoning === "none", "순서 무관 최종 모양 불일치: " + JSON.stringify(cur));
ok(calls <= 4, "적응 호출이 4회를 넘었습니다");
ok(M.oaAdjust("gpt-y", E_OTHER) === null, "무관 param(messages) 은 첫 호출부터 포기(null)");
ok(M.oaAdjust("gpt-z", "some text about reasoning_effort") && M.oaShape("gpt-z").reasoning === "none", "JSON 아닌 본문도 정규식으로 none 학습");
console.log = origLog;
ok(logs.some((l) => /gpt-6-luna → reasoning_effort none/.test(l)), "학습 로그(reasoning_effort none) 가 남지 않았습니다");

// sanitizeShape — jsonb 화이트리스트
ok(M.sanitizeShape({ reasoning: "low", maxKey: "x", temp: "yes" }) && JSON.stringify(M.sanitizeShape({ reasoning: "low", maxKey: "x", temp: "yes" })) === JSON.stringify({ temp: true, maxKey: "max_tokens", reasoning: null }), "sanitizeShape: 이상값 정규화 실패");
ok(JSON.stringify(M.sanitizeShape({ temp: false, maxKey: "max_completion_tokens", reasoning: "none" })) === JSON.stringify({ temp: false, maxKey: "max_completion_tokens", reasoning: "none" }), "sanitizeShape: 정상값 보존 실패");
ok(M.sanitizeShape(null) === null && M.sanitizeShape("str") === null && M.sanitizeShape(42) === null, "sanitizeShape: 비객체는 null");

if (failed) { console.error(`✘ oaAdjust 회귀 실패 ${failed}건`); process.exit(1); }
console.log("✔ oaAdjust 회귀 통과 — 사본 동일 · 3단계 수렴 · 포기 규칙 · sanitizeShape");
