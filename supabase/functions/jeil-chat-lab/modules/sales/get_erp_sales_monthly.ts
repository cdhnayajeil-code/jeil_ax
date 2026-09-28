// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "get_erp_sales_monthly", version: "1.0.0", domain: "sales", kind: "read",
  title_ko: "월별 매출", summary_ko: "거래처×월 매출액·건수",
  description_llm: "ERP 매출 월집계(중간DB 사내 실데이터) — 거래처×월 매출액·건수(현재 가용 2026-01~). '이번달 매출', '거래처별 매출' 류 질의에 사용. ※수금액·수주액은 미매핑(0)이니 매출액만 답할 것. 파일럿(유니포인트 매핑 확정 전).",
  params: { type: "object", properties: {}, required: [] },
  perm_module: "sales", perm_mode: "gate", sensitivity: "amount",
  view: ["series"], erp: true, owner: "영업팀", status: "live",
  prompt_hint: "매출의 수금액·수주액은 미매핑(0)이니 매출액만 답하세요.",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    const { data } = await admin.from("v_erp_sales_monthly").select("*").order("ym", { ascending: false });
    const rows = data || [];
    let amt = 0, cnt = 0;
    const byBp: Record<string, { name: string; amt: number }> = {};
    const byMo: Record<string, { amt: number; cnt: number; bps: Set<string> }> = {};
    for (const r of rows) {
      amt += Number(r.sales_amt || 0); cnt += Number(r.order_cnt || 0);
      const b = (byBp[r.bp_code] = byBp[r.bp_code] || { name: r.bp_name || r.bp_code, amt: 0 });
      b.amt += Number(r.sales_amt || 0);
      const m = (byMo[r.ym] = byMo[r.ym] || { amt: 0, cnt: 0, bps: new Set() });
      m.amt += Number(r.sales_amt || 0); m.cnt += Number(r.order_cnt || 0); m.bps.add(r.bp_code);
    }
    const top = Object.values(byBp).sort((a, b) => b.amt - a.amt).slice(0, 10);
    const 월별 = Object.keys(byMo).sort().map((ym) => ({ 월: ym, 매출액_원: byMo[ym].amt, 건수: byMo[ym].cnt, 거래처수: byMo[ym].bps.size }));
    return { 기준시각: asOf, 월별, 매출액합계_원: amt, 매출건수: cnt, 거래처수: Object.keys(byBp).length,
      거래처Top10: top.map((t) => ({ 거래처: t.name, 매출액_원: t.amt })),
      안내: "ERP 중간DB 파일럿(유니포인트 매핑 확정 전). 월별 값은 각 월 실적재분이며, 미마감 최근월은 값이 작을 수 있음.",
      __view: { view: "series", title: "월별 매출액(전사)", unit: "원", asOf,
        rows: 월별.slice(-24).map((m) => ({ k: m.월, v: m.매출액_원 })),
        note: "ERP 중간DB 파일럿 · 미마감 최근월은 값이 작을 수 있음" } satisfies ViewPayload };
  }
