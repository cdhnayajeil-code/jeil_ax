// jeil-chat-admin — 챗봇 관리자 콘솔 실데이터 API (사용량·권한·게이트웨이 상태·사용자부서 매핑)
// 배포: verify_jwt=false (Entra 토큰을 내부에서 Graph로 검증)
// 호출: POST /functions/v1/jeil-chat-admin  Authorization: Bearer <Entra access_token>
//   조회(빈 바디): { gateway, usage, admins, dept_mapping, dept_permissions } — 관리자(portal_admin)만
//   저장(바디 {action:'save_dept_perm', rows:[...]}): 부서별 권한 설정 upsert(관리자만) → { ok, saved }
// 원칙: chat_log·erp 매핑 뷰는 RLS로 클라이언트 차단 → 이 함수(service_role)가 유일한 조회/저장 경로.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

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

  // 2-b) 저장 액션 — 부서별 권한 설정 upsert(관리자만). 부서명 기준은 ERP 매핑(v_erp_dept_roster).
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  if (body && (body as Record<string, unknown>).action === "save_dept_perm") {
    const rowsIn = Array.isArray((body as Record<string, unknown>).rows) ? (body as Record<string, unknown>).rows as Record<string, unknown>[] : [];
    const nowIso = new Date().toISOString();
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

  // 4) 사용자↔부서↔사원 매핑(ERP Z_USR_MAST_REC 대사) + 부서별 권한 설정
  //    service_role은 RLS 우회 → 사내 전용 뷰 전량 조회. 부서명 기준으로 권한 설정과 결합.
  const [udUsers, udRecon, udRoster, deptPerm] = await Promise.all([
    admin.from("v_erp_user_dept").select("email,dept_nm,emp_nm,matched_dept_cd,dept_matched").order("dept_nm").order("emp_nm"),
    admin.from("v_erp_user_dept_recon").select("email,usr_nm_raw,dept_nm,emp_nm,status,recon_type").order("recon_type").order("dept_nm"),
    admin.from("v_erp_dept_roster").select("dept_nm,emp_cnt,dept_matched,members").order("emp_cnt", { ascending: false }),
    admin.from("dept_permission").select("dept_nm,dept_admin_email,erp_scope,page_visibility,note,updated_by,updated_at"),
  ]);

  return json({
    gateway: {
      function: "jeil-chat",
      model: Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini",
      provider: "OpenAI",
      key_set: !!Deno.env.get("OPENAI_API_KEY"),
      auth_policy: "Entra 토큰 Graph 검증 · @jeilm.co.kr 사내 한정",
      limits: { max_messages: 20, max_total_chars: 24000, max_tokens: 1024 },
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
      by_user: Object.entries(byUser)
        .map(([upn, v]) => ({ upn, ...v, cost: Number(v.cost.toFixed(4)) }))
        .sort((a, b) => b.calls - a.calls)
        .slice(0, 20),
      recent: rows.slice(0, 20),
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
    as_of: new Date().toISOString(),
  });
});
