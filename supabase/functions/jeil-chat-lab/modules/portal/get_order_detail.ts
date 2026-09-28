// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "get_order_detail", version: "1.0.0", domain: "portal", kind: "read",
  title_ko: "외주검사 발주 상세", summary_ko: "외주검사 발주 1건의 진행단계·검사결과·사진·메시지",
  description_llm: "협력사 '외주 검사' 발주 상세만 조회(포털DB, 소수 건) — 진행상태(10단계)·검사결과·검수요청·사진·메시지 건수. ※일반 ERP 구매발주(PO…번호)의 발주 상세·품목·금액·거래처·구매요청은 이 도구가 아니라 get_erp_po_pr 를 쓸 것. 협력사 검사 대상이 아닌 발주번호는 여기서 조회되지 않는다.",
  params: {
        type: "object",
        properties: { po_no: { type: "string", description: "발주번호 (예: PO202607010128)" } },
        required: ["po_no"],
      },
  perm_module: "pur_order", perm_mode: "gate", sensitivity: "amount",
  view: ["record"], erp: false, owner: "구매팀", status: "live",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    const po = String(args.po_no || "").trim();
    if (!po) return { 오류: "po_no가 필요합니다." };
    const [{ data: h }, { data: s }, { data: insp }, { data: reqs }, { data: photos }, { data: msgs }] = await Promise.all([
      admin.from("sp_order_header").select("*").eq("po_no", po).maybeSingle(),
      admin.from("sp_order_state").select("status,step,updated_at").eq("po_no", po).maybeSingle(),
      admin.from("sp_inspection").select("result,judge_id,opinion,judged_at").eq("po_no", po).maybeSingle(),
      admin.from("sp_insp_request").select("insp_req_no,requested_at").eq("po_no", po).eq("cancelled", false),
      admin.from("sp_photo").select("id").eq("po_no", po),
      admin.from("sp_message").select("id").eq("po_no", po),
    ]);
    if (!h) return { 기준시각: asOf, 오류: `발주번호 ${po} 는 협력사 외주검사 포털에 없습니다.`, 안내: "ERP 구매발주(PO…)일 수 있습니다. get_erp_po_pr 도구로 다시 조회하세요.", 재시도도구: "get_erp_po_pr", 재시도인자: { po_no: po } };
    return {
      기준시각: asOf, 발주번호: h.po_no, 협력사: h.vendor_name, 발주일: h.order_date, 납기: h.due_date,
      금액_원: Number(h.amt || 0), 품목수: Array.isArray(h.items) ? h.items.length : 0,
      상태: STATUS_KO[s?.status || ""] || s?.status || "미확인", 진행단계_10: s?.step ?? null,
      검사결과: insp ? { 판정: insp.result, 판정자: insp.judge_id, 의견: insp.opinion, 판정일: insp.judged_at } : "판정 전",
      검수요청건수: (reqs || []).length, 사진건수: (photos || []).length, 메시지건수: (msgs || []).length,
      __view: { view: "record", title: `외주검사 발주 ${h.po_no}`, asOf,
        fields: [
          { k: "협력사", v: String(h.vendor_name || "-") },
          { k: "발주일 / 납기", v: `${h.order_date || "-"} / ${h.due_date || "-"}` },
          { k: "금액", v: won(Number(h.amt || 0)) },
          { k: "품목수", v: `${Array.isArray(h.items) ? h.items.length : 0}종` },
          { k: "상태", v: `${STATUS_KO[s?.status || ""] || s?.status || "미확인"}${s?.step != null ? ` (${s.step}/10단계)` : ""}` },
          { k: "검사결과", v: insp ? `${insp.result}${insp.judged_at ? ` · ${String(insp.judged_at).slice(0, 10)}` : ""}` : "판정 전" },
          { k: "검수요청/사진/메시지", v: `${(reqs || []).length}건 / ${(photos || []).length}장 / ${(msgs || []).length}건` },
        ] } satisfies ViewPayload,
    };
  }
