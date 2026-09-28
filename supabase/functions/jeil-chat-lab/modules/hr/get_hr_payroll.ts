// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest } from "../../core/types.ts";
import { runHr } from "./_hr_impl.ts";

export const manifest: ToolManifest = {
  id: "get_hr_payroll", version: "1.0.0", domain: "hr", kind: "read",
  title_ko: "급여 집계", summary_ko: "월별 급여총액·퇴직급여(인사팀·관리자 전용, 접근 감사)",
  description_llm: "인사 급여 집계 조회(민감 — 인사팀·관리자 전용, 접근 감사 기록됨). 월별·부서별 급여대상 인원·급여총액·퇴직급여 집계. 개인별 급여·주민번호·계좌는 중간DB에 없으며 조회 불가. '급여총액', '인건비 추이' 류 질의에 사용.",
  params: { type: "object", properties: { ym: { type: "string", description: "조회 월 YYYY-MM(선택)" } }, required: [] },
  perm_module: "payroll", perm_mode: "gate", sensitivity: "personal",
  view: ["series", "notice"], erp: true, owner: "인사팀", status: "live",
};

export const run = (ctx: ToolCtx) => runHr(ctx, manifest.id);
