// core/agent_api.ts — 부서 에이전트 API(14 기획 · ADR-109 · REQ-0086/0087/0088).
// 호출: POST jeil-chat-lab  { agent:"purchase", op?, ... }  — op 가 없고 messages 가 있으면 대화(SSE).
//
// 역할(core/agent.ts roleOf)
//   user     : 대화 · 👍👎 · 내 자료함                      (live 에이전트의 일반 사용자)
//   operator : + 설정 초안(새 버전) · 개선 대장 · 용어집 · 골든셋 · 회귀 실행 · 턴 열람   (구매팀 실작업자)
//   reviewer : + 버전 「현재」 지정 · 상태·한도·예산 · 구성원 관리                      (관리자: 확인·점검·승인)
// 모든 판정은 서버에서(CLAUDE.md §5.4). 화면의 버튼 숨김은 편의일 뿐이다.
import type { ErpScope, ToolModule } from "./types.ts";
import type { AiConfig, AiModelRow } from "./config.ts";
import { costOf } from "./config.ts";

/** 채점·분류에 쓰는 「싼 모델」 우선순위 — 앞에서부터 실제 호출 가능한 첫 모델을 쓴다.
 *  사람이 읽는 답이 아니라 내부 판정(골든셋 채점·개선대장 묶기)이므로 **단가가 첫 기준**이다.
 *  2026-09-29 공식표 기준 단가: gpt-6-luna $0.10/$0.50 · gpt-4o-mini $0.15/$0.60 ·
 *    claude-haiku-4-5 $1/$5 · gpt-4.1-mini $0.40/$1.60 → 이 순서가 곧 싼 순서다.
 *  Haiku 4.5 는 은퇴 예고 상태가 아니다(Active · 보장 기한 2026-10-15 · 은퇴 시 60일 전 통지) —
 *  뒤로 내린 이유는 마감이 아니라 10배 비싸기 때문이다. */
const JUDGE_MODELS = ["gpt-6-luna", "gpt-4o-mini", "claude-haiku-4-5", "gpt-4.1-mini"];
import { visibleTo } from "./scope.ts";
import { MODULE_KO } from "./util.ts";
import {
  type AgentRole, type AgentRow, type AgentVersion, AGENT_COLS, VERSION_COLS,
  agentModules, agentPrompt, joinAgentPrompt, loadAgent, loadVersion, roleOf, todayKst, turnFlags,
} from "./agent.ts";
import { converse } from "./engine.ts";
import type { ChatMsg } from "../llm/index.ts";
import type { Attachment } from "../llm/types.ts";

/* ───── 첨부 파일 검사(REQ-0089) ─────
   화면이 글자로 푼 파일(text)·이미지·PDF 를 질문에 붙여 보낸다. 서버는 원본을 저장하지 않고, 여기서 형식·크기·민감정보만 본다.
   대화가 이어지면 화면이 이전 첨부도 다시 보내므로, **최신 질문부터** 예산을 채우고 넘치는 옛 첨부는 안내 문구로 바꾼다. */
const ATT = { maxFiles: 5, textChars: 60_000, totalText: 150_000, imageB64: 7_000_000, pdfB64: 11_000_000, totalB64: 14_000_000 };
const IMG_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const RRN = /\b\d{6}\s?-\s?[1-4]\d{6}\b/;   // 주민등록번호 형식(§1.7) — 발견하면 거부
function checkAttachments(messages: ChatMsg[]): { error?: string; meta: { name: string; kind: string; chars?: number; bytes?: number }[] } {
  let textLeft = ATT.totalText, b64Left = ATT.totalB64;
  let meta: { name: string; kind: string; chars?: number; bytes?: number }[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || !m.parts) continue;
    const latest = i === messages.length - 1;
    if (m.parts.length > ATT.maxFiles) return { error: `파일은 한 번에 ${ATT.maxFiles}개까지 첨부할 수 있습니다.`, meta: [] };
    const out: Attachment[] = [];
    for (const raw of m.parts as unknown[]) {
      const p = (raw || {}) as Record<string, unknown>;
      const name = String(p.name || "첨부").replace(/[\r\n]/g, " ").slice(0, 120);
      if (p.kind === "text" && typeof p.text === "string") {
        const text = p.text.slice(0, ATT.textChars);
        if (RRN.test(text)) return { error: `'${name}' 에 주민등록번호로 보이는 값이 있어 보낼 수 없습니다. 해당 열을 지우고 다시 첨부해 주세요.`, meta: [] };
        if (text.length > textLeft) { out.push({ kind: "note", name, text: `(이전 첨부 '${name}' 은 대화가 길어 제외 — 필요하면 다시 첨부)` }); continue; }
        textLeft -= text.length;
        out.push({ kind: "text", name, text: text + (p.text.length > ATT.textChars ? `\n…(이하 ${p.text.length - ATT.textChars}자 생략)` : "") });
        if (latest) meta.push({ name, kind: "text", chars: p.text.length });
      } else if ((p.kind === "image" || p.kind === "pdf") && typeof p.data === "string" && /^[A-Za-z0-9+/=]+$/.test(p.data.slice(0, 200))) {
        const media = p.kind === "pdf" ? "application/pdf" : String(p.media || "");
        if (p.kind === "image" && !IMG_TYPES.includes(media)) return { error: `'${name}' — 이미지는 PNG·JPG·GIF·WEBP 만 됩니다.`, meta: [] };
        const cap = p.kind === "pdf" ? ATT.pdfB64 : ATT.imageB64;
        if (p.data.length > cap) return { error: `'${name}' 이 너무 큽니다(${p.kind === "pdf" ? "PDF 8MB" : "이미지 5MB"} 이하).`, meta: [] };
        if (p.data.length > b64Left) { out.push({ kind: "note", name, text: `(이전 첨부 '${name}' 은 대화가 길어 제외 — 필요하면 다시 첨부)` }); continue; }
        b64Left -= p.data.length;
        out.push(p.kind === "pdf" ? { kind: "pdf", name, data: p.data } : { kind: "image", name, media, data: p.data });
        if (latest) meta.push({ name, kind: p.kind, bytes: Math.round(p.data.length * 0.75) });
      }
    }
    // note 는 글자 조각으로 바꿔 넣는다(어댑터는 text·image·pdf 만 안다)
    m.parts = out.map((a) => a.kind === "note" ? { kind: "text", name: a.name, text: a.text } : a);
  }
  meta = meta.reverse();
  return { meta };
}

export type AgentCtx = {
  // deno-lint-ignore no-explicit-any
  admin: any; token: string; scope: ErpScope; ai: AiConfig; usable: Map<string, AiModelRow>; vendors: string[];
  modules: ToolModule[]; req: Request; json: (o: unknown, status?: number) => Response; cors: Record<string, string>;
};

const MAX_MSG_CHARS = 8000;
const BUCKET = "agent-artifacts";
const ROLE_RANK: Record<string, number> = { user: 1, operator: 2, reviewer: 3 };
const need = (role: AgentRole, min: "user" | "operator" | "reviewer") => !!role && ROLE_RANK[role] >= ROLE_RANK[min];
const vendorOf = (ai: AiConfig) => (m: string) => String(ai.models.find((x) => x.model_id === m)?.vendor || "openai").toLowerCase();
const monthStart = () => todayKst().slice(0, 7) + "-01T00:00:00+09:00";
const dayStart = () => todayKst() + "T00:00:00+09:00";
const txt = (v: unknown, max: number) => String(v ?? "").slice(0, max);

/* 부서 NAS 저장(REQ-0108) — 형식·이름 기준. 민감 이름은 NAS 색인(nas_index.py _SENSITIVE_NAME)과 같은 낱말이다(한쪽만 고치지 않는다). */
const NAS_SAVE_EXT = new Set([".csv", ".tsv", ".txt", ".md", ".json", ".sql", ".log", ".xml", ".html", ".htm", ".xlsx", ".xlsm", ".docx", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const NAS_TEXT_EXT = new Set([".csv", ".tsv", ".txt", ".md", ".json", ".sql", ".log", ".xml", ".html", ".htm"]);
const NAS_SENSITIVE_NAME = /급여|연봉|임금대장|인사평가|고과|주민등록|통장사본|신분증/i;
const NAS_SAVE_MAX_B64 = Math.ceil(8 * 1024 * 1024 / 3) * 4;   // 8MB 원본
/** 파일 이름에서 경로·금지 글자를 뺀다. 확장자는 유지. */
const safeFileName = (n: string) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").replace(/^[.\s]+/, "").trim().slice(0, 150);
async function sha256Hex(buf: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// deno-lint-ignore no-explicit-any
async function glossaryOf(admin: any, key: string) {
  const { data } = await admin.from("agent_glossary").select("term,meaning").eq("agent_key", key).eq("active", true).order("term");
  return (data || []) as { term: string; meaning: string }[];
}
// deno-lint-ignore no-explicit-any
async function monthSpend(admin: any, key: string): Promise<number> {
  const { data } = await admin.from("agent_turn").select("est_cost_usd").eq("agent_key", key).gte("created_at", monthStart()).limit(20000);
  // deno-lint-ignore no-explicit-any
  return ((data || []) as any[]).reduce((n, r) => n + (Number(r.est_cost_usd) || 0), 0);
}

/** 버전 → 실제 쓸 모델. 기본 모델이 부를 수 없으면(키 미등록·비활성) 예비 모델, 그것도 없으면 전역 기본값. */
function resolveModel(c: AgentCtx, v: AgentVersion, overBudget: boolean): { model: string | null; fallback: string | null; reason: string | null } {
  const ok = (m: string | null | undefined) => !!m && c.usable.has(m);
  if (overBudget && ok(v.fallback_model_id)) return { model: v.fallback_model_id, fallback: null, reason: "월 예산 초과 — 예비 모델로 전환" };
  if (ok(v.model_id)) return { model: v.model_id, fallback: ok(v.fallback_model_id) ? v.fallback_model_id : null, reason: null };
  if (ok(v.fallback_model_id)) return { model: v.fallback_model_id, fallback: null, reason: `기본 모델(${v.model_id}) 호출 불가 — 예비 모델 사용` };
  if (ok(c.ai.default_model)) return { model: c.ai.default_model, fallback: null, reason: `설정 모델 호출 불가 — 전역 기본(${c.ai.default_model})` };
  return { model: null, fallback: null, reason: "호출 가능한 모델이 없습니다" };
}

/** 이 버전·이 사용자에게 주입할 모듈과, 권한 때문에 빠진 모듈. */
function pickModules(c: AgentCtx, v: AgentVersion, scope: ErpScope) {
  const mods = agentModules(c.modules, v);
  const injected = mods.filter((m) => visibleTo(m.manifest, scope));
  const denied = mods.filter((m) => !visibleTo(m.manifest, scope)).map((m) => ({ id: m.manifest.id, title_ko: m.manifest.title_ko }));
  return { injected, denied };
}

export async function handleAgent(c: AgentCtx, body: Record<string, unknown>): Promise<Response> {
  const { admin, json, scope } = c;
  const agent = await loadAgent(admin, String(body.agent || ""));
  if (!agent || agent.status === "off") return json({ error: "없는 에이전트이거나 중지된 에이전트입니다." }, 404);
  const role = await roleOf(admin, agent, scope);
  if (!role) return json({ error: `forbidden: ${agent.name_ko}는 파일럿 구성원만 사용할 수 있습니다. 필요하면 관리자에게 요청하세요.` }, 403);
  const op = typeof body.op === "string" ? body.op : "";

  if (!op) return chat(c, agent, role, body);

  switch (op) {
    /* ───── 사용자 ───── */
    case "boot": {
      const v = await loadVersion(admin, agent.agent_key, null);
      const { count } = await admin.from("agent_turn").select("id", { count: "exact", head: true })
        .eq("agent_key", agent.agent_key).eq("upn", scope.upn).is("golden_run_id", null).gte("created_at", dayStart());
      const rm = v ? resolveModel(c, v, false) : { model: null, reason: "현재 버전 없음" };
      return json({
        agent: { key: agent.agent_key, name: agent.name_ko, icon: agent.icon, summary: agent.summary_ko, status: agent.status,
          suggestions: agent.suggestions, collect: agent.collect_turns, retention_days: agent.retention_days, daily_limit: agent.daily_limit },
        role, version: v?.version ?? null, model: rm.model, model_note: rm.reason,
        today: { used: count || 0, limit: agent.daily_limit },
        me: { upn: scope.upn, name: scope.empNm, dept: scope.dept },
      });
    }
    case "rate": {
      const id = Number(body.turn_id); const rating = Number(body.rating);
      if (!id || ![1, -1].includes(rating)) return json({ error: "turn_id·rating(1|-1) 필요" }, 400);
      const { data: t } = await admin.from("agent_turn").select("id,upn,question").eq("id", id).eq("agent_key", agent.agent_key).maybeSingle();
      if (!t || t.upn !== scope.upn) return json({ error: "본인 대화만 평가할 수 있습니다." }, 403);
      const note = txt(body.note, 500) || null;
      await admin.from("agent_turn").update({ rating, rating_note: note, rated_at: new Date().toISOString() }).eq("id", id);
      if (rating === -1) {
        await admin.from("agent_improve").insert({ agent_key: agent.agent_key, source: "thumbs_down", turn_ids: [id],
          summary: `👎 ${txt(t.question, 120)}`, proposal: note ? `사용자 의견: ${note}` : null });
      }
      return json({ ok: true });
    }
    case "artifact_save": {
      const kind = body.kind === "html" ? "html" : body.kind === "csv" ? "csv" : null;
      const content = typeof body.content === "string" ? body.content : "";
      const title = txt(body.title, 120).replace(/[\\/:*?"<>|]/g, " ").trim() || "자료";
      if (!kind || !content) return json({ error: "kind(csv|html)·content 필요" }, 400);
      if (content.length > 2_000_000) return json({ error: "자료가 너무 큽니다(2MB 초과)." }, 413);
      // 화면이 만든 HTML 만 받는다 — 스크립트·이벤트 속성·javascript: 링크가 있으면 거부(§6 출력 인코딩)
      if (kind === "html" && /<script|<iframe|<object|<embed|javascript:|\son[a-z]+\s*=/i.test(content)) return json({ error: "허용되지 않는 HTML 입니다." }, 400);
      const id = crypto.randomUUID();
      const path = `${scope.upn}/${id}.${kind}`;
      const blob = new Blob([content], { type: kind === "csv" ? "text/csv" : "text/html" });
      const up = await admin.storage.from(BUCKET).upload(path, blob, { contentType: kind === "csv" ? "text/csv" : "text/html", upsert: false });
      if (up.error) return json({ error: "저장 실패: " + up.error.message }, 500);
      const { data, error } = await admin.from("agent_artifact").insert({ id, agent_key: agent.agent_key, upn: scope.upn,
        turn_id: Number(body.turn_id) || null, title, kind, storage_path: path, size_bytes: blob.size }).select("id,title,kind,size_bytes,created_at,expires_at").single();
      if (error) return json({ error: "기록 실패: " + error.message }, 500);
      return json({ ok: true, artifact: data });
    }
    case "artifact_list": {
      await cleanupArtifacts(c, scope.upn);
      const { data } = await admin.from("agent_artifact").select("id,title,kind,size_bytes,created_at,expires_at")
        .eq("agent_key", agent.agent_key).eq("upn", scope.upn).order("created_at", { ascending: false }).limit(50);
      return json({ items: data || [] });
    }
    case "artifact_url": {
      const { data: a } = await admin.from("agent_artifact").select("upn,storage_path,title,kind").eq("id", String(body.id || "")).maybeSingle();
      if (!a || a.upn !== scope.upn) return json({ error: "본인 자료만 열 수 있습니다." }, 403);
      const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(a.storage_path, 120, { download: `${a.title}.${a.kind}` });
      if (error) return json({ error: error.message }, 500);
      return json({ url: data.signedUrl });
    }
    /* ───── 부서 NAS 저장(REQ-0108 · 정본 SQL 89) — 사용자가 버튼을 누른 것만 ───── */
    case "nas_save": {
      if (!agent.dept_nm) return json({ error: "이 에이전트에는 담당 부서가 없어 저장할 폴더를 정할 수 없습니다." }, 400);
      let bucket = "", path = "", name = "", size = 0, sha = "", kind: "attachment" | "artifact" = "attachment";
      let artifactId: string | null = null;
      if (body.source === "artifact") {
        const { data: a } = await admin.from("agent_artifact").select("id,upn,storage_path,title,kind").eq("id", String(body.id || "")).maybeSingle();
        if (!a || a.upn !== scope.upn) return json({ error: "본인 자료만 저장할 수 있습니다." }, 403);
        const dl = await admin.storage.from(BUCKET).download(a.storage_path);
        if (dl.error || !dl.data) return json({ error: "자료 원본을 읽지 못했습니다." }, 500);
        const buf = new Uint8Array(await dl.data.arrayBuffer());
        kind = "artifact"; bucket = BUCKET; path = a.storage_path; artifactId = a.id;
        name = safeFileName(`${a.title}.${a.kind}`); size = buf.length; sha = await sha256Hex(buf);
      } else {
        name = safeFileName(String(body.name || ""));
        const ext = (name.match(/\.[A-Za-z0-9]{1,5}$/)?.[0] || "").toLowerCase();
        if (!name || !NAS_SAVE_EXT.has(ext)) return json({ error: "저장할 수 없는 형식입니다. 엑셀·CSV·워드·PDF·이미지·텍스트만 저장합니다." }, 400);
        if (NAS_SENSITIVE_NAME.test(name)) return json({ error: "급여·인사평가·주민등록 등 민감 자료로 보이는 파일은 저장하지 않습니다(§1.7)." }, 400);
        const b64 = typeof body.data === "string" ? body.data : "";
        if (!b64 || b64.length > NAS_SAVE_MAX_B64) return json({ error: "파일이 너무 큽니다(8MB까지 저장합니다)." }, 413);
        let buf: Uint8Array;
        try { buf = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)); } catch { return json({ error: "파일 내용을 읽지 못했습니다." }, 400); }
        if (!buf.length) return json({ error: "빈 파일입니다." }, 400);
        if (NAS_TEXT_EXT.has(ext)) {
          // 글자 파일은 주민등록번호 꼴이 있으면 받지 않는다(채팅 첨부와 같은 기준). 엑셀·워드·PDF 는 NAS 색인 단계에서 걸러진다
          const head = new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, 2_000_000));
          if (RRN.test(head)) return json({ error: "주민등록번호로 보이는 값이 있어 저장할 수 없습니다. 해당 열을 지우고 다시 시도해 주세요." }, 400);
        }
        bucket = "nas-outbox"; path = `${scope.upn}/${crypto.randomUUID()}${ext}`; size = buf.length; sha = await sha256Hex(buf);
        const up = await admin.storage.from(bucket).upload(path, new Blob([buf]), { contentType: "application/octet-stream", upsert: false });
        if (up.error) return json({ error: "임시 보관 실패: " + up.error.message }, 500);
      }
      const { data: r, error } = await admin.rpc("nas_save_submit", { p_upn: scope.upn, p_saver: `${scope.dept || ""} ${scope.empNm || ""}`.trim(),
        p_agent: agent.agent_key, p_dept: agent.dept_nm, p_kind: kind, p_file_name: name, p_size: size, p_sha256: sha,
        p_bucket: bucket, p_path: path, p_turn_id: Number(body.turn_id) || null, p_artifact_id: artifactId });
      // 큐에 들어가지 않았으면 방금 올린 임시 파일을 남기지 않는다
      if ((error || r?.status !== "queued") && bucket === "nas-outbox") await admin.storage.from(bucket).remove([path]).catch(() => {});
      if (error) return json({ error: "저장 요청 실패: " + error.message }, 500);
      if (r.status === "no_folder") return json({ error: `${agent.dept_nm} 폴더가 사내 NAS 에 등록돼 있지 않습니다(관리자 확인 필요).` }, 409);
      if (r.status === "too_big") return json({ error: `파일이 너무 큽니다(${r.max_mb}MB까지 저장합니다).` }, 413);
      return json({ ok: true, ...r, file_name: r.file_name || name });
    }
    case "nas_saved_list": {
      if (!agent.dept_nm) return json({ folder: null, items: [] });
      const { data, error } = await admin.rpc("nas_save_list", { p_dept: agent.dept_nm, p_limit: 300 });
      if (error) return json({ error: error.message }, 500);
      // deno-lint-ignore no-explicit-any
      const items = ((data?.items || []) as any[]).map((x) => ({ ...x, mine: x.upn === scope.upn, upn: undefined }));
      return json({ ...data, items, can_manage: need(role, "reviewer") });
    }
    case "nas_saved_delete": {
      const { data, error } = await admin.rpc("nas_save_request_purge", { p_save_id: String(body.id || ""), p_upn: scope.upn, p_can_manage: need(role, "reviewer") });
      if (error) return json({ error: error.message }, 500);
      if (data?.status === "denied") return json({ error: "본인이 저장한 파일만 지울 수 있습니다." }, 403);
      if (data?.status === "missing") return json({ error: "없는 항목입니다." }, 404);
      if (data?.status === "busy") return json({ error: "저장이 진행 중입니다. 잠시 뒤 다시 시도해 주세요." }, 409);
      if (data?.cleanup?.path) await admin.storage.from("nas-outbox").remove([data.cleanup.path]).catch(() => {});
      return json({ ok: true, status: data?.status });
    }
    case "artifact_delete": {
      const { data: a } = await admin.from("agent_artifact").select("id,upn,storage_path").eq("id", String(body.id || "")).maybeSingle();
      if (!a || a.upn !== scope.upn) return json({ error: "본인 자료만 지울 수 있습니다." }, 403);
      await admin.storage.from(BUCKET).remove([a.storage_path]);
      await admin.from("agent_artifact").delete().eq("id", a.id);
      return json({ ok: true });
    }
  }

  /* ───── 담당자(operator) 이상 ───── */
  if (!need(role, "operator")) return json({ error: "forbidden: 에이전트 담당자(구성원)만 할 수 있습니다." }, 403);
  switch (op) {
    case "admin_boot": {
      await cleanupTurns(c, agent);
      const [vers, mem, glo, gold, imp] = await Promise.all([
        admin.from("ai_agent_version").select(VERSION_COLS).eq("agent_key", agent.agent_key).order("version", { ascending: false }).limit(50),
        admin.from("ai_agent_member").select("upn,role,added_by,added_at").eq("agent_key", agent.agent_key).order("role").order("upn"),
        admin.from("agent_glossary").select("id,term,meaning,active,created_by,created_at").eq("agent_key", agent.agent_key).order("term"),
        admin.from("agent_golden").select("id,question,expect_tools,expect_rules,source_turn_id,active,created_by,created_at").eq("agent_key", agent.agent_key).order("id"),
        admin.from("agent_improve").select("status").eq("agent_key", agent.agent_key),
      ]);
      const names = await nameMap(admin, ((mem.data || []) as { upn: string }[]).map((m) => m.upn));
      const impCnt: Record<string, number> = {};
      ((imp.data || []) as { status: string }[]).forEach((r) => { impCnt[r.status] = (impCnt[r.status] || 0) + 1; });
      return json({
        agent: await fullAgent(admin, agent.agent_key), role, me: { upn: scope.upn, name: scope.empNm },
        versions: vers.data || [],
        members: ((mem.data || []) as { upn: string }[]).map((m) => ({ ...m, name: names.get(m.upn) || null })),
        glossary: glo.data || [], golden: gold.data || [], improve_counts: impCnt,
        models: c.ai.models.map((m) => ({ model_id: m.model_id, vendor: m.vendor, label: m.label, active: m.active,
          price_in: m.price_in, price_out: m.price_out, usable: c.usable.has(m.model_id) })),
        vendors_ready: c.vendors,
        modules: c.modules.map((m) => ({ id: m.manifest.id, title_ko: m.manifest.title_ko, domain: m.manifest.domain, kind: m.manifest.kind,
          perm_module: m.manifest.perm_module, perm_ko: m.manifest.perm_module ? (MODULE_KO[m.manifest.perm_module] || m.manifest.perm_module) : "",
          perm_mode: m.manifest.perm_mode, sensitivity: m.manifest.sensitivity, status: m.manifest.status, summary_ko: m.manifest.summary_ko })),
        month_spend_usd: Number((await monthSpend(admin, agent.agent_key)).toFixed(4)),
      });
    }
    case "preview": {
      const v = await loadVersion(admin, agent.agent_key, Number(body.version) || null);
      if (!v) return json({ error: "버전 없음" }, 404);
      const { injected, denied } = pickModules(c, v, scope);
      const parts = agentPrompt(agent, v, injected.map((m) => m.manifest), await glossaryOf(admin, agent.agent_key), denied, todayKst());
      return json({ version: v.version, injected: injected.map((m) => m.manifest.id), denied, parts, chars: joinAgentPrompt(parts).length,
        model: resolveModel(c, v, false) });
    }
    case "version_save": {
      // 설정 저장 = 새 초안 버전(수정 대신 새 행). 기준 버전을 복사하고 바뀐 칸만 덮는다.
      const base = await loadVersion(admin, agent.agent_key, Number(body.base_version) || null);
      if (!base) return json({ error: "기준 버전 없음" }, 404);
      const f = (body.fields || {}) as Record<string, unknown>;
      const effort = ["low", "medium", "high", "xhigh", "max"].includes(String(f.effort)) ? String(f.effort) : (f.effort === null ? null : base.effort);
      const model = typeof f.model_id === "string" && c.ai.models.some((m) => m.model_id === f.model_id) ? f.model_id : base.model_id;
      const fb = f.fallback_model_id === null || f.fallback_model_id === "" ? null
        : typeof f.fallback_model_id === "string" && c.ai.models.some((m) => m.model_id === f.fallback_model_id) ? f.fallback_model_id : base.fallback_model_id;
      const mods = f.modules && typeof f.modules === "object" ? f.modules as { domains?: unknown; off?: unknown } : base.modules;
      const clampInt = (x: unknown, lo: number, hi: number, d: number) => { const n = Math.round(Number(x)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
      const { data: mx } = await admin.from("ai_agent_version").select("version").eq("agent_key", agent.agent_key).order("version", { ascending: false }).limit(1).maybeSingle();
      const row = {
        agent_key: agent.agent_key, version: (mx?.version || 0) + 1, state: "draft",
        model_id: model, fallback_model_id: fb, effort,
        max_tokens: f.max_tokens != null ? clampInt(f.max_tokens, 256, 16000, base.max_tokens) : base.max_tokens,
        temperature: f.temperature === null || f.temperature === "" ? null : f.temperature != null ? Math.min(1, Math.max(0, Number(f.temperature) || 0)) : base.temperature,
        prompt_caching: typeof f.prompt_caching === "boolean" ? f.prompt_caching : base.prompt_caching,
        role_prompt: f.role_prompt != null ? txt(f.role_prompt, 4000) : base.role_prompt,
        answer_rules: f.answer_rules != null ? txt(f.answer_rules, 6000) : base.answer_rules,
        modules: {
          domains: Array.isArray(mods.domains) ? (mods.domains as unknown[]).map(String).slice(0, 20) : (base.modules.domains || []),
          off: Array.isArray(mods.off) ? (mods.off as unknown[]).map(String).slice(0, 100) : (base.modules.off || []),
        },
        max_tool_rounds: f.max_tool_rounds != null ? clampInt(f.max_tool_rounds, 1, 8, base.max_tool_rounds) : base.max_tool_rounds,
        note: txt(f.note, 500) || `v${base.version} 기준 수정`, created_by: scope.upn,
      };
      const { data, error } = await admin.from("ai_agent_version").insert(row).select(VERSION_COLS).single();
      if (error) return json({ error: "저장 실패: " + error.message }, 500);
      // 개선 대장 항목을 이 버전으로 반영했다고 표시
      const imp = Array.isArray(body.improve_ids) ? (body.improve_ids as unknown[]).map(Number).filter(Boolean) : [];
      if (imp.length) await admin.from("agent_improve").update({ status: "applied", applied_version: row.version, updated_at: new Date().toISOString() })
        .eq("agent_key", agent.agent_key).in("id", imp);
      return json({ ok: true, version: data });
    }
    case "turns": {
      const days = Math.min(Math.max(Number(body.days) || 14, 1), 180);
      let q = admin.from("agent_turn")
        .select("id,agent_version,upn,dept_nm,created_at,question,answer,tools,model,fallback_used,prompt_tokens,completion_tokens,cache_read_tokens,est_cost_usd,latency_ms,rounds,flags,rating,rating_note")
        .eq("agent_key", agent.agent_key).is("golden_run_id", null)
        .gte("created_at", new Date(Date.now() - days * 86400_000).toISOString()).order("created_at", { ascending: false }).limit(500);
      if (body.only === "flagged") q = q.neq("flags", "{}");
      if (body.only === "down") q = q.eq("rating", -1);
      const { data } = await q;
      // deno-lint-ignore no-explicit-any
      const rows = (data || []) as any[];
      const names = await nameMap(admin, rows.map((r) => r.upn));
      return json({ items: rows.map((r) => ({ ...r, name: names.get(r.upn) || null })) });
    }
    case "improve_list": {
      const { data } = await admin.from("agent_improve").select("*").eq("agent_key", agent.agent_key)
        .order("status").order("created_at", { ascending: false }).limit(500);
      return json({ items: data || [] });
    }
    case "improve_save": {
      const f = (body.fields || {}) as Record<string, unknown>;
      const STS = ["inbox", "triage", "planned", "applied", "verified", "wontfix"];
      const CAT = ["prompt", "glossary", "new_module", "data_gap", "golden", "model", "none"];
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (typeof f.summary === "string") patch.summary = txt(f.summary, 300);
      if (typeof f.proposal === "string") patch.proposal = txt(f.proposal, 3000);
      if (f.category === null || CAT.includes(String(f.category))) patch.category = f.category;
      if (typeof f.req_id === "string") patch.req_id = txt(f.req_id, 20) || null;
      if (STS.includes(String(f.status))) {
        // 검증 완료(verified)·보류(wontfix) 확정은 관리자(reviewer)의 점검 몫이다
        if ((f.status === "verified") && !need(role, "reviewer")) return json({ error: "「검증 완료」는 관리자(검토자)가 확정합니다." }, 403);
        patch.status = f.status;
        if (f.status === "verified" || f.status === "wontfix") { patch.resolved_at = new Date().toISOString(); patch.reviewed_by = scope.upn; patch.reviewed_at = patch.resolved_at; }
      }
      if (body.id) {
        const { error } = await admin.from("agent_improve").update(patch).eq("agent_key", agent.agent_key).eq("id", Number(body.id));
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true });
      }
      const turnIds = Array.isArray(f.turn_ids) ? (f.turn_ids as unknown[]).map(Number).filter(Boolean).slice(0, 50) : [];
      const { data, error } = await admin.from("agent_improve").insert({ agent_key: agent.agent_key, source: "owner", turn_ids: turnIds,
        owner_upn: scope.upn, summary: patch.summary || "(요약 없음)", proposal: patch.proposal || null, category: patch.category || null,
        status: patch.status || "inbox" }).select("*").single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, item: data });
    }
    case "improve_cluster": return improveCluster(c, agent);
    case "glossary_save": {
      const term = txt(body.term, 60).trim(); const meaning = txt(body.meaning, 600).trim();
      if (!term || !meaning) return json({ error: "용어·뜻 필요" }, 400);
      const { error } = body.id
        ? await admin.from("agent_glossary").update({ term, meaning, active: body.active !== false }).eq("agent_key", agent.agent_key).eq("id", Number(body.id))
        : await admin.from("agent_glossary").insert({ agent_key: agent.agent_key, term, meaning, created_by: scope.upn });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    case "glossary_delete": {
      await admin.from("agent_glossary").delete().eq("agent_key", agent.agent_key).eq("id", Number(body.id));
      return json({ ok: true });
    }
    case "golden_save": {
      const q = txt(body.question, 800).trim();
      if (!q) return json({ error: "질문 필요" }, 400);
      const tools = Array.isArray(body.expect_tools) ? (body.expect_tools as unknown[]).map(String).filter((t) => c.modules.some((m) => m.manifest.id === t)) : [];
      const row = { question: q, expect_tools: tools, expect_rules: txt(body.expect_rules, 1000) || null, active: body.active !== false };
      const { error } = body.id
        ? await admin.from("agent_golden").update(row).eq("agent_key", agent.agent_key).eq("id", Number(body.id))
        : await admin.from("agent_golden").insert({ ...row, agent_key: agent.agent_key, source_turn_id: Number(body.source_turn_id) || null, created_by: scope.upn });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    case "golden_delete": {
      await admin.from("agent_golden").delete().eq("agent_key", agent.agent_key).eq("id", Number(body.id));
      return json({ ok: true });
    }
    case "golden_start": {
      const v = await loadVersion(admin, agent.agent_key, Number(body.version) || null);
      if (!v) return json({ error: "버전 없음" }, 404);
      const { data: g } = await admin.from("agent_golden").select("id").eq("agent_key", agent.agent_key).eq("active", true).order("id");
      const ids = ((g || []) as { id: number }[]).map((x) => x.id);
      if (!ids.length) return json({ error: "활성 골든셋 문항이 없습니다." }, 400);
      const { data: run, error } = await admin.from("agent_golden_run").insert({ agent_key: agent.agent_key, version: v.version,
        started_by: scope.upn, total: ids.length }).select("id").single();
      if (error) return json({ error: error.message }, 500);
      return json({ run_id: run.id, version: v.version, golden_ids: ids });
    }
    case "golden_one": return goldenOne(c, agent, body);
    case "golden_finish": {
      const { data: run } = await admin.from("agent_golden_run").select("id,version,results").eq("id", Number(body.run_id)).eq("agent_key", agent.agent_key).maybeSingle();
      if (!run) return json({ error: "실행 기록 없음" }, 404);
      const res = (run.results || []) as { pass: boolean; cost: number }[];
      const pass = res.filter((r) => r.pass).length; const cost = res.reduce((n, r) => n + (Number(r.cost) || 0), 0);
      const now = new Date().toISOString();
      await admin.from("agent_golden_run").update({ finished_at: now, pass, total: res.length, cost_usd: cost }).eq("id", run.id);
      await admin.from("ai_agent_version").update({ golden_pass: pass, golden_total: res.length, golden_run_at: now })
        .eq("agent_key", agent.agent_key).eq("version", run.version);
      return json({ ok: true, pass, total: res.length, cost_usd: Number(cost.toFixed(4)) });
    }
    case "golden_runs": {
      // 회귀 실행 기록(REQ-0106) — 사용 화면 「🧪 검증·테스트」 탭이 읽는다. 최근 10회 요약 + 그중 한 회차의 문항별 결과.
      const { data: runs } = await admin.from("agent_golden_run").select("id,version,started_by,started_at,finished_at,pass,total,cost_usd")
        .eq("agent_key", agent.agent_key).order("id", { ascending: false }).limit(10);
      // deno-lint-ignore no-explicit-any
      const list = (runs || []) as any[];
      const pick = Number(body.run_id) || (list.find((r) => r.finished_at) || list[0] || {}).id || null;
      let results: unknown[] = [];
      if (pick) {
        const { data: one } = await admin.from("agent_golden_run").select("results").eq("id", pick).eq("agent_key", agent.agent_key).maybeSingle();
        // deno-lint-ignore no-explicit-any
        results = (((one && one.results) || []) as any[]).map((r) => ({ ...r, answer: String(r.answer || "").slice(0, 400) }))
          .sort((a, b) => Number(a.golden_id) - Number(b.golden_id));
      }
      const { count } = await admin.from("agent_golden").select("id", { count: "exact", head: true }).eq("agent_key", agent.agent_key).eq("active", true);
      return json({ runs: list, run_id: pick, results, golden_active: count || 0, current_version: agent.current_version ?? null });
    }
    case "usage": return usage(c, agent, Number(body.days) || 30);
  }

  /* ───── 관리자(reviewer) — 확인·점검·승인 ───── */
  if (!need(role, "reviewer")) return json({ error: "forbidden: 관리자(검토자)만 할 수 있습니다." }, 403);
  switch (op) {
    case "version_promote": {
      const v = await loadVersion(admin, agent.agent_key, Number(body.version));
      if (!v) return json({ error: "버전 없음" }, 404);
      if (v.state === "current") return json({ ok: true, unchanged: true });
      const now = new Date().toISOString();
      await admin.from("ai_agent_version").update({ state: "retired" }).eq("agent_key", agent.agent_key).eq("state", "current");
      const { error } = await admin.from("ai_agent_version").update({ state: "current", approved_by: scope.upn, approved_at: now })
        .eq("agent_key", agent.agent_key).eq("version", v.version);
      if (error) return json({ error: error.message }, 500);
      await admin.from("ai_agent").update({ current_version: v.version, updated_by: scope.upn, updated_at: now }).eq("agent_key", agent.agent_key);
      return json({ ok: true, version: v.version });
    }
    case "agent_update": {
      const f = (body.fields || {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = { updated_by: scope.upn, updated_at: new Date().toISOString() };
      if (["dev", "pilot", "live", "off"].includes(String(f.status))) patch.status = f.status;
      if (f.daily_limit != null) patch.daily_limit = Math.min(1000, Math.max(1, Math.round(Number(f.daily_limit)) || 50));
      if (f.monthly_budget_usd != null) patch.monthly_budget_usd = Math.min(10000, Math.max(0, Number(f.monthly_budget_usd) || 0));
      if (typeof f.collect_turns === "boolean") patch.collect_turns = f.collect_turns;
      if (f.retention_days != null) patch.retention_days = Math.min(730, Math.max(30, Math.round(Number(f.retention_days)) || 180));
      if (Array.isArray(f.suggestions)) patch.suggestions = (f.suggestions as { label?: unknown; q?: unknown }[]).slice(0, 12)
        .map((s) => ({ label: txt(s.label, 30), q: txt(s.q, 300) })).filter((s) => s.label && s.q);
      if (typeof f.summary_ko === "string") patch.summary_ko = txt(f.summary_ko, 200);
      const { error } = await admin.from("ai_agent").update(patch).eq("agent_key", agent.agent_key);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, agent: await fullAgent(admin, agent.agent_key) });
    }
    case "member_set": {
      const upn = String(body.upn || "").trim().toLowerCase();
      if (!/^[a-z0-9._-]+@jeilm\.co\.kr$/.test(upn)) return json({ error: "사내 계정(@jeilm.co.kr)을 입력하세요." }, 400);
      if (body.role === null || body.role === "") {
        if (upn === scope.upn) return json({ error: "본인은 뺄 수 없습니다(다른 관리자가 처리)." }, 400);
        await admin.from("ai_agent_member").delete().eq("agent_key", agent.agent_key).eq("upn", upn);
        return json({ ok: true });
      }
      if (!["operator", "reviewer"].includes(String(body.role))) return json({ error: "role 은 operator|reviewer" }, 400);
      const { error } = await admin.from("ai_agent_member").upsert({ agent_key: agent.agent_key, upn, role: body.role, added_by: scope.upn });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
  }
  return json({ error: `알 수 없는 op: ${op}` }, 400);
}

/* ───────────────────────── 대화(SSE) ───────────────────────── */
async function chat(c: AgentCtx, agent: AgentRow, role: AgentRole, body: Record<string, unknown>): Promise<Response> {
  const { admin, json, scope, req } = c;
  // 시험 대화: 담당자 이상은 초안 버전으로 대화해 볼 수 있다(턴은 그 버전으로 기록)
  const wantVer = Number(body.version) || null;
  if (wantVer && !need(role, "operator")) return json({ error: "버전 지정 대화는 담당자만 할 수 있습니다." }, 403);
  const v = await loadVersion(admin, agent.agent_key, wantVer);
  if (!v) return json({ error: "에이전트 설정 버전이 없습니다." }, 503);

  const raw = Array.isArray(body.messages) ? body.messages : [];
  const windowed: ChatMsg[] = raw
    // deno-lint-ignore no-explicit-any
    .filter((m: any) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-c.ai.max_messages)
    // deno-lint-ignore no-explicit-any
    .map((m: any) => (m.role === "user" && Array.isArray(m.attachments) && m.attachments.length
      ? { role: "user" as const, content: m.content.slice(0, MAX_MSG_CHARS), parts: m.attachments as unknown as Attachment[] }
      : { role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));
  // 창(max_messages)이 짝수라 10왕복을 넘으면 첫 메시지가 assistant 가 된다 — Anthropic 은 user 로 시작해야 400 이 안 난다(09-30 실측 잠재 결함)
  const firstUser = windowed.findIndex((m) => m.role === "user");
  const messages: ChatMsg[] = firstUser > 0 ? windowed.slice(firstUser) : windowed;
  if (!messages.length || messages[messages.length - 1].role !== "user") return json({ error: "마지막 메시지는 사용자 질문이어야 합니다." }, 400);
  const att = checkAttachments(messages);
  if (att.error) return json({ error: att.error }, 400);
  const total = messages.reduce((n, m) => n + ("content" in m ? String(m.content).length : 0), 0);
  if (total > c.ai.max_total_chars) return json({ error: "대화가 너무 깁니다. 새 대화로 시작하세요." }, 400);

  // 1인 1일 한도(시험 대화 제외)
  if (!wantVer) {
    const { count } = await admin.from("agent_turn").select("id", { count: "exact", head: true })
      .eq("agent_key", agent.agent_key).eq("upn", scope.upn).is("golden_run_id", null).gte("created_at", dayStart());
    if ((count || 0) >= agent.daily_limit) return json({ error: `오늘 질문 한도(${agent.daily_limit}회)를 다 썼습니다. 내일 다시 이용해 주세요.` }, 429);
  }
  const spend = await monthSpend(admin, agent.agent_key);
  const overBudget = agent.monthly_budget_usd > 0 && spend >= Number(agent.monthly_budget_usd);
  const rm = resolveModel(c, v, overBudget);
  if (!rm.model) return json({ error: "AI 연결이 아직 설정되지 않았습니다(관리자 확인 필요)." }, 503);

  const { injected, denied } = pickModules(c, v, scope);
  const parts = agentPrompt(agent, v, injected.map((m) => m.manifest), await glossaryOf(admin, agent.agent_key), denied, todayKst());
  const system = joinAgentPrompt(parts);
  const question = String((messages[messages.length - 1] as { content: string }).content);
  // 보고서 해설 요청은 화면이 카드 표를 질문에 붙여 보낸다 — 기록에는 표를 남기지 않는다(조회 결과 행 미저장 원칙, SQL 74 머리말)
  const REPORT_HEAD = "아래 조회 결과로 보고용 해설을 써줘";
  const qStore = question.startsWith(REPORT_HEAD)
    ? question.split("\n").slice(0, 2).join("\n") + "\n(첨부 표 데이터는 기록하지 않음)" : question;

  let logId: number | null = null;
  try {
    const { data } = await admin.from("chat_log").insert({ upn: scope.upn, model: rm.model, messages_count: messages.length, prompt_chars: total, session_id: null })
      .select("id").single();
    logId = data?.id ?? null;
  } catch { /* 로그 실패는 무시 */ }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const upstream = new AbortController();
  let gone = false;
  const onGone = () => { gone = true; try { upstream.abort(); } catch { /* 무시 */ } };
  try { req.signal?.addEventListener("abort", onGone); } catch { /* 무시 */ }
  const send = (o: unknown) => writer.write(enc.encode("data: " + JSON.stringify(o) + "\n\n")).catch(() => onGone());
  const t0 = Date.now();

  const run = (async () => {
    let res: Awaited<ReturnType<typeof converse>> | null = null;
    let stopped = false;
    try {
      await send({ jeilax_agent: { type: "start", version: v.version, model: rm.model, note: rm.reason } });
      res = await converse({
        admin, userToken: c.token, scope, model: rm.model!, vendorOf: vendorOf(c.ai), fallbackModel: rm.fallback,
        modules: injected, system, messages, maxTokens: v.max_tokens, temperature: v.temperature, effort: v.effort,
        caching: v.prompt_caching, maxRounds: v.max_tool_rounds, signal: upstream.signal, isGone: () => gone,
        emit: (t) => send({ choices: [{ delta: { content: t } }] }),
        onView: async (view) => { const p = JSON.stringify({ jeilax: view }); if (p.length <= 16000) await send({ jeilax: view }); },
        // 담당자 이상에게만 도구 추적을 보낸다(일반 사용자 화면에는 자세한 내용을 보이지 않는다)
        onTool: need(role, "operator") ? (t) => send({ jeilax_agent: { type: "tool", tool: t.tool, args: t.args, ms: t.ms, outcome: t.outcome, rows: t.rows } }) : undefined,
        onNote: need(role, "operator") ? (n) => send({ jeilax_agent: { ...n } }) : undefined,
      });
      stopped = res.stopped;
    } catch (e) {
      if (gone || (e instanceof Error && e.name === "AbortError")) stopped = true;
      else { try { await send({ choices: [{ delta: { content: "⚠ 오류: " + (e instanceof Error ? e.message : String(e)) } }] }); } catch { /* 종료 */ } }
    } finally {
      const st = res?.state || { pt: 0, ct: 0, cr: 0, cw: 0, toolCalls: {} };
      const model = res?.model || rm.model!;
      const cost = costOf(model, c.ai, st);
      const latency = Date.now() - t0;
      const tools = (res?.tools || []).map((t) => ({ tool: t.tool, args: t.args, ms: t.ms, outcome: t.outcome, rows: t.rows, sensitivity: t.sensitivity }));
      const personal = tools.some((t) => t.sensitivity === "personal");
      const flags = turnFlags({ tools, answer: res?.answer || "", latency_ms: latency, stop: st.stop, toolCount: tools.length });
      if (overBudget) flags.push("budget_fallback");
      if (res?.llmError) flags.push("llm_error");
      // 벤더 오류 본문을 턴 기록에 남긴다(도구 목록에 `_llm` 항목으로 — 스키마 변경 없이). 판정(flags)을 낸 뒤에 넣어 tool_error 로 오판되지 않게.
      const toolsStored: Record<string, unknown>[] = [...tools];
      if (res?.fallbackNote) toolsStored.push({ tool: "_llm", args: { from: res.fallbackNote.from, to: res.fallbackNote.to }, ms: 0, outcome: "fallback", rows: null, sensitivity: null, status: res.fallbackNote.status, detail: res.fallbackNote.detail });
      if (res?.llmError) toolsStored.push({ tool: "_llm", args: { model }, ms: 0, outcome: "error", rows: null, sensitivity: null, status: res.llmError.status, detail: res.llmError.detail.slice(0, 300) });
      let turnId: number | null = null;
      if (agent.collect_turns) {
        try {
          const { data } = await admin.from("agent_turn").insert({
            agent_key: agent.agent_key, agent_version: v.version, upn: scope.upn, dept_nm: scope.dept, question: qStore.slice(0, 4000),
            attachments: att.meta,   // 이번 질문에 붙은 파일의 이름·종류·크기만(원본·내용은 저장하지 않는다)
            answer: personal ? null : (res?.answer || "").slice(0, 20000), tools: toolsStored, model, fallback_used: !!res?.fallbackUsed,
            prompt_tokens: st.pt || null, completion_tokens: st.ct || null, cache_read_tokens: st.cr || null,
            est_cost_usd: Number(cost.toFixed(6)), latency_ms: latency, rounds: res?.rounds || 0, flags, chat_log_id: logId,
          }).select("id").single();
          turnId = data?.id ?? null;
          // 자동 판정에 걸린 턴은 개선 대장 inbox 로(시험 대화 제외) — 👎 는 사용자가 누를 때 따로 올라간다
          const auto = flags.filter((f) => ["tool_error", "zero_rows", "perm_denied", "no_tool", "refusal", "llm_error"].includes(f));
          if (turnId && auto.length && !wantVer) {
            await admin.from("agent_improve").insert({ agent_key: agent.agent_key, source: "auto", turn_ids: [turnId],
              summary: `[${auto.join(",")}] ${qStore.slice(0, 120)}` });
          }
        } catch (e) { console.error("agent_turn insert", e); }
      }
      if (turnId) await send({ jeilax_agent: { type: "end", turn_id: turnId, model, fallback: !!res?.fallbackUsed, ms: latency,
        ...(need(role, "operator") ? { pt: st.pt, ct: st.ct, cr: st.cr, est_cost_usd: Number(cost.toFixed(6)), flags } : {}) } });
      try { req.signal?.removeEventListener("abort", onGone); } catch { /* 무시 */ }
      try { await writer.write(enc.encode("data: [DONE]\n\n")); } catch { /* 무시 */ }
      try { await writer.close(); } catch { /* 무시 */ }
      if (logId != null) {
        try {
          await admin.from("chat_log").update({ model, prompt_tokens: st.pt || null, completion_tokens: st.ct || null,
            est_cost_usd: st.pt || st.ct ? Number(cost.toFixed(6)) : null, tools_used: tools.length ? tools.map((t) => t.tool) : null, stopped,
          }).eq("id", logId);
        } catch { /* 무시 */ }
      }
    }
  })();
  // @ts-ignore: Supabase Edge Runtime
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(run);
  return new Response(readable, { headers: { ...c.cors, "Content-Type": "text/event-stream", "x-model": rm.model } });
}

/* ───────────────────────── 골든셋 1문항 ───────────────────────── */
async function goldenOne(c: AgentCtx, agent: AgentRow, body: Record<string, unknown>): Promise<Response> {
  const { admin, json, scope } = c;
  const { data: run } = await admin.from("agent_golden_run").select("id,version,results,finished_at").eq("id", Number(body.run_id)).eq("agent_key", agent.agent_key).maybeSingle();
  if (!run || run.finished_at) return json({ error: "진행 중인 실행이 아닙니다." }, 400);
  const { data: g } = await admin.from("agent_golden").select("id,question,expect_tools,expect_rules").eq("id", Number(body.golden_id)).eq("agent_key", agent.agent_key).maybeSingle();
  if (!g) return json({ error: "문항 없음" }, 404);
  const v = await loadVersion(admin, agent.agent_key, run.version);
  if (!v) return json({ error: "버전 없음" }, 404);
  const rm = resolveModel(c, v, false);
  if (!rm.model) return json({ error: "호출 가능한 모델이 없습니다." }, 503);
  const { injected, denied } = pickModules(c, v, scope);
  const system = joinAgentPrompt(agentPrompt(agent, v, injected.map((m) => m.manifest), await glossaryOf(admin, agent.agent_key), denied, todayKst()));
  const t0 = Date.now();
  const res = await converse({ admin, userToken: c.token, scope, model: rm.model, vendorOf: vendorOf(c.ai), fallbackModel: rm.fallback,
    modules: injected, system, messages: [{ role: "user", content: g.question }], maxTokens: v.max_tokens, temperature: v.temperature,
    effort: v.effort, caching: v.prompt_caching, maxRounds: v.max_tool_rounds });
  const called = [...new Set(res.tools.map((t) => t.tool))];
  const expect = (g.expect_tools || []) as string[];
  const toolsOk = expect.every((t) => called.includes(t));
  let judge: { pass: boolean; why: string; cost: number } = { pass: true, why: "요건 없음", cost: 0 };
  if (g.expect_rules && !res.llmError) judge = await judgeAnswer(c, g.question, g.expect_rules, res.answer);
  const pass = !res.llmError && toolsOk && judge.pass;
  const cost = costOf(res.model, c.ai, res.state) + judge.cost;
  const item = { golden_id: g.id, question: g.question, pass, tools_ok: toolsOk, called, expect, judge: judge.pass, why: judge.why,
    answer: res.answer.slice(0, 1500), model: res.model, ms: Date.now() - t0, cost: Number(cost.toFixed(6)) };
  const results = [...((run.results || []) as unknown[]).filter((r) => (r as { golden_id: number }).golden_id !== g.id), item];
  await admin.from("agent_golden_run").update({ results }).eq("id", run.id);
  await admin.from("agent_turn").insert({ agent_key: agent.agent_key, agent_version: v.version, upn: scope.upn, dept_nm: scope.dept,
    question: g.question, answer: res.answer.slice(0, 20000), tools: res.tools.map((t) => ({ tool: t.tool, args: t.args, ms: t.ms, outcome: t.outcome, rows: t.rows })),
    model: res.model, fallback_used: res.fallbackUsed, prompt_tokens: res.state.pt || null, completion_tokens: res.state.ct || null,
    cache_read_tokens: res.state.cr || null, est_cost_usd: Number(cost.toFixed(6)), latency_ms: item.ms, rounds: res.rounds,
    flags: pass ? [] : ["golden_fail"], golden_run_id: run.id });
  return json({ ok: true, result: item });
}

/** 저렴한 모델로 답변이 요건을 지켰는지 채점(JSON 한 줄). Haiku(키 있을 때) → gpt-4o-mini 순. */
async function judgeAnswer(c: AgentCtx, question: string, rules: string, answer: string): Promise<{ pass: boolean; why: string; cost: number }> {
  const judgeModel = JUDGE_MODELS.find((m) => c.usable.has(m));
  if (!judgeModel) return { pass: true, why: "채점 모델 없음 — 도구 판정만", cost: 0 };
  const res = await converse({ admin: c.admin, userToken: c.token, scope: c.scope, model: judgeModel, vendorOf: vendorOf(c.ai), modules: [],
    system: "당신은 사내 AI 답변 채점자입니다. 답변이 요건을 모두 지켰는지 판정하고 JSON 한 줄만 출력하세요: {\"pass\":true|false,\"why\":\"한 문장\"}",
    messages: [{ role: "user", content: `질문: ${question}\n\n요건:\n${rules}\n\n답변:\n${answer.slice(0, 6000)}` }],
    maxTokens: 300, temperature: 0, effort: null, caching: false, maxRounds: 1 });
  const cost = costOf(res.model, c.ai, res.state);
  const m = /\{[\s\S]*\}/.exec(res.answer);
  try { const j = JSON.parse(m ? m[0] : "{}"); return { pass: !!j.pass, why: String(j.why || "").slice(0, 300), cost }; }
  catch { return { pass: false, why: "채점 응답 해석 실패: " + res.answer.slice(0, 120), cost }; }
}

/* ───────────────────────── 개선 대장 AI 묶기 ───────────────────────── */
async function improveCluster(c: AgentCtx, agent: AgentRow): Promise<Response> {
  const { admin, json } = c;
  const { data } = await admin.from("agent_improve").select("id,summary,proposal,source,turn_ids").eq("agent_key", agent.agent_key).eq("status", "inbox").order("id").limit(80);
  // deno-lint-ignore no-explicit-any
  const items = (data || []) as any[];
  if (items.length < 2) return json({ error: "묶을 inbox 항목이 2건 이상 필요합니다." }, 400);
  const model = JUDGE_MODELS.find((m) => c.usable.has(m));
  if (!model) return json({ error: "분류용 모델이 없습니다." }, 503);
  const res = await converse({ admin, userToken: c.token, scope: c.scope, model, vendorOf: vendorOf(c.ai), modules: [],
    system: "당신은 사내 AI 에이전트 개선 담당자를 돕습니다. 개선 후보 목록을 비슷한 원인끼리 묶고 각 묶음의 분류를 제안합니다. " +
      "분류: prompt(프롬프트 문구) · glossary(용어집) · new_module(새 조회 기능 필요) · data_gap(ERP 데이터 미적재) · golden(좋은 예시) · model(모델 한계) · none(조치 불필요). " +
      "JSON 배열만 출력: [{\"ids\":[번호...],\"category\":\"…\",\"summary\":\"묶음 한 줄 요약\",\"proposal\":\"조치 제안 한두 문장\"}]",
    messages: [{ role: "user", content: items.map((i) => `#${i.id} (${i.source}) ${i.summary}${i.proposal ? " / " + i.proposal : ""}`).join("\n") }],
    maxTokens: 2000, temperature: 0, effort: null, caching: false, maxRounds: 1 });
  const m = /\[[\s\S]*\]/.exec(res.answer);
  let groups: { ids: number[]; category: string; summary: string; proposal: string }[] = [];
  try { groups = JSON.parse(m ? m[0] : "[]"); } catch { return json({ error: "분류 응답 해석 실패", raw: res.answer.slice(0, 500) }, 502); }
  const valid = new Map(items.map((i) => [Number(i.id), i]));
  const CAT = ["prompt", "glossary", "new_module", "data_gap", "golden", "model", "none"];
  let made = 0;
  for (const g of groups) {
    const ids = (g.ids || []).map(Number).filter((id) => valid.has(id));
    if (!ids.length) continue;
    const turns = [...new Set(ids.flatMap((id) => (valid.get(id).turn_ids || []) as number[]))];
    // 여러 건이면 새 묶음 1건을 triage 로 만들고 원래 항목은 wontfix(묶음으로 이관)
    if (ids.length > 1) {
      await admin.from("agent_improve").insert({ agent_key: agent.agent_key, source: "auto", status: "triage", turn_ids: turns,
        category: CAT.includes(g.category) ? g.category : null, summary: `[묶음 ${ids.length}건] ${String(g.summary || "").slice(0, 200)}`,
        proposal: String(g.proposal || "").slice(0, 1000) });
      await admin.from("agent_improve").update({ status: "wontfix", proposal: `묶음으로 이관(AI 분류)`, resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString() }).in("id", ids);
    } else {
      await admin.from("agent_improve").update({ status: "triage", category: CAT.includes(g.category) ? g.category : null,
        proposal: String(g.proposal || "").slice(0, 1000), updated_at: new Date().toISOString() }).eq("id", ids[0]);
    }
    made++;
  }
  return json({ ok: true, groups: made, model, cost_usd: Number(costOf(res.model, c.ai, res.state).toFixed(5)) });
}

/* ───────────────────────── 사용량 ───────────────────────── */
async function usage(c: AgentCtx, agent: AgentRow, days: number): Promise<Response> {
  const d = Math.min(Math.max(days, 1), 180);
  const { data } = await c.admin.from("agent_turn")
    .select("created_at,upn,agent_version,model,est_cost_usd,latency_ms,rating,flags,fallback_used,cache_read_tokens,prompt_tokens")
    .eq("agent_key", agent.agent_key).is("golden_run_id", null)
    .gte("created_at", new Date(Date.now() - d * 86400_000).toISOString()).limit(20000);
  // deno-lint-ignore no-explicit-any
  const rows = (data || []) as any[];
  const byDay: Record<string, { n: number; cost: number }> = {};
  const byVer: Record<string, { n: number; up: number; down: number; flagged: number; cost: number; ms: number }> = {};
  const users = new Set<string>();
  const flagCnt: Record<string, number> = {};
  let cost = 0, up = 0, down = 0, cacheRead = 0, prompt = 0, fb = 0;
  for (const r of rows) {
    const day = new Date(new Date(r.created_at).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
    const cst = Number(r.est_cost_usd) || 0;
    (byDay[day] = byDay[day] || { n: 0, cost: 0 }).n++; byDay[day].cost += cst;
    const vk = "v" + r.agent_version;
    const bv = (byVer[vk] = byVer[vk] || { n: 0, up: 0, down: 0, flagged: 0, cost: 0, ms: 0 });
    bv.n++; bv.cost += cst; bv.ms += Number(r.latency_ms) || 0;
    if (r.rating === 1) { up++; bv.up++; } if (r.rating === -1) { down++; bv.down++; }
    if ((r.flags || []).length) bv.flagged++;
    (r.flags || []).forEach((f: string) => { flagCnt[f] = (flagCnt[f] || 0) + 1; });
    users.add(r.upn); cost += cst; cacheRead += Number(r.cache_read_tokens) || 0; prompt += Number(r.prompt_tokens) || 0;
    if (r.fallback_used) fb++;
  }
  const spend = await monthSpend(c.admin, agent.agent_key);
  return c.json({
    days: d, turns: rows.length, users: users.size, cost_usd: Number(cost.toFixed(4)), up, down, fallback: fb,
    cache_hit_ratio: cacheRead + prompt ? Number((cacheRead / (cacheRead + prompt)).toFixed(3)) : null,
    flags: flagCnt,
    by_day: Object.keys(byDay).sort().map((k) => ({ day: k, n: byDay[k].n, cost: Number(byDay[k].cost.toFixed(4)) })),
    by_version: Object.keys(byVer).sort().map((k) => ({ version: k, ...byVer[k], cost: Number(byVer[k].cost.toFixed(4)), avg_ms: Math.round(byVer[k].ms / byVer[k].n) })),
    month: { spend_usd: Number(spend.toFixed(4)), budget_usd: Number(agent.monthly_budget_usd), ratio: agent.monthly_budget_usd ? Number((spend / Number(agent.monthly_budget_usd)).toFixed(3)) : null },
  });
}

/* ───────────────────────── 보조 ───────────────────────── */
// deno-lint-ignore no-explicit-any
async function fullAgent(admin: any, key: string) {
  const { data } = await admin.from("ai_agent").select(AGENT_COLS + ",updated_by,updated_at").eq("agent_key", key).maybeSingle();
  return data;
}
// deno-lint-ignore no-explicit-any
async function nameMap(admin: any, upns: string[]): Promise<Map<string, string>> {
  const u = [...new Set(upns.filter(Boolean))];
  if (!u.length) return new Map();
  const { data } = await admin.from("v_erp_user_dept").select("email,emp_nm,dept_nm").in("email", u);
  // deno-lint-ignore no-explicit-any
  return new Map(((data || []) as any[]).map((r) => [String(r.email).toLowerCase(), `${r.dept_nm || ""} ${r.emp_nm || ""}`.trim()]));
}
/** 보존기간 지난 턴 정리(관리 화면 열 때) — 골든셋·개선 대장이 참조하는 턴 번호는 남지만 원문은 지워진다. */
async function cleanupTurns(c: AgentCtx, agent: AgentRow) {
  try {
    await c.admin.from("agent_turn").delete().eq("agent_key", agent.agent_key)
      .lt("created_at", new Date(Date.now() - agent.retention_days * 86400_000).toISOString());
  } catch { /* 무시 */ }
}
/** 만료(30일) 자료 정리 — 본인 것만. */
async function cleanupArtifacts(c: AgentCtx, upn: string) {
  try {
    const { data } = await c.admin.from("agent_artifact").select("id,storage_path").eq("upn", upn).lt("expires_at", new Date().toISOString()).limit(100);
    // deno-lint-ignore no-explicit-any
    const rows = (data || []) as any[];
    if (!rows.length) return;
    await c.admin.storage.from(BUCKET).remove(rows.map((r) => r.storage_path));
    await c.admin.from("agent_artifact").delete().in("id", rows.map((r) => r.id));
  } catch { /* 무시 */ }
}
