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
for (const id of ["tab-cost", "panel-cost", "vcCards", "vcNote", "vcBudgetRows", "vcStageRows", "vcPriceRows",
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
  assume: { in_tokens: 6000, out_tokens: 700, cache_hit: 0.4,
            note: "질문 1건 = 입력 6,000 · 출력 700 토큰, 입력의 40% 캐시 적중 가정 · 모델별 토큰 계수 반영" },
  models: [
    // 고성능 2종 · 범용 1종 · 경량 3종 · 이전 세대 1종 — 등급 묶음과 메타 표시를 함께 본다
    { model_id: "claude-opus-5-5", stage: 4, recommended: true, vendor: "Anthropic", vendor_key: "anthropic", purpose: "고난도 기획·분석", tier: "flagship",
      price_in: 4, price_cache_in: 0.2, price_out: 20, context_k: 1000, token_factor: 1.3, active: false, callable: false,
      status_note: "Anthropic 권고 기본", per_1k_questions_usd: 26.6, price_cache_in_eff: 0.2 },
    { model_id: "gpt-6-astra", stage: 5, recommended: false, vendor: "OpenAI", vendor_key: "openai", purpose: "최상위", tier: "flagship",
      price_in: 10, price_cache_in: 1, price_out: 50, context_k: null, token_factor: 1, active: false, callable: true,
      status_note: "OpenAI 플래그십", per_1k_questions_usd: 61.4, price_cache_in_eff: 1 },
    { model_id: "claude-sonnet-5-5", stage: 3, recommended: true, vendor: "Anthropic", vendor_key: "anthropic", purpose: "전사 워크호스", tier: "workhorse",
      price_in: 2, price_cache_in: 0.2, price_out: 10, context_k: 1000, token_factor: 1.3, active: false, callable: false,
      status_note: null, per_1k_questions_usd: 13.3, price_cache_in_eff: 0.2 },
    { model_id: "gpt-6-luna", stage: 1, recommended: true, vendor: "OpenAI", vendor_key: "openai", purpose: "대량·집중", tier: "light",
      price_in: 0.1, price_cache_in: 0.01, price_out: 0.5, context_k: null, token_factor: 1, active: false, callable: true,
      status_note: "기본 모델 교체 1순위 후보", per_1k_questions_usd: 0.73, price_cache_in_eff: 0.01 },
    { model_id: "gpt-4o-mini", stage: 1, recommended: false, vendor: "OpenAI", vendor_key: "openai", purpose: "현 운영 기본", tier: "light",
      price_in: 0.15, price_cache_in: 0.075, price_out: 0.6, context_k: null, token_factor: 1, active: true, callable: true,
      status_note: "현 운영 기본 모델", per_1k_questions_usd: 0.96, price_cache_in_eff: 0.075 },
    { model_id: "claude-haiku-4-5", stage: 2, recommended: false, vendor: "Anthropic", vendor_key: "anthropic", purpose: "분류·채점", tier: "light",
      price_in: 1, price_cache_in: 0.1, price_out: 5, context_k: 200, token_factor: 1, active: true, callable: false,
      status_note: "Active — 은퇴 공지 없음. 보장 기한 2026-10-15(은퇴일이 아니다 · 은퇴 시 60일 전 통지)", per_1k_questions_usd: 7.3, price_cache_in_eff: 0.1 },
    { model_id: "gpt-4.1-mini", stage: 1, recommended: false, vendor: "OpenAI", vendor_key: "openai", purpose: "에이전트 예비", tier: "light",
      price_in: 0.4, price_cache_in: 0.1, price_out: 1.6, context_k: null, token_factor: 1, active: true, callable: true,
      status_note: "부서 에이전트 예비 모델", per_1k_questions_usd: 3.52, price_cache_in_eff: 0.1 },
    { model_id: "claude-sonnet-5", stage: 3, recommended: false, vendor: "Anthropic", vendor_key: "anthropic", purpose: "에이전트 기본", tier: "legacy",
      price_in: 2, price_cache_in: 0.2, price_out: 10, context_k: null, token_factor: 1.3, active: true, callable: false,
      status_note: "⚠ 이전 세대인데 구매 에이전트 v1 의 기본으로 남아 있다 — Sonnet 5.5 로 옮길 것", per_1k_questions_usd: 13.3, price_cache_in_eff: 0.2 },
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

const areas = ["vcCards", "vcNote", "vcBudgetRows", "vcStageRows", "vcPriceRows", "vcModelRows", "vcTrend", "vcOrchRows", "apiKeyRows"];
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

// 단계별 권장 — 「무슨 일에 무슨 모델」이 1~5단계로 보이고, 권장과 실제 배정이 어긋나면 눈에 띄어야 한다
for (const t of ["일상 조회", "분류·채점", "부서 업무", "고난도", "최상위"]) must("vcStageRows", t, `단계 이름(${t})`);
must("vcStageRows", "gpt-6-luna", "1단계 권장(gpt-6-luna)");
must("vcStageRows", "claude-sonnet-5-5", "3단계 권장(claude-sonnet-5-5)");
must("vcStageRows", "claude-opus-5-5", "4단계 권장(claude-opus-5-5)");
must("vcStageRows", "권장 없음", "5단계는 권장을 두지 않는다($10/$50 대)");
// 권장 모델의 활성·호출 상태가 보여야 한다 — 「권장인데 못 부른다」를 숨기면 안 된다
must("vcStageRows", "호출불가", "권장 모델의 호출 불가 표시");
must("vcStageRows", "미배정", "배정 안 된 단계 표시");
// 단가표 행에도 단계·권장 배지
must("vcPriceRows", "1단계", "단가표 단계 배지");
must("vcPriceRows", "권장", "단가표 권장 배지");

// 단가 비교 — 등급 묶음이 먼저다(고성능/범용/경량/이전 세대를 구분해야 배정 판단이 된다)
for (const t of ["고성능", "범용", "경량", "이전 세대"]) must("vcPriceRows", t, `등급 소제목(${t})`);
if (html("vcPriceRows").indexOf("고성능") > html("vcPriceRows").indexOf("경량")) fail("등급 순서가 고성능 → 경량이 아닙니다.");
must("vcPriceRows", "최저", "최저 단가 배지");
must("vcPriceRows", "×", "상대 배수 표시");
must("vcPriceRows", "챗봇 기본", "챗봇 기본 모델 표시");
must("vcPriceRows", "구매 에이전트 예비", "예비 모델 표시");
// 현행 라인업이 실제로 보이는가(카탈로그가 낡으면 여기서 걸린다)
for (const m of ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-astra", "gpt-6-luna"]) must("vcPriceRows", m, `현행 모델 행(${m})`);
// 비용 판단에 필요한 세 값 — 캐시 입력 단가 · 컨텍스트 · 토큰 계수
must("vcPriceRows", "$0.20", "캐시 입력 단가(Opus 5.5 $0.20)");
must("vcPriceRows", "1M", "컨텍스트 1M 표시");
must("vcPriceRows", "200K", "컨텍스트 200K 표시");
must("vcPriceRows", "×1.30", "토큰 계수 배지");
// 컨텍스트를 모르는 모델은 0 이 아니라 「—」 여야 한다(없는 값을 만들지 않는다)
if (!html("vcPriceRows").includes('color:var(--muted)">—<')) fail("컨텍스트 미확인 모델이 「—」로 표시되지 않습니다.");
// 은퇴 예고는 경고색으로 눈에 띄어야 한다
must("vcPriceRows", "보장 기한", "모델 수명 정보 표시(은퇴 공지가 아니라 보장 기한임을 밝힌다)");
if (html("vcPriceRows").includes("은퇴 예고")) fail("「은퇴 예고」로 단정하는 문구가 있습니다 — 공식 상태는 Active 입니다.");
if (!/color:var\(--red\)">⚠/.test(html("vcPriceRows"))) fail("⚠ 가 붙은 상태 메모가 경고색(--red)으로 표시되지 않습니다.");
// 환산 가정은 서버가 보낸 문구를 그대로 적어야 한다 — 화면에 숫자를 따로 박으면 서버와 어긋난다
must("vcPriceNote", "입력 6,000", "환산 가정 문구(서버 assume)");
must("vcPriceNote", "40% 캐시 적중", "캐시 적중 가정");
must("vcPriceNote", "토큰 계수", "토큰 계수 설명");
// 「최저」 배지는 **호출 가능한** 최저가 모델 한 곳에만 — 못 부르는 모델이 기준이면 비교가 헛돈다
{
  const lowest = html("vcPriceRows").split("<tr").filter((r) => r.includes("최저"));
  if (lowest.length !== 1) fail(`「최저」 배지가 ${lowest.length}개입니다(1개여야 합니다).`);
  if (!lowest[0].includes("gpt-6-luna")) fail("「최저」 배지가 호출 가능한 최저가 모델(gpt-6-luna)에 붙지 않았습니다.");
}

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
