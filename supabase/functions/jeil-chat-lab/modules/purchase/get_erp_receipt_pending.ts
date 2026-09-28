// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "get_erp_receipt_pending", version: "1.0.0", domain: "purchase", kind: "read",
  title_ko: "미입고 발주", summary_ko: "발주완료·입고전 라인(납기경과 필터)",
  description_llm: "ERP 미입고 발주 목록(중간DB 사내 실데이터) — 발주완료(상태 PO)됐지만 아직 입고(GR) 전인 발주 라인. '미입고 발주', '납기 지난 미입고', '입고 안 된 발주' 류 질의에 사용. overdue_only=true면 납기경과·미입고만.",
  params: { type: "object", properties: { overdue_only: { type: "boolean", description: "납기경과·미입고만(선택)" }, limit: { type: "integer", description: "최대 건수(기본 30, 최대 100)" } }, required: [] },
  perm_module: "pur_order", perm_mode: "gate", sensitivity: "amount",
  view: ["list"], erp: true, owner: "구매팀", status: "live",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    const overdueOnly = args.overdue_only === true || String(args.overdue_only) === "true";
    const lim = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
    let q = admin.from("v_erp_po_pr_link")
      .select("po_no,po_vendor,item_name,po_qty,po_rcpt_qty,po_dlvy_dt,po_amt,overdue_unreceived")
      .eq("po_sts", "PO");
    if (overdueOnly) q = q.eq("overdue_unreceived", true);
    const { data } = await q.order("po_dlvy_dt", { ascending: true }).limit(lim);
    const rows = data || [];
    let amt = 0; for (const r of rows) amt += Number(r.po_amt || 0);
    // deno-lint-ignore no-explicit-any
    const 목록 = rows.map((r: any) => ({ 발주번호: r.po_no, 거래처: r.po_vendor, 품목: r.item_name,
      발주수량: Number(r.po_qty || 0), 입고수량: Number(r.po_rcpt_qty || 0), 납기: r.po_dlvy_dt,
      발주금액_원: Number(r.po_amt || 0), 납기경과: r.overdue_unreceived === true }));
    return { 기준시각: asOf, 조건: overdueOnly ? "납기경과·미입고" : "미입고(발주완료 PO상태)", 표시건수_라인: rows.length, 표시금액합_원: amt,
      목록,
      안내: "발주상태 PO=발주완료·입고전. 발주 라인 단위 목록(limit 제한). 파일럿 데이터.",
      __view: { view: "list", title: overdueOnly ? "납기경과·미입고 발주" : "미입고 발주(발주완료·입고전)", asOf,
        columns: [
          { key: "발주번호", label: "발주번호" }, { key: "거래처", label: "거래처" }, { key: "품목", label: "품목" },
          { key: "발주수량", label: "발주수량", num: true }, { key: "입고수량", label: "입고", num: true },
          { key: "납기", label: "납기" }, { key: "발주금액_원", label: "금액(원)", num: true }, { key: "경과", label: "" },
        ],
        rows: 목록.slice(0, 30).map((r) => ({ ...r, 경과: r.납기경과 ? "⚠" : "" })),
        note: `표시 ${rows.length}라인 · 합계 ${won(amt)}` } satisfies ViewPayload };
  }
