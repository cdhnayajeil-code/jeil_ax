// get_proposal_recon — 기안서 대장 ↔ ERP 전표·세금계산서 대사(14 기획 §4-2 #11 · REQ-0087 · 원 기능 REQ-0081/0082). 손으로 쓴 모듈.
// 원천: public.agent_proposal_recon(p_upn) — 화면과 **같은** proposal_recon_list() 를 로그인 사용자 권한으로 부른다(SQL 74 §12).
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { comma } from "../../core/util.ts";
import { RECON_KO, STAGE_KO, canProposal, clean, proposalDeny } from "./_agent_util.ts";

export const manifest: ToolManifest = {
  id: "get_proposal_recon", version: "1.0.0", domain: "purchase", kind: "read",
  title_ko: "기안서 ↔ 전표 대사", summary_ko: "기안서 대장 전표번호 칸별 ERP 전표·세금계산서 대사 결과",
  description_llm: "기안서 대장의 전표번호 칸(선급·중도·잔금)마다 ERP 전표·전자세금계산서와 금액을 맞춘 대사 결과. " +
    "등급: 일치·세액차(정상)·합산·분할(기계 판단 불가)·계산서없음·전표없음·확인필요(금액 불일치)·미기재. " +
    "'대사 현황', '금액 안 맞는 기안서', '전표 없는 건', '○○ 업체 대사' 류. grade 로 등급을 좁히고 q 로 업체를 좁힌다.",
  params: { type: "object", properties: {
    grade: { type: "string", enum: ["확인필요", "전표없음", "계산서없음", "합산·분할", "일치", "세액차", "미기재", "요처리"],
      description: "등급. '요처리' = 확인필요+전표없음" },
    q: { type: "string", description: "업체명(대장·전표) 부분일치" },
    limit: { type: "integer", description: "표시 건수(기본 20, 최대 100)" },
  }, required: [] },
  perm_module: null, perm_mode: "partial", sensitivity: "amount",
  view: ["series", "list", "notice"], erp: true, owner: "구매팀", status: "pilot",
  prompt_hint: "기안서 대사에서 붉은 등급은 '확인필요'·'전표없음' 둘뿐입니다. '합산·분할'은 틀린 것이 아니라 기계가 판단할 수 없다는 뜻이니 오류로 단정하지 마세요.",
};

export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope } = ctx;
  if (!canProposal(scope)) return proposalDeny();
  const { data, error } = await admin.rpc("agent_proposal_recon", { p_upn: scope.upn });
  if (error) return { 오류: "대사 조회 실패: " + error.message };
  // deno-lint-ignore no-explicit-any
  const all = ((data?.rows) || []) as any[];
  const counts: Record<string, number> = {};
  all.forEach((r) => { const k = RECON_KO[r.recon ?? ""] || String(r.recon); counts[k] = (counts[k] || 0) + 1; });
  const want = typeof args.grade === "string" ? args.grade : "";
  const q = clean(args.q).toLowerCase();
  const pick = all.filter((r) => {
    const g = RECON_KO[r.recon ?? ""] || "";
    if (want === "요처리" ? !(r.recon === "diff" || r.recon === "noslip") : want && g !== want) return false;
    if (q && !(`${r.ledger_vendor || ""} ${r.slip_vendor || ""}`.toLowerCase().includes(q))) return false;
    return true;
  });
  const show = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
  const top = pick.slice(0, show);
  const order = ["확인필요", "전표없음", "계산서없음", "합산·분할", "세액차", "일치", "미기재"];
  return {
    기준시각: asOf, 대장적재: data?.as_of || null, 미러기준: data?.mirror_as_of || null, 대사칸수: all.length, 등급별: counts,
    조건: [want, q && `업체 '${q}'`].filter(Boolean).join(" · ") || "전체", 해당: pick.length,
    목록: top.map((r) => ({ 권번호: r.key, 단계: STAGE_KO[r.stage] || r.stage, 대장금액_원: Number(r.ledger_amt) || 0, 전표: r.slip_raw,
      등급: RECON_KO[r.recon ?? ""] || r.recon, 대장업체: r.ledger_vendor, 전표업체: r.slip_vendor, 표시: r.flags || [] })),
    __view: pick.length && (want || q)
      ? { view: "list", title: `기안서 대사 — ${want || "전체"}${q ? ` · '${q}'` : ""}`, asOf,
          columns: [{ key: "key", label: "권-번호" }, { key: "st", label: "단계" }, { key: "amt", label: "대장금액(원)", num: true },
            { key: "slip", label: "전표" }, { key: "g", label: "등급" }, { key: "v", label: "업체" }],
          rows: top.map((r) => ({ key: r.key, st: STAGE_KO[r.stage] || r.stage, amt: Number(r.ledger_amt) || 0, slip: r.slip_raw || "-",
            g: RECON_KO[r.recon ?? ""] || r.recon, v: r.ledger_vendor || "-" })),
          note: `${comma(pick.length)}칸` + (pick.length > show ? ` · ${show}칸 표시` : "") + (data?.mirror_as_of ? ` · ERP 미러 ${String(data.mirror_as_of).slice(0, 10)}` : ""),
          actions: [{ kind: "link", label: "기안서 대장 화면에서 근거 보기", url: "/work/purchase-proposals" }] } satisfies ViewPayload
      : { view: "series", title: "기안서 대사 등급별 칸 수", unit: "칸", asOf,
          rows: order.filter((k) => counts[k]).map((k) => ({ k, v: counts[k] })),
          note: `대사 ${comma(all.length)}칸 · 붉은 등급은 확인필요·전표없음`,
          actions: [{ kind: "ask", label: "요처리 건 보기", prompt: "기안서 대사에서 확인필요·전표없음 건 보여줘" }] } satisfies ViewPayload,
  };
}
