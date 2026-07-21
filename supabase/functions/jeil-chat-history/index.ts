// jeil-chat-history — 챗봇 대화내역 CRUD (work 작업폴더 · 대화 세션 · 메시지 · 팀 공유) v2
// 배포: verify_jwt=false (Entra 토큰은 Supabase JWT가 아니므로 내부에서 직접 검증)
// 호출: POST /functions/v1/jeil-chat-history  Authorization: Bearer <Entra access_token>
//   body: { op: "bootstrap"|"work_create"|"work_update"|"work_delete"
//               |"session_list"|"session_rename"|"session_delete"|"session_messages"
//               |"member_list"|"member_add"|"member_remove", ... }
// 원칙(대화 원문 서버 저장 — ADR-009, v2에서 팀 공유로 개정):
//   - chat_work/chat_session/chat_message/chat_work_member 는 RLS 전면차단(정책 0) — 이 함수(service_role)의
//     접근 판정이 유일한 경로. 판정은 DB RPC(chat_work_access/chat_session_access)로 일원화:
//     본인 소유이거나, 소속 work의 소유자·팀원일 때만 접근(공유 대화).
//   - 폴더 이름·메모 수정/삭제·팀원 초대/제거는 "소유자만". 팀원은 열람·참여·본인 나가기만.
//   - 관리자용 원문 조회 op는 만들지 않는다(관리자는 chat_log 메타 통계만 — jeil-chat-admin).
//   - 삭제는 soft delete(deleted_at) → 30일 뒤 hard purge + 보존기간(chat_retention_days) 초과분 purge
//     (bootstrap 처리 말미에 기회적 수행, EdgeRuntime.waitUntil).
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const MAX_MEMBERS = 20;   // 폴더당 팀원 상한

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
  } catch {
    return null;
  }
}

// 본인 소유 가드 — 소유자 한정 op(work 수정·삭제 등)의 테이블 접근은 반드시 이 함수를 거친다.
// deno-lint-ignore no-explicit-any
function ownGuard(admin: any, table: string, upn: string) {
  return {
    select: (cols: string) => admin.from(table).select(cols).eq("upn", upn),
    update: (row: Record<string, unknown>) => admin.from(table).update(row).eq("upn", upn),
    insert: (row: Record<string, unknown>) => admin.from(table).insert({ ...row, upn }),
  };
}

// 공유 접근 판정 — DB RPC로 일원화(소유자·팀원). 실패는 false(fail-closed).
// deno-lint-ignore no-explicit-any
async function canAccessWork(admin: any, workId: string, upn: string): Promise<boolean> {
  try { const { data } = await admin.rpc("chat_work_access", { p_work: workId, p_upn: upn }); return data === true; }
  catch { return false; }
}
// deno-lint-ignore no-explicit-any
async function canAccessSession(admin: any, sessionId: string, upn: string): Promise<boolean> {
  try { const { data } = await admin.rpc("chat_session_access", { p_session: sessionId, p_upn: upn }); return data === true; }
  catch { return false; }
}

// 사용자 표기 규약 '부서_이름_아이디'(v_erp_user_dept) — 미매핑은 아이디 원본 유지
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
  } catch { /* 라벨 실패는 아이디 원본으로 폴백 */ }
  for (const e of uniq) if (!out[e]) out[e] = e;
  return out;
}

// 기회적 purge — soft delete 30일 경과분 + 보존기간(chat_retention_days) 초과분 hard delete.
// deno-lint-ignore no-explicit-any
async function opportunisticPurge(admin: any) {
  try {
    const cut30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    await admin.from("chat_session").delete().lt("deleted_at", cut30);
    await admin.from("chat_work").delete().lt("deleted_at", cut30);
    const { data: cfg } = await admin.from("ai_gateway_config").select("chat_retention_days").eq("id", 1).maybeSingle();
    const days = Number(cfg?.chat_retention_days ?? 180);
    if (days > 0) {
      const cutRet = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
      await admin.from("chat_session").delete().lt("last_message_at", cutRet);
      await admin.from("chat_session").delete().is("last_message_at", null).lt("created_at", cutRet);
    }
  } catch { /* purge 실패는 무시 — 다음 기회에 재시도 */ }
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
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const op = String((body as Record<string, unknown>).op || "");
  const b = body as Record<string, unknown>;
  const nowIso = new Date().toISOString();
  const works = ownGuard(admin, "chat_work", user.upn);
  const sessions = ownGuard(admin, "chat_session", user.upn);

  // 초기 로드 — 내 폴더 + 내가 팀원인 공유 폴더 + 접근 가능한 세션 전체. 말미에 기회적 purge.
  if (op === "bootstrap") {
    const [ownR, memR] = await Promise.all([
      works.select("id,name,memo,sort,updated_at").is("deleted_at", null).order("sort").order("updated_at", { ascending: false }),
      admin.from("chat_work_member").select("work_id").eq("upn", user.upn),
    ]);
    if (ownR.error) return json({ error: "work 조회 실패: " + ownR.error.message }, 500);
    // deno-lint-ignore no-explicit-any
    const ownWorks = (ownR.data || []) as any[];
    const memIds = [...new Set(((memR.data || []) as { work_id: string }[]).map((r) => r.work_id))];
    // deno-lint-ignore no-explicit-any
    let sharedWorks: any[] = [];
    if (memIds.length) {
      const { data } = await admin.from("chat_work").select("id,upn,name,memo,sort,updated_at")
        .in("id", memIds).is("deleted_at", null);
      sharedWorks = data || [];
    }
    const allIds = [...new Set([...ownWorks.map((w) => w.id), ...sharedWorks.map((w) => w.id)])];
    // 폴더별 팀원 수(공유 배지용)
    const cnt: Record<string, number> = {};
    if (allIds.length) {
      const { data: mc } = await admin.from("chat_work_member").select("work_id").in("work_id", allIds);
      for (const r of (mc || []) as { work_id: string }[]) cnt[r.work_id] = (cnt[r.work_id] || 0) + 1;
    }
    const ownerLbl = await labelMap(admin, sharedWorks.map((w) => String(w.upn)));
    const outWorks = [
      ...ownWorks.map((w) => ({ id: w.id, name: w.name, memo: w.memo, sort: w.sort, updated_at: w.updated_at,
        is_owner: true, member_count: cnt[w.id] || 0, shared: (cnt[w.id] || 0) > 0, owner_label: null })),
      ...sharedWorks.map((w) => ({ id: w.id, name: w.name, memo: w.memo, sort: w.sort, updated_at: w.updated_at,
        is_owner: false, member_count: cnt[w.id] || 0, shared: true, owner_label: ownerLbl[String(w.upn).toLowerCase()] || String(w.upn) })),
    ];
    // 접근 가능한 세션 = 내 개인 세션(work 미소속) + 접근 폴더의 세션 전부(생성자 upn 포함).
    // 폴더 소속 세션은 "현재" 구성원 자격 기준 — 제거·나가기 후에는 본인이 만든 세션도 제외(F1 정책).
    let sq = admin.from("chat_session").select("id,work_id,title,message_count,last_message_at,upn").is("deleted_at", null);
    sq = allIds.length
      ? sq.or(`and(upn.eq.${user.upn},work_id.is.null),work_id.in.(${allIds.join(",")})`)
      : sq.eq("upn", user.upn).is("work_id", null);
    const { data: sess, error: se } = await sq.order("last_message_at", { ascending: false, nullsFirst: false }).limit(300);
    if (se) return json({ error: "세션 조회 실패: " + se.message }, 500);
    // @ts-ignore: Supabase Edge Runtime
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(opportunisticPurge(admin));
    return json({ works: outWorks, sessions: sess || [], me: user.upn });
  }

  // work 생성 (생성자=소유자)
  if (op === "work_create") {
    const name = String(b.name || "").trim().slice(0, 100);
    if (!name) return json({ error: "작업 폴더 이름이 필요합니다." }, 400);
    const memo = b.memo != null ? String(b.memo).slice(0, 4000) : null;
    const { data, error } = await works.insert({ name, memo }).select("id,name,memo,sort,updated_at").single();
    if (error) return json({ error: "작업 폴더 생성 실패: " + error.message }, 500);
    return json({ ok: true, work: { ...data, is_owner: true, member_count: 0, shared: false, owner_label: null } });
  }

  // work 이름·메모·정렬 수정 — 소유자만
  if (op === "work_update") {
    if (!isUuid(b.work_id)) return json({ error: "잘못된 work_id" }, 400);
    const row: Record<string, unknown> = { updated_at: nowIso };
    if (b.name != null) {
      const name = String(b.name).trim().slice(0, 100);
      if (!name) return json({ error: "이름은 비울 수 없습니다." }, 400);
      row.name = name;
    }
    if (b.memo !== undefined) row.memo = b.memo == null ? null : String(b.memo).slice(0, 4000);
    if (b.sort !== undefined) { const n = Math.trunc(Number(b.sort)); if (Number.isFinite(n)) row.sort = n; }
    const { data, error } = await works.update(row).eq("id", b.work_id).is("deleted_at", null)
      .select("id,name,memo,sort,updated_at").maybeSingle();
    if (error) return json({ error: "작업 폴더 수정 실패: " + error.message }, 500);
    if (!data) return json({ error: "작업 폴더를 찾을 수 없거나 소유자가 아닙니다." }, 404);
    return json({ ok: true, work: data });
  }

  // work 삭제 — 소유자만. 소속 세션도 함께 soft delete.
  if (op === "work_delete") {
    if (!isUuid(b.work_id)) return json({ error: "잘못된 work_id" }, 400);
    const { data: w, error: we } = await works.update({ deleted_at: nowIso, updated_at: nowIso })
      .eq("id", b.work_id).is("deleted_at", null).select("id").maybeSingle();
    if (we) return json({ error: "작업 폴더 삭제 실패: " + we.message }, 500);
    if (!w) return json({ error: "작업 폴더를 찾을 수 없거나 소유자가 아닙니다." }, 404);
    const { data: sd, error: se } = await admin.from("chat_session").update({ deleted_at: nowIso, updated_at: nowIso })
      .eq("work_id", b.work_id).is("deleted_at", null).select("id");
    if (se) return json({ error: "소속 대화 삭제 실패: " + se.message }, 500);
    return json({ ok: true, sessions_affected: (sd || []).length });
  }

  // 세션 목록 — work_id 지정(uuid)=해당 work(공유 접근 포함, 팀원 세션 전부), null=내 미분류, 생략=내 전체
  if (op === "session_list") {
    if (isUuid(b.work_id)) {
      if (!(await canAccessWork(admin, b.work_id, user.upn))) return json({ error: "이 작업 폴더에 접근할 수 없습니다." }, 403);
      const { data, error } = await admin.from("chat_session").select("id,work_id,title,message_count,last_message_at,upn")
        .eq("work_id", b.work_id).is("deleted_at", null)
        .order("last_message_at", { ascending: false, nullsFirst: false }).limit(100);
      if (error) return json({ error: "세션 조회 실패: " + error.message }, 500);
      return json({ sessions: data || [] });
    }
    let q = sessions.select("id,work_id,title,message_count,last_message_at,upn").is("deleted_at", null);
    if (b.work_id === null) q = q.is("work_id", null);
    const { data, error } = await q.order("last_message_at", { ascending: false, nullsFirst: false }).limit(100);
    if (error) return json({ error: "세션 조회 실패: " + error.message }, 500);
    return json({ sessions: data || [] });
  }

  // 세션 이름 변경 — 접근자(생성자·공유 work 팀원) 모두 가능
  if (op === "session_rename") {
    if (!isUuid(b.session_id)) return json({ error: "잘못된 session_id" }, 400);
    const title = String(b.title || "").trim().slice(0, 120);
    if (!title) return json({ error: "대화 이름이 필요합니다." }, 400);
    if (!(await canAccessSession(admin, b.session_id, user.upn))) return json({ error: "이 대화에 접근할 수 없습니다." }, 403);
    const { error } = await admin.from("chat_session").update({ title, updated_at: nowIso })
      .eq("id", b.session_id).is("deleted_at", null);
    if (error) return json({ error: "이름 변경 실패: " + error.message }, 500);
    return json({ ok: true, session: { id: b.session_id, title } });
  }

  // 세션 삭제(soft) — 접근 가능(현재 구성원)하면서 생성자 또는 소속 work 소유자만
  if (op === "session_delete") {
    if (!isUuid(b.session_id)) return json({ error: "잘못된 session_id" }, 400);
    if (!(await canAccessSession(admin, b.session_id, user.upn))) return json({ error: "대화를 찾을 수 없습니다." }, 404);
    const { data: s } = await admin.from("chat_session").select("id,upn,work_id").eq("id", b.session_id).is("deleted_at", null).maybeSingle();
    if (!s) return json({ error: "대화를 찾을 수 없습니다." }, 404);
    let allowed = String(s.upn) === user.upn;
    if (!allowed && s.work_id) {
      const { data: w } = await admin.from("chat_work").select("upn").eq("id", s.work_id).maybeSingle();
      allowed = !!w && String(w.upn) === user.upn;
    }
    if (!allowed) return json({ error: "대화 삭제는 만든 사람 또는 폴더 소유자만 가능합니다." }, 403);
    const { error } = await admin.from("chat_session").update({ deleted_at: nowIso, updated_at: nowIso }).eq("id", b.session_id);
    if (error) return json({ error: "대화 삭제 실패: " + error.message }, 500);
    return json({ ok: true });
  }

  // 세션 메시지 조회(복원·이어보기) — 접근 판정 후 원문+뷰+발화자 라벨 반환
  if (op === "session_messages") {
    if (!isUuid(b.session_id)) return json({ error: "잘못된 session_id" }, 400);
    if (!(await canAccessSession(admin, b.session_id, user.upn))) return json({ error: "대화를 찾을 수 없습니다." }, 404);
    const { data: s, error: se } = await admin.from("chat_session").select("id,work_id,title,message_count,last_message_at,upn")
      .eq("id", b.session_id).is("deleted_at", null).maybeSingle();
    if (se || !s) return json({ error: "세션 조회 실패" }, 500);
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(b.limit)) || 50));
    let q = admin.from("chat_message").select("seq,role,content,views,model,stopped,created_at,upn").eq("session_id", b.session_id);
    const before = Math.trunc(Number(b.before_seq));
    if (Number.isFinite(before) && before > 0) q = q.lt("seq", before);
    const { data: m, error: me } = await q.order("seq", { ascending: false }).limit(limit);
    if (me) return json({ error: "메시지 조회 실패: " + me.message }, 500);
    const msgs = (m || []).reverse();
    // deno-lint-ignore no-explicit-any
    const senders = await labelMap(admin, (msgs as any[]).filter((x) => x.role === "user").map((x) => String(x.upn)));
    return json({ session: s, messages: msgs, senders, me: user.upn });
  }

  // 팀원 목록 — 접근자 모두. 소유자·팀원 표기 라벨 포함.
  if (op === "member_list") {
    if (!isUuid(b.work_id)) return json({ error: "잘못된 work_id" }, 400);
    if (!(await canAccessWork(admin, b.work_id, user.upn))) return json({ error: "이 작업 폴더에 접근할 수 없습니다." }, 403);
    const { data: w } = await admin.from("chat_work").select("upn,name").eq("id", b.work_id).maybeSingle();
    const { data: mem, error } = await admin.from("chat_work_member").select("upn,invited_by,created_at")
      .eq("work_id", b.work_id).order("created_at");
    if (error) return json({ error: "팀원 조회 실패: " + error.message }, 500);
    const emails = [String(w?.upn || ""), ...(mem || []).map((r: { upn: string }) => r.upn)];
    const lbl = await labelMap(admin, emails);
    return json({
      owner: { upn: w?.upn, label: lbl[String(w?.upn || "").toLowerCase()] || w?.upn },
      members: (mem || []).map((r: { upn: string; created_at: string }) => ({ upn: r.upn, label: lbl[r.upn.toLowerCase()] || r.upn, created_at: r.created_at })),
      is_owner: String(w?.upn) === user.upn,
      me: user.upn,
    });
  }

  // 팀원 초대 — 소유자만. 사내(@jeilm.co.kr) 계정 한정.
  if (op === "member_add") {
    if (!isUuid(b.work_id)) return json({ error: "잘못된 work_id" }, 400);
    const email = String(b.email || "").trim().toLowerCase();
    if (!email.endsWith("@jeilm.co.kr")) return json({ error: "사내(@jeilm.co.kr) 계정만 초대할 수 있습니다." }, 400);
    const { data: w } = await works.select("id,upn").eq("id", b.work_id).is("deleted_at", null).maybeSingle();
    if (!w) return json({ error: "팀원 초대는 폴더 소유자만 가능합니다." }, 403);
    if (email === user.upn) return json({ error: "본인(소유자)은 초대 대상이 아닙니다." }, 400);
    const { count } = await admin.from("chat_work_member").select("upn", { count: "exact", head: true }).eq("work_id", b.work_id);
    if ((count || 0) >= MAX_MEMBERS) return json({ error: `팀원은 폴더당 최대 ${MAX_MEMBERS}명입니다.` }, 400);
    const { error } = await admin.from("chat_work_member")
      .upsert({ work_id: b.work_id, upn: email, invited_by: user.upn }, { onConflict: "work_id,upn" });
    if (error) return json({ error: "팀원 초대 실패: " + error.message }, 500);
    const lbl = await labelMap(admin, [email]);
    return json({ ok: true, member: { upn: email, label: lbl[email] || email } });
  }

  // 팀원 제거 — 소유자(누구든 제거) 또는 본인(나가기)
  if (op === "member_remove") {
    if (!isUuid(b.work_id)) return json({ error: "잘못된 work_id" }, 400);
    const email = String(b.email || "").trim().toLowerCase();
    if (!email) return json({ error: "제거할 계정이 필요합니다." }, 400);
    const { data: w } = await admin.from("chat_work").select("upn").eq("id", b.work_id).is("deleted_at", null).maybeSingle();
    if (!w) return json({ error: "작업 폴더를 찾을 수 없습니다." }, 404);
    const isOwner = String(w.upn) === user.upn;
    if (!isOwner && email !== user.upn) return json({ error: "팀원 제거는 소유자 또는 본인(나가기)만 가능합니다." }, 403);
    const { error } = await admin.from("chat_work_member").delete().eq("work_id", b.work_id).eq("upn", email);
    if (error) return json({ error: "팀원 제거 실패: " + error.message }, 500);
    return json({ ok: true, removed: email });
  }

  return json({ error: "알 수 없는 op: " + (op || "(없음)") }, 400);
});
