// approve-vendor — 관리자 협력사 가입 승인/거부 (service_role 서버측 처리)
// 배포: supabase-jeilax MCP deploy_edge_function (verify_jwt=false, 내부에서 JWT 검증)
// 호출: POST /functions/v1/approve-vendor  Authorization: Bearer <관리자 access_token>
//   body: { application_id, action: "approve"|"reject", matched_bp_cd?, note? }
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") || "";

  // 호출자(관리자) 검증 — role=internal 만 허용
  const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: uerr } = await userClient.auth.getUser();
  if (uerr || !user) return json({ error: "unauthorized" }, 401);
  if ((user.app_metadata as Record<string, unknown>)?.role !== "internal")
    return json({ error: "forbidden: admin only" }, 403);

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const { application_id, action, matched_bp_cd, note } = body;
  if (!application_id || !action) return json({ error: "application_id, action required" }, 400);

  const admin = createClient(url, service);
  const { data: app, error: aerr } = await admin.from("vendor_application").select("*").eq("id", application_id).single();
  if (aerr || !app) return json({ error: "application not found" }, 404);

  if (action === "approve") {
    if (!matched_bp_cd) return json({ error: "matched_bp_cd required" }, 400);
    const { data: vm } = await admin.from("vendor_master").select("bp_cd").eq("bp_cd", matched_bp_cd).single();
    if (!vm) return json({ error: "unknown bp_cd" }, 400);
    if (app.auth_user_id) {
      const { error: e } = await admin.auth.admin.updateUserById(app.auth_user_id, {
        app_metadata: { role: "vendor", vendor_bp: [matched_bp_cd] },
      });
      if (e) return json({ error: "updateUser failed: " + e.message }, 500);
    }
    await admin.from("vendor_application").update({
      status: "approved", matched_bp_cd, reviewed_by: user.email,
      reviewed_at: new Date().toISOString(), review_note: note ?? null,
    }).eq("id", application_id);
    return json({ ok: true, status: "approved", bp_cd: matched_bp_cd });
  }
  if (action === "reject") {
    await admin.from("vendor_application").update({
      status: "rejected", reviewed_by: user.email,
      reviewed_at: new Date().toISOString(), review_note: note ?? null,
    }).eq("id", application_id);
    return json({ ok: true, status: "rejected" });
  }
  return json({ error: "invalid action" }, 400);
});
