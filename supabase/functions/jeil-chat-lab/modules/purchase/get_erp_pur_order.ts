// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "get_erp_pur_order", version: "1.0.0", domain: "purchase", kind: "read",
  title_ko: "월별 발주 현황", summary_ko: "월별 발주건수·금액, 특정 월 거래처 Top10",
  description_llm: "ERP 전체 구매발주 현황(중간DB 사내 실데이터, 2026년 수천 건) — 월별 발주건수·발주금액·거래처수, 특정 월 상세(거래처Top·상태분포). '1월 발주', 'ERP 발주 현황', '월별 발주 얼마' 류 질의에 사용. (협력사 외주 검사 발주는 get_order_summary)",
  params: { type: "object", properties: { ym: { type: "string", description: "조회 월 YYYY-MM(선택, 예 2026-01). 없으면 월별 전체 요약" } }, required: [] },
  perm_module: "pur_order", perm_mode: "gate", sensitivity: "amount",
  view: ["series", "ranking"], erp: true, owner: "구매팀", status: "live",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    const ym = String(args.ym || "").replace(/[^0-9-]/g, "").slice(0, 7);
    const { data: mrows } = await admin.from("v_erp_pur_order_monthly").select("*").order("ym");
    const 월별 = (mrows || []).map((r: Record<string, unknown>) => ({
      월: r.ym, 발주건수: Number(r.po_cnt || 0), 품목라인: Number(r.line_cnt || 0),
      거래처수: Number(r.bp_cnt || 0), 발주금액_원: Number(r.amt || 0),
    }));
    let 상세: unknown = null;
    if (/^\d{4}-\d{2}$/.test(ym)) {
      const [y, m] = ym.split("-").map(Number);
      const nm = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
      const { data } = await admin.from("v_erp_pur_order")
        .select("po_no,bp_name,po_amt,po_sts").gte("po_dt", ym + "-01").lt("po_dt", nm + "-01").limit(3000);
      const rows = data || [];
      const byBp: Record<string, number> = {}; const bySts: Record<string, { 건수: number; 금액_원: number }> = {};
      const pos = new Set<string>(); let amt = 0;
      for (const r of rows) {
        pos.add(r.po_no); amt += Number(r.po_amt || 0);
        const nmk = r.bp_name || r.po_no; byBp[nmk] = (byBp[nmk] || 0) + Number(r.po_amt || 0);
        const s = stsKo(r.po_sts); const e = (bySts[s] = bySts[s] || { 건수: 0, 금액_원: 0 });
        e.건수 += 1; e.금액_원 += Number(r.po_amt || 0);
      }
      const top = Object.entries(byBp).sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([거래처, 금액]) => ({ 거래처, 발주금액_원: 금액 }));
      상세 = { 월: ym, 발주건수: pos.size, 품목라인: rows.length, 발주금액_원: amt, 거래처Top10: top, 상태분포_금액: bySts };
    }
    // 뷰: 특정 월 상세 조회면 거래처 Top10(ranking), 아니면 월별 추이(series)
    // deno-lint-ignore no-explicit-any
    const d상세 = 상세 as any;
    const poView: ViewPayload = d상세
      ? { view: "ranking", title: `${ym} 거래처별 발주금액 Top10`, unit: "원", asOf,
          rows: (d상세.거래처Top10 || []).map((t: Record<string, unknown>, i: number) => ({ rank: i + 1, label: String(t.거래처), v: Number(t.발주금액_원 || 0) })),
          note: `${ym} 발주 ${comma(Number(d상세.발주건수 || 0))}건 · 총 ${won(Number(d상세.발주금액_원 || 0))}` }
      : { view: "series", title: "월별 발주금액(전사)", unit: "원", asOf,
          rows: 월별.slice(-24).map((m: Record<string, unknown>) => ({ k: String(m.월), v: Number(m.발주금액_원 || 0) })),
          note: "발주건수는 고유 발주번호 기준 · 파일럿" };
    return { 기준시각: asOf, 월별, 상세, 안내: "ERP 중간DB 구매발주(pur_order_s, 2026 전체). 발주건수=고유 발주번호 기준. 파일럿 데이터.",
      __view: poView };
  }
