// jeil-gl-draft — 결의전표 초안 CRUD (포털 입력 → 사람이 ERP 확정) v1
// 배포: verify_jwt=false (Entra 토큰은 Supabase JWT가 아니므로 내부에서 Graph 재검증)
// 호출: POST /functions/v1/jeil-gl-draft  Authorization: Bearer <Entra access_token>
//   body: { op: "bootstrap"|"save"|"mine"|"get"|"submit"|"void"|"bp"|"list"|"post", ... }
// DDL 정본: 이관/sql/21_gl_draft.sql · 마이그레이션 gl_draft_v1 · gl_draft_master_rpc
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
    });
  }

  /* ===== op: bp — 거래처 검색(2자 이상, 최대 30건) ===== */
  if (op === "bp") {
    const q = String(b.q || "").trim();
    if (q.length < 2) return json({ ok: true, rows: [] });
    const { data } = await admin.rpc("gl_bp_search", { p_q: q });
    return json({ ok: true, rows: data || [] });
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
    try { const { data } = await admin.rpc("gl_master_get"); accounts = (data?.accounts || []); } catch { /* 폴백 */ }
    if (!accounts.length) {
      return json({ error: "master_empty",
        안내: "계정과목 마스터가 아직 적재되지 않아 초안을 검증할 수 없습니다. 관리자에게 문의하세요." }, 503);
    }
    // deno-lint-ignore no-explicit-any
    const acctMap = new Map<string, any>(accounts.map((a) => [String(a.acct_cd), a]));

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

      if (fg === "D") dr += amt; else cr += amt;
      items.push({
        item_seq: line, dr_cr_fg: fg,
        acct_cd: acctCd, acct_nm: acct.acct_nm || null,
        item_amt: amt,
        item_desc: clip(r.item_desc, DESC_MAX) || glDesc,
        bp_cd: clip(r.bp_cd, 30), bp_nm: clip(r.bp_nm, 100),
        cost_cd: clip(r.cost_cd, 10) || clip(h.cost_cd, 10),
        project_no: projectNo,
        vat_type: clip(r.vat_type, 2), vat_amt: r.vat_amt != null ? num(r.vat_amt) : null,
      });
    }
    // 차대 일치 — 프론트가 뭘 보내든 여기서 막는다
    if (dr !== cr) {
      return json({ error: "unbalanced",
        안내: `차변 합계(${dr.toLocaleString()})와 대변 합계(${cr.toLocaleString()})가 일치하지 않습니다.` }, 400);
    }

    const headerRow = {
      draft_dt: draftDt,
      gl_type: clip(h.gl_type, 2),
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
      const { error } = await admin.from("gl_draft").update(headerRow).eq("draft_no", no);
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

    log("save", no, { items: items.length, dr, cr, new: !draftNo });
    return json({ ok: true, draft_no: no, dr_total: dr, cr_total: cr,
      안내: `초안을 저장했습니다(${no}). 제출하면 회계 담당자가 ERP에 등록합니다.` });
  }

  /* ===== op: mine — 내 초안 목록 ===== */
  if (op === "mine") {
    const { data, error } = await admin.from("gl_draft")
      .select("draft_no,draft_dt,gl_desc,dept_nm,dr_total,cr_total,status,erp_temp_gl_no,created_at,submitted_at,posted_at")
      .eq("owner_upn", user.upn).order("created_at", { ascending: false }).limit(100);
    if (error) return json({ error: "조회 실패: " + error.message }, 500);
    return json({ ok: true, rows: data || [] });
  }

  /* ===== op: get — 초안 1건(헤더+라인) ===== */
  if (op === "get") {
    const no = String(b.draft_no || "");
    const { data: hd } = await admin.from("gl_draft").select("*").eq("draft_no", no).maybeSingle();
    if (!hd) return json({ error: "초안을 찾을 수 없습니다." }, 404);
    // 본인 것이거나, 확정 권한자(회계 담당자)만 열람
    if (hd.owner_upn !== user.upn && !canPost) {
      log("denied", no, { reason: "not_owner" });
      return json({ error: "forbidden: 열람 권한이 없습니다." }, 403);
    }
    const { data: items } = await admin.from("gl_draft_item")
      .select("*").eq("draft_no", no).order("item_seq");
    log("view", no);
    return json({ ok: true, header: hd, items: items || [] });
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
    log("void", no, { reason: clip(b.reason, 200) });
    return json({ ok: true, 안내: "초안을 폐기했습니다." });
  }

  /* ===== op: list — 제출된 초안 목록(회계 담당자) ===== */
  if (op === "list") {
    if (!canPost) return json({ error: "forbidden: 회계 담당자 전용입니다." }, 403);
    let q = admin.from("gl_draft")
      .select("draft_no,draft_dt,gl_type,dept_nm,cost_cd,gl_desc,ref_no,owner_upn,owner_nm,owner_erp_usr_id,dr_total,cr_total,status,erp_temp_gl_no,created_at,submitted_at,posted_at")
      .order("submitted_at", { ascending: true, nullsFirst: false }).limit(300);
    const st = String(b.status || "submitted");
    if (st !== "all") q = q.eq("status", st);
    const { data, error } = await q;
    if (error) return json({ error: "조회 실패: " + error.message }, 500);
    log("list", null, { status: st });
    return json({ ok: true, rows: data || [] });
  }

  /* ===== op: post — ERP 확정 기록(회계 담당자). 포털이 ERP에 쓰는 것이 아니라 "사람이 등록한 결과"를 기록한다 ===== */
  if (op === "post") {
    if (!canPost) return json({ error: "forbidden: 회계 담당자 전용입니다." }, 403);
    const no = String(b.draft_no || "");
    const tempGlNo = clip(b.erp_temp_gl_no, 18);
    if (!tempGlNo) {
      return json({ error: "erp_no_required",
        안내: "ERP에서 저장된 결의전표번호를 입력해야 확정 처리할 수 있습니다. 이 번호가 이중 입력을 막는 유일한 장치입니다." }, 400);
    }
    const { data: cur } = await admin.from("gl_draft")
      .select("draft_no,status").eq("draft_no", no).maybeSingle();
    if (!cur) return json({ error: "초안을 찾을 수 없습니다." }, 404);
    if (cur.status === "posted") return json({ error: "이미 확정 처리된 초안입니다." }, 409);
    if (cur.status === "void") return json({ error: "폐기된 초안입니다." }, 409);

    // 같은 ERP 전표번호가 다른 초안에 이미 기입돼 있으면 거부 — 이중 등록 탐지
    const { data: dup } = await admin.from("gl_draft")
      .select("draft_no").eq("erp_temp_gl_no", tempGlNo).neq("draft_no", no).maybeSingle();
    if (dup) {
      return json({ error: "duplicate_erp_no",
        안내: `이 ERP 전표번호(${tempGlNo})는 이미 다른 초안(${dup.draft_no})에 기록되어 있습니다. 중복 등록이 아닌지 확인하세요.` }, 409);
    }

    const { error } = await admin.from("gl_draft").update({
      status: "posted", erp_temp_gl_no: tempGlNo,
      posted_by: user.upn, posted_at: nowIso, updated_at: nowIso,
    }).eq("draft_no", no);
    if (error) return json({ error: "확정 실패: " + error.message }, 500);
    log("post", no, { erp_temp_gl_no: tempGlNo });
    return json({ ok: true, 안내: `ERP 전표번호 ${tempGlNo} 로 확정 기록했습니다.` });
  }

  return json({ error: "지원하지 않는 op" }, 400);
});
