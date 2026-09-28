// jeil-chat-lab — 챗봇 모듈형 고도화 **실험실** 게이트웨이 (REQ-0084 · 13 기획 · ADR-108 제안)
// 화면: https://ai.jeilm.co.kr/chatdemo (app/chat-lab.html) — **전체관리자(perm_effective.is_admin)만**.
// 운영 jeil-chat 과 완전히 분리된 함수다. 운영 챗봇·대화내역에 영향이 없다.
//
// 구조(13 기획 §2):
//   modules/<domain>/<tool>.ts  = manifest(설명서) + run(ctx)   ← 도구 1개 = 파일 1개
//   modules/index.ts            = 등록 목록(정적 import)
//   core/                       = 타입·헬퍼·권한·프롬프트 조립·설정
//   llm/<vendor>.ts             = 벤더 어댑터(현재 openai)
//
// 호출: POST /functions/v1/jeil-chat-lab   Authorization: Bearer <Entra access_token>
//   { op:"registry" }                                   → 모듈 등록부·모델·프롬프트 정보(JSON)
//   { op:"preview", lab }                               → 이 실험 조건에서 주입될 모듈·조립 프롬프트(JSON)
//   { messages:[…], lab }                               → SSE 대화
//   lab = { disabled?: string[], simulate?: { modules: string[] } | null,
//           prompt_mode?: "auto"|"db"|"code", perm_filter?: "gate"|"hide", model?: string }
// SSE: 운영과 같은 {"choices":[{"delta"}]} · {"jeilax": 뷰} · [DONE] + 실험용 {"jeilax_lab": 추적}
//
// 원칙:
//   - 관리자 판정은 서버에서(§5.4). 시뮬레이션은 **좁히기만**(실제 권한에 없는 모듈 추가 불가 · 타인 대행 없음).
//   - 대화 원문을 저장하지 않는다(chat_session/chat_message 미사용) — 실험 대화가 사용자 대화내역에 섞이지 않게.
//   - 비용은 실제로 발생하므로 chat_log 에는 남긴다(사용량 화면에 드러난다).
import { createClient } from "jsr:@supabase/supabase-js@2";
import type { ErpScope, ToolManifest, ToolModule } from "./core/types.ts";
import { resolveErpScope, simulateScope, gateDeny, visibleTo } from "./core/scope.ts";
import { assemblePrompt, joinPrompt, LEGACY_SYSTEM_PROMPT } from "./core/prompt.ts";
import { loadAiConfig, usableModels, pickModel, priceFor } from "./core/config.ts";
import { ADAPTERS, type ChatMsg, type StreamState } from "./llm/openai.ts";
import { MODULES } from "./modules/index.ts";
import { MODULE_KO } from "./core/util.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MAX_MSG_CHARS = 8000;
const MAX_ROUNDS = 4;
const VENDORS = Object.keys(ADAPTERS);

/* ===== Entra 토큰 검증(운영과 동일) ===== */
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

type LabOpts = {
  disabled: Set<string>; simulate: string[] | null;
  prompt_mode: "auto" | "db" | "code"; perm_filter: "gate" | "hide"; model: string | null;
};
function readLab(raw: unknown): LabOpts {
  // deno-lint-ignore no-explicit-any
  const l = (raw && typeof raw === "object" ? raw : {}) as any;
  const ids = new Set(MODULES.map((m) => m.manifest.id));
  return {
    disabled: new Set((Array.isArray(l.disabled) ? l.disabled : []).map(String).filter((x: string) => ids.has(x))),
    simulate: l.simulate && Array.isArray(l.simulate.modules) ? l.simulate.modules.map(String).slice(0, 20) : null,
    prompt_mode: ["auto", "db", "code"].includes(l.prompt_mode) ? l.prompt_mode : "auto",
    perm_filter: l.perm_filter === "hide" ? "hide" : "gate",
    model: typeof l.model === "string" && l.model ? l.model.slice(0, 80) : null,
  };
}

/** 이번 요청에 주입할 모듈 고르기(13 기획 §2-5 ②) — 이유를 함께 돌려준다. */
function selectModules(scope: ErpScope, lab: LabOpts) {
  const injected: ToolModule[] = [];
  const excluded: { id: string; title_ko: string; reason: string }[] = [];
  for (const m of MODULES) {
    const mf = m.manifest;
    if (mf.status === "off") { excluded.push({ id: mf.id, title_ko: mf.title_ko, reason: "상태 off" }); continue; }
    if (lab.disabled.has(mf.id)) { excluded.push({ id: mf.id, title_ko: mf.title_ko, reason: "실험에서 끔" }); continue; }
    if (lab.perm_filter === "hide" && !visibleTo(mf, scope)) {
      excluded.push({ id: mf.id, title_ko: mf.title_ko, reason: `권한 없음(${MODULE_KO[mf.perm_module || ""] || mf.perm_module})` });
      continue;
    }
    injected.push(m);
  }
  return { injected, excluded };
}

function buildPrompt(lab: LabOpts, injected: ToolModule[], excluded: { id: string; title_ko: string; reason: string }[], dbPrompt: string) {
  if (lab.prompt_mode === "db") return { text: dbPrompt, parts: [{ key: "db", label: "운영 DB 프롬프트(ai_gateway_config)", text: dbPrompt }] };
  if (lab.prompt_mode === "code") return { text: LEGACY_SYSTEM_PROMPT, parts: [{ key: "code", label: "운영 코드 상수(SYSTEM_PROMPT)", text: LEGACY_SYSTEM_PROMPT }] };
  const denied = excluded.filter((e) => e.reason.startsWith("권한 없음"));
  const parts = assemblePrompt(injected.map((m) => m.manifest), denied);
  return { text: joinPrompt(parts), parts };
}

/** 결과에서 건수·결과 유형을 뽑는다(추적 표시용). */
function outcomeOf(result: unknown, view: unknown): { outcome: string; rows: number | null } {
  // deno-lint-ignore no-explicit-any
  const r = (result || {}) as any; const v = (view || {}) as any;
  if (r.접근제한) return { outcome: "denied", rows: null };
  if (r.오류) return { outcome: "error", rows: null };
  const n = Array.isArray(v.rows) ? v.rows.length
    : Array.isArray(r.목록) ? r.목록.length
    : typeof r.건수 === "number" ? r.건수 : null;
  return { outcome: n === 0 ? "empty" : "ok", rows: n };
}

const publicManifest = (mf: ToolManifest) => ({ ...mf });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized: MS 로그인 토큰이 필요합니다." }, 401);
  const user = await verifyEntraUser(token);
  if (!user) return json({ error: "unauthorized: 사내(@jeilm.co.kr) 계정 인증 실패 — 다시 로그인하세요." }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const realScope = await resolveErpScope(admin, user.upn);
  // ★ 실험실은 전체관리자 전용 — 화면 게이트와 별개로 서버가 막는다(CLAUDE.md §5.4)
  if (!realScope.isAdmin) return json({ error: "forbidden: 챗봇 실험실은 전체관리자만 사용할 수 있습니다." }, 403);

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const lab = readLab(body.lab);
  const scope = lab.simulate ? simulateScope(realScope, lab.simulate) : realScope;
  const ai = await loadAiConfig(admin);
  const usable = usableModels(ai, VENDORS);

  if (body.op === "registry") {
    return json({
      modules: MODULES.map((m) => publicManifest(m.manifest)),
      perm_modules: Object.entries(MODULE_KO).map(([k, v]) => ({ key: k, label: v })),
      models: ai.models.map((m) => ({ ...m, usable: usable.has(m.model_id) })),
      default_model: ai.default_model,
      vendors: VENDORS,
      db_prompt: { set: ai.db_prompt_set, chars: ai.system_prompt.length, text: ai.system_prompt },
      code_prompt_chars: LEGACY_SYSTEM_PROMPT.length,
      me: { upn: realScope.upn, dept: realScope.dept, name: realScope.empNm, modules: [...realScope.modules] },
    });
  }

  const { injected, excluded } = selectModules(scope, lab);
  const prompt = buildPrompt(lab, injected, excluded, ai.system_prompt);

  if (body.op === "preview") {
    return json({
      injected: injected.map((m) => m.manifest.id), excluded,
      prompt: { mode: lab.prompt_mode, chars: prompt.text.length, parts: prompt.parts },
      scope: { simulated: !!lab.simulate, isAdmin: scope.isAdmin, modules: [...scope.modules] },
      tools_json_chars: JSON.stringify(injected.map((m) => ({ n: m.manifest.id, d: m.manifest.description_llm, p: m.manifest.params }))).length,
    });
  }

  // ===== 대화 =====
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const messages: ChatMsg[] = raw
    // deno-lint-ignore no-explicit-any
    .filter((m: any) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-ai.max_messages)
    // deno-lint-ignore no-explicit-any
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));
  if (!messages.length) return json({ error: "messages가 비어 있습니다." }, 400);
  const total = messages.reduce((n, m) => n + ("content" in m ? String(m.content).length : 0), 0);
  if (total > ai.max_total_chars) return json({ error: "대화가 너무 깁니다. 새 대화로 시작하세요." }, 400);

  const lastUserText = [...messages].reverse().find((m) => m.role === "user");
  const model = lab.model && usable.has(lab.model) ? lab.model
    : pickModel(lastUserText && "content" in lastUserText ? String(lastUserText.content) : "", ai, VENDORS);
  const vendor = String(usable.get(model)?.vendor || "openai").toLowerCase();
  const adapter = ADAPTERS[vendor] || ADAPTERS.openai;
  const apiKey = Deno.env.get(adapter.keyEnv);
  if (!apiKey) return json({ error: `서버 미설정: ${adapter.keyEnv} 시크릿이 없습니다.` }, 503);

  let logId: number | null = null;
  try {
    const { data } = await admin.from("chat_log")
      .insert({ upn: user.upn, model, messages_count: messages.length, prompt_chars: total, session_id: null })
      .select("id").single();
    logId = data?.id ?? null;
  } catch { /* 로그 실패는 무시 */ }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const upstream = new AbortController();
  let clientGone = false;
  const onGone = () => { clientGone = true; try { upstream.abort(); } catch { /* 무시 */ } };
  try { req.signal?.addEventListener("abort", onGone); } catch { /* 무시 */ }
  const send = (o: unknown) => writer.write(enc.encode("data: " + JSON.stringify(o) + "\n\n")).catch((e: unknown) => { onGone(); throw e; });
  const lab_ = (o: Record<string, unknown>) => send({ jeilax_lab: o }).catch(() => {});
  const emit = (c: string) => send({ choices: [{ delta: { content: c } }] });

  const byId = new Map(injected.map((m) => [m.manifest.id, m]));
  const t0 = Date.now();

  const run = (async () => {
    const state: StreamState = { pt: 0, ct: 0, toolCalls: {} };
    const toolsUsed: string[] = [];
    let stopped = false; let rounds = 0;
    try {
      await lab_({
        type: "start", model, vendor, prompt_mode: lab.prompt_mode, perm_filter: lab.perm_filter,
        simulated: !!lab.simulate, scope_modules: [...scope.modules], is_admin: scope.isAdmin,
        injected: injected.map((m) => m.manifest.id), excluded, prompt_chars: prompt.text.length,
      });
      const convo: ChatMsg[] = [{ role: "system", content: prompt.text }, ...messages];
      let lastSig = "";
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (clientGone) { stopped = true; break; }
        rounds = round + 1;
        const lastRound = round === MAX_ROUNDS - 1;
        state.toolCalls = {};
        const r = await adapter.round({ apiKey, model, messages: convo, tools: lastRound ? null : injected.map((m) => m.manifest),
          maxTokens: ai.max_tokens, temperature: ai.temperature, signal: upstream.signal, emit, state });
        if (!r.ok) {
          console.error("llm error", r.status, r.detail);
          await emit(r.status === 401 ? "⚠ AI 키가 유효하지 않습니다(만료/오입력)."
            : r.status === 429 ? "⚠ AI 사용량 한도 초과 — 잠시 후 다시 시도하세요."
            : "⚠ AI 응답 생성에 실패했습니다.");
          await lab_({ type: "llm_error", status: r.status, detail: r.detail.slice(0, 300) });
          break;
        }
        const calls = Object.values(state.toolCalls).filter((c) => c.name);
        if (!calls.length) break;
        const sig = calls.map((c) => c.name + ":" + c.args).sort().join("|");
        if (sig === lastSig) { await lab_({ type: "loop_stop", round: rounds }); break; }
        lastSig = sig;
        convo.push({ role: "assistant_tools", calls });
        for (const c of calls) {
          toolsUsed.push(c.name);
          const mod = byId.get(c.name);
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(c.args || "{}"); } catch { /* 빈 인자 */ }
          const ts = Date.now();
          let result: unknown;
          let gated = false;
          if (!mod) {
            result = { 오류: `알 수 없는 도구: ${c.name}` };
          } else {
            // 실행 직전 2차 방어선 — 주입 단계와 무관하게 권한을 다시 본다(§2-5 ④)
            const deny = gateDeny(mod.manifest, scope);
            if (deny) { result = deny; gated = true; }
            else {
              try { result = await mod.run({ admin, args, asOf: new Date().toISOString(), scope, userToken: token }); }
              catch (e) { result = { 오류: "조회 실패: " + (e instanceof Error ? e.message : String(e)) }; }
            }
          }
          const ms = Date.now() - ts;
          const ro = result as Record<string, unknown> | null;
          const view = ro && typeof ro === "object" ? ro.__view : null;
          if (ro && view) {
            delete ro.__view;
            const payload = JSON.stringify({ jeilax: view });
            if (payload.length <= 16000) await writer.write(enc.encode("data: " + payload + "\n\n")).catch(() => onGone());
          }
          const modelText = JSON.stringify(result).slice(0, 12000);
          const oc = outcomeOf(result, view);
          await lab_({
            type: "tool", round: rounds, tool: c.name, version: mod?.manifest.version ?? null,
            kind: mod?.manifest.kind ?? null, perm_module: mod?.manifest.perm_module ?? null,
            args, ms, outcome: oc.outcome, rows: oc.rows, gated, has_view: !!view,
            result_chars: modelText.length, result_preview: modelText.slice(0, 1500),
          });
          convo.push({ role: "tool", call_id: c.id, content: modelText });
        }
      }
    } catch (e) {
      if (clientGone || (e instanceof Error && e.name === "AbortError")) stopped = true;
      else { try { await emit("⚠ 오류: " + (e instanceof Error ? e.message : String(e))); } catch { /* 종료됨 */ } }
    } finally {
      const price = priceFor(model, ai);
      const cost = (state.pt * price.inp + state.ct * price.out) / 1_000_000;
      await lab_({ type: "end", rounds, pt: state.pt, ct: state.ct, est_cost_usd: Number(cost.toFixed(6)), ms: Date.now() - t0, stopped, tools_used: toolsUsed });
      try { req.signal?.removeEventListener("abort", onGone); } catch { /* 무시 */ }
      try { await writer.write(enc.encode("data: [DONE]\n\n")); } catch { /* 무시 */ }
      try { await writer.close(); } catch { /* 무시 */ }
      if (logId != null) {
        try {
          await admin.from("chat_log").update({
            prompt_tokens: state.pt || null, completion_tokens: state.ct || null,
            est_cost_usd: state.pt || state.ct ? Number(cost.toFixed(6)) : null,
            tools_used: toolsUsed.length ? toolsUsed : null, stopped,
          }).eq("id", logId);
        } catch { /* 무시 */ }
      }
    }
  })();
  // @ts-ignore: Supabase Edge Runtime
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(run);

  return new Response(readable, { headers: { ...cors, "Content-Type": "text/event-stream", "x-model": model } });
});
