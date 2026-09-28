// app/lib/agentApi.js — 부서 에이전트 API 클라이언트(데이터 접근 단일 진입점 §3.3) · REQ-0086/0087/0088
// 서버: supabase/functions/jeil-chat-lab (body.agent 경로 — core/agent_api.ts). 권한 판정은 전부 서버가 한다(§5.4).
// 토큰: 포털(/main)이 저장한 Entra 토큰 localStorage 'jeilax_auth' — 데모 한정 저장 방식(운영 전환 시 BFF 로 교체, §6).
import { SUPABASE_URL } from "../config.js";

const FN = SUPABASE_URL + "/functions/v1/jeil-chat-lab";

export function auth() {
  try { const a = JSON.parse(localStorage.getItem("jeilax_auth") || "null"); return (a && a.at && a.exp > Date.now()) ? a : null; }
  catch (e) { return null; }
}
export function toLogin() {
  const here = location.pathname + location.search;
  try { sessionStorage.setItem("jeilax_next", here); sessionStorage.setItem("jeilax_next_name", document.title.slice(0, 120)); } catch (e) { /* 무시 */ }
  location.replace("/main?next=" + encodeURIComponent(here));
}
export class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/** JSON op 호출. 401 이면 로그인으로 보낸다. */
export async function op(agent, name, payload = {}) {
  const a = auth(); if (!a) { toLogin(); throw new ApiError(401, "login"); }
  const r = await fetch(FN, { method: "POST", headers: { Authorization: "Bearer " + a.at, "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, agent, op: name }) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { toLogin(); throw new ApiError(401, "login"); }
  if (!r.ok) throw new ApiError(r.status, j.error || ("HTTP " + r.status));
  return j;
}

/** 대화(SSE). handlers: onText(t) · onView(v) · onEvent(ev: jeilax_agent) — 끝나면 resolve. signal 로 중지. */
export async function chat(agent, messages, handlers = {}, { signal, version } = {}) {
  const a = auth(); if (!a) { toLogin(); throw new ApiError(401, "login"); }
  const r = await fetch(FN, { method: "POST", signal, headers: { Authorization: "Bearer " + a.at, "Content-Type": "application/json" },
    body: JSON.stringify({ agent, messages, ...(version ? { version } : {}) }) });
  if (!r.ok || !r.body) {
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { toLogin(); throw new ApiError(401, "login"); }
    throw new ApiError(r.status, j.error || ("HTTP " + r.status));
  }
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop() || "";
    for (const ln of lines) {
      const t = ln.trim(); if (!t.startsWith("data:")) continue;
      const p = t.slice(5).trim(); if (p === "[DONE]") continue;
      let ev; try { ev = JSON.parse(p); } catch (e) { continue; }
      if (ev.jeilax_agent) handlers.onEvent && handlers.onEvent(ev.jeilax_agent);
      else if (ev.jeilax) handlers.onView && handlers.onView(ev.jeilax);
      else {
        const c = ev.choices && ev.choices[0] && ev.choices[0].delta && ev.choices[0].delta.content;
        if (c) handlers.onText && handlers.onText(c);
      }
    }
  }
}
