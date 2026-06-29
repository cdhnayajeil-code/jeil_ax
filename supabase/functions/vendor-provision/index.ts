// vendor-provision — 관리자 주도 협력사 계정 발급 (service_role)
// 배포: verify_jwt=false (내부에서 관리자 JWT 검증)
// 호출: POST /functions/v1/vendor-provision  Authorization: Bearer <관리자 access_token>
//   body: { bp_cd, email, contact_name?, phone? }
//   응답: { ok, email, temp_password, bp_nm }
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

// 임시 비밀번호(영대소문자+숫자+특수 포함, 14자 내외)
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

  // 관리자 검증: role=internal + portal_admin 등록자
  const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: uerr } = await userClient.auth.getUser();
  if (uerr || !user) return json({ error: "unauthorized" }, 401);
  // role은 Hook이 JWT에만 주입 → getUser()의 app_metadata엔 없음. 이메일+portal_admin으로 판정.
  if (!(user.email || "").toLowerCase().endsWith("@jeilm.co.kr"))
    return json({ error: "forbidden: internal only" }, 403);

  const admin = createClient(url, service);
  const { data: pa } = await admin.from("portal_admin").select("email").eq("email", user.email).maybeSingle();
  if (!pa) return json({ error: "forbidden: vendor-admin only" }, 403);

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const { bp_cd, email, contact_name, phone } = body;
  if (!bp_cd || !email) return json({ error: "bp_cd, email required" }, 400);

  const { data: vm } = await admin.from("vendor_master").select("bp_cd,bp_nm").eq("bp_cd", bp_cd).single();
  if (!vm) return json({ error: "unknown bp_cd" }, 400);

  const pw = tempPassword();
  const { data: created, error: ce } = await admin.auth.admin.createUser({
    email,
    password: pw,
    email_confirm: true,
    app_metadata: { role: "vendor", vendor_bp: [bp_cd] },
    user_metadata: { contact_name: contact_name ?? null, phone: phone ?? null, bp_cd },
  });
  if (ce || !created?.user) return json({ error: "createUser failed: " + (ce?.message ?? "unknown") }, 400);

  const { error: ae } = await admin.from("vendor_account").upsert({
    bp_cd, email, auth_user_id: created.user.id,
    contact_name: contact_name ?? null, phone: phone ?? null,
    status: "active", created_by: user.email,
  }, { onConflict: "email" });
  if (ae) return json({ error: "vendor_account save failed: " + ae.message }, 500);

  await admin.from("vendor_account_log").insert({
    action: "create", target_email: email, bp_cd,
    actor_email: user.email,
    actor_name: (user.user_metadata as Record<string, string>)?.name ?? null,
  });

  return json({ ok: true, email, temp_password: pw, bp_nm: vm.bp_nm });
});
