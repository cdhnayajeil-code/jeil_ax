// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest } from "../../core/types.ts";
import { runHr } from "./_hr_impl.ts";

export const manifest: ToolManifest = {
  id: "get_hr_headcount", version: "1.0.0", domain: "hr", kind: "read",
  title_ko: "인원현황", summary_ko: "월별 급여대상 인원(부서별은 payroll 보유자만)",
  description_llm: "인원현황 조회(급여대장 HDF070T 기준 급여대상 인원, 2026-01~). 월별 전사 총원은 전 직원 조회 가능하고, 부서별 인원 분포는 인사팀·관리자만 반환된다. '2026년 인원현황', '이번달 몇 명', '부서별 인원' 류 질의에 사용. 급여 금액은 포함하지 않음(금액은 get_hr_payroll).",
  params: { type: "object", properties: { ym: { type: "string", description: "조회 월 YYYY-MM(선택). 없으면 월별 전체 추이" } }, required: [] },
  perm_module: "payroll", perm_mode: "partial", sensitivity: "normal",
  view: ["series", "notice"], erp: true, owner: "인사팀", status: "live",
};

export const run = (ctx: ToolCtx) => runHr(ctx, manifest.id);
