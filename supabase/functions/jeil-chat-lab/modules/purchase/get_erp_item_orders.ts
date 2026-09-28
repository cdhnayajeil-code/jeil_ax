// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "get_erp_item_orders", version: "1.0.0", domain: "purchase", kind: "read",
  title_ko: "품목별 구매 이력", summary_ko: "품목의 구매요청→발주→매입 이력",
  description_llm: "특정 '품목'의 구매요청·발주·매입 이력 조회(중간DB 사내 실데이터, 2026 전체). 품목코드(예: S3041-00065)나 품목명으로 그 품목이 언제·누가·얼마에 요청/발주/매입됐는지 반환(구매요청 PR·발주 PO·연결관계·수량·금액·상태). '이 품목(코드) 발주됐어?', '품목코드로 구매요청/발주 조회', 'S3041-00065 발주·구매요청 알려줘' 류에 반드시 이 도구를 쓸 것. ※품목코드는 발주번호(PO…)·구매요청번호(PR…)가 아니므로 get_erp_po_pr 에 품목코드를 넣지 말 것.",
  params: { type: "object", properties: { item: { type: "string", description: "품목코드(예: S3041-00065) 또는 품목명 키워드" } }, required: ["item"] },
  perm_module: "pur_order", perm_mode: "gate", sensitivity: "amount",
  view: ["list", "notice"], erp: true, owner: "구매팀", status: "live",
  prompt_hint: "★'품목코드(예: S3041-00065)나 품목명으로 그 품목의 발주·구매요청·매입 이력을 조회'하려면 반드시 get_erp_item_orders 를 쓰세요. 품목코드는 발주번호가 아니므로 get_erp_po_pr 의 po_no/pr_no 에 품목코드를 절대 넣지 마세요(넣으면 '없음'으로 오답). 품목코드로 물었는데 발주가 있으면 있다고 정확히 답하고, 품목코드를 발주번호처럼 답하지 마세요. 도구가 '재시도도구'를 반환하면 그 도구로 다시 조회하세요.",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    const raw = String(args.item || "").trim();
    const key = raw.replace(/[,()*%]/g, "").trim();
    if (!key) return { 오류: "item(품목코드 또는 품목명)이 필요합니다." };
    // 1) 품목 확정: 정확 코드 매칭 우선, 없으면 코드/명 부분일치로 후보 조회
    const { data: exact } = await admin.from("v_erp_item").select("item_code,item_name,spec,unit,use_yn").eq("item_code", key).limit(1);
    let items = exact || [];
    if (!items.length) {
      const { data: cand } = await admin.from("v_erp_item").select("item_code,item_name,spec,unit,use_yn")
        .or(`item_code.ilike.%${key}%,item_name.ilike.%${key}%`).limit(10);
      items = cand || [];
    }
    if (!items.length) {
      return { 기준시각: asOf, 검색어: raw, 건수: 0, 안내: `"${raw}"에 해당하는 품목을 찾지 못했습니다. 품목코드·품목명을 확인하세요(중간DB는 2026년 기준).` };
    }
    // 후보가 여러 개면(부분일치) 목록만 안내 — 어느 품목인지 사용자 확인
    if (items.length > 1) {
      // deno-lint-ignore no-explicit-any
      const 후보 = items.map((r: any) => ({ 품목코드: r.item_code, 품목명: r.item_name, 규격: r.spec, 단위: r.unit }));
      return { 기준시각: asOf, 검색어: raw, 후보건수: 후보.length, 후보, 안내: "여러 품목이 검색됐습니다. 어느 품목인지 품목코드로 다시 알려주세요.",
        __view: { view: "list", title: `품목 후보 — "${raw}" (${후보.length}건)`, asOf,
          columns: [{ key: "품목코드", label: "품목코드" }, { key: "품목명", label: "품목명" }, { key: "규격", label: "규격" }, { key: "단위", label: "단위" }],
          rows: 후보, note: "품목코드를 지정해 다시 조회하세요" } satisfies ViewPayload };
    }
    const it = items[0] as Record<string, unknown>;
    const code = String(it.item_code);
    // 2) 확정 품목코드로 구매요청·발주·매입 조회(각 최신순)
    const [reqR, ordR, ivR] = await Promise.all([
      admin.from("v_erp_pur_req").select("pr_no,req_dt,req_qty,ord_qty,rcpt_qty,iv_qty,pr_sts,req_dept_resolved,req_prsn,sppl_name").eq("item_code", code).order("req_dt", { ascending: false }).limit(50),
      admin.from("v_erp_pur_order").select("po_no,po_dt,bp_name,po_qty,po_amt,po_sts,rcpt_qty,pr_no,dlvy_dt").eq("item_code", code).order("po_dt", { ascending: false }).limit(50),
      admin.from("v_erp_iv_dtl").select("iv_no,iv_dt,bp_name,iv_qty,iv_loc_amt,po_no").eq("item_code", code).order("iv_dt", { ascending: false }).limit(50),
    ]);
    const uMap = await userLabelMap(admin, (reqR.data || []).map((r: Record<string, unknown>) => r.req_prsn));
    // deno-lint-ignore no-explicit-any
    const 구매요청 = (reqR.data || []).map((r: any) => ({ 구매요청번호: r.pr_no, 요청일: r.req_dt, 요청수량: Number(r.req_qty || 0), 발주수량: Number(r.ord_qty || 0), 요청부서: r.req_dept_resolved || "", 요청자: userLbl(uMap, r.req_prsn), 진행: stsKo(r.pr_sts) }));
    // deno-lint-ignore no-explicit-any
    const 발주 = (ordR.data || []).map((r: any) => ({ 발주번호: r.po_no, 발주일: r.po_dt, 거래처: r.bp_name || "", 발주수량: Number(r.po_qty || 0), 발주금액_원: Number(r.po_amt || 0), 입고수량: Number(r.rcpt_qty || 0), 진행: stsKo(r.po_sts), 연결_구매요청: r.pr_no || null }));
    // deno-lint-ignore no-explicit-any
    const 매입 = (ivR.data || []).map((r: any) => ({ 매입번호: r.iv_no, 매입일: r.iv_dt, 거래처: r.bp_name || "", 매입수량: Number(r.iv_qty || 0), 매입금액_원: Number(r.iv_loc_amt || 0), 연결_발주: r.po_no || null }));
    const 사용금지 = /사용\s*금지/.test(String(it.item_name || ""));
    // __view: 발주 목록을 list 뷰로(있으면), 없고 구매요청만 있으면 구매요청을 list로
    const hasPo = 발주.length > 0;
    const view: ViewPayload = {
      view: "list",
      title: `${code} ${it.item_name || ""} — ${hasPo ? "발주" : "구매요청"} 이력`,
      asOf,
      columns: hasPo
        ? [{ key: "발주번호", label: "발주번호" }, { key: "발주일", label: "발주일" }, { key: "거래처", label: "거래처" }, { key: "발주수량", label: "수량" }, { key: "발주금액", label: "금액(원)" }, { key: "진행", label: "진행" }]
        : [{ key: "구매요청번호", label: "구매요청" }, { key: "요청일", label: "요청일" }, { key: "요청부서", label: "부서" }, { key: "요청수량", label: "수량" }, { key: "진행", label: "진행" }],
      rows: hasPo
        // deno-lint-ignore no-explicit-any
        ? 발주.slice(0, 30).map((r: any) => ({ 발주번호: r.발주번호, 발주일: r.발주일, 거래처: r.거래처, 발주수량: comma(r.발주수량), 발주금액: comma(r.발주금액_원), 진행: r.진행 }))
        // deno-lint-ignore no-explicit-any
        : 구매요청.slice(0, 30).map((r: any) => ({ 구매요청번호: r.구매요청번호, 요청일: r.요청일, 요청부서: r.요청부서, 요청수량: comma(r.요청수량), 진행: r.진행 })),
      note: `구매요청 ${구매요청.length} · 발주 ${발주.length} · 매입 ${매입.length}건 (2026 기준)`,
    };
    return {
      기준시각: asOf,
      품목: { 품목코드: code, 품목명: it.item_name, 규격: it.spec, 단위: it.unit, 사용금지 },
      구매요청건수: 구매요청.length, 발주건수: 발주.length, 매입건수: 매입.length,
      구매요청, 발주, 매입,
      안내: (구매요청.length || 발주.length || 매입.length)
        ? "요청→발주→입고→매입 진행순. 진행상태 코드는 요청RQ→확정CF→발주완료PO→입고GR→매입IV. 수량·금액은 ERP 중간DB(2026) 기준."
        : `이 품목(${code})은 중간DB(2026년)에 등록된 구매요청·발주·매입이 없습니다. 2025년 이전 건은 미적재이니 있으면 원본 ERP를 확인하세요.`,
      // 이력 0건은 "없다"가 아니라 "적재범위 밖일 수 있다" — 평문으로 끝내지 않고 카드로 원인과 요청 경로를 준다(§14-6 P2b).
      // 조건 오입력(ⓓ)일 가능성이 있으므로 '품목 다시 확인'을 앞에 두고 요청 버튼은 뒤로 보낸다(confirm_first).
      __view: (구매요청.length || 발주.length) ? view : await (async () => {
        const p = gapOf(await loadLoadScope(admin, "pur_order"), "*");
        return { view: "notice", title: `${code} — 등록된 발주·구매요청 이력 없음`, kind: "info",
          text: `중간DB(${p ? "2026년 이후 적재" : "현재 적재범위"})에 이 품목의 구매요청·발주·매입이 없습니다. 품목코드가 맞는지 먼저 확인하시고, 2025년 이전 건이라면 적재범위 밖입니다.`,
          actions: [{ kind: "ask", label: "품목 정보 다시 확인", prompt: `품목 ${code} 정보 확인해줘` }],
          ...(p ? { request: { ui: "data", kind: "data", module: "pur_order", moduleKo: "발주·구매요청",
            dept: scope.dept || "미지정", confirm_first: true,
            gap: { type: "period", detail: p.label_ko, fix_type: p.fix_type } } } : {}),
        } satisfies ViewPayload;
      })(),
    };
  }
