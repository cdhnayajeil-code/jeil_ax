// _test_model_tab.mjs — 관리자 콘솔 「모델 설정」 탭 렌더 회귀 — 동작 점검 배지·할 일·부분 갱신 (REQ-0095 · REQ-0093)
//
// 실행:  node _test_model_tab.mjs
//
// 무엇을 지키려는 테스트인가
//   「점검」 결과는 서버(jeil-chat action:test_model)가 기록한 사실을 배지로 옮기는 것뿐이어야 한다.
//   ① 모델 행 수·저장 셀렉터(tr[data-model])가 그대로인지 ② 「점검」 링크가 OpenAI·키 있는 행에만, id 를 JS 문자열에 넣지 않는
//   방식(mxCheckOne(this))으로 붙는지 ③ 정상/빈 답/거부/미점검 4종 + 「추론 끔」 배지가 서버 값대로 나오는지
//   ④ 미점검 행에 「정상」이 없는지(§16.6) ⑤ 기본 모델·작동 중 예외 규칙 모델의 점검 실패는 빨강, 미점검은 파랑으로 「지금 해야 할 일」에 오르는지
//   ⑥ 벤더 원문(따옴표·<script>)이 속성·본문을 깨지 않는지 ⑦ 키 값처럼 보이는 문자열이 없는지 ⑧ 새 요소 id·colspan 이 있는지
//   ⑨ null 값(ms·note)에 예외가 없는지 ⑩ 「점검」 클릭 경로(200·409 취소·429·네트워크 실패)가 셀만 부분 갱신하고 점검 중 잠금이 풀리는지
//   ⑪ 점검 대기 중 화면이 다시 그려져도 결과가 새 객체·셀에 남고 같은 모델 2차 요청이 막히는지 를 본다.
//   escHtml 목은 실제와 같이 **비문자열이면 throw** 한다 — att()/String() 없이 숫자·null 을 넘기는 회귀를 잡기 위해서다.
//   _test_cost_tab.mjs 와 같은 방식 — jsdom 없이 최소 DOM, 검사 대상 JS 는 화면 파일에서 런타임에 꺼낸다.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const HTML = join(ROOT, "04_챗봇_포털_데모UI.html");
let failed = 0;
const fail = (m) => { console.error("✘ " + m); failed++; };
const ok = (c, m) => { if (!c) fail(m); };
const src = readFileSync(HTML, "utf8");

/* ── 1. 블록 추출: 💳 비용 블록(공용 헬퍼) → 모델 설정 블록 ───────────── */
const m1 = src.indexOf("   💳 AI 비용·예산 탭 (REQ-0091");
const m2 = src.indexOf("/* ===== 사용모델 설정 렌더·저장");
const m3 = src.indexOf("/* ===== 응답 중지 + work");
if (m1 < 0 || m2 < 0 || m3 < 0 || !(m1 < m2 && m2 < m3)) { console.error("✘ 블록 마커를 찾지 못했습니다(주석 머리글이 바뀐 듯)."); process.exit(1); }
const costBlock = src.slice(src.lastIndexOf("/*", m1), m2);
const modelBlock = src.slice(m2, m3);

for (const id of ["mxCheckAllBtn", "mxCheckNote", "mxCards", "mxTodo", "amModelRows", "amDefaultModel", "amRouteRows", "mxDefaultInfo"]) {
  if (!src.includes(`id="${id}"`)) fail(`화면에 id="${id}" 가 없습니다.`);
}
ok(src.includes('<tbody id="amModelRows"><tr><td colspan="5"'), "모델 표 colspan=\"5\" 가 바뀌었습니다(열 수 변경 — 저장 셀렉터 확인).");
ok(/onclick="mxCheckAll\(\)"/.test(src), "「전체 점검」 버튼이 mxCheckAll() 을 부르지 않습니다.");

/* ── 2. 최소 DOM — amModelRows 의 innerHTML 을 행·셀 객체로 파싱해 부분 갱신 경로가 실제로 돌게 한다 ── */
const els = new Map();
class El {
  constructor(id) { this.id = id; this.innerHTML = ""; this.textContent = ""; this.value = ""; this.checked = false; this.disabled = false; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getAttribute() { return null; }
}
const cells = new Map();              // model_id → { innerHTML }  (mxCheckCellRefresh 가 여기에 쓴다)
const saveButtons = [{ disabled: false }, { disabled: false }, { disabled: false }];
function rowsOf() {
  const html = els.get("amModelRows")?.innerHTML || "";
  const out = [];
  for (const mm of html.matchAll(/<tr data-model="([^"]+)"[\s\S]*?<\/tr>/g)) {
    const id = mm[1];
    if (!cells.has(id)) cells.set(id, { innerHTML: (mm[0].match(/<td class="am-check">([\s\S]*?)<\/td>/) || ["", ""])[1] });
    out.push({ getAttribute: (a) => (a === "data-model" ? id : null), querySelector: (q) => (q === ".am-check" ? cells.get(id) : null) });
  }
  return out;
}
const g = globalThis;
g.document = {
  getElementById: (id) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); },
  querySelectorAll: (sel) => sel === "#amModelRows tr[data-model]" ? rowsOf() : sel === "#panel-model button.save" ? saveButtons : [],
  querySelector: () => null,
};
g.window = { IS_BUNDLE: false };
g.localStorage = { getItem: () => null };
g.escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");   // 실제와 같이 비문자열이면 throw
g.fmtKST = (x) => "09/30 14:00";
let auth = null; g.getLiveAuth = () => auth;
g.ADMIN_GATEWAY = "http://example.invalid"; g.CHAT_GATEWAY = "http://example.invalid/chat";
g.alert = () => {}; let confirmAnswer = false; g.confirm = () => confirmAnswer;
g.setTimeout = () => 0;                                  // 연타 대기 타이머가 프로세스를 붙들지 않게
const fetchLog = []; let fetchQueue = [];
g.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body); fetchLog.push({ url, body });
  const sc = fetchQueue.shift(); if (!sc) throw new Error("fetch 스텁 큐가 비었습니다");
  if (sc.throw) throw new TypeError("Failed to fetch");
  if (sc.defer) await sc.defer;
  return { status: sc.status, json: async () => sc.data };
};
// deno-lint-ignore no-eval
(0, eval)(costBlock);
// deno-lint-ignore no-eval
(0, eval)(modelBlock);

/* ── 3. 표본 model_settings ────────────────────────────────────────────── */
const AT = "2026-09-30T05:00:00Z";
const RAW_NASTY = '{"error":{"message":"bad \\"quote\\" <script>alert(1)</script>","param":"reasoning_effort"}}';
const sample = () => ({
  models: [
    { model_id: "gpt-4o-mini", vendor: "OpenAI", stage: 1, recommended: false, tier: "light", price_in: 0.15, price_out: 0.6, active: true, callable: true, sort: 10,
      last_check_at: AT, last_check_ok: true, last_check_status: 200, last_check_ms: 1200, last_check_note: "정상", last_check_detail: { pt: 6000, ct: 3, rt: 0, cost_usd: 0.0009 }, request_shape: { temp: true, maxKey: "max_tokens", reasoning: null } },
    { model_id: "gpt-6-luna", vendor: "OpenAI", stage: 1, recommended: true, tier: "light", price_in: 0.1, price_out: 0.5, active: true, callable: true, sort: 11,
      last_check_at: AT, last_check_ok: false, last_check_status: 400, last_check_ms: 900, last_check_note: '거부됨: 도구+추론 조합 미지원(자동 보정 실패) "따옴표" <script>x</script>',
      last_check_detail: { raw: RAW_NASTY, param: "reasoning_effort", adjustments: ["max_completion_tokens 사용"] }, request_shape: { temp: true, maxKey: "max_completion_tokens", reasoning: "none" } },
    { model_id: "gpt-5-mini", vendor: "OpenAI", stage: 3, recommended: false, tier: "workhorse", price_in: 0.25, price_out: 2, active: false, callable: true, sort: 20,
      last_check_at: AT, last_check_ok: false, last_check_status: 200, last_check_ms: 2400, last_check_note: "빈 답 — 답 최대 길이 1024토큰을 추론에 모두 사용(추론 토큰 1024) → 세부 설정 「답 최대 길이」를 올리세요", last_check_detail: { pt: 6000, ct: 1024, rt: 1024, finish: "length" }, request_shape: { temp: false, maxKey: "max_completion_tokens", reasoning: null } },
    { model_id: "gpt-4.1-mini", vendor: "OpenAI", stage: 1, recommended: false, tier: "light", price_in: 0.4, price_out: 1.6, active: true, callable: true, sort: 12,
      last_check_at: null, last_check_ok: null, last_check_status: null, last_check_ms: null, last_check_note: null, last_check_detail: null, request_shape: null },
    { model_id: "gpt-6-astra", vendor: "OpenAI", stage: 5, recommended: false, tier: "flagship", price_in: 10, price_out: 50, active: false, callable: true, sort: 50,
      last_check_at: AT, last_check_ok: false, last_check_status: 400, last_check_ms: 700, last_check_note: "거부됨: 도구 호출 불가 — Responses API 필요(켜도 답하지 못함)", last_check_detail: { raw: "x", param: "reasoning_effort" }, request_shape: { temp: true, maxKey: "max_completion_tokens", reasoning: "none" } },
    { model_id: "gpt-6-sol", vendor: "OpenAI", stage: 3, recommended: true, tier: "flagship", price_in: 2, price_out: 10, active: true, callable: true, sort: 21,
      last_check_at: null, last_check_ok: null, last_check_status: null, last_check_ms: null, last_check_note: null, last_check_detail: null, request_shape: null },
    { model_id: "gpt-4o", vendor: "OpenAI", stage: 3, recommended: false, tier: "legacy", price_in: 2.5, price_out: 10, active: true, callable: true, sort: 22,
      last_check_at: AT, last_check_ok: false, last_check_status: 500, last_check_ms: null, last_check_note: null, last_check_detail: null, request_shape: null },   // ⑨ null 값
    { model_id: "claude-sonnet-5-5", vendor: "Anthropic", stage: 3, recommended: true, tier: "workhorse", price_in: 2, price_out: 10, active: true, callable: true, sort: 30,
      last_check_at: null, last_check_ok: null, last_check_status: null, last_check_ms: null, last_check_note: null, last_check_detail: null, request_shape: null },
    { model_id: "claude-haiku-4-5", vendor: "Anthropic", stage: 2, recommended: false, tier: "light", price_in: 1, price_out: 5, active: true, callable: false, sort: 31,
      last_check_at: null, last_check_ok: null, last_check_status: null, last_check_ms: null, last_check_note: null, last_check_detail: null, request_shape: null },
  ],
  config: { default_model: "gpt-6-luna", max_tokens: 1024, temperature: 0.3, prompt_caching: true, max_messages: 20, max_total_chars: 24000, system_prompt: "지시문",
            work_context_mode: "memo", work_context_max_chars: 2000, work_history_turns: 10, chat_save_enabled: true, chat_retention_days: 180, session_max_messages: 400 },
  routing: [
    { id: 7, seq: 2, label: "입력 2,000자 이상 또는 키워드", rule_type: "keyword_length", match_keywords: ["분석"], min_chars: 2000, model_id: "gpt-6-sol", active: true, enforced: true },
    { id: 9, seq: 4, label: "기본값", rule_type: "default", match_keywords: [], min_chars: null, model_id: "gpt-6-luna", active: true, enforced: true },
    { id: 6, seq: 1, label: "파일 업로드", rule_type: "file", match_keywords: [], min_chars: null, model_id: "gpt-6-sol", active: true, enforced: false },
  ],
});
const MS = sample();

/* ── 4. 렌더 ───────────────────────────────────────────────────────────── */
try { g.renderModelSettings(MS); } catch (e) { console.error("✘ renderModelSettings 예외:", e && e.stack || e); process.exit(1); }
const rows = els.get("amModelRows").innerHTML;
const todo = els.get("mxTodo").innerHTML;
const cards = els.get("mxCards").innerHTML;

const trs = rows.match(/<tr data-model="/g) || [];
ok(trs.length === MS.models.length, `① tr[data-model] 수 ${trs.length} ≠ 모델 수 ${MS.models.length}`);
ok((rows.match(/class="am-check"/g) || []).length === trs.length, "① 모든 행에 .am-check 셀이 있어야 부분 갱신이 됩니다");
const links = rows.match(/onclick="return mxCheckOne\(this\)"/g) || [];
const openaiCallable = MS.models.filter((m) => m.vendor === "OpenAI" && m.callable).length;
ok(links.length === openaiCallable, `② 「점검」 링크 수 ${links.length} ≠ OpenAI·키 있는 행 ${openaiCallable}`);
ok(!/mxCheckOne\('/.test(rows), "② 「점검」 링크가 id 를 JS 문자열에 넣고 있습니다(따옴표 깨짐 위험).");
const rowOf = (id) => { const i = rows.indexOf(`<tr data-model="${id}"`); const j = rows.indexOf("</tr>", i); return rows.slice(i, j); };
ok(/정상 1\.2초/.test(rowOf("gpt-4o-mini")), "③ 정상 배지(1.2초)가 없습니다");
ok(/badge a" title="[^"]*">빈 답/.test(rowOf("gpt-5-mini")), "③ 빈 답 배지가 없습니다(200 인데 본문 0자)");
ok(/badge b[^>]*>미점검/.test(rowOf("gpt-4.1-mini")), "③ 미점검 배지가 없습니다(점 있는 id)");
ok(/badge r" title="[^"]*">거부됨/.test(rowOf("gpt-6-luna")), "③ 거부 배지가 없습니다");
ok(/추론 끔/.test(rowOf("gpt-6-luna")) && /추론 끔/.test(rowOf("gpt-6-astra")), "③ 「추론 끔」 보조 배지가 없습니다");
ok(!/추론 끔/.test(rowOf("gpt-4o-mini")), "③ reasoning null 인 모델에 「추론 끔」이 붙었습니다");
ok(/Responses API 필요/.test(rowOf("gpt-6-astra")), "③ gpt-6-astra 의 영구 거부 사유가 배지에 없습니다");
ok(!/정상/.test(rowOf("gpt-4.1-mini")) && !/정상/.test(rowOf("gpt-6-sol")), "④ 미점검 행에 「정상」이 보입니다(§16.6)");
ok(!/mxCheckOne/.test(rowOf("claude-sonnet-5-5")) && !/미점검/.test(rowOf("claude-sonnet-5-5")), "② Claude(키 있음) 행에 점검 링크·미점검 배지가 붙었습니다 — 운영 챗봇은 OpenAI 전용");
ok(/키 없음/.test(rowOf("claude-haiku-4-5")) && !/mxCheckOne/.test(rowOf("claude-haiku-4-5")), "② 키 없는 행 표기가 바뀌었습니다");
ok(/badge r[^>]*>실패/.test(rowOf("gpt-4o")), "⑨ note·ms 가 null 인 실패 행이 「실패」 배지로 나오지 않습니다");

// ⑤ 할 일 — 기본 모델 거부 = 빨강 · 규칙 2 미점검 = 파랑
ok(/badge r/.test(todo) && /기본 모델 gpt-6-luna 이\(가\) 마지막 점검/.test(todo) && /거부됨: 도구\+추론/.test(todo), "⑤ 기본 모델 점검 실패가 빨강 할 일로 오르지 않았습니다");
ok(/예외 규칙 2 gpt-6-sol 은 아직 점검한 적이 없습니다/.test(todo), "⑤ 작동 중 예외 규칙 모델의 미점검이 파랑 할 일로 오르지 않았습니다");
ok(!/gpt-4\.1-mini 은 아직 점검/.test(todo), "⑤ 대상이 아닌 모델(gpt-4.1-mini)의 미점검이 할 일에 올랐습니다");
ok(/거부됨/.test(cards), "⑤ 기본 모델 카드에 점검 배지가 없습니다");

// ⑥·⑦ 안전
ok(!rows.includes("<script>") && !todo.includes("<script>"), "⑥ 벤더 원문의 <script> 가 그대로 나왔습니다");
ok(/title="[^"]*&quot;[^"]*"/.test(rowOf("gpt-6-luna")), "⑥ 원문 따옴표가 &quot; 로 이스케이프되지 않았습니다(속성 깨짐)");
ok(!/sk-[A-Za-z0-9_-]{20,}/.test(rows + todo + cards), "⑦ 키 값처럼 보이는 문자열이 화면에 있습니다");

/* ── 5. 「점검」 클릭 경로 — fetch 스텁으로 네 갈래 + 재렌더 경합 ─────── */
auth = { at: "token" };
const cell = (id) => (cells.get(id) || {}).innerHTML || "";
const noteEl = () => els.get("mxCheckNote").textContent;
// (a) 200 · 기록됨 → 셀만 갱신, 잠금 해제, 할 일 재계산
fetchQueue = [{ status: 200, data: { ok: true, result: { model_id: "gpt-4.1-mini", checked: true, ok: true, status: 200, ms: 900, note: "정상", shape: { temp: true, maxKey: "max_tokens", reasoning: null }, adjustments: [], detail: { pt: 10, ct: 2, cost_usd: 0.00001 }, checked_at: AT, recorded: true } } }];
let r = await g.mxCheckModel("gpt-4.1-mini");
ok(r && r.status === 200, "⑩(a) 200 경로 반환값");
ok(/정상 0\.9초/.test(cell("gpt-4.1-mini")), "⑩(a) 셀이 「정상 0.9초」로 부분 갱신되지 않았습니다: " + cell("gpt-4.1-mini"));
ok(Object.keys(g.MX_BUSY).length === 0, "⑩(a) 점검 뒤 MX_BUSY 가 비지 않았습니다");
ok(fetchLog[0].body.action === "test_model" && fetchLog[0].body.relearn === false && fetchLog[0].url === g.CHAT_GATEWAY, "⑩(a) 요청이 채팅 게이트웨이 test_model 이 아닙니다");
// (b) 409 need_force · 취소 → 오류가 아니라 「건너뜀」 파랑, 요청 1건만
fetchQueue = [{ status: 409, data: { error: "이 모델은 점검 1회 비용 상한이 $0.25 입니다 — 확인 후 실행하세요.", bound_usd: 0.25, need_force: true } }];
confirmAnswer = false; const n0 = fetchLog.length;
r = await g.mxCheckModel("gpt-6-astra");
ok(r && r.cancelled === true && fetchLog.length === n0 + 1, "⑩(b) 취소 시 force 재요청이 나갔거나 반환값이 다릅니다");
ok(/badge b">건너뜀 — 비용 확인 취소/.test(cell("gpt-6-astra")) && !/badge r/.test(cell("gpt-6-astra").replace(/badge r" title="x">거부됨[^<]*<\/span>/, "")), "⑩(b) 취소가 빨간 오류 배지로 남습니다: " + cell("gpt-6-astra"));
ok(/취소/.test(noteEl()), "⑩(b) 안내문에 취소가 없습니다");
// (c) 429 → 「방금 점검함 — n초 뒤」
fetchQueue = [{ status: 429, data: { error: "방금 점검했습니다", retry_after_s: 7 } }];
r = await g.mxCheckModel("gpt-4o-mini");
ok(/방금 점검함 — 7초 뒤/.test(cell("gpt-4o-mini")), "⑩(c) 429 배지가 없습니다: " + cell("gpt-4o-mini"));
// (d) 네트워크 실패 → 고정 한국어 문구, 원문은 title 에만
fetchQueue = [{ throw: true }];
r = await g.mxCheckModel("gpt-6-sol");
ok(/badge r" title="[^"]*Failed to fetch[^"]*">연결 실패\(네트워크\)/.test(cell("gpt-6-sol")), "⑩(d) 네트워크 실패 배지 문구·title 이 다릅니다: " + cell("gpt-6-sol"));
ok(Object.keys(g.MX_BUSY).length === 0, "⑩ 실패 경로 뒤 MX_BUSY 가 남았습니다");
// (e) 지난 점검 실패 모델은 relearn:true 로 보낸다
fetchQueue = [{ status: 200, data: { ok: true, result: { model_id: "gpt-6-luna", checked: true, ok: true, status: 200, ms: 1500, note: "정상", shape: { temp: true, maxKey: "max_completion_tokens", reasoning: "none" }, adjustments: ["max_completion_tokens 사용", "reasoning_effort none"], detail: {}, checked_at: AT, recorded: true } } }];
await g.mxCheckModel("gpt-6-luna");
ok(fetchLog[fetchLog.length - 1].body.relearn === true, "⑩(e) 실패했던 모델의 재점검이 relearn:true 를 보내지 않습니다");
ok(!/badge r/.test(els.get("mxTodo").innerHTML.replace(/badge r">지금/g, "")) || !/gpt-6-luna 이\(가\) 마지막 점검/.test(els.get("mxTodo").innerHTML), "⑩(e) 정상으로 바뀐 기본 모델이 여전히 빨간 할 일에 있습니다");
// (f) 재렌더 경합 — 응답 대기 중 화면이 다시 그려져도 결과는 새 객체·셀에 남고, 2차 요청은 막힌다
let release; const gate = new Promise((res) => { release = res; });
fetchQueue = [{ status: 200, defer: gate, data: { ok: true, result: { model_id: "gpt-4o", checked: true, ok: true, status: 200, ms: 800, note: "정상", shape: {}, adjustments: [], detail: {}, checked_at: AT, recorded: true } } }];
const pending = g.mxCheckModel("gpt-4o");
await Promise.resolve();
ok(g.MX_BUSY["gpt-4o"] === true, "⑪ 진행 중 MX_BUSY 가 세워지지 않았습니다");
g.renderModelSettings(sample());                          // 저장·새로고침이 끼어든 상황(새 객체)
ok(/점검 중…/.test(els.get("amModelRows").innerHTML.match(/<tr data-model="gpt-4o"[\s\S]*?<\/tr>/)[0]), "⑪ 재렌더 뒤 「점검 중…」 배지가 사라졌습니다");
ok((await g.mxCheckModel("gpt-4o")) === null, "⑪ 진행 중인 모델에 2차 요청이 나갔습니다");
release(); await pending;
ok(g.mxFind("gpt-4o").last_check_ok === true, "⑪ 결과가 재렌더 뒤의 새 객체에 기록되지 않았습니다");
ok(/정상 0\.8초/.test(cell("gpt-4o")), "⑪ 셀이 새 결과로 갱신되지 않았습니다: " + cell("gpt-4o"));
ok(!(/gpt-4o 이\(가\) 마지막 점검/.test(els.get("mxTodo").innerHTML)), "⑪ 할 일이 옛 상태를 봅니다");

if (failed) { console.error(`✘ 모델 설정 탭 회귀 실패 ${failed}건`); process.exit(1); }
console.log(`✔ 모델 설정 탭 렌더 회귀 통과 — 행 ${trs.length} · 점검 링크 ${links.length} · 클릭 경로 6종 · amModelRows:${rows.length} · mxTodo:${todo.length}`);
