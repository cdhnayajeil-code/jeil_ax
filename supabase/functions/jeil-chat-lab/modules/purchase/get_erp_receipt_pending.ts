// 정본(손수정 2026-09-30 · 원래 _port_modules.py 자동 생성, HAND_TUNED 로 재생성 제외) — 12_에이전트관리/05 F-2.
//   · 정렬 2차키(po_no·po_seq): 납기일 하나로만 정렬하면 같은 조회가 다른 30행을 돌려준다(비결정)
//   · vendor 조건 + 전체 건수(count) + 거래처별 집계: 「거래처별 요약」「오성테크 건만」에 표 없는 숫자를 만들지 않게
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "get_erp_receipt_pending", version: "1.1.0", domain: "purchase", kind: "read",
  title_ko: "미입고 발주", summary_ko: "발주완료·입고전 라인(납기경과·거래처 필터, 전체 건수·거래처별 집계)",
  description_llm: "ERP 미입고 발주 목록(중간DB 사내 실데이터) — 발주완료(상태 PO)됐지만 아직 입고(GR) 전인 발주 라인. '미입고 발주', '납기 지난 미입고', '입고 안 된 발주' 류 질의에 사용. overdue_only=true면 납기경과·미입고만. vendor 로 거래처를 좁힌다. 결과의 전체건수·거래처별 집계는 표시 한도와 무관한 전체 값이다.",
  params: { type: "object", properties: { overdue_only: { type: "boolean", description: "납기경과·미입고만(선택)" }, vendor: { type: "string", description: "거래처명 부분일치(선택) — '오성테크 건만' 처럼 좁힐 때" }, limit: { type: "integer", description: "표시 라인 수(기본 30, 최대 100) — 전체 건수·거래처별 집계는 한도와 무관" } }, required: [] },
  prompt_hint: "미입고 발주를 거래처별로 요약할 때는 get_erp_receipt_pending 의 거래처별 집계(전체 기준)를 쓰고, 특정 거래처만 볼 때는 vendor 인자로 다시 조회하세요. 표시 라인은 한도로 잘리니 '표시 N / 전체 M' 을 밝히세요.",
  perm_module: "pur_order", perm_mode: "gate", sensitivity: "amount",
  view: ["list"], erp: true, owner: "구매팀", status: "live",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    const overdueOnly = args.overdue_only === true || String(args.overdue_only) === "true";
    const vendor = String(args.vendor || "").replace(/[,()*%]/g, "").trim().slice(0, 60);
    const lim = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
    const base = (sel: string) => {
      let q = admin.from("v_erp_po_pr_link").select(sel, { count: "exact" }).eq("po_sts", "PO");
      if (overdueOnly) q = q.eq("overdue_unreceived", true);
      if (vendor) q = q.ilike("po_vendor", `%${vendor}%`);
      return q;
    };
    // 표시분: 납기 오래된 순 + 2차 정렬키(같은 납기일이 30번째에 몰리면 순서가 실행마다 바뀐다)
    const { data, count } = await base("po_no,po_vendor,item_name,po_qty,po_rcpt_qty,po_dlvy_dt,po_amt,overdue_unreceived")
      .order("po_dlvy_dt", { ascending: true }).order("po_no", { ascending: true }).order("po_seq", { ascending: true }).limit(lim);
    const rows = data || [];
    const total = typeof count === "number" ? count : rows.length;
    let amt = 0; for (const r of rows) amt += Number(r.po_amt || 0);
    // 거래처별 집계 — 표시 한도와 무관하게 조건 전체(최대 1,000라인)로 센다. 그 이상이면 '일부'라고 밝힌다.
    const AGG_MAX = 1000;
    const { data: aggRows } = await base("po_vendor,po_amt").order("po_dlvy_dt", { ascending: true }).order("po_no", { ascending: true }).limit(AGG_MAX);
    const byV: Record<string, { 라인수: number; 금액합_원: number }> = {};
    let aggAmt = 0;
    for (const r of (aggRows || []) as { po_vendor: string; po_amt: number }[]) {
      const k = r.po_vendor || "(거래처 미상)"; const a = Number(r.po_amt || 0);
      (byV[k] = byV[k] || { 라인수: 0, 금액합_원: 0 }).라인수++; byV[k].금액합_원 += a; aggAmt += a;
    }
    const 거래처별 = Object.entries(byV).map(([거래처, v]) => ({ 거래처, ...v })).sort((a, b) => b.금액합_원 - a.금액합_원).slice(0, 30);
    const aggExact = total <= AGG_MAX;
    // deno-lint-ignore no-explicit-any
    const 목록 = rows.map((r: any) => ({ 발주번호: r.po_no, 거래처: r.po_vendor, 품목: r.item_name,
      발주수량: Number(r.po_qty || 0), 입고수량: Number(r.po_rcpt_qty || 0), 납기: r.po_dlvy_dt,
      발주금액_원: Number(r.po_amt || 0), 납기경과: r.overdue_unreceived === true }));
    const cond = [overdueOnly ? "납기경과·미입고" : "미입고(발주완료 PO상태)", vendor && `거래처 '${vendor}'`].filter(Boolean).join(" · ");
    return { 기준시각: asOf, 조건: cond,
      전체건수_라인: total, 잘림: total > rows.length, 표시건수_라인: rows.length, 표시금액합_원: amt,
      전체금액합_원: aggExact ? aggAmt : null, 거래처별_집계기준: aggExact ? "조건 전체" : `납기 오래된 순 ${AGG_MAX}라인까지(일부)`, 거래처별,
      목록,
      안내: `발주상태 PO=발주완료·입고전. 발주 라인 단위. 표시 ${rows.length} / 전체 ${total}라인 — 표시분 합계(${won(amt)})를 전체 합계로 말하지 말 것. 거래처별 집계는 ${aggExact ? "전체 기준" : "일부 기준"}. 파일럿 데이터.`,
      __view: { view: "list", title: (overdueOnly ? "납기경과·미입고 발주" : "미입고 발주(발주완료·입고전)") + (vendor ? ` — ${vendor}` : ""), asOf,
        columns: [
          { key: "발주번호", label: "발주번호" }, { key: "거래처", label: "거래처" }, { key: "품목", label: "품목" },
          { key: "발주수량", label: "발주수량", num: true }, { key: "입고수량", label: "입고", num: true },
          { key: "납기", label: "납기" }, { key: "발주금액_원", label: "금액(원)", num: true }, { key: "경과", label: "" },
        ],
        rows: 목록.slice(0, 30).map((r) => ({ ...r, 경과: r.납기경과 ? "⚠" : "" })),
        note: `표시 ${rows.length} / 전체 ${total}라인 · 표시분 합계 ${won(amt)}` + (aggExact ? ` · 전체 합계 ${won(aggAmt)}` : "") } satisfies ViewPayload };
  }
