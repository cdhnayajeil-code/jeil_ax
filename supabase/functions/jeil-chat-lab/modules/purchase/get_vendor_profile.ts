// get_vendor_profile — 거래처 한 장 요약(14 기획 §4-2 #12 · REQ-0087). 손으로 쓴 모듈.
// 원천: v_erp_purchase_monthly(매입) · v_erp_pur_order_hdr(발주) · v_erp_po_pr_link(미입고·납기경과)
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { comma } from "../../core/util.ts";
import { clean } from "./_agent_util.ts";

export const manifest: ToolManifest = {
  id: "get_vendor_profile", version: "1.0.0", domain: "purchase", kind: "read",
  title_ko: "거래처 프로필", summary_ko: "거래처 1곳의 최근 12개월 매입·발주·미입고·납기경과를 한 장으로",
  description_llm: "거래처 한 장 요약 — 거래처명(부분일치)으로 최근 12개월 매입액(송장)·발주 건수·발주액·진행중 발주·미입고 라인·납기경과 미입고·최근 발주일·주요 품목. " +
    "'○○사 어때', '○○ 거래처 요약', '○○ 납기 잘 지켜?' 류. 이름이 여러 곳과 맞으면 후보를 돌려주니 다시 좁혀 물어라.",
  params: { type: "object", properties: {
    vendor: { type: "string", description: "거래처명(부분일치) 또는 거래처코드" },
  }, required: ["vendor"] },
  perm_module: "pur_order", perm_mode: "gate", sensitivity: "amount",
  view: ["record", "notice"], erp: true, owner: "구매팀", status: "pilot",
};

function ymBack(asOf: string, months: number): string {
  const d = new Date(asOf); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 7);
}

export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf } = ctx;
  const v = clean(args.vendor);
  if (!v) return { 오류: "거래처명을 알려 주세요." };
  // 1) 거래처 확정 — 발주 헤더에서 이름/코드로 찾는다
  const { data: cands } = await admin.from("v_erp_pur_order_hdr").select("bp_code,bp_name")
    .or(`bp_name.ilike.*${v}*,bp_code.eq.${v}`).limit(500);
  const uniq = new Map<string, string>();
  // deno-lint-ignore no-explicit-any
  ((cands || []) as any[]).forEach((r) => uniq.set(r.bp_code, r.bp_name));
  if (!uniq.size) {
    return { 기준시각: asOf, 건수: 0, 안내: `'${v}' 와 맞는 발주 거래처가 없습니다. 이름을 다르게 적어 보세요.`,
      __view: { view: "notice", title: "거래처를 찾지 못했습니다", kind: "info", text: `'${v}' 와 맞는 발주 거래처가 없습니다.` } };
  }
  if (uniq.size > 1) {
    const exact = [...uniq.entries()].find(([c, n]) => n === v || c === v);
    if (!exact) {
      const list = [...uniq.entries()].slice(0, 10).map(([c, n]) => `${n}(${c})`);
      return { 기준시각: asOf, 후보: list, 안내: `'${v}' 와 맞는 거래처가 ${uniq.size}곳입니다. 어느 곳인지 골라 주세요.`,
        __view: { view: "notice", title: "거래처 후보", kind: "info", text: `'${v}' 와 맞는 거래처 ${uniq.size}곳 — ${list.join(", ")}`,
          actions: [...uniq.values()].slice(0, 4).map((n) => ({ kind: "ask", label: n, prompt: `${n} 거래처 프로필 보여줘` })) } };
    }
    uniq.clear(); uniq.set(exact[0], exact[1]);
  }
  const [code, name] = [...uniq.entries()][0];
  const from = ymBack(asOf, 11);
  const since = `${from}-01`;
  const [pm, po, link] = await Promise.all([
    admin.from("v_erp_purchase_monthly").select("ym,purchase_amt,iv_cnt").eq("bp_code", code).gte("ym", from),
    admin.from("v_erp_pur_order_hdr").select("po_no,po_dt,amt,po_sts,items_txt").eq("bp_code", code).gte("po_dt", since).order("po_dt", { ascending: false }).limit(1000),
    admin.from("v_erp_po_pr_link").select("po_no,item_name,po_dlvy_dt,po_qty,po_rcpt_qty,overdue_unreceived,cls_flg").eq("po_vendor", name).limit(2000),
  ]);
  // deno-lint-ignore no-explicit-any
  const pmr = (pm.data || []) as any[]; const por = (po.data || []) as any[]; const lk = (link.data || []) as any[];
  const buy = pmr.reduce((n, r) => n + (Number(r.purchase_amt) || 0), 0);
  const poAmt = por.reduce((n, r) => n + (Number(r.amt) || 0), 0);
  const openPo = por.filter((r) => r.po_sts === "PO").length;
  const unrec = lk.filter((r) => Number(r.po_rcpt_qty || 0) < Number(r.po_qty || 0) && r.cls_flg !== "Y");
  const overdue = unrec.filter((r) => r.overdue_unreceived);
  const itemCnt: Record<string, number> = {};
  lk.forEach((r) => { if (r.item_name) itemCnt[r.item_name] = (itemCnt[r.item_name] || 0) + 1; });
  const topItems = Object.entries(itemCnt).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  const last = por[0]?.po_dt || null;
  const fields = [
    { k: "거래처", v: `${name} (${code})` },
    { k: "매입(12개월)", v: `${comma(buy)}원 · 송장 ${pmr.reduce((n, r) => n + (Number(r.iv_cnt) || 0), 0)}건` },
    { k: "발주(12개월)", v: `${por.length}건 · ${comma(poAmt)}원` },
    { k: "진행중 발주", v: `${openPo}건(입고 전)` },
    { k: "미입고 라인", v: `${unrec.length}라인` },
    { k: "납기경과 미입고", v: `${overdue.length}라인` },
    { k: "최근 발주일", v: last || "-" },
    { k: "주요 품목", v: topItems.join(", ") || "-" },
  ];
  return {
    기준시각: asOf, 기간: `${from}~${asOf.slice(0, 7)}`, 거래처: name, 거래처코드: code,
    매입액_12개월_원: buy, 발주건수: por.length, 발주액_원: poAmt, 진행중발주: openPo, 미입고라인: unrec.length, 납기경과미입고라인: overdue.length,
    최근발주일: last, 주요품목: topItems,
    납기경과목록: overdue.slice(0, 10).map((r) => ({ 발주번호: r.po_no, 품목: r.item_name, 납기: r.po_dlvy_dt, 발주수량: r.po_qty, 입고수량: r.po_rcpt_qty })),
    __view: { view: "record", title: `거래처 프로필 — ${name}`, asOf, fields,
      note: "매입=송장 기준 · 발주=발주일 기준 최근 12개월 · 미입고=종결 제외",
      actions: [
        ...(overdue.length ? [{ kind: "ask", label: "납기경과 목록", prompt: `${name} 납기 지난 미입고 발주 목록 보여줘` }] : []),
        { kind: "ask", label: "월별 매입 추이", prompt: `${name} 월별 매입 보여줘` }] } satisfies ViewPayload,
  };
}
