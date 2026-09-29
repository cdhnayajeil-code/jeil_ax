// get_pur_proposal — 구매 기안서 대장 조회(14 기획 §4-2 #10 · REQ-0087). 손으로 쓴 모듈.
// 원천: public.v_pur_proposal_case(건 단위 — /work/purchase-proposals 화면과 같은 뷰)
// 권한: 기안서 대장 화면(purchase_proposal_2026) 열람 권한 — 화면·RPC 와 같은 판정(perm_mode=partial)
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { comma } from "../../core/util.ts";
import { canProposal, clean, isDate, proposalDeny } from "./_agent_util.ts";

export const manifest: ToolManifest = {
  id: "get_pur_proposal", version: "1.1.0", domain: "purchase", kind: "read",
  title_ko: "기안서 대장 조회", summary_ko: "구매 기안서 대장을 키워드·기간·종결여부로 검색",
  description_llm: "구매 기안서 대장(구매팀 엑셀 대장, 건 단위) 검색 — 기안일·기안자·JOB번호·프로젝트·고객사·내용·업체·금액·종결여부·스캔본 유무. " +
    "'○○ 업체 기안서', '미종결 기안', '이번 달 기안 건', 'JOB ○○ 기안' 류. ERP 전표와의 대사는 get_proposal_recon 을 쓴다.",
  params: { type: "object", properties: {
    q: { type: "string", description: "키워드 — 내용·업체·프로젝트·고객사·JOB번호·기안자 부분일치" },
    closed: { type: "string", enum: ["Y", "N"], description: "Y=종결, N=미종결" },
    from: { type: "string", description: "기안일 시작 YYYY-MM-DD" },
    to: { type: "string", description: "기안일 종료 YYYY-MM-DD" },
    limit: { type: "integer", description: "표시 건수(기본 20, 최대 100)" },
  }, required: [] },
  perm_module: null, perm_mode: "partial", sensitivity: "amount",
  view: ["list", "notice"], erp: false, owner: "구매팀", status: "pilot",
};

export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope } = ctx;
  if (!canProposal(scope)) return proposalDeny();
  const q = clean(args.q);
  const show = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
  let qb = admin.from("v_pur_proposal_case")
    .select("vol,no,key,draft_dt,drafter,job_no,project,customer,content,vendor,amt,lines,no_slip_lines,closed,scan_ok,src_updated")
    .order("draft_dt", { ascending: false, nullsFirst: false }).limit(1000);
  if (q) qb = qb.or(["content", "vendor", "project", "customer", "job_no", "drafter"].map((c) => `${c}.ilike.*${q}*`).join(","));
  if (args.closed === "Y" || args.closed === "N") qb = qb.eq("closed", args.closed);
  if (isDate(args.from)) qb = qb.gte("draft_dt", args.from);
  if (isDate(args.to)) qb = qb.lte("draft_dt", args.to);
  const { data, error } = await qb;
  if (error) return { 오류: "조회 실패: " + error.message };
  // deno-lint-ignore no-explicit-any
  const rows = (data || []) as any[];
  const total = rows.reduce((n, r) => n + (Number(r.amt) || 0), 0);
  const open = rows.filter((r) => r.closed !== "Y").length;
  const top = rows.slice(0, show);
  // 스캔본(문서중앙화) 파일명 — 목록은 매일 밤 자동 갱신(proposal_scan). 내용은 읽지 않는다.
  const scanMap = new Map<string, { file_name: string | null; checked_at: string }>();
  if (top.length) {
    const { data: sc } = await admin.from("pur_proposal_scan").select("vol,no,file_name,matched,checked_at")
      .in("vol", [...new Set(top.map((r) => r.vol))]).in("no", top.map((r) => r.no));
    // deno-lint-ignore no-explicit-any
    ((sc || []) as any[]).forEach((s) => { if (s.matched) scanMap.set(`${s.vol}-${s.no}`, s); });
  }
  const cond = [q && `'${q}'`, args.closed === "Y" ? "종결" : args.closed === "N" ? "미종결" : "", (args.from || args.to) && `${args.from || "…"}~${args.to || "…"}`].filter(Boolean).join(" · ") || "전체";
  const asOfLedger = rows[0]?.src_updated || null;
  return {
    기준시각: asOf, 대장적재시각: asOfLedger, 조건: cond, 건수: rows.length, 미종결: open, 금액합계_원: total,
    목록: top.map((r) => ({ 권번호: r.key, 기안일: r.draft_dt, 기안자: r.drafter, JOB: r.job_no, 프로젝트: r.project, 고객사: r.customer,
      내용: r.content, 업체: r.vendor, 금액_원: Number(r.amt) || 0, 종결: r.closed === "Y" ? "종결" : "미종결", 전표없는행: r.no_slip_lines,
      스캔본: scanMap.get(r.key)?.file_name ? `있음(${scanMap.get(r.key)!.file_name})` : r.scan_ok ? "있음" : "없음" })),
    __view: { view: "list", title: `기안서 대장 — ${cond}`, asOf,
      columns: [{ key: "key", label: "권-번호" }, { key: "dt", label: "기안일" }, { key: "vendor", label: "업체" },
        { key: "content", label: "내용" }, { key: "amt", label: "금액(원)", num: true }, { key: "st", label: "종결" }, { key: "scan", label: "스캔본" }],
      rows: top.map((r) => ({ key: r.key, dt: r.draft_dt || "-", vendor: r.vendor || "-", content: String(r.content || "").slice(0, 40),
        amt: Number(r.amt) || 0, st: r.closed === "Y" ? "종결" : "미종결", scan: scanMap.get(r.key)?.file_name || (r.scan_ok ? "○" : "없음") })),
      note: `${comma(rows.length)}건(미종결 ${open}) · 합계 ${comma(total)}원` + (rows.length > show ? ` · 최근 ${show}건 표시` : ""),
      actions: [{ kind: "link", label: "기안서 대장 화면", url: "/work/purchase-proposals" }] } satisfies ViewPayload,
  };
}
