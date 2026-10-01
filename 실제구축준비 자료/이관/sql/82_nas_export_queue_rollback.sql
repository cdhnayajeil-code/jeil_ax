-- 82_nas_export_queue_rollback.sql — 82 되돌리기 (REQ-0097)
--
-- 유실되는 것은 **적재 요청 이력·심박·증분 커서**뿐이다. 업무 데이터는 이 SQL 이 만든 것이 하나도 없다
--   (82 는 읽기 전용 내보내기 경로다 — agent_turn·v_erp_* 를 읽기만 하고 고치지 않는다).
-- 이미 NAS 에 쓴 파일은 그대로 남는다. 커서가 사라지므로 다시 적재하면 **처음부터** 다시 내보낸다
--   → 같은 행이 파일에 두 번 실린다. 되돌린 뒤 재적재할 때는 NAS 의 기존 파일을 먼저 치우거나,
--     `nas_export_commit` 로 커서를 수동 복원한다(마지막 파일의 끝 행 값).
-- 워커(nas_worker.py)는 이 RPC 가 없으면 `--self-check` 에서 사유를 남기고 멈춘다 — 조용히 성공하지 않는다.

begin;

drop function if exists public.nas_export_commit(text, text, text, int);
drop function if exists public.nas_export_page(text, text, text, int);
drop function if exists public.nas_export_count(text, text, text);
drop function if exists public.nas_export_sources(text);
drop function if exists public.nas_request_finish(uuid, text, jsonb, int, int, text);
drop function if exists public.nas_request_progress(uuid, int, int, text, int, int);
drop function if exists public.nas_request_claim(text);
drop function if exists public.nas_runner_ping(text, text);
drop function if exists public.nas_request_status(uuid);
drop function if exists public.nas_request_create(text, text[]);

drop table if exists etl_meta.nas_export_state;    -- nas_export_source 를 참조하므로 먼저
drop table if exists etl_meta.nas_export_source;
drop table if exists etl_meta.nas_heartbeat;
drop table if exists etl_meta.nas_request;

commit;

-- 확인: 아래가 0행이어야 한다
-- select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'etl_meta' and relname like 'nas%';
-- select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and proname like 'nas\_%';
