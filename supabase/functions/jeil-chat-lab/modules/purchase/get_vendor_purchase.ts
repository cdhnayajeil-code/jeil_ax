// get_vendor_purchase — 거래처별 매입 집계(14 기획 §4-2 #9 · REQ-0087). 손으로 쓴 모듈.
// 원천: public.v_erp_purchase_monthly(송장 기준 거래처×월 — /work/purchase-vendor 화면과 같은 뷰)
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { comma } from "../../core/util.ts";
import { clean, isYm } from "./_agent_util.ts";

export const manifest: ToolManifest = {
  id: "get_vendor_purchase", version: "1.0.0", domain: "purchase", kind: "read",
  title_ko: "거래처별 매입 집계", summary_ko: "기간 내 거래처 매입 순위, 또는 한 거래처의 월별 매입",
  description_llm: "거래처별 매입(송장 기준) 집계 — 거래처를 지정하지 않으면 기간 내 매입액 상위 거래처 순위, 거래처명을 주면 그 거래처의 월별 매입 추이. " +
    "'올해 거래처별 매입 순위', '3분기 매입 top 10 거래처', '○○사 월별 매입' 류. 기간은 YYYY-MM(기본: 올해 1월~최근월).",
  params: { type: "object", properties: {
    vendor: { type: "string", description: "거래처명(부분일치). 없으면 순위" },
    from_ym: { type: "string", description: "시작월 YYYY-MM" },
    to_ym: { type: "string", description: "종료월 YYYY-MM" },
    n: { type: "integer", description: "순위 건수(기본 10, 최대 30)" },
  }, required: [] },
  perm_module: "purchase", perm_mode: "gate", sensitivity: "amount",
  view: ["ranking", "series"], erp: true, owner: "구매팀", status: "pilot",
  prompt_hint: "거래처 '순위'·'한 거래처의 월별 매입'은 get_vendor_purchase 를 쓰세요(송장 기준 매입).",
};

export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf } = ctx;
  const year = asOf.slice(0, 4);
  const from = isYm(args.from_ym) ? args.from_ym : `${year}-01`;
  const to = isYm(args.to_ym) ? args.to_ym : `${year}-12`;
  const vendor = clean(args.vendor);
  let qb = admin.from("v_erp_purchase_monthly").select("ym,bp_code,bp_name,purchase_amt,iv_cnt").gte("ym", from).lte("ym", to).limit(5000);
  if (vendor) qb = qb.ilike("bp_name", `%${vendor}%`);
  const { data, error } = await qb;
  if (error) return { 오류: "조회 실패: " + error.message };
  // deno-lint-ignore no-explicit-any
  const rows = (data || []) as any[];
  const period = `${from}~${to}`;
  if (!rows.length) {
    return { 기준시각: asOf, 기간: period, 건수: 0, 안내: vendor ? `'${vendor}' 거래처의 매입 기록이 이 기간에 없습니다.` : "이 기간 매입 기록이 없습니다." };
  }
  if (vendor) {
    const names = [...new Set(rows.map((r) => r.bp_name))];
    const byYm: Record<string, number> = {};
    rows.forEach((r) => { byYm[r.ym] = (byYm[r.ym] || 0) + (Number(r.purchase_amt) || 0); });
    const series = Object.keys(byYm).sort().map((k) => ({ k, v: byYm[k] }));
    const sum = series.reduce((n, x) => n + x.v, 0);
    return { 기준시각: asOf, 기간: period, 거래처: names, 월별: series.map((x) => ({ 월: x.k, 매입액_원: x.v })), 합계_원: sum,
      안내: names.length > 1 ? `이름에 '${vendor}' 가 들어간 거래처 ${names.length}곳을 합산했습니다: ${names.join(", ")}` : undefined,
      __view: { view: "series", title: `${names.length > 1 ? `'${vendor}' 포함 ${names.length}곳` : names[0]} 월별 매입 (${period})`, unit: "원", asOf,
        rows: series, note: `합계 ${comma(sum)}원 · 송장 기준` } satisfies ViewPayload };
  }
  const agg = new Map<string, { name: string; amt: number; cnt: number }>();
  rows.forEach((r) => {
    const a = agg.get(r.bp_code) || { name: r.bp_name, amt: 0, cnt: 0 };
    a.amt += Number(r.purchase_amt) || 0; a.cnt += Number(r.iv_cnt) || 0; agg.set(r.bp_code, a);
  });
  const n = Math.min(Math.max(Number(args.n) || 10, 1), 30);
  const ranked = [...agg.entries()].sort((a, b) => b[1].amt - a[1].amt);
  const total = ranked.reduce((s, [, a]) => s + a.amt, 0);
  const top = ranked.slice(0, n);
  return { 기준시각: asOf, 기간: period, 거래처수: ranked.length, 전체매입_원: total,
    순위: top.map(([code, a], i) => ({ 순위: i + 1, 거래처: a.name, 거래처코드: code, 매입액_원: a.amt, 송장건수: a.cnt,
      비중_퍼센트: total ? Math.round(a.amt / total * 1000) / 10 : 0 })),
    __view: { view: "ranking", title: `거래처별 매입 상위 ${top.length} (${period})`, unit: "원", asOf,
      rows: top.map(([, a], i) => ({ rank: i + 1, label: a.name, v: a.amt, sub: `송장 ${a.cnt}건 · 비중 ${total ? (a.amt / total * 100).toFixed(1) : 0}%` })),
      note: `거래처 ${ranked.length}곳 · 전체 ${comma(total)}원 · 송장 기준`,
      actions: top.length ? [{ kind: "ask", label: `1위 ${top[0][1].name} 프로필`, prompt: `${top[0][1].name} 거래처 프로필 보여줘` }] : [] } satisfies ViewPayload };
}
