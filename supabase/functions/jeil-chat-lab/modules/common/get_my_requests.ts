// 자동 생성(_port_modules.py) — 원본: jeil-chat/index.ts (TOOLS · runTool 분기). 로직을 바꾸려면 원본 대신 이 모듈을 정본으로 전환한 뒤 고친다.
import type { ToolCtx, ToolManifest, ViewPayload } from "../../core/types.ts";
import { STATUS_KO, stsKo, MODULE_KO, hasModule, comma, won, STEP_IX, STEP_LABELS, userLabelMap, userLbl, graphGet, graphSearchDocs, loadDocScope, inScope, loadLoadScope, gapOf, gapAttr } from "../../core/util.ts";
import type { ScopeRow } from "../../core/util.ts";

export const manifest: ToolManifest = {
  id: "get_my_requests", version: "1.0.0", domain: "common", kind: "read",
  title_ko: "내 요청 진행", summary_ko: "본인 접수·동조한 포털 요청 진행상황",
  description_llm: "로그인한 '본인'이 접수한 포털 요청의 진행상황 조회 — 접수번호·유형(권한/데이터 적재범위 등)·상태·대상·처리 회신. '내 요청 어떻게 됐어?', '권한 요청 진행상황', '내가 낸 요청 보여줘' 류 질의에 사용. 본인이 낸 건과 동조자로 참여한 건만 조회되며 타인의 요청은 조회할 수 없다.",
  params: { type: "object", properties: {}, required: [] },
  perm_module: null, perm_mode: "self", sensitivity: "normal",
  view: ["list"], erp: false, owner: "포털 관리", status: "live",
  prompt_hint: "[신규] '내 요청 어떻게 됐어?', '권한 요청 진행상황' 류 질의는 get_my_requests 로 본인이 접수·동조한 요청만 조회해 답하세요.",
};

// deno-lint-ignore require-await
export async function run(ctx: ToolCtx): Promise<unknown> {
  const { admin, args, asOf, scope, userToken } = ctx;

    const KIND_KO_REQ: Record<string, string> = {
      perm: "권한", perm_sensitive: "민감권한(급여·인사)", data: "데이터 적재범위",
      doc: "문서 연동범위", feature: "기능 요청", quality: "데이터 품질",
    };
    const ST_KO: Record<string, string> = {
      open: "접수", ack: "확인", doing: "처리중", done: "완료", rejected: "반려", duplicate: "중복", cancelled: "취소",
    };
    const cols = "req_no,kind,status,target_module,target_detail,reason,handled_note,created_at,closed_at";
    const [own, sup] = await Promise.all([
      admin.from("portal_request").select(cols).eq("requester_upn", scope.upn)
        .order("created_at", { ascending: false }).limit(20),
      admin.from("portal_request").select(cols).contains("supporters", [scope.upn])
        .order("created_at", { ascending: false }).limit(20),
    ]);
    const seen = new Set<string>();
    // deno-lint-ignore no-explicit-any
    const merged = ([...(own.data || []), ...(sup.data || [])] as any[])
      .filter((r) => (seen.has(r.req_no) ? false : (seen.add(r.req_no), true)))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    if (!merged.length) {
      return { 기준시각: asOf, 건수: 0,
        안내: "접수하신 요청이 없습니다. 챗봇이 '조회할 수 없다'고 답한 카드에서 「열람 권한 요청」 또는 「데이터 적용 요청」 버튼으로 접수할 수 있습니다." };
    }
    // deno-lint-ignore no-explicit-any
    const 목록 = merged.map((r: any) => ({
      접수번호: r.req_no, 유형: KIND_KO_REQ[r.kind] || r.kind, 상태: ST_KO[r.status] || r.status,
      대상: r.target_detail?.module_ko || r.target_module || "-",
      항목: r.target_detail?.gap?.detail || null,
      접수일: String(r.created_at).slice(0, 10), 사유: r.reason,
      처리회신: r.handled_note || null,
    }));
    return { 기준시각: asOf, 건수: 목록.length, 목록,
      안내: "본인이 접수했거나 동조자로 참여한 요청만 조회됩니다. 처리 결과는 '처리회신'에 표시되며, 권한 요청은 완료 후 재로그인하면 반영됩니다.",
      __view: { view: "list", title: `내 요청 ${목록.length}건`, asOf,
        columns: [
          { key: "접수번호", label: "접수번호" }, { key: "유형", label: "유형" },
          { key: "대상", label: "대상" }, { key: "상태", label: "상태" },
          { key: "접수일", label: "접수일" }, { key: "처리회신", label: "처리 회신" },
        ],
        // deno-lint-ignore no-explicit-any
        rows: 목록.map((r: any) => ({ ...r, 처리회신: r.처리회신 || "" })),
        note: "본인 접수·동조분만 표시" } satisfies ViewPayload };
  }
