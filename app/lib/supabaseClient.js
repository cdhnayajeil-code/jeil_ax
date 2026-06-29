// app/lib/supabaseClient.js — Supabase 클라이언트 단일 인스턴스
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: "jeilax_sb_auth",   // 데모: 기존 jeilax_auth(Entra)와 분리
  },
});
