// jeil-gl-draft — 결의전표 초안 CRUD (포털 입력 → 사람이 ERP 확정) v5
// 배포: verify_jwt=false (Entra 토큰은 Supabase JWT가 아니므로 내부에서 Graph 재검증)
// 호출: POST /functions/v1/jeil-gl-draft  Authorization: Bearer <Entra access_token>
//   body: { op: "bootstrap"|"save"|"mine"|"get"|"submit"|"void"|"bp"|"item"|"list"|"post"
//              |"tpl_list"|"tpl_get"|"tpl_save"|"tpl_status"|"tpl_delete"|"tpl_use"
//              |"tpl_recur_list"|"tpl_apply_prev"|"tpl_seed_bulk"
//              |"slip_list"|"slip_get"|"apply_request"|"apply_cancel", ... }
// v5.1(2026-08-18): ERP char 패딩 대응(acctCtrlFor trim, RPC btrim은 gl_pad_trim_v1) + op item(품목 검색) 추가
// v5.2(2026-08-19): ERP 직접등록 1차(DEMO2, 결정 C-11) 적용 상태 노출 — mine/list 에 erp_apply_* 필드 추가.
//   적용 실행은 이 함수가 아니라 관리자 PC 적용기(gl_apply_demo2.py)가 수행한다(포털은 ERP에 직접 쓰지 않음).
// v5.3(2026-08-19): [ERP 전송] 버튼 — op apply_request(전송 대기 ready 마킹)·apply_cancel(대기 취소), canPost 전용.
//   상태머신: null → ready(버튼) → applied|failed(중계 gl_apply_demo2.py --queue/--watch 처리 결과).
//   이 함수는 여전히 ERP에 쓰지 않는다 — 마킹만 하고, 투입은 사내 pull 중계가 수행(기회검토 채택 구조).
// v5.7(2026-08-20): 관리항목 참조 검색 전면 연결 — op `ctrl_ref`(공용) + bootstrap 의
//   `ctrl_ref_kinds`(검색 가능 목록). 원천은 통합 미러 erp_ro.ctrl_ref_s(migration gl_ctrl_ref_v1).
//   참조가 있는 관리항목 31종 전부 연결(거래처·품목 4종은 기존 전용 RPC, 나머지 27종은 통합 미러).
//   민감 6종(사번·계좌·신용카드·구매카드·어음·차입번호)도 전표 입력에 필요해 연결하되
//   (관리자 지시 2026-08-20), 조회는 감사 로그에 남긴다(값 제외, 검색어 길이·결과 건수만).
//   사번은 사번·성명·부서명만 적재한다 — 주민번호·급여·주소·연락처는 원천에서 선택하지 않는다.
// v5.6(2026-08-20): 코스트센터 필수화(관리자 지시). save 에서 라인마다 코스트센터를 요구하고
//   (없으면 헤더값 승계) `gl_master_get` 의 유효 목록으로 화이트리스트 재검증한다.
//   유효 목록은 폐지분(조직개편 19801 · 명칭 '(사용금지)')을 제외한 것 — migration gl_master_cost_center_v2.
// v5.5(2026-08-20): 템플릿 가시성 수정 — `tpl_list all` 을 관리 권한자로 제한하던 조건 제거.
//   일반 사용자가 자기 비공개(draft) 템플릿을 어디서도 볼 수 없어 공개조차 못 하던 막다른 길을 없앤다.
//   범위 제한은 loadTemplates 안으로 옮겼다: 관리 권한이 없으면 '공개된 것 + 내 편집 가능한 것'까지만.
// v5.4(2026-08-20): 「전송 성공 = 확정」 일원화(결정 C-13). 화면의 ERP 전표번호 수기 입력칸을 없애고,
//   적용 성공 시 RPC gl_apply_record(v3)가 status 를 submitted→posted 로 닫고 ERP 채번번호를
//   erp_temp_gl_no 에 기록한다. op post(수기 번호 회기입)는 운영 전환기 폴백으로만 남긴다 — 화면 미노출.
// DDL 정본: 이관/sql/21_gl_draft.sql · 22_gl_template.sql · 23(관리항목 마스터) · 25(전표 미러) · 26(ERP 적용)
//   마이그레이션 gl_draft_v1 · gl_draft_master_rpc · gl_template_v1 · gl_ctrl_master_v1 · gl_template_v2
//              · gl_slip_mirror_v1
//
// v3(템플릿) 원칙
//  - 템플릿은 "분개 형태"만 담는다. 금액 실적치를 담지 않는다(고정액·비율 규칙만).
//    단 v2 시드의 고정 금액(fixed)은 B2 승인(2026-08-11) 범위에서 예외적으로 허용.
//  - 템플릿을 적용해도 검증은 면제되지 않는다 — save 의 서버 재검증을 그대로 통과해야 한다.
//  - 공개 범위(org/dept/user)와 편집 권한을 분리한다: 전사·부서 템플릿은 관리자·회계 담당자만 만든다.
//
// v4(월반복·관리항목 — 기획 10_반복전표_자동화_기획 §6.4, 2026-08-12) 원칙
//  - 하위호환: 기존 op 의 동작·응답 형태는 바꾸지 않는다(라이브 화면이 구버전일 수 있다). 추가만 한다.
//  - 관리항목(ctrls)은 요청이 보낼 때만 저장·검증한다. 필수 관리항목(acct_ctrl_assn 플래그 Y) 강제는
//    신형 화면(ctrl_aware=true)에만 적용 — 구화면 저장이 깨지지 않게 하는 단계적 전환이며,
//    신형 화면 안착 후 상시 강제로 전환한다(그 전까지 구화면 저장에는 warnings 로만 알린다).
//  - 부가세 자동계산은 화면에서만 한다(결정 C-14, 2026-08-20 B2 개정) — 계산서유형(V4)별 세율로
//    공급가액·세액·합계를 서로 채우되 '제안'이며 사용자가 덮어쓸 수 있다. 서버는 계산하지 않고
//    받은 값을 그대로 검증한다(차대 일치·필수 관리항목). 원천징수 자동계산은 여전히 범위 밖.
//    서버는 세액 관계식을 계산·강제하지 않고, 이상치(계산서일이 결의일자보다 미래 등)만 경고한다.
//  - 월반복 사용 이력(gl_template_usage)은 초안 생성 시 기록하고 상태를 동기한다(배지 4상태의 근거).
//
// v5(전표복사 — 2026-08-18) 원칙
//  - 본인이 ERP에 입력한 결의전표(미러 erp_ro.gl_slip_*)를 불러와 새 초안의 출발점으로 복사한다.
//    ERP 전표복사 메뉴와 동일 흐름 — 결의일자는 새로, 계정·금액·내용은 사용자가 수정.
//  - 조회 범위는 JWT→gl_erp_user 로 확정한 본인 ERP USR_ID 전표뿐(1:1 매핑 실측 확정, C-3).
//    소유 필터는 RPC(gl_slip_list/get) 안에서 강제한다 — 화면 파라미터를 신뢰하지 않는다.
//  - 미러는 야간 ETL 적재라 실시간이 아니다. 민감 관리항목(사번·계좌·카드·어음) 값은 미러에 없다.
//
// 원칙 (CLAUDE.md §1.2·§1.6·§5.4)
//  - 포털은 ERP에 쓰지 않는다. 이 함수는 "ERP 결의전표(A_TEMP_GL)에 옮겨 담을 초안"까지만 만든다.
//  - 등록자는 JWT UPN 에서만 취득한다. 본문의 owner 값은 무시(위조 차단).
//    UPN → ERP USR_ID 매핑(gl_erp_user)에 실패하면 저장을 거부한다 —
//    ERP 계정이 없는 사람 명의의 전표가 만들어지는 것을 막는 장치다.
//  - 차대일치·계정유효·금액·마감월은 전부 서버에서 재검증한다. 화면 검증은 UX일 뿐이다.
//  - 합계(dr_total/cr_total)는 화면 값을 믿지 않고 라인에서 다시 계산해 저장한다.
//  - 모든 접근을 gl_draft_log 에 남긴다(금액이 담기는 첫 포털 쓰기 기능).
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

/* ===== 규칙 상수 (변경 시 화면·설계문서 동시 갱신) ===== */
const MODULE_INPUT = "accounting";   // 초안 입력 권한 모듈 (관리자 콘솔에서 부서에 부여)
const MODULE_POST = "finance";       // ERP 확정(회계 담당자) 권한 모듈 — 자금팀·내부회계관리팀 보유
const MAX_ITEMS = 50;                // 라인 상한
const DESC_MAX = 200;                // 적요 길이 — ERP nvarchar(200)
const REF_MAX = 30;                  // 참조번호 — ERP nvarchar(30)
const DRAFT_LIMIT = 30;              // 사용자당 미확정(draft+submitted) 보유 상한
// ERP 결의전표번호 형식 — A2 승인 후 실측 확정(2026-08-03): 'TG'+YYYYMMDD+4자리 순번(총 14자)
const TEMP_GL_NO_RE = /^TG\d{12}$/;
const GL_TYPE_DEFAULT = "03";        // A_TEMP_GL 2026년 2,947건 전량 '03'(일반전표) — 실측 확정
const TPL_ITEM_MAX = 30;             // 템플릿 라인 상한(전표 라인 상한보다 낮게 — 형태 정의용)
const TPL_NM_MAX = 60;               // 템플릿 이름
const CTRL_VAL_MAX = 30;             // 관리항목 값 — ERP A_TEMP_GL_DTL.CTRL_VAL nvarchar(30)
const CTRL_PER_LINE_MAX = 15;        // 라인당 관리항목 상한(실측 최대 7종 + 여유)
const SEED_MAX = 100;                // tpl_seed_bulk 1회 상한
// 개인 식별·금융 관리항목 — 부서/전사 템플릿에 '고정값'으로 저장·배포 금지(사번·계좌·카드·어음)
// 민감 관리항목 — 전사·부서 템플릿에 고정값 저장 금지 + 참조 검색 시 감사 로그 대상
const SENSITIVE_CTRL = new Set(["EM", "BA", "D1", "CP", "NN", "L1"]);

async function verifyEntraUser(token: string): Promise<{ upn: string; name: string } | null> {
  try {
    const r = await fetch("https://graph.microsoft.com/v1.0/me?$select=userPrincipalName,mail,displayName", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const me = await r.json();
    const upn = String(me.userPrincipalName || me.mail || "").toLowerCase();
    if (!upn.endsWith("@jeilm.co.kr")) return null;
    return { upn, name: String(me.displayName || "") };
  } catch { return null; }
}

const num = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : NaN;
};
const clip = (v: unknown, max: number): string | null => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized: MS 로그인 토큰이 필요합니다." }, 401);
  const user = await verifyEntraUser(token);
  if (!user) return json({ error: "unauthorized: 사내 계정 인증 실패" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const op = String(b.op || "");
  const nowIso = new Date().toISOString();

  // deno-lint-ignore no-explicit-any
  const log = (action: string, draftNo: string | null, detail?: any) =>
    admin.from("gl_draft_log").insert({ draft_no: draftNo, actor_upn: user.upn, action, detail: detail ?? null })
      .then(() => {}, () => {});   // 로깅 실패가 업무를 막지 않는다

  /* 유효 권한 — 판정 SSOT(perm_effective). 실패는 빈 결과로 폴백(fail-closed). */
  // deno-lint-ignore no-explicit-any
  let eff: any = {};
  try { const { data } = await admin.rpc("perm_effective", { p_upn: user.upn }); eff = data || {}; } catch { /* 폴백 */ }
  const isAdmin = !!eff.is_admin;
  const myModules: string[] = (eff.erp_modules as string[]) || [];
  const canInput = isAdmin || myModules.includes(MODULE_INPUT);
  const canPost = isAdmin || myModules.includes(MODULE_POST);

  if (!canInput && !canPost) {
    log("denied", null, { op });
    return json({ error: "forbidden", 안내: "결의전표 초안 작성 권한이 없습니다. 포털 관리자에게 권한을 요청하세요." }, 403);
  }

  /* ERP 등록자 매핑 — 전표의 명의가 되는 값이라 여기서 한 번만 정한다. */
  let erpUser: { erp_usr_id?: string; usr_nm?: string } = {};
  try { const { data } = await admin.rpc("gl_erp_user", { p_upn: user.upn }); erpUser = data || {}; } catch { /* 폴백 */ }
  const erpUsrId = erpUser.erp_usr_id || null;
  // usr_nm 은 '부서명_이름' 규약 — 이름만 떼어 표시용으로 쓴다(성명은 마스킹 대상 아님, CLAUDE.md §1.7)
  const ownerNm = (erpUser.usr_nm || user.name || "").split("_").slice(1).join("_") || user.name || null;

  /* ===== 템플릿 공통 — 볼 수 있는 범위/편집 권한 판정 =====
     범위: 전사(org) 는 모두, 부서(dept) 는 소속·겸직 부서만, 개인(user) 은 본인만.
     편집: 전사·부서 템플릿은 관리자·회계 담당자만. 개인 템플릿은 본인.
     "관리 모드"(all=true)는 관리자·회계 담당자에 한해 draft/archived 까지 보여준다. */
  const myDepts: string[] = ((eff.depts as string[]) || []).filter(Boolean);
  const canManageTpl = isAdmin || canPost;

  // deno-lint-ignore no-explicit-any
  const visibleTpl = (t: any): boolean => {
    if (t.scope === "user") return t.owner_upn === user.upn;
    if (t.scope === "dept") return myDepts.includes(String(t.scope_dept_nm || "")) || canManageTpl;
    return true;
  };
  // deno-lint-ignore no-explicit-any
  const editableTpl = (t: any): boolean =>
    t.scope === "user" ? t.owner_upn === user.upn : canManageTpl;

  const loadTemplates = async (all: boolean) => {
    let q = admin.from("gl_template").select("*").order("sort_no").order("tpl_nm");
    if (!all) q = q.eq("status", "active");
    else q = q.neq("status", "archived");
    const { data: heads } = await q;
    // all=true 라도 남의 미공개 전사·부서 템플릿까지 보여선 안 된다.
    // 관리 권한이 없으면 "공개된 것 + 내가 편집할 수 있는 것(=내 개인 템플릿)"으로 좁힌다.
    // 이 단서가 없으면 일반 사용자가 자기 비공개 템플릿을 어디서도 못 봐 공개할 수 없다(막다른 길).
    const list = (heads || []).filter((t) =>
      visibleTpl(t) && (!all || canManageTpl || t.status === "active" || editableTpl(t)));
    if (!list.length) return [];
    const ids = list.map((t) => t.tpl_id);
    const { data: items } = await admin.from("gl_template_item")
      .select("*").in("tpl_id", ids).order("line_seq");
    const { data: ctrls } = await admin.from("gl_template_item_ctrl")
      .select("*").in("tpl_id", ids);
    const ctrlKey = (tplId: number, seq: number) => tplId + "#" + seq;
    // deno-lint-ignore no-explicit-any
    const ctrlBy = new Map<string, any[]>();
    (ctrls || []).forEach((c) => {
      const k = ctrlKey(c.tpl_id, c.line_seq);
      const arr = ctrlBy.get(k) || []; arr.push(c); ctrlBy.set(k, arr);
    });
    // deno-lint-ignore no-explicit-any
    const byId = new Map<number, any[]>();
    (items || []).forEach((it) => {
      const arr = byId.get(it.tpl_id) || [];
      arr.push({ ...it, ctrls: ctrlBy.get(ctrlKey(it.tpl_id, it.line_seq)) || [] });
      byId.set(it.tpl_id, arr);
    });
    return list.map((t) => ({ ...t, items: byId.get(t.tpl_id) || [], can_edit: editableTpl(t) }));
  };

  /* ===== v4 공통 헬퍼 ===== */
  // 관리항목 마스터 — erp_ro 는 REST 비노출이라 전용 RPC(gl_ctrl_master_get, service_role)로 읽는다.
  // deno-lint-ignore no-explicit-any
  let _ctrlMaster: any = null;
  const ctrlMaster = async () => {
    if (_ctrlMaster) return _ctrlMaster;
    try { const { data } = await admin.rpc("gl_ctrl_master_get"); _ctrlMaster = data || {}; }
    catch { _ctrlMaster = {}; }
    return _ctrlMaster;
  };
  /* 참조 마스터 값 검증(2026-08-20 레드팀 조치) — 저장 시 코드가 ERP 마스터에 있는지 확인한다.
     검색은 붙였지만 저장 검증이 없어, 복사·템플릿·API 직접호출로 임의값이 들어갈 수 있었다.
     적재되지 않은 관리항목(참조 없음)은 검증 대상이 아니므로 통과시킨다 — 없는 걸 막을 수는 없다.
     한 요청 안에서 같은 (항목,값)은 한 번만 조회한다(라인 수만큼 왕복하지 않게). */
  const refCache = new Map<string, boolean>();
  const refLoaded = new Map<string, boolean>();
  const refValid = async (ctrlCd: string, val: string): Promise<boolean> => {
    const cd = String(ctrlCd || "").trim();
    const v = String(val || "").trim();
    if (!cd || !v) return true;
    const key = cd + " " + v;
    if (refCache.has(key)) return refCache.get(key)!;
    // 이 관리항목이 참조 미러에 적재돼 있는지 먼저 본다(미적재면 검증 자체를 하지 않는다)
    if (!refLoaded.has(cd)) {
      const { count } = await admin.schema("erp_ro").from("ctrl_ref_s")
        .select("ref_cd", { count: "exact", head: true }).eq("ctrl_cd", cd);
      refLoaded.set(cd, (count || 0) > 0);
    }
    if (!refLoaded.get(cd)) { refCache.set(key, true); return true; }
    const { count } = await admin.schema("erp_ro").from("ctrl_ref_s")
      .select("ref_cd", { count: "exact", head: true }).eq("ctrl_cd", cd).eq("ref_cd", v);
    const ok = (count || 0) > 0;
    refCache.set(key, ok);
    return ok;
  };

  // 계정×차대별 관리항목 요건: Map<acct_cd, {cd, seq, req(해당 방향 필수)}[]>
  // ERP char 패딩(뒤 공백) 대비 — 키·코드·플래그 전부 trim해 매칭한다(gl_pad_trim_v1 이후 이중 안전).
  const acctCtrlFor = async (fg: "D" | "C") => {
    const m = await ctrlMaster();
    const rows: [string, string, number, string, string][] = m.acct_ctrl || [];
    const out = new Map<string, { cd: string; seq: number; req: boolean }[]>();
    rows.forEach(([acct, cd, seq, drY, crY]) => {
      const a = String(acct || "").trim();
      const arr = out.get(a) || [];
      arr.push({ cd: String(cd || "").trim(), seq: Number(seq),
                 req: String(fg === "D" ? drY : crY).trim() === "Y" });
      out.set(a, arr);
    });
    return out;
  };
  // 월반복 사용 이력 상태 동기 — 실패가 업무를 막지 않는다
  const syncUsage = (draftNo: string, status: string) =>
    admin.from("gl_template_usage").update({ status }).eq("draft_no", draftNo)
      .then(() => {}, () => {});
  // 템플릿 라인 관리항목 규칙 저장(교체).
  // 어느 라인에도 ctrls 키가 없으면(구형 화면 저장) 기존 규칙을 보존한다 — 하위호환.
  // 부서/전사 템플릿에는 민감 관리항목(사번·계좌 등)의 고정값 저장을 거부하고 input 으로 강등한다.
  // deno-lint-ignore no-explicit-any
  const saveTplCtrls = async (tplId: number, items: any[], itemsIn: Record<string, unknown>[], tplScope: string) => {
    const anyKey = itemsIn.some((r) => "ctrls" in r);
    if (!anyKey) return;
    await admin.from("gl_template_item_ctrl").delete().eq("tpl_id", tplId);
    // deno-lint-ignore no-explicit-any
    const byKey = new Map<string, any>();   // line#cd 중복 제거(나중 값 우선)
    itemsIn.forEach((r, i) => {
      const cs = Array.isArray(r.ctrls) ? (r.ctrls as Record<string, unknown>[]) : [];
      cs.slice(0, CTRL_PER_LINE_MAX).forEach((c) => {
        const cd = (clip(c.ctrl_cd, 3) || "").toUpperCase();
        if (!cd) return;
        let rule = ["fixed", "input", "date_shift"].includes(String(c.val_rule)) ? String(c.val_rule) : "input";
        let fv = rule === "fixed" ? clip(c.fixed_val, CTRL_VAL_MAX) : null;
        if (tplScope !== "user" && SENSITIVE_CTRL.has(cd)) { rule = "input"; fv = null; }
        byKey.set(items[i].line_seq + "#" + cd,
          { tpl_id: tplId, line_seq: items[i].line_seq, ctrl_cd: cd, val_rule: rule, fixed_val: fv });
      });
    });
    const rows = Array.from(byKey.values());
    if (rows.length) await admin.from("gl_template_item_ctrl").insert(rows);
  };

  /* ===== op: bootstrap — 권한·등록자·마스터 ===== */
  if (op === "bootstrap") {
    // deno-lint-ignore no-explicit-any
    let master: any = { accounts: [], cost_centers: [], depts: [], as_of: null };
    try { const { data } = await admin.rpc("gl_master_get"); master = data || master; } catch { /* 폴백 */ }
    const { data: locks } = await admin.from("gl_period_lock").select("ym").eq("locked", true);
    log("bootstrap", null);
    return json({
      ok: true,
      me: { upn: user.upn, name: ownerNm, erp_usr_id: erpUsrId, dept_nm: eff.dept_nm || null },
      can_input: canInput, can_post: canPost, is_admin: isAdmin,
      erp_user_mapped: !!erpUsrId,
      ...(erpUsrId ? {} : { 안내: "회원님의 MS 계정과 연결된 ERP 사용자 ID를 찾지 못했습니다. 초안을 저장할 수 없습니다 — 포털 관리자에게 문의하세요." }),
      master,
      locked_months: (locks || []).map((r) => r.ym),
      accounts_loaded: (master.accounts || []).length > 0,
      templates: await loadTemplates(false),
      can_manage_tpl: canManageTpl,
      // v4: 관리항목 마스터(코드 사전 + 계정×차대 요건) — 화면이 계정 선택 시 필드를 자동 생성한다
      ctrl_master: await ctrlMaster(),
      // v5.7: 검색 가능한 관리항목 목록 {ctrl_cd: 선택지수} — 화면이 🔍 버튼을 붙일 대상
      ctrl_ref_kinds: await (async () => {
        try { const { data } = await admin.rpc("gl_ctrl_ref_kinds"); return data || {}; }
        catch { return {}; }
      })(),
    });
  }

  /* ===== op: tpl_recur_list — 월반복 템플릿 + 회차 상태(F1 카드) =====
     ym 미지정 시 이번 달. 배지 4상태의 근거는 gl_template_usage(초안 생성 시 기록·상태 동기). */
  if (op === "tpl_recur_list") {
    // 기본 ym 은 KST 기준(매월 1일 00~09시 UTC 경계 오차 방지). 화면도 로컬 ym 을 명시 전송한다.
    const ym = /^\d{4}-\d{2}$/.test(String(b.ym || "")) ? String(b.ym)
      : new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
    const all = await loadTemplates(false);
    const recur = all.filter((t) => t.recur_cycle === "monthly");
    const ids = recur.map((t) => t.tpl_id);
    // deno-lint-ignore no-explicit-any
    let usages: any[] = [];
    if (ids.length) {
      const { data } = await admin.from("gl_template_usage")
        .select("tpl_id,use_ym,draft_no,status,used_by,used_at")
        .in("tpl_id", ids).order("used_at", { ascending: false }).limit(1000);
      usages = data || [];
    }
    const rows = recur.map((t) => {
      const mine = usages.filter((u) => u.tpl_id === t.tpl_id);
      const thisYm = mine.filter((u) => u.use_ym === ym && u.status !== "void");
      // 대표 상태: posted > submitted > draft (같은 회차에 여러 건이면 가장 진행된 것)
      const rank = { posted: 3, submitted: 2, draft: 1 } as Record<string, number>;
      const top = thisYm.slice().sort((a, b2) => (rank[b2.status] || 0) - (rank[a.status] || 0))[0] || null;
      const lastPosted = mine.find((u) => u.status === "posted") || null;
      return {
        tpl_id: t.tpl_id, tpl_nm: t.tpl_nm, category: t.category, scope: t.scope,
        descr: t.descr, month_offset: t.month_offset, title_pattern: t.title_pattern,
        ym, ym_status: top ? top.status : "none",
        ym_count: thisYm.length,
        // 초안번호는 본인 것일 때만(이어서 작성용), 작성자는 이메일 local-part 로 축약(노출 최소화)
        ym_draft_no: top && top.used_by === user.upn ? top.draft_no : null,
        ym_used_by: top ? String(top.used_by || "").split("@")[0] : null,
        ym_is_mine: !!(top && top.used_by === user.upn),
        last_used_at: mine[0]?.used_at || t.last_used_at || null,
        last_posted_at: lastPosted?.used_at || null,
      };
    });
    return json({ ok: true, ym, rows });
  }

  /* ===== op: tpl_apply_prev — 전월 프리필(F2) =====
     구조·규칙은 템플릿 정의에서, 변동 기본값은 "요청자 본인의 최근 확정(posted) 초안"에서만 가져온다
     (부서 공유 템플릿이어도 타인 초안은 참조하지 않는다 — 개인 식별 관리항목 노출 방지). */
  if (op === "tpl_apply_prev") {
    const id = Number(b.tpl_id);
    const { data: t } = await admin.from("gl_template").select("*").eq("tpl_id", id).maybeSingle();
    if (!t) return json({ error: "템플릿을 찾을 수 없습니다." }, 404);
    if (!visibleTpl(t)) return json({ error: "forbidden: 열람 권한이 없는 템플릿입니다." }, 403);
    const { data: tItems } = await admin.from("gl_template_item")
      .select("*").eq("tpl_id", id).order("line_seq");
    const { data: tCtrls } = await admin.from("gl_template_item_ctrl").select("*").eq("tpl_id", id);

    // 본인 최근 확정 초안(이 템플릿 유래) — usage 를 최신순으로 훑는다
    const { data: myUses } = await admin.from("gl_template_usage")
      .select("draft_no,used_at").eq("tpl_id", id).eq("used_by", user.upn).eq("status", "posted")
      .order("used_at", { ascending: false }).limit(1);
    // deno-lint-ignore no-explicit-any
    let prev: any = null;
    if (myUses && myUses.length) {
      const no = myUses[0].draft_no;
      const { data: hd } = await admin.from("gl_draft").select("*").eq("draft_no", no).maybeSingle();
      if (hd && hd.owner_upn === user.upn) {
        const { data: items } = await admin.from("gl_draft_item")
          .select("*").eq("draft_no", no).order("item_seq");
        const { data: ctrls } = await admin.from("gl_draft_item_ctrl")
          .select("item_seq,ctrl_cd,ctrl_val,invoice_seq").eq("draft_no", no);
        prev = { header: hd, items: items || [], ctrls: ctrls || [] };
      }
    }
    log("tpl_apply_prev", null, { tpl_id: id, has_prev: !!prev });
    return json({ ok: true,
      tpl: { ...t, items: (tItems || []).map((it) => ({
        ...it, ctrls: (tCtrls || []).filter((c) => c.line_seq === it.line_seq) })) },
      prev });
  }

  /* ===== op: tpl_list — 템플릿 목록. all=true 면 관리 모드(미공개 포함) ===== */
  if (op === "tpl_list") {
    // all 은 누구나 쓸 수 있다 — 범위 제한은 loadTemplates 안에서 한다(내 비공개 템플릿까지만 추가로 보임).
    return json({ ok: true, rows: await loadTemplates(!!b.all), can_manage_tpl: canManageTpl });
  }

  /* ===== op: tpl_get — 템플릿 1건 ===== */
  if (op === "tpl_get") {
    const id = Number(b.tpl_id);
    const { data: t } = await admin.from("gl_template").select("*").eq("tpl_id", id).maybeSingle();
    if (!t) return json({ error: "템플릿을 찾을 수 없습니다." }, 404);
    if (!visibleTpl(t)) return json({ error: "forbidden: 열람 권한이 없는 템플릿입니다." }, 403);
    const { data: items } = await admin.from("gl_template_item")
      .select("*").eq("tpl_id", id).order("line_seq");
    const { data: cs } = await admin.from("gl_template_item_ctrl").select("*").eq("tpl_id", id);
    return json({ ok: true, tpl: { ...t, can_edit: editableTpl(t) },
      items: (items || []).map((it) => ({ ...it, ctrls: (cs || []).filter((c) => c.line_seq === it.line_seq) })) });
  }

  /* ===== op: tpl_save — 템플릿 생성·수정 =====
     계정코드는 마스터에 있는 것만 허용한다(전표 저장 때와 동일 기준).
     차액(balance) 규칙은 방향당 1줄까지 — 두 줄이면 어느 쪽을 맞출지 정할 수 없다. */
  if (op === "tpl_save") {
    const t = (b.tpl || {}) as Record<string, unknown>;
    const itemsIn = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
    const id = b.tpl_id ? Number(b.tpl_id) : null;

    const scope = String(t.scope || "user");
    if (!["org", "dept", "user"].includes(scope)) return json({ error: "공개 범위가 올바르지 않습니다." }, 400);
    if (scope !== "user" && !canManageTpl) {
      return json({ error: "forbidden",
        안내: "전사·부서 템플릿은 관리자 또는 회계 담당자만 만들 수 있습니다. 개인 템플릿으로 저장하세요." }, 403);
    }
    if (!canInput && !canManageTpl) return json({ error: "forbidden: 템플릿 작성 권한이 없습니다." }, 403);

    const tplNm = clip(t.tpl_nm, TPL_NM_MAX);
    if (!tplNm) return json({ error: "템플릿 이름을 입력하세요." }, 400);
    if (!itemsIn.length) return json({ error: "템플릿 라인을 1줄 이상 등록하세요." }, 400);
    if (itemsIn.length > TPL_ITEM_MAX) return json({ error: `템플릿 라인은 최대 ${TPL_ITEM_MAX}줄입니다.` }, 400);

    // deno-lint-ignore no-explicit-any
    let accounts: any[] = [];
    try { const { data } = await admin.rpc("gl_master_get"); accounts = (data?.accounts || []); } catch { /* 폴백 */ }
    // deno-lint-ignore no-explicit-any
    const acctMap = new Map<string, any>(accounts.map((a) => [String(a.acct_cd), a]));
    if (!acctMap.size) return json({ error: "master_empty", 안내: "계정과목 마스터가 없어 템플릿을 검증할 수 없습니다." }, 503);

    const bal = { D: 0, C: 0 };
    // 라인 검증은 첫 오류에서 멈추고 그 줄을 알려준다(400). 예외는 아래 catch 에서 메시지로 환원.
    // deno-lint-ignore no-explicit-any
    let items: any[];
    try {
    items = itemsIn.map((r, i) => {
      const line = i + 1;
      const fg = String(r.dr_cr_fg || "").toUpperCase();
      if (fg !== "D" && fg !== "C") throw new Error(`${line}번 줄: 차변/대변을 선택하세요.`);
      const acctCd = String(r.acct_cd || "").trim();
      const acct = acctMap.get(acctCd);
      if (!acct) throw new Error(`${line}번 줄: 계정과목이 올바르지 않습니다.`);
      const rule = String(r.amt_rule || "input");
      if (!["input", "pct", "fixed", "balance"].includes(rule)) throw new Error(`${line}번 줄: 금액 규칙이 올바르지 않습니다.`);
      let val: number | null = null;
      if (rule === "pct" || rule === "fixed") {
        val = num(r.amt_value);
        if (!(val > 0)) throw new Error(`${line}번 줄: ${rule === "pct" ? "비율" : "고정금액"}을 0보다 크게 입력하세요.`);
        if (rule === "pct" && val > 100) throw new Error(`${line}번 줄: 비율은 100을 넘을 수 없습니다.`);
        if (rule === "fixed" && !Number.isInteger(val)) throw new Error(`${line}번 줄: 고정금액은 원 단위 정수로 입력하세요.`);
      }
      if (rule === "balance") bal[fg as "D" | "C"] += 1;
      return {
        line_seq: line, dr_cr_fg: fg, acct_cd: acctCd, acct_nm: acct.acct_nm || null,
        amt_rule: rule, amt_value: val,
        item_desc: clip(r.item_desc, DESC_MAX), bp_cd: clip(r.bp_cd, 30), bp_nm: clip(r.bp_nm, 100),
        cost_cd: clip(r.cost_cd, 10), project_no: clip(r.project_no, 20), vat_type: clip(r.vat_type, 2),
        acct_lock: !!r.acct_lock, note: clip(r.note, 200),
        amt_locked: !!r.amt_locked,   // v2: true=고정 필드(프리필 후 잠금 표시)
      };
    });
    } catch (e) {
      return json({ error: (e as Error).message || "템플릿 라인이 올바르지 않습니다." }, 400);
    }
    if (bal.D > 1 || bal.C > 1) {
      return json({ error: "balance_conflict",
        안내: "차액 자동(balance) 규칙은 차변·대변 각각 한 줄까지만 지정할 수 있습니다." }, 400);
    }

    const head = {
      tpl_nm: tplNm,
      category: clip(t.category, 30),
      descr: clip(t.descr, 200),
      scope,
      scope_dept_cd: scope === "dept" ? clip(t.scope_dept_cd, 10) : null,
      scope_dept_nm: scope === "dept" ? clip(t.scope_dept_nm, 60) : null,
      owner_upn: scope === "user" ? user.upn : (clip(t.owner_upn, 120) || user.upn),
      gl_type: clip(t.gl_type, 2) || GL_TYPE_DEFAULT,
      cost_cd: clip(t.cost_cd, 10),
      desc_tmpl: clip(t.desc_tmpl, DESC_MAX),
      ref_hint: clip(t.ref_hint, 100),
      amount_mode: String(t.amount_mode || "total") === "manual" ? "manual" : "total",
      status: ["draft", "active", "archived"].includes(String(t.status)) ? String(t.status) : "draft",
      erp_case_cd: clip(t.erp_case_cd, 30),
      sort_no: Number.isFinite(Number(t.sort_no)) ? Number(t.sort_no) : 100,
      // v2 월반복 속성 — 요청 본문에 키가 있을 때만 갱신(구형 화면 저장이 기존 값을 null 로 덮지 않게, 하위호환)
      ...("recur_cycle" in t ? { recur_cycle: String(t.recur_cycle || "") === "monthly" ? "monthly" : null } : {}),
      ...("title_pattern" in t ? { title_pattern: clip(t.title_pattern, DESC_MAX) } : {}),
      ...("month_offset" in t ? { month_offset: t.month_offset === 0 || t.month_offset === -1 ? Number(t.month_offset) : null } : {}),
      ...("vat_mode" in t ? { vat_mode: ["taxable", "exempt"].includes(String(t.vat_mode)) ? String(t.vat_mode) : null } : {}),
      ...("src_family_key" in t ? { src_family_key: clip(t.src_family_key, 120) } : {}),
      updated_by: user.upn, updated_at: nowIso,
    };
    if (scope === "dept" && !head.scope_dept_cd) return json({ error: "부서 템플릿은 부서를 선택해야 합니다." }, 400);

    let tplId = id;
    if (tplId) {
      const { data: cur } = await admin.from("gl_template").select("*").eq("tpl_id", tplId).maybeSingle();
      if (!cur) return json({ error: "템플릿을 찾을 수 없습니다." }, 404);
      if (!editableTpl(cur)) return json({ error: "forbidden: 이 템플릿을 수정할 권한이 없습니다." }, 403);
      const { error } = await admin.from("gl_template").update(head).eq("tpl_id", tplId);
      if (error) return json({ error: "템플릿 저장 실패: " + error.message }, 500);
      await admin.from("gl_template_item").delete().eq("tpl_id", tplId);
    } else {
      const { data: ins, error } = await admin.from("gl_template")
        .insert({ ...head, created_by: user.upn }).select("tpl_id,tpl_code").single();
      if (error) return json({ error: "템플릿 저장 실패: " + error.message }, 500);
      tplId = ins.tpl_id;
    }
    const { error: itErr } = await admin.from("gl_template_item")
      .insert(items.map((it) => ({ ...it, tpl_id: tplId })));
    if (itErr) return json({ error: "템플릿 라인 저장 실패: " + itErr.message }, 500);
    await saveTplCtrls(tplId!, items, itemsIn, scope);   // v2: 라인 관리항목 규칙(ctrls 키가 있을 때만 교체)

    log("tpl_save", null, { tpl_id: tplId, tpl_nm: tplNm, scope, lines: items.length, new: !id });
    return json({ ok: true, tpl_id: tplId, 안내: `템플릿 '${tplNm}' 을(를) 저장했습니다.` });
  }

  /* ===== op: tpl_status — 공개/비공개 전환 ===== */
  if (op === "tpl_status") {
    const id = Number(b.tpl_id);
    const st = String(b.status || "");
    if (!["draft", "active", "archived"].includes(st)) return json({ error: "상태값이 올바르지 않습니다." }, 400);
    const { data: cur } = await admin.from("gl_template").select("*").eq("tpl_id", id).maybeSingle();
    if (!cur) return json({ error: "템플릿을 찾을 수 없습니다." }, 404);
    if (!editableTpl(cur)) return json({ error: "forbidden: 권한이 없습니다." }, 403);
    const { error } = await admin.from("gl_template")
      .update({ status: st, updated_by: user.upn, updated_at: nowIso }).eq("tpl_id", id);
    if (error) return json({ error: "상태 변경 실패: " + error.message }, 500);
    log("tpl_status", null, { tpl_id: id, status: st });
    return json({ ok: true, 안내: st === "active" ? "템플릿을 공개했습니다." : st === "draft" ? "템플릿을 비공개(초안)로 되돌렸습니다." : "템플릿을 보관 처리했습니다." });
  }

  /* ===== op: tpl_delete — 완전 삭제(라인 cascade) ===== */
  if (op === "tpl_delete") {
    const id = Number(b.tpl_id);
    const { data: cur } = await admin.from("gl_template").select("*").eq("tpl_id", id).maybeSingle();
    if (!cur) return json({ error: "템플릿을 찾을 수 없습니다." }, 404);
    if (!editableTpl(cur)) return json({ error: "forbidden: 권한이 없습니다." }, 403);
    const { error } = await admin.from("gl_template").delete().eq("tpl_id", id);
    if (error) return json({ error: "삭제 실패: " + error.message }, 500);
    log("tpl_delete", null, { tpl_id: id, tpl_nm: cur.tpl_nm });
    return json({ ok: true, 안내: `템플릿 '${cur.tpl_nm}' 을(를) 삭제했습니다.` });
  }

  /* ===== op: tpl_use — 적용 기록(어떤 템플릿이 실제로 쓰이는지 남긴다) ===== */
  if (op === "tpl_use") {
    const id = Number(b.tpl_id);
    const { data: cur } = await admin.from("gl_template").select("use_cnt,scope,owner_upn,scope_dept_nm").eq("tpl_id", id).maybeSingle();
    // 열람 권한이 없는 템플릿은 카운트하지 않는다(통계 오염 방지). 응답은 동일하게 ok — 존재 여부를 흘리지 않는다.
    if (!cur || !visibleTpl(cur)) return json({ ok: true });
    await admin.from("gl_template")
      .update({ use_cnt: Number(cur.use_cnt || 0) + 1, last_used_at: nowIso }).eq("tpl_id", id);
    log("tpl_use", null, { tpl_id: id });
    return json({ ok: true });
  }

  /* ===== op: bp — 거래처 검색(2자 이상, 최대 30건) ===== */
  if (op === "bp") {
    const q = String(b.q || "").trim();
    if (q.length < 2) return json({ ok: true, rows: [] });
    const { data } = await admin.rpc("gl_bp_search", { p_q: q });
    return json({ ok: true, rows: data || [] });
  }

  /* ===== op: ctrl_ref — 관리항목 참조 검색(프로젝트·은행·계산서유형 등 19종 공용) =====
     어떤 관리항목이 검색 가능한지는 서버(ctrl_ref_s 적재분)가 정한다 — 화면 하드코딩 없음.
     민감 항목(사번·계좌·카드·어음·차입)은 애초에 적재하지 않아 여기서도 조회되지 않는다. */
  if (op === "ctrl_ref") {
    const cd = String(b.ctrl_cd || "").trim();
    if (!cd) return json({ ok: true, rows: [] });
    const { data } = await admin.rpc("gl_ctrl_ref_search",
      { p_ctrl_cd: cd, p_q: String(b.q || "").trim() });
    // 사번·계좌·카드·어음·차입 조회는 누가 언제 봤는지 남긴다(CLAUDE.md §6 감사 로그).
    // 값은 남기지 않는다 — 검색어와 결과 건수만.
    if (SENSITIVE_CTRL.has(cd)) {
      log("ctrl_ref", null, { ctrl_cd: cd, q_len: String(b.q || "").trim().length,
                              hits: (data || []).length });
    }
    return json({ ok: true, rows: data || [] });
  }

  /* ===== op: item — 품목 검색(관리항목 MK 팝업용, 2자 이상, 최대 30건) ===== */
  if (op === "item") {
    const q = String(b.q || "").trim();
    if (q.length < 2) return json({ ok: true, rows: [] });
    const { data } = await admin.rpc("gl_item_search", { p_q: q });
    return json({ ok: true, rows: data || [] });
  }

  /* ===== op: slip_list — 전표복사: 본인 ERP 결의전표 목록(미러) =====
     소유 필터는 RPC 가 강제 — 여기서 넘기는 erpUsrId 는 JWT 매핑 결과뿐(위조 불가). */
  if (op === "slip_list") {
    if (!canInput) return json({ error: "forbidden: 초안 작성 권한이 없습니다." }, 403);
    if (!erpUsrId) {
      return json({ error: "erp_user_unmapped",
        안내: "MS 계정과 연결된 ERP 사용자 ID가 없어 본인 전표를 조회할 수 없습니다." }, 409);
    }
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(b.from || "")) ? String(b.from) : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(b.to || "")) ? String(b.to) : null;
    const q = clip(b.q, 60);
    const { data, error } = await admin.rpc("gl_slip_list",
      { p_erp_usr_id: erpUsrId, p_from: from, p_to: to, p_q: q });
    if (error) return json({ error: "조회 실패: " + error.message }, 500);
    // deno-lint-ignore no-explicit-any
    const rows = (data || []) as any[];
    let asOf: string | null = null;   // 미러 최근 동기 시점 — 야간 배치라 실시간이 아님을 화면에 알린다
    try { const { data: s } = await admin.rpc("gl_slip_synced_at"); asOf = (s as string) || null; } catch { /* 폴백 */ }
    log("slip_list", null, { from, to, q, rows: rows.length });
    return json({ ok: true, rows, as_of: asOf });
  }

  /* ===== op: slip_get — 전표복사: 본인 전표 1건(헤더+라인+관리항목) ===== */
  if (op === "slip_get") {
    if (!canInput) return json({ error: "forbidden: 초안 작성 권한이 없습니다." }, 403);
    if (!erpUsrId) return json({ error: "erp_user_unmapped" }, 409);
    const no = String(b.temp_gl_no || "").trim();
    if (!no) return json({ error: "전표번호가 필요합니다." }, 400);
    const { data, error } = await admin.rpc("gl_slip_get", { p_erp_usr_id: erpUsrId, p_no: no });
    if (error) return json({ error: "조회 실패: " + error.message }, 500);
    if (!data) {
      log("denied", null, { op, temp_gl_no: no, reason: "slip_not_owner_or_missing" });
      return json({ error: "전표를 찾을 수 없거나 본인이 등록한 전표가 아닙니다." }, 404);
    }
    log("slip_view", null, { temp_gl_no: no });
    return json({ ok: true, ...data });
  }

  /* ===== op: save — 초안 저장(신규/수정). 서버 재검증이 여기 전부 모여 있다 ===== */
  if (op === "save") {
    if (!canInput) return json({ error: "forbidden: 초안 작성 권한이 없습니다." }, 403);
    if (!erpUsrId) {
      log("denied", null, { reason: "erp_user_unmapped" });
      return json({ error: "erp_user_unmapped",
        안내: "MS 계정과 연결된 ERP 사용자 ID가 없어 초안을 만들 수 없습니다. 전표 등록자는 ERP 계정 기준이어야 합니다." }, 409);
    }

    const h = (b.header || {}) as Record<string, unknown>;
    const itemsIn = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
    const draftNo = b.draft_no ? String(b.draft_no) : null;

    /* --- 헤더 검증 --- */
    const draftDt = String(h.draft_dt || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draftDt)) return json({ error: "결의일자를 선택하세요." }, 400);
    const glDesc = clip(h.gl_desc, DESC_MAX);
    if (!glDesc) return json({ error: "적요를 입력하세요." }, 400);

    // 마감월 — 잠긴 월에는 결의할 수 없다(레지스트리가 비어 있으면 제한 없음)
    const ym = draftDt.slice(0, 7);
    const { data: lock } = await admin.from("gl_period_lock")
      .select("ym,note").eq("ym", ym).eq("locked", true).maybeSingle();
    if (lock) {
      return json({ error: "period_locked",
        안내: `${ym} 은(는) 마감된 회계기간입니다. 결의일자를 변경하세요.${lock.note ? " (" + lock.note + ")" : ""}` }, 409);
    }

    /* --- 라인 검증 --- */
    if (itemsIn.length < 2) return json({ error: "전표 라인은 차변·대변 최소 2줄이 필요합니다." }, 400);
    if (itemsIn.length > MAX_ITEMS) return json({ error: `전표 라인은 최대 ${MAX_ITEMS}줄까지 가능합니다.` }, 400);

    // 계정 유효성 — 마스터에 있고 사용중인 코드만. project_fg='Y' 면 프로젝트 필수.
    // deno-lint-ignore no-explicit-any
    let accounts: any[] = [];
    // deno-lint-ignore no-explicit-any
    let costCenters: any[] = [];
    try {
      const { data } = await admin.rpc("gl_master_get");
      accounts = (data?.accounts || []);
      costCenters = (data?.cost_centers || []);
    } catch { /* 폴백 */ }
    if (!accounts.length) {
      return json({ error: "master_empty",
        안내: "계정과목 마스터가 아직 적재되지 않아 초안을 검증할 수 없습니다. 관리자에게 문의하세요." }, 503);
    }
    // deno-lint-ignore no-explicit-any
    const acctMap = new Map<string, any>(accounts.map((a) => [String(a.acct_cd), a]));
    // 코스트센터는 필수값(2026-08-20 관리자 지시). 폐지된 코드는 gl_master_get 이 이미 제외한다.
    const costSet = new Set(costCenters.map((c) => String(c.cost_cd).trim()));

    const items: Record<string, unknown>[] = [];
    let dr = 0, cr = 0;
    for (let i = 0; i < itemsIn.length; i++) {
      const r = itemsIn[i];
      const line = i + 1;
      const fg = String(r.dr_cr_fg || "").toUpperCase();
      if (fg !== "D" && fg !== "C") return json({ error: `${line}번 줄: 차변/대변을 선택하세요.` }, 400);

      const acctCd = String(r.acct_cd || "").trim();
      const acct = acctMap.get(acctCd);
      if (!acct) return json({ error: `${line}번 줄: 계정과목이 올바르지 않습니다.` }, 400);

      const amt = num(r.item_amt);
      if (!(amt > 0)) return json({ error: `${line}번 줄: 금액은 0보다 커야 합니다.` }, 400);
      if (!Number.isInteger(amt)) return json({ error: `${line}번 줄: 금액은 원 단위 정수로 입력하세요.` }, 400);

      const projectNo = clip(r.project_no, 20) || clip(h.project_no, 20);
      if (String(acct.project_fg || "") === "Y" && !projectNo) {
        return json({ error: `${line}번 줄: '${acct.acct_nm}' 계정은 프로젝트가 필요합니다.` }, 400);
      }
      // 프로젝트 코드 화이트리스트(2026-08-20) — 화면은 조회식이지만 복사·템플릿·API 직접호출로
      // 임의값이 들어올 수 있다. 실제로 자유입력 시절 '2026-01'(월 표기)이 저장된 초안이 있었다.
      if (projectNo && !(await refValid("PC", projectNo))) {
        return json({ error: `${line}번 줄: 프로젝트 '${projectNo}' 는 ERP 프로젝트 마스터에 없습니다. 검색해서 선택하세요.` }, 400);
      }

      // 코스트센터 필수 + 화이트리스트 재검증(화면 값만 믿지 않는다 — 폐지 코드 유입 차단)
      const lineCost = (clip(r.cost_cd, 10) || clip(h.cost_cd, 10) || "").trim();
      if (!lineCost) {
        return json({ error: `${line}번 줄: 코스트센터는 필수입니다. 전표 기본 코스트센터를 고르거나 줄마다 지정하세요.` }, 400);
      }
      if (costSet.size && !costSet.has(lineCost)) {
        return json({ error: `${line}번 줄: 사용할 수 없는 코스트센터입니다(${lineCost}). 폐지됐거나 존재하지 않습니다.` }, 400);
      }

      if (fg === "D") dr += amt; else cr += amt;
      items.push({
        item_seq: line, dr_cr_fg: fg,
        acct_cd: acctCd, acct_nm: acct.acct_nm || null,
        item_amt: amt,
        item_desc: clip(r.item_desc, DESC_MAX) || glDesc,
        bp_cd: clip(r.bp_cd, 30), bp_nm: clip(r.bp_nm, 100),
        cost_cd: lineCost,
        project_no: projectNo,
        vat_type: clip(r.vat_type, 2), vat_amt: r.vat_amt != null ? num(r.vat_amt) : null,
      });
    }
    // 차대 일치 — 프론트가 뭘 보내든 여기서 막는다
    if (dr !== cr) {
      return json({ error: "unbalanced",
        안내: `차변 합계(${dr.toLocaleString()})와 대변 합계(${cr.toLocaleString()})가 일치하지 않습니다.` }, 400);
    }

    /* --- v4: 관리항목 검증·수집 (요청이 보낼 때만 — 구화면 하위호환) ---
       필수(플래그 Y) 강제는 신형 화면(ctrl_aware=true)에만 적용, 그 외엔 warnings 로 알린다.
       세액 자동계산·관계식 강제는 하지 않는다(B2 결정 2026-08-11 — 실물 증빙 값이 정답). */
    const ctrlRows: Record<string, unknown>[] = [];
    const warnings: string[] = [];
    const ctrlAware = b.ctrl_aware === true;
    // deno-lint-ignore no-explicit-any
    const anyCtrls = itemsIn.some((r) => Array.isArray((r as any).ctrls) && ((r as any).ctrls as any[]).length > 0);
    if (ctrlAware || anyCtrls) {
      const m = await ctrlMaster();
      // deno-lint-ignore no-explicit-any
      const known = new Set(((m.ctrl_items || []) as any[]).map((c) => String(c.ctrl_cd).trim()));
      // 오류 메시지에 코드 대신 항목명을 보여주기 위한 사전(예: PC → 프로젝트코드)
      // deno-lint-ignore no-explicit-any
      const ctrlNmOf = new Map<string, string>(((m.ctrl_items || []) as any[])
        .map((c) => [String(c.ctrl_cd).trim(), String(c.ctrl_nm || "").trim()]));
      const reqD = await acctCtrlFor("D");
      const reqC = await acctCtrlFor("C");
      for (let i = 0; i < itemsIn.length; i++) {
        const r = itemsIn[i];
        const line = i + 1;
        const fg = String(r.dr_cr_fg || "").toUpperCase() as "D" | "C";
        const acctCd = String(r.acct_cd || "").trim();
        const cs = Array.isArray(r.ctrls) ? (r.ctrls as Record<string, unknown>[]) : [];
        if (cs.length > CTRL_PER_LINE_MAX) {
          return json({ error: `${line}번 줄: 관리항목이 너무 많습니다(최대 ${CTRL_PER_LINE_MAX}종).` }, 400);
        }
        // 코드별 중복 제거(대소문자 변형 포함 — 나중 값 우선). PK(draft_no,item_seq,ctrl_cd) 충돌 예방.
        const given = new Map<string, { val: string; inv: number | null }>();
        for (const c of cs) {
          const cd = String(c.ctrl_cd || "").trim().toUpperCase();
          if (!cd) continue;
          if (known.size && !known.has(cd)) {
            return json({ error: `${line}번 줄: 알 수 없는 관리항목 코드(${cd})입니다.` }, 400);
          }
          const val = clip(c.ctrl_val, CTRL_VAL_MAX);
          if (val == null) continue;   // 빈 값은 저장하지 않는다
          const inv = Number(c.invoice_seq);
          given.set(cd, { val, inv: Number.isInteger(inv) && inv > 0 ? inv : null });
        }
        // 참조 마스터가 있는 관리항목은 값이 실제로 존재하는 코드인지 확인한다(2026-08-20).
        // 틀린 코드는 ERP 투입 단계에서야 터지므로, 저장 시점에 잡아 돌려보낸다.
        for (const [cd, v] of given) {
          if (!(await refValid(cd, v.val))) {
            const nm = (ctrlNmOf.get(cd) || cd);
            return json({ error: "ctrl_ref_invalid",
              안내: `${line}번 줄: ${nm}(${cd}) 값 '${v.val}' 은(는) ERP 마스터에 없습니다. 🔍 검색해서 선택하세요.` }, 400);
          }
        }
        given.forEach((v, cd) =>
          ctrlRows.push({ item_seq: line, ctrl_cd: cd, ctrl_val: v.val, invoice_seq: v.inv }));
        // V6(거래처코드) ↔ 라인 거래처 일치 — 데이터 정합(하드, 세액 계산 아님)
        const bpCd = String(r.bp_cd || "").trim();
        const v6 = given.get("V6")?.val;
        if (v6 && bpCd && v6 !== bpCd) {
          return json({ error: "ctrl_bp_mismatch",
            안내: `${line}번 줄: 관리항목 거래처코드(V6=${v6})가 라인 거래처(${bpCd})와 다릅니다.` }, 400);
        }
        // 필수 관리항목(acct_ctrl_assn 플래그 Y) — 신형 화면에만 하드
        const req = ((fg === "D" ? reqD : reqC).get(acctCd) || []).filter((x) => x.req);
        const missing = req.filter((x) => !given.has(x.cd)).map((x) => x.cd);
        if (missing.length) {
          const msg = `${line}번 줄(${acctCd}): 필수 관리항목 누락 — ${missing.join(", ")}`;
          if (ctrlAware) return json({ error: "ctrl_required", 안내: msg }, 400);
          warnings.push(msg);
        }
        // 이상치 경고(소프트) — 계산서일(V2)이 결의일자보다 미래
        const v2 = given.get("V2")?.val;
        if (v2 && /^\d{4}-\d{2}-\d{2}$/.test(v2) && v2 > draftDt) {
          warnings.push(`${line}번 줄: 계산서일(${v2})이 결의일자(${draftDt})보다 미래입니다 — 실물 계산서를 확인하세요.`);
        }
      }
    }

    const headerRow = {
      draft_dt: draftDt,
      gl_type: clip(h.gl_type, 2) || GL_TYPE_DEFAULT,
      dept_cd: clip(h.dept_cd, 10), dept_nm: clip(h.dept_nm, 60),
      cost_cd: clip(h.cost_cd, 10),
      gl_desc: glDesc,
      project_no: clip(h.project_no, 20),
      ref_no: clip(h.ref_no, REF_MAX),
      owner_upn: user.upn, owner_erp_usr_id: erpUsrId, owner_nm: ownerNm,
      dr_total: dr, cr_total: cr,
      updated_at: nowIso,
    };

    let no = draftNo;
    if (no) {
      // 수정 — 본인의 작성중(draft) 건만
      const { data: cur } = await admin.from("gl_draft")
        .select("draft_no,status,owner_upn").eq("draft_no", no).maybeSingle();
      if (!cur) return json({ error: "초안을 찾을 수 없습니다." }, 404);
      if (cur.owner_upn !== user.upn) return json({ error: "forbidden: 본인이 작성한 초안만 수정할 수 있습니다." }, 403);
      if (cur.status !== "draft") return json({ error: "이미 제출·확정된 초안은 수정할 수 없습니다." }, 409);
      // 위 검사는 읽고-나서-쓰기라, 확인과 저장 사이에 다른 탭이 제출하면 덮어쓸 수 있다.
      // UPDATE 조건에 상태·소유자를 함께 걸어 그 틈을 닫는다(조건에 안 맞으면 0행 → 409).
      const { data: upd, error } = await admin.from("gl_draft").update(headerRow)
        .eq("draft_no", no).eq("status", "draft").eq("owner_upn", user.upn).select("draft_no");
      if (!error && (!upd || upd.length === 0)) {
        return json({ error: "conflict",
          안내: "저장하는 사이에 이 초안이 제출·확정됐습니다. 화면을 새로 고쳐 확인하세요." }, 409);
      }
      if (error) return json({ error: "저장 실패: " + error.message }, 500);
      await admin.from("gl_draft_item").delete().eq("draft_no", no);
    } else {
      // 신규 — 미확정 보유 상한
      const { count } = await admin.from("gl_draft")
        .select("id", { count: "exact", head: true })
        .eq("owner_upn", user.upn).in("status", ["draft", "submitted"]);
      if ((count || 0) >= DRAFT_LIMIT) {
        return json({ error: "too_many_drafts",
          안내: `미확정 초안이 ${DRAFT_LIMIT}건을 넘었습니다. 기존 초안을 제출하거나 삭제한 뒤 작성하세요.` }, 429);
      }
      const { data: ins, error } = await admin.from("gl_draft").insert(headerRow).select("draft_no").single();
      if (error) return json({ error: "저장 실패: " + error.message }, 500);
      no = ins.draft_no;
    }

    const { error: itemErr } = await admin.from("gl_draft_item")
      .insert(items.map((it) => ({ ...it, draft_no: no })));
    if (itemErr) return json({ error: "라인 저장 실패: " + itemErr.message }, 500);

    // v4: 관리항목 교체 저장 — 관리항목을 다루는 요청(신형 화면)일 때만.
    // 구형 화면(ctrls 미전송) 재저장이 기존 관리항목을 지우지 않게 한다(하위호환).
    if (ctrlAware || anyCtrls) {
      await admin.from("gl_draft_item_ctrl").delete().eq("draft_no", no);
      if (ctrlRows.length) {
        const { error: cErr } = await admin.from("gl_draft_item_ctrl")
          .insert(ctrlRows.map((c) => ({ ...c, draft_no: no })));
        if (cErr) return json({ error: "관리항목 저장 실패: " + cErr.message }, 500);
      }
    }

    // v4: 월반복 회차 기록 — 템플릿 유래 초안이면 usage 를 남긴다(F1 배지의 근거).
    // 배지 데이터 위조 방지: 템플릿이 실제 존재하고 요청자에게 보이는 것일 때만 기록한다.
    const tplId = Number(b.tpl_id);
    if (Number.isInteger(tplId) && tplId > 0) {
      const { data: tref } = await admin.from("gl_template")
        .select("tpl_id,scope,owner_upn,scope_dept_nm").eq("tpl_id", tplId).maybeSingle();
      if (tref && visibleTpl(tref)) {
        // use_ym 은 결의월 ±2개월 이내만 허용(소급·선행 회차) — 벗어나면 결의월로 대체
        let useYm = /^\d{4}-\d{2}$/.test(String(b.use_ym || "")) ? String(b.use_ym) : draftDt.slice(0, 7);
        const monthIdx = (s: string) => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7));
        if (Math.abs(monthIdx(useYm) - monthIdx(draftDt.slice(0, 7))) > 2) useYm = draftDt.slice(0, 7);
        await admin.from("gl_template_usage")
          .upsert({ tpl_id: tplId, draft_no: no, use_ym: useYm, status: "draft", used_by: user.upn },
                  { onConflict: "tpl_id,draft_no" })
          .then(() => {}, () => {});
      }
    }

    log("save", no, { items: items.length, dr, cr, ctrls: ctrlRows.length,
      ctrl_aware: ctrlAware, warn_cnt: warnings.length, new: !draftNo });
    return json({ ok: true, draft_no: no, dr_total: dr, cr_total: cr, warnings,
      안내: `초안을 저장했습니다(${no}). 제출하면 회계 담당자가 ERP에 등록합니다.` });
  }

  /* ===== op: mine — 내 초안 목록 ===== */
  if (op === "mine") {
    const { data, error } = await admin.from("gl_draft")
      .select("draft_no,draft_dt,gl_desc,dept_nm,dr_total,cr_total,status,erp_temp_gl_no,erp_apply_status,erp_apply_gl_no,erp_apply_target,created_at,submitted_at,posted_at")
      .eq("owner_upn", user.upn).order("created_at", { ascending: false }).limit(100);
    if (error) return json({ error: "조회 실패: " + error.message }, 500);
    return json({ ok: true, rows: data || [] });
  }

  /* ===== op: get — 초안 1건(헤더+라인) ===== */
  if (op === "get") {
    const no = String(b.draft_no || "");
    const { data: hd } = await admin.from("gl_draft").select("*").eq("draft_no", no).maybeSingle();
    if (!hd) return json({ error: "초안을 찾을 수 없습니다." }, 404);
    // 본인 것이거나, 확정 권한자(회계 담당자)만 열람.
    // 단 타인의 미제출(draft) 초안은 회계 담당자도 열람 불가 — 제출 의사 확정 전 데이터 보호(최소권한).
    if (hd.owner_upn !== user.upn && (!canPost || hd.status === "draft")) {
      log("denied", no, { reason: hd.owner_upn !== user.upn && hd.status === "draft" ? "draft_not_owner" : "not_owner" });
      return json({ error: "forbidden: 열람 권한이 없습니다." }, 403);
    }
    const { data: items } = await admin.from("gl_draft_item")
      .select("*").eq("draft_no", no).order("item_seq");
    const { data: cs } = await admin.from("gl_draft_item_ctrl")
      .select("item_seq,ctrl_cd,ctrl_val,invoice_seq").eq("draft_no", no);
    log("view", no);
    return json({ ok: true, header: hd,
      items: (items || []).map((it) => ({ ...it, ctrls: (cs || []).filter((c) => c.item_seq === it.item_seq) })) });
  }

  /* ===== op: submit — 제출(작성중 → 제출됨) ===== */
  if (op === "submit") {
    const no = String(b.draft_no || "");
    const { data: cur } = await admin.from("gl_draft")
      .select("draft_no,status,owner_upn,dr_total,cr_total").eq("draft_no", no).maybeSingle();
    if (!cur) return json({ error: "초안을 찾을 수 없습니다." }, 404);
    if (cur.owner_upn !== user.upn) return json({ error: "forbidden: 본인 초안만 제출할 수 있습니다." }, 403);
    if (cur.status !== "draft") return json({ error: "이미 제출된 초안입니다." }, 409);
    if (Number(cur.dr_total) !== Number(cur.cr_total)) {
      return json({ error: "차변·대변 합계가 일치하지 않아 제출할 수 없습니다." }, 400);
    }
    const { error } = await admin.from("gl_draft")
      .update({ status: "submitted", submitted_at: nowIso, updated_at: nowIso }).eq("draft_no", no);
    if (error) return json({ error: "제출 실패: " + error.message }, 500);
    await syncUsage(no, "submitted");
    log("submit", no);
    return json({ ok: true, 안내: "제출했습니다. 회계 담당자가 ERP에 등록한 뒤 전표번호가 표시됩니다." });
  }

  /* ===== op: void — 폐기(본인, 작성중·제출됨 한정) ===== */
  if (op === "void") {
    const no = String(b.draft_no || "");
    const { data: cur } = await admin.from("gl_draft")
      .select("draft_no,status,owner_upn").eq("draft_no", no).maybeSingle();
    if (!cur) return json({ error: "초안을 찾을 수 없습니다." }, 404);
    if (cur.owner_upn !== user.upn && !canPost) return json({ error: "forbidden" }, 403);
    if (cur.status === "posted") return json({ error: "이미 ERP에 등록된 건은 폐기할 수 없습니다. 회계 담당자에게 문의하세요." }, 409);
    const { error } = await admin.from("gl_draft").update({
      status: "void", void_reason: clip(b.reason, 200), updated_at: nowIso,
    }).eq("draft_no", no);
    if (error) return json({ error: "폐기 실패: " + error.message }, 500);
    await syncUsage(no, "void");
    log("void", no, { reason: clip(b.reason, 200) });
    return json({ ok: true, 안내: "초안을 폐기했습니다." });
  }

  /* ===== op: list — 제출된 초안 목록(회계 담당자) =====
     최소권한: 타인의 미제출(draft) 초안은 목록에 내리지 않는다 — 확정 업무는 submitted 이후다. */
  if (op === "list") {
    if (!canPost) return json({ error: "forbidden: 회계 담당자 전용입니다." }, 403);
    let q = admin.from("gl_draft")
      .select("draft_no,draft_dt,gl_type,dept_nm,cost_cd,gl_desc,ref_no,owner_upn,owner_nm,owner_erp_usr_id,dr_total,cr_total,status,erp_temp_gl_no,erp_apply_status,erp_apply_gl_no,erp_apply_target,created_at,submitted_at,posted_at")
      .order("submitted_at", { ascending: true, nullsFirst: false }).limit(300);
    const st = String(b.status || "submitted");
    if (st === "draft") return json({ error: "forbidden: 작성중(미제출) 초안은 작성자 본인만 볼 수 있습니다." }, 403);
    if (st !== "all") q = q.eq("status", st);
    else q = q.neq("status", "draft");
    const { data, error } = await q;
    if (error) return json({ error: "조회 실패: " + error.message }, 500);
    log("list", null, { status: st });
    return json({ ok: true, rows: data || [] });
  }

  /* ===== op: post — ERP 확정 기록(회계 담당자). 포털이 ERP에 쓰는 것이 아니라 "사람이 등록한 결과"를 기록한다.
     v5.4부터 화면에서는 호출하지 않는다(전송 성공 시 gl_apply_record 가 자동 확정) — 수기 등록 폴백용으로만 유지. ===== */
  if (op === "post") {
    if (!canPost) return json({ error: "forbidden: 회계 담당자 전용입니다." }, 403);
    const no = String(b.draft_no || "");
    const tempGlNo = clip(b.erp_temp_gl_no, 18);
    if (!tempGlNo) {
      return json({ error: "erp_no_required",
        안내: "ERP에서 저장된 결의전표번호를 입력해야 확정 처리할 수 있습니다. 이 번호가 이중 입력을 막는 유일한 장치입니다." }, 400);
    }
    // 형식 검증 — A2 승인 후 ERP 실측으로 확정(2026-08-03): TEMP_GL_NO 는 'TG'+YYYYMMDD+4자리 순번(14자).
    // 2026년 2,947건 전량 이 형식이다. 오타·임의값('1' 같은)이 확정 처리되던 공백을 막는다.
    if (!TEMP_GL_NO_RE.test(tempGlNo)) {
      return json({ error: "erp_no_format",
        안내: `결의전표번호 형식이 올바르지 않습니다(입력값: ${tempGlNo}). ERP 결의전표번호는 TG + 날짜8자리 + 순번4자리 형식입니다 — 예: TG202608030001` }, 400);
    }
    const { data: cur } = await admin.from("gl_draft")
      .select("draft_no,status").eq("draft_no", no).maybeSingle();
    if (!cur) return json({ error: "초안을 찾을 수 없습니다." }, 404);
    if (cur.status === "posted") return json({ error: "이미 확정 처리된 초안입니다." }, 409);
    if (cur.status === "void") return json({ error: "폐기된 초안입니다." }, 409);

    // 같은 ERP 전표번호가 다른 초안에 이미 기입돼 있으면 거부 — 이중 등록 탐지.
    // maybeSingle 은 2건 이상이면 오류로 null 이 되어 검사가 뚫린다 — 목록 조회로 판정한다.
    const { data: dups } = await admin.from("gl_draft")
      .select("draft_no").eq("erp_temp_gl_no", tempGlNo).neq("draft_no", no).limit(1);
    if (dups && dups.length) {
      return json({ error: "duplicate_erp_no",
        안내: `이 ERP 전표번호(${tempGlNo})는 이미 다른 초안(${dups[0].draft_no})에 기록되어 있습니다. 중복 등록이 아닌지 확인하세요.` }, 409);
    }

    const { error } = await admin.from("gl_draft").update({
      status: "posted", erp_temp_gl_no: tempGlNo,
      posted_by: user.upn, posted_at: nowIso, updated_at: nowIso,
    }).eq("draft_no", no);
    if (error) return json({ error: "확정 실패: " + error.message }, 500);
    await syncUsage(no, "posted");
    log("post", no, { erp_temp_gl_no: tempGlNo });
    return json({ ok: true, 안내: `ERP 전표번호 ${tempGlNo} 로 확정 기록했습니다.` });
  }

  /* ===== op: apply_request — [ERP 전송] 대기 등록(회계 담당자·관리자 전용, C-11 1차: DEMO2) =====
     실제 투입은 사내 중계(gl_apply_demo2.py --queue/--watch)가 수행 — 여기서는 ready 마킹만.
     포털은 ERP에 직접 쓰지 않는다는 경계를 유지한다(기회검토 채택 구조: 사내 pull). */
  if (op === "apply_request") {
    if (!canPost) return json({ error: "forbidden: 회계 담당자 전용입니다." }, 403);
    const no = String(b.draft_no || "");
    const { data: cur } = await admin.from("gl_draft")
      .select("draft_no,status,erp_apply_status,erp_apply_gl_no").eq("draft_no", no).maybeSingle();
    if (!cur) return json({ error: "초안을 찾을 수 없습니다." }, 404);
    if (cur.status !== "submitted") {
      return json({ error: "제출됨 상태의 초안만 ERP로 전송할 수 있습니다." }, 409);
    }
    if (cur.erp_apply_status === "applied") {
      return json({ error: "already_applied",
        안내: `이미 ERP에 적용된 초안입니다(${cur.erp_apply_gl_no || ""}).` }, 409);
    }
    if (cur.erp_apply_status === "ready") {
      return json({ ok: true, 안내: "이미 전송 대기 중입니다 — 중계가 곧 처리합니다." });
    }
    const { error } = await admin.from("gl_draft").update({
      erp_apply_status: "ready", erp_apply_target: "JEILMNS_DEMO2",
      erp_apply_msg: null, updated_at: nowIso,
    }).eq("draft_no", no);
    if (error) return json({ error: "전송 요청 실패: " + error.message }, 500);
    log("apply_request", no, { target: "JEILMNS_DEMO2" });
    return json({ ok: true,
      안내: "ERP 전송 대기로 등록했습니다(대상: DEMO2). 사내 중계가 자동 투입하며, 완료되면 「ERP 적용」 열에 전표번호(AG…)가 표시됩니다." });
  }

  /* ===== op: apply_cancel — 전송 대기 취소(중계가 아직 집지 않은 건만) ===== */
  if (op === "apply_cancel") {
    if (!canPost) return json({ error: "forbidden: 회계 담당자 전용입니다." }, 403);
    const no = String(b.draft_no || "");
    const { data: cur } = await admin.from("gl_draft")
      .select("draft_no,erp_apply_status").eq("draft_no", no).maybeSingle();
    if (!cur) return json({ error: "초안을 찾을 수 없습니다." }, 404);
    if (cur.erp_apply_status !== "ready") {
      return json({ error: "전송 대기 상태가 아닙니다(이미 처리됐을 수 있습니다)." }, 409);
    }
    const { error } = await admin.from("gl_draft").update({
      erp_apply_status: null, erp_apply_target: null, updated_at: nowIso,
    }).eq("draft_no", no);
    if (error) return json({ error: "취소 실패: " + error.message }, 500);
    log("apply_cancel", no);
    return json({ ok: true, 안내: "전송 대기를 취소했습니다." });
  }

  /* ===== op: tpl_seed_bulk — 시드 템플릿 일괄 등재(전체관리자 한정, C-6 단일 경로 유지) =====
     B2 검수 통과분을 등재하는 관리 작업. 건별로 tpl_save 와 동일한 핵심 검증(계정 유효·규칙값)을 거치고,
     전 건을 감사 로그에 남긴다. 실패 건은 건너뛰고 사유를 반환한다(부분 성공 허용). */
  if (op === "tpl_seed_bulk") {
    if (!isAdmin) {
      log("denied", null, { op });
      return json({ error: "forbidden: 전체관리자 전용입니다." }, 403);
    }
    const seeds = Array.isArray(b.seeds) ? (b.seeds as Record<string, unknown>[]) : [];
    if (!seeds.length) return json({ error: "seeds 배열이 비어 있습니다." }, 400);
    if (seeds.length > SEED_MAX) return json({ error: `한 번에 최대 ${SEED_MAX}건까지 등재할 수 있습니다.` }, 400);

    // deno-lint-ignore no-explicit-any
    let accounts: any[] = [];
    try { const { data } = await admin.rpc("gl_master_get"); accounts = (data?.accounts || []); } catch { /* 폴백 */ }
    // deno-lint-ignore no-explicit-any
    const acctMap = new Map<string, any>(accounts.map((a) => [String(a.acct_cd), a]));
    if (!acctMap.size) return json({ error: "master_empty", 안내: "계정과목 마스터가 없어 시드를 검증할 수 없습니다." }, 503);

    const results: { tpl_nm: string; ok: boolean; tpl_id?: number; error?: string }[] = [];
    for (const seed of seeds) {
      const t = (seed.tpl || {}) as Record<string, unknown>;
      const itemsIn = Array.isArray(seed.items) ? (seed.items as Record<string, unknown>[]) : [];
      const tplNm = clip(t.tpl_nm, TPL_NM_MAX) || "(이름 없음)";
      try {
        if (!itemsIn.length || itemsIn.length > TPL_ITEM_MAX) throw new Error("라인 수가 올바르지 않습니다.");
        const scope = ["org", "dept", "user"].includes(String(t.scope)) ? String(t.scope) : "dept";
        const bal = { D: 0, C: 0 };
        const items = itemsIn.map((r, i) => {
          const line = i + 1;
          const fg = String(r.dr_cr_fg || "").toUpperCase();
          if (fg !== "D" && fg !== "C") throw new Error(`${line}번 줄: 차대 구분 오류`);
          const acctCd = String(r.acct_cd || "").trim();
          const acct = acctMap.get(acctCd);
          if (!acct) throw new Error(`${line}번 줄: 계정(${acctCd}) 없음`);
          const rule = ["input", "pct", "fixed", "balance"].includes(String(r.amt_rule)) ? String(r.amt_rule) : "input";
          let val: number | null = null;
          if (rule === "pct" || rule === "fixed") {
            val = num(r.amt_value);
            if (!(val > 0)) throw new Error(`${line}번 줄: 규칙값 오류`);
            if (rule === "pct" && val > 100) throw new Error(`${line}번 줄: 비율 100 초과`);
          }
          if (rule === "balance") bal[fg as "D" | "C"] += 1;
          return {
            line_seq: line, dr_cr_fg: fg, acct_cd: acctCd, acct_nm: acct.acct_nm || null,
            amt_rule: rule, amt_value: val,
            item_desc: clip(r.item_desc, DESC_MAX), bp_cd: clip(r.bp_cd, 30), bp_nm: clip(r.bp_nm, 100),
            cost_cd: clip(r.cost_cd, 10), project_no: clip(r.project_no, 20), vat_type: clip(r.vat_type, 2),
            acct_lock: !!r.acct_lock, note: clip(r.note, 200), amt_locked: !!r.amt_locked,
          };
        });
        if (bal.D > 1 || bal.C > 1) throw new Error("차액(balance) 규칙은 방향당 1줄까지");

        const head = {
          tpl_nm: tplNm, category: clip(t.category, 30) || "월반복",
          descr: clip(t.descr, 200), scope,
          scope_dept_cd: scope === "dept" ? clip(t.scope_dept_cd, 10) : null,
          scope_dept_nm: scope === "dept" ? clip(t.scope_dept_nm, 60) : null,
          owner_upn: clip(t.owner_upn, 120) || user.upn,
          gl_type: clip(t.gl_type, 2) || GL_TYPE_DEFAULT,
          cost_cd: clip(t.cost_cd, 10),
          desc_tmpl: clip(t.desc_tmpl, DESC_MAX), ref_hint: clip(t.ref_hint, 100),
          amount_mode: String(t.amount_mode || "total") === "manual" ? "manual" : "total",
          status: "draft",   // 시드는 비공개로 등재 — 회계 담당·관리자가 확인 후 공개(active) 전환
          erp_case_cd: clip(t.erp_case_cd, 30),
          sort_no: Number.isFinite(Number(t.sort_no)) ? Number(t.sort_no) : 100,
          recur_cycle: String(t.recur_cycle || "") === "monthly" ? "monthly" : null,
          title_pattern: clip(t.title_pattern, DESC_MAX),
          month_offset: t.month_offset === 0 || t.month_offset === -1 ? Number(t.month_offset) : null,
          vat_mode: ["taxable", "exempt"].includes(String(t.vat_mode)) ? String(t.vat_mode) : null,
          src_family_key: clip(t.src_family_key, 120),
          created_by: user.upn, updated_by: user.upn, updated_at: nowIso,
        };
        const { data: ins, error } = await admin.from("gl_template").insert(head).select("tpl_id").single();
        if (error) throw new Error(error.message);
        const tplId = ins.tpl_id as number;
        const { error: itErr } = await admin.from("gl_template_item")
          .insert(items.map((it) => ({ ...it, tpl_id: tplId })));
        if (itErr) throw new Error(itErr.message);
        await saveTplCtrls(tplId, items, itemsIn, scope);
        results.push({ tpl_nm: tplNm, ok: true, tpl_id: tplId });
      } catch (e) {
        results.push({ tpl_nm: tplNm, ok: false, error: (e as Error).message });
      }
    }
    const okCnt = results.filter((r) => r.ok).length;
    log("tpl_seed_bulk", null, { total: seeds.length, ok: okCnt, results });
    return json({ ok: true, results,
      안내: `시드 ${okCnt}/${seeds.length}건 등재(비공개 상태) — 확인 후 공개 전환하세요.` });
  }

  return json({ error: "지원하지 않는 op" }, 400);
});
