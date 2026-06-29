// vendor-reset-password — 관리자 협력사 비밀번호 초기화 (service_role)
// 배포: verify_jwt=false (내부에서 관리자 JWT 검증)
// 호출: POST /functions/v1/vendor-reset-password  Authorization: Bearer <관리자 access_token>
//   body: { auth_user_id? , email? }  (둘 중 하나)
//   응답: { ok, email, temp_password }
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

function tempPassword(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "");
  return "Jm" + b64.slice(0, 10) + "7!";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") || "";

  const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: uerr } = await userClient.auth.getUser();
  if (uerr || !user) return json({ error: "unauthorized" }, 401);
  if ((user.app_metadata as Record<string, unknown>)?.role !== "internal")
    return json({ error: "forbidden: internal only" }, 403);

  const admin = createClient(url, service);
  const { data: pa } = await admin.from("portal_admin").select("email").eq("email", user.email).maybeSingle();
  if (!pa) return json({ error: "forbidden: vendor-admin only" }, 403);

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const { auth_user_id, email } = body;

  // 대상 계정 확정
  let acc: { auth_user_id: string; email: string; bp_cd: string } | null = null;
  if (auth_user_id) {
    const { data } = await admin.from("vendor_account").select("auth_user_id,email,bp_cd").eq("auth_user_id", auth_user_id).maybeSingle();
    acc = data;
  } else if (email) {
    const { data } = await admin.from("vendor_account").select("auth_user_id,email,bp_cd").eq("email", email).maybeSingle();
    acc = data;
  }
  if (!acc?.auth_user_id) return json({ error: "vendor account not found" }, 404);

  const pw = tempPassword();
  const { error: ue } = await admin.auth.admin.updateUserById(acc.auth_user_id, { password: pw });
  if (ue) return json({ error: "reset failed: " + ue.message }, 500);

  await admin.from("vendor_account").update({ last_reset_at: new Date().toISOString() }).eq("auth_user_id", acc.auth_user_id);
  await admin.from("vendor_account_log").insert({
    action: "reset_password", target_email: acc.email, bp_cd: acc.bp_cd,
    actor_email: user.email,
    actor_name: (user.user_metadata as Record<string, string>)?.name ?? null,
  });

  return json({ ok: true, email: acc.email, temp_password: pw });
});
