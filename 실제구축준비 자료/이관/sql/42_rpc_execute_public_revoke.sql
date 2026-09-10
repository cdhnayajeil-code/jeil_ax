-- ============================================================================
-- 42_rpc_execute_public_revoke.sql — 서비스롤 전용 RPC 12종에 남아 있던 PUBLIC EXECUTE 회수
--   (2026-09-10 · REQ-0027 · 절대우선 fix — REQ-0026 조사 중 실측 발견)
--
-- 무엇이 문제였나
--   34/38/39/41 번 파일의 계정·퇴사 RPC 는 전부 SECURITY DEFINER(RLS 우회)인데,
--   권한 회수를 `revoke all … from anon, authenticated` 로만 했다.
--   Postgres 함수는 생성 시 **PUBLIC 에 EXECUTE 가 기본 부여**되므로, anon/authenticated 를
--   명시적으로 빼도 PUBLIC 경유로 다시 실행 가능하다(has_function_privilege('anon', …) = true 실측).
--   결과: 공개 anon 키만으로 PostgREST `/rest/v1/rpc/account_recon_get` 등을 호출해
--   전 직원 명부 조회 · 계정 미러 upsert · 퇴사 처리 큐 투입이 가능한 상태였다.
--   17_perm_core.sql 의 perm_* 5종은 `from public, authenticated, anon` 으로 제대로 회수돼 있었다.
--
-- 고치는 것
--   12종 전부 `revoke all … from public, anon, authenticated` + `grant execute … to service_role`.
--   호출자는 Edge Function(jeil-accounts, SUPABASE_SERVICE_ROLE_KEY)과 ETL(etl_run/etl_watch/gw_collect/ms_collect,
--   SUPABASE_SERVICE_ROLE_KEY) 뿐이라 동작 영향 0 — 2026-09-10 grep 실측.
--
-- 재발 방지
--   서비스롤 전용 함수를 만들 때는 반드시 `from public` 을 포함한다(17번 파일 패턴).
--   검증: 아래 §검증 쿼리에서 anon_x/auth_x 가 전부 false 여야 한다.
-- ============================================================================

-- 계정 대사·미러 (34_identity_accounts.sql)
revoke all on function public.account_recon_get(text, text)             from public, anon, authenticated;
revoke all on function public.acct_source_upsert(text, jsonb)           from public, anon, authenticated;
revoke all on function public.erp_identity_upsert(text, jsonb)          from public, anon, authenticated;
revoke all on function public.erp_usr_master_reconcile(text[])          from public, anon, authenticated;
grant execute on function public.account_recon_get(text, text)          to service_role;
grant execute on function public.acct_source_upsert(text, jsonb)        to service_role;
grant execute on function public.erp_identity_upsert(text, jsonb)       to service_role;
grant execute on function public.erp_usr_master_reconcile(text[])       to service_role;

-- 퇴사 처리 큐 (38_offboard_request.sql · 39_offboard_axes.sql · 41_ms_license.sql)
revoke all on function public.offboard_search(text, integer)                          from public, anon, authenticated;
revoke all on function public.offboard_request_create(text[], text, text, text[], date) from public, anon, authenticated;
revoke all on function public.offboard_request_status(uuid)                           from public, anon, authenticated;
revoke all on function public.offboard_request_claim(text)                            from public, anon, authenticated;
revoke all on function public.offboard_request_progress(uuid, integer, integer, text) from public, anon, authenticated;
revoke all on function public.offboard_request_finish(uuid, text, jsonb, text)        from public, anon, authenticated;
revoke all on function public.offboard_refresh_accounts(text)                         from public, anon, authenticated;
revoke all on function public.offboard_refresh_status(uuid)                           from public, anon, authenticated;
grant execute on function public.offboard_search(text, integer)                          to service_role;
grant execute on function public.offboard_request_create(text[], text, text, text[], date) to service_role;
grant execute on function public.offboard_request_status(uuid)                           to service_role;
grant execute on function public.offboard_request_claim(text)                            to service_role;
grant execute on function public.offboard_request_progress(uuid, integer, integer, text) to service_role;
grant execute on function public.offboard_request_finish(uuid, text, jsonb, text)        to service_role;
grant execute on function public.offboard_refresh_accounts(text)                         to service_role;
grant execute on function public.offboard_refresh_status(uuid)                           to service_role;

-- ── 검증 (읽기 전용) ─────────────────────────────────────────────────────────
-- select p.oid::regprocedure::text sig,
--        has_function_privilege('anon', p.oid, 'EXECUTE') anon_x,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x,
--        has_function_privilege('service_role', p.oid, 'EXECUTE') svc_x
--   from pg_proc p
--  where p.pronamespace = 'public'::regnamespace
--    and (p.proname like 'account_%' or p.proname like 'offboard_%' or p.proname like 'acct_%'
--         or p.proname in ('erp_identity_upsert','erp_usr_master_reconcile'))
--  order by 1;
-- 기대: anon_x = false · auth_x = false · svc_x = true (12행 전부)

-- ── 롤백 ─────────────────────────────────────────────────────────────────────
-- 되돌릴 이유가 없다(공개 노출 복구). 굳이 필요하면 각 함수에 `grant execute … to public;`.
