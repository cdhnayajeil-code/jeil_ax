// 정본(손수정 2026-09-30 · 원래 _port_modules.py 자동 생성, HAND_TUNED 로 재생성 제외) — 12_에이전트관리/05 F-4.
//   · 전체 건수(count)와 잘림 표시: 표시 30건을 「전부」처럼 말하던 것(실제 675건)을 막는다
//   · 표 제목의 내부 상태값(unordered)을 한글로
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "get_erp_pur_req", version: "1.0.0", domain: "purchase", kind: "read",
  title_ko: "구매요청 목록", summary_ko: "상태·부서별 구매요청",
  description_llm: "ERP 구매요청(PR) 목록 조회(중간DB 사내 실데이터) — 상태·부서별 구매요청. '미발주 구매요청 몇 건/목록'(status=unordered), '우리 팀 구매요청', 'RQ(요청)/CF(확정) 상태 PR' 류. 특정 PR 단건 상세는 get_erp_po_pr(pr_no)를 쓸 것.",
  params: { type: "object", properties: { status: { type: "string", description: "unordered(미발주)/RQ/CF 등(선택)" }, dept: { type: "string", description: "요청부서 키워드(선택)" }, limit: { type: "integer", description: "최대 건수(기본 30, 최대 100)" } }, required: [] },
  perm_module: "pur_order", perm_mode: "gate", sensitivity: "normal",
  view: ["list"], erp: true, owner: "구매팀", status: "live",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    const status = String(args.status || "").trim();
    const dept = String(args.dept || "").replace(/[,()*%]/g, "").trim();
    const lim = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
    let q = admin.from("v_erp_pur_req")
      .select("pr_no,pr_sts,item_name,req_qty,ord_qty,rcpt_qty,iv_qty,req_dt,dlvy_dt,req_dept_resolved,req_prsn,so_no", { count: "exact" });
    if (status === "unordered" || status === "미발주") q = q.or("ord_qty.eq.0,ord_qty.is.null");
    else if (status) q = q.eq("pr_sts", status.toUpperCase());
    if (dept) q = q.ilike("req_dept_resolved", `%${dept}%`);
    const { data, count } = await q.order("req_dt", { ascending: false }).order("pr_no", { ascending: false }).limit(lim);
    const rows = data || [];
    const total = typeof count === "number" ? count : rows.length;
    const statusKo = status === "unordered" || status === "미발주" ? "미발주" : status ? stsKo(status.toUpperCase()) : "전체";
    // 요청자 표기: '부서_이름_아이디' (미매핑은 원본 아이디 유지)
    const uMap = await userLabelMap(admin, rows.map((r: Record<string, unknown>) => r.req_prsn));
    // deno-lint-ignore no-explicit-any
    const 목록 = rows.map((r: any) => ({ 구매요청번호: r.pr_no, 상태: stsKo(r.pr_sts), 품목: r.item_name,
      요청수량: Number(r.req_qty || 0), 발주수량: Number(r.ord_qty || 0), 미발주: Number(r.ord_qty || 0) === 0,
      요청일: r.req_dt, 필요납기: r.dlvy_dt, 요청부서: r.req_dept_resolved || "미상", 요청자: userLbl(uMap, r.req_prsn) }));
    return { 기준시각: asOf, 조건: { 상태: statusKo, 부서: dept || "전체" }, 전체건수: total, 잘림: total > rows.length, 표시건수: rows.length,
      목록,
      안내: `구매요청 목록. 표시 ${rows.length} / 전체 ${total}건 — 표시 건수를 전체처럼 말하지 말 것(최신 요청일 순). status=unordered(미발주,ord_qty=0)/RQ(요청)/CF(확정). 요청부서는 요청자 이메일→부서 매핑 보완. 파일럿 데이터.`,
      __view: { view: "list", title: `구매요청 — ${statusKo} / ${dept || "전부서"} (표시 ${rows.length} / 전체 ${total}건)`, asOf,
        columns: [
          { key: "구매요청번호", label: "구매요청번호" }, { key: "상태", label: "상태" }, { key: "품목", label: "품목" },
          { key: "요청수량", label: "요청수량", num: true }, { key: "미발주표시", label: "" },
          { key: "요청일", label: "요청일" }, { key: "필요납기", label: "필요납기" },
          { key: "요청자", label: "요청자(부서_이름_아이디)" },
        ],
        rows: 목록.slice(0, 30).map((r) => ({ ...r, 미발주표시: r.미발주 ? "미발주" : "" })) } satisfies ViewPayload };
  }
