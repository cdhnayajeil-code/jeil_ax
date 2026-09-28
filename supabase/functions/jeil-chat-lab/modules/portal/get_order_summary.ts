// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "get_order_summary", version: "1.0.0", domain: "portal", kind: "read",
  title_ko: "협력사 외주검사 발주 현황", summary_ko: "포털에 등록된 외주검사 발주의 상태별 건수·납기임박",
  description_llm: "협력사 '외주 검사' 발주 현황(포털DB — 협력사 포털에 등록된 외주 검사 대상 발주, 소수 건). 상태별 건수·검사 진행·납기임박. ※ ERP 전체 구매발주(수천 건·월별)는 get_erp_pur_order 를 쓸 것.",
  params: { type: "object", properties: {}, required: [] },
  perm_module: "pur_order", perm_mode: "gate", sensitivity: "amount",
  view: ["record"], erp: false, owner: "구매팀", status: "live",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    const [{ data: heads }, { data: states }] = await Promise.all([
      admin.from("sp_order_header").select("po_no,vendor_name,due_date,amt"),
      admin.from("sp_order_state").select("po_no,status,step"),
    ]);
    const st: Record<string, { status: string; step: number }> = {};
    (states || []).forEach((s: { po_no: string; status: string; step: number }) => (st[s.po_no] = s));
    const byStatus: Record<string, number> = {};
    let totalAmt = 0;
    const vendors = new Set<string>();
    const dueSoon: unknown[] = [];
    const in7 = Date.now() + 7 * 86400000;
    for (const h of heads || []) {
      const s = st[h.po_no]?.status || "new";
      byStatus[STATUS_KO[s] || s] = (byStatus[STATUS_KO[s] || s] || 0) + 1;
      totalAmt += Number(h.amt || 0);
      vendors.add(h.vendor_name || "");
      if (s !== "done" && h.due_date && new Date(h.due_date).getTime() <= in7) {
        dueSoon.push({ 발주번호: h.po_no, 협력사: h.vendor_name, 납기: h.due_date, 상태: STATUS_KO[s] || s });
      }
    }
    return { 기준시각: asOf, 총발주: (heads || []).length, 상태별건수: byStatus, 총발주금액_원: totalAmt, 협력사수: vendors.size, 납기7일내_미완료: dueSoon,
      __view: { view: "record", title: "협력사 외주검사 발주 현황", asOf,
        fields: [
          { k: "총 발주", v: `${(heads || []).length}건` },
          { k: "총 발주금액", v: won(totalAmt) },
          { k: "협력사", v: `${vendors.size}곳` },
          { k: "납기 7일내 미완료", v: `${dueSoon.length}건` },
          ...Object.entries(byStatus).map(([k, v]) => ({ k: `상태 · ${k}`, v: `${v}건` })),
        ] } satisfies ViewPayload };
  }
