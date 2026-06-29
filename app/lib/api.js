// app/lib/api.js — 데이터 접근 단일 진입점 (CLAUDE.md §3.3)
// 화면은 portalApi / authApi 만 호출한다. 내부 구현(supabase↔mock↔azure)을
// 여기 한 곳에서 교체하므로, Azure 전환 시 화면 코드는 건드리지 않는다.
//
// 반환 형태는 기존 데모 화면(협력사_모바일_포털.html)의 orders 구조에 맞춘다:
//   { no, date, due, type, status, inspReqNo, items[], photos[], msgs[], bp }
import { DATA_BACKEND } from "../config.js";
import { supabase } from "./supabaseClient.js";

// status ↔ step 매핑(02 문서 상태머신 단순화)
const STEP = { new: 4, prod: 5, insp: 7, done: 10 };
const fmt = (ts) => (ts ? new Date(ts).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const _bp = {}; // po_no -> bp_cd 캐시 (쓰기 시 격리 키 재사용)

/* ===================== Supabase 어댑터 ===================== */
const supabaseAdapter = {
  // ---- 인증 (협력사: 이메일/비번. 사내 Entra OIDC는 C′단계에서 추가) ----
  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.user;
  },
  async signOut() { return supabase.auth.signOut(); },
  async currentUser() { const { data } = await supabase.auth.getUser(); return data.user; },
  onAuthChange(cb) { return supabase.auth.onAuthStateChange((_e, s) => cb(s?.user || null)); },

  // ---- 발주 목록 (RLS가 자동 격리: 협력사는 자기 bp_cd만) ----
  async getOrders() {
    const { data: heads, error } = await supabase
      .from("sp_order_header")
      .select("po_no,bp_cd,vendor_name,order_date,due_date,po_type,project_code,amt,items")
      .order("order_date", { ascending: false });
    if (error) throw error;
    if (!heads.length) return [];
    const pos = heads.map((h) => h.po_no);
    heads.forEach((h) => (_bp[h.po_no] = h.bp_cd));

    const [states, photos, msgs, insps, inspections] = await Promise.all([
      supabase.from("sp_order_state").select("*").in("po_no", pos),
      supabase.from("sp_photo").select("*").in("po_no", pos).order("created_at"),
      supabase.from("sp_message").select("*").in("po_no", pos).order("created_at"),
      supabase.from("sp_insp_request").select("*").in("po_no", pos).eq("cancelled", false),
      supabase.from("sp_inspection").select("*").in("po_no", pos),
    ]);
    const group = (res) => {
      const m = {}; (res.data || []).forEach((r) => (m[r.po_no] = m[r.po_no] || []).push(r)); return m;
    };
    const ph = group(photos), mg = group(msgs), ir = group(insps);
    const st = {}; (states.data || []).forEach((s) => (st[s.po_no] = s));
    const iq = {}; (inspections.data || []).forEach((r) => (iq[r.po_no] = r));

    return heads.map((h) => ({
      no: h.po_no,
      bp: h.bp_cd,
      vendor_name: h.vendor_name || h.bp_cd,
      proj: h.project_code || "-",
      amt: h.amt || 0,
      date: h.order_date,
      due: h.due_date,
      type: h.po_type,
      status: st[h.po_no]?.status || "new",
      inspReqNo: ir[h.po_no]?.[0]?.insp_req_no || "",
      inspection: iq[h.po_no] ? { result: iq[h.po_no].result, resultNo: iq[h.po_no].result_no, by: iq[h.po_no].judge_id, at: iq[h.po_no].judged_at, comment: iq[h.po_no].opinion } : null,
      items: h.items || [],
      photos: (ph[h.po_no] || []).map((p) => ({
        storage_path: p.storage_path, tag: p.tag, cmt: p.comment,
        by: p.uploaded_by, t: fmt(p.created_at), chk: p.confirmed ? "ok" : "",
      })),
      msgs: (mg[h.po_no] || []).map((m) => ({
        who: m.sender_role === "supplier" ? "me" : "them",
        name: m.sender_name || "", text: m.body, t: fmt(m.created_at),
      })),
    }));
  },

  // ---- 협력사 진행상태 변경 ----
  async updateStatus(po, status) {
    const { error } = await supabase.from("sp_order_state")
      .upsert({ po_no: po, bp_cd: _bp[po], status, step: STEP[status] || 4, updated_at: new Date().toISOString() });
    if (error) throw error;
  },

  // ---- 검수요청 생성 (IR+YYYYMMDD+seq) ----
  async requestInspection(po) {
    const no = "IR" + po.slice(2);
    const { error } = await supabase.from("sp_insp_request")
      .insert({ po_no: po, bp_cd: _bp[po], insp_req_no: no, requested_by: (await this.currentUser())?.email || "vendor" });
    if (error) throw error;
    await this.updateStatus(po, "insp");
    return no;
  },

  // ---- 양방향 메시지 ----
  async sendMessage(po, text, role = "supplier", name = "") {
    const { error } = await supabase.from("sp_message")
      .insert({ po_no: po, bp_cd: _bp[po], sender_role: role, sender_id: (await this.currentUser())?.email || role, sender_name: name, body: text });
    if (error) throw error;
  },

  // ---- 검수 판정 (사내 전용. 협력사 토큰으론 RLS가 차단) ----
  async judge(po, result, opinion, judgeId) {
    const no = "IQ" + po.slice(2);
    await supabase.from("sp_inspection").upsert({ po_no: po, bp_cd: _bp[po], result, result_no: no, judge_id: judgeId, opinion });
    await supabase.from("sp_inspection_log").insert({ po_no: po, bp_cd: _bp[po], result, judge_id: judgeId, opinion });
  },

  // ---- 사진 업로드 (Storage + 메타) ----
  async uploadPhoto(po, file, meta = {}) {
    const path = `${_bp[po]}/${po}/${Date.now()}_${file.name}`;
    const up = await supabase.storage.from("vendor-photos").upload(path, file);
    if (up.error) throw up.error;
    const { error } = await supabase.from("sp_photo")
      .insert({ po_no: po, bp_cd: _bp[po], storage_path: path, tag: meta.tag || "작업", comment: meta.cmt || "", uploaded_by: (await this.currentUser())?.email || "vendor" });
    if (error) throw error;
    return path;
  },
  async photoUrl(path) {
    const { data } = await supabase.storage.from("vendor-photos").createSignedUrl(path, 60 * 10);
    return data?.signedUrl || "";
  },

  // ---- Realtime 구독 (양방향 즉시 반영) ----
  subscribe(onChange) {
    const ch = supabase.channel("portal-sync");
    ["sp_order_state", "sp_photo", "sp_message", "sp_insp_request", "sp_inspection"].forEach((t) =>
      ch.on("postgres_changes", { event: "*", schema: "public", table: t }, (p) => onChange(t, p))
    );
    ch.subscribe();
    return () => supabase.removeChannel(ch);
  },
};

/* ===================== Mock 어댑터 (오프라인 데모 fallback) ===================== */
// 기존 localStorage 'jeilax_link_v1' 기반. 데모 한정 — 운영 미사용.
const mockAdapter = {
  async signIn() { return { email: "demo@local" }; },
  async signOut() {}, async currentUser() { return { email: "demo@local" }; }, onAuthChange() { return { data: { subscription: { unsubscribe() {} } } }; },
  async getOrders() { try { return Object.values((JSON.parse(localStorage.getItem("jeilax_link_v1")) || {}).orders || {}); } catch { return []; } },
  async updateStatus() {}, async requestInspection() {}, async sendMessage() {}, async judge() {}, async uploadPhoto() {}, async photoUrl() { return ""; }, subscribe() { return () => {}; },
};

const adapter = DATA_BACKEND === "mock" ? mockAdapter : supabaseAdapter;
export const portalApi = adapter;
export const authApi = adapter;

// 비모듈 인라인 스크립트(기존 데모 HTML)에서도 쓸 수 있게 전역 노출
if (typeof window !== "undefined") { window.portalApi = adapter; window.authApi = adapter; }
