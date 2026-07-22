// jeil-me — 로그인 사용자의 신원·역할·부서·페이지/ERP 권한 판정 (사내 전 직원)
// 배포: verify_jwt=false (Entra access_token을 Graph로 재검증 — 위조 불가)
// 호출: POST /functions/v1/jeil-me  Authorization: Bearer <Entra access_token(jeilax_auth.at)>
//   응답: { upn, name, dept_nm, role, is_admin, dept_admin_of, erp_modules, pages[], catalog[] }
// 원칙(CLAUDE.md §5.4): 권한 판정은 서버에서. 포털 카드·페이지 게이트는 이 결과를 강제한다.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ERP 데이터 모듈 카탈로그 — public.v_erp_* 노출 뷰와 1:1 (+ payroll=민감, 인사팀/관리자)
const CATALOG = [
  { key: "sales", label: "매출" },
  { key: "purchase", label: "매입" },
  { key: "inventory", label: "재고" },
  { key: "item", label: "품목" },
  { key: "pur_order", label: "발주" },
  { key: "user_dept", label: "사용자·부서" },
  { key: "payroll", label: "급여" }, // 민감 — 인사팀 dept_erp_scope 또는 관리자(is_admin)만
  { key: "finance", label: "자금·회계" }, // 민감 — 자금·회계 부서만(자금 대시보드 게이트, erp_finance_overview RPC 강제)
];

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

  // 신원·역할·부서
  const [udRes, paRes, daRes] = await Promise.all([
    admin.from("v_erp_user_dept").select("dept_nm,emp_nm").eq("email", upn).maybeSingle(),
    admin.from("portal_admin").select("email").eq("email", upn).maybeSingle(),
    admin.from("dept_permission").select("dept_nm").eq("dept_admin_email", upn),
  ]);
  const dept_nm: string | null = udRes.data?.dept_nm ?? null;
  const emp_nm: string | null = udRes.data?.emp_nm ?? null;
  const is_admin = !!paRes.data;
  const dept_admin_of: string[] = (daRes.data || []).map((r: { dept_nm: string }) => r.dept_nm);
  const role = is_admin ? "admin" : (dept_admin_of.length ? "dept_admin" : "user");

  // 허용 ERP 모듈
  let erp_modules: string[];
  if (is_admin) {
    erp_modules = CATALOG.map((c) => c.key);
  } else {
    const { data: es } = await admin.from("dept_erp_scope").select("module_key").eq("dept_nm", dept_nm || "");
    erp_modules = (es || []).map((r: { module_key: string }) => r.module_key);
  }
  const modSet = new Set(erp_modules);
  const deptAdminSet = new Set(dept_admin_of);

  // 페이지 접근 판정
  const { data: pageRows } = await admin.from("portal_page").select("*").eq("active", true).order("sort");
  const pages = (pageRows || []).map((p: Record<string, unknown>) => {
    const vis = String(p.visibility || "");
    const owner = (p.dept_nm as string) || "";
    const shared: string[] = (p.shared_depts as string[]) || [];
    let allowed: boolean;
    if (is_admin) {
      allowed = true;
    } else if (vis === "전사 공개") {
      allowed = true;
    } else if (vis === "부서 전용") {
      allowed = (!!dept_nm && dept_nm === owner) || deptAdminSet.has(owner);
    } else if (vis === "지정 부서 공유") {
      allowed = (!!dept_nm && (dept_nm === owner || shared.includes(dept_nm))) || deptAdminSet.has(owner);
    } else {
      allowed = false;
    }
    // ERP 모듈 강제(해당 페이지가 ERP 데이터면 부서 모듈 권한도 있어야 함)
    if (allowed && p.erp_module && !is_admin) allowed = modSet.has(p.erp_module as string);
    return {
      page_key: p.page_key, title: p.title, path: p.path, icon: p.icon,
      dept_nm: p.dept_nm, visibility: p.visibility, erp_module: p.erp_module, allowed,
    };
  });

  return json({
    upn,
    name: emp_nm || upn.split("@")[0],
    dept_nm, emp_nm, role, is_admin, dept_admin_of,
    erp_modules, pages, catalog: CATALOG,
    as_of: new Date().toISOString(),
  });
});
