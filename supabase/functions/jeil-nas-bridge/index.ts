// jeil-nas-bridge — 사내 NAS 워커 전용 중계(좁은 키) · REQ-0102 · ADR-110 v3
// 배포: verify_jwt=false (사람 로그인이 아니라 기계 토큰을 이 함수가 직접 검증한다)
// 호출: POST /functions/v1/jeil-nas-bridge   헤더 x-nas-worker-token: <전용 토큰>
//       본문 { fn: "<허용 RPC 이름>", payload: { ... } }  →  그 RPC 의 결과(JSON) 그대로
//
// 왜 필요한가
//   NAS 컨테이너에 service_role 키를 두면, 컨테이너가 털렸을 때 DB 전체가 열린다.
//   그래서 컨테이너에는 **이 함수만 부를 수 있는 전용 토큰**을 두고, 이 함수가 아래 목록의
//   NAS 적재용 RPC 만 대신 불러 준다. 목록 밖은 무엇도 지나가지 못한다.
//
// 보안
//   · 토큰은 평문으로 어디에도 저장하지 않는다 — DB 에는 SHA-256 만(etl_meta.nas_worker_token, 정본 SQL 85).
//   · 인증 실패는 사유를 구분하지 않는다(토큰 없음·틀림·비활성 모두 같은 응답).
//   · 워커 이름(p_worker)은 토큰 행의 값으로 **서버가 덮어쓴다** — 다른 워커를 사칭해 요청을 가로채지 못한다.
//   · 사람용 RPC(nas_request_create·status)는 중계하지 않는다 — 요청을 만드는 것은 사내 로그인 화면의 일이다.
//   · CORS 헤더를 주지 않는다 — 브라우저가 부를 일이 없다.
import { createClient } from "jsr:@supabase/supabase-js@2";

// nas_worker.py 의 BRIDGE_FNS 와 같은 목록이어야 한다(한쪽만 고치지 않는다).
const ALLOWED = new Set([
  "nas_runner_ping", "nas_request_claim", "nas_request_progress", "nas_request_finish",
  "nas_export_sources", "nas_export_count", "nas_export_page", "nas_export_commit",
  "nas_query_claim", "nas_query_finish",   // 실시간 조회(정본 SQL 86 · REQ-0103)
  "nas_index_folders",                     // 문서 색인 대상 폴더(정본 SQL 87 · REQ-0104)
  "nas_save_claim", "nas_save_finish", "nas_save_purge_list", "nas_save_purged",   // 부서 폴더 저장(정본 SQL 89 · REQ-0108)
  "nas_save_fetch",                        // RPC 가 아니다 — 저장할 파일의 1회용 내려받기 주소(아래에서 따로 처리)
  "nas_work_claim", "nas_fetch_finish",    // 일감 하나(저장·내려받기·삭제 신호) · 내려받기 결과(정본 SQL 90 · REQ-0108)
  "nas_fetch_put",                         // RPC 가 아니다 — 내려받을 파일을 올릴 1회용 주소
]);
// 워커 이름을 인자로 받는 RPC — 여기서 토큰 행의 이름으로 바꿔 넣는다.
const WORKER_ARG = new Set(["nas_runner_ping", "nas_request_claim", "nas_query_claim", "nas_save_claim", "nas_work_claim"]);

// 길게 대기 — 조회 요청이 없으면 0.3초마다 다시 확인하며 최대 20초를 기다렸다가 답한다.
// DB 함수 안에서 기다리면 PostgREST 8초 제한에 걸리므로 기다림은 여기서 한다. 20초는 사내 장비의
// 유휴 연결 제한에 걸리지 않게 잡은 값이다(워커는 답을 받으면 곧바로 다시 문다).
const WAIT_FNS = new Set(["nas_query_claim", "nas_save_claim", "nas_work_claim"]);
const WAIT_STEP_MS = 300;
const WAIT_MAX_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const token = (req.headers.get("x-nas-worker-token") || "").trim();
  if (token.length < 32 || token.length > 200) return json({ error: "unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: worker, error: authErr } = await admin.rpc("nas_worker_token_check", { p_hash: await sha256Hex(token) });
  if (authErr || typeof worker !== "string" || !worker) return json({ error: "unauthorized" }, 401);

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const fn = typeof body?.fn === "string" ? body.fn : "";
  if (!ALLOWED.has(fn)) return json({ error: "forbidden" }, 403);

  const payload: Record<string, unknown> =
    body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? { ...body.payload } : {};
  if (WORKER_ARG.has(fn)) payload.p_worker = worker;

  // 저장할 파일 내려받기 — 그 워커가 지금 처리 중인 건만, 2분짜리 1회용 주소로 준다(버킷은 비공개).
  // 워커는 Storage 키를 갖지 않는다. 주소는 이 응답으로만 나가고 어디에도 기록하지 않는다.
  if (fn === "nas_save_fetch") {
    const { data: src, error: e1 } = await admin.rpc("nas_save_source", { p_save_id: payload.p_save_id, p_worker: worker });
    if (e1 || !src?.bucket || !src?.path) return json({ error: "not found" }, 404);
    const { data: signed, error: e2 } = await admin.storage.from(src.bucket).createSignedUrl(src.path, 120);
    if (e2 || !signed?.signedUrl) return json({ error: "sign failed" }, 500);
    return json({ url: signed.signedUrl });
  }

  // 내려받기 — NAS 의 파일을 임시 버킷에 올릴 1회용 주소. 그 워커가 지금 처리 중인 건의 정해진 자리(_fetch/…)에만 쓸 수 있다.
  if (fn === "nas_fetch_put") {
    const { data: src, error: e1 } = await admin.rpc("nas_fetch_source", { p_fetch_id: payload.p_fetch_id, p_worker: worker });
    if (e1 || !src?.bucket || !src?.path) return json({ error: "not found" }, 404);
    const { data: up, error: e2 } = await admin.storage.from(src.bucket).createSignedUploadUrl(src.path);
    if (e2 || !up?.signedUrl) return json({ error: "sign failed" }, 500);
    return json({ url: up.signedUrl });
  }

  let { data, error } = await admin.rpc(fn, payload);
  // 저장이 끝나면(성공·실패 모두) 임시 버킷의 파일을 지운다 — 생성 자료(자료함 사본)는 대상이 아니다(RPC 가 cleanup 을 주지 않는다)
  if (fn === "nas_save_finish" && !error && data?.cleanup?.bucket === "nas-outbox" && typeof data.cleanup.path === "string") {
    await admin.storage.from("nas-outbox").remove([data.cleanup.path]).catch(() => {});
    delete data.cleanup;
  }
  if (WAIT_FNS.has(fn) && !error && data == null) {
    const waitMs = Math.min(Math.max(Number(body.wait_ms) || 0, 0), WAIT_MAX_MS);
    const until = Date.now() + waitMs;
    // 워커가 끊겼으면 더 기다리지 않는다 — 죽은 연결이 요청을 집어 가면 그 요청은 아무도 처리하지 못한다
    while (!error && data == null && Date.now() + WAIT_STEP_MS <= until && !req.signal.aborted) {
      await sleep(WAIT_STEP_MS);
      if (req.signal.aborted) break;
      ({ data, error } = await admin.rpc(fn, payload));
    }
  }
  if (error) {
    // PostgREST 오류 모양을 그대로 돌려준다 — 워커가 사유(허용 목록 밖 소스 등)를 요청 결과에 남긴다
    return json({ code: error.code, message: error.message, details: error.details, hint: error.hint }, 400);
  }
  return json(data ?? null);
});
