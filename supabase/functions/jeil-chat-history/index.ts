// jeil-chat-history — 챗봇 대화내역 본인 전용 CRUD (work 작업폴더 · 대화 세션 · 메시지)
// 배포: verify_jwt=false (Entra 토큰은 Supabase JWT가 아니므로 내부에서 직접 검증)
// 호출: POST /functions/v1/jeil-chat-history  Authorization: Bearer <Entra access_token>
//   body: { op: "bootstrap"|"work_create"|"work_update"|"work_delete"
//               |"session_list"|"session_rename"|"session_delete"|"session_messages", ... }
// 원칙(대화 원문 서버 저장 정책 — ADR 등재):
//   - chat_work/chat_session/chat_message 는 RLS 전면차단(정책 0) — 이 함수(service_role)의
//     upn 필터가 유일한 접근 경로. 모든 쿼리는 ownGuard()를 거쳐 본인(upn) 것만 다룬다.
//   - 관리자용 원문 조회 op는 만들지 않는다(관리자는 chat_log 메타 통계만 — jeil-chat-admin).
//   - 삭제는 soft delete(deleted_at) → 30일 뒤 hard purge. 보존기간(chat_retention_days) 초과분도
//     purge. purge는 bootstrap 처리 말미에 기회적으로 수행(EdgeRuntime.waitUntil).
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

// 본인 소유 가드 — 모든 테이블 접근은 반드시 이 함수를 거친다(upn 필터 누락 방지).
// deno-lint-ignore no-explicit-any
function ownGuard(admin: any, table: string, upn: string) {
  return {
    select: (cols: string) => admin.from(table).select(cols).eq("upn", upn),
    update: (row: Record<string, unknown>) => admin.from(table).update(row).eq("upn", upn),
    del: () => admin.from(table).delete().eq("upn", upn),
    insert: (row: Record<string, unknown>) => admin.from(table).insert({ ...row, upn }),
  };
}

// 기회적 purge — soft delete 30일 경과분 + 보존기간(chat_retention_days) 초과분 hard delete.
// 전체 사용자 대상(시스템 정리 작업). chat_message는 세션 FK cascade로 함께 삭제된다.
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
  const messages = ownGuard(admin, "chat_message", user.upn);

  // 초기 로드 — work 목록 + 최근 세션 전체(프론트가 work별 그룹핑). 말미에 기회적 purge.
  if (op === "bootstrap") {
    const [wr, sr] = await Promise.all([
      works.select("id,name,memo,sort,updated_at").is("deleted_at", null).order("sort").order("updated_at", { ascending: false }),
      sessions.select("id,work_id,title,message_count,last_message_at").is("deleted_at", null)
        .order("last_message_at", { ascending: false, nullsFirst: false }).limit(200),
    ]);
    if (wr.error) return json({ error: "work 조회 실패: " + wr.error.message }, 500);
    if (sr.error) return json({ error: "세션 조회 실패: " + sr.error.message }, 500);
    // @ts-ignore: Supabase Edge Runtime
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(opportunisticPurge(admin));
    return json({ works: wr.data || [], sessions: sr.data || [] });
  }

  // work 생성
  if (op === "work_create") {
    const name = String(b.name || "").trim().slice(0, 100);
    if (!name) return json({ error: "작업 폴더 이름이 필요합니다." }, 400);
    const memo = b.memo != null ? String(b.memo).slice(0, 4000) : null;
    const { data, error } = await works.insert({ name, memo }).select("id,name,memo,sort,updated_at").single();
    if (error) return json({ error: "작업 폴더 생성 실패: " + error.message }, 500);
    return json({ ok: true, work: data });
  }

  // work 이름·메모·정렬 수정
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
    if (!data) return json({ error: "작업 폴더를 찾을 수 없습니다." }, 404);
    return json({ ok: true, work: data });
  }

  // work 삭제 — 소속 세션도 함께 soft delete(폴더 삭제 직관). 30일 내 복구 여지.
  if (op === "work_delete") {
    if (!isUuid(b.work_id)) return json({ error: "잘못된 work_id" }, 400);
    const { data: w, error: we } = await works.update({ deleted_at: nowIso, updated_at: nowIso })
      .eq("id", b.work_id).is("deleted_at", null).select("id").maybeSingle();
    if (we) return json({ error: "작업 폴더 삭제 실패: " + we.message }, 500);
    if (!w) return json({ error: "작업 폴더를 찾을 수 없습니다." }, 404);
    const { data: sd, error: se } = await sessions.update({ deleted_at: nowIso, updated_at: nowIso })
      .eq("work_id", b.work_id).is("deleted_at", null).select("id");
    if (se) return json({ error: "소속 대화 삭제 실패: " + se.message }, 500);
    return json({ ok: true, sessions_affected: (sd || []).length });
  }

  // 세션 목록 — work_id 지정(uuid)=해당 work, null=미분류(일반), 생략=전체
  if (op === "session_list") {
    let q = sessions.select("id,work_id,title,message_count,last_message_at").is("deleted_at", null);
    if (b.work_id === null) q = q.is("work_id", null);
    else if (b.work_id !== undefined) {
      if (!isUuid(b.work_id)) return json({ error: "잘못된 work_id" }, 400);
      q = q.eq("work_id", b.work_id);
    }
    const { data, error } = await q.order("last_message_at", { ascending: false, nullsFirst: false }).limit(100);
    if (error) return json({ error: "세션 조회 실패: " + error.message }, 500);
    return json({ sessions: data || [] });
  }

  // 세션 이름 변경
  if (op === "session_rename") {
    if (!isUuid(b.session_id)) return json({ error: "잘못된 session_id" }, 400);
    const title = String(b.title || "").trim().slice(0, 120);
    if (!title) return json({ error: "대화 이름이 필요합니다." }, 400);
    const { data, error } = await sessions.update({ title, updated_at: nowIso })
      .eq("id", b.session_id).is("deleted_at", null).select("id,title").maybeSingle();
    if (error) return json({ error: "이름 변경 실패: " + error.message }, 500);
    if (!data) return json({ error: "대화를 찾을 수 없습니다." }, 404);
    return json({ ok: true, session: data });
  }

  // 세션 삭제(soft)
  if (op === "session_delete") {
    if (!isUuid(b.session_id)) return json({ error: "잘못된 session_id" }, 400);
    const { data, error } = await sessions.update({ deleted_at: nowIso, updated_at: nowIso })
      .eq("id", b.session_id).is("deleted_at", null).select("id").maybeSingle();
    if (error) return json({ error: "대화 삭제 실패: " + error.message }, 500);
    if (!data) return json({ error: "대화를 찾을 수 없습니다." }, 404);
    return json({ ok: true });
  }

  // 세션 메시지 조회(복원·이어보기) — 소유 검증 후 원문+뷰 반환. before_seq로 과거 페이지 조회.
  if (op === "session_messages") {
    if (!isUuid(b.session_id)) return json({ error: "잘못된 session_id" }, 400);
    const { data: s, error: se } = await sessions.select("id,work_id,title,message_count,last_message_at")
      .eq("id", b.session_id).is("deleted_at", null).maybeSingle();
    if (se) return json({ error: "세션 조회 실패: " + se.message }, 500);
    if (!s) return json({ error: "대화를 찾을 수 없습니다." }, 404);
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(b.limit)) || 50));
    let q = messages.select("seq,role,content,views,model,stopped,created_at").eq("session_id", b.session_id);
    const before = Math.trunc(Number(b.before_seq));
    if (Number.isFinite(before) && before > 0) q = q.lt("seq", before);
    const { data: m, error: me } = await q.order("seq", { ascending: false }).limit(limit);
    if (me) return json({ error: "메시지 조회 실패: " + me.message }, 500);
    return json({ session: s, messages: (m || []).reverse() });
  }

  return json({ error: "알 수 없는 op: " + (op || "(없음)") }, 400);
});
