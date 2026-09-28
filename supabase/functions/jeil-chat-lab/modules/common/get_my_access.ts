// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "get_my_access", version: "1.0.0", domain: "common", kind: "read",
  title_ko: "내 권한", summary_ko: "본인 역할·부서·ERP 모듈·페이지 권한",
  description_llm: "로그인한 '본인'의 포털 권한 조회 — 역할(관리자/부서관리자/일반), 소속 부서, 열람 가능한 ERP 데이터 모듈, 접근 가능/불가 운영페이지 목록, 권한 요청 방법. '내 권한 뭐야', '나 관리자야?', '어떤 데이터 볼 수 있어?', '이 페이지 왜 안 보여' 류 질의에 반드시 사용(추측 답변 금지). 타인의 권한은 조회 불가.",
  params: { type: "object", properties: {}, required: [] },
  perm_module: null, perm_mode: "self", sensitivity: "normal",
  view: ["record"], erp: false, owner: "포털 관리", status: "live",
  prompt_hint: "'내 권한 확인', '나 뭐 볼 수 있어?', '이 페이지 왜 안 보여?' 류 권한 질의는 일반론으로 답하지 말고 반드시 get_my_access 도구로 로그인 본인의 실제 역할·부서·ERP 모듈·페이지 권한을 조회해 답하세요(관리자면 관리자라고 정확히 알릴 것). 본인 외 타인의 권한은 조회할 수 없습니다.",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    // 본인 권한만(호출자 UPN 고정 — 모델이 타인 UPN을 지정할 수 없음).
    // v2: 판정은 이미 perm_effective(SSOT)가 끝냈다 — 여기서는 표현만 한다(중복 판정 제거).
    const deptAdminOf = scope.deptAdminOf;
    const role = scope.isAdmin ? "관리자(전권)" : (deptAdminOf.length ? "부서관리자" : "일반 사용자");
    const modules = [...scope.modules];
    const pages = scope.pages.map((p) => ({
      페이지: p.title, 담당부서: p.dept_nm, 공개범위: p.visibility,
      접근가능: p.allowed, 사유: p.reason, 경로: String(p.path || ""),
    }));
    // 개인 예외(겸직 부서·모듈 가감·기간 권한) — 본인에게 무엇이 왜 적용 중인지 투명하게 보여준다
    const 개인예외 = scope.grants.map((g) => ({
      유형: String(g.scope_type), 대상: String(g.scope_key),
      효과: g.effect === "deny" ? "차단" : "허용",
      만료: g.valid_to ? String(g.valid_to).slice(0, 10) : "무기한",
      사유: String(g.reason || ""),
    }));
    // deno-lint-ignore no-explicit-any
    const okPages = pages.filter((p: any) => p.접근가능);
    // deno-lint-ignore no-explicit-any
    const noPages = pages.filter((p: any) => !p.접근가능);
    // 계정 표기 규약: '부서_이름_아이디'
    const 계정표기 = `${scope.dept || "미매핑"}_${scope.empNm || "-"}_${scope.upn}`;
    return {
      기준시각: asOf, 계정: 계정표기, 이름: scope.empNm || "-", 소속부서: scope.dept || "미매핑",
      적용부서: scope.depts,
      역할: role, 관리자여부: scope.isAdmin, 부서관리자_담당부서: deptAdminOf,
      열람가능_ERP모듈: modules.map((m) => `${MODULE_KO[m] || m}(${m})`),
      개인예외권한: 개인예외,
      // deno-lint-ignore no-explicit-any
      접근가능_페이지: okPages.map((p: any) => p.페이지),
      // deno-lint-ignore no-explicit-any
      접근불가_페이지: noPages.map((p: any) => ({ 페이지: p.페이지, 담당부서: p.담당부서, 공개범위: p.공개범위, 사유: p.사유 })),
      __view: { view: "record", title: "내 포털 권한", asOf,
        fields: [
          { k: "계정", v: 계정표기 },
          { k: "소속부서", v: scope.depts.length > 1 ? scope.depts.join(" · ") + " (겸직·대행 포함)" : (scope.dept || "미매핑") },
          { k: "역할", v: role },
          { k: "ERP 모듈", v: modules.length ? modules.map((m) => MODULE_KO[m] || m).join(" · ") : "없음" },
          { k: "운영페이지", v: `접근가능 ${okPages.length} / 전체 ${pages.length}` },
          ...(개인예외.length ? [{ k: "개인 예외", v: 개인예외.map((g) => `${g.대상}(${g.효과}·${g.만료})`).join(", ") }] : []),
          ...(deptAdminOf.length ? [{ k: "부서관리자", v: deptAdminOf.join(", ") }] : []),
        ],
        // 접근 가능한 운영페이지 바로가기(상위 3) — 실제 열람 차단은 각 페이지 게이트(jeil-me)가 재판정
        // deno-lint-ignore no-explicit-any
        actions: okPages.filter((p: any) => p.경로).slice(0, 3)
          // deno-lint-ignore no-explicit-any
          .map((p: any) => ({ kind: "link", label: String(p.페이지), url: String(p.경로) })) } satisfies ViewPayload,
      권한요청방법: scope.isAdmin
        ? "관리자(전권) 계정이므로 별도 권한 요청이 필요 없습니다. 타 사용자 권한 부여는 관리자 콘솔 › 권한 설정에서 수행하세요(부서 단위 = 부서별 ERP 모듈, 개인 단위 = 개인 예외 권한)."
        : "필요한 데이터 모듈·페이지를 지정해 포털 관리자에게 요청하세요. 부서 전체가 필요하면 부서 권한으로, 본인만 필요하면 개인 예외 권한(기간 지정 가능)으로 부여됩니다. 급여·자금은 민감 모듈이라 별도 승인이 필요합니다.",
      안내: "본인 권한만 조회됩니다(타인 권한 조회 불가). 판정 기준(단일 출처 public.perm_effective): 전체 관리자(portal_admin) › 개인 예외(perm_grant, deny>allow) › 소속·겸직 부서 ERP 모듈(dept_erp_scope) + 페이지 공개범위(portal_page).",
    };
  }
