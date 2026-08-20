// app/lib/supabaseClient.js — Supabase 클라이언트 단일 인스턴스
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";

// 세션 저장소 분리(2026-08-20) — 사내 세션과 협력사 세션은 같은 도메인이라 localStorage 키를
// 공유하면 서로 덮어쓴다(실제 사고: 관리자가 협력사 포털에 로그인하자 사내 콘솔 세션이 대체돼
// 계정 관리 API가 403 forbidden: internal only 로 거부됨).
// → 협력사 대상 화면(협력사 로그인·협력사 모바일 포털)만 별도 키를 쓴다.
const VENDOR_PAGES = ["/app/vendor-login", "/pages/협력사_모바일_포털"];
const path = decodeURIComponent(location.pathname);
const isVendorPage = VENDOR_PAGES.some((p) => path.includes(p));

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,       // OAuth(Entra) 콜백 자동 세션화 — 브리지에 필요
    flowType: "pkce",               // OAuth code flow(PKCE) — 토큰 URL 노출 최소화
    // 데모: 기존 jeilax_auth(Entra)와 분리. 사내=jeilax_sb_auth / 협력사=jeilax_sb_vendor
    storageKey: isVendorPage ? "jeilax_sb_vendor" : "jeilax_sb_auth",
  },
});
