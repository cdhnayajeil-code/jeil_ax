// jeil-chat-admin — 챗봇 관리자 콘솔 실데이터 API (사용량·권한·게이트웨이 상태·사용자부서 매핑)
// 배포: verify_jwt=false (Entra 토큰을 내부에서 Graph로 검증)
// 호출: POST /functions/v1/jeil-chat-admin  Authorization: Bearer <Entra access_token>
//   조회(빈 바디): { gateway, usage, admins, dept_mapping, dept_permissions, portal_pages, dept_erp_scope, catalog, model_settings } — 관리자만
//   저장({action:'save_dept_perm'|'save_page_perm'|'save_dept_erp'|'save_ai_models'|'save_ai_config'|'save_ai_routing'|'manage_admin', ...}): 관리자만 → { ok, saved }
//   v9: save_ai_config에 work 컨텍스트 적용범위·대화 저장 정책 6필드 추가. usage에 세션·메시지 건수(원문은 반환하지 않음 — 본인 전용 jeil-chat-history뿐).
//   v10(2026-07-22): 권한 코어 통합 — 개인 예외 권한 액션 3종(grant_perm·revoke_perm·effective_perm) 추가,
//     조회 응답에 perm_grants·perm_audit 포함, 모듈 카탈로그 SSOT를 DB(perm_module_catalog)로 이관.
// 원칙: chat_log·erp 매핑 뷰는 RLS로 클라이언트 차단 → 이 함수(service_role)가 유일한 조회/저장 경로.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ERP 데이터 모듈 카탈로그 — v10(2026-07-22)부터 DB(public.perm_module_catalog)가 SSOT.
// 아래 값은 DB 조회 실패 시의 안전 폴백일 뿐이다(코드-DB 이중관리 종료).
const CATALOG_FALLBACK = [
  { key: "sales", label: "매출", sensitive: false }, { key: "purchase", label: "매입", sensitive: false },
  { key: "inventory", label: "재고", sensitive: false }, { key: "item", label: "품목", sensitive: false },
  { key: "pur_order", label: "발주", sensitive: false }, { key: "user_dept", label: "사용자·부서", sensitive: false },
  { key: "payroll", label: "급여·인사", sensitive: true }, { key: "finance", label: "자금·회계", sensitive: true },
];

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // 1) 사내 사용자 검증
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized: MS 로그인 토큰이 필요합니다." }, 401);
  const user = await verifyEntraUser(token);
  if (!user) return json({ error: "unauthorized: 사내 계정 인증 실패" }, 401);

  // 2) 관리자 검증 (portal_admin 등록자만)
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: pa } = await admin.from("portal_admin").select("email").eq("email", user.upn).maybeSingle();
  if (!pa) return json({ error: "forbidden: 관리자 전용" }, 403);

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const nowIso = new Date().toISOString();

  // 2-b) 저장 액션 — 부서별 권한 설정 upsert(관리자만). 부서명 기준은 ERP 매핑(v_erp_dept_roster).
  if (body && (body as Record<string, unknown>).action === "save_dept_perm") {
    const rowsIn = Array.isArray((body as Record<string, unknown>).rows) ? (body as Record<string, unknown>).rows as Record<string, unknown>[] : [];
    const rows = rowsIn
      .filter((r) => r && r.dept_nm)
      .map((r) => ({
        dept_nm: String(r.dept_nm),
        dept_admin_email: r.dept_admin_email ? String(r.dept_admin_email) : null,
        erp_scope: r.erp_scope ? String(r.erp_scope) : null,
        page_visibility: r.page_visibility ? String(r.page_visibility) : "부서 전용",
        note: r.note ? String(r.note) : null,
        updated_by: user.upn,
        updated_at: nowIso,
      }));
    if (!rows.length) return json({ error: "저장할 부서 행이 없습니다." }, 400);
    const { error: se } = await admin.from("dept_permission").upsert(rows, { onConflict: "dept_nm" });
    if (se) return json({ error: "부서 권한 저장 실패: " + se.message }, 500);
    return json({ ok: true, saved: rows.length, updated_by: user.upn, updated_at: nowIso });
  }

  // 2-c) 저장 액션 — 페이지 공개 설정(portal_page upsert).
  if (body && (body as Record<string, unknown>).action === "save_page_perm") {
    const rowsIn = Array.isArray((body as Record<string, unknown>).rows) ? (body as Record<string, unknown>).rows as Record<string, unknown>[] : [];
    const rows = rowsIn.filter((r) => r && r.page_key).map((r) => ({
      page_key: String(r.page_key),
      title: r.title != null ? String(r.title) : undefined,
      path: r.path != null ? String(r.path) : undefined,
      icon: r.icon != null ? String(r.icon) : undefined,
      dept_nm: r.dept_nm ? String(r.dept_nm) : null,
      visibility: r.visibility ? String(r.visibility) : "부서 전용",
      shared_depts: Array.isArray(r.shared_depts) ? (r.shared_depts as unknown[]).map(String) : [],
      erp_module: r.erp_module ? String(r.erp_module) : null,
      active: r.active !== false,
      updated_by: user.upn, updated_at: nowIso,
    }));
    if (!rows.length) return json({ error: "저장할 페이지가 없습니다." }, 400);
    const { error: pe } = await admin.from("portal_page").upsert(rows, { onConflict: "page_key" });
    if (pe) return json({ error: "페이지 권한 저장 실패: " + pe.message }, 500);
    return json({ ok: true, saved: rows.length, updated_by: user.upn, updated_at: nowIso });
  }

  // 2-d) 저장 액션 — 부서별 ERP 모듈 권한(제공 부서 범위를 삭제 후 재삽입).
  if (body && (body as Record<string, unknown>).action === "save_dept_erp") {
    const rowsIn = Array.isArray((body as Record<string, unknown>).rows) ? (body as Record<string, unknown>).rows as Record<string, unknown>[] : [];
    const depts = rowsIn.map((r) => String(r.dept_nm || "")).filter(Boolean);
    if (!depts.length) return json({ error: "저장할 부서가 없습니다." }, 400);
    const { error: de } = await admin.from("dept_erp_scope").delete().in("dept_nm", depts);
    if (de) return json({ error: "ERP 모듈 권한 갱신 실패: " + de.message }, 500);
    const ins: Record<string, unknown>[] = [];
    for (const r of rowsIn) {
      const dn = String(r.dept_nm || ""); if (!dn) continue;
      const mods = Array.isArray(r.modules) ? (r.modules as unknown[]).map(String) : [];
      for (const m of mods) ins.push({ dept_nm: dn, module_key: m, updated_by: user.upn, updated_at: nowIso });
    }
    if (ins.length) {
      const { error: ie } = await admin.from("dept_erp_scope").insert(ins);
      if (ie) return json({ error: "ERP 모듈 권한 저장 실패: " + ie.message }, 500);
    }
    return json({ ok: true, saved: depts.length, modules: ins.length, updated_by: user.upn, updated_at: nowIso });
  }

  // 2-e) 전체권한(전체 관리자=portal_admin) 부여/해제 — 관리자만. 특정 이메일 수동 지정.
  if (body && (body as Record<string, unknown>).action === "manage_admin") {
    const sub = String((body as Record<string, unknown>).sub || "");
    const email = String((body as Record<string, unknown>).email || "").trim().toLowerCase();
    if (!email || !email.endsWith("@jeilm.co.kr")) return json({ error: "사내(@jeilm.co.kr) 이메일이 필요합니다." }, 400);
    if (sub === "add") {
      const { error } = await admin.from("portal_admin").upsert({ email, granted_by: user.upn, granted_at: nowIso }, { onConflict: "email" });
      if (error) return json({ error: "전체권한 부여 실패: " + error.message }, 500);
      return json({ ok: true, action: "add", email, by: user.upn });
    }
    if (sub === "remove") {
      if (email === user.upn) return json({ error: "본인의 전체권한은 해제할 수 없습니다(잠금 방지)." }, 400);
      const { error } = await admin.from("portal_admin").delete().eq("email", email);
      if (error) return json({ error: "전체권한 해제 실패: " + error.message }, 500);
      return json({ ok: true, action: "remove", email });
    }
    return json({ error: "알 수 없는 관리 동작" }, 400);
  }

  // 2-e-1) 개인 예외 권한 부여 — 부서축으로 못 푸는 예외(겸직·대행·프로젝트)를 개인 단위로 가감.
  //   scope_type: role(admin|auditor) | dept(부서 추가) | erp_module | page | onedrive
  //   effect: allow | deny(우선). valid_to로 기간 권한(대행 종료 시 자동 소멸). 사유 필수 → perm_audit 기록.
  if (body && (body as Record<string, unknown>).action === "grant_perm") {
    const b = body as Record<string, unknown>;
    const { data, error } = await admin.rpc("perm_grant_set", {
      p_actor: user.upn,
      p_upn: String(b.upn || "").trim().toLowerCase(),
      p_scope_type: String(b.scope_type || ""),
      p_scope_key: String(b.scope_key || ""),
      p_effect: String(b.effect || "allow"),
      p_reason: b.reason != null ? String(b.reason).slice(0, 400) : null,
      p_valid_to: b.valid_to ? String(b.valid_to) : null,
    });
    if (error) return json({ error: "권한 부여 실패: " + error.message }, 400);
    return json({ ok: true, result: data, by: user.upn });
  }

  // 2-e-2) 개인 예외 권한 회수(이력 보존 — revoked_at 기록 후 감사 남김)
  if (body && (body as Record<string, unknown>).action === "revoke_perm") {
    const id = Number((body as Record<string, unknown>).id);
    if (!Number.isFinite(id)) return json({ error: "회수할 권한 id가 필요합니다." }, 400);
    const { data, error } = await admin.rpc("perm_grant_revoke", { p_actor: user.upn, p_id: id });
    if (error) return json({ error: "권한 회수 실패: " + error.message }, 400);
    return json({ ok: true, result: data, by: user.upn });
  }

  // 2-e-3) 유효 권한 시뮬레이터 — "이 사람은 지금 무엇을 볼 수 있는가"를 실제 판정 함수로 그대로 확인.
  //   부여 전 영향 확인·문의 대응용. 조회 자체도 감사에 남긴다.
  if (body && (body as Record<string, unknown>).action === "effective_perm") {
    const target = String((body as Record<string, unknown>).upn || "").trim().toLowerCase();
    if (!target) return json({ error: "조회할 사용자 이메일이 필요합니다." }, 400);
    const { data, error } = await admin.rpc("perm_effective", { p_upn: target });
    if (error) return json({ error: "권한 조회 실패: " + error.message }, 400);
    await admin.from("perm_audit").insert({ actor: user.upn, action: "view_effective", target, detail: {} });
    return json({ ok: true, effective: data });
  }

  // 2-f) 저장 액션 — 사용모델 카탈로그(ai_model upsert). 단가·활성화·용도 편집.
  if (body && (body as Record<string, unknown>).action === "save_ai_models") {
    const rowsIn = Array.isArray((body as Record<string, unknown>).rows) ? (body as Record<string, unknown>).rows as Record<string, unknown>[] : [];
    const num = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
    const rows = rowsIn.filter((r) => r && r.model_id).map((r) => ({
      model_id: String(r.model_id).trim().slice(0, 80),
      vendor: r.vendor ? String(r.vendor).slice(0, 40) : "OpenAI",
      label: r.label != null ? String(r.label).slice(0, 120) : String(r.model_id),
      purpose: r.purpose != null ? String(r.purpose).slice(0, 400) : null,
      price_in: num(r.price_in, 0),
      price_out: num(r.price_out, 0),
      active: r.active === true,
      // callable은 게이트웨이 실제 호출가능 여부 — 서버가 벤더로 강제(OpenAI만 true). 클라이언트 임의 지정 불가.
      callable: String(r.vendor || "OpenAI").toLowerCase() === "openai",
      sort: Math.trunc(num(r.sort, 100)),
      note: r.note != null ? String(r.note).slice(0, 400) : null,
      updated_by: user.upn, updated_at: nowIso,
    }));
    if (!rows.length) return json({ error: "저장할 모델이 없습니다." }, 400);
    const { error: me } = await admin.from("ai_model").upsert(rows, { onConflict: "model_id" });
    if (me) return json({ error: "모델 저장 실패: " + me.message }, 500);
    return json({ ok: true, saved: rows.length, updated_by: user.upn, updated_at: nowIso });
  }

  // 2-g) 저장 액션 — 게이트웨이 설정(ai_gateway_config 싱글턴 upsert). 상한·파라미터·시스템프롬프트.
  if (body && (body as Record<string, unknown>).action === "save_ai_config") {
    const c = ((body as Record<string, unknown>).config || {}) as Record<string, unknown>;
    const clampInt = (v: unknown, lo: number, hi: number, d: number) => {
      const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
    };
    const dm = String(c.default_model || "").trim();
    // 기본 모델은 반드시 실제 호출가능(active+callable)한 모델이어야 함
    const { data: dmRow } = await admin.from("ai_model").select("model_id,active,callable").eq("model_id", dm).maybeSingle();
    if (!dmRow || !dmRow.active || !dmRow.callable) {
      return json({ error: `기본 모델 '${dm || "(미지정)"}'은(는) 활성화·호출가능한 모델이 아닙니다. 먼저 모델을 활성화하세요.` }, 400);
    }
    const temp = Math.min(2, Math.max(0, Number(c.temperature)));
    const row = {
      id: 1,
      default_model: dm,
      max_tokens: clampInt(c.max_tokens, 256, 4096, 1024),
      temperature: Number.isFinite(temp) ? Number(temp.toFixed(2)) : 0.3,
      prompt_caching: c.prompt_caching !== false,
      max_messages: clampInt(c.max_messages, 1, 50, 20),
      max_total_chars: clampInt(c.max_total_chars, 1000, 100000, 24000),
      system_prompt: c.system_prompt != null ? String(c.system_prompt).slice(0, 12000) : "",
      // v9: work 컨텍스트 적용범위·대화 저장 정책(챗봇 대화내역 기능 — jeil-chat이 요청마다 로드)
      work_context_mode: ["off", "memo", "memo_summary"].includes(String(c.work_context_mode)) ? String(c.work_context_mode) : "memo",
      work_context_max_chars: clampInt(c.work_context_max_chars, 0, 8000, 2000),
      work_history_turns: clampInt(c.work_history_turns, 0, 25, 10),
      chat_save_enabled: c.chat_save_enabled !== false,
      chat_retention_days: clampInt(c.chat_retention_days, 0, 730, 180),
      session_max_messages: clampInt(c.session_max_messages, 50, 2000, 400),
      updated_by: user.upn, updated_at: nowIso,
    };
    const { error: ce } = await admin.from("ai_gateway_config").upsert(row, { onConflict: "id" });
    if (ce) return json({ error: "게이트웨이 설정 저장 실패: " + ce.message }, 500);
    return json({ ok: true, saved: 1, updated_by: user.upn, updated_at: nowIso });
  }

  // 2-h) 저장 액션 — 라우팅 규칙(ai_routing_rule 전체 교체). enforced는 서버가 규칙유형으로 강제.
  if (body && (body as Record<string, unknown>).action === "save_ai_routing") {
    const rowsIn = Array.isArray((body as Record<string, unknown>).rows) ? (body as Record<string, unknown>).rows as Record<string, unknown>[] : [];
    // 게이트웨이 실제 적용 유형: keyword_length·default 만(파일/ERP/교차검증은 미연동 → enforced=false 강제)
    const ENFORCEABLE = new Set(["keyword_length", "default"]);
    const rows = rowsIn.filter((r) => r && r.model_id && r.label).map((r, i) => {
      const rt = String(r.rule_type || "keyword_length");
      const kws = Array.isArray(r.match_keywords)
        ? (r.match_keywords as unknown[]).map((x) => String(x).trim()).filter(Boolean)
        : String(r.match_keywords || "").split(",").map((s) => s.trim()).filter(Boolean);
      const mc = Number(r.min_chars);
      return {
        seq: Math.trunc(Number(r.seq) || (i + 1)),
        label: String(r.label).slice(0, 200),
        rule_type: rt.slice(0, 30),
        match_keywords: kws.slice(0, 30),
        min_chars: Number.isFinite(mc) && mc > 0 ? Math.trunc(mc) : null,
        model_id: String(r.model_id).trim().slice(0, 80),
        enforced: ENFORCEABLE.has(rt) && r.active !== false,
        active: r.active !== false,
        note: r.note != null ? String(r.note).slice(0, 400) : null,
        updated_by: user.upn, updated_at: nowIso,
      };
    });
    // 전체 교체(부서별 ERP 모듈과 동일 패턴): 기존 삭제 후 재삽입
    const { error: de } = await admin.from("ai_routing_rule").delete().gte("id", 0);
    if (de) return json({ error: "라우팅 규칙 갱신 실패: " + de.message }, 500);
    if (rows.length) {
      const { error: ie } = await admin.from("ai_routing_rule").insert(rows);
      if (ie) return json({ error: "라우팅 규칙 저장 실패: " + ie.message }, 500);
    }
    return json({ ok: true, saved: rows.length, updated_by: user.upn, updated_at: nowIso });
  }

  // 3) 사용량 집계 (최근 2000건 기준 — 현 규모에 충분, 대량화 시 SQL 집계로 전환)
  const { data: logs, error: le } = await admin
    .from("chat_log")
    .select("upn,model,messages_count,prompt_chars,prompt_tokens,completion_tokens,est_cost_usd,tools_used,created_at")
    .order("id", { ascending: false })
    .limit(2000);
  if (le) return json({ error: "chat_log 조회 실패: " + le.message }, 500);

  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;
  const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
  const rows = logs || [];
  const byUser: Record<string, { calls: number; chars: number; tokens: number; cost: number; last: string }> = {};
  let todayCalls = 0, weekCalls = 0, totalChars = 0;
  let totalPt = 0, totalCt = 0, totalCost = 0, monthCost = 0, toolCalls = 0;
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const weekUsers = new Set<string>();
  for (const r of rows) {
    const t = new Date(r.created_at).getTime();
    totalChars += r.prompt_chars || 0;
    totalPt += r.prompt_tokens || 0; totalCt += r.completion_tokens || 0;
    const c = Number(r.est_cost_usd || 0);
    totalCost += c;
    if (t >= monthStart.getTime()) monthCost += c;
    if (Array.isArray(r.tools_used) && r.tools_used.length) toolCalls++;
    if (t >= todayStart.getTime()) todayCalls++;
    if (now - t <= 7 * dayMs) { weekCalls++; weekUsers.add(r.upn); }
    const u = (byUser[r.upn] = byUser[r.upn] || { calls: 0, chars: 0, tokens: 0, cost: 0, last: r.created_at });
    u.calls++; u.chars += r.prompt_chars || 0;
    u.tokens += (r.prompt_tokens || 0) + (r.completion_tokens || 0);
    u.cost += c;
    if (r.created_at > u.last) u.last = r.created_at;
  }

  const { data: admins } = await admin.from("portal_admin").select("email,granted_by,granted_at").order("granted_at");

  // 대화내역 규모 통계(건수만 — 원문은 절대 반환하지 않는다. 원문 열람은 본인 전용 jeil-chat-history뿐)
  const [sessCntRes, msgCntRes] = await Promise.all([
    admin.from("chat_session").select("id", { count: "exact", head: true }).is("deleted_at", null),
    admin.from("chat_message").select("id", { count: "exact", head: true }),
  ]);

  // 4) 사용자↔부서↔사원 매핑(ERP Z_USR_MAST_REC 대사) + 부서별 권한 설정
  //    service_role은 RLS 우회 → 사내 전용 뷰 전량 조회. 부서명 기준으로 권한 설정과 결합.
  const [udUsers, udRecon, udRoster, deptPerm, pagesRes, deptErpRes, deptErpSuggestRes, aiModelsRes, aiCfgRes, aiRulesRes,
         catalogRes, grantsRes, permAuditRes] = await Promise.all([
    admin.from("v_erp_user_dept").select("email,dept_nm,emp_nm,matched_dept_cd,dept_matched").order("dept_nm").order("emp_nm"),
    admin.from("v_erp_user_dept_recon").select("email,usr_nm_raw,dept_nm,emp_nm,status,recon_type").order("recon_type").order("dept_nm"),
    admin.from("v_erp_dept_roster").select("dept_nm,emp_cnt,dept_matched,members").order("emp_cnt", { ascending: false }),
    admin.from("dept_permission").select("dept_nm,dept_admin_email,erp_scope,page_visibility,note,updated_by,updated_at"),
    admin.from("portal_page").select("*").order("sort"),
    admin.from("dept_erp_scope").select("dept_nm,module_key"),
    admin.from("v_erp_dept_erp_suggest").select("dept_nm,module_key"),
    admin.from("ai_model").select("*").order("sort"),
    admin.from("ai_gateway_config").select("*").eq("id", 1).maybeSingle(),
    admin.from("ai_routing_rule").select("*").order("seq"),
    admin.from("perm_module_catalog").select("module_key,label,sensitive,sort").order("sort"),
    admin.rpc("perm_grant_list"),                                     // 개인 예외 권한(활성+회수 이력)
    admin.from("perm_audit").select("actor,action,target,detail,at").order("at", { ascending: false }).limit(100),
  ]);

  // ERP DB 연동 현황(소스별 최신 연동시각·건수·기간) — 관리자 콘솔 표시용.
  // service_role이라 RLS 우회. 급여는 뷰 자체가 민감 실테이블을 세지 않고 배치 건수만 노출한다.
  const erpSyncRes = await admin.from("v_erp_sync_overview").select("*").order("sort");

  // 사용자 표기 규약 '부서_이름_아이디'(예: 총무팀_최동혁_dh.choi@jeilm.co.kr) — 표시용. 감사 원본 upn은 불변.
  const uLbl = new Map<string, string>(
    // deno-lint-ignore no-explicit-any
    ((udUsers.data || []) as any[]).map((r) => {
      const e = String(r.email || "").toLowerCase();
      return [e, `${r.dept_nm || "미매핑"}_${r.emp_nm || "-"}_${e}`] as [string, string];
    }),
  );
  const uLabel = (id: unknown) => { const s = String(id || "").toLowerCase(); return uLbl.get(s) || String(id || ""); };

  // 사용모델 설정(SSOT: ai_model / ai_gateway_config / ai_routing_rule). 게이트웨이 실효 모델은 DB 기본모델 우선.
  const aiCfg = aiCfgRes.data as Record<string, unknown> | null;
  const effectiveModel = (aiCfg?.default_model as string) || Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";

  return json({
    gateway: {
      function: "jeil-chat",
      model: effectiveModel,                                   // DB 설정 기본모델(실효값). 미설정 시 env 폴백
      env_model: Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini",
      config_source: aiCfg ? "db(ai_gateway_config)" : "env(fallback)",
      provider: "OpenAI",
      key_set: !!Deno.env.get("OPENAI_API_KEY"),
      auth_policy: "Entra 토큰 Graph 검증 · @jeilm.co.kr 사내 한정",
      limits: {
        max_messages: Number(aiCfg?.max_messages ?? 20),
        max_total_chars: Number(aiCfg?.max_total_chars ?? 24000),
        max_tokens: Number(aiCfg?.max_tokens ?? 1024),
      },
      tools: ["get_order_summary", "get_order_detail", "get_inspection_pending"],
    },
    usage: {
      total_calls: rows.length,
      today_calls: todayCalls,
      week_calls: weekCalls,
      week_users: weekUsers.size,
      total_prompt_chars: totalChars,
      total_prompt_tokens: totalPt,
      total_completion_tokens: totalCt,
      total_cost_usd: Number(totalCost.toFixed(4)),
      month_cost_usd: Number(monthCost.toFixed(4)),
      tool_call_count: toolCalls,
      chat_sessions: sessCntRes.count || 0,
      chat_messages: msgCntRes.count || 0,
      by_user: Object.entries(byUser)
        .map(([upn, v]) => ({ upn, label: uLabel(upn), ...v, cost: Number(v.cost.toFixed(4)) }))
        .sort((a, b) => b.calls - a.calls)
        .slice(0, 20),
      recent: rows.slice(0, 20).map((r) => ({ ...r, upn_label: uLabel(r.upn) })),
    },
    admins: admins || [],
    // 사용자↔부서↔사원 매핑(ERP 대사) — 콘솔 '사용자·부서' 탭 + '권한 설정' 부서표 기준 데이터
    dept_mapping: {
      counts: {
        users: (udUsers.data || []).length,
        recon: (udRecon.data || []).length,
        depts: (udRoster.data || []).length,
      },
      users: udUsers.data || [],   // 정상 매핑(재직·부서일치)
      recon: udRecon.data || [],   // 대사 불일치(자동제외·확인대상)
      roster: udRoster.data || [], // 부서별 사원 명부
      error: udUsers.error?.message || udRoster.error?.message || null,
    },
    dept_permissions: deptPerm.data || [], // 저장된 부서별 권한 설정
    // 권한 상세: 페이지 레지스트리 + 부서별 ERP 모듈 권한 + 모듈 카탈로그
    portal_pages: pagesRes.data || [],
    dept_erp_scope: deptErpRes.data || [],
    dept_erp_suggest: deptErpSuggestRes.data || [], // ERP 역할·메뉴 권한 기반 제안값(참고용)
    // 모듈 카탈로그(SSOT: perm_module_catalog). sensitive=민감(급여·자금) — 콘솔에서 ⚠ 표시·일괄부여 제외.
    catalog: (catalogRes.data || []).length
      ? (catalogRes.data as { module_key: string; label: string; sensitive: boolean }[])
          .map((c) => ({ key: c.module_key, label: c.label, sensitive: c.sensitive }))
      : CATALOG_FALLBACK,
    // 개인 예외 권한(부서축으로 못 푸는 예외) + 권한 변경 감사
    perm_grants: grantsRes.data || [],
    perm_audit: permAuditRes.data || [],
    // ERP DB 연동 현황 — 어떤 ERP 테이블이 언제·얼마나 중간DB로 들어왔는지(연결 상태 확인용)
    erp_sync: { sources: erpSyncRes.data || [], error: erpSyncRes.error?.message || null },
    // 사용모델 설정 탭(모델 카탈로그·게이트웨이 설정·라우팅 규칙) — 실데이터
    model_settings: {
      models: aiModelsRes.data || [],
      config: aiCfg,
      routing: aiRulesRes.data || [],
      effective_model: effectiveModel,
      error: aiModelsRes.error?.message || aiCfgRes.error?.message || aiRulesRes.error?.message || null,
    },
    as_of: new Date().toISOString(),
  });
});
