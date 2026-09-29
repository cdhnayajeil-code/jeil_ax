// get_proposal_chain — 기안서 한 건의 연결 전체(REQ-0092 · 12_에이전트관리/04). 손으로 쓴 모듈.
//   기안서(권-번호) → 스캔본(문서중앙화 · 파일명·존재 여부만) → 전표(TG/GL)·대사 등급 → 세금계산서(국세청 승인번호)
//   → 매입(IV) → 발주(PO) → 결재(PU)·구매요청(PR)
// 원천: v_pur_proposal_case · pur_proposal · pur_proposal_scan(야간 자동 갱신 proposal_scan) ·
//       agent_proposal_recon_detail(upn, 권, 번호)(SQL 76 — 화면과 같은 대사 상세) · v_pur_proposal_po_link(SQL 76) · v_erp_pur_list
// 권한: 기안서 대장 화면 권한(purchase_proposal_2026). 발주·결재·요청 부분은 ERP 모듈 pur_order 가 있을 때만 보인다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { comma, hasModule } from "../../core/util.ts";
import { RECON_KO, STAGE_KO, canProposal, proposalDeny } from "./_agent_util.ts";

export const manifest: ToolManifest = {
  id: "get_proposal_chain", version: "1.0.0", domain: "purchase", kind: "read",
  title_ko: "기안서 연결 추적", summary_ko: "기안서 → 스캔본 → 전표·세금계산서 → 매입 → 발주 → 결재·구매요청 한 장",
  description_llm: "구매 기안서 한 건의 처리 연결 전체를 한 번에 본다: 기안 내용·금액 → 문서중앙화 스캔본(파일명·존재 여부) → 대장 전표번호(선급·중도·잔금)와 ERP 전표·금액 대사 등급 → 국세청 세금계산서(승인번호·공급가·세액) → 매입(IV) → 발주(PO) → 결재번호(PU)·구매요청(PR)·진행상태. " +
    "기안서 권-번호(예 9-830)로 묻거나, 발주번호(PO…)·결재번호(PU…)·구매요청번호(PR…)로 '어느 기안서에서 나왔나'를 물을 때 쓴다. '9-830 기안 어디까지 처리됐어?', '9-830 스캔본 있어?', 'PO202609230004 는 어느 기안서야?'.",
  params: { type: "object", properties: {
    proposal: { type: "string", description: "기안서 권-번호(예 9-830)" },
    po: { type: "string", description: "발주번호 PO… — 이 발주가 연결된 기안서를 찾는다" },
    pu: { type: "string", description: "결재번호 PU… — 이 결재의 발주가 연결된 기안서를 찾는다" },
    pr: { type: "string", description: "구매요청번호 PR…" },
  }, required: [] },
  perm_module: null, perm_mode: "partial", sensitivity: "amount",
  view: ["record", "list", "notice"], erp: true, owner: "구매팀", status: "pilot",
  prompt_hint: "기안서(권-번호)와 전표·세금계산서·스캔본·발주의 연결을 묻거나, 발주/결재/요청 번호로 기안서를 찾을 때는 get_proposal_chain 을 쓰세요. " +
    "발주 연결의 '확정'은 전표→매입→발주로 따라간 것이고 '추정'은 프로젝트(JOB번호=P-CODE)·거래처·금액이 맞는 것입니다 — 추정이면 반드시 추정이라고 밝히세요. " +
    "스캔본은 파일명·존재 여부만 확인합니다(내용은 읽지 않음). 스캔본 목록은 매일 밤 자동 갱신되니 확인 시각을 함께 알려 주세요.",
};

const num = (v: unknown, pre: string) => { const s = String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""); return s.startsWith(pre) && s.length >= 14 ? s : ""; };
const keyOf = (v: unknown): [number, number] | null => { const m = /^\s*(\d{1,3})\s*-\s*(\d{1,5})\s*$/.exec(String(v ?? "")); return m ? [+m[1], +m[2]] : null; };

export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope } = ctx;
  if (!canProposal(scope)) return proposalDeny();
  const seePo = hasModule(scope, "pur_order");

  // ── 1) 기안서 특정: 권-번호 직접, 또는 PO/PU/PR → 발주 → 연결 뷰 → 기안서 ──
  let key = keyOf(args.proposal);
  const PO = num(args.po, "PO"), PU = num(args.pu, "PU"), PR = num(args.pr, "PR");
  if (!key && (PO || PU || PR)) {
    if (!seePo) return { 접근제한: true, 안내: "발주·결재·구매요청 번호로 찾으려면 ERP '발주·구매요청' 모듈 권한이 필요합니다." };
    let pos: string[] = PO ? [PO] : [];
    if (!PO) {
      const { data } = await admin.from("v_erp_pur_list").select("po_no").eq(PU ? "pu_no" : "pr_no", PU || PR).not("po_no", "is", null).limit(200);
      pos = [...new Set(((data || []) as { po_no: string }[]).map((r) => r.po_no))];
      if (!pos.length) return { 기준시각: asOf, 건수: 0, 안내: `${PU || PR} 에 연결된 발주가 아직 없어 기안서를 찾을 수 없습니다(미발주).` };
    }
    const { data: links } = await admin.from("v_pur_proposal_po_link").select("vol,no,key,po_no,method,confidence").in("po_no", pos.slice(0, 100));
    // deno-lint-ignore no-explicit-any
    const ls = (links || []) as any[];
    const keys = [...new Map(ls.map((l) => [l.key, l])).values()];
    if (!keys.length) {
      return { 기준시각: asOf, 건수: 0, 안내: `${PO || PU || PR} 과 연결된 기안서를 찾지 못했습니다 — 기안서 대장에 전표가 아직 없거나, 프로젝트·거래처·금액으로 한 건이 특정되지 않았습니다.`,
        __view: { view: "notice", title: "연결된 기안서 없음", kind: "info", text: `${PO || PU || PR}: 연결된 기안서를 찾지 못했습니다(전표 미기재 또는 추정 불가).` } satisfies ViewPayload };
    }
    if (keys.length > 1) {
      const { data: cs } = await admin.from("v_pur_proposal_case").select("key,draft_dt,vendor,content,amt").in("key", keys.map((k) => k.key).slice(0, 30));
      // deno-lint-ignore no-explicit-any
      const byKey = new Map(((cs || []) as any[]).map((c) => [c.key, c]));
      return { 기준시각: asOf, 조건: PO || PU || PR, 기안서수: keys.length,
        목록: keys.map((k) => ({ 권번호: k.key, 발주: k.po_no, 연결: `${k.confidence}(${k.method})`, 업체: byKey.get(k.key)?.vendor, 내용: byKey.get(k.key)?.content, 금액_원: Number(byKey.get(k.key)?.amt) || 0 })),
        __view: { view: "list", title: `${PO || PU || PR} 에 연결된 기안서 ${keys.length}건`, asOf,
          columns: [{ key: "k", label: "권-번호" }, { key: "po", label: "발주" }, { key: "c", label: "연결" }, { key: "v", label: "업체" }, { key: "t", label: "내용" }, { key: "a", label: "금액(원)", num: true }],
          rows: keys.slice(0, 30).map((k) => ({ k: k.key, po: k.po_no, c: k.confidence, v: byKey.get(k.key)?.vendor || "-", t: String(byKey.get(k.key)?.content || "").slice(0, 30), a: Number(byKey.get(k.key)?.amt) || 0 })),
          actions: keys.slice(0, 3).map((k) => ({ kind: "ask", label: `${k.key} 연결 전체`, prompt: `기안서 ${k.key} 연결 전체 보여줘` })) } satisfies ViewPayload };
    }
    key = [keys[0].vol, keys[0].no];
  }
  if (!key) return { 오류: "기안서 권-번호(예 9-830) 또는 발주·결재·구매요청 번호를 알려 주세요." };
  const [vol, no] = key; const k = `${vol}-${no}`;

  // ── 2) 기안·스캔·대사·발주 연결을 한 번에 ──
  const [caseR, scanR, detR, linkR] = await Promise.all([
    admin.from("v_pur_proposal_case").select("key,draft_dt,drafter,job_no,project,customer,content,vendor,amt,lines,no_slip_lines,closed,scan_ok,src_updated").eq("vol", vol).eq("no", no).maybeSingle(),
    admin.from("pur_proposal_scan").select("file_name,size_kb,file_mtime,matched,checked_at").eq("vol", vol).eq("no", no).maybeSingle(),
    admin.rpc("agent_proposal_recon_detail", { p_upn: scope.upn, p_vol: vol, p_no: no }),
    seePo ? admin.from("v_pur_proposal_po_link").select("po_no,method,confidence,slips,iv_nos").eq("vol", vol).eq("no", no) : Promise.resolve({ data: null }),
  ]);
  // deno-lint-ignore no-explicit-any
  const c = caseR.data as any;
  if (!c) return { 기준시각: asOf, 건수: 0, 안내: `기안서 ${k} 가 중간DB 기안서 대장에 없습니다. 번호를 확인하거나, 최근 기안이면 대장 적재(Teams 엑셀 → 중간DB)가 아직 안 된 것일 수 있습니다.`,
    __view: { view: "notice", title: `기안서 ${k} 없음`, kind: "info", text: `기안서 대장에 ${k} 가 없습니다.` } satisfies ViewPayload };
  // deno-lint-ignore no-explicit-any
  const sc = scanR.data as any;
  // deno-lint-ignore no-explicit-any
  const stages = ((detR.data?.stages) || []) as any[];
  // deno-lint-ignore no-explicit-any
  const links = ((linkR as any).data || []) as any[];

  // 전표·계산서 요약(단계별) — 대사 등급은 목록 RPC 와 같은 라벨
  const { data: recon } = await admin.rpc("agent_proposal_recon", { p_upn: scope.upn });
  // deno-lint-ignore no-explicit-any
  const cells = (((recon?.rows) || []) as any[]).filter((r) => r.key === k);
  const slipRows = cells.map((r) => ({ 단계: STAGE_KO[r.stage] || r.stage, 전표: r.slip_raw || "-", 대장금액_원: Number(r.ledger_amt) || 0, 등급: RECON_KO[r.recon ?? ""] || r.recon, 표시: r.flags || [] }));
  const invoices = stages.flatMap((s) => (s.invoices || []).map((iv: Record<string, unknown>) => {
    const n = (iv.nts || {}) as Record<string, unknown>;
    return { 단계: STAGE_KO[s.stage] || s.stage, 전표: s.slip_no || s.tok, 승인번호: n.aprv_no || null, 발행일: n.issue_date || iv.dt || null,
      공급가_원: Number(n.supply ?? iv.supply) || 0, 세액_원: Number(n.vat ?? iv.vat) || 0, 공급자: n.sup_nm || null, 품목: n.item_nm || null };
  }));
  const glNos = [...new Set(stages.map((s) => s.gl_no).filter(Boolean))];

  // 발주 → 결재·요청·상태
  const confirmed = links.filter((l) => l.confidence === "확정");
  const guessed = links.filter((l) => l.confidence === "추정");
  const poNos = [...new Set(links.map((l) => l.po_no))];
  // deno-lint-ignore no-explicit-any
  let poRows: any[] = [];
  if (seePo && poNos.length) {
    const { data } = await admin.from("v_erp_pur_list").select("po_no,pr_no,pu_no,status_kr,amt,po_dt,bp_name").in("po_no", poNos.slice(0, 50)).limit(2000);
    poRows = data || [];
  }
  const pus = [...new Set(poRows.map((r) => r.pu_no).filter(Boolean))];
  const prs = [...new Set(poRows.map((r) => r.pr_no).filter(Boolean))];
  const st: Record<string, number> = {}; poRows.forEach((r) => { st[r.status_kr] = (st[r.status_kr] || 0) + 1; });
  const poAmt = poRows.reduce((n, r) => n + (Number(r.amt) || 0), 0);

  const scanTxt = sc?.matched ? `있음 — ${sc.file_name}${sc.size_kb ? ` (${comma(sc.size_kb)}KB)` : ""}` : "없음";
  const kst = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
  const scanAt = sc?.checked_at ? kst(sc.checked_at) : null;
  const worst = cells.map((r) => r.recon).sort((a, b) => ["diff", "noslip", "noinv", "split", "none", "vat", "match"].indexOf(a) - ["diff", "noslip", "noinv", "split", "none", "vat", "match"].indexOf(b))[0];
  const poTxt = !seePo ? "(ERP 발주 권한 없음)" : !poNos.length ? "연결 없음(전표 미기재 또는 추정 불가)"
    : `${poNos.length}건 · ${confirmed.length ? "확정(전표 경유)" : `추정(${guessed[0]?.method})`}`;

  const fields = [
    { k: "기안서", v: `${k} · ${c.draft_dt || "-"} · ${c.drafter || "-"}` },
    { k: "업체·내용", v: `${c.vendor || "-"} — ${String(c.content || "").slice(0, 60)}` },
    { k: "금액", v: `${comma(Number(c.amt) || 0)}원${c.closed === "Y" ? " · 종결" : " · 미종결"}` },
    { k: "JOB·프로젝트", v: `${c.job_no || "-"} ${c.project ? "· " + c.project : ""}` },
    { k: "스캔본", v: scanTxt + (scanAt ? ` · 확인 ${scanAt}` : "") },
    { k: "전표", v: cells.length ? `${cells.length}칸 · ${glNos.length ? "GL " + glNos.slice(0, 3).join(", ") : "전표번호 " + cells.map((r) => r.slip_raw).filter(Boolean).slice(0, 3).join(", ")} · 대사 ${RECON_KO[worst ?? ""] || "-"}` : "전표 미기재" },
    { k: "세금계산서", v: invoices.length ? `${invoices.length}장 · 승인번호 ${invoices.map((i) => i.승인번호).filter(Boolean).slice(0, 2).join(", ") || "-"}` : "연결 없음" },
    { k: "발주(PO)", v: poTxt + (poNos.length ? ` · ${poNos.slice(0, 3).join(", ")}${poNos.length > 3 ? " 외" : ""}` : "") },
    ...(seePo && poNos.length ? [
      { k: "결재(PU)·요청(PR)", v: `결재 ${pus.length}건${pus.length ? " (" + pus.slice(0, 3).join(", ") + (pus.length > 3 ? " 외" : "") + ")" : ""} · 요청 ${prs.length}줄` },
      { k: "발주 진행", v: Object.entries(st).map(([s, n]) => `${s} ${n}`).join(" · ") + ` · 발주금액 ${comma(poAmt)}원` },
    ] : []),
  ];
  // 단계 표시: 기안 → 스캔 → 전표 → 계산서 → 발주
  const done = [true, !!sc?.matched, cells.length > 0, invoices.length > 0, poNos.length > 0];
  const cur = done.indexOf(false);

  return {
    기준시각: asOf, 기안서: { 권번호: k, 기안일: c.draft_dt, 기안자: c.drafter, JOB: c.job_no, 프로젝트: c.project, 고객사: c.customer, 업체: c.vendor, 내용: c.content, 금액_원: Number(c.amt) || 0, 종결: c.closed === "Y", 대장적재: c.src_updated },
    스캔본: { 있음: !!sc?.matched, 파일명: sc?.file_name || null, 크기KB: sc?.size_kb || null, 파일수정일: sc?.file_mtime || null, 목록확인시각: sc?.checked_at || null, 안내: "문서중앙화 스캔본은 파일명·존재 여부만 확인(내용 미열람) · 목록은 매일 밤 자동 갱신" },
    전표: slipRows, 세금계산서: invoices,
    발주연결: seePo ? { 건수: poNos.length, 방법: confirmed.length ? "확정(전표→매입→발주)" : guessed.length ? `추정(${guessed[0].method})` : "없음",
      매입IV: [...new Set(confirmed.flatMap((l) => l.iv_nos || []))].slice(0, 10), 발주: poNos.slice(0, 20), 결재PU: pus.slice(0, 20), 구매요청PR줄수: prs.length, 상태별줄수: st, 발주금액_원: poAmt } : "ERP 발주 권한 없음",
    __view: { view: "record", title: `기안서 ${k} 연결 전체`, asOf, fields,
      steps: { labels: ["기안", "스캔본", "전표", "세금계산서", "발주"], current: cur < 0 ? 5 : cur },
      note: (guessed.length && !confirmed.length ? "발주 연결은 추정(프로젝트·거래처·금액) · " : "") + "스캔본은 파일명·존재 여부만",
      actions: [
        { kind: "link", label: "기안서 대장에서 근거 보기", url: "/work/purchase-proposals" },
        ...(poNos.length === 1 ? [{ kind: "ask", label: `${poNos[0]} 단계별 상세`, prompt: `발주 ${poNos[0]} 상세 조회해줘` }] : []),
        ...(pus.length ? [{ kind: "ask", label: "결재번호별 진행", prompt: `결재번호 ${pus[0]} 로 묶인 구매요청 진행 보여줘` }] : []),
      ] } satisfies ViewPayload,
  };
}
