// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "get_erp_item", version: "1.0.0", domain: "item", kind: "read",
  title_ko: "품목 검색", summary_ko: "품목코드·품목명 부분일치 검색(사용금지 표시)",
  description_llm: "ERP 품목 조회(중간DB 사내 실데이터) — 코드/명 부분일치로 품목 마스터 검색(규격·단위·분류·사용금지 여부). '품목 있어?', '품목코드 뭐야' 류 질의에 사용. 품목명에 '사용금지' 표기가 있으면 신규 발주 제시 금지. ※그 품목의 발주·구매요청·매입 이력은 get_erp_item_orders 를 쓸 것.",
  params: { type: "object", properties: { keyword: { type: "string", description: "품목코드 또는 품목명 키워드" } }, required: ["keyword"] },
  perm_module: "item", perm_mode: "gate", sensitivity: "normal",
  view: ["list"], erp: true, owner: "구매팀", status: "live",
  prompt_hint: "품목명에 '사용금지' 표기가 있는 코드는 신규 발주용으로 제시하지 말고 대체코드 확인을 안내하세요.",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    const kw = String(args.keyword || "").replace(/[,()*%]/g, "").trim();
    if (!kw) return { 오류: "keyword가 필요합니다." };
    const { data } = await admin.from("v_erp_item")
      .select("item_code,item_name,spec,unit,item_class,use_yn")
      .or(`item_code.ilike.%${kw}%,item_name.ilike.%${kw}%`).limit(30);
    const rows = data || [];
    // deno-lint-ignore no-explicit-any
    const 목록 = rows.map((r: any) => ({ 품목코드: r.item_code, 품목명: r.item_name, 규격: r.spec, 단위: r.unit, 분류: r.item_class, 사용: r.use_yn, 사용금지: /사용\s*금지/.test(String(r.item_name || "")) }))
      .sort((a: { 사용금지: boolean }, b: { 사용금지: boolean }) => (a.사용금지 ? 1 : 0) - (b.사용금지 ? 1 : 0));
    return { 기준시각: asOf, 검색어: kw, 건수: 목록.length, 목록,
      안내: "품목명에 '사용금지' 표기가 있는 코드는 신규 발주용으로 제시 금지(대체코드 확인 안내).",
      __view: { view: "list", title: `품목 검색 — "${kw}" (${목록.length}건)`, asOf,
        columns: [
          { key: "품목코드", label: "품목코드" }, { key: "품목명", label: "품목명" },
          { key: "규격", label: "규격" }, { key: "단위", label: "단위" }, { key: "금지", label: "" },
        ],
        // deno-lint-ignore no-explicit-any
        rows: 목록.slice(0, 30).map((r: any) => ({ 품목코드: r.품목코드, 품목명: r.품목명, 규격: r.규격 || "", 단위: r.단위 || "", 금지: r.사용금지 ? "⚠ 사용금지" : "" })),
        note: "사용금지 품목은 신규 발주 제시 금지" } satisfies ViewPayload };
  }
