// 정본(손수정 2026-09-30 · 원래 _port_modules.py 자동 생성, HAND_TUNED 로 재생성 제외) — 12_에이전트관리/05 F-3.
//   · 검사결과(합격·불합격·판정전) 집계와 불합격 목록: 상태(공정 단계)만 보고 「불합격 없음」이라 답하던 오답을 막는다
//   · 주문일 범위·「기간 조건 없음」 명시: 도구에 기간 인자가 없는데 「이번 달」이라 말하지 않게
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "get_order_summary", version: "1.1.0", domain: "portal", kind: "read",
  title_ko: "협력사 외주검사 발주 현황", summary_ko: "포털에 등록된 외주검사 발주의 상태별 건수·검사결과(합격/불합격)·납기임박",
  description_llm: "협력사 '외주 검사' 발주 현황(포털DB — 협력사 포털에 등록된 외주 검사 대상 발주, 소수 건). 상태(공정 단계)별 건수 + 검사결과(합격·불합격·판정전)별 건수와 불합격 목록·납기임박. 기간 조건은 없고 전체를 돌려준다(주문일 범위를 함께 준다). ※ ERP 전체 구매발주(수천 건·월별)는 get_erp_pur_order 를 쓸 것.",
  params: { type: "object", properties: {}, required: [] },
  prompt_hint: "외주 검사의 '불합격·합격' 질문은 상태(생산중·검사·완료 = 공정 단계)가 아니라 검사결과별 건수·불합격 목록으로 답하세요. 이 도구는 기간 조건이 없으니 '이번 달'이라 말하지 말고 주문일 범위(전체)를 밝히세요.",
  perm_module: "pur_order", perm_mode: "gate", sensitivity: "amount",
  view: ["record"], erp: false, owner: "구매팀", status: "live",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    const [{ data: heads }, { data: states }, { data: insp }] = await Promise.all([
      admin.from("sp_order_header").select("po_no,vendor_name,order_date,due_date,amt"),
      admin.from("sp_order_state").select("po_no,status,step"),
      admin.from("sp_inspection").select("po_no,result,judge_id,judged_at"),
    ]);
    const st: Record<string, { status: string; step: number }> = {};
    (states || []).forEach((s: { po_no: string; status: string; step: number }) => (st[s.po_no] = s));
    // 검사결과(판정) — 상태(공정 단계)와 다른 축. 판정 행이 없으면 '판정전'.
    const ins: Record<string, { result: string; judge_id: string | null; judged_at: string | null }> = {};
    (insp || []).forEach((i: { po_no: string; result: string; judge_id: string | null; judged_at: string | null }) => (ins[i.po_no] = i));
    const byStatus: Record<string, number> = {};
    const byResult: Record<string, number> = {};
    const failed: unknown[] = [];
    let totalAmt = 0;
    const vendors = new Set<string>();
    const dueSoon: unknown[] = [];
    const dates: string[] = [];
    const in7 = Date.now() + 7 * 86400000;
    for (const h of heads || []) {
      const s = st[h.po_no]?.status || "new";
      byStatus[STATUS_KO[s] || s] = (byStatus[STATUS_KO[s] || s] || 0) + 1;
      const r = ins[h.po_no]?.result || "판정전";
      byResult[r] = (byResult[r] || 0) + 1;
      if (r === "불합격") failed.push({ 발주번호: h.po_no, 협력사: h.vendor_name, 판정일: ins[h.po_no]?.judged_at || null, 판정자: ins[h.po_no]?.judge_id || null, 상태: STATUS_KO[s] || s });
      totalAmt += Number(h.amt || 0);
      vendors.add(h.vendor_name || "");
      if (h.order_date) dates.push(String(h.order_date));
      if (s !== "done" && h.due_date && new Date(h.due_date).getTime() <= in7) {
        dueSoon.push({ 발주번호: h.po_no, 협력사: h.vendor_name, 납기: h.due_date, 상태: STATUS_KO[s] || s });
      }
    }
    dates.sort();
    const range = dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : "-";
    return { 기준시각: asOf, 기간조건: "없음 — 포털에 등록된 외주검사 발주 전체", 주문일범위: range,
      총발주: (heads || []).length, 상태별건수: byStatus, 검사결과별건수: byResult, 불합격목록: failed,
      총발주금액_원: totalAmt, 협력사수: vendors.size, 납기7일내_미완료: dueSoon,
      안내: `기간 조건 없이 전체 ${(heads || []).length}건(주문일 ${range}). '이번 달'이라 말하지 말 것. 불합격 여부는 검사결과별건수·불합격목록으로 답할 것(상태는 공정 단계).`,
      __view: { view: "record", title: "협력사 외주검사 발주 현황(전체)", asOf,
        fields: [
          { k: "총 발주", v: `${(heads || []).length}건 · 주문일 ${range}` },
          { k: "총 발주금액", v: won(totalAmt) },
          { k: "협력사", v: `${vendors.size}곳` },
          { k: "납기 7일내 미완료", v: `${dueSoon.length}건` },
          { k: "검사결과", v: Object.entries(byResult).map(([k, v]) => `${k} ${v}건`).join(" · ") || "-" },
          ...(failed.length ? [{ k: "불합격", v: (failed as { 발주번호: string; 협력사: string }[]).map((f) => `${f.발주번호}(${f.협력사})`).join(", ") }] : []),
          ...Object.entries(byStatus).map(([k, v]) => ({ k: `상태 · ${k}`, v: `${v}건` })),
        ] } satisfies ViewPayload };
  }
