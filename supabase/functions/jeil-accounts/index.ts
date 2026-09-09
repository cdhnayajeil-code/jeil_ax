// jeil-accounts — 계정 통합관리·대사 조회 API (REQ-0018)
// 배포: verify_jwt=false (Entra 토큰을 내부에서 Graph로 검증)
// 호출: POST /functions/v1/jeil-accounts  Authorization: Bearer <Entra access_token>
//   { scope: 'summary' | 'recon' | 'erp' | 'hr' | 'gw' | 'ms', q?: string } → { ok, scope, data }
//   { scope: 'search', q: string }                                        → 사원 검색(퇴사 처리 대상)
//   { scope: 'offboard_create', emails, mode, axes?, retireDt? }           → 퇴사 처리 요청 등록
//   { scope: 'offboard_status', requestId: string }                       → 요청 진행 상태
//   { scope: 'refresh' }                                                  → 계정·권한 전량 재수집 요청
//   { scope: 'refresh_status', requestId: string }                        → 재수집 진행 상태
//
// 정본은 ERP 계정(Z_USR_MAST_REC.usr_id = 이메일)이고 인사(HAA010T)는 이메일로 붙는 서브다.
// 조회는 반드시 RPC account_recon_get 경유 — erp_ro 는 REST 비노출 스키마라
// supabase-js 로 테이블/뷰를 직접 읽으면 service_role 이어도 '오류 없이 빈 결과'가 돌아온다
// (REQ-0015 에서 실제로 당한 함정이라 이 함수는 from() 을 쓰지 않는다).
//
// 조회는 읽기 전용이다. 계정 생성·삭제·비밀번호 변경은 이 함수의 일이 아니다.
// 예외는 퇴사 처리 **요청 등록**뿐인데, 이것도 계정을 직접 건드리지 않는다 —
// 큐에 한 줄 넣을 뿐이고 실제 처리는 그룹웨어에 붙을 수 있는 호스트의 러너가 한다.
// 대상 정보(이름·로그인ID·퇴사일)는 화면 값을 쓰지 않고 DB(v_account_recon)가 만든다.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SCOPES = ["summary", "recon", "erp", "hr", "gw", "ms"];
const ACTIONS = ["offboard_create", "offboard_status", "search", "refresh", "refresh_status"];

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

  // 1) 사내 사용자 검증 (Graph /me 재검증 — 프론트 토큰을 그대로 믿지 않는다)
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized: MS 로그인 토큰이 필요합니다." }, 401);
  const user = await verifyEntraUser(token);
  if (!user) return json({ error: "unauthorized: 사내 계정 인증 실패" }, 401);

  // 2) 관리자 검증 — 계정 명부는 전 직원의 소속·재직 정보라 관리자만 본다
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: pa } = await admin.from("portal_admin").select("email").eq("email", user.upn).maybeSingle();
  if (!pa) return json({ error: "forbidden: 관리자 전용" }, 403);

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const scope = String(body.scope || "recon");

  // ── 퇴사 처리 요청/상태 ──────────────────────────────────────────────
  if (ACTIONS.includes(scope)) {
    if (scope === "search") {
      const q = String(body.q || "").trim().slice(0, 60);
      if (q.length < 2) return json({ error: "두 글자 이상 입력하세요" }, 400);
      const { data, error } = await admin.rpc("offboard_search", { p_q: q, p_limit: 30 });
      if (error) return json({ error: "검색 실패: " + error.message }, 500);
      return json({ ok: true, scope, data, viewer: user.upn });
    }
    if (scope === "offboard_create") {
      const emails = Array.isArray(body.emails) ? body.emails.map((e) => String(e)).slice(0, 50) : [];
      const mode = String(body.mode || "check") === "apply" ? "apply" : "check";
      // 축은 화이트리스트로 거른다 — 화면이 무엇을 보내든 허용된 셋만 통과한다.
      const axes = (Array.isArray(body.axes) ? body.axes.map((a) => String(a)) : ["gw"])
        .filter((a) => ["erp", "gw", "ms"].includes(a));
      const rd = /^\d{4}-\d{2}-\d{2}$/.test(String(body.retireDt || "")) ? String(body.retireDt) : null;
      if (!emails.length) return json({ error: "대상이 없습니다" }, 400);
      if (!axes.length) return json({ error: "처리할 축을 하나 이상 고르세요" }, 400);
      const { data, error } = await admin.rpc("offboard_request_create", {
        p_emails: emails, p_mode: mode, p_requested_by: user.upn,
        p_axes: axes, p_retire_dt: rd,
      });
      if (error) return json({ error: "요청 등록 실패: " + error.message }, 500);
      return json({ ok: true, scope, data, viewer: user.upn });
    }
    // 계정·권한 전량 재수집 — MS(라이선스 포함)·그룹웨어만. ERP 배치는 부르지 않는다.
    // 화면이 대사를 보기 전에 최신 상태로 맞출 수 있어야, 이미 처리된 축을 또 건드리지 않는다.
    if (scope === "refresh") {
      const { data, error } = await admin.rpc("offboard_refresh_accounts", { p_requested_by: user.upn });
      if (error) return json({ error: "갱신 요청 실패: " + error.message }, 500);
      return json({ ok: true, scope, data, viewer: user.upn });
    }
    const rid = String(body.requestId || "");
    if (!/^[0-9a-f-]{36}$/i.test(rid)) return json({ error: "requestId 형식 오류" }, 400);
    if (scope === "refresh_status") {
      const { data, error } = await admin.rpc("offboard_refresh_status", { p_request_id: rid });
      if (error) return json({ error: "상태 조회 실패: " + error.message }, 500);
      return json({ ok: true, scope, data, viewer: user.upn });
    }
    const { data, error } = await admin.rpc("offboard_request_status", { p_request_id: rid });
    if (error) return json({ error: "상태 조회 실패: " + error.message }, 500);
    return json({ ok: true, scope, data, viewer: user.upn });
  }

  if (!SCOPES.includes(scope)) return json({ error: "허용되지 않은 scope: " + scope }, 400);
  const q = body.q ? String(body.q).slice(0, 100) : null;

  const { data, error } = await admin.rpc("account_recon_get", { p_scope: scope, p_q: q });
  if (error) return json({ error: "계정 조회 실패: " + error.message }, 500);

  return json({ ok: true, scope, data, viewer: user.upn });
});
