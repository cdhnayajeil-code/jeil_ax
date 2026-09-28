// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "get_inspection_pending", version: "1.0.0", domain: "portal", kind: "read",
  title_ko: "검사 판정 대기", summary_ko: "검수요청 후 합/부 판정 전인 발주 목록",
  description_llm: "검수요청이 접수됐지만 아직 합/부 판정이 나지 않은(검사 대기) 발주 목록 — 발주번호, 협력사, 납기, 요청일시.",
  params: { type: "object", properties: {}, required: [] },
  perm_module: "pur_order", perm_mode: "gate", sensitivity: "normal",
  view: ["list"], erp: false, owner: "구매팀", status: "live",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    const [{ data: reqs }, { data: insps }, { data: heads }] = await Promise.all([
      admin.from("sp_insp_request").select("po_no,insp_req_no,requested_at").eq("cancelled", false),
      admin.from("sp_inspection").select("po_no"),
      admin.from("sp_order_header").select("po_no,vendor_name,due_date"),
    ]);
    const judged = new Set((insps || []).map((r: { po_no: string }) => r.po_no));
    const hm: Record<string, { vendor_name: string; due_date: string }> = {};
    (heads || []).forEach((h: { po_no: string; vendor_name: string; due_date: string }) => (hm[h.po_no] = h));
    const seen = new Set<string>();
    const pending = (reqs || [])
      .filter((r: { po_no: string }) => !judged.has(r.po_no) && !seen.has(r.po_no) && seen.add(r.po_no))
      .map((r: { po_no: string; insp_req_no: string; requested_at: string }) => ({
        발주번호: r.po_no, 협력사: hm[r.po_no]?.vendor_name || "-", 납기: hm[r.po_no]?.due_date || "-",
        검수요청번호: r.insp_req_no, 요청일시: r.requested_at,
      }));
    return { 기준시각: asOf, 판정대기건수: pending.length, 목록: pending,
      __view: { view: "list", title: `검사 판정 대기 ${pending.length}건`, asOf,
        columns: [
          { key: "발주번호", label: "발주번호" }, { key: "협력사", label: "협력사" },
          { key: "납기", label: "납기" }, { key: "요청일시", label: "검수요청일시" },
        ], rows: pending.slice(0, 30) } satisfies ViewPayload };
  }
