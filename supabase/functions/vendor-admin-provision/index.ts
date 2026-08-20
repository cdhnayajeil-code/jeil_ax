// vendor-admin-provision — 협력사 포털 "통합 관리자 계정"(role=vendor_admin) 발급·관리 (service_role)
// 배포: verify_jwt=false (내부에서 관리자 JWT 검증)
// 호출: POST /functions/v1/vendor-admin-provision  Authorization: Bearer <사내 관리자 access_token>
//   body: { action?: "create"|"disable"|"enable"|"delete", email?, display_name?, phone?, auth_user_id?, force? }
//   응답(create): { ok, email, temp_password, converted }
//   409 + code:"email_exists": 이미 그 이메일로 Supabase Auth 계정이 있다(협력사 계정 등).
//        어떤 계정인지 existing{kind,bp_cd,bp_nm}로 알려주고, 관리자가 확인 후 force:true로
//        다시 호출하면 기존 계정을 관리자 계정으로 전환한다(거래처 소속 해제 + 새 임시비번).
//
// 이 계정은 특정 거래처(bp_cd)에 묶이지 않고 전 거래처를 "읽기 전용"으로 조회한다.
// 쓰기 RLS 정책은 부여하지 않으므로(마이그레이션 vendor_portal_admin_readonly),
// 상태변경·사진등록·메시지 발송은 DB 레벨에서 차단된다.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

// 초기 비밀번호(고정, 2026-08-20 정책) — 최초 로그인 시 새 비밀번호 설정을 강제한다.
const INIT_PW = "jeilmns";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") || "";

  // 관리자 검증: 사내 도메인 + portal_admin 등재자
  const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: uerr } = await userClient.auth.getUser();
  if (uerr || !user) return json({ error: "unauthorized" }, 401);
  if (!(user.email || "").toLowerCase().endsWith("@jeilm.co.kr"))
    return json({ error: "forbidden: internal only" }, 403);

  const admin = createClient(url, service);
  const { data: pa } = await admin.from("portal_admin").select("email").eq("email", user.email).maybeSingle();
  if (!pa) return json({ error: "forbidden: vendor-admin only" }, 403);

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const action = (body.action || "create").toLowerCase();
  const actorName = (user.user_metadata as Record<string, string>)?.name ?? null;
  const logIt = (act: string, target: string | null, detail: Record<string, unknown> = {}) =>
    admin.from("vendor_account_log").insert({
      action: act, target_email: target, bp_cd: null,
      actor_email: user.email, actor_name: actorName, detail,
    });

  /* ── 이메일로 기존 auth 사용자 찾기(발급 실패 원인 판별용) ── */
  async function findAuthUserByEmail(email: string) {
    for (let page = 1; page <= 5; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) return null;
      const hit = (data?.users || []).find((u) => (u.email || "").toLowerCase() === email);
      if (hit) return hit;
      if (!data?.users?.length || data.users.length < 1000) return null;
    }
    return null;
  }

  /* ── 발급 ── */
  if (action === "create") {
    const email = (body.email || "").trim().toLowerCase();
    const display_name = (body.display_name || "").trim() || null;
    const phone = (body.phone || "").trim() || null;
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "email required" }, 400);
    // 사내 이메일 금지: 같은 주소로 Entra SSO 계정이 생기면 app_metadata.role이 vendor_admin으로
    // 고정돼 사내 권한(role=internal)을 잃는다. 사내 직원은 SSO 세션 그대로 포털에 들어가면 된다.
    if (email.endsWith("@jeilm.co.kr"))
      return json({ error: "사내(@jeilm.co.kr) 이메일은 Entra SSO 계정과 충돌하므로 발급할 수 없습니다. 사내 직원은 SSO 로그인 상태로 협력사 포털에 접속하면 동일한 전체 조회 화면이 열립니다." }, 400);

    const pw = INIT_PW;
    const force = String(body.force ?? "") === "true" || (body as unknown as { force?: boolean }).force === true;
    let userId = "";
    let converted: Record<string, unknown> | null = null;

    const { data: created, error: ce } = await admin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
      app_metadata: { role: "vendor_admin", vendor_bp: [], must_change_password: true },
      user_metadata: { display_name, phone, vendor_admin: true },
    });

    if (ce || !created?.user) {
      const already = /already.*registered|email_exists/i.test(ce?.message ?? "");
      if (!already) return json({ error: "계정 생성 실패: " + (ce?.message ?? "unknown") }, 400);

      // 이미 이 이메일로 Supabase Auth 사용자가 있다. 무엇으로 쓰이는 계정인지 밝혀 알려준다.
      const [{ data: vacc }, { data: vadm }] = await Promise.all([
        admin.from("vendor_account").select("bp_cd,email").eq("email", email).maybeSingle(),
        admin.from("vendor_admin_account").select("email").eq("email", email).maybeSingle(),
      ]);
      let bp_nm: string | null = null;
      if (vacc?.bp_cd) {
        const { data: vm } = await admin.from("vendor_master").select("bp_nm").eq("bp_cd", vacc.bp_cd).maybeSingle();
        bp_nm = vm?.bp_nm ?? null;
      }
      const kind = vadm ? "vendor_admin" : vacc ? "vendor" : "other";
      const existing = { kind, email, bp_cd: vacc?.bp_cd ?? null, bp_nm };

      if (kind === "vendor_admin")
        return json({ error: "이미 이 이메일로 협력사 포털 관리자 계정이 발급돼 있습니다. 아래 목록에서 비밀번호를 초기화해 사용하세요.", code: "email_exists", existing }, 409);

      if (!force)
        return json({
          error: kind === "vendor"
            ? `이미 등록된 이메일입니다 — 현재 협력사 계정(거래처 ${vacc?.bp_cd}${bp_nm ? " " + bp_nm : ""})으로 사용 중입니다.`
            : "이미 등록된 이메일입니다(다른 용도의 계정).",
          code: "email_exists", existing,
        }, 409);

      // force=true: 관리자가 확인 후 전환을 선택했다 — 기존 계정을 관리자 계정으로 승격한다.
      const found = await findAuthUserByEmail(email);
      if (!found?.id) return json({ error: "기존 계정을 찾지 못했습니다. Supabase Auth에서 직접 확인하세요." }, 400);
      const { error: ue } = await admin.auth.admin.updateUserById(found.id, {
        password: pw,
        email_confirm: true,
        ban_duration: "none",
        app_metadata: { role: "vendor_admin", vendor_bp: [], must_change_password: true },
        user_metadata: { ...(found.user_metadata ?? {}), display_name, phone, vendor_admin: true },
      });
      if (ue) return json({ error: "계정 전환 실패: " + ue.message }, 400);
      userId = found.id;
      converted = { from: kind, bp_cd: vacc?.bp_cd ?? null, bp_nm };
      // 거래처 계정 대장에서는 제거 — 이 계정은 더 이상 특정 거래처 소속이 아니다(그리드는 다시 '미발급').
      if (vacc?.bp_cd) await admin.from("vendor_account").delete().eq("email", email);
    } else {
      userId = created.user.id;
    }

    const { error: ae } = await admin.from("vendor_admin_account").upsert({
      email, auth_user_id: userId, display_name, phone,
      status: "active", created_by: user.email, must_change_pw: true,
    }, { onConflict: "email" });
    if (ae) return json({ error: "vendor_admin_account save failed: " + ae.message }, 500);

    await logIt(converted ? "convert_admin" : "create_admin", email, { display_name, ...(converted ?? {}) });
    return json({ ok: true, email, temp_password: pw, init_password: pw, must_change: true, converted });
  }

  /* ── 대상 계정 조회(비활성/활성/삭제 공통) ── */
  const key = body.auth_user_id
    ? { col: "auth_user_id", val: body.auth_user_id }
    : { col: "email", val: (body.email || "").trim().toLowerCase() };
  if (!key.val) return json({ error: "auth_user_id or email required" }, 400);
  const { data: acc } = await admin.from("vendor_admin_account")
    .select("email,auth_user_id,status").eq(key.col, key.val).maybeSingle();
  if (!acc?.auth_user_id) return json({ error: "vendor admin account not found" }, 404);

  if (action === "disable" || action === "enable") {
    const disable = action === "disable";
    // ban_duration: 로그인 자체를 차단(토큰 발급 불가). 해제는 'none'.
    const { error: be } = await admin.auth.admin.updateUserById(acc.auth_user_id, {
      ban_duration: disable ? "876000h" : "none",
    });
    if (be) return json({ error: (disable ? "비활성" : "활성") + " 실패: " + be.message }, 500);
    await admin.from("vendor_admin_account")
      .update({ status: disable ? "disabled" : "active" }).eq("auth_user_id", acc.auth_user_id);
    await logIt(disable ? "disable_admin" : "enable_admin", acc.email);
    return json({ ok: true, email: acc.email, status: disable ? "disabled" : "active" });
  }

  if (action === "delete") {
    const { error: de } = await admin.auth.admin.deleteUser(acc.auth_user_id);
    if (de) return json({ error: "삭제 실패: " + de.message }, 500);
    await admin.from("vendor_admin_account").delete().eq("auth_user_id", acc.auth_user_id);
    await logIt("delete_admin", acc.email);
    return json({ ok: true, email: acc.email });
  }

  return json({ error: "unknown action: " + action }, 400);
});
