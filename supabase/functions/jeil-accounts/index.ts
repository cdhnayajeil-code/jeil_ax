// jeil-accounts — 계정 통합관리·대사 조회 API (REQ-0018)
// 배포: verify_jwt=false (Entra 토큰을 내부에서 Graph로 검증)
// 호출: POST /functions/v1/jeil-accounts  Authorization: Bearer <Entra access_token>
//   { scope: 'summary' | 'recon' | 'erp' | 'hr' | 'gw' | 'ms', q?: string } → { ok, scope, data }
//
// 정본은 ERP 계정(Z_USR_MAST_REC.usr_id = 이메일)이고 인사(HAA010T)는 이메일로 붙는 서브다.
// 조회는 반드시 RPC account_recon_get 경유 — erp_ro 는 REST 비노출 스키마라
// supabase-js 로 테이블/뷰를 직접 읽으면 service_role 이어도 '오류 없이 빈 결과'가 돌아온다
// (REQ-0015 에서 실제로 당한 함정이라 이 함수는 from() 을 쓰지 않는다).
//
// 읽기 전용이다. 계정 생성·삭제·비밀번호 변경은 이 함수의 일이 아니다.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SCOPES = ["summary", "recon", "erp", "hr", "gw", "ms"];

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
  if (!SCOPES.includes(scope)) return json({ error: "허용되지 않은 scope: " + scope }, 400);
  const q = body.q ? String(body.q).slice(0, 100) : null;

  const { data, error } = await admin.rpc("account_recon_get", { p_scope: scope, p_q: q });
  if (error) return json({ error: "계정 조회 실패: " + error.message }, 500);

  return json({ ok: true, scope, data, viewer: user.upn });
});
