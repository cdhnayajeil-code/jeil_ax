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

// 입력 상한 (키 남용·과금 폭주 방지)
const MAX_MESSAGES = 20;
const MAX_MSG_CHARS = 8000;
const MAX_TOTAL_CHARS = 24000;
const MAX_TOKENS = 1024;

// 모델 단가표 (USD / 1M 토큰, 2026-07 기준 — 변동 시 갱신. 정산은 OpenAI 청구서 기준)
const PRICES: Record<string, { inp: number; out: number }> = {
  "gpt-4o-mini": { inp: 0.15, out: 0.60 },
  "gpt-4o": { inp: 2.50, out: 10.00 },
  "gpt-4.1-mini": { inp: 0.40, out: 1.60 },
};

const SYSTEM_PROMPT =
  "당신은 제일엠앤에스(JEIL M&S)의 사내 AI 어시스턴트 'jeil-chat'입니다. " +
  "업무 문서 초안(주간보고·메일·공지), 규정 질의, 데이터 요약을 한국어로 간결하고 정확하게 돕습니다. " +
  "협력사 외주 발주·검사 현황은 제공된 조회 도구(포털DB 실데이터)를 사용해 답하고, 답변에 조회 기준 시각을 표기하세요. " +
  "매출·매입·재고·품목 등 ERP 데이터는 ERP 중간DB 조회 도구(get_erp_*)를 사용하되, 유니포인트 매핑 확정 전 '파일럿 데이터'임을 답변에 밝히세요. " +
  "도구로 조회할 수 없는 사내 수치·규정은 추측하지 말고 원본 확인을 권하세요. " +
  "급여·주민번호 등 개인정보나 비밀값을 답변에 포함하지 마세요.";

/* ===== 1단계 포털DB 조회 도구 (읽기전용 · 집계/요약만 반환) ===== */
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_order_summary",
      description: "협력사 외주 발주 전체 현황 요약(포털DB 실데이터) — 상태별 건수, 총 발주금액, 협력사 수, 납기 임박(7일 내) 목록. '발주 현황 어때', '진행 중 몇 건' 류 질의에 사용.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_order_detail",
      description: "발주번호로 특정 발주 상세 조회 — 협력사, 발주/납기일, 금액, 품목, 진행상태(10단계), 검사결과, 검수요청·사진·메시지 건수.",
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
      description: "ERP 매출 월집계(중간DB 사내 실데이터) — 거래처×월 매출액·수금액·건수, 롤링 3개월. '이번달 매출', '거래처별 매출' 류 질의에 사용. 파일럿(유니포인트 매핑 확정 전).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_purchase_monthly",
      description: "ERP 매입 월집계(중간DB 사내 실데이터) — 거래처×월 매입액·전표건수, 롤링 3개월. '매입 현황', '거래처별 매입' 류 질의에 사용.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_inventory_status",
      description: "ERP 재고 입출고 현황(중간DB 사내 실데이터) — 품목×창고 입고/출고, 최근 31일. '재고', '입출고' 류 질의에 사용. 입출고 분류는 협의 전 초안.",
      parameters: { type: "object", properties: { item_code: { type: "string", description: "품목코드(선택, 특정 품목만)" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_item",
      description: "ERP 품목 조회(중간DB 사내 실데이터) — 코드/명 부분일치로 품목 마스터 검색(규격·단위·분류). '품목 있어?', '품목코드 뭐야' 류 질의에 사용.",
      parameters: { type: "object", properties: { keyword: { type: "string", description: "품목코드 또는 품목명 키워드" } }, required: ["keyword"] },
    },
  },
];

const STATUS_KO: Record<string, string> = { new: "신규", prod: "생산중", insp: "검사", done: "완료" };

// deno-lint-ignore no-explicit-any
async function runTool(admin: any, name: string, argsJson: string): Promise<unknown> {
  let args: Record<string, string> = {};
  try { args = JSON.parse(argsJson || "{}"); } catch { /* 빈 인자 */ }
  const asOf = new Date().toISOString();

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
    if (!h) return { 기준시각: asOf, 오류: `발주번호 ${po} 를 찾을 수 없습니다.` };
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
    return { 기준시각: asOf, 월별, 매입액합계_원: amt, 전표건수: cnt, 거래처수: Object.keys(byBp).length,
      거래처Top10: top.map((t) => ({ 거래처: t.name, 매입액_원: t.amt, 전표건수: t.cnt })),
      안내: "ERP 중간DB 파일럿. 월별 값은 각 월 실적재분이며, 미마감 최근월은 값이 작을 수 있음." };
  }

  if (name === "get_erp_inventory_status") {
    const code = String(args.item_code || "").replace(/[,()*%]/g, "").trim();
    let q = admin.from("v_erp_inventory_daily").select("*").order("ymd", { ascending: false }).limit(2000);
    if (code) q = q.eq("item_code", code);
    const { data } = await q; const rows = data || [];
    let inq = 0, outq = 0; const items = new Set<string>();
    for (const r of rows) { inq += Number(r.in_qty || 0); outq += Number(r.out_qty || 0); items.add(r.item_code); }
    return { 기준시각: asOf, 대상: code || "전체(최근31일)", 품목수: items.size, 입고합계: inq, 출고합계: outq, 표본행수: rows.length,
      안내: "ERP 중간DB 재고 일집계 파일럿(입출고 분류는 협의 전 초안)" };
  }

  if (name === "get_erp_item") {
    const kw = String(args.keyword || "").replace(/[,()*%]/g, "").trim();
    if (!kw) return { 오류: "keyword가 필요합니다." };
    const { data } = await admin.from("v_erp_item")
      .select("item_code,item_name,spec,unit,item_class,use_yn")
      .or(`item_code.ilike.%${kw}%,item_name.ilike.%${kw}%`).limit(30);
    const rows = data || [];
    // deno-lint-ignore no-explicit-any
    return { 기준시각: asOf, 검색어: kw, 건수: rows.length, 목록: rows.map((r: any) => ({ 품목코드: r.item_code, 품목명: r.item_name, 규격: r.spec, 단위: r.unit, 분류: r.item_class, 사용: r.use_yn })) };
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
function callOpenAI(apiKey: string, model: string, messages: unknown[], withTools: boolean) {
  return fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, stream: true, max_tokens: MAX_TOKENS, messages,
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
  const model = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";

  // 1) 사내 사용자 검증 (Entra 토큰 → Graph)
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized: MS 로그인 토큰이 필요합니다." }, 401);
  const user = await verifyEntraUser(token);
  if (!user) return json({ error: "unauthorized: 사내(@jeilm.co.kr) 계정 인증 실패 — 다시 로그인하세요." }, 401);

  // 2) 입력 검증
  let body: { messages?: Array<{ role: string; content: string }> };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const messages = raw
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));
  if (!messages.length) return json({ error: "messages가 비어 있습니다." }, 400);
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total > MAX_TOTAL_CHARS) return json({ error: "대화가 너무 깁니다. 새 대화로 시작하세요." }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 3) 감사 로그 선기록 (스트림 종료 후 토큰·비용·도구 갱신)
  let logId: number | null = null;
  try {
    const { data } = await admin.from("chat_log")
      .insert({ upn: user.upn, model, messages_count: messages.length, prompt_chars: total })
      .select("id").single();
    logId = data?.id ?? null;
  } catch { /* 로그 실패는 무시 */ }

  // 4) 스트리밍 응답 (도구 호출 시: 1차 스트림에서 도구 수집 → 실행 → 2차 스트림)
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const emit = (c: string) =>
    writer.write(enc.encode("data: " + JSON.stringify({ choices: [{ delta: { content: c } }] }) + "\n\n")).then(() => {});

  const run = (async () => {
    const state: PumpState = { pt: 0, ct: 0, toolCalls: {} };
    const toolsUsed: string[] = [];
    try {
      const convo: unknown[] = [{ role: "system", content: SYSTEM_PROMPT }, ...messages];
      const res1 = await callOpenAI(apiKey, model, convo, true);
      if (!res1.ok || !res1.body) {
        const detail = await res1.text().catch(() => "");
        console.error("openai error", res1.status, detail.slice(0, 500));
        await emit(res1.status === 401 ? "⚠ OpenAI 키가 유효하지 않습니다(만료/오입력)."
          : res1.status === 429 ? "⚠ OpenAI 사용량 한도 초과 — 잠시 후 다시 시도하세요."
          : "⚠ AI 응답 생성에 실패했습니다.");
      } else {
        await pumpStream(res1.body, emit, state);
        const calls = Object.values(state.toolCalls).filter((c) => c.name);
        if (calls.length) {
          // 도구 실행 (최대 1라운드 — 2차 호출에는 도구 미제공)
          const assistantMsg = {
            role: "assistant", content: null,
            tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })),
          };
          const toolMsgs: unknown[] = [];
          for (const c of calls) {
            toolsUsed.push(c.name);
            let result: unknown;
            try { result = await runTool(admin, c.name, c.args); }
            catch (e) { result = { 오류: "조회 실패: " + (e instanceof Error ? e.message : String(e)) }; }
            toolMsgs.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(result).slice(0, 12000) });
          }
          state.toolCalls = {};
          const res2 = await callOpenAI(apiKey, model, [...convo, assistantMsg, ...toolMsgs], false);
          if (res2.ok && res2.body) await pumpStream(res2.body, emit, state);
          else await emit("⚠ 데이터 조회 후 응답 생성에 실패했습니다.");
        }
      }
    } catch (e) {
      try { await emit("⚠ 오류: " + (e instanceof Error ? e.message : String(e))); } catch { /* 스트림 종료됨 */ }
    } finally {
      try { await writer.write(enc.encode("data: [DONE]\n\n")); } catch { /* 무시 */ }
      try { await writer.close(); } catch { /* 무시 */ }
      // U-1: 토큰·추정비용·사용도구 갱신
      if (logId != null) {
        const price = PRICES[model] || PRICES["gpt-4o-mini"];
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
