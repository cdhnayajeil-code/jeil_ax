// jeil-portal-request — 포털 요청 원장 CRUD (챗봇 조회불가 → 사용자 요청 접수) v1
// 배포: verify_jwt=false (Entra 토큰은 Supabase JWT가 아니므로 내부에서 직접 검증)
// 호출: POST /functions/v1/jeil-portal-request  Authorization: Bearer <Entra access_token>
//   body: { op: "create"|"mine"|"cancel"|"list"|"transition"|"stats", ... }
// 설계 정본: 11_제품기획/11_챗봇_데이터요청접수_설계.md (ADR-011) · DDL: 이관/sql/18_portal_request.sql
//
// 원칙(설계 §3)
//  - 요청자는 JWT에서만 취득한다. 본문의 requester 값은 무시(위조 차단).
//  - perm/perm_sensitive 는 접수 시 perm_effective() 로 "정말 권한이 없는지" 재판정한다
//    → 프론트가 임의 모듈을 보내도 접수되지 않는다(서명키 불필요).
//  - 접수는 실거래 액션이 아니다. 권한 부여·ETL 확대 실행은 관리자 화면의 별도 클릭(CLAUDE.md §1.6·§5.4).
//  - 사유는 저장 전 민감 패턴 마스킹(주민번호·계좌·카드). 성명은 마스킹 제외(CLAUDE.md §1.7).
//  - 알림(Teams)은 TEAMS_WEBHOOK_URL 시크릿이 있을 때만 동작하는 부가 기능 — 실패해도 접수는 성공한다.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

/* ===== 규칙 상수 (설계 §4-6·§9 — 변경 시 설계문서 동시 갱신) ===== */
const DAILY_LIMIT = 5;        // 사용자당 1일 접수 상한
const REASON_MIN = 15;        // 사유 최소 길이(품질 하한)
const REASON_MAX = 200;
const KINDS = ["perm", "perm_sensitive", "data", "doc", "feature", "quality"] as const;
const OPEN_STATES = ["open", "ack", "doing"];
// 상태 전이표 — 여기에 없는 전이는 거부(fail-closed)
const NEXT: Record<string, string[]> = {
  open: ["ack", "doing", "done", "rejected", "duplicate", "cancelled"],
  ack: ["doing", "done", "rejected", "duplicate", "cancelled"],
  doing: ["done", "rejected", "duplicate"],
  done: [], rejected: [], duplicate: [], cancelled: [],
};
const KIND_KO: Record<string, string> = {
  perm: "권한", perm_sensitive: "민감권한(급여·인사)", data: "데이터 적재범위",
  doc: "문서 연동범위", feature: "기능 요청", quality: "데이터 품질",
};

async function verifyEntraUser(token: string): Promise<{ upn: string } | null> {
  try {
    const r = await fetch("https://graph.microsoft.com/v1.0/me?$select=userPrincipalName,mail", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const me = await r.json();
    const upn = String(me.userPrincipalName || me.mail || "").toLowerCase();
    if (!upn.endsWith("@jeilm.co.kr")) return null;
    return { upn };
  } catch { return null; }
}

/* 사유 마스킹 — 주민번호·계좌·카드 형태만. 성명·부서·금액 표현은 그대로 둔다(CLAUDE.md §1.7). */
function maskSensitive(s: string): string {
  return s
    .replace(/\b\d{6}\s*[-–]\s*[1-4]\d{6}\b/g, "******-*******")   // 주민등록번호
    .replace(/\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/g, "****-****-****-****")   // 카드
    .replace(/\b\d{2,3}-\d{2,6}-\d{2,6}(-\d{1,6})?\b/g, "***-****-****");      // 계좌
}

/* 사용자 표기 규약 '부서_이름_아이디'(v_erp_user_dept) */
// deno-lint-ignore no-explicit-any
async function labelMap(admin: any, emails: string[]): Promise<Record<string, string>> {
  const uniq = [...new Set(emails.map((e) => String(e || "").toLowerCase()).filter((e) => e.includes("@")))];
  const out: Record<string, string> = {};
  if (!uniq.length) return out;
  try {
    const { data } = await admin.from("v_erp_user_dept").select("email,dept_nm,emp_nm").in("email", uniq);
    // deno-lint-ignore no-explicit-any
    for (const r of (data || []) as any[]) {
      const e = String(r.email || "").toLowerCase();
      if (e && r.emp_nm) out[e] = `${r.dept_nm || "미매핑"}_${r.emp_nm}_${e}`;
    }
  } catch { /* 라벨 실패는 아이디 원본 폴백 */ }
  for (const e of uniq) if (!out[e]) out[e] = e;
  return out;
}

/* Teams 알림 — TEAMS_WEBHOOK_URL 시크릿이 있을 때만. 실패해도 접수 결과에 영향 없음.
   URL 형식으로 페이로드 분기: logic.azure.com = Power Automate Workflows(Adaptive Card),
   webhook.office.com = 구 O365 커넥터(MessageCard). */
async function notifyTeams(title: string, lines: string[], link?: string) {
  const url = Deno.env.get("TEAMS_WEBHOOK_URL");
  if (!url) return;
  const text = lines.join("\n\n");
  try {
    const body = url.includes("webhook.office.com")
      ? { "@type": "MessageCard", "@context": "https://schema.org/extensions",
          summary: title, themeColor: "1B3A6B", title, text,
          ...(link ? { potentialAction: [{ "@type": "OpenUri", name: "요청함 열기",
            targets: [{ os: "default", uri: link }] }] } : {}) }
      : { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive",
          content: { type: "AdaptiveCard", $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            version: "1.4", body: [
              { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true },
              { type: "TextBlock", text, wrap: true },
            ],
            ...(link ? { actions: [{ type: "Action.OpenUrl", title: "요청함 열기", url: link }] } : {}) } }] };
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch { /* 알림 실패는 무시 */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // 1) 사내 사용자 검증
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized: MS 로그인 토큰이 필요합니다." }, 401);
  const user = await verifyEntraUser(token);
  if (!user) return json({ error: "unauthorized: 사내 계정 인증 실패" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const op = String(b.op || "");
  const nowIso = new Date().toISOString();

  // 유효 권한(판정 SSOT — ADR-010). 실패는 빈 결과로 폴백(fail-closed 방향).
  // deno-lint-ignore no-explicit-any
  let eff: any = {};
  try { const { data } = await admin.rpc("perm_effective", { p_upn: user.upn }); eff = data || {}; } catch { /* 폴백 */ }
  const isAdmin = !!eff.is_admin;
  const myDept = (eff.dept_nm as string) || null;
  const myModules: string[] = (eff.erp_modules as string[]) || [];

  const adminGuard = () => (isAdmin ? null : json({ error: "forbidden: 관리자 전용" }, 403));

  /* ===== op: create — 요청 접수 ===== */
  if (op === "create") {
    const kind = String(b.kind || "");
    if (!KINDS.includes(kind as typeof KINDS[number])) return json({ error: "요청 유형이 올바르지 않습니다." }, 400);

    const reasonRaw = String(b.reason || "").trim();
    if (reasonRaw.length < REASON_MIN) {
      return json({ error: `요청 사유를 ${REASON_MIN}자 이상 구체적으로 적어주세요. (무엇을·왜 필요한지)` }, 400);
    }
    const reason = maskSensitive(reasonRaw.slice(0, REASON_MAX));
    const urgency = b.urgency === "high" ? "high" : "normal";
    const targetModule = b.module ? String(b.module).slice(0, 80) : null;

    // 1) 정당성 재판정 — 권한 유형은 "정말 없을 때"만 접수한다(프론트 위조·중복 요청 차단)
    if (kind === "perm" || kind === "perm_sensitive") {
      if (!targetModule) return json({ error: "권한 요청 대상 모듈이 없습니다." }, 400);
      if (isAdmin || myModules.includes(targetModule)) {
        return json({ error: "already_granted",
          안내: "이미 해당 데이터 열람 권한이 있습니다. 화면을 새로고침한 뒤 다시 조회해 보세요." }, 409);
      }
    }

    // 2) 1일 상한
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count } = await admin.from("portal_request")
      .select("id", { count: "exact", head: true })
      .eq("requester_upn", user.upn).gte("created_at", since);
    if ((count || 0) >= DAILY_LIMIT) {
      return json({ error: "rate_limited",
        안내: `하루 요청 가능 건수(${DAILY_LIMIT}건)를 초과했습니다. 급한 건은 포털 관리자에게 직접 문의해 주세요.` }, 429);
    }

    // 3) 중복 병합 — 같은 (유형·대상·부서)로 진행 중인 건이 있으면 동조 처리(새 행 생성 안 함)
    // 대상(module)이 특정된 유형만 병합한다. feature·quality 는 내용이 제각각이라 병합하면 안 된다.
    // 데이터 요청의 묶음 축 = 담당자 작업 유형(fix_type: period|column|table) — 관리자 결정 2026-07-23.
    // 같은 모듈이라도 "칸 수정"과 "새 테이블 연결"은 작업도 소요도 달라 한 건으로 묶으면 안 된다.
    // deno-lint-ignore no-explicit-any
    const gapIn: any = (b.gap && typeof b.gap === "object") ? b.gap : null;
    const fixType = gapIn?.fix_type ? String(gapIn.fix_type).slice(0, 40) : null;

    // deno-lint-ignore no-explicit-any
    let dup: any;
    if (targetModule) {
      let dupQ = admin.from("portal_request")
        .select("id,req_no,status,supporters,requester_upn,reason,target_detail")
        .eq("kind", kind).in("status", OPEN_STATES).eq("target_module", targetModule);
      // null 은 eq 로 매칭되지 않으므로 is 로 분기(부서 미매핑 사용자)
      dupQ = myDept ? dupQ.eq("requester_dept", myDept) : dupQ.is("requester_dept", null);
      const { data: dupRows } = await dupQ.order("created_at", { ascending: true }).limit(20);
      // deno-lint-ignore no-explicit-any
      const cands = (dupRows || []) as any[];
      dup = kind === "data"
        ? cands.find((r) => (r.target_detail?.gap?.fix_type ?? null) === fixType)
        : cands[0];
    }
    if (dup) {
      if (dup.requester_upn === user.upn) {
        return json({ ok: true, merged: true, req_no: dup.req_no, status: dup.status,
          안내: `이미 접수된 요청(${dup.req_no})이 처리 중입니다. 중복 접수하지 않았습니다.` });
      }
      const sup = [...new Set([...(dup.supporters || []), user.upn])];
      await admin.from("portal_request").update({ supporters: sup }).eq("id", dup.id);
      return json({ ok: true, merged: true, req_no: dup.req_no, status: dup.status, supporters: sup.length,
        안내: `같은 요청(${dup.req_no})이 이미 접수되어 처리 중입니다. 회원님을 요청자로 함께 등록했습니다(총 ${sup.length + 1}명).` });
    }

    // 4) 신규 접수
    const detail: Record<string, unknown> = {};
    if (b.tool) detail.tool = String(b.tool).slice(0, 60);
    if (b.args_digest) detail.args_digest = String(b.args_digest).slice(0, 120);
    if (b.module_ko) detail.module_ko = String(b.module_ko).slice(0, 60);
    if (b.detail) detail.note = String(b.detail).slice(0, 200);
    // 미연계 항목·작업유형 — 요청함의 묶음(캠페인) 기준이 된다.
    if (gapIn) {
      detail.gap = {
        type: gapIn.type ? String(gapIn.type).slice(0, 20) : null,
        detail: gapIn.detail ? String(gapIn.detail).slice(0, 120) : null,
        fix_type: fixType,
      };
    }

    const { data: ins, error } = await admin.from("portal_request").insert({
      kind, requester_upn: user.upn, requester_dept: myDept,
      target_module: targetModule, target_detail: detail, reason, urgency,
      needs_vendor_review: kind === "data",   // ETL 확대는 유니포인트 협의 가능성 있음(CLAUDE.md §4.6)
    }).select("id,req_no,status,created_at").single();
    if (error) return json({ error: "접수 실패: " + error.message }, 500);

    const lbl = (await labelMap(admin, [user.upn]))[user.upn] || user.upn;
    const modKo = String(detail.module_ko || targetModule || "-");
    await notifyTeams(
      `🔔 새 포털 요청 ${ins.req_no} · ${KIND_KO[kind]}${urgency === "high" ? " (급함)" : ""}`,
      [`**요청자**: ${lbl}`, `**대상**: ${modKo}`, `**사유**: ${reason}`],
      "https://ai.jeilm.co.kr/",
    );

    // 데이터 요청은 완료 시점을 약속하지 않는다(관리자 결정 2026-07-23) — 검토 착수만 통지.
    return json({ ok: true, req_no: ins.req_no, status: ins.status,
      안내: kind === "data" || kind === "feature"
        ? `요청이 접수되었습니다(${ins.req_no}). 검토에 착수하며, 정기 업데이트 시 적용을 검토해 결과를 알려드립니다.`
        : `요청이 접수되었습니다(${ins.req_no}). 관리자 확인 후 결과를 알려드립니다.` });
  }

  /* ===== op: mine — 내가 낸 요청 ===== */
  if (op === "mine") {
    const cols = "req_no,kind,status,target_module,target_detail,reason,urgency,handled_note,supporters,requester_upn,created_at,closed_at";
    // 본인 접수분 + 동조자로 참여한 건(중복 병합된 요청도 진행상황을 볼 수 있어야 함)
    const [own, sup] = await Promise.all([
      admin.from("portal_request").select(cols).eq("requester_upn", user.upn)
        .order("created_at", { ascending: false }).limit(50),
      admin.from("portal_request").select(cols).contains("supporters", [user.upn])
        .order("created_at", { ascending: false }).limit(50),
    ]);
    if (own.error) return json({ error: "조회 실패: " + own.error.message }, 500);
    const seen = new Set<string>();
    const rows = [...(own.data || []), ...(sup.data || [])]
      .filter((r) => (seen.has(r.req_no) ? false : (seen.add(r.req_no), true)))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((r) => ({ ...r, kind_ko: KIND_KO[r.kind] || r.kind, is_owner: r.requester_upn === user.upn }));
    return json({ ok: true, rows });
  }

  /* ===== op: cancel — 요청자 본인 취소(open/ack 한정) ===== */
  if (op === "cancel") {
    const reqNo = String(b.req_no || "");
    const { data: row } = await admin.from("portal_request")
      .select("id,status").eq("req_no", reqNo).eq("requester_upn", user.upn).maybeSingle();
    if (!row) return json({ error: "요청을 찾을 수 없습니다." }, 404);
    if (!["open", "ack"].includes(row.status)) {
      return json({ error: "이미 처리가 시작되어 취소할 수 없습니다. 관리자에게 문의하세요." }, 409);
    }
    await admin.from("portal_request").update({ status: "cancelled", closed_at: nowIso }).eq("id", row.id);
    return json({ ok: true, 안내: "요청을 취소했습니다." });
  }

  /* ===== op: list — 요청함(관리자) ===== */
  if (op === "list") {
    const g = adminGuard(); if (g) return g;
    let q = admin.from("portal_request")
      .select("id,req_no,kind,status,requester_upn,requester_dept,target_module,target_detail,reason,urgency,supporters,assignee_upn,handled_note,needs_vendor_review,created_at,acked_at,closed_at")
      .order("created_at", { ascending: false }).limit(300);
    const st = String(b.status || "");
    if (st === "open") q = q.in("status", OPEN_STATES);
    else if (st) q = q.eq("status", st);
    if (b.kind) q = q.eq("kind", String(b.kind));
    const { data, error } = await q;
    if (error) return json({ error: "조회 실패: " + error.message }, 500);

    const rows = data || [];
    const lbl = await labelMap(admin, rows.map((r) => String(r.requester_upn)));
    const DAY = 24 * 3600 * 1000;
    return json({ ok: true, rows: rows.map((r) => ({
      ...r, kind_ko: KIND_KO[r.kind] || r.kind,
      requester_label: lbl[String(r.requester_upn).toLowerCase()] || r.requester_upn,
      supporter_count: (r.supporters || []).length,
      age_days: Math.floor((Date.now() - new Date(r.created_at).getTime()) / DAY),
    })) });
  }

  /* ===== op: transition — 상태 전이(관리자). 부여 실행은 하지 않는다(권한 화면에서 사람이 클릭) ===== */
  if (op === "transition") {
    const g = adminGuard(); if (g) return g;
    const reqNo = String(b.req_no || "");
    const to = String(b.to || "");
    const note = b.note ? maskSensitive(String(b.note).slice(0, 500)) : null;

    const { data: row } = await admin.from("portal_request").select("id,status,kind").eq("req_no", reqNo).maybeSingle();
    if (!row) return json({ error: "요청을 찾을 수 없습니다." }, 404);
    if (!(NEXT[row.status] || []).includes(to)) {
      return json({ error: `'${row.status}' → '${to}' 전이는 허용되지 않습니다.` }, 400);
    }
    if (["done", "rejected"].includes(to) && !note) {
      return json({ error: "완료·반려는 처리 사유(요청자 회신 문구)가 필요합니다." }, 400);
    }
    const patch: Record<string, unknown> = { status: to, assignee_upn: user.upn };
    if (note) patch.handled_note = note;
    if (to === "ack") patch.acked_at = nowIso;
    if (["done", "rejected", "duplicate", "cancelled"].includes(to)) patch.closed_at = nowIso;
    if (b.dup_of) patch.dup_of = Number(b.dup_of);

    const { error } = await admin.from("portal_request").update(patch).eq("id", row.id);
    if (error) return json({ error: "상태 변경 실패: " + error.message }, 500);
    return json({ ok: true, req_no: reqNo, status: to });
  }

  /* ===== op: stats — 요청함 배지·수요 통계(관리자) ===== */
  if (op === "stats") {
    const g = adminGuard(); if (g) return g;
    const { data } = await admin.from("portal_request").select("kind,status,target_module,requester_dept,created_at");
    const rows = data || [];
    const open = rows.filter((r) => OPEN_STATES.includes(r.status));
    const DAY = 24 * 3600 * 1000;
    const heat: Record<string, number> = {};
    for (const r of rows) {
      const k = `${r.requester_dept || "미지정"}|${r.target_module || "-"}`;
      heat[k] = (heat[k] || 0) + 1;
    }
    return json({ ok: true,
      open_count: open.length,
      overdue_count: open.filter((r) => Date.now() - new Date(r.created_at).getTime() > DAY).length,
      by_kind: KINDS.map((k) => ({ kind: k, kind_ko: KIND_KO[k], open: open.filter((r) => r.kind === k).length })),
      heatmap: Object.entries(heat).map(([k, v]) => ({ dept: k.split("|")[0], module: k.split("|")[1], n: v }))
        .sort((a, b) => b.n - a.n).slice(0, 20),
      total: rows.length });
  }

  return json({ error: "지원하지 않는 op" }, 400);
});
