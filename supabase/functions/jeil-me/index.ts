// jeil-me — 로그인 사용자의 신원·역할·부서·페이지/ERP 권한 판정 (사내 전 직원)
// 배포: verify_jwt=false (Entra access_token을 Graph로 재검증 — 위조 불가)
// 호출: POST /functions/v1/jeil-me  Authorization: Bearer <Entra access_token(jeilax_auth.at)>
//   응답: { upn, name, dept_nm, depts[], role, is_admin, dept_admin_of, erp_modules, grants[], pages[], catalog[] }
// v2(2026-07-22): 판정 로직을 DB 단일 함수 public.perm_effective(upn)로 이관 — 부서축 CORE + 개인 예외(perm_grant).
//   이 함수는 더 이상 자체 판정을 하지 않는다(판정 중복 제거). 카탈로그도 DB(perm_module_catalog)가 SSOT.
// 원칙(CLAUDE.md §5.4): 권한 판정은 서버에서. 포털 카드·페이지 게이트는 이 결과를 강제한다.
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

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized: MS 로그인 토큰이 필요합니다." }, 401);
  const user = await verifyEntraUser(token);
  if (!user) return json({ error: "unauthorized: 사내 계정 인증 실패" }, 401);
  const upn = user.upn;

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 통합 판정(SSOT) — 부서축 + 개인 예외 + 기간 만료까지 DB에서 계산
  const [{ data: eff, error: pe }, { data: cat }] = await Promise.all([
    admin.rpc("perm_effective", { p_upn: upn }),
    admin.from("perm_module_catalog").select("module_key,label,sensitive").order("sort"),
  ]);
  if (pe || !eff) return json({ error: "권한 판정 실패: " + (pe?.message || "no data") }, 500);

  const e = eff as Record<string, unknown>;
  return json({
    upn,
    name: (e.emp_nm as string) || upn.split("@")[0],
    emp_nm: e.emp_nm ?? null,
    dept_nm: e.dept_nm ?? null,
    depts: e.depts ?? [],                 // 소속 + 개인 dept 예외(겸직·대행)
    role: e.role,
    is_admin: e.is_admin,
    is_auditor: e.is_auditor,
    dept_admin_of: e.dept_admin_of ?? [],
    erp_modules: e.erp_modules ?? [],
    grants: e.grants ?? [],               // 본인에게 적용 중인 개인 예외(투명성)
    pages: e.pages ?? [],                 // { page_key, title, path, allowed, reason }
    catalog: (cat || []).map((c: { module_key: string; label: string; sensitive: boolean }) =>
      ({ key: c.module_key, label: c.label, sensitive: c.sensitive })),
    as_of: e.as_of ?? new Date().toISOString(),
  });
});
