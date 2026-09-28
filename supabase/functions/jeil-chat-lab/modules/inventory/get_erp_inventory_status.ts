// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "get_erp_inventory_status", version: "1.0.0", domain: "inventory", kind: "read",
  title_ko: "재고 입출고", summary_ko: "품목×창고 최근 31일 입출고(결측 배지 포함)",
  description_llm: "ERP 재고 입출고 현황(중간DB 사내 실데이터) — 품목×창고, 최근 31일. '재고', '입출고' 류 질의에 사용. ※현재 중간DB는 출고만 유효하고 입고량·재고량은 미적재(0/미표기) — 특정 발주의 입고 여부는 get_erp_po_pr(입고수량)로 답할 것.",
  params: { type: "object", properties: { item_code: { type: "string", description: "품목코드(선택, 특정 품목만)" } }, required: [] },
  perm_module: "inventory", perm_mode: "gate", sensitivity: "normal",
  view: ["record"], erp: true, owner: "자재팀", status: "live",
  prompt_hint: "재고·입고 수치(get_erp_inventory_status)는 현재 중간DB에 출고만 유효하고 입고량·재고량은 미적재입니다 — '입고 0/재고 없음'을 실적으로 단정하지 말고 미적재 상태임을 밝히며, 특정 발주의 입고 여부는 발주 조회(get_erp_po_pr)의 입고수량으로 답하세요.",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    const code = String(args.item_code || "").replace(/[,()*%]/g, "").trim();
    let q = admin.from("v_erp_inventory_daily").select("*").order("ymd", { ascending: false }).limit(2000);
    if (code) q = q.eq("item_code", code);
    const { data } = await q; const rows = data || [];
    let inq = 0, outq = 0; const items = new Set<string>();
    for (const r of rows) { inq += Number(r.in_qty || 0); outq += Number(r.out_qty || 0); items.add(r.item_code); }
    return { 기준시각: asOf, 대상: code || "전체(최근31일)", 품목수: items.size, 입고합계: inq, 출고합계: outq, 표본행수: rows.length,
      데이터주의: "현재 중간DB 재고는 출고만 유효하며 입고량·재고량은 미적재(0/미표기)입니다 — '입고 0/재고 없음'을 실적으로 단정하지 말 것. 특정 발주의 입고 여부는 get_erp_po_pr(입고수량)로 확인.",
      안내: "ERP 중간DB 재고 일집계 파일럿(입출고 분류는 협의 전 초안, 수집범위 일부 품목·약 1개월)",
      __view: await (async () => {
        // 결측 배지는 레지스트리에서 온다(§16) — 코드 상수 제거. 적재가 끝나 state=loaded 가 되면 배지가 자동으로 사라진다.
        const sc = await loadLoadScope(admin, "inventory");
        const gIn = gapOf(sc, "in_qty"), gStock = gapOf(sc, "stock_qty");
        const gaps = [gIn, gStock].filter(Boolean) as ScopeRow[];
        const fixes = [...new Set(gaps.map((g) => g.fix_type).filter(Boolean))].join(",");
        return { view: "record", title: `재고 입출고 — ${code || "전체(최근 31일)"}`, asOf,
          fields: [
            { k: "품목수", v: comma(items.size) },
            { k: "출고합계", v: comma(outq) },
            { k: "입고합계", v: comma(inq), ...gapAttr(gIn) },
            ...(gStock ? [{ k: "재고합계", v: "-", ...gapAttr(gStock) }] : []),
            { k: "표본행수", v: comma(rows.length) },
          ],
          // 데이터 적용요청(2분류 중 '데이터' 축) — 결측이 있을 때만 붙인다.
          ...(gaps.length ? { request: { ui: "data", kind: "data", module: "inventory", moduleKo: "재고",
            dept: scope.dept || "미지정",
            gap: { type: "field", detail: gaps.map((g) => g.label_ko).join("·"), fix_type: fixes } } } : {}),
          note: gaps.length ? `${gaps.map((g) => g.label_ko).join("·")}은 중간DB 미적재 — 실적으로 단정 금지` : undefined,
        } satisfies ViewPayload;
      })() };
  }
