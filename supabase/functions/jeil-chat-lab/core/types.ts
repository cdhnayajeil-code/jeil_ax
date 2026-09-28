// core/types.ts — 모듈 규격(13 기획 §2 · ADR-108 제안). 게이트웨이·모듈·어댑터가 공유하는 타입.

/** 뷰 5종 고정(ADR-008). 새 뷰 타입을 만들지 않는다 — 타입으로 막는다. */
export type ViewPayload = Record<string, unknown> & { view: "series" | "ranking" | "record" | "list" | "notice" };

export type PagePerm = { page_key: string; title: string; path: string; dept_nm: string | null; visibility: string; allowed: boolean; reason: string };

/** perm_effective(ADR-010) 결과. 모듈은 이것만 보고 판정한다 — 권한을 다시 조회하지 않는다. */
export type ErpScope = {
  upn: string; isAdmin: boolean; modules: Set<string>; dept: string | null; empNm: string | null;
  depts: string[]; deptAdminOf: string[]; pages: PagePerm[]; grants: Record<string, unknown>[];
};

export type ToolKind = "read" | "draft" | "request";
/** gate=권한 모듈 없으면 게이트웨이가 차단 · partial=모듈 안에서 부분 판정 · self=본인 데이터 고정 · docs=문서 화이트리스트∩Graph 트리밍 */
export type PermMode = "gate" | "partial" | "self" | "docs";
export type Sensitivity = "normal" | "amount" | "personal";
export type ModuleStatus = "dev" | "pilot" | "live" | "off";

export interface ToolManifest {
  id: string;                 // 도구 이름(영구 불변 — 모델이 부르는 이름)
  version: string;
  domain: string;             // portal · purchase · item · sales · inventory · hr · common · docs
  kind: ToolKind;
  title_ko: string;
  summary_ko: string;
  description_llm: string;    // 모델용 설명(원본 TOOLS 문구 그대로)
  params: Record<string, unknown>;   // JSON Schema — 벤더 중립. 어댑터가 벤더 형식으로 바꾼다
  perm_module: string | null;
  perm_mode: PermMode;
  sensitivity: Sensitivity;
  view: string[];
  erp: boolean;               // ERP 중간DB 데이터를 쓰는가(파일럿 안내 문구 주입 여부)
  prompt_hint?: string;       // 시스템 프롬프트에 자동으로 들어갈 문구
  owner: string;              // 업무 담당(내용 검수 책임)
  status: ModuleStatus;
}

export interface ToolCtx {
  // deno-lint-ignore no-explicit-any
  admin: any;                 // service_role 클라이언트 — public.v_erp_* · 포털 테이블만
  args: Record<string, unknown>;
  asOf: string;
  scope: ErpScope;
  userToken: string;          // Entra 위임 토큰(문서 도구 전용)
}

export interface ToolModule {
  manifest: ToolManifest;
  run(ctx: ToolCtx): Promise<unknown>;
}
