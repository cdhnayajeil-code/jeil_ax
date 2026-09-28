// jeil-chat-lab — 챗봇 모듈형 고도화 **실험실** 게이트웨이 (REQ-0084 · 13 기획 · ADR-108 제안)
// 화면: https://ai.jeilm.co.kr/chatdemo (app/chat-lab.html) — **전체관리자(perm_effective.is_admin)만**.
// 운영 jeil-chat 과 완전히 분리된 함수다. 운영 챗봇·대화내역에 영향이 없다.
//
// 구조(13 기획 §2):
//   modules/<domain>/<tool>.ts  = manifest(설명서) + run(ctx)   ← 도구 1개 = 파일 1개
//   modules/index.ts            = 등록 목록(정적 import)
//   core/                       = 타입·헬퍼·권한·프롬프트 조립·설정
//   llm/<vendor>.ts             = 벤더 어댑터(openai · anthropic — REQ-0085)
//   core/engine.ts              = 대화 루프 1개(실험실·에이전트·골든셋 공유)
//   core/agent*.ts              = 부서 에이전트(14 기획 · ADR-109 · REQ-0086~0088) — body.agent 가 있으면 이쪽
//
// ★ 두 가지 입구
//   ① 실험실(body.agent 없음) : 전체관리자 전용 — 아래 원칙 그대로.
//   ② 부서 에이전트(body.agent): 에이전트 구성원(operator/reviewer) · 관리자 · (live 면) 일반 사용자. 판정은 core/agent.ts roleOf.
//      대화 턴은 agent_turn 에 기록(품질 개선용 · 화면 고지). 실험실 원칙 "대화 원문 미저장"은 ①에만 해당한다.
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
import { resolveErpScope, simulateScope, visibleTo } from "./core/scope.ts";
import { assemblePrompt, joinPrompt, LEGACY_SYSTEM_PROMPT } from "./core/prompt.ts";
import { loadAiConfig, usableModels, pickModel, costOf } from "./core/config.ts";
import { readyVendors, type ChatMsg } from "./llm/index.ts";
import { MODULES as PORTED } from "./modules/index.ts";
import { EXTRA_MODULES } from "./modules/extra.ts";
import { MODULE_KO } from "./core/util.ts";
import { converse } from "./core/engine.ts";
import { handleAgent } from "./core/agent_api.ts";

/** 등록 모듈 = 운영에서 옮긴 19종(자동 생성) + 손으로 쓴 모듈(부서 에이전트). */
const MODULES: ToolModule[] = [...PORTED, ...EXTRA_MODULES];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MAX_MSG_CHARS = 8000;
const MAX_ROUNDS = 4;

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

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  const VENDORS = readyVendors();
  // ② 부서 에이전트 — 권한 판정은 handleAgent 안에서(구성원·관리자·live)
  if (typeof body.agent === "string" && body.agent) {
    const ai = await loadAiConfig(admin);
    return handleAgent({ admin, token, scope: realScope, ai, usable: usableModels(ai, VENDORS), vendors: VENDORS,
      modules: MODULES, req, json, cors }, body);
  }

  // ① 실험실은 전체관리자 전용 — 화면 게이트와 별개로 서버가 막는다(CLAUDE.md §5.4)
  if (!realScope.isAdmin) return json({ error: "forbidden: 챗봇 실험실은 전체관리자만 사용할 수 있습니다." }, 403);
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
  const vendorOf = (m: string) => String(ai.models.find((x) => x.model_id === m)?.vendor || "openai").toLowerCase();
  const vendor = vendorOf(model);
  if (!VENDORS.includes(vendor)) return json({ error: `서버 미설정: ${vendor} 키 시크릿이 없습니다.` }, 503);

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

  const t0 = Date.now();

  const run = (async () => {
    let res: Awaited<ReturnType<typeof converse>> | null = null;
    let stopped = false;
    try {
      await lab_({
        type: "start", model, vendor, prompt_mode: lab.prompt_mode, perm_filter: lab.perm_filter,
        simulated: !!lab.simulate, scope_modules: [...scope.modules], is_admin: scope.isAdmin,
        injected: injected.map((m) => m.manifest.id), excluded, prompt_chars: prompt.text.length,
      });
      res = await converse({
        admin, userToken: token, scope, model, vendorOf, modules: injected, system: prompt.text, messages,
        maxTokens: ai.max_tokens, temperature: ai.temperature, effort: vendor === "anthropic" ? "medium" : null, caching: true,
        maxRounds: MAX_ROUNDS, signal: upstream.signal, isGone: () => clientGone, emit,
        onView: async (view) => {
          const payload = JSON.stringify({ jeilax: view });
          if (payload.length <= 16000) await writer.write(enc.encode("data: " + payload + "\n\n")).catch(() => onGone());
        },
        onTool: (t) => lab_({ type: "tool", round: t.round, tool: t.tool, version: t.version, kind: t.kind, perm_module: t.perm_module,
          args: t.args, ms: t.ms, outcome: t.outcome, rows: t.rows, gated: t.gated, has_view: t.has_view,
          result_chars: t.result_chars, result_preview: t.result_preview }),
        onNote: (n) => lab_(n),
      });
      stopped = res.stopped;
    } catch (e) {
      if (clientGone || (e instanceof Error && e.name === "AbortError")) stopped = true;
      else { try { await emit("⚠ 오류: " + (e instanceof Error ? e.message : String(e))); } catch { /* 종료됨 */ } }
    } finally {
      const st = res?.state || { pt: 0, ct: 0, cr: 0, cw: 0, toolCalls: {} };
      const usedModel = res?.model || model;
      const cost = costOf(usedModel, ai, st);
      const toolsUsed = (res?.tools || []).map((t) => t.tool);
      await lab_({ type: "end", rounds: res?.rounds || 0, pt: st.pt, ct: st.ct, cr: st.cr || 0, est_cost_usd: Number(cost.toFixed(6)),
        ms: Date.now() - t0, stopped, tools_used: toolsUsed });
      try { req.signal?.removeEventListener("abort", onGone); } catch { /* 무시 */ }
      try { await writer.write(enc.encode("data: [DONE]\n\n")); } catch { /* 무시 */ }
      try { await writer.close(); } catch { /* 무시 */ }
      if (logId != null) {
        try {
          await admin.from("chat_log").update({
            model: usedModel, prompt_tokens: st.pt || null, completion_tokens: st.ct || null,
            est_cost_usd: st.pt || st.ct ? Number(cost.toFixed(6)) : null,
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
