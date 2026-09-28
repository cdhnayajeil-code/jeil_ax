// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "get_erp_po_pr", version: "1.0.0", domain: "purchase", kind: "read",
  title_ko: "발주·구매요청 상세", summary_ko: "PO/PR 번호로 상세 + 연결 + 진행단계",
  description_llm: "ERP 구매발주 상세 + 발주↔구매요청 연결 조회(중간DB 사내 실데이터, 2026 전체 수천 건). 발주번호(PO…) 또는 구매요청번호(PR…)로 발주 상세(거래처·품목·수량·발주금액·발주일·상태)와 연결 구매요청(요청일·필요납기·요청자·부서) 조회. 특정 발주번호(예: PO202606230022)의 상세·품목·금액·거래처 질의는 반드시 이 도구를 쓸 것(협력사 검사 발주가 아니면 get_order_detail 로는 조회 안 됨). 'PO… 발주 상세/내역/품목/금액', 'PO… 구매요청 뭐야', 'PR… 발주됐어?' 류. po_no 또는 pr_no 중 하나 필수. ※이 도구는 PO/PR '번호' 전용 — 품목코드(예: S3041-00065)를 넣지 말 것(품목 이력은 get_erp_item_orders).",
  params: { type: "object", properties: { po_no: { type: "string", description: "발주번호(예: PO202607080001)" }, pr_no: { type: "string", description: "구매요청번호(예: PR202607060009)" } }, required: [] },
  perm_module: "pur_order", perm_mode: "gate", sensitivity: "amount",
  view: ["record"], erp: true, owner: "구매팀", status: "live",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    const po = String(args.po_no || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 20);
    const pr = String(args.pr_no || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 20);
    if (!po && !pr) return { 오류: "po_no 또는 pr_no가 필요합니다." };
    // 입력 가드: PO/PR 번호 형식이 아니면(예: 품목코드 S3041-00065를 발주번호로 오인) 0건 무응답 대신 재안내.
    if ((po && !/^PO/i.test(po)) || (pr && !/^PR/i.test(pr))) {
      return { 오류: `입력값 "${po || pr}"은(는) 발주(PO…)/구매요청(PR…) 번호 형식이 아닙니다.`,
        재시도도구: "get_erp_item_orders",
        안내: "품목코드(예: S3041-00065)나 품목명이라면 get_erp_item_orders 로 그 품목의 발주·구매요청 이력을 조회하세요. 발주/구매요청 번호는 PO…/PR… 로 시작합니다." };
    }
    let q = admin.from("v_erp_po_pr_link").select("*").limit(50);
    if (po) q = q.eq("po_no", po);
    if (pr) q = q.eq("pr_no", pr);
    const { data } = await q; const rows = data || [];
    // 요청자 표기: '부서_이름_아이디' (미매핑은 원본 아이디 유지)
    const uMap = await userLabelMap(admin, rows.map((r: Record<string, unknown>) => r.req_prsn));
    // deno-lint-ignore no-explicit-any
    const 발주_구매요청 = rows.map((r: any) => ({
      발주번호: r.po_no, 구매요청번호: r.pr_no || null, 발주일: r.po_dt, 거래처: r.po_vendor,
      품목코드: r.item_code, 품목: r.item_name, 발주수량: Number(r.po_qty || 0), 발주금액_원: Number(r.po_amt || 0),
      발주상태: stsKo(r.po_sts), 입고수량: Number(r.po_rcpt_qty || 0), 매입수량: Number(r.iv_qty || 0),
      진행: `요청 ${Number(r.req_qty || 0)} → 발주 ${Number(r.ord_qty || 0)} → 입고 ${Number(r.po_rcpt_qty || 0)} → 매입 ${Number(r.iv_qty || 0)}`,
      납기: r.po_dlvy_dt, 납기경과_미입고: r.overdue_unreceived === true,
      외주구분: r.subcontra_flg === "Y" ? "외주" : "일반", 연결수주번호: r.so_no || null,
      요청일: r.req_dt, 필요납기: r.pr_dlvy_dt, 요청수량: Number(r.req_qty || 0),
      요청부서: r.req_dept_resolved || "미상", 요청자: userLbl(uMap, r.req_prsn), 구매요청상태: stsKo(r.pr_sts),
    }));
    // PR 조회인데 발주 라인이 없으면(미발주 PR) 구매요청 자체 상세로 답
    let 구매요청상세: unknown = null;
    let poPrView: ViewPayload | null = null;
    if (pr && !rows.length) {
      const { data: rd } = await admin.from("v_erp_pur_req").select("*").eq("pr_no", pr).maybeSingle();
      // deno-lint-ignore no-explicit-any
      const r: any = rd;
      const uMap2 = await userLabelMap(admin, [r?.req_prsn]);
      구매요청상세 = r ? {
        구매요청번호: r.pr_no, 구매요청상태: stsKo(r.pr_sts), 품목코드: r.item_code, 품목: r.item_name,
        요청수량: Number(r.req_qty || 0), 발주수량: Number(r.ord_qty || 0), 입고수량: Number(r.rcpt_qty || 0), 매입수량: Number(r.iv_qty || 0),
        진행: `요청 ${Number(r.req_qty || 0)} → 발주 ${Number(r.ord_qty || 0)} → 입고 ${Number(r.rcpt_qty || 0)} → 매입 ${Number(r.iv_qty || 0)}`,
        미발주: Number(r.ord_qty || 0) === 0, 요청일: r.req_dt, 필요납기: r.dlvy_dt,
        요청부서: r.req_dept_resolved || "미상", 요청자: userLbl(uMap2, r.req_prsn), 연결수주번호: r.so_no || null, 공급처: r.sppl_name || null,
      } : null;
      if (r) {
        poPrView = { view: "record", title: `구매요청 ${r.pr_no}`, asOf,
          fields: [
            { k: "품목", v: String(r.item_name || "-") },
            { k: "요청수량", v: comma(Number(r.req_qty || 0)) },
            { k: "요청일 / 필요납기", v: `${r.req_dt || "-"} / ${r.dlvy_dt || "-"}` },
            { k: "요청부서", v: String(r.req_dept_resolved || "미상") },
            { k: "요청자", v: userLbl(uMap2, r.req_prsn) || "-" },
            { k: "발주 여부", v: Number(r.ord_qty || 0) === 0 ? "미발주" : `발주 ${comma(Number(r.ord_qty || 0))}` },
          ],
          steps: { labels: STEP_LABELS, current: STEP_IX[String(r.pr_sts || "").trim()] ?? -1 } };
      }
    }
    // 발주 라인이 있으면 첫 라인 기준 record + 진행단계 steps
    // deno-lint-ignore no-explicit-any
    const f0: any = rows[0];
    if (f0) {
      poPrView = { view: "record", title: `발주 ${f0.po_no}`, asOf,
        fields: [
          { k: "거래처", v: String(f0.po_vendor || "-") },
          { k: "품목", v: String(f0.item_name || "-") + (rows.length > 1 ? ` 외 ${rows.length - 1}건` : "") },
          { k: "발주일", v: String(f0.po_dt || "-") },
          { k: "납기", v: String(f0.po_dlvy_dt || "-") + (f0.overdue_unreceived === true ? " ⚠경과·미입고" : "") },
          { k: "발주금액", v: won(Number(f0.po_amt || 0)) + (rows.length > 1 ? " (첫 라인)" : "") },
          { k: "수량 진행", v: `요청 ${comma(Number(f0.req_qty || 0))} → 발주 ${comma(Number(f0.ord_qty || 0))} → 입고 ${comma(Number(f0.po_rcpt_qty || 0))} → 매입 ${comma(Number(f0.iv_qty || 0))}` },
          { k: "구매요청", v: String(f0.pr_no || "-") + (f0.req_prsn ? ` · ${userLbl(uMap, f0.req_prsn)}` : (f0.req_dept_resolved ? ` · ${f0.req_dept_resolved}` : "")) },
          { k: "외주구분", v: f0.subcontra_flg === "Y" ? "외주" : "일반" },
        ],
        steps: { labels: STEP_LABELS, current: STEP_IX[String(f0.po_sts || "").trim()] ?? -1 } };
    }
    return { 기준시각: asOf, 조회조건: { po_no: po || null, pr_no: pr || null }, 연결건수: rows.length,
      발주_구매요청, 구매요청상세,
      안내: "ERP 중간DB 발주↔구매요청 연결(파일럿). 진행단계: 요청(RQ)→확정(CF)→발주(PO)→입고(GR)→매입(IV). 요청부서는 요청자 이메일→부서 매핑으로 보완됨.",
      ...(poPrView ? { __view: poPrView } : {}) };
  }
