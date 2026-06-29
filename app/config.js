// app/config.js — 데모 공개 설정
// 주의: 아래 키는 Supabase "publishable(anon)" 키로 설계상 공개 가능하다.
//       실제 데이터 보호는 RLS가 담당한다(CLAUDE.md §5.4).
//       service_role 키·Entra Secret·DB 접속정보는 절대 여기 두지 않는다(§1).
export const SUPABASE_URL = "https://dvzohdqtjzocgcclgwro.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_eZDv07JsmvxMbYAsm3UqFA_u3BG1olA";

// 데이터 어댑터 선택: 'supabase' | 'mock'
// mock = 기존 localStorage 데모(오프라인). supabase = 실제 DB.
export const DATA_BACKEND = "supabase";
