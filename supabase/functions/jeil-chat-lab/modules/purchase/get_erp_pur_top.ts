// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "get_erp_pur_top", version: "1.0.0", domain: "purchase", kind: "read",
  title_ko: "발주 금액 상위", summary_ko: "발주번호별 총액 상위 N",
  description_llm: "ERP 발주 금액 상위(top N) 조회 — 발주번호별 총액(라인 합산) 큰 순으로 발주번호·거래처·발주총액·라인수·대표품목. '가장 금액이 큰 발주', '발주 top 5', '최대 금액 구매' 류. 동일 발주 중복 없이 발주 총액 기준(라인 단위 아님).",
  params: { type: "object", properties: { n: { type: "integer", description: "상위 몇 건(기본 10, 최대 30)" } }, required: [] },
  perm_module: "pur_order", perm_mode: "gate", sensitivity: "amount",
  view: ["ranking"], erp: true, owner: "구매팀", status: "live",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    const n = Math.min(Math.max(Number(args.n) || 10, 1), 30);
    const { data } = await admin.from("v_erp_pur_top_po")
      .select("po_no,po_dt,po_vendor,line_cnt,po_total,top_item,pr_no,has_open_line")
      .order("po_total", { ascending: false, nullsFirst: false }).limit(n);
    const rows = data || [];
    return { 기준시각: asOf, 상위N: n,
      // deno-lint-ignore no-explicit-any
      상위목록: rows.map((r: any) => ({
        발주번호: r.po_no, 발주일: r.po_dt, 거래처: r.po_vendor,
        발주총액_원: Number(r.po_total || 0), 라인수: Number(r.line_cnt || 0), 대표품목: r.top_item,
        구매요청번호: r.pr_no || null, 진행: r.has_open_line ? "진행중(일부 입고전)" : "입고/매입 진행",
      })),
      안내: "ERP 중간DB 발주 총액(발주번호별 라인 합산) 상위. 동일 발주 중복 없음. 파일럿 데이터.",
      __view: { view: "ranking", title: `발주 총액 상위 ${n}건`, unit: "원", asOf,
        // deno-lint-ignore no-explicit-any
        rows: rows.map((r: any, i: number) => ({ rank: i + 1, label: `${r.po_no} · ${r.po_vendor || "-"}`, v: Number(r.po_total || 0), sub: String(r.top_item || "") })),
        note: "발주번호별 라인 합산 총액 기준",
        ...(rows.length ? { actions: [{ kind: "ask", label: `1위 ${(rows[0] as Record<string, unknown>).po_no} 상세 보기`,
          prompt: `발주 ${(rows[0] as Record<string, unknown>).po_no} 상세 조회해줘` }] } : {}) } satisfies ViewPayload };
  }
