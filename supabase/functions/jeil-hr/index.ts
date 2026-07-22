// jeil-hr — 인사 급여 '집계'(민감) 게이트 API. payroll 모듈 보유자만. 감사 로그 기록.
// v2(2026-07-22): 판정을 DB 통합 함수 perm_effective로 이관(부서 하드코딩 제거).
// 배포: verify_jwt=false (Entra access_token을 Graph로 재검증)
// 호출: POST /functions/v1/jeil-hr  Authorization: Bearer <Entra access_token(jeilax_auth.at)>
//   응답(허용): { allowed:true, dept, is_admin, payroll:[{ym,dept_nm,headcount,pay_tot_amt,retire_amt}], as_of }
//   비허용: 403 { allowed:false } — 인사팀/관리자 아님.
// 원칙(CLAUDE.md §1.7·§4·§6): 급여는 권한그룹(인사팀) 밖 노출 금지. erp_secure REST 비노출 →
//   service_role RPC(hr_payroll_get)로만 조회. 개인별·주민·계좌 미포함(집계만). 모든 접근 감사(hr_access_log).
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

  // 통합 판정(SSOT): payroll 모듈 보유 = 부서 권한(인사팀) 또는 개인 예외(기간 권한 포함) 또는 전체 관리자
  // v2(2026-07-22): 부서명 하드코딩(dept==='인사팀') 제거 → perm_effective로 통일. 콘솔 설정이 즉시 반영된다.
  const { data: eff, error: pe } = await admin.rpc("perm_effective", { p_upn: upn });
  if (pe || !eff) return json({ error: "권한 판정 실패: " + (pe?.message || "no data") }, 500);
  const e = eff as Record<string, unknown>;
  const dept: string | null = (e.dept_nm as string) ?? null;
  const is_admin = !!e.is_admin;
  const allowed = is_admin || (Array.isArray(e.erp_modules) && (e.erp_modules as string[]).includes("payroll"));

  // 감사 기록(허용/거부 모두)
  try { await admin.rpc("hr_access_log_add", { p_upn: upn, p_dept: dept, p_ok: allowed }); } catch { /* 무시 */ }

  if (!allowed) {
    return json({ allowed: false, error: "forbidden: 급여 데이터는 급여(payroll) 권한 보유자만 조회할 수 있습니다.", dept }, 403);
  }

  // 급여 집계(erp_secure) — service_role RPC로만 조회
  const { data: payroll, error } = await admin.rpc("hr_payroll_get");
  if (error) return json({ allowed: true, error: "급여 집계 조회 실패: " + error.message }, 500);

  return json({
    allowed: true, dept, is_admin,
    payroll: payroll || [],
    as_of: new Date().toISOString(),
    note: "인사 급여 집계(총액·인원). 개인별·주민번호·계좌 미포함.",
  });
});
