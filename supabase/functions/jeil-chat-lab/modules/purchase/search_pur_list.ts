// search_pur_list — 발주통합 LIST 검색·번호 추적(14 기획 §4-2 #8 · REQ-0087 · v1.1 REQ-0090). 손으로 쓴 모듈(자동 생성 아님).
// 원천: public.v_erp_pur_list(PO 라인 + 발주 없는 PR — /work/purchase-list 화면과 같은 뷰, 정본 SQL 72)
//
// 번호 3종(12_에이전트관리/04 · 2026-09-29 실측)
//   PR = 구매요청번호  'PR'+YYYYMMDD+4자리 — **요청 품목 1줄**마다 1개(5,663개 ≈ 5,673행)
//   PU = 구매요청결재번호 'PU'+YYYYMMDD+4자리 — 그룹웨어 결재 1건. PR 여러 줄을 묶는다(평균 4.7 · 최대 111). ERP M_PUR_REQ.EXT1_CD
//   PO = 발주번호     'PO'+YYYYMMDD+4자리 — 발주서 1건. PR 여러 줄을 묶고(최대 134), PR 1줄이 PO 여러 건으로 나뉘기도 한다(최대 3)
//   흐름: 요청(PR) → 결재(PU) → 발주(PO) → 입고 → 매입(IV). PU 와 PO 는 서로 다른 묶음이라 1:1 이 아니다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { comma } from "../../core/util.ts";
import { clean, isDate } from "./_agent_util.ts";

export const manifest: ToolManifest = {
  id: "search_pur_list", version: "1.1.0", domain: "purchase", kind: "read",
  title_ko: "발주통합 LIST 검색·번호 추적", summary_ko: "PR·PU·PO 번호로 연결 추적 + 조건 검색(요청·결재·발주·입고·매입 한 줄)",
  description_llm: "발주통합관리 LIST(구매팀 엑셀 대장과 같은 한 줄 목록) 검색. 한 줄 = 발주 라인(발주가 안 난 구매요청은 요청 1줄). " +
    "번호 3종을 모두 받는다: pr=구매요청번호(PR…, 요청 품목 1줄), pu=구매요청결재번호(PU…, 그룹웨어 결재 1건 = PR 여러 줄 묶음), po=발주번호(PO…, 발주서 1건 = PR 여러 줄 묶음). " +
    "번호를 주면 그 번호에 연결된 PR·PU·PO 목록과 진행상태 분포를 함께 돌려준다('PU2026… 결재 건 발주 됐어?', 'PO… 에 묶인 요청들', 'PR… 은 어느 발주로 갔어?'). " +
    "그 밖에 키워드(품목명·품번·공급처·건명·도번·P-CODE·계약내역), 진행상태(미발주/발주/부분입고/입고완료/매입완료), 구분(원자재/부자재/외주/소모품), 미입고·납기경과, 기간(목록일자=발주일, 미발주는 요청일)으로 좁힌다.",
  params: { type: "object", properties: {
    pr: { type: "string", description: "구매요청번호 PR… (전체 또는 앞부분)" },
    pu: { type: "string", description: "구매요청결재번호 PU… (전체 또는 앞부분)" },
    po: { type: "string", description: "발주번호 PO… (전체 또는 앞부분)" },
    q: { type: "string", description: "키워드 — 품목명·품번·공급처·건명·도번/품명·P-CODE·계약내역 부분일치" },
    bp: { type: "string", description: "공급처(거래처)명 부분일치" },
    status: { type: "string", enum: ["미발주", "발주", "부분입고", "입고완료", "매입완료"], description: "진행상태" },
    gubun: { type: "string", enum: ["원자재", "부자재", "외주", "소모품"], description: "구분" },
    unreceived: { type: "boolean", description: "true면 입고가 덜 된(미입고) 줄만" },
    overdue: { type: "boolean", description: "true면 입고요청일이 지난 미입고만" },
    from: { type: "string", description: "시작일 YYYY-MM-DD(목록일자)" },
    to: { type: "string", description: "종료일 YYYY-MM-DD" },
    limit: { type: "integer", description: "목록 표시 줄 수(기본 30, 최대 100)" },
  }, required: [] },
  perm_module: "pur_order", perm_mode: "gate", sensitivity: "amount",
  view: ["list"], erp: true, owner: "구매팀", status: "pilot",
  prompt_hint: "번호 체계: PR=구매요청번호(요청 품목 1줄) · PU=구매요청결재번호(그룹웨어 결재 1건, PR 여러 줄 묶음) · PO=발주번호(발주서 1건, PR 여러 줄 묶음). " +
    "흐름은 PR(요청) → PU(결재) → PO(발주) → 입고 → 매입. PU 와 PO 는 묶는 기준이 달라 1:1 이 아니니 'PU 1건 = PO 1건'이라고 말하지 마세요. " +
    "PU 번호가 나오거나, 번호끼리의 연결(이 결재 건은 발주됐나 · 이 발주에 묶인 요청들)을 묻거나, 조건으로 여러 줄을 찾을 때는 search_pur_list 를 쓰세요. " +
    "PO 한 건·PR 한 줄의 단계별 상세(요청→확정→발주→입고→매입 수량)는 get_erp_po_pr 입니다. 발주통합 LIST 의 '상태'는 미발주·발주·부분입고·입고완료·매입완료 다섯 가지입니다.",
};

const SCAN = 1000;   // 집계에 쓰는 최대 행 — 넘으면 「일부만 집계」라고 밝힌다
const COLS = "row_kind,po_no,po_seq,pr_no,pu_no,po_dt,list_dt,req_dt,bp_name,item_code,item_name,spec,qty,unit,amt,dlvy_dt,po_dlvy_dt," +
  "rcpt_qty,rcpt_last_dt,iv_last_dt,status_kr,is_unreceived,overdue_unreceived,gubun,p_code,prj_nm,req_title,dw_ref,req_user_nm,req_dept,agent_nm";
const numArg = (v: unknown, pre: string): string => {
  const s = String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
  return s.startsWith(pre) ? s : "";
};

export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf } = ctx;
  const pr = numArg(args.pr, "PR"), pu = numArg(args.pu, "PU"), po = numArg(args.po, "PO");
  // 번호를 q 에 넣어 부른 경우도 알아본다(모델이 칸을 헷갈려도 맞게 찾도록)
  const qRaw = clean(args.q);
  const qNum = /^(PR|PU|PO)\d{6,}/i.test(qRaw.replace(/\s/g, "")) ? qRaw.replace(/\s/g, "").toUpperCase() : "";
  const q = qNum ? "" : qRaw;
  const PR = pr || (qNum.startsWith("PR") ? qNum : ""), PU = pu || (qNum.startsWith("PU") ? qNum : ""), PO = po || (qNum.startsWith("PO") ? qNum : "");
  const byNumber = !!(PR || PU || PO);
  const show = Math.min(Math.max(Number(args.limit) || 30, 1), 100);

  let qb = admin.from("v_erp_pur_list").select(COLS).order("list_dt", { ascending: false }).limit(SCAN);
  if (PR) qb = PR.length >= 14 ? qb.eq("pr_no", PR) : qb.like("pr_no", `${PR}%`);
  if (PU) qb = PU.length >= 14 ? qb.eq("pu_no", PU) : qb.like("pu_no", `${PU}%`);
  if (PO) qb = PO.length >= 14 ? qb.eq("po_no", PO) : qb.like("po_no", `${PO}%`);
  if (q) qb = qb.or(["item_name", "item_code", "bp_name", "req_title", "dw_ref", "p_code", "prj_nm"].map((c) => `${c}.ilike.*${q}*`).join(","));
  const bp = clean(args.bp);
  if (bp) qb = qb.ilike("bp_name", `%${bp}%`);
  if (typeof args.status === "string" && ["미발주", "발주", "부분입고", "입고완료", "매입완료"].includes(args.status)) qb = qb.eq("status_kr", args.status);
  if (typeof args.gubun === "string" && ["원자재", "부자재", "외주", "소모품"].includes(args.gubun)) qb = qb.eq("gubun", args.gubun);
  if (args.unreceived === true) qb = qb.eq("is_unreceived", true);
  if (args.overdue === true) qb = qb.eq("overdue_unreceived", true);
  if (isDate(args.from)) qb = qb.gte("list_dt", args.from);
  if (isDate(args.to)) qb = qb.lte("list_dt", args.to);
  const { data, error } = await qb;
  if (error) return { 오류: "조회 실패: " + error.message };
  // deno-lint-ignore no-explicit-any
  const rows = (data || []) as any[];

  const total = rows.reduce((n, r) => n + (Number(r.amt) || 0), 0);
  const byStatus: Record<string, number> = {};
  rows.forEach((r) => { byStatus[r.status_kr] = (byStatus[r.status_kr] || 0) + 1; });
  const uniq = (k: string) => [...new Set(rows.map((r) => r[k]).filter(Boolean))] as string[];
  const prs = uniq("pr_no"), pus = uniq("pu_no"), pos = uniq("po_no");
  const cond = [PR && `구매요청 ${PR}`, PU && `결재 ${PU}`, PO && `발주 ${PO}`, q && `키워드 '${q}'`, bp && `공급처 '${bp}'`,
    args.status && `상태 ${args.status}`, args.gubun && `구분 ${args.gubun}`, args.unreceived && "미입고", args.overdue && "납기경과",
    (args.from || args.to) && `기간 ${args.from || "…"}~${args.to || "…"}`].filter(Boolean).join(" · ") || "조건 없음(최근순)";

  if (!rows.length) {
    const hint = PU ? "결재번호가 ERP 구매요청에 아직 연결되지 않았거나(요청의 결재번호 칸 미기재) 번호가 다를 수 있습니다."
      : PR || PO ? "번호를 다시 확인해 주세요. 올해 1월 이전 건은 중간DB 에 없을 수 있습니다." : "조건을 넓혀 보세요.";
    return { 기준시각: asOf, 조건: cond, 건수: 0, 안내: `발주통합 LIST 에 해당 줄이 없습니다. ${hint}`,
      __view: { view: "notice", title: "발주통합 LIST — 결과 없음", kind: "info", text: `${cond}: 해당 줄이 없습니다. ${hint}` } satisfies ViewPayload };
  }

  // 번호로 찾았으면 "연결"을 먼저 보여 준다 — 이 결재 건이 어느 발주로 갔는지, 이 발주에 어떤 요청이 묶였는지
  const 연결 = byNumber ? {
    구매요청PR: { 개수: prs.length, 목록: prs.slice(0, 30) },
    결재PU: { 개수: pus.length, 목록: pus.slice(0, 30), 결재번호없는줄: rows.filter((r) => !r.pu_no).length },
    발주PO: { 개수: pos.length, 목록: pos.slice(0, 30), 미발주줄: rows.filter((r) => r.row_kind === "PR").length },
    해석: [
      PU && `결재 ${PU} 에 구매요청 ${prs.length}줄이 묶여 있고, 그중 ${rows.filter((r) => r.row_kind === "PO").length}줄이 발주 ${pos.length}건으로 나갔습니다(미발주 ${rows.filter((r) => r.row_kind === "PR").length}줄).`,
      PO && `발주 ${PO} 에 구매요청 ${prs.length}줄이 묶여 있고, 결재번호는 ${pus.length}건입니다${pus.length > 1 ? "(여러 결재의 요청을 한 발주로 묶음)" : ""}.`,
      PR && `구매요청 ${PR} 은 ${pos.length ? `발주 ${pos.join(", ")}` : "아직 발주 전"}${pus.length ? ` · 결재 ${pus.join(", ")}` : " · 결재번호 없음"} 입니다.`,
    ].filter(Boolean).join(" "),
  } : undefined;

  const top = rows.slice(0, show);
  return {
    기준시각: asOf, 조건: cond, 줄수: rows.length, 일부만집계: rows.length >= SCAN, 금액합계_원: total, 상태별줄수: byStatus,
    ...(연결 ? { 연결 } : { 번호개수: { PR: prs.length, PU: pus.length, PO: pos.length } }),
    목록: top.map((r) => ({
      구분: r.row_kind === "PR" ? "미발주 요청" : "발주 라인", 구매요청번호_PR: r.pr_no, 결재번호_PU: r.pu_no, 발주번호_PO: r.po_no,
      건명: r.req_title, 공급처: r.bp_name, 품번: r.item_code, 품목명: r.item_name, 규격: r.spec, 수량: r.qty, 단위: r.unit, 금액_원: Number(r.amt) || 0,
      요청일: r.req_dt, 발주일: r.po_dt, 입고요청일: r.dlvy_dt, 발주납기: r.po_dlvy_dt, 입고수량: r.rcpt_qty, 입고일: r.rcpt_last_dt || null, 매입일: r.iv_last_dt || null,
      상태: r.status_kr, 납기경과미입고: !!r.overdue_unreceived, 자재구분: r.gubun, P_CODE: r.p_code, 요청자: r.req_user_nm, 담당자: r.agent_nm,
    })),
    안내: rows.length >= SCAN ? `조건에 맞는 줄이 ${SCAN}줄을 넘어 최근 ${SCAN}줄만 집계했습니다. 조건을 좁히면 정확해집니다.` : undefined,
    __view: { view: "list", title: `발주통합 LIST — ${cond}`, asOf,
      columns: [
        { key: "pr", label: "구매요청(PR)" }, { key: "pu", label: "결재(PU)" }, { key: "po", label: "발주(PO)" }, { key: "bp", label: "공급처" },
        { key: "item", label: "품목" }, { key: "qty", label: "수량", num: true }, { key: "amt", label: "금액(원)", num: true },
        { key: "due", label: "입고요청일" }, { key: "st", label: "상태" }],
      rows: top.map((r) => ({ pr: r.pr_no || "-", pu: r.pu_no || "-", po: r.po_no || "미발주", bp: r.bp_name || "-", item: r.item_name || r.item_code,
        qty: Number(r.qty) || 0, amt: Number(r.amt) || 0, due: r.dlvy_dt || "-", st: r.status_kr + (r.overdue_unreceived ? " ⚠납기경과" : "") })),
      note: `${comma(rows.length)}줄 · PR ${prs.length} · PU ${pus.length} · PO ${pos.length} · 합계 ${comma(total)}원`
        + (rows.length > show ? ` · 상위 ${show}줄 표시` : "") + (rows.length >= SCAN ? " · 일부만 집계" : ""),
      actions: [
        ...(pos.length === 1 ? [{ kind: "ask", label: `${pos[0]} 단계별 상세`, prompt: `발주 ${pos[0]} 상세 조회해줘` }] : []),
        { kind: "link", label: "발주통합 LIST 화면에서 보기", url: "/work/purchase-list" }] } satisfies ViewPayload,
  };
}
