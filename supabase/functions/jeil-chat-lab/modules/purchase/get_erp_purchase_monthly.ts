// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "get_erp_purchase_monthly", version: "1.0.0", domain: "purchase", kind: "read",
  title_ko: "월별 매입(송장)", summary_ko: "송장 기준 거래처×월 매입액",
  description_llm: "ERP 매입 월집계(중간DB 사내 실데이터, 송장 M_IV 기준) — 거래처×월 매입액·전표건수(현재 가용 2026-01~). '매입 현황', '거래처별 매입', '특정 거래처/특정 월 매입' 류 질의에 사용. bp(거래처명·코드)·ym(YYYY-MM) 지정 시 해당 거래처×월 상세 반환.",
  params: { type: "object", properties: { bp: { type: "string", description: "거래처명 또는 코드(선택)" }, ym: { type: "string", description: "조회 월 YYYY-MM(선택)" } }, required: [] },
  perm_module: "purchase", perm_mode: "gate", sensitivity: "amount",
  view: ["series", "list"], erp: true, owner: "구매팀", status: "live",
  prompt_hint: "'매입'의 공식 집계는 송장 기준 get_erp_purchase_monthly(거래처×월)입니다. 개별 발주의 상태 IV는 그 발주의 '매입완료' 진행표시로만 해석하고, 두 수치를 합산·혼동하지 마세요.",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    const { data } = await admin.from("v_erp_purchase_monthly").select("*").order("ym", { ascending: false });
    const rows = data || [];
    let amt = 0, cnt = 0;
    const byBp: Record<string, { name: string; amt: number; cnt: number }> = {};
    const byMo: Record<string, { amt: number; cnt: number; bps: Set<string> }> = {};
    for (const r of rows) {
      amt += Number(r.purchase_amt || 0); cnt += Number(r.iv_cnt || 0);
      const b = (byBp[r.bp_code] = byBp[r.bp_code] || { name: r.bp_name || r.bp_code, amt: 0, cnt: 0 });
      b.amt += Number(r.purchase_amt || 0); b.cnt += Number(r.iv_cnt || 0);
      const m = (byMo[r.ym] = byMo[r.ym] || { amt: 0, cnt: 0, bps: new Set() });
      m.amt += Number(r.purchase_amt || 0); m.cnt += Number(r.iv_cnt || 0); m.bps.add(r.bp_code);
    }
    const top = Object.values(byBp).sort((a, b) => b.amt - a.amt).slice(0, 10);
    const 월별 = Object.keys(byMo).sort().map((ym) => ({ 월: ym, 매입액_원: byMo[ym].amt, 전표건수: byMo[ym].cnt, 거래처수: byMo[ym].bps.size }));
    // 거래처·월 필터(선택) — Top10 밖 거래처/특정 월 매입 조회
    const bpKw = String(args.bp || "").replace(/[,()*%]/g, "").trim();
    const ymF = String(args.ym || "").replace(/[^0-9-]/g, "").slice(0, 7);
    let 필터결과: unknown = null;
    if (bpKw || /^\d{4}-\d{2}$/.test(ymF)) {
      const f = rows.filter((r: Record<string, unknown>) =>
        (!bpKw || String(r.bp_name || "").includes(bpKw) || String(r.bp_code || "") === bpKw) &&
        (!/^\d{4}-\d{2}$/.test(ymF) || r.ym === ymF));
      let famt = 0; for (const r of f) famt += Number(r.purchase_amt || 0);
      필터결과 = { 조건: { 거래처: bpKw || null, 월: ymF || null }, 건수: f.length, 매입액합계_원: famt,
        목록: f.map((r: Record<string, unknown>) => ({ 월: r.ym, 거래처: r.bp_name || r.bp_code, 매입액_원: Number(r.purchase_amt || 0), 전표건수: Number(r.iv_cnt || 0) })) };
    }
    // 뷰: 거래처·월 필터 조회면 그 목록(list), 아니면 월별 추이(series)
    const purView: ViewPayload = 필터결과
      ? { view: "list", title: `매입 조회${bpKw ? " — " + bpKw : ""}${/^\d{4}-\d{2}$/.test(ymF) ? " " + ymF : ""}`, asOf,
          columns: [
            { key: "월", label: "월" }, { key: "거래처", label: "거래처" },
            { key: "매입액_원", label: "매입액(원)", num: true }, { key: "전표건수", label: "전표", num: true },
          ],
          // deno-lint-ignore no-explicit-any
          rows: ((필터결과 as any).목록 || []).slice(0, 30), note: "송장(M_IV) 기준" }
      : { view: "series", title: "월별 매입액(전사)", unit: "원", asOf,
          rows: 월별.slice(-24).map((m) => ({ k: m.월, v: m.매입액_원 })),
          note: "송장(M_IV) 기준 · 미마감 최근월은 값이 작을 수 있음" };
    return { 기준시각: asOf, 월별, 매입액합계_원: amt, 전표건수: cnt, 거래처수: Object.keys(byBp).length,
      거래처Top10: top.map((t) => ({ 거래처: t.name, 매입액_원: t.amt, 전표건수: t.cnt })), 필터결과,
      안내: "ERP 중간DB 매입(송장 M_IV 기준) 파일럿. 월별 값은 각 월 실적재분이며, 미마감 최근월은 값이 작을 수 있음. 발주 상태 IV와는 별개 집계.",
      __view: purView };
  }
