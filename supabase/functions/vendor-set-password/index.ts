// vendor-set-password — 본인 비밀번호 설정 + 강제변경 플래그 해제 (service_role)
// 배포: verify_jwt=false (내부에서 사용자 JWT 검증)
// 호출: POST /functions/v1/vendor-set-password  Authorization: Bearer <본인 access_token>
//   body: { new_password }
//   응답: { ok, email }
//
// 비밀번호 정책(2026-08-20): 발급·초기화 시 비밀번호는 고정 초기값 'jeilmns'이고
// app_metadata.must_change_password = true 가 걸린다. 이 플래그는 사용자가 직접 지울 수 없고
// 이 함수로 "실제 비밀번호를 바꿔야만" 해제된다(초기비번 방치 차단).
import { createClient } from "jsr:@supabase/supabase-js@2";

const INIT_PW = "jeilmns";
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

  const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: uerr } = await userClient.auth.getUser();
  if (uerr || !user) return json({ error: "로그인이 필요합니다." }, 401);

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const pw = String(body.new_password ?? "");
  if (pw.length < 8) return json({ error: "비밀번호는 8자 이상이어야 합니다." }, 400);
  if (pw.toLowerCase() === INIT_PW) return json({ error: "초기 비밀번호와 다른 값으로 설정해야 합니다." }, 400);

  const admin = createClient(url, service);
  const email = (user.email || "").toLowerCase();

  // 대상은 협력사 계정 또는 협력사 포털 관리자 계정만(사내 SSO 계정은 Entra에서 관리).
  const [{ data: vacc }, { data: vadm }] = await Promise.all([
    admin.from("vendor_account").select("email,bp_cd").eq("email", email).maybeSingle(),
    admin.from("vendor_admin_account").select("email").eq("email", email).maybeSingle(),
  ]);
  if (!vacc && !vadm) return json({ error: "이 계정은 포털에서 비밀번호를 변경할 수 없습니다(사내 계정은 Microsoft 계정에서 변경)." }, 403);

  const meta = (user.app_metadata ?? {}) as Record<string, unknown>;
  const { error: ue } = await admin.auth.admin.updateUserById(user.id, {
    password: pw,
    app_metadata: { ...meta, must_change_password: false },
  });
  if (ue) return json({ error: "비밀번호 변경 실패: " + ue.message }, 400);

  if (vacc) await admin.from("vendor_account").update({ must_change_pw: false }).eq("email", email);
  if (vadm) await admin.from("vendor_admin_account").update({ must_change_pw: false }).eq("email", email);

  await admin.from("vendor_account_log").insert({
    action: "set_password", target_email: email, bp_cd: vacc?.bp_cd ?? null,
    actor_email: email, actor_name: (user.user_metadata as Record<string, string>)?.contact_name ?? null,
    detail: { by: "self" },
  });

  return json({ ok: true, email });
});
