// _test_cost_tab.mjs — 관리자 콘솔 「💳 AI 비용·예산」 탭 렌더 회귀 (REQ-0091 · ADR-111)
//
// 실행:  node _test_cost_tab.mjs
//
// 무엇을 지키려는 테스트인가
//   이 탭은 **돈 숫자**를 보여 준다. 조용히 비거나 0 으로 보이면 관리자가 잘못된 판단을 한다.
//   그래서 표본 응답 하나로 ① 예외 없이 렌더되는지 ② 출처 배지(벤더 실측/내부 추정)가 구분돼 나오는지
//   ③ 예산 미설정·잔액 미확인이 0 이 아니라 「미설정/—」 로 나오는지 ④ 호출 불가 모델 경고가 뜨는지
//   ⑤ 기준일 없는 잔액 저장을 막는지 를 확인한다.
//   또 ⑥ **키 값처럼 보이는 문자열이 화면에 나오지 않는지**(CLAUDE.md §1.1·§1.8) 를 본다.
//
// jsdom 을 쓰지 않는다(이 PC 에 없다) — 필요한 최소 DOM 만 흉내 내고, 검사 대상 JS 는
// 04_챗봇_포털_데모UI.html 에서 **런타임에 꺼내 온다**. 그래서 화면을 고치면 테스트가 같은 코드를 본다.
// 테스트 파일 자리는 아직 정본이 없다(REQ-0063) — 루트 `_build_*.py` 와 같은 `_` 접두 도구 규약을 따른다.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const HTML = join(ROOT, "04_챗봇_포털_데모UI.html");

/* ── 1. 검사 대象 블록을 화면 파일에서 꺼낸다 ───────────────────────────── */
const src = readFileSync(HTML, "utf8");
const mark = src.indexOf("   💳 AI 비용·예산 탭 (REQ-0091");
if (mark < 0) fail("04_챗봇_포털_데모UI.html 에서 「💳 AI 비용·예산」 JS 블록을 찾지 못했습니다(주석 머리글이 바뀐 듯).");
const start = src.lastIndexOf("/*", mark);
const end = src.indexOf("/* ===== 사용모델 설정 렌더·저장", mark);
if (end < 0) fail("블록의 끝(사용모델 설정 렌더) 주석을 찾지 못했습니다.");
const block = src.slice(start, end);

/* 화면 쪽 요소가 실제로 있는지도 같이 본다 — id 오타 한 글자로 탭이 비는 것을 막는다 */
for (const id of ["tab-cost", "panel-cost", "vcCards", "vcNote", "vcBudgetRows", "vcPriceRows",
                  "vcModelRows", "vcModelNote", "vcTrend", "vcTrendRange", "vcOrchRows", "apiKeyRows"]) {
  if (!src.includes(`id="${id}"`)) fail(`화면에 id="${id}" 가 없습니다.`);
}
if (!src.includes("'cost','permacct'")) fail("showTab 목록에 'cost' 가 없습니다 — 탭을 눌러도 패널이 열리지 않습니다.");
if (!src.includes("/admin/api-setup")) fail("「🔑 API 설정방법」 링크(/admin/api-setup)가 없습니다.");

/* ── 2. 최소 DOM 흉내 ──────────────────────────────────────────────────── */
const els = new Map();
class El {
  constructor(id) { this.id = id; this.innerHTML = ""; this.textContent = ""; this.className = ""; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getAttribute() { return null; }
}
let alerted = "";
const g = globalThis;
g.document = {
  getElementById: (id) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); },
  querySelectorAll: () => [],
};
g.window = { IS_BUNDLE: false };
g.localStorage = { getItem: () => null };
g.escHtml = (x) => String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
g.fmtKST = (x) => String(x || "");
g.getLiveAuth = () => null;
g.ADMIN_GATEWAY = "http://example.invalid";
g.alert = (m) => { alerted = String(m || ""); };

/* 블록 안 함수들을 전역에 올린다(var 선언이라 indirect eval 로 전역에 붙는다) */
// deno-lint-ignore no-eval
(0, eval)(block);

/* ── 3. 표본 응답 — OpenAI=벤더 실측 / Anthropic=키 없음(내부 추정) ────── */
const D = {
  ok: true, as_of: "2026-09-29T01:00:00Z", month: { start: "2026-09-01", today: "2026-09-29" },
  keys: [
    { env: "OPENAI_API_KEY", vendor: "openai", role: "call", set: true, len: 164, expect_prefix: "sk-", prefix_ok: true, need: "GPT 호출" },
    { env: "OPENAI_ADMIN_KEY", vendor: "openai", role: "admin", set: true, len: 180, expect_prefix: "sk-admin-", prefix_ok: true, need: "사용량 조회" },
    { env: "ANTHROPIC_API_KEY", vendor: "anthropic", role: "call", set: false, len: 0, expect_prefix: "sk-ant-", prefix_ok: null, need: "Claude 호출" },
    { env: "ANTHROPIC_ADMIN_KEY", vendor: "anthropic", role: "admin", set: true, len: 120, expect_prefix: "sk-ant-admin", prefix_ok: false, need: "사용량 조회" },
  ],
  vendors: [
    {
      vendor: "openai", label: "OpenAI", billing_mode: "prepaid_credit", console_url: "https://example.invalid/billing",
      call_key_set: true, admin_key_set: true, source: "vendor_api", error: null, window_start: "2026-09-01",
      month_spend_usd: 12.4013,
      by_day: [{ day: "2026-09-27", cost_usd: 1.2 }, { day: "2026-09-28", cost_usd: 0 }, { day: "2026-09-29", cost_usd: 3.4 }],
      by_model: [
        { model: "gpt-4.1-mini", in_tokens: 1234567, cached_tokens: 900000, out_tokens: 45678, requests: 311, cost_usd: 11.9 },
        { model: "(토큰 외: web_search)", in_tokens: 0, cached_tokens: 0, out_tokens: 0, requests: 0, cost_usd: 0.5 },
      ],
      budget: { monthly_budget_usd: 50, set: true, remaining_usd: 37.6, ratio: 0.248, alert_ratio: 0.8 },
      credit: { added_usd: 120, as_of: "2026-09-01", spent_since_usd: 12.4013, remaining_usd: 107.6, stale: false, reason: null },
    },
    {
      vendor: "anthropic", label: "Anthropic (Claude)", billing_mode: "prepaid_credit", console_url: null,
      call_key_set: false, admin_key_set: false, source: "internal_estimate",
      error: "ANTHROPIC_ADMIN_KEY 미등록 — 벤더 청구액을 읽을 수 없어 내부 추정치를 보여 줍니다.",
      window_start: "2026-09-01", month_spend_usd: 0, by_day: [], by_model: [],
      budget: { monthly_budget_usd: 0, set: false, remaining_usd: null, ratio: null, alert_ratio: 0.8 },
      credit: { added_usd: null, as_of: null, spent_since_usd: null, remaining_usd: null, stale: false,
                reason: "충전 잔액 미입력 — 벤더 콘솔에서 확인한 금액과 날짜를 적으면 역산합니다." },
    },
  ],
  models: [
    { model_id: "gpt-4o-mini", vendor: "OpenAI", vendor_key: "openai", purpose: "기본", price_in: 0.15, price_out: 0.6, active: true, callable: true, per_1k_questions_usd: 1.32 },
    { model_id: "claude-sonnet-5", vendor: "Anthropic", vendor_key: "anthropic", purpose: "에이전트 기본", price_in: 2, price_out: 10, active: true, callable: false, per_1k_questions_usd: 19 },
    { model_id: "gpt-4.1-mini", vendor: "OpenAI", vendor_key: "openai", purpose: "경량", price_in: 0.4, price_out: 1.6, active: true, callable: true, per_1k_questions_usd: 3.52 },
  ],
  orchestration: {
    gateway: { default_model: "gpt-4o-mini", vendor: "openai", max_tokens: 1024, prompt_caching: true },
    agents: [{
      agent_key: "purchase", name_ko: "구매 에이전트", dept_nm: "구매팀", status: "pilot", version: 1,
      model_id: "claude-sonnet-5", model_vendor: "anthropic", model_callable: false,
      fallback_model_id: "gpt-4.1-mini", fallback_vendor: "openai", effort: "medium",
      monthly_budget_usd: 150, daily_limit: 50,
    }],
    routing: [{ seq: 1, label: "긴 질문", rule_type: "keyword_length", model_id: "gpt-4o", active: true, enforced: false, vendor: "openai" }],
  },
};

function fail(msg) { console.error("✖ 실패 — " + msg); process.exit(1); }
const html = (id) => g.document.getElementById(id).innerHTML;
function must(id, needle, why) { if (!html(id).includes(needle)) fail(`${why} (${id} 에 「${needle}」 없음)`); }

/* ── 4. 렌더 ───────────────────────────────────────────────────────────── */
g.renderVendorCost(D);

const areas = ["vcCards", "vcNote", "vcBudgetRows", "vcPriceRows", "vcModelRows", "vcTrend", "vcOrchRows", "apiKeyRows"];
const empty = areas.filter((id) => html(id).length < 20);
if (empty.length) fail("비어 있는 영역 — " + empty.join(", "));

// 출처가 구분돼 보이는가 — 이 둘을 섞으면 금액 해석이 틀린다
must("vcCards", "벤더 실측", "OpenAI 출처 배지");
must("vcCards", "내부 추정", "Anthropic 출처 배지");
must("vcCards", "$12.40", "OpenAI 이번 달 사용액");
must("vcCards", "$37.60", "예산 잔여(역산)");
must("vcCards", "$107.60", "충전 잔액 역산");
// 없는 값을 0 으로 꾸미지 않는가
must("vcCards", "월 예산 미설정", "예산 미설정 표기");
must("vcCards", "ANTHROPIC_ADMIN_KEY 미등록", "조회 키 없음 사유");
must("vcBudgetRows", "미설정", "예산 미설정 칸");
must("vcBudgetRows", "충전 잔액 미입력", "잔액 미확인 사유");

// 단가 비교 — 최저 표시와 상대 배수, 그리고 「지금 쓰는 곳」
must("vcPriceRows", "최저", "최저 단가 배지");
must("vcPriceRows", "×", "상대 배수 표시");
must("vcPriceRows", "챗봇 기본", "챗봇 기본 모델 표시");
must("vcPriceRows", "구매 에이전트 예비", "예비 모델 표시");

// 모델별 — 청구에만 있는 토큰 외 비용을 버리지 않는가
must("vcModelRows", "토큰 외", "토큰 외 비용 행");
if (!/9[56]\.\d%/.test(html("vcModelRows"))) fail("모델별 비중 계산 이상 — " + html("vcModelRows").slice(0, 200));

// 배정 — 부를 수 없는 모델이 지정돼 있으면 경고해야 한다(지금 실제 상황이다)
must("vcOrchRows", "호출 불가", "호출 불가 경고");
must("vcOrchRows", "구매 에이전트", "에이전트 행");
must("vcOrchRows", "표시만", "미적용 라우팅 표시");

// 키 표 — 상태만 있고 값은 없어야 한다
must("apiKeyRows", "미등록", "미등록 배지");
must("apiKeyRows", "접두어 불일치", "접두어 불일치 배지");
// 화면에 일부러 적는 「기대 접두어」(<code>sk-ant-admin</code> 등)는 빼고 본다 — 실제 키는 40자를 넘는다
const keyHtml = html("apiKeyRows").replace(/<code>[\s\S]*?<\/code>/g, "");
if (/sk-[A-Za-z0-9_-]{24,}/.test(keyHtml)) fail("키 값처럼 보이는 문자열이 화면에 있습니다(§1.1·§1.8 위반).");

// 추이
must("vcTrend", "2026-09-29", "일별 추이 날짜");
must("vcTrend", "최고", "추이 최고값");

/* ── 5. 가드 — 기준일 없는 잔액은 저장을 막아야 한다 ────────────────────── */
g.document.querySelectorAll = () => ([{
  getAttribute: (k) => ({ "data-vendor": "openai", "data-label": "OpenAI", "data-console": "" })[k],
  querySelector: (sel) => ({ value: ({ ".vc-mode": "prepaid_credit", ".vc-budget": "50", ".vc-credit": "120", ".vc-asof": "" })[sel] }),
}]);
alerted = "";
g.saveVendorBudget();
if (!/함께 적어야/.test(alerted)) fail("잔액만 있고 확인일이 없는데 저장을 막지 않았습니다.");

console.log("✔ 비용·예산 탭 렌더 회귀 통과 — 영역 " + areas.length + "개 · " +
  areas.map((id) => id + ":" + html(id).length).join(" · "));
