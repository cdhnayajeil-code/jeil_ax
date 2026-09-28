// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts runTool 의 인사 2종 공유 분기. 손으로 고치지 말 것.
import type { ToolCtx, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

// deno-lint-ignore no-unused-vars
export async function runHr(ctx: ToolCtx, name: string): Promise<unknown> {
  const { admin, args, asOf, scope } = ctx;

    const wantsPay = name === "get_hr_payroll";
    const canDetail = hasModule(scope, "payroll");   // 부서별 분포·금액 열람 가능 여부(인사팀·관리자)
    // 민감 데이터 접근은 허용·거부 모두 감사 기록(jeil-hr와 동일 원장)
    try { await admin.rpc("hr_access_log_add", { p_upn: scope.upn, p_dept: scope.dept, p_ok: canDetail }); } catch { /* 무시 */ }
    if (wantsPay && !canDetail) {
      const 안내 = `급여 집계는 인사팀(또는 포털 관리자)만 열람할 수 있습니다. 회원님 소속(${scope.dept || "미지정"})은 권한 범위 밖입니다. 인원 수만 필요하시면 '인원현황'으로 다시 물어보세요(전사 총원은 조회 가능).`;
      return { 접근제한: true, 요청안내: true, 모듈: "payroll", 부서: scope.dept || "미지정", 안내,
        __view: { view: "notice", title: "급여 데이터 접근 제한", kind: "deny", text: 안내,
          request: { ui: "perm", kind: "perm_sensitive", module: "payroll", moduleKo: "급여·인사", dept: scope.dept || "미지정" },
          actions: [
            { kind: "ask", label: "전사 인원현황만 보기", prompt: "2026년 월별 전사 인원현황 보여줘" },
            { kind: "ask", label: "권한 요청 초안 작성", prompt: "포털 관리자에게 보낼 급여·인사(payroll) ERP 모듈 권한 요청 메시지 초안을 사내 메신저용으로 간결하게 작성해줘. 요청 사유 한 줄을 포함하고, 내가 복사해서 직접 보낼 수 있는 형태로." },
          ] } satisfies ViewPayload };
    }
    const ymF = String(args.ym || "").replace(/[^0-9]/g, "").slice(0, 6);   // 'YYYY-MM'·'YYYYMM' 모두 수용
    // erp_secure 는 REST 미노출 → service_role RPC로만 조회
    // deno-lint-ignore no-explicit-any
    const { data: pr, error } = await admin.rpc("hr_payroll_get");
    if (error) return { 오류: "인사 집계 조회 실패: " + error.message };
    // deno-lint-ignore no-explicit-any
    const rows = ((pr || []) as any[]).filter((r) => !ymF || String(r.ym) === ymF);
    if (!rows.length) {
      // 기간 밖 무데이터 — 평문 대신 카드 + 적용요청 경로(§14-6 P2b)
      const p = gapOf(await loadLoadScope(admin, "payroll"), "*");
      const 안내 = "해당 기간 인사 집계 데이터가 없습니다. 현재 중간DB는 2026년 이후만 월별 적재되어 있습니다.";
      return { 기준시각: asOf, 조건: ymF || "전체", 건수: 0, 안내,
        __view: { view: "notice", title: "인사 집계 — 적재범위 밖", kind: "info", text: 안내,
          actions: [{ kind: "ask", label: "2026년 인원현황 보기", prompt: "2026년 월별 전사 인원현황 보여줘" }],
          ...(p ? { request: { ui: "data", kind: "data", module: "payroll", moduleKo: "급여·인사",
            dept: scope.dept || "미지정", confirm_first: true,
            gap: { type: "period", detail: p.label_ko, fix_type: p.fix_type } } } : {}),
        } satisfies ViewPayload };
    }
    const byYm: Record<string, { hc: number; pay: number; ret: number; depts: number }> = {};
    for (const r of rows) {
      const m = (byYm[r.ym] = byYm[r.ym] || { hc: 0, pay: 0, ret: 0, depts: 0 });
      m.hc += Number(r.headcount || 0); m.pay += Number(r.pay_tot_amt || 0);
      m.ret += Number(r.retire_amt || 0); m.depts += 1;
    }
    const 월별 = Object.keys(byYm).sort().map((y) => ({
      월: `${y.slice(0, 4)}-${y.slice(4, 6)}`, 급여대상인원: byYm[y].hc, 부서수: byYm[y].depts,
      ...(wantsPay && canDetail ? { 급여총액_원: byYm[y].pay, 퇴직급여_원: byYm[y].ret } : {}),
    }));
    // 뷰: 인원(명) 또는 급여총액(원) 월별 시리즈 — 전사 총원은 전 직원, 급여는 권한 통과자만 이 지점에 도달
    const hrView: ViewPayload = { view: "series",
      title: wantsPay ? "월별 급여총액(전사)" : "월별 급여대상 인원(전사)",
      unit: wantsPay ? "원" : "명", asOf,
      // deno-lint-ignore no-explicit-any
      rows: (월별 as any[]).slice(-24).map((m) => ({ k: String(m.월), v: wantsPay ? Number(m.급여총액_원 || 0) : Number(m.급여대상인원 || 0) })),
      note: "급여대장(HDF070T) 기준 · 마감 전 변동 가능" + (wantsPay ? " · 집계만(개인별 없음)" : ""),
      // 후속질문 칩 — 권한 보유자(인사팀·관리자)에게만 급여 방향 유도(비권한자에게 차단 질문 유도 금지)
      ...(!wantsPay && canDetail ? { actions: [{ kind: "ask", label: "월별 급여총액 추이 보기", prompt: "2026년 월별 급여총액 추이 보여줘" }] } : {}) };
    const base = { 기준시각: asOf, 조건: ymF ? `${ymF.slice(0, 4)}-${ymF.slice(4, 6)}` : "전체 기간", 월별 };
    if (!canDetail) {
      return { ...base, 부서별: "권한 없음(비표시)",
        안내: "전사 총원(월별)만 제공됩니다. 부서별 인원 분포·급여액은 인사팀·관리자 전용입니다 — 필요 시 포털 관리자에게 요청하세요. 인원은 급여대장(HDF070T) 기준 급여대상 인원이며 마감 전 변동될 수 있습니다. 이 수치로 부서별 인원을 추정하지 마세요.",
        __view: hrView };
    }
    const 부서별 = rows
      // deno-lint-ignore no-explicit-any
      .map((r: any) => ({ 월: `${String(r.ym).slice(0, 4)}-${String(r.ym).slice(4, 6)}`, 부서: r.dept_nm, 인원: Number(r.headcount || 0),
        ...(wantsPay ? { 급여총액_원: Number(r.pay_tot_amt || 0), 퇴직급여_원: Number(r.retire_amt || 0) } : {}) }))
      .sort((a, b) => (a.월 === b.월 ? b.인원 - a.인원 : (a.월 < b.월 ? 1 : -1)))
      .slice(0, 120);
    return { ...base, 부서별, 열람권한: scope.isAdmin ? "관리자" : "인사팀",
      안내: `인원은 급여대장(HDF070T) 기준 급여대상 인원으로 마감 전 변동될 수 있습니다. ${wantsPay ? "급여는 집계(총액·인원)만이며 개인별·주민번호·계좌는 중간DB에 없습니다. " : ""}민감 데이터 접근은 감사 기록(hr_access_log)됩니다 — 답변에 개인 식별 정보를 포함하지 마세요.`,
      __view: hrView };
  }
