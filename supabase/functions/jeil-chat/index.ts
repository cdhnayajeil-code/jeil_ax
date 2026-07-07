// jeil-chat — 사내 AI 챗봇 게이트웨이 (OpenAI 프록시)
// 배포: verify_jwt=false (Entra 토큰은 Supabase JWT가 아니므로 내부에서 직접 검증)
// 호출: POST /functions/v1/jeil-chat  Authorization: Bearer <Entra access_token(User.Read)>
//   body: { messages: [{role:'user'|'assistant', content:string}, ...] }
//   응답: OpenAI SSE 스트림 패스스루 (text/event-stream)
// 원칙(CLAUDE.md §1·§6): API 키는 서버 시크릿(OPENAI_API_KEY)에만 존재. 프론트 미노출.
//   사용 이력은 chat_log 테이블에 기록(감사 로그).
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

// 입력 상한 (키 남용·과금 폭주 방지)
const MAX_MESSAGES = 20;
const MAX_MSG_CHARS = 8000;
const MAX_TOTAL_CHARS = 24000;

const SYSTEM_PROMPT =
  "당신은 제일엠앤에스(JEIL M&S)의 사내 AI 어시스턴트 'jeil-chat'입니다. " +
  "업무 문서 초안(주간보고·메일·공지), 규정 질의, 데이터 요약을 한국어로 간결하고 정확하게 돕습니다. " +
  "확실하지 않은 사내 수치·규정은 추측하지 말고 원본 확인을 권하세요. " +
  "급여·주민번호 등 개인정보나 비밀값을 답변에 포함하지 마세요.";

// Entra 액세스 토큰 검증: Microsoft Graph /me 호출로 유효성 + 사내 도메인 확인
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return json({ error: "서버 미설정: OPENAI_API_KEY 시크릿이 등록되지 않았습니다." }, 503);
  const model = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";

  // 1) 사내 사용자 검증 (Entra 토큰 → Graph)
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized: MS 로그인 토큰이 필요합니다." }, 401);
  const user = await verifyEntraUser(token);
  if (!user) return json({ error: "unauthorized: 사내(@jeilm.co.kr) 계정 인증 실패 — 다시 로그인하세요." }, 401);

  // 2) 입력 검증
  let body: { messages?: Array<{ role: string; content: string }> };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const messages = raw
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));
  if (!messages.length) return json({ error: "messages가 비어 있습니다." }, 400);
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total > MAX_TOTAL_CHARS) return json({ error: "대화가 너무 깁니다. 새 대화로 시작하세요." }, 400);

  // 3) 감사 로그 (service_role — 실패해도 응답은 진행)
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("chat_log").insert({
      upn: user.upn, model, messages_count: messages.length, prompt_chars: total,
    });
  } catch { /* 로그 실패는 무시 */ }

  // 4) OpenAI 호출 — SSE 스트림 패스스루
  const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: 1024,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    }),
  });
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.error("openai error", upstream.status, detail.slice(0, 500));
    const msg = upstream.status === 401 ? "OpenAI 키가 유효하지 않습니다(만료/오입력)."
      : upstream.status === 429 ? "OpenAI 사용량 한도 초과 — 잠시 후 다시 시도하세요."
      : "AI 응답 생성에 실패했습니다.";
    return json({ error: msg, status: upstream.status }, 502);
  }
  return new Response(upstream.body, {
    headers: { ...cors, "Content-Type": "text/event-stream", "x-model": model },
  });
});
