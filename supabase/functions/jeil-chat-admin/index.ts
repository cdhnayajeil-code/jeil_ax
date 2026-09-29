// jeil-chat-admin — 챗봇 관리자 콘솔 실데이터 API (사용량·권한·게이트웨이 상태·사용자부서 매핑)
// 배포: verify_jwt=false (Entra 토큰을 내부에서 Graph로 검증)
// 호출: POST /functions/v1/jeil-chat-admin  Authorization: Bearer <Entra access_token>
//   조회(빈 바디): { gateway, usage, admins, dept_mapping, dept_permissions, portal_pages, dept_erp_scope, catalog, model_settings } — 관리자만
//   부분 조회({scope:'perm'}): { org_nodes, page_scopes, dept_modules, admins, dept_mapping, portal_pages, dept_erp_scope, dept_erp_suggest, catalog, perm_grants, perm_audit, as_of }
//   부분 조회({scope:'dept'}): { dept_mapping, as_of }
//   저장({action:'save_dept_perm'|'save_page_scope'|'save_dept_module'|'preview_page_scope'|'save_ai_models'|'save_ai_config'|'save_ai_routing'|'manage_admin', ...}): 관리자만 → { ok, saved }
//   v9: save_ai_config에 work 컨텍스트 적용범위·대화 저장 정책 6필드 추가. usage에 세션·메시지 건수(원문은 반환하지 않음 — 본인 전용 jeil-chat-history뿐).
//   v10(2026-07-22): 권한 코어 통합 — 개인 예외 권한 액션 3종(grant_perm·revoke_perm·effective_perm) 추가,
//     조회 응답에 perm_grants·perm_audit 포함, 모듈 카탈로그 SSOT를 DB(perm_module_catalog)로 이관.
//   v11(2026-09-10, REQ-0026): 부분 조회 scope('perm'|'dept') — 권한 설정 독립 화면(/admin/permissions)과
//     사용자·부서 화면(/admin/user-dept)이 대화 로그 2,000건·모델 설정까지 매번 받지 않게. 빈 바디는 종전과 같은 전체 응답(호환).
//     save_dept_perm 은 호출 화면이 사라졌지만(부서 관리자 축 UI 제거 — 관리자 결정) 호환을 위해 남긴다.
//   v12(2026-09-23, REQ-0078 · ADR-107): 부서 키 = 부서코드 + 조직도 상속(하위 포함).
//     scope:'perm' 에 org_nodes(현행 조직)·page_scopes·dept_modules 추가.
//     저장은 DB RPC 로 — save_page_scope(perm_page_scope_save) · save_dept_module(perm_dept_module_save),
//     미리보기 preview_page_scope(perm_preview_page). 검증·감사·옛 컬럼 미러는 RPC 가 한다(트랜잭션 하나).
//     옛 저장 save_page_perm·save_dept_erp 는 **거부(410)** — 판정이 새 표만 보므로 받아 주면 저장이 조용히 무시된다.
//   v13(2026-09-29, REQ-0091 · ADR-111): AI 비용·예산 관제 — 액션 3종 추가(vendor_cost·save_vendor_budget·verify_vendor_key).
//     두 벤더의 **실사용액은 벤더 Usage/Cost API 실측**(Admin 키 필요), 키가 없으면 chat_log·agent_turn 기반 「내부 추정」으로 표시하고 사유를 남긴다.
//     **잔여 크레딧 API 는 두 벤더 모두 없다** → 관리자 입력(ai_vendor_budget)에서 실사용을 빼 역산한다. 키 값은 어떤 응답에도 담지 않는다(§1.1·§1.8).
//   v14(2026-09-29, REQ-0056): 모델 카탈로그 현행화 반영 — tier(고성능/범용/경량/이전세대)·캐시 입력 단가·컨텍스트·토큰 계수 노출,
//     「질문 1천건 환산」에 토큰 계수·캐시 적중 가정 적용, **callable 을 어댑터+키 등록으로 판정**(OpenAI 하드코딩 제거).
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

/** 어댑터가 있는 벤더 목록 — llm/index.ts(ADAPTERS)와 같은 축. 새 벤더를 붙이면 여기에 한 줄. */
const ADAPTER_VENDORS: Record<string, string> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };

/** 이 서버에서 실제로 부를 수 있는 벤더인가 — 어댑터가 있고 **호출 키가 등록**돼 있어야 한다. */
function vendorCallable(vendor: string): boolean {
  const env = ADAPTER_VENDORS[String(vendor || "").toLowerCase()];
  return !!env && !!Deno.env.get(env);
}

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

  // 2-c0) v12: 옛 저장 액션 거부 — 판정(perm_effective)이 코드 표(portal_page_scope·dept_module_scope)만 본다.
  //   예전 화면이 브라우저에 남아 저장하면 성공처럼 보이고 아무 효과가 없게 되므로, 새로고침을 요구한다.
  if (body && ["save_page_perm", "save_dept_erp"].includes(String((body as Record<string, unknown>).action))) {
    return json({ error: "권한 설정 화면이 조직도 방식으로 바뀌었습니다. 화면을 새로고침(Ctrl+F5)한 뒤 다시 저장하세요." }, 410);
  }

  // 2-c1) v12: 페이지 공개 설정 1건 저장 — 검증·감사·옛 컬럼 미러는 RPC(perm_page_scope_save)가 한 트랜잭션으로.
  if (body && (body as Record<string, unknown>).action === "save_page_scope") {
    const page = (body as Record<string, unknown>).page;
    if (!page || typeof page !== "object") return json({ error: "저장할 페이지 설정이 없습니다." }, 400);
    const { data, error } = await admin.rpc("perm_page_scope_save", { p_actor: user.upn, p_page: page });
    if (error) return json({ error: "페이지 공개 설정 저장 실패: " + error.message }, 400);
    return json({ ok: true, result: data, updated_by: user.upn, updated_at: nowIso });
  }

  // 2-c2) v12: 부서 1건의 ERP 모듈 저장 — 민감 모듈 상속 금지·신규 민감 부여 사유 필수(RPC·트리거가 강제).
  if (body && (body as Record<string, unknown>).action === "save_dept_module") {
    const b = body as Record<string, unknown>;
    const deptCd = String(b.dept_cd || "").trim();
    if (!deptCd) return json({ error: "부서 코드가 필요합니다." }, 400);
    const rows = Array.isArray(b.rows) ? b.rows : [];
    const { data, error } = await admin.rpc("perm_dept_module_save", {
      p_actor: user.upn, p_dept_cd: deptCd, p_rows: rows,
      p_reason: b.reason != null ? String(b.reason).slice(0, 400) : null,
    });
    if (error) return json({ error: "ERP 모듈 저장 실패: " + error.message }, 400);
    return json({ ok: true, result: data, updated_by: user.upn, updated_at: nowIso });
  }

  // 2-c3) v12: 미리보기 — 저장하지 않은 페이지 설정으로 「어느 부서·몇 명이 보게 되나」(판정과 같은 규칙).
  if (body && (body as Record<string, unknown>).action === "preview_page_scope") {
    const page = (body as Record<string, unknown>).page;
    if (!page || typeof page !== "object") return json({ error: "미리볼 페이지 설정이 없습니다." }, 400);
    const { data, error } = await admin.rpc("perm_preview_page", { p_page: page });
    if (error) return json({ error: "미리보기 실패: " + error.message }, 400);
    return json({ ok: true, preview: data });
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
      // callable = 「어댑터가 있는 벤더 + 그 벤더 호출 키가 서버에 등록됨」. 클라이언트 임의 지정 불가.
      //   v13까지는 OpenAI 만 true 로 못박혀 있었다 — 부서 에이전트 게이트웨이(jeil-chat-lab)에 Claude 어댑터가
      //   생긴 뒤로는 사실과 달라, 키를 넣어도 Claude 모델이 「호출 불가」로 보였다(REQ-0085·0056).
      callable: vendorCallable(String(r.vendor || "OpenAI")),
      sort: Math.trunc(num(r.sort, 100)),
      note: r.note != null ? String(r.note).slice(0, 400) : null,
      updated_by: user.upn, updated_at: nowIso,
    }));
    if (!rows.length) return json({ error: "저장할 모델이 없습니다." }, 400);
    // v14: 카탈로그 메타(tier·캐시단가·컨텍스트·토큰계수·상태메모)는 화면에서 편집하지 않는다 →
    //   upsert 가 null 로 덮어쓰지 않도록 현재 값을 읽어 함께 넣는다(정본은 SQL 77).
    {
      const ids = rows.map((r) => r.model_id);
      const { data: cur } = await admin.from("ai_model")
        .select("model_id,tier,price_cache_in,context_k,token_factor,status_note").in("model_id", ids);
      const keep = new Map((cur || []).map((c: Record<string, unknown>) => [String(c.model_id), c]));
      for (const r of rows as Record<string, unknown>[]) {
        const k = keep.get(String(r.model_id));
        if (!k) continue;
        r.tier = k.tier; r.price_cache_in = k.price_cache_in; r.context_k = k.context_k;
        r.token_factor = k.token_factor; r.status_note = k.status_note;
      }
    }
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

  /* ════════════════════════════════════════════════════════════════════════════════════════
     v13(2026-09-29, REQ-0091 · ADR-111) — AI 비용·예산 관제(Claude + OpenAI 두 벤더)
       action:'vendor_cost'        → 벤더별 이번 달 실사용액·모델별·일별 + 예산/충전 잔여(역산) + 단가 + 오케스트레이션 배정
       action:'save_vendor_budget' → ai_vendor_budget 저장(관리자 입력 예산·충전액)
       action:'verify_vendor_key'  → 붙여 넣은 키를 벤더에 시험 호출해 **검증만** 한다(저장·기록하지 않는다)

     왜 「잔여」를 역산하는가
       OpenAI·Anthropic 모두 **잔여 크레딧 조회 API 가 없다**(2026-09-29 문서 실측). 사용량·비용 조회만 있다.
       그래서 잔여 = (관리자가 적은 월 예산 − 이번 달 실사용) / (관리자가 확인한 잔액 − 확인일 이후 실사용).
       화면은 이 값이 역산이라는 것과 기준일을 반드시 함께 보여 준다(CLAUDE.md §16.6).

     키 취급 — 값은 어떤 응답·로그에도 담지 않는다(CLAUDE.md §1.1·§1.8). 등록 여부·길이·접두어 일치만 알린다.
     ════════════════════════════════════════════════════════════════════════════════════════ */

  // 시크릿 규약: 호출 키와 사용량 조회(Admin) 키는 **별개**다. Admin 키 없이 사용량 API 를 부르면 401.
  const KEY_SPEC = [
    { env: "OPENAI_API_KEY",      vendor: "openai",    role: "call",  prefix: "sk-",          label: "OpenAI 호출 키",              need: "챗봇·에이전트가 GPT 모델을 부를 때" },
    { env: "OPENAI_ADMIN_KEY",    vendor: "openai",    role: "admin", prefix: "sk-admin-",    label: "OpenAI 사용량 조회 키(Admin)", need: "이 화면이 OpenAI 실사용액을 읽을 때" },
    { env: "ANTHROPIC_API_KEY",   vendor: "anthropic", role: "call",  prefix: "sk-ant-",      label: "Anthropic 호출 키",           need: "에이전트가 Claude 모델을 부를 때" },
    { env: "ANTHROPIC_ADMIN_KEY", vendor: "anthropic", role: "admin", prefix: "sk-ant-admin", label: "Anthropic 사용량 조회 키(Admin)", need: "이 화면이 Claude 실사용액을 읽을 때" },
  ];

  /** 키 등록 현황 — **값은 담지 않는다**. 길이·접두어 일치만(CLAUDE.md §1.8). */
  const keyStatus = () =>
    KEY_SPEC.map((k) => {
      const v = Deno.env.get(k.env) || "";
      return {
        env: k.env, vendor: k.vendor, role: k.role, label: k.label, need: k.need,
        set: !!v, len: v.length,
        expect_prefix: k.prefix,
        prefix_ok: v ? v.startsWith(k.prefix) : null,
      };
    });

  /** 사용량 조회에 쓸 Admin 키. 전용 시크릿이 없으면, 호출 키가 Admin 키로 발급된 경우에만 재사용한다. */
  const adminKeyFor = (vendor: string): string | null => {
    if (vendor === "openai") {
      const a = Deno.env.get("OPENAI_ADMIN_KEY");
      if (a) return a;
      const c = Deno.env.get("OPENAI_API_KEY") || "";
      return c.startsWith("sk-admin-") ? c : null;
    }
    const a = Deno.env.get("ANTHROPIC_ADMIN_KEY");
    if (a) return a;
    const c = Deno.env.get("ANTHROPIC_API_KEY") || "";
    return c.startsWith("sk-ant-admin") ? c : null;
  };
  const callKeySet = (vendor: string) => !!Deno.env.get(vendor === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");

  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const num2 = (n: number) => Number(n.toFixed(2));
  const num6 = (n: number) => Number(n.toFixed(6));

  // 「질문 1천건 환산」 가정값 — 한 곳에서만 고친다(화면은 서버가 보내는 assume 을 그대로 적는다)
  const Q_IN_TOKENS = 6000, Q_OUT_TOKENS = 700, Q_CACHE_HIT = 0.4;
  type DayCost = { day: string; cost_usd: number };
  type CostOut = { byDay: DayCost[]; modelCost: Map<string, number> };
  type ModelUse = { model: string; in_tokens: number; cached_tokens: number; out_tokens: number; requests: number; cost_usd: number | null };

  /* ---- OpenAI: 비용(일 단위 USD 실수) + 토큰(모델별) -------------------------------------- */
  async function openaiCost(key: string, startUnix: number, endUnix: number, monthStartDay: string): Promise<CostOut> {
    const byDay: DayCost[] = [];
    const modelCost = new Map<string, number>();   // 모델별 비용은 **이번 달분만** 모은다(표가 이번 달 기준)
    let page: string | null = null, guard = 0;
    do {
      const u = new URL("https://api.openai.com/v1/organization/costs");
      u.searchParams.set("start_time", String(startUnix));
      u.searchParams.set("end_time", String(endUnix));
      u.searchParams.set("bucket_width", "1d");
      u.searchParams.append("group_by[]", "line_item");   // 같은 요청으로 모델별 비용까지 — 호출 수는 그대로
      u.searchParams.set("limit", "31");
      if (page) u.searchParams.set("page", page);
      const r = await fetch(u, { headers: { Authorization: `Bearer ${key}` } });
      if (!r.ok) throw new Error(`OpenAI 비용 조회 실패(${r.status}) — ${(await r.text()).slice(0, 180)}`);
      const j = await r.json();
      for (const b of (j.data || [])) {
        const day = dayKey(new Date(Number(b.start_time) * 1000));
        let sum = 0;
        for (const x of (b.results || [])) {
          const v = Number((x?.amount as Record<string, unknown> | undefined)?.value || 0);
          sum += v;
          if (day >= monthStartDay) {
            // line_item 은 "gpt-4o-mini-2024-07-18, input" 꼴 — 마지막 쉼표 앞이 모델이다.
            // 형식이 다르면 통째로 라벨로 쓴다(추측해서 잘라내지 않는다).
            const li = String(x.line_item || "(미지정)");
            const ci = li.lastIndexOf(",");
            const mk = ci > 0 ? li.slice(0, ci).trim() : li;
            modelCost.set(mk, (modelCost.get(mk) || 0) + v);
          }
        }
        byDay.push({ day, cost_usd: num6(sum) });
      }
      page = j.has_more ? (j.next_page || null) : null;
    } while (page && ++guard < 4);
    return { byDay, modelCost };
  }

  async function openaiTokens(key: string, startUnix: number, endUnix: number): Promise<ModelUse[]> {
    const agg = new Map<string, ModelUse>();
    let page: string | null = null, guard = 0;
    do {
      const u = new URL("https://api.openai.com/v1/organization/usage/completions");
      u.searchParams.set("start_time", String(startUnix));
      u.searchParams.set("end_time", String(endUnix));
      u.searchParams.set("bucket_width", "1d");
      u.searchParams.append("group_by[]", "model");
      u.searchParams.set("limit", "31");
      if (page) u.searchParams.set("page", page);
      const r = await fetch(u, { headers: { Authorization: `Bearer ${key}` } });
      if (!r.ok) throw new Error(`OpenAI 토큰 조회 실패(${r.status}) — ${(await r.text()).slice(0, 180)}`);
      const j = await r.json();
      for (const b of (j.data || [])) {
        for (const x of (b.results || [])) {
          const m = String(x.model || "(미지정)");
          const a = agg.get(m) || { model: m, in_tokens: 0, cached_tokens: 0, out_tokens: 0, requests: 0, cost_usd: null };
          a.in_tokens += Number(x.input_tokens || 0);
          a.cached_tokens += Number(x.input_cached_tokens || 0);
          a.out_tokens += Number(x.output_tokens || 0);
          a.requests += Number(x.num_model_requests || 0);
          agg.set(m, a);
        }
      }
      page = j.has_more ? (j.next_page || null) : null;
    } while (page && ++guard < 4);
    return [...agg.values()];
  }

  /* ---- Anthropic: 비용(금액은 **센트 단위 문자열** → /100) + 토큰(모델별) ------------------ */
  async function anthropicCost(key: string, startIso: string, endIso: string, monthStartDay: string): Promise<CostOut> {
    const byDay: DayCost[] = [];
    const modelCost = new Map<string, number>();
    let page: string | null = null, guard = 0;
    do {
      const u = new URL("https://api.anthropic.com/v1/organizations/cost_report");
      u.searchParams.set("starting_at", startIso);
      u.searchParams.set("ending_at", endIso);
      u.searchParams.set("bucket_width", "1d");
      u.searchParams.append("group_by[]", "description");  // description 으로 묶으면 결과에 model·cost_type 이 붙는다
      u.searchParams.set("limit", "31");
      if (page) u.searchParams.set("page", page);
      const r = await fetch(u, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
      if (!r.ok) throw new Error(`Anthropic 비용 조회 실패(${r.status}) — ${(await r.text()).slice(0, 180)}`);
      const j = await r.json();
      for (const b of (j.data || [])) {
        const day = String(b.starting_at || "").slice(0, 10);
        let cents = 0;
        for (const x of (b.results || [])) {
          // amount 는 **최소 통화단위(센트) 문자열**이다 — "123.45" = $1.2345
          const v = Number(x.amount || 0);
          cents += v;
          if (day >= monthStartDay) {
            // 토큰 외 비용(웹검색·코드실행·세션)은 model 이 null 이다 — 따로 모아 청구액을 잃지 않는다
            const mk = x.model ? String(x.model) : `(토큰 외: ${String(x.cost_type || "기타")})`;
            modelCost.set(mk, (modelCost.get(mk) || 0) + v / 100);
          }
        }
        byDay.push({ day, cost_usd: num6(cents / 100) });
      }
      page = j.has_more ? (j.next_page || null) : null;
    } while (page && ++guard < 4);
    return { byDay, modelCost };
  }

  async function anthropicTokens(key: string, startIso: string, endIso: string): Promise<ModelUse[]> {
    const agg = new Map<string, ModelUse>();
    let page: string | null = null, guard = 0;
    do {
      const u = new URL("https://api.anthropic.com/v1/organizations/usage_report/messages");
      u.searchParams.set("starting_at", startIso);
      u.searchParams.set("ending_at", endIso);
      u.searchParams.set("bucket_width", "1d");
      u.searchParams.append("group_by[]", "model");
      u.searchParams.set("limit", "31");
      if (page) u.searchParams.set("page", page);
      const r = await fetch(u, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
      if (!r.ok) throw new Error(`Anthropic 토큰 조회 실패(${r.status}) — ${(await r.text()).slice(0, 180)}`);
      const j = await r.json();
      for (const b of (j.data || [])) {
        for (const x of (b.results || [])) {
          const m = String(x.model || "(미지정)");
          const a = agg.get(m) || { model: m, in_tokens: 0, cached_tokens: 0, out_tokens: 0, requests: 0, cost_usd: null };
          const cc = (x.cache_creation || {}) as Record<string, unknown>;
          a.in_tokens += Number(x.uncached_input_tokens || 0)
            + Number(cc.ephemeral_5m_input_tokens || 0) + Number(cc.ephemeral_1h_input_tokens || 0);
          a.cached_tokens += Number(x.cache_read_input_tokens || 0);
          a.out_tokens += Number(x.output_tokens || 0);
          a.requests += 0; // 사용량 API 는 요청 수를 주지 않는다 — 추정하지 않고 0(화면은 「—」)
          agg.set(m, a);
        }
      }
      page = j.has_more ? (j.next_page || null) : null;
    } while (page && ++guard < 4);
    return [...agg.values()];
  }

  /* ---- 2-k0) 키 등록 현황만 — /admin/api-setup 전용 경량 응답(외부 호출·DB 조회 없음) ---------- */
  if (body && (body as Record<string, unknown>).action === "keys_status") {
    return json({ ok: true, as_of: nowIso, keys: keyStatus() });
  }

  /* ---- 2-k) 벤더 예산 저장 --------------------------------------------------------------- */
  if (body && (body as Record<string, unknown>).action === "save_vendor_budget") {
    const rowsIn = Array.isArray((body as Record<string, unknown>).rows) ? (body as Record<string, unknown>).rows as Record<string, unknown>[] : [];
    const ok = new Set(["openai", "anthropic"]);
    const rows = rowsIn.filter((r) => r && ok.has(String(r.vendor).toLowerCase())).map((r) => {
      const bud = Math.max(0, Number(r.monthly_budget_usd) || 0);
      const credRaw = r.credit_added_usd;
      const hasCred = credRaw !== "" && credRaw != null && Number.isFinite(Number(credRaw));
      const asOf = String(r.credit_as_of || "").slice(0, 10);
      const ar = Number(r.alert_ratio);
      return {
        vendor: String(r.vendor).toLowerCase(),
        label: String(r.label || r.vendor).slice(0, 80),
        billing_mode: r.billing_mode === "postpaid_invoice" ? "postpaid_invoice" : "prepaid_credit",
        monthly_budget_usd: num2(bud),
        // 잔액과 확인일은 **함께** 있어야 한다(표 제약) — 하나만 오면 둘 다 비운다
        credit_added_usd: hasCred && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? num2(Math.max(0, Number(credRaw))) : null,
        credit_as_of: hasCred && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : null,
        alert_ratio: Number.isFinite(ar) && ar > 0 && ar <= 1 ? Number(ar.toFixed(3)) : 0.8,
        console_url: r.console_url != null ? String(r.console_url).slice(0, 300) : null,
        note: r.note != null ? String(r.note).slice(0, 400) : null,
        updated_by: user.upn, updated_at: nowIso,
      };
    });
    if (!rows.length) return json({ error: "저장할 벤더 행이 없습니다." }, 400);
    const { error: be } = await admin.from("ai_vendor_budget").upsert(rows, { onConflict: "vendor" });
    if (be) return json({ error: "벤더 예산 저장 실패: " + be.message }, 500);
    return json({ ok: true, saved: rows.length, updated_by: user.upn, updated_at: nowIso });
  }

  /* ---- 2-l) 키 검증 — 저장하지 않는다 ----------------------------------------------------
     붙여 넣은 키로 벤더에 가장 싼 조회 1건을 보내 살아 있는지만 본다.
     키는 변수 밖으로 나가지 않는다: DB 에 쓰지 않고, 로그·응답에 담지 않는다.
     실제 사용은 Supabase Edge Function 시크릿 등록으로만 한다(CLAUDE.md §1.1). */
  if (body && (body as Record<string, unknown>).action === "verify_vendor_key") {
    const b = body as Record<string, unknown>;
    const vendor = String(b.vendor || "").toLowerCase();
    const role = String(b.role || "call");
    const key = String(b.key || "").trim();
    if (!["openai", "anthropic"].includes(vendor)) return json({ error: "벤더를 openai 또는 anthropic 으로 지정하세요." }, 400);
    if (!key) return json({ error: "검증할 키를 입력하세요." }, 400);
    if (key.length > 300) return json({ error: "키 형식이 아닙니다(너무 깁니다)." }, 400);

    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    let url = "", headers: Record<string, string> = {}, what = "";
    if (vendor === "openai" && role === "admin") {
      const u = new URL("https://api.openai.com/v1/organization/costs");
      u.searchParams.set("start_time", String(Math.floor(yesterday.getTime() / 1000)));
      u.searchParams.set("limit", "1");
      url = u.toString(); headers = { Authorization: `Bearer ${key}` }; what = "OpenAI 사용량 조회 권한";
    } else if (vendor === "openai") {
      url = "https://api.openai.com/v1/models"; headers = { Authorization: `Bearer ${key}` }; what = "OpenAI 호출 권한";
    } else if (role === "admin") {
      const u = new URL("https://api.anthropic.com/v1/organizations/cost_report");
      u.searchParams.set("starting_at", yesterday.toISOString().slice(0, 10) + "T00:00:00Z");
      u.searchParams.set("limit", "1");
      url = u.toString(); headers = { "x-api-key": key, "anthropic-version": "2023-06-01" }; what = "Anthropic 사용량 조회 권한";
    } else {
      url = "https://api.anthropic.com/v1/models?limit=1"; headers = { "x-api-key": key, "anthropic-version": "2023-06-01" }; what = "Anthropic 호출 권한";
    }
    try {
      const r = await fetch(url, { headers });
      const txt = (await r.text()).slice(0, 300);
      const hint = r.status === 401 ? "키가 틀렸거나 폐기됐습니다."
        : r.status === 403 ? (role === "admin" ? "이 키에 조직 사용량 조회 권한이 없습니다 — Admin 키로 발급하세요." : "권한이 없는 키입니다.")
        : r.status === 404 ? "조직 계정이 아니거나 이 벤더에서 해당 API 를 쓸 수 없습니다(개인 계정은 Admin API 불가)."
        : r.status === 429 ? "요청이 몰렸습니다 — 잠시 후 다시." : "";
      // 응답 본문은 벤더 오류 메시지일 뿐이지만, 혹시라도 키가 되비치지 않게 잘라낸다
      const detail = txt.replace(key, "***").slice(0, 200);
      return json({
        ok: true, verified: r.ok, status: r.status, what, hint,
        detail: r.ok ? "정상 응답" : detail,
        note: "이 키는 저장하지 않았습니다. 실제 사용은 Supabase Edge Function 시크릿 등록으로만 됩니다.",
      });
    } catch (e) {
      return json({ ok: true, verified: false, status: 0, what, hint: "벤더에 연결하지 못했습니다.", detail: String((e as Error).message || e).slice(0, 200) });
    }
  }

  /* ---- 2-m) 벤더별 사용량·비용·예산 잔여 --------------------------------------------------- */
  if (body && (body as Record<string, unknown>).action === "vendor_cost") {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const floor90 = new Date(now.getTime() - 90 * 24 * 3600 * 1000);

    const [budRes, modelRes, cfgRes, agentRes, verRes, ruleRes] = await Promise.all([
      admin.from("ai_vendor_budget").select("*"),
      admin.from("ai_model").select("model_id,vendor,label,purpose,tier,price_in,price_cache_in,price_out,context_k,token_factor,active,callable,sort,status_note,note").order("sort"),
      admin.from("ai_gateway_config").select("default_model,max_tokens,prompt_caching").eq("id", 1).maybeSingle(),
      admin.from("ai_agent").select("agent_key,name_ko,dept_nm,status,current_version,monthly_budget_usd,daily_limit"),
      admin.from("ai_agent_version").select("agent_key,version,state,model_id,fallback_model_id,effort"),
      admin.from("ai_routing_rule").select("seq,label,rule_type,model_id,active,enforced").order("seq"),
    ]);

    const models = modelRes.data || [];
    const vendorOf = new Map<string, string>(models.map((m) => [m.model_id, String(m.vendor || "").toLowerCase()]));
    const guessVendor = (mid: string) => {
      const v = vendorOf.get(mid);
      if (v) return v;
      const s = String(mid || "").toLowerCase();
      if (s.startsWith("claude")) return "anthropic";
      if (s.startsWith("gpt") || s.startsWith("o1") || s.startsWith("o3") || s.startsWith("o4")) return "openai";
      return "";
    };

    // 내부 추정 폴백용 원장 — Admin 키가 없는 벤더는 이 값으로 「내부 추정」을 보여 준다(0 으로 감추지 않는다)
    const sinceAll = new Date(Math.min(monthStart.getTime(), ...(budRes.data || [])
      .map((b) => (b.credit_as_of ? new Date(b.credit_as_of + "T00:00:00Z").getTime() : monthStart.getTime()))));
    const estSince = new Date(Math.max(sinceAll.getTime(), floor90.getTime()));
    const [clRes, atRes] = await Promise.all([
      admin.from("chat_log").select("model,est_cost_usd,prompt_tokens,completion_tokens,created_at").gte("created_at", estSince.toISOString()).limit(20000),
      admin.from("agent_turn").select("model,est_cost_usd,prompt_tokens,completion_tokens,cache_read_tokens,created_at").gte("created_at", estSince.toISOString()).limit(20000),
    ]);
    const estByVendor: Record<string, { byDay: Map<string, number>; byModel: Map<string, ModelUse> }> = {
      openai: { byDay: new Map(), byModel: new Map() }, anthropic: { byDay: new Map(), byModel: new Map() },
    };
    const feedEst = (r: Record<string, unknown>) => {
      const mid = String(r.model || "");
      const v = guessVendor(mid); if (!estByVendor[v]) return;
      const day = String(r.created_at).slice(0, 10);
      const c = Number(r.est_cost_usd || 0);
      const bd = estByVendor[v].byDay; bd.set(day, (bd.get(day) || 0) + c);
      const bm = estByVendor[v].byModel;
      const a = bm.get(mid) || { model: mid, in_tokens: 0, cached_tokens: 0, out_tokens: 0, requests: 0, cost_usd: 0 };
      a.in_tokens += Number(r.prompt_tokens || 0);
      a.cached_tokens += Number(r.cache_read_tokens || 0);
      a.out_tokens += Number(r.completion_tokens || 0);
      a.requests += 1;
      a.cost_usd = Number(a.cost_usd || 0) + c;
      bm.set(mid, a);
    };
    (clRes.data || []).forEach(feedEst);
    (atRes.data || []).forEach(feedEst);

    const budByVendor = new Map<string, Record<string, unknown>>((budRes.data || []).map((b) => [String(b.vendor), b]));
    const vendors: Record<string, unknown>[] = [];

    for (const vendor of ["openai", "anthropic"]) {
      const bud = budByVendor.get(vendor) || {
        vendor, label: vendor === "openai" ? "OpenAI" : "Anthropic (Claude)", billing_mode: "prepaid_credit",
        monthly_budget_usd: 0, credit_added_usd: null, credit_as_of: null, alert_ratio: 0.8, console_url: null, note: null,
      };
      const creditAsOf = bud.credit_as_of ? new Date(String(bud.credit_as_of) + "T00:00:00Z") : null;
      const creditTooOld = !!creditAsOf && creditAsOf.getTime() < floor90.getTime();
      const winStart = new Date(Math.max(
        Math.min(monthStart.getTime(), creditAsOf ? creditAsOf.getTime() : monthStart.getTime()),
        floor90.getTime(),
      ));

      const key = adminKeyFor(vendor);
      let source = "internal_estimate", err: string | null = null;
      let byDay: DayCost[] = [], byModel: ModelUse[] = [];

      if (key) {
        try {
          const mStart = dayKey(monthStart);
          let c: CostOut;
          if (vendor === "openai") {
            const [cc, t] = await Promise.all([
              openaiCost(key, Math.floor(winStart.getTime() / 1000), Math.floor(now.getTime() / 1000), mStart),
              openaiTokens(key, Math.floor(monthStart.getTime() / 1000), Math.floor(now.getTime() / 1000)),
            ]);
            c = cc; byModel = t;
          } else {
            const [cc, t] = await Promise.all([
              anthropicCost(key, winStart.toISOString(), now.toISOString(), mStart),
              anthropicTokens(key, monthStart.toISOString(), now.toISOString()),
            ]);
            c = cc; byModel = t;
          }
          byDay = c.byDay;
          // 모델별 비용을 토큰 행에 붙인다. 비용표에만 있는 항목(스냅샷 ID·토큰 외 비용)은 행을 새로 만든다 —
          // 청구에 있는 돈을 화면에서 지우지 않는다.
          const left = new Map(c.modelCost);
          for (const m of byModel) {
            // 벤더는 스냅샷 ID(gpt-4o-mini-2024-07-18)로 청구하고 사용량은 별칭으로 줄 수 있다 → 접두어로도 맞춘다
            let hit: string | null = left.has(m.model) ? m.model : null;
            if (!hit) for (const k of left.keys()) { if (k.startsWith(m.model) || m.model.startsWith(k)) { hit = k; break; } }
            if (hit) { m.cost_usd = num6(left.get(hit) || 0); left.delete(hit); }
          }
          for (const [k, v] of left) {
            byModel.push({ model: k, in_tokens: 0, cached_tokens: 0, out_tokens: 0, requests: 0, cost_usd: num6(v) });
          }
          source = "vendor_api";
        } catch (e) {
          err = String((e as Error).message || e).slice(0, 220);
        }
      } else {
        err = `${vendor === "openai" ? "OPENAI_ADMIN_KEY" : "ANTHROPIC_ADMIN_KEY"} 미등록 — 벤더 청구액을 읽을 수 없어 내부 추정치를 보여 줍니다.`;
      }

      if (source !== "vendor_api") {
        byDay = [...estByVendor[vendor].byDay.entries()].map(([day, cost_usd]) => ({ day, cost_usd: num6(cost_usd) })).sort((a, b) => a.day < b.day ? -1 : 1);
        byModel = [...estByVendor[vendor].byModel.values()];
      }

      const mStr = dayKey(monthStart);
      const monthSpend = byDay.filter((d) => d.day >= mStr).reduce((s, d) => s + d.cost_usd, 0);
      const creditSpend = creditAsOf && !creditTooOld
        ? byDay.filter((d) => d.day >= dayKey(creditAsOf)).reduce((s, d) => s + d.cost_usd, 0) : null;

      const budgetUsd = Number(bud.monthly_budget_usd || 0);
      const creditAdded = bud.credit_added_usd != null ? Number(bud.credit_added_usd) : null;

      vendors.push({
        vendor, label: bud.label, billing_mode: bud.billing_mode,
        console_url: bud.console_url, note: bud.note,
        updated_by: bud.updated_by || null, updated_at: bud.updated_at || null,
        call_key_set: callKeySet(vendor),
        admin_key_set: !!key,
        source, error: err,
        window_start: dayKey(winStart),
        month_spend_usd: num6(monthSpend),
        by_day: byDay,
        by_model: byModel.map((m) => ({ ...m, cost_usd: m.cost_usd == null ? null : num6(m.cost_usd) }))
          .sort((a, b) => (b.cost_usd || 0) - (a.cost_usd || 0) || (b.out_tokens - a.out_tokens)),
        budget: {
          monthly_budget_usd: num2(budgetUsd),
          set: budgetUsd > 0,
          remaining_usd: budgetUsd > 0 ? num2(budgetUsd - monthSpend) : null,
          ratio: budgetUsd > 0 ? Number(Math.min(9.99, monthSpend / budgetUsd).toFixed(4)) : null,
          alert_ratio: Number(bud.alert_ratio || 0.8),
        },
        credit: {
          added_usd: creditAdded,
          as_of: bud.credit_as_of || null,
          spent_since_usd: creditSpend == null ? null : num6(creditSpend),
          remaining_usd: creditAdded != null && creditSpend != null ? num2(creditAdded - creditSpend) : null,
          stale: creditTooOld,
          reason: creditAdded == null ? "충전 잔액 미입력 — 벤더 콘솔에서 확인한 금액과 날짜를 적으면 역산합니다."
            : creditTooOld ? "확인일이 90일 이전입니다 — 잔액을 다시 확인해 주세요(역산 창을 넘습니다)." : null,
        },
      });
    }

    // 오케스트레이션 배정 — 지금 어느 경로가 어느 모델을 쓰는가(단가 비교의 상대편)
    const verByAgent = new Map<string, Record<string, unknown>>();
    for (const v of (verRes.data || [])) {
      const a = (agentRes.data || []).find((x) => x.agent_key === v.agent_key);
      if (a && a.current_version === v.version) verByAgent.set(v.agent_key, v);
    }
    const priceOf = (mid: string) => models.find((m) => m.model_id === mid) || null;

    return json({
      ok: true, as_of: nowIso,
      month: { start: dayKey(monthStart), today: dayKey(now) },
      keys: keyStatus(),
      vendors,
      models: models.map((m) => {
        // 질문 1건 환산 가정: 입력 6,000 · 출력 700 토큰, 입력의 40%는 캐시 적중(도구 정의·시스템 프롬프트가 매번 같다).
        //   토큰 계수(token_factor)는 토크나이저 세대 차이 보정 — Claude 4.7 이후는 같은 글을 약 1.3배로 센다.
        //   전부 **가정값**이므로 화면이 그대로 밝힐 수 있게 assume 을 함께 보낸다(CLAUDE.md §16.6).
        const f = Number(m.token_factor) || 1;
        const inTok = Q_IN_TOKENS * f, outTok = Q_OUT_TOKENS * f;
        const cacheIn = m.price_cache_in != null ? Number(m.price_cache_in) : Number(m.price_in) * 0.1;
        const per1 = (inTok * (1 - Q_CACHE_HIT) * Number(m.price_in)
                    + inTok * Q_CACHE_HIT * cacheIn
                    + outTok * Number(m.price_out)) / 1_000_000;
        return {
          ...m, vendor_key: String(m.vendor || "").toLowerCase(),
          // v14: callable 은 DB 값이 아니라 **지금 이 서버의 판정**을 보낸다(키를 넣으면 즉시 반영)
          callable: vendorCallable(String(m.vendor || "")),
          callable_db: m.callable,
          price_cache_in_eff: num2(cacheIn),
          per_1k_questions_usd: num2(per1 * 1000),
        };
      }),
      assume: { in_tokens: Q_IN_TOKENS, out_tokens: Q_OUT_TOKENS, cache_hit: Q_CACHE_HIT,
                note: "질문 1건 = 입력 " + Q_IN_TOKENS.toLocaleString() + " · 출력 " + Q_OUT_TOKENS +
                      " 토큰, 입력의 " + Math.round(Q_CACHE_HIT * 100) + "% 캐시 적중 가정 · 모델별 토큰 계수 반영" },
      orchestration: {
        gateway: {
          default_model: cfgRes.data?.default_model || null,
          vendor: cfgRes.data?.default_model ? guessVendor(String(cfgRes.data.default_model)) : null,
          max_tokens: cfgRes.data?.max_tokens ?? null,
          prompt_caching: cfgRes.data?.prompt_caching ?? null,
        },
        agents: (agentRes.data || []).map((a) => {
          const v = verByAgent.get(a.agent_key);
          const mid = v ? String(v.model_id) : null;
          const fb = v && v.fallback_model_id ? String(v.fallback_model_id) : null;
          const pm = mid ? priceOf(mid) : null;
          return {
            agent_key: a.agent_key, name_ko: a.name_ko, dept_nm: a.dept_nm, status: a.status,
            version: a.current_version, model_id: mid, model_vendor: mid ? guessVendor(mid) : null,
            model_callable: pm ? !!pm.callable : null,
            fallback_model_id: fb, fallback_vendor: fb ? guessVendor(fb) : null,
            effort: v ? (v.effort || null) : null,
            monthly_budget_usd: Number(a.monthly_budget_usd || 0), daily_limit: a.daily_limit,
          };
        }),
        routing: (ruleRes.data || []).map((r) => ({ ...r, vendor: guessVendor(String(r.model_id)) })),
      },
      internal_estimate_window: dayKey(estSince),
      errors: {
        budget: budRes.error?.message || null, models: modelRes.error?.message || null,
        chat_log: clRes.error?.message || null, agent_turn: atRes.error?.message || null,
      },
    });
  }

  // 2-i) v11: 조회 묶음 — 전체 응답과 부분 조회(scope)가 같은 쿼리를 쓰도록 한 곳에 둔다.
  //   dept_mapping: 사용자↔부서↔사원 매핑(ERP Z_USR_MAST_REC 대사). service_role은 RLS 우회 → 사내 전용 뷰 전량 조회.
  //   perm: 권한 설정 화면이 쓰는 것 전부(전체 관리자·페이지·부서 ERP 모듈·제안·카탈로그·개인 예외·감사).
  const qDeptMapping = () => Promise.all([
    admin.from("v_erp_user_dept").select("email,dept_nm,emp_nm,matched_dept_cd,dept_matched").order("dept_nm").order("emp_nm"),
    admin.from("v_erp_user_dept_recon").select("email,usr_nm_raw,dept_nm,emp_nm,status,recon_type").order("recon_type").order("dept_nm"),
    admin.from("v_erp_dept_roster").select("dept_nm,emp_cnt,dept_matched,members").order("emp_cnt", { ascending: false }),
  ]);
  const qPerm = () => Promise.all([
    admin.from("portal_admin").select("email,granted_by,granted_at").order("granted_at"),
    admin.from("portal_page").select("*").order("sort"),
    admin.from("dept_erp_scope").select("dept_nm,module_key"),
    admin.from("v_erp_dept_erp_suggest").select("dept_nm,module_key"),
    admin.from("perm_module_catalog").select("module_key,label,sensitive,sort").order("sort"),
    admin.rpc("perm_grant_list"),                                     // 개인 예외 권한(활성+회수 이력)
    admin.from("perm_audit").select("actor,action,target,detail,at").order("at", { ascending: false }).limit(100),
    // v12: 조직도 기반 권한(ADR-107) — 현행 조직 노드·페이지 공유 범위·부서 모듈(코드)
    admin.from("v_perm_org_node").select("dept_cd,dept_nm,par_dept_cd,lvl,path_cd,path_nm,sort_key,has_child,org_change_id,member_cnt,hr_cnt,is_cost").order("sort_key"),
    admin.from("portal_page_scope").select("page_key,dept_cd,include_sub,org_change_id,updated_by,updated_at"),
    admin.from("dept_module_scope").select("dept_cd,module_key,include_sub,org_change_id,updated_by,updated_at"),
  ]);
  // deno-lint-ignore no-explicit-any
  const buildDeptMapping = (udUsers: any, udRecon: any, udRoster: any) => ({
    counts: {
      users: (udUsers.data || []).length,
      recon: (udRecon.data || []).length,
      depts: (udRoster.data || []).length,
    },
    users: udUsers.data || [],   // 정상 매핑(재직·부서일치)
    recon: udRecon.data || [],   // 대사 불일치(자동제외·확인대상)
    roster: udRoster.data || [], // 부서별 사원 명부
    error: udUsers.error?.message || udRoster.error?.message || null,
  });
  // 모듈 카탈로그(SSOT: perm_module_catalog). sensitive=민감(급여·자금) — 콘솔에서 ⚠ 표시·일괄부여 제외.
  // deno-lint-ignore no-explicit-any
  const buildCatalog = (catalogRes: any) => (catalogRes.data || []).length
    ? (catalogRes.data as { module_key: string; label: string; sensitive: boolean }[])
        .map((c) => ({ key: c.module_key, label: c.label, sensitive: c.sensitive }))
    : CATALOG_FALLBACK;

  // 2-j) v11: 부분 조회 — 권한 화면(scope:'perm')·사용자부서 화면(scope:'dept').
  //   chat_log 2,000건·모델 설정·ERP 연동 현황은 읽지 않는다. 빈 바디/그 외 값은 아래 전체 응답으로.
  const scope = String((body as Record<string, unknown>).scope || "");
  if (scope === "perm" || scope === "dept") {
    const [udUsers, udRecon, udRoster] = await qDeptMapping();
    const dept_mapping = buildDeptMapping(udUsers, udRecon, udRoster);
    if (scope === "dept") {
      // 사용자·부서 화면의 「데이터 기준」 타일 — 계정 미러(usr_master) 마지막 성공 적재 시각
      const asof = await admin.from("v_erp_data_asof").select("job_name,last_success").eq("job_name", "usr_master").maybeSingle();
      return json({ dept_mapping, asof_usr_master: asof.data?.last_success || null, as_of: nowIso });
    }
    const [adminsRes, pagesRes, deptErpRes, deptErpSuggestRes, catalogRes, grantsRes, permAuditRes,
           orgRes, pageScopeRes, deptModRes] = await qPerm();
    return json({
      org_nodes: orgRes.data || [],
      page_scopes: pageScopeRes.data || [],
      dept_modules: deptModRes.data || [],
      org_error: orgRes.error?.message || pageScopeRes.error?.message || deptModRes.error?.message || null,
      admins: adminsRes.data || [],
      dept_mapping,
      portal_pages: pagesRes.data || [],
      dept_erp_scope: deptErpRes.data || [],
      dept_erp_suggest: deptErpSuggestRes.data || [],
      catalog: buildCatalog(catalogRes),
      perm_grants: grantsRes.data || [],
      perm_audit: permAuditRes.data || [],
      as_of: nowIso,
    });
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

  // 대화내역 규모 통계(건수만 — 원문은 절대 반환하지 않는다. 원문 열람은 본인 전용 jeil-chat-history뿐)
  // 4) 사용자↔부서↔사원 매핑 + 권한 묶음(v11: qDeptMapping/qPerm 공용) + 부서별 권한 설정(레거시) + 모델 설정
  const [[sessCntRes, msgCntRes], [udUsers, udRecon, udRoster],
         [adminsRes, pagesRes, deptErpRes, deptErpSuggestRes, catalogRes, grantsRes, permAuditRes],
         deptPerm, aiModelsRes, aiCfgRes, aiRulesRes] = await Promise.all([
    Promise.all([
      admin.from("chat_session").select("id", { count: "exact", head: true }).is("deleted_at", null),
      admin.from("chat_message").select("id", { count: "exact", head: true }),
    ]),
    qDeptMapping(),
    qPerm(),
    admin.from("dept_permission").select("dept_nm,dept_admin_email,erp_scope,page_visibility,note,updated_by,updated_at"),
    admin.from("ai_model").select("*").order("sort"),   // v14: tier·price_cache_in·context_k·token_factor·status_note 포함
    admin.from("ai_gateway_config").select("*").eq("id", 1).maybeSingle(),
    admin.from("ai_routing_rule").select("*").order("seq"),
  ]);
  const admins = adminsRes.data;

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
      // v13(REQ-0091): 벤더 키 4종 등록 현황 — **값은 담지 않는다**(등록 여부·길이·접두어 일치만, §1.8).
      //   외부 호출이 없어 전체 응답에 넣어도 느려지지 않는다. 실사용액은 action:'vendor_cost' 로 따로 조회.
      keys: keyStatus(),
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
    // 사용자↔부서↔사원 매핑(ERP 대사) — /admin/user-dept · /admin/permissions 기준 데이터
    dept_mapping: buildDeptMapping(udUsers, udRecon, udRoster),
    dept_permissions: deptPerm.data || [], // 저장된 부서별 권한 설정(레거시 — v11부터 편집 화면 없음, 0행)
    // 권한: 페이지 레지스트리 + 부서별 ERP 모듈 권한 + 모듈 카탈로그
    portal_pages: pagesRes.data || [],
    dept_erp_scope: deptErpRes.data || [],
    dept_erp_suggest: deptErpSuggestRes.data || [], // ERP 역할·메뉴 권한 기반 제안값(참고용)
    catalog: buildCatalog(catalogRes),
    // 개인 예외 권한(부서축으로 못 푸는 예외) + 권한 변경 감사
    perm_grants: grantsRes.data || [],
    perm_audit: permAuditRes.data || [],
    // ERP DB 연동 현황 — 어떤 ERP 테이블이 언제·얼마나 중간DB로 들어왔는지(연결 상태 확인용)
    erp_sync: { sources: erpSyncRes.data || [], error: erpSyncRes.error?.message || null },
    // 사용모델 설정 탭(모델 카탈로그·게이트웨이 설정·라우팅 규칙) — 실데이터
    model_settings: {
      // v14: callable 은 DB 값 대신 **지금 이 서버의 판정**(어댑터+키)으로 바꿔 보낸다 — 화면이 사실을 보게
      models: (aiModelsRes.data || []).map((m: Record<string, unknown>) => ({
        ...m, callable: vendorCallable(String(m.vendor || "")), callable_db: m.callable,
      })),
      config: aiCfg,
      routing: aiRulesRes.data || [],
      effective_model: effectiveModel,
      error: aiModelsRes.error?.message || aiCfgRes.error?.message || aiRulesRes.error?.message || null,
    },
    as_of: new Date().toISOString(),
  });
});
