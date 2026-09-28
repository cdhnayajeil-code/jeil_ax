// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "read_document", version: "1.0.0", domain: "docs", kind: "read",
  title_ko: "문서 본문 판독", summary_ko: "Excel 셀값·텍스트 본문(승인 폴더만)",
  description_llm: "특정 문서의 상세·본문 조회(사용자 위임 토큰). search_my_documents가 준 driveId·itemId로 호출. 승인 프로젝트 폴더(화이트리스트) 밖 문서는 열람되지 않는다. Excel(.xlsx)은 셀 값(최대 40행), 텍스트(.txt/.csv/.md/.json)는 본문(최대 8000자)을 반환하고, 그 외 형식(docx/pdf 등)은 메타데이터+링크만 반환한다(본문 추출 미지원).",
  params: { type: "object", properties: { driveId: { type: "string", description: "드라이브 ID(search 결과)" }, itemId: { type: "string", description: "항목 ID(search 결과)" } }, required: ["driveId", "itemId"] },
  perm_module: null, perm_mode: "docs", sensitivity: "normal",
  view: ["notice"], erp: false, owner: "포털 관리", status: "live",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    const driveId = String(args.driveId || "").trim();
    const itemId = String(args.itemId || "").trim();
    if (!driveId || !itemId) return { 오류: "driveId·itemId가 필요합니다(먼저 search_my_documents로 조회)." };
    // 화이트리스트(§8): 승인 범위의 문서만 판독 허용(범위 밖 driveId/폴더 직접 열람 차단)
    const docScope = await loadDocScope(admin);
    if (!docScope) return { 오류: "문서 연동 범위 미설정", 안내: "AI 문서 연동 범위가 설정되지 않아 본문을 제공하지 않습니다. 관리자에게 문의하세요." };
    // 1차 게이트: 승인 driveId가 하나도 없으면 Graph 호출 전 차단
    if (!docScope.some((s) => s.driveId === driveId)) {
      const 안내 = "이 문서는 AI 연동 승인 범위(프로젝트 폴더)에 없어 열람할 수 없습니다. search_my_documents로 승인 범위 내 문서를 찾으세요.";
      return { 오류: "범위 밖 문서", 안내,
        __view: { view: "notice", title: "문서 연동 승인범위 밖", kind: "deny", text: 안내,
          request: { ui: "perm", kind: "doc", module: "document", moduleKo: "문서 연동범위", dept: scope.dept || "미지정" } } satisfies ViewPayload };
    }
    const base = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
    try {
      const meta = await graphGet(userToken, `${base}?$select=name,size,file,webUrl,lastModifiedDateTime`);
      // 2차 게이트: 폴더 레벨 경로 검증(승인 폴더 하위인지) — 같은 라이브러리라도 범위 밖 폴더면 차단
      if (!inScope(docScope, driveId, String(meta.webUrl || ""))) {
        const 안내 = "이 문서는 승인된 AI 연동 폴더 하위가 아니어서 열람할 수 없습니다. search_my_documents로 승인 범위 내 문서를 찾으세요.";
        return { 오류: "범위 밖 폴더", 안내,
          __view: { view: "notice", title: "승인 폴더 밖 문서", kind: "deny", text: 안내,
            request: { ui: "perm", kind: "doc", module: "document", moduleKo: "문서 연동범위", dept: scope.dept || "미지정" } } satisfies ViewPayload };
      }
      const nm = String(meta.name || "");
      if (/\.xlsx?$/i.test(nm)) {
        const ws = await graphGet(userToken, `${base}/workbook/worksheets`);
        // deno-lint-ignore no-explicit-any
        const sid = (ws as any).value?.[0]?.id;
        // deno-lint-ignore no-explicit-any
        const sname = (ws as any).value?.[0]?.name;
        const ur = await graphGet(userToken, `${base}/workbook/worksheets('${sid}')/usedRange(valuesOnly=true)`);
        // deno-lint-ignore no-explicit-any
        const rows = ((ur as any).text || []).slice(0, 40);
        return { 기준시각: asOf, 파일: nm, 링크: meta.webUrl, 시트: sname, 범위: (ur as Record<string, unknown>).address,
          행수: (ur as Record<string, unknown>).rowCount, 열수: (ur as Record<string, unknown>).columnCount, 셀값: rows,
          안내: "Excel 셀 값(최대 40행). 본인 권한 내 파일만 판독됨. 개인정보(급여·주민번호 등)는 답변에 노출 금지." };
      }
      if (/\.(txt|csv|md|json)$/i.test(nm)) {
        const r = await fetch(`${base}/content`, { headers: { Authorization: `Bearer ${userToken}` } });
        if (!r.ok) throw new Error(`Graph ${r.status}`);
        const t = (await r.text()).slice(0, 8000);
        return { 기준시각: asOf, 파일: nm, 링크: meta.webUrl, 내용: t, 안내: "텍스트 본문(최대 8000자). 본인 권한 내 파일만." };
      }
      return { 기준시각: asOf, 파일: nm, 크기: meta.size, 링크: meta.webUrl,
        안내: "이 형식(docx/pdf 등)의 본문 추출은 현재 미지원(후속 과제) — Excel·텍스트만 본문 판독. 파일은 접근 가능하며 링크로 열람하세요." };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("401") || msg.includes("403")) return { 오류: "문서 접근 권한 없음", 안내: "본인 권한 밖 문서이거나 재로그인이 필요합니다." };
      return { 오류: "문서 읽기 실패: " + msg };
    }
  }
