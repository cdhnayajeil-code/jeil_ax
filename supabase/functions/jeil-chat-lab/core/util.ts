// core/util.ts — 모듈 공용 헬퍼. 전부 운영 jeil-chat/index.ts 의 원본을 그대로 옮겼다(동작 동일).
import type { ErpScope } from "./types.ts";

export const STATUS_KO: Record<string, string> = { new: "신규", prod: "생산중", insp: "검사", done: "완료" };

// ERP 발주·구매요청 진행단계 코드(원천 po_sts/pr_sts) → 한글 해석. 진행순서: RQ→CF→PO→GR→IV
export const ERP_STS_KO: Record<string, string> = {
  RQ: "요청", CF: "확정", PO: "발주완료(입고전)", GR: "입고완료", IV: "매입/송장완료",
};
export const stsKo = (c: unknown): string => {
  const s = String(c ?? "").trim();
  return s ? (ERP_STS_KO[s] ? `${s}(${ERP_STS_KO[s]})` : s) : "-";
};

// 모듈 키 → 한글 라벨 (접근제한 안내 문구용)
export const MODULE_KO: Record<string, string> = {
  sales: "매출", purchase: "매입", inventory: "재고", item: "품목", pur_order: "발주·구매요청",
  payroll: "급여·인사", user_dept: "사용자·부서", finance: "자금·회계",
};

// 모듈 보유 여부(관리자는 전 모듈)
export const hasModule = (s: ErpScope, m: string) => s.isAdmin || s.modules.has(m);

export const comma = (n: number) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export const won = (n: number) => comma(n) + "원";
// ERP 진행단계 → steps 뷰 인덱스(요청 RQ → 확정 CF → 발주 PO → 입고 GR → 매입 IV)
export const STEP_IX: Record<string, number> = { RQ: 0, CF: 1, PO: 2, GR: 3, IV: 4 };
export const STEP_LABELS = ["요청", "확정", "발주완료", "입고", "매입"];

/* 사용자 표기 규약 — 아이디(사내 이메일)는 '부서_이름_아이디'로 표시. 표시용 변환일 뿐 감사 로그의 원본 upn 은 바꾸지 않는다. */
// deno-lint-ignore no-explicit-any
export async function userLabelMap(admin: any, ids: unknown[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.map((s) => String(s || "").trim().toLowerCase()).filter((s) => s.includes("@")))];
  if (!uniq.length) return new Map();
  const { data } = await admin.from("v_erp_user_dept").select("email,dept_nm,emp_nm").in("email", uniq);
  const m = new Map<string, string>();
  // deno-lint-ignore no-explicit-any
  for (const r of (data || []) as any[]) {
    const e = String(r.email || "").toLowerCase();
    if (e && r.emp_nm) m.set(e, `${r.dept_nm || "미매핑"}_${r.emp_nm}_${e}`);
  }
  return m;
}
export const userLbl = (m: Map<string, string>, id: unknown): string | null => {
  const s = String(id || "").trim();
  return s ? (m.get(s.toLowerCase()) || s) : null;
};

// ===== Microsoft Graph 호출(사용자 위임 토큰) — 문서 도구 전용. 보안 트리밍은 Graph가 처리 =====
export async function graphGet(userToken: string, url: string): Promise<Record<string, unknown>> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${userToken}` } });
  if (!r.ok) throw new Error(`Graph ${r.status}`);
  return await r.json();
}
export async function graphSearchDocs(userToken: string, q: string, size: number): Promise<Record<string, unknown>> {
  const r = await fetch("https://graph.microsoft.com/v1.0/search/query", {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ entityTypes: ["driveItem"], query: { queryString: q }, from: 0, size }] }),
  });
  if (!r.ok) throw new Error(`Graph search ${r.status}`);
  return await r.json();
}

// ===== AI 문서 연계 화이트리스트 (SSOT: ai_document_scope) — 조회실패·빈 목록이면 null → fail-closed =====
export type DocScope = { driveId: string; pathPrefix: string; webUrl: string };
export function normUrl(u: string): string {
  try { return decodeURIComponent(String(u || "")).toLowerCase(); } catch { return String(u || "").toLowerCase(); }
}
// deno-lint-ignore no-explicit-any
export async function loadDocScope(admin: any): Promise<DocScope[] | null> {
  try {
    const { data, error } = await admin.from("ai_document_scope")
      .select("drive_id, web_url, path_prefix").eq("active", true);
    if (error || !Array.isArray(data) || data.length === 0) return null;
    // deno-lint-ignore no-explicit-any
    const scopes: DocScope[] = data.map((r: any) => ({
      driveId: String(r.drive_id || ""),
      pathPrefix: normUrl(String(r.path_prefix || r.web_url || "")),
      webUrl: String(r.web_url || ""),
    })).filter((s: DocScope) => s.driveId && s.pathPrefix);
    return scopes.length ? scopes : null;
  } catch { return null; }
}
export function inScope(scopes: DocScope[], driveId: string, webUrl: string): boolean {
  const du = String(driveId || "");
  const wu = normUrl(webUrl);
  return scopes.some((s) => s.driveId === du && (!s.pathPrefix || wu.startsWith(s.pathPrefix)));
}

/* ===== 적재범위 레지스트리(erp_load_scope) — 결측 배지의 단일 출처(설계 11 §16). 조회 실패는 빈 배열(fail-soft) ===== */
export type ScopeRow = { field_key: string; label_ko: string; state: string; gap_label: string | null; gap_why: string | null; fix_type: string | null };
// deno-lint-ignore no-explicit-any
export async function loadLoadScope(admin: any, mod: string): Promise<ScopeRow[]> {
  try {
    const { data } = await admin.from("erp_load_scope")
      .select("field_key,label_ko,state,gap_label,gap_why,fix_type").eq("module", mod);
    return (data || []) as ScopeRow[];
  } catch { return []; }
}
export const gapOf = (rows: ScopeRow[], key: string): ScopeRow | null =>
  rows.find((r) => r.field_key === key && r.state !== "loaded") || null;
export const gapAttr = (g: ScopeRow | null) => (g ? { gap: g.gap_label || "미연계", gap_why: g.gap_why || "", fix_type: g.fix_type || "" } : {});
