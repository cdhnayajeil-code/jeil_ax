// search_pur_list — 발주통합 LIST 검색(14 기획 §4-2 #8 · REQ-0087). 손으로 쓴 모듈(자동 생성 아님).
// 원천: public.v_erp_pur_list(PR 미발주 + PO 라인 한 줄 — /work/purchase-list 화면과 같은 뷰)
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { comma } from "../../core/util.ts";
import { clean, isDate } from "./_agent_util.ts";

export const manifest: ToolManifest = {
  id: "search_pur_list", version: "1.0.0", domain: "purchase", kind: "read",
  title_ko: "발주통합 LIST 검색", summary_ko: "구매요청(미발주)·발주·입고·매입을 한 줄로 조건 검색",
  description_llm: "발주통합 LIST 검색 — 구매요청(미발주)과 발주 라인을 한 줄씩(발주번호·요청번호·거래처·품목·수량·금액·납기·진행상태) 조건으로 찾는다. " +
    "키워드(품목명·품목코드·거래처명·발주번호·요청번호·프로젝트), 진행상태(미발주/발주/입고완료/매입완료), 미입고만, 납기경과 미입고만, 기간(목록일자)으로 좁힌다. " +
    "'○○ 거래처 발주 목록', '미발주 구매요청', '이번 달 발주 중 미입고', '품목 ○○ 들어간 발주' 류. 건수·합계·상태별 분포와 상위 목록을 돌려준다.",
  params: { type: "object", properties: {
    q: { type: "string", description: "키워드 — 품목명·품목코드·거래처명·발주번호(PO…)·요청번호(PR…)·프로젝트명 부분일치" },
    status: { type: "string", enum: ["미발주", "발주", "입고완료", "매입완료"], description: "진행상태" },
    unreceived: { type: "boolean", description: "true면 입고가 덜 된(미입고) 발주만" },
    overdue: { type: "boolean", description: "true면 납기가 지난 미입고만" },
    from: { type: "string", description: "시작일 YYYY-MM-DD(목록일자 기준)" },
    to: { type: "string", description: "종료일 YYYY-MM-DD" },
    limit: { type: "integer", description: "목록 표시 건수(기본 30, 최대 100)" },
  }, required: [] },
  perm_module: "pur_order", perm_mode: "gate", sensitivity: "amount",
  view: ["list"], erp: true, owner: "구매팀", status: "pilot",
  prompt_hint: "조건 검색형 발주 질문(거래처·품목·상태·기간으로 여러 건 찾기)은 search_pur_list 를 쓰세요. 한 건의 상세는 get_erp_po_pr 입니다.",
};

const SCAN = 1000;   // 집계에 쓰는 최대 행 — 넘으면 「일부만 집계」라고 밝힌다

export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf } = ctx;
  const q = clean(args.q);
  const show = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
  let qb = admin.from("v_erp_pur_list")
    .select("row_kind,po_no,pr_no,po_dt,list_dt,bp_name,item_code,item_name,spec,qty,unit,amt,dlvy_dt,status_kr,is_unreceived,overdue_unreceived,prj_nm,req_user_nm")
    .order("list_dt", { ascending: false }).limit(SCAN);
  if (q) qb = qb.or(["item_name", "item_code", "bp_name", "po_no", "pr_no", "prj_nm"].map((c) => `${c}.ilike.*${q}*`).join(","));
  if (typeof args.status === "string" && ["미발주", "발주", "입고완료", "매입완료"].includes(args.status)) qb = qb.eq("status_kr", args.status);
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
  const cond = [q && `키워드 '${q}'`, args.status && `상태 ${args.status}`, args.unreceived && "미입고", args.overdue && "납기경과",
    (args.from || args.to) && `기간 ${args.from || "…"}~${args.to || "…"}`].filter(Boolean).join(" · ") || "조건 없음(최근순)";
  const top = rows.slice(0, show);
  return {
    기준시각: asOf, 조건: cond, 건수: rows.length, 일부만집계: rows.length >= SCAN, 금액합계_원: total, 상태별건수: byStatus,
    목록: top.map((r) => ({ 구분: r.row_kind, 발주번호: r.po_no, 요청번호: r.pr_no, 일자: r.list_dt, 거래처: r.bp_name,
      품목: r.item_name, 품목코드: r.item_code, 수량: r.qty, 금액_원: Number(r.amt) || 0, 납기: r.dlvy_dt, 상태: r.status_kr,
      납기경과미입고: !!r.overdue_unreceived })),
    안내: rows.length >= SCAN ? `조건에 맞는 행이 ${SCAN}건을 넘어 최근 ${SCAN}건만 집계했습니다. 조건을 좁히면 정확해집니다.` : undefined,
    __view: { view: "list", title: `발주통합 LIST — ${cond}`, asOf,
      columns: [
        { key: "no", label: "발주/요청번호" }, { key: "dt", label: "일자" }, { key: "bp", label: "거래처" },
        { key: "item", label: "품목" }, { key: "qty", label: "수량", num: true }, { key: "amt", label: "금액(원)", num: true },
        { key: "due", label: "납기" }, { key: "st", label: "상태" }],
      rows: top.map((r) => ({ no: r.po_no || r.pr_no, dt: r.list_dt, bp: r.bp_name || "-", item: r.item_name || r.item_code,
        qty: Number(r.qty) || 0, amt: Number(r.amt) || 0, due: r.dlvy_dt || "-", st: r.status_kr + (r.overdue_unreceived ? " ⚠납기경과" : "") })),
      note: `${comma(rows.length)}건 · 합계 ${comma(total)}원` + (rows.length > show ? ` · 상위 ${show}건 표시` : "") + (rows.length >= SCAN ? " · 일부만 집계" : ""),
      actions: [{ kind: "link", label: "발주통합 LIST 화면에서 보기", url: "/work/purchase-list" }] } satisfies ViewPayload,
  };
}
