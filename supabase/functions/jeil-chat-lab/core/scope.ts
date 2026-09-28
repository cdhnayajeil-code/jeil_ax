// core/scope.ts — 권한 판정(perm_effective 단일 출처, ADR-010) + 실험실 권한 시뮬레이션 + 공통 게이트.
import type { ErpScope, ToolManifest, ViewPayload } from "./types.ts";
import { MODULE_KO, hasModule } from "./util.ts";

// deno-lint-ignore no-explicit-any
export async function resolveErpScope(admin: any, upn: string): Promise<ErpScope> {
  const { data: eff } = await admin.rpc("perm_effective", { p_upn: upn });
  const e = (eff || {}) as Record<string, unknown>;
  return {
    upn,
    isAdmin: !!e.is_admin,
    modules: new Set<string>((e.erp_modules as string[]) || []),
    dept: (e.dept_nm as string) ?? null,
    empNm: (e.emp_nm as string) ?? null,
    depts: (e.depts as string[]) || [],
    deptAdminOf: (e.dept_admin_of as string[]) || [],
    pages: (e.pages as PagePermLike[]) || [],
    grants: (e.grants as Record<string, unknown>[]) || [],
  } as ErpScope;
}
type PagePermLike = ErpScope["pages"][number];

/** 권한 시뮬레이션 — **좁히기만** 한다. 실제 권한에 없는 모듈은 넣을 수 없고, 타인 UPN 대행은 없다.
 *  관리자 표시는 끄므로 게이트·부분판정이 일반 사용자처럼 동작한다. */
export function simulateScope(real: ErpScope, modules: unknown): ErpScope {
  const want = Array.isArray(modules) ? modules.map((m) => String(m)) : [];
  const allowed = want.filter((m) => real.isAdmin || real.modules.has(m));
  return { ...real, isAdmin: false, modules: new Set(allowed), deptAdminOf: [] };
}

/** 공통 게이트(운영 runTool 첫머리와 같은 문구·같은 카드). perm_mode=gate 모듈에만 적용. */
export function gateDeny(m: ToolManifest, scope: ErpScope): Record<string, unknown> | null {
  const erpMod = m.perm_mode === "gate" ? m.perm_module : null;
  if (!erpMod || hasModule(scope, erpMod)) return null;
  const modKo = MODULE_KO[erpMod] || erpMod;
  const dept = scope.dept || "소속 부서";
  const 안내 = `요청하신 ERP '${modKo}' 데이터는 회원님 소속 부서(${dept})에 아직 열람 권한이 없습니다. 열람이 필요하시면 포털 관리자에게 '${dept}의 ${modKo}(${erpMod}) ERP 모듈 권한'을 요청해 주세요. (관리자 콘솔 › 사용자·부서 › 부서별 ERP 모듈 권한에서 부여)`;
  return {
    접근제한: true, 요청안내: true, 모듈: erpMod, 부서: scope.dept || "미지정", 안내,
    __view: { view: "notice", title: "데이터 접근 권한 안내", kind: "deny", text: 안내,
      request: { ui: "perm", kind: "perm", module: erpMod, moduleKo: modKo, dept },
      actions: [{ kind: "ask", label: "권한 요청 초안 작성",
        prompt: `포털 관리자에게 보낼 '${dept}의 ${modKo}(${erpMod}) ERP 모듈 권한' 요청 메시지 초안을 사내 메신저용으로 간결하게 작성해줘. 요청 사유 한 줄을 포함하고, 내가 복사해서 직접 보낼 수 있는 형태로.` }] } satisfies ViewPayload,
  };
}

/** 이 모듈을 이 사용자에게 보여 줄 수 있는가(권한별 주입 §2-5). 실행 때 gateDeny 로 한 번 더 막는다. */
export function visibleTo(m: ToolManifest, scope: ErpScope): boolean {
  if (m.perm_mode !== "gate" || !m.perm_module) return true;
  return hasModule(scope, m.perm_module);
}
