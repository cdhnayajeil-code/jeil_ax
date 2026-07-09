// jeil-chat — 사내 AI 챗봇 게이트웨이 (OpenAI 프록시 + 포털DB 조회 도구 + 토큰·비용 기록)
// 배포: verify_jwt=false (Entra 토큰은 Supabase JWT가 아니므로 내부에서 직접 검증)
// 호출: POST /functions/v1/jeil-chat  Authorization: Bearer <Entra access_token(User.Read)>
//   body: { messages: [{role:'user'|'assistant', content:string}, ...] }
//   응답: SSE 스트림 — data: {"choices":[{"delta":{"content":"..."}}]} ... data: [DONE]
// 원칙(CLAUDE.md §1·§4·§6):
//   - API 키는 서버 시크릿(OPENAI_API_KEY)에만 존재. 프론트 미노출.
//   - 데이터 접근은 사전 등록된 읽기전용 도구만(모델의 임의 SQL 금지). 포털DB + ERP 중간DB 사본(public.v_erp_* 뷰) — ERP 운영DB 직접 조회는 없음.
//   - chat_log에 사용 이력 + 토큰·추정비용·사용도구 기록(대화 원문 미저장).
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

// 입력 상한 폴백 기본값 (DB ai_gateway_config 미설정/조회실패 시에만 사용)
const MAX_MESSAGES = 20;
const MAX_MSG_CHARS = 8000;
const MAX_TOTAL_CHARS = 24000;
const MAX_TOKENS = 1024;
const DEFAULT_TEMP = 0.3;

// 모델 단가표 폴백 (USD / 1M 토큰). 실제 단가는 DB ai_model(price_in/price_out) 우선.
const PRICES: Record<string, { inp: number; out: number }> = {
  "gpt-4o-mini": { inp: 0.15, out: 0.60 },
  "gpt-4o": { inp: 2.50, out: 10.00 },
  "gpt-4.1-mini": { inp: 0.40, out: 1.60 },
};

const SYSTEM_PROMPT =
  "당신은 제일엠앤에스(JEIL M&S)의 사내 AI 어시스턴트 'jeil-chat'입니다. " +
  "업무 문서 초안(주간보고·메일·공지), 규정 질의, 데이터 요약을 한국어로 간결하고 정확하게 돕습니다. " +
  "협력사 외주 '검사' 현황은 포털 도구(get_order_summary/get_order_detail 등)로 답하고, 답변에 조회 기준 시각을 표기하세요. " +
  "매출·매입·재고·품목·발주 등 ERP 데이터는 ERP 중간DB 조회 도구(get_erp_*)를 사용하되, 유니포인트 매핑 확정 전 '파일럿 데이터'임을 답변에 밝히세요. " +
  "'발주'는 기본적으로 ERP 전체 구매발주(get_erp_pur_order)를 의미합니다. 특정 발주번호(PO)·구매요청번호(PR) 조회는 get_erp_po_pr, '가장 금액이 큰/최대/상위(top) 발주·구매요청'은 get_erp_pur_top 을 쓰세요(임의 레코드를 최대라고 답하지 말 것). 구매요청 자체엔 금액 컬럼이 없어 연결된 발주금액 기준으로 판단합니다. 협력사 외주 검사 관련일 때만 get_order_summary(포털)를 쓰고, 서로 다른 발주 데이터를 혼동하지 마세요. " +
  "월별 표를 그릴 때는 도구가 반환한 '월별' 배열의 각 월 값을 그대로 사용하고, 값이 없는 월을 임의로 '미제공'으로 적지 마세요. " +
  "ERP 발주·구매요청의 진행단계 코드는 반드시 한글로 풀어 답하세요: RQ(요청)→CF(확정)→PO(발주완료·입고전)→GR(입고완료)→IV(매입/송장완료). 진행수량은 요청(req_qty)→발주(ord_qty)→입고(rcpt_qty)→매입(iv_qty) 순이며, 도구가 준 이 수량으로 '어디까지 진행됐는지'를 설명하세요. " +
  "'매입'의 공식 집계는 송장 기준 get_erp_purchase_monthly(거래처×월)입니다. 개별 발주의 상태 IV는 그 발주의 '매입완료' 진행표시로만 해석하고, 두 수치를 합산·혼동하지 마세요. " +
  "재고·입고 수치(get_erp_inventory_status)는 현재 중간DB에 출고만 유효하고 입고량·재고량은 미적재입니다 — '입고 0/재고 없음'을 실적으로 단정하지 말고 미적재 상태임을 밝히며, 특정 발주의 입고 여부는 발주 조회(get_erp_po_pr)의 입고수량으로 답하세요. 매출의 수금액·수주액도 미매핑(0)이니 매출액만 답하세요. " +
  "품목명에 '사용금지' 표기가 있는 코드는 신규 발주용으로 제시하지 말고 대체코드 확인을 안내하세요. " +
  "도구가 '접근제한'(요청안내)을 반환하면 데이터를 지어내지 말고, 반환된 '안내' 문구 그대로 사용자에게 관리자 권한 요청 방법을 안내하세요. " +
  "도구로 조회할 수 없는 사내 수치·규정은 추측하지 말고 원본 확인을 권하세요. " +
  "급여·주민번호 등 개인정보나 비밀값을 답변에 포함하지 마세요.";

/* ===== 1단계 포털DB 조회 도구 (읽기전용 · 집계/요약만 반환) ===== */
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_order_summary",
      description: "협력사 '외주 검사' 발주 현황(포털DB — 협력사 포털에 등록된 외주 검사 대상 발주, 소수 건). 상태별 건수·검사 진행·납기임박. ※ ERP 전체 구매발주(수천 건·월별)는 get_erp_pur_order 를 쓸 것.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_order_detail",
      description: "협력사 '외주 검사' 발주 상세만 조회(포털DB, 소수 건) — 진행상태(10단계)·검사결과·검수요청·사진·메시지 건수. ※일반 ERP 구매발주(PO…번호)의 발주 상세·품목·금액·거래처·구매요청은 이 도구가 아니라 get_erp_po_pr 를 쓸 것. 협력사 검사 대상이 아닌 발주번호는 여기서 조회되지 않는다.",
      parameters: {
        type: "object",
        properties: { po_no: { type: "string", description: "발주번호 (예: PO202607010128)" } },
        required: ["po_no"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_inspection_pending",
      description: "검수요청이 접수됐지만 아직 합/부 판정이 나지 않은(검사 대기) 발주 목록 — 발주번호, 협력사, 납기, 요청일시.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  /* ===== 2단계 ERP 중간DB 조회 도구 (사내 실데이터 · 읽기전용 뷰 v_erp_* · 파일럿) ===== */
  {
    type: "function",
    function: {
      name: "get_erp_sales_monthly",
      description: "ERP 매출 월집계(중간DB 사내 실데이터) — 거래처×월 매출액·건수(현재 가용 2026-01~). '이번달 매출', '거래처별 매출' 류 질의에 사용. ※수금액·수주액은 미매핑(0)이니 매출액만 답할 것. 파일럿(유니포인트 매핑 확정 전).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_purchase_monthly",
      description: "ERP 매입 월집계(중간DB 사내 실데이터, 송장 M_IV 기준) — 거래처×월 매입액·전표건수(현재 가용 2026-01~). '매입 현황', '거래처별 매입', '특정 거래처/특정 월 매입' 류 질의에 사용. bp(거래처명·코드)·ym(YYYY-MM) 지정 시 해당 거래처×월 상세 반환.",
      parameters: { type: "object", properties: { bp: { type: "string", description: "거래처명 또는 코드(선택)" }, ym: { type: "string", description: "조회 월 YYYY-MM(선택)" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_inventory_status",
      description: "ERP 재고 입출고 현황(중간DB 사내 실데이터) — 품목×창고, 최근 31일. '재고', '입출고' 류 질의에 사용. ※현재 중간DB는 출고만 유효하고 입고량·재고량은 미적재(0/미표기) — 특정 발주의 입고 여부는 get_erp_po_pr(입고수량)로 답할 것.",
      parameters: { type: "object", properties: { item_code: { type: "string", description: "품목코드(선택, 특정 품목만)" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_item",
      description: "ERP 품목 조회(중간DB 사내 실데이터) — 코드/명 부분일치로 품목 마스터 검색(규격·단위·분류·사용금지 여부). '품목 있어?', '품목코드 뭐야' 류 질의에 사용. 품목명에 '사용금지' 표기가 있으면 신규 발주 제시 금지.",
      parameters: { type: "object", properties: { keyword: { type: "string", description: "품목코드 또는 품목명 키워드" } }, required: ["keyword"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_pur_order",
      description: "ERP 전체 구매발주 현황(중간DB 사내 실데이터, 2026년 수천 건) — 월별 발주건수·발주금액·거래처수, 특정 월 상세(거래처Top·상태분포). '1월 발주', 'ERP 발주 현황', '월별 발주 얼마' 류 질의에 사용. (협력사 외주 검사 발주는 get_order_summary)",
      parameters: { type: "object", properties: { ym: { type: "string", description: "조회 월 YYYY-MM(선택, 예 2026-01). 없으면 월별 전체 요약" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_po_pr",
      description: "ERP 구매발주 상세 + 발주↔구매요청 연결 조회(중간DB 사내 실데이터, 2026 전체 수천 건). 발주번호(PO…) 또는 구매요청번호(PR…)로 발주 상세(거래처·품목·수량·발주금액·발주일·상태)와 연결 구매요청(요청일·필요납기·요청자·부서) 조회. 특정 발주번호(예: PO202606230022)의 상세·품목·금액·거래처 질의는 반드시 이 도구를 쓸 것(협력사 검사 발주가 아니면 get_order_detail 로는 조회 안 됨). 'PO… 발주 상세/내역/품목/금액', 'PO… 구매요청 뭐야', 'PR… 발주됐어?' 류. po_no 또는 pr_no 중 하나 필수.",
      parameters: { type: "object", properties: { po_no: { type: "string", description: "발주번호(예: PO202607080001)" }, pr_no: { type: "string", description: "구매요청번호(예: PR202607060009)" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_pur_top",
      description: "ERP 발주 금액 상위(top N) 조회 — 발주번호별 총액(라인 합산) 큰 순으로 발주번호·거래처·발주총액·라인수·대표품목. '가장 금액이 큰 발주', '발주 top 5', '최대 금액 구매' 류. 동일 발주 중복 없이 발주 총액 기준(라인 단위 아님).",
      parameters: { type: "object", properties: { n: { type: "integer", description: "상위 몇 건(기본 10, 최대 30)" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_receipt_pending",
      description: "ERP 미입고 발주 목록(중간DB 사내 실데이터) — 발주완료(상태 PO)됐지만 아직 입고(GR) 전인 발주 라인. '미입고 발주', '납기 지난 미입고', '입고 안 된 발주' 류 질의에 사용. overdue_only=true면 납기경과·미입고만.",
      parameters: { type: "object", properties: { overdue_only: { type: "boolean", description: "납기경과·미입고만(선택)" }, limit: { type: "integer", description: "최대 건수(기본 30, 최대 100)" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_pur_req",
      description: "ERP 구매요청(PR) 목록 조회(중간DB 사내 실데이터) — 상태·부서별 구매요청. '미발주 구매요청 몇 건/목록'(status=unordered), '우리 팀 구매요청', 'RQ(요청)/CF(확정) 상태 PR' 류. 특정 PR 단건 상세는 get_erp_po_pr(pr_no)를 쓸 것.",
      parameters: { type: "object", properties: { status: { type: "string", description: "unordered(미발주)/RQ/CF 등(선택)" }, dept: { type: "string", description: "요청부서 키워드(선택)" }, limit: { type: "integer", description: "최대 건수(기본 30, 최대 100)" } }, required: [] },
    },
  },
];

const STATUS_KO: Record<string, string> = { new: "신규", prod: "생산중", insp: "검사", done: "완료" };

// ERP 발주·구매요청 진행단계 코드(원천 po_sts/pr_sts) → 한글 해석. 진행순서: RQ→CF→PO→GR→IV
const ERP_STS_KO: Record<string, string> = {
  RQ: "요청", CF: "확정", PO: "발주완료(입고전)", GR: "입고완료", IV: "매입/송장완료",
};
const stsKo = (c: unknown): string => {
  const s = String(c ?? "").trim();
  return s ? (ERP_STS_KO[s] ? `${s}(${ERP_STS_KO[s]})` : s) : "-";
};

// ERP Tool → 데이터 모듈 매핑 (부서별 erp_scope 강제용, dept_erp_scope와 동일 키)
const ERP_TOOL_MODULE: Record<string, string> = {
  get_erp_sales_monthly: "sales", get_erp_purchase_monthly: "purchase",
  get_erp_inventory_status: "inventory", get_erp_item: "item",
  get_erp_pur_order: "pur_order", get_erp_po_pr: "pur_order", get_erp_pur_top: "pur_order",
  get_erp_receipt_pending: "pur_order", get_erp_pur_req: "pur_order",
};
// 모듈 키 → 한글 라벨 (접근제한 안내 문구용)
const MODULE_KO: Record<string, string> = {
  sales: "매출", purchase: "매입", inventory: "재고", item: "품목", pur_order: "발주·구매요청",
};

type ErpScope = { isAdmin: boolean; modules: Set<string>; dept: string | null };
// 호출자 UPN → 허용 ERP 모듈 판정 (관리자=전 모듈, 그 외=소속 부서 dept_erp_scope)
// deno-lint-ignore no-explicit-any
async function resolveErpScope(admin: any, upn: string): Promise<ErpScope> {
  const [{ data: pa }, { data: ud }] = await Promise.all([
    admin.from("portal_admin").select("email").eq("email", upn).maybeSingle(),
    admin.from("v_erp_user_dept").select("dept_nm").eq("email", upn).maybeSingle(),
  ]);
  const dept: string | null = ud?.dept_nm ?? null;
  if (pa) return { isAdmin: true, modules: new Set(), dept };
  const { data: es } = await admin.from("dept_erp_scope").select("module_key").eq("dept_nm", dept || "");
  return { isAdmin: false, modules: new Set((es || []).map((r: { module_key: string }) => r.module_key)), dept };
}

/* ===== 사용모델 설정 로드·라우팅 (SSOT: ai_gateway_config / ai_model / ai_routing_rule) =====
   원칙: 조회 실패·미설정이면 기존 하드코딩 기본값으로 안전 폴백 → 설정이 비어도 챗봇은 정상 동작한다. */
type AiModelRow = { model_id: string; vendor: string; active: boolean; callable: boolean; price_in: number; price_out: number };
type AiRuleRow = { seq: number; rule_type: string; match_keywords: string[] | null; min_chars: number | null; model_id: string; active: boolean };
type AiConfig = {
  default_model: string; max_tokens: number; temperature: number;
  max_messages: number; max_total_chars: number; system_prompt: string;
  models: AiModelRow[]; rules: AiRuleRow[];
};

function fallbackConfig(): AiConfig {
  return {
    default_model: Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini",
    max_tokens: MAX_TOKENS, temperature: DEFAULT_TEMP,
    max_messages: MAX_MESSAGES, max_total_chars: MAX_TOTAL_CHARS,
    system_prompt: SYSTEM_PROMPT, models: [], rules: [],
  };
}

// deno-lint-ignore no-explicit-any
async function loadAiConfig(admin: any): Promise<AiConfig> {
  try {
    const [cfgR, modR, rulR] = await Promise.all([
      admin.from("ai_gateway_config").select("*").eq("id", 1).maybeSingle(),
      admin.from("ai_model").select("model_id,vendor,active,callable,price_in,price_out"),
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
      system_prompt: c.system_prompt || SYSTEM_PROMPT,
      models: (modR.data as AiModelRow[]) || [],
      rules: (rulR.data as AiRuleRow[]) || [],
    };
  } catch {
    return fallbackConfig();
  }
}

// 실제 호출 가능한(active+callable+OpenAI) 모델 맵
function usableModels(ai: AiConfig): Map<string, AiModelRow> {
  return new Map(
    ai.models.filter((m) => m.active && m.callable && String(m.vendor).toLowerCase() === "openai")
      .map((m) => [m.model_id, m]),
  );
}

// 라우팅: keyword_length 규칙만 실제 적용(대상 모델이 usable일 때). 미매칭이면 기본 모델(usable 검증·폴백).
function pickModel(userText: string, ai: AiConfig): string {
  const usable = usableModels(ai);
  const envModel = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
  const safeDefault = usable.has(ai.default_model)
    ? ai.default_model
    : (usable.size ? [...usable.keys()][0] : envModel);
  const text = String(userText || "");
  for (const rule of ai.rules) {
    if (rule.rule_type !== "keyword_length") continue;            // 게이트웨이 실제 적용 유형만
    const kwHit = (rule.match_keywords || []).some((k) => k && text.includes(k));
    const lenHit = rule.min_chars != null && rule.min_chars > 0 && text.length >= rule.min_chars;
    if ((kwHit || lenHit) && usable.has(rule.model_id)) return rule.model_id;
  }
  return safeDefault;
}

// 단가 조회: DB ai_model 우선 → 폴백 PRICES 표
function priceFor(model: string, ai: AiConfig): { inp: number; out: number } {
  const m = ai.models.find((x) => x.model_id === model);
  if (m && (m.price_in || m.price_out)) return { inp: Number(m.price_in), out: Number(m.price_out) };
  return PRICES[model] || PRICES["gpt-4o-mini"];
}

// deno-lint-ignore no-explicit-any
async function runTool(admin: any, name: string, argsJson: string, scope: ErpScope): Promise<unknown> {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(argsJson || "{}"); } catch { /* 빈 인자 */ }
  const asOf = new Date().toISOString();

  // ERP 데이터 도구는 소속 부서 erp_scope로 강제(관리자 예외). 범위 밖이면 데이터 대신 안내 반환.
  const erpMod = ERP_TOOL_MODULE[name];
  if (erpMod && !scope.isAdmin && !scope.modules.has(erpMod)) {
    const modKo = MODULE_KO[erpMod] || erpMod;
    const dept = scope.dept || "소속 부서";
    return {
      접근제한: true, 요청안내: true, 모듈: erpMod, 부서: scope.dept || "미지정",
      안내: `요청하신 ERP '${modKo}' 데이터는 회원님 소속 부서(${dept})에 아직 열람 권한이 없습니다. 열람이 필요하시면 포털 관리자에게 '${dept}의 ${modKo}(${erpMod}) ERP 모듈 권한'을 요청해 주세요. (관리자 콘솔 › 사용자·부서 › 부서별 ERP 모듈 권한에서 부여)`,
    };
  }

  if (name === "get_order_summary") {
    const [{ data: heads }, { data: states }] = await Promise.all([
      admin.from("sp_order_header").select("po_no,vendor_name,due_date,amt"),
      admin.from("sp_order_state").select("po_no,status,step"),
    ]);
    const st: Record<string, { status: string; step: number }> = {};
    (states || []).forEach((s: { po_no: string; status: string; step: number }) => (st[s.po_no] = s));
    const byStatus: Record<string, number> = {};
    let totalAmt = 0;
    const vendors = new Set<string>();
    const dueSoon: unknown[] = [];
    const in7 = Date.now() + 7 * 86400000;
    for (const h of heads || []) {
      const s = st[h.po_no]?.status || "new";
      byStatus[STATUS_KO[s] || s] = (byStatus[STATUS_KO[s] || s] || 0) + 1;
      totalAmt += Number(h.amt || 0);
      vendors.add(h.vendor_name || "");
      if (s !== "done" && h.due_date && new Date(h.due_date).getTime() <= in7) {
        dueSoon.push({ 발주번호: h.po_no, 협력사: h.vendor_name, 납기: h.due_date, 상태: STATUS_KO[s] || s });
      }
    }
    return { 기준시각: asOf, 총발주: (heads || []).length, 상태별건수: byStatus, 총발주금액_원: totalAmt, 협력사수: vendors.size, 납기7일내_미완료: dueSoon };
  }

  if (name === "get_order_detail") {
    const po = String(args.po_no || "").trim();
    if (!po) return { 오류: "po_no가 필요합니다." };
    const [{ data: h }, { data: s }, { data: insp }, { data: reqs }, { data: photos }, { data: msgs }] = await Promise.all([
      admin.from("sp_order_header").select("*").eq("po_no", po).maybeSingle(),
      admin.from("sp_order_state").select("status,step,updated_at").eq("po_no", po).maybeSingle(),
      admin.from("sp_inspection").select("result,judge_id,opinion,judged_at").eq("po_no", po).maybeSingle(),
      admin.from("sp_insp_request").select("insp_req_no,requested_at").eq("po_no", po).eq("cancelled", false),
      admin.from("sp_photo").select("id").eq("po_no", po),
      admin.from("sp_message").select("id").eq("po_no", po),
    ]);
    if (!h) return { 기준시각: asOf, 오류: `발주번호 ${po} 는 협력사 외주검사 포털에 없습니다.`, 안내: "ERP 구매발주(PO…)일 수 있습니다. get_erp_po_pr 도구로 다시 조회하세요.", 재시도도구: "get_erp_po_pr", 재시도인자: { po_no: po } };
    return {
      기준시각: asOf, 발주번호: h.po_no, 협력사: h.vendor_name, 발주일: h.order_date, 납기: h.due_date,
      금액_원: Number(h.amt || 0), 품목수: Array.isArray(h.items) ? h.items.length : 0,
      상태: STATUS_KO[s?.status || ""] || s?.status || "미확인", 진행단계_10: s?.step ?? null,
      검사결과: insp ? { 판정: insp.result, 판정자: insp.judge_id, 의견: insp.opinion, 판정일: insp.judged_at } : "판정 전",
      검수요청건수: (reqs || []).length, 사진건수: (photos || []).length, 메시지건수: (msgs || []).length,
    };
  }

  if (name === "get_inspection_pending") {
    const [{ data: reqs }, { data: insps }, { data: heads }] = await Promise.all([
      admin.from("sp_insp_request").select("po_no,insp_req_no,requested_at").eq("cancelled", false),
      admin.from("sp_inspection").select("po_no"),
      admin.from("sp_order_header").select("po_no,vendor_name,due_date"),
    ]);
    const judged = new Set((insps || []).map((r: { po_no: string }) => r.po_no));
    const hm: Record<string, { vendor_name: string; due_date: string }> = {};
    (heads || []).forEach((h: { po_no: string; vendor_name: string; due_date: string }) => (hm[h.po_no] = h));
    const seen = new Set<string>();
    const pending = (reqs || [])
      .filter((r: { po_no: string }) => !judged.has(r.po_no) && !seen.has(r.po_no) && seen.add(r.po_no))
      .map((r: { po_no: string; insp_req_no: string; requested_at: string }) => ({
        발주번호: r.po_no, 협력사: hm[r.po_no]?.vendor_name || "-", 납기: hm[r.po_no]?.due_date || "-",
        검수요청번호: r.insp_req_no, 요청일시: r.requested_at,
      }));
    return { 기준시각: asOf, 판정대기건수: pending.length, 목록: pending };
  }

  /* ===== 2단계 ERP 중간DB 도구 (public.v_erp_* 뷰, service_role 조회 · 사내 실데이터) ===== */
  if (name === "get_erp_sales_monthly") {
    const { data } = await admin.from("v_erp_sales_monthly").select("*").order("ym", { ascending: false });
    const rows = data || [];
    let amt = 0, cnt = 0;
    const byBp: Record<string, { name: string; amt: number }> = {};
    const byMo: Record<string, { amt: number; cnt: number; bps: Set<string> }> = {};
    for (const r of rows) {
      amt += Number(r.sales_amt || 0); cnt += Number(r.order_cnt || 0);
      const b = (byBp[r.bp_code] = byBp[r.bp_code] || { name: r.bp_name || r.bp_code, amt: 0 });
      b.amt += Number(r.sales_amt || 0);
      const m = (byMo[r.ym] = byMo[r.ym] || { amt: 0, cnt: 0, bps: new Set() });
      m.amt += Number(r.sales_amt || 0); m.cnt += Number(r.order_cnt || 0); m.bps.add(r.bp_code);
    }
    const top = Object.values(byBp).sort((a, b) => b.amt - a.amt).slice(0, 10);
    const 월별 = Object.keys(byMo).sort().map((ym) => ({ 월: ym, 매출액_원: byMo[ym].amt, 건수: byMo[ym].cnt, 거래처수: byMo[ym].bps.size }));
    return { 기준시각: asOf, 월별, 매출액합계_원: amt, 매출건수: cnt, 거래처수: Object.keys(byBp).length,
      거래처Top10: top.map((t) => ({ 거래처: t.name, 매출액_원: t.amt })),
      안내: "ERP 중간DB 파일럿(유니포인트 매핑 확정 전). 월별 값은 각 월 실적재분이며, 미마감 최근월은 값이 작을 수 있음." };
  }

  if (name === "get_erp_purchase_monthly") {
    const { data } = await admin.from("v_erp_purchase_monthly").select("*").order("ym", { ascending: false });
    const rows = data || [];
    let amt = 0, cnt = 0;
    const byBp: Record<string, { name: string; amt: number; cnt: number }> = {};
    const byMo: Record<string, { amt: number; cnt: number; bps: Set<string> }> = {};
    for (const r of rows) {
      amt += Number(r.purchase_amt || 0); cnt += Number(r.iv_cnt || 0);
      const b = (byBp[r.bp_code] = byBp[r.bp_code] || { name: r.bp_name || r.bp_code, amt: 0, cnt: 0 });
      b.amt += Number(r.purchase_amt || 0); b.cnt += Number(r.iv_cnt || 0);
      const m = (byMo[r.ym] = byMo[r.ym] || { amt: 0, cnt: 0, bps: new Set() });
      m.amt += Number(r.purchase_amt || 0); m.cnt += Number(r.iv_cnt || 0); m.bps.add(r.bp_code);
    }
    const top = Object.values(byBp).sort((a, b) => b.amt - a.amt).slice(0, 10);
    const 월별 = Object.keys(byMo).sort().map((ym) => ({ 월: ym, 매입액_원: byMo[ym].amt, 전표건수: byMo[ym].cnt, 거래처수: byMo[ym].bps.size }));
    // 거래처·월 필터(선택) — Top10 밖 거래처/특정 월 매입 조회
    const bpKw = String(args.bp || "").replace(/[,()*%]/g, "").trim();
    const ymF = String(args.ym || "").replace(/[^0-9-]/g, "").slice(0, 7);
    let 필터결과: unknown = null;
    if (bpKw || /^\d{4}-\d{2}$/.test(ymF)) {
      const f = rows.filter((r: Record<string, unknown>) =>
        (!bpKw || String(r.bp_name || "").includes(bpKw) || String(r.bp_code || "") === bpKw) &&
        (!/^\d{4}-\d{2}$/.test(ymF) || r.ym === ymF));
      let famt = 0; for (const r of f) famt += Number(r.purchase_amt || 0);
      필터결과 = { 조건: { 거래처: bpKw || null, 월: ymF || null }, 건수: f.length, 매입액합계_원: famt,
        목록: f.map((r: Record<string, unknown>) => ({ 월: r.ym, 거래처: r.bp_name || r.bp_code, 매입액_원: Number(r.purchase_amt || 0), 전표건수: Number(r.iv_cnt || 0) })) };
    }
    return { 기준시각: asOf, 월별, 매입액합계_원: amt, 전표건수: cnt, 거래처수: Object.keys(byBp).length,
      거래처Top10: top.map((t) => ({ 거래처: t.name, 매입액_원: t.amt, 전표건수: t.cnt })), 필터결과,
      안내: "ERP 중간DB 매입(송장 M_IV 기준) 파일럿. 월별 값은 각 월 실적재분이며, 미마감 최근월은 값이 작을 수 있음. 발주 상태 IV와는 별개 집계." };
  }

  if (name === "get_erp_inventory_status") {
    const code = String(args.item_code || "").replace(/[,()*%]/g, "").trim();
    let q = admin.from("v_erp_inventory_daily").select("*").order("ymd", { ascending: false }).limit(2000);
    if (code) q = q.eq("item_code", code);
    const { data } = await q; const rows = data || [];
    let inq = 0, outq = 0; const items = new Set<string>();
    for (const r of rows) { inq += Number(r.in_qty || 0); outq += Number(r.out_qty || 0); items.add(r.item_code); }
    return { 기준시각: asOf, 대상: code || "전체(최근31일)", 품목수: items.size, 입고합계: inq, 출고합계: outq, 표본행수: rows.length,
      데이터주의: "현재 중간DB 재고는 출고만 유효하며 입고량·재고량은 미적재(0/미표기)입니다 — '입고 0/재고 없음'을 실적으로 단정하지 말 것. 특정 발주의 입고 여부는 get_erp_po_pr(입고수량)로 확인.",
      안내: "ERP 중간DB 재고 일집계 파일럿(입출고 분류는 협의 전 초안, 수집범위 일부 품목·약 1개월)" };
  }

  if (name === "get_erp_item") {
    const kw = String(args.keyword || "").replace(/[,()*%]/g, "").trim();
    if (!kw) return { 오류: "keyword가 필요합니다." };
    const { data } = await admin.from("v_erp_item")
      .select("item_code,item_name,spec,unit,item_class,use_yn")
      .or(`item_code.ilike.%${kw}%,item_name.ilike.%${kw}%`).limit(30);
    const rows = data || [];
    // deno-lint-ignore no-explicit-any
    const 목록 = rows.map((r: any) => ({ 품목코드: r.item_code, 품목명: r.item_name, 규격: r.spec, 단위: r.unit, 분류: r.item_class, 사용: r.use_yn, 사용금지: /사용\s*금지/.test(String(r.item_name || "")) }))
      .sort((a: { 사용금지: boolean }, b: { 사용금지: boolean }) => (a.사용금지 ? 1 : 0) - (b.사용금지 ? 1 : 0));
    return { 기준시각: asOf, 검색어: kw, 건수: 목록.length, 목록,
      안내: "품목명에 '사용금지' 표기가 있는 코드는 신규 발주용으로 제시 금지(대체코드 확인 안내)." };
  }

  if (name === "get_erp_pur_order") {
    const ym = String(args.ym || "").replace(/[^0-9-]/g, "").slice(0, 7);
    const { data: mrows } = await admin.from("v_erp_pur_order_monthly").select("*").order("ym");
    const 월별 = (mrows || []).map((r: Record<string, unknown>) => ({
      월: r.ym, 발주건수: Number(r.po_cnt || 0), 품목라인: Number(r.line_cnt || 0),
      거래처수: Number(r.bp_cnt || 0), 발주금액_원: Number(r.amt || 0),
    }));
    let 상세: unknown = null;
    if (/^\d{4}-\d{2}$/.test(ym)) {
      const [y, m] = ym.split("-").map(Number);
      const nm = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
      const { data } = await admin.from("v_erp_pur_order")
        .select("po_no,bp_name,po_amt,po_sts").gte("po_dt", ym + "-01").lt("po_dt", nm + "-01").limit(3000);
      const rows = data || [];
      const byBp: Record<string, number> = {}; const bySts: Record<string, { 건수: number; 금액_원: number }> = {};
      const pos = new Set<string>(); let amt = 0;
      for (const r of rows) {
        pos.add(r.po_no); amt += Number(r.po_amt || 0);
        const nmk = r.bp_name || r.po_no; byBp[nmk] = (byBp[nmk] || 0) + Number(r.po_amt || 0);
        const s = stsKo(r.po_sts); const e = (bySts[s] = bySts[s] || { 건수: 0, 금액_원: 0 });
        e.건수 += 1; e.금액_원 += Number(r.po_amt || 0);
      }
      const top = Object.entries(byBp).sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([거래처, 금액]) => ({ 거래처, 발주금액_원: 금액 }));
      상세 = { 월: ym, 발주건수: pos.size, 품목라인: rows.length, 발주금액_원: amt, 거래처Top10: top, 상태분포_금액: bySts };
    }
    return { 기준시각: asOf, 월별, 상세, 안내: "ERP 중간DB 구매발주(pur_order_s, 2026 전체). 발주건수=고유 발주번호 기준. 파일럿 데이터." };
  }

  if (name === "get_erp_po_pr") {
    const po = String(args.po_no || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 20);
    const pr = String(args.pr_no || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 20);
    if (!po && !pr) return { 오류: "po_no 또는 pr_no가 필요합니다." };
    let q = admin.from("v_erp_po_pr_link").select("*").limit(50);
    if (po) q = q.eq("po_no", po);
    if (pr) q = q.eq("pr_no", pr);
    const { data } = await q; const rows = data || [];
    // deno-lint-ignore no-explicit-any
    const 발주_구매요청 = rows.map((r: any) => ({
      발주번호: r.po_no, 구매요청번호: r.pr_no || null, 발주일: r.po_dt, 거래처: r.po_vendor,
      품목코드: r.item_code, 품목: r.item_name, 발주수량: Number(r.po_qty || 0), 발주금액_원: Number(r.po_amt || 0),
      발주상태: stsKo(r.po_sts), 입고수량: Number(r.po_rcpt_qty || 0), 매입수량: Number(r.iv_qty || 0),
      진행: `요청 ${Number(r.req_qty || 0)} → 발주 ${Number(r.ord_qty || 0)} → 입고 ${Number(r.po_rcpt_qty || 0)} → 매입 ${Number(r.iv_qty || 0)}`,
      납기: r.po_dlvy_dt, 납기경과_미입고: r.overdue_unreceived === true,
      외주구분: r.subcontra_flg === "Y" ? "외주" : "일반", 연결수주번호: r.so_no || null,
      요청일: r.req_dt, 필요납기: r.pr_dlvy_dt, 요청수량: Number(r.req_qty || 0),
      요청부서: r.req_dept_resolved || "미상", 요청자: r.req_prsn || null, 구매요청상태: stsKo(r.pr_sts),
    }));
    // PR 조회인데 발주 라인이 없으면(미발주 PR) 구매요청 자체 상세로 답
    let 구매요청상세: unknown = null;
    if (pr && !rows.length) {
      const { data: rd } = await admin.from("v_erp_pur_req").select("*").eq("pr_no", pr).maybeSingle();
      // deno-lint-ignore no-explicit-any
      const r: any = rd;
      구매요청상세 = r ? {
        구매요청번호: r.pr_no, 구매요청상태: stsKo(r.pr_sts), 품목코드: r.item_code, 품목: r.item_name,
        요청수량: Number(r.req_qty || 0), 발주수량: Number(r.ord_qty || 0), 입고수량: Number(r.rcpt_qty || 0), 매입수량: Number(r.iv_qty || 0),
        진행: `요청 ${Number(r.req_qty || 0)} → 발주 ${Number(r.ord_qty || 0)} → 입고 ${Number(r.rcpt_qty || 0)} → 매입 ${Number(r.iv_qty || 0)}`,
        미발주: Number(r.ord_qty || 0) === 0, 요청일: r.req_dt, 필요납기: r.dlvy_dt,
        요청부서: r.req_dept_resolved || "미상", 요청자: r.req_prsn || null, 연결수주번호: r.so_no || null, 공급처: r.sppl_name || null,
      } : null;
    }
    return { 기준시각: asOf, 조회조건: { po_no: po || null, pr_no: pr || null }, 연결건수: rows.length,
      발주_구매요청, 구매요청상세,
      안내: "ERP 중간DB 발주↔구매요청 연결(파일럿). 진행단계: 요청(RQ)→확정(CF)→발주(PO)→입고(GR)→매입(IV). 요청부서는 요청자 이메일→부서 매핑으로 보완됨." };
  }

  if (name === "get_erp_pur_top") {
    const n = Math.min(Math.max(Number(args.n) || 10, 1), 30);
    const { data } = await admin.from("v_erp_pur_top_po")
      .select("po_no,po_dt,po_vendor,line_cnt,po_total,top_item,pr_no,has_open_line")
      .order("po_total", { ascending: false, nullsFirst: false }).limit(n);
    const rows = data || [];
    return { 기준시각: asOf, 상위N: n,
      // deno-lint-ignore no-explicit-any
      상위목록: rows.map((r: any) => ({
        발주번호: r.po_no, 발주일: r.po_dt, 거래처: r.po_vendor,
        발주총액_원: Number(r.po_total || 0), 라인수: Number(r.line_cnt || 0), 대표품목: r.top_item,
        구매요청번호: r.pr_no || null, 진행: r.has_open_line ? "진행중(일부 입고전)" : "입고/매입 진행",
      })),
      안내: "ERP 중간DB 발주 총액(발주번호별 라인 합산) 상위. 동일 발주 중복 없음. 파일럿 데이터." };
  }

  if (name === "get_erp_receipt_pending") {
    const overdueOnly = args.overdue_only === true || String(args.overdue_only) === "true";
    const lim = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
    let q = admin.from("v_erp_po_pr_link")
      .select("po_no,po_vendor,item_name,po_qty,po_rcpt_qty,po_dlvy_dt,po_amt,overdue_unreceived")
      .eq("po_sts", "PO");
    if (overdueOnly) q = q.eq("overdue_unreceived", true);
    const { data } = await q.order("po_dlvy_dt", { ascending: true }).limit(lim);
    const rows = data || [];
    let amt = 0; for (const r of rows) amt += Number(r.po_amt || 0);
    return { 기준시각: asOf, 조건: overdueOnly ? "납기경과·미입고" : "미입고(발주완료 PO상태)", 표시건수_라인: rows.length, 표시금액합_원: amt,
      // deno-lint-ignore no-explicit-any
      목록: rows.map((r: any) => ({ 발주번호: r.po_no, 거래처: r.po_vendor, 품목: r.item_name,
        발주수량: Number(r.po_qty || 0), 입고수량: Number(r.po_rcpt_qty || 0), 납기: r.po_dlvy_dt,
        발주금액_원: Number(r.po_amt || 0), 납기경과: r.overdue_unreceived === true })),
      안내: "발주상태 PO=발주완료·입고전. 발주 라인 단위 목록(limit 제한). 파일럿 데이터." };
  }

  if (name === "get_erp_pur_req") {
    const status = String(args.status || "").trim();
    const dept = String(args.dept || "").replace(/[,()*%]/g, "").trim();
    const lim = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
    let q = admin.from("v_erp_pur_req")
      .select("pr_no,pr_sts,item_name,req_qty,ord_qty,rcpt_qty,iv_qty,req_dt,dlvy_dt,req_dept_resolved,req_prsn,so_no");
    if (status === "unordered" || status === "미발주") q = q.or("ord_qty.eq.0,ord_qty.is.null");
    else if (status) q = q.eq("pr_sts", status.toUpperCase());
    if (dept) q = q.ilike("req_dept_resolved", `%${dept}%`);
    const { data } = await q.order("req_dt", { ascending: false }).limit(lim);
    const rows = data || [];
    return { 기준시각: asOf, 조건: { 상태: status || "전체", 부서: dept || "전체" }, 표시건수: rows.length,
      // deno-lint-ignore no-explicit-any
      목록: rows.map((r: any) => ({ 구매요청번호: r.pr_no, 상태: stsKo(r.pr_sts), 품목: r.item_name,
        요청수량: Number(r.req_qty || 0), 발주수량: Number(r.ord_qty || 0), 미발주: Number(r.ord_qty || 0) === 0,
        요청일: r.req_dt, 필요납기: r.dlvy_dt, 요청부서: r.req_dept_resolved || "미상", 요청자: r.req_prsn })),
      안내: "구매요청 목록. status=unordered(미발주,ord_qty=0)/RQ(요청)/CF(확정). 요청부서는 요청자 이메일→부서 매핑 보완. 파일럿 데이터." };
  }

  return { 오류: `알 수 없는 도구: ${name}` };
}

/* ===== Entra 토큰 검증 ===== */
async function verifyEntraUser(token: string): Promise<{ upn: string } | null> {
  try {
    const r = await fetch("https://graph.microsoft.com/v1.0/me?$select=userPrincipalName,mail", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const me = await r.json();
    const upn = String(me.userPrincipalName || me.mail || "").toLowerCase();
    if (!upn.endsWith("@jeilm.co.kr")) return null;
    return { upn };
  } catch {
    return null;
  }
}

/* ===== OpenAI 스트림 호출·파싱 ===== */
function callOpenAI(apiKey: string, model: string, messages: unknown[], withTools: boolean, maxTokens: number, temperature: number) {
  return fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, stream: true, max_tokens: maxTokens, temperature, messages,
      stream_options: { include_usage: true },            // U-1: 토큰 usage 수신
      ...(withTools ? { tools: TOOLS } : {}),
    }),
  });
}

type ToolCallAcc = { id: string; name: string; args: string };
type PumpState = { pt: number; ct: number; toolCalls: Record<number, ToolCallAcc> };

// OpenAI SSE를 읽어 content는 emit, tool_calls·usage는 state에 축적
async function pumpStream(body: ReadableStream<Uint8Array>, emit: (c: string) => Promise<void>, state: PumpState) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const ln of lines) {
      const t = ln.trim();
      if (!t.startsWith("data:")) continue;
      const p = t.slice(5).trim();
      if (p === "[DONE]") continue;
      // deno-lint-ignore no-explicit-any
      let ev: any; try { ev = JSON.parse(p); } catch { continue; }
      if (ev.usage) { state.pt += ev.usage.prompt_tokens || 0; state.ct += ev.usage.completion_tokens || 0; }
      const d = ev.choices?.[0]?.delta;
      if (!d) continue;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          const cur = (state.toolCalls[i] = state.toolCalls[i] || { id: "", name: "", args: "" });
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
        }
      }
      if (typeof d.content === "string" && d.content) await emit(d.content);
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return json({ error: "서버 미설정: OPENAI_API_KEY 시크릿이 등록되지 않았습니다." }, 503);

  // 1) 사내 사용자 검증 (Entra 토큰 → Graph)
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized: MS 로그인 토큰이 필요합니다." }, 401);
  const user = await verifyEntraUser(token);
  if (!user) return json({ error: "unauthorized: 사내(@jeilm.co.kr) 계정 인증 실패 — 다시 로그인하세요." }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 1-b) 사용모델 설정 로드(관리자 콘솔 › 모델 설정 SSOT). 조회 실패 시 안전 폴백(기존 하드코딩값).
  const ai = await loadAiConfig(admin);

  // 2) 입력 검증 (상한은 DB 설정값 사용)
  let body: { messages?: Array<{ role: string; content: string }> };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const messages = raw
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-ai.max_messages)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));
  if (!messages.length) return json({ error: "messages가 비어 있습니다." }, 400);
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total > ai.max_total_chars) return json({ error: "대화가 너무 깁니다. 새 대화로 시작하세요." }, 400);

  // 2-b) 모델 라우팅 — 마지막 사용자 메시지 기준. 라우팅 규칙 미매칭 시 기본 모델(설정값).
  const lastUserText = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const model = pickModel(lastUserText, ai);

  // 2-c) ERP Tool 접근 범위(부서별 erp_scope) — 관리자는 전 모듈, 그 외 소속 부서 허용 모듈만
  const erpScope = await resolveErpScope(admin, user.upn);

  // 3) 감사 로그 선기록 (스트림 종료 후 토큰·비용·도구 갱신)
  let logId: number | null = null;
  try {
    const { data } = await admin.from("chat_log")
      .insert({ upn: user.upn, model, messages_count: messages.length, prompt_chars: total })
      .select("id").single();
    logId = data?.id ?? null;
  } catch { /* 로그 실패는 무시 */ }

  // 4) 스트리밍 응답 (도구 호출 시 상한 멀티라운드: 라운드마다 도구 수집→실행→누적, 마지막 라운드는 도구 없이 최종답변)
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const emit = (c: string) =>
    writer.write(enc.encode("data: " + JSON.stringify({ choices: [{ delta: { content: c } }] }) + "\n\n")).then(() => {});

  const run = (async () => {
    const state: PumpState = { pt: 0, ct: 0, toolCalls: {} };
    const toolsUsed: string[] = [];
    try {
      // 도구 호출 상한 멀티라운드 — 리다이렉트형(도구가 다른 도구를 안내)·순차의존형 복합질문 대응.
      // 무한루프 3중 차단: MAX_ROUNDS 상한 + 직전 라운드와 동일 호출 반복 시 중단 + 마지막 라운드 강제 withTools=false.
      const convo: unknown[] = [{ role: "system", content: ai.system_prompt }, ...messages];
      const MAX_ROUNDS = 4;
      let lastSig = "";
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const lastRound = round === MAX_ROUNDS - 1;
        state.toolCalls = {};
        const res = await callOpenAI(apiKey, model, convo, !lastRound, ai.max_tokens, ai.temperature);
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          console.error("openai error", res.status, detail.slice(0, 500));
          await emit(res.status === 401 ? "⚠ OpenAI 키가 유효하지 않습니다(만료/오입력)."
            : res.status === 429 ? "⚠ OpenAI 사용량 한도 초과 — 잠시 후 다시 시도하세요."
            : "⚠ AI 응답 생성에 실패했습니다.");
          break;
        }
        await pumpStream(res.body, emit, state);
        const calls = Object.values(state.toolCalls).filter((c) => c.name);
        if (!calls.length) break;                          // 도구 없이 최종답변 완료 → 종료
        const sig = calls.map((c) => c.name + ":" + c.args).sort().join("|");
        if (sig === lastSig) break;                        // 직전과 동일 호출 반복 → 무한루프 차단
        lastSig = sig;
        convo.push({
          role: "assistant", content: null,
          tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })),
        });
        for (const c of calls) {
          toolsUsed.push(c.name);
          let result: unknown;
          try { result = await runTool(admin, c.name, c.args, erpScope); }
          catch (e) { result = { 오류: "조회 실패: " + (e instanceof Error ? e.message : String(e)) }; }
          convo.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(result).slice(0, 12000) });
        }
      }
    } catch (e) {
      try { await emit("⚠ 오류: " + (e instanceof Error ? e.message : String(e))); } catch { /* 스트림 종료됨 */ }
    } finally {
      try { await writer.write(enc.encode("data: [DONE]\n\n")); } catch { /* 무시 */ }
      try { await writer.close(); } catch { /* 무시 */ }
      // U-1: 토큰·추정비용·사용도구 갱신
      if (logId != null) {
        const price = priceFor(model, ai);
        const cost = (state.pt * price.inp + state.ct * price.out) / 1_000_000;
        try {
          await admin.from("chat_log").update({
            prompt_tokens: state.pt || null, completion_tokens: state.ct || null,
            est_cost_usd: state.pt || state.ct ? Number(cost.toFixed(6)) : null,
            tools_used: toolsUsed.length ? toolsUsed : null,
          }).eq("id", logId);
        } catch { /* 무시 */ }
      }
    }
  })();
  // @ts-ignore: Supabase Edge Runtime — 응답 반환 후에도 로그 갱신 완료 보장
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(run);

  return new Response(readable, {
    headers: { ...cors, "Content-Type": "text/event-stream", "x-model": model },
  });
});
