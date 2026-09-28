// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "search_my_documents", version: "1.0.0", domain: "docs", kind: "read",
  title_ko: "내 문서 검색", summary_ko: "승인 폴더 ∩ 본인 권한 문서 검색(Graph)",
  description_llm: "사용자의 OneDrive·SharePoint 문서 검색(Microsoft Graph). 단, AI 연동이 승인된 프로젝트 폴더(화이트리스트) 안에서만, 그중에서도 본인 권한 범위만 자동 트리밍된다. '내 문서/회의록/보고서/특정 파일 찾아줘' 류 질의에 사용. 파일명·수정일·링크와 함께 read_document 호출용 driveId·itemId를 반환한다. 승인 범위 밖 문서는 조회되지 않는다.",
  params: { type: "object", properties: { query: { type: "string", description: "검색어(파일명·키워드)" }, limit: { type: "integer", description: "최대 건수(기본 8, 최대 15)" } }, required: ["query"] },
  perm_module: null, perm_mode: "docs", sensitivity: "normal",
  view: ["list", "notice"], erp: false, owner: "포털 관리", status: "live",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    const q = String(args.query || "").trim();
    if (!q) return { 오류: "검색어(query)가 필요합니다." };
    const size = Math.min(Math.max(Number(args.limit) || 8, 1), 15);
    // 화이트리스트(§8): 승인 컨테이너로만 제한. 미설정이면 fail-closed(전 문서 노출 방지).
    const docScope = await loadDocScope(admin);
    if (!docScope) return { 오류: "문서 연동 범위 미설정",
      안내: "AI 문서 연동 범위(승인 프로젝트 폴더)가 설정되지 않아 검색을 제공하지 않습니다. 관리자에게 범위 등록을 요청하세요.",
      __view: { view: "notice", title: "문서 연동 범위 미설정", kind: "info",
        text: "AI 문서 연동 범위(승인 프로젝트 폴더)가 설정되지 않아 검색을 제공하지 않습니다. 관리자에게 범위 등록을 요청하세요.",
        // 문서 승인범위는 "문서는 있는데 못 본다" → 사용자 화면상 권한요청(ui:perm), 원장 유형은 doc(담당 분리)
        request: { ui: "perm", kind: "doc", module: "document", moduleKo: "문서 연동범위",
          dept: scope.dept || "미지정" } } satisfies ViewPayload };
    try {
      // 서버측 스코프: 승인 범위 경로(폴더/라이브러리/사이트)로 KQL path 한정 + 여유분 확보(후단 하드필터 대비)
      const pathClause = ` AND (${docScope.map((s) => `path:"${s.webUrl}"`).join(" OR ")})`;
      const data = await graphSearchDocs(userToken, q + pathClause, Math.min(Math.max(size * 4, size), 40));
      // deno-lint-ignore no-explicit-any
      const hc = (data as any).value?.[0]?.hitsContainers?.[0];
      // deno-lint-ignore no-explicit-any
      const 목록 = (hc?.hits || []).map((h: any) => ({
        이름: h.resource?.name, 수정일: h.resource?.lastModifiedDateTime, 링크: h.resource?.webUrl,
        driveId: h.resource?.parentReference?.driveId, itemId: h.resource?.id, 발췌: h.summary || null,
      }))
        // 이중 게이트: 승인 driveId 일치 AND 경로가 승인 접두로 시작(폴더 레벨 하드 필터 — 경로 스코프 누수 대비)
        // deno-lint-ignore no-explicit-any
        .filter((x: any) => inScope(docScope, String(x.driveId || ""), String(x.링크 || "")))
        .slice(0, size);
      return { 기준시각: asOf, 검색어: q, 승인범위_수: docScope.length, 반환수: 목록.length, 목록,
        안내: "AI 승인 범위(폴더/라이브러리 화이트리스트) ∩ 본인 권한 범위 문서만 검색됨(§8 이중 게이트). 본문·상세는 read_document(driveId,itemId). 답변에 출처(파일명·링크) 표기. 범위 밖이면 결과 없음이 정상.",
        __view: { view: "list", title: `문서 검색 — "${q}" (${목록.length}건)`, asOf,
          columns: [
            { key: "이름", label: "파일명" }, { key: "수정일", label: "수정일" }, { key: "링크", label: "열기", link: true },
          ],
          // deno-lint-ignore no-explicit-any
          rows: 목록.map((x: any) => ({ 이름: x.이름, 수정일: String(x.수정일 || "").slice(0, 10), 링크: x.링크 })),
          // 0건은 "없다"가 아니라 "승인 범위 밖일 수 있다" — 검색어 재확인을 먼저 권하고 요청 경로를 함께 준다.
          ...(목록.length === 0 ? { request: { ui: "perm", kind: "doc", module: "document", moduleKo: "문서 연동범위", dept: scope.dept || "미지정", confirm_first: true } } : {}),
          note: 목록.length === 0
            ? "검색 결과 없음 — 검색어를 바꿔보시고, 필요한 폴더가 AI 연동 범위에 없다면 아래로 요청하세요"
            : "AI 승인 범위 ∩ 본인 권한 문서만" } satisfies ViewPayload };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("401") || msg.includes("403")) return { 오류: "문서 접근 권한 없음", 안내: "MS 재로그인(파일 권한 포함)이 필요할 수 있습니다. 계속 실패하면 관리자에게 문의하세요." };
      return { 오류: "문서 검색 실패: " + msg };
    }
  }
