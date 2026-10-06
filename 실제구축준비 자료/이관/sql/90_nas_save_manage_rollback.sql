-- 90_nas_save_manage_rollback.sql — 보관함 관리 3종(폴더·내려받기·즉시 삭제) 되돌리기(REQ-0108)
-- 먼저 게이트웨이(jeil-chat-lab)·중계 함수(jeil-nas-bridge)·NAS 워커를 이전 버전(v23 · v6 · n1.6)으로 되돌린 뒤 실행한다.
-- 사용자 폴더에 이미 저장된 파일은 NAS 에 그대로 남는다. 대장의 폴더 이름(nas_save.subdir)은 기록으로 남긴다.
drop function if exists public.nas_fetch_sweep();
drop function if exists public.nas_fetch_status(uuid, text);
drop function if exists public.nas_fetch_finish(uuid, text, text);
drop function if exists public.nas_fetch_source(uuid, text);
drop function if exists public.nas_fetch_submit(uuid, text, text);
drop function if exists public.nas_work_claim(text);
drop function if exists public.nas_save_folder_delete(text, text, text, boolean);
drop function if exists public.nas_save_folder_create(text, text, text);
drop table if exists etl_meta.nas_fetch;
drop table if exists etl_meta.nas_save_folder;
-- nas_save_submit · nas_save_claim · nas_save_list 는 89_nas_save_queue.sql 을 다시 실행해 되돌린다
-- (그 전에 13번째 인자가 붙은 submit 을 지운다).
drop function if exists public.nas_save_submit(text, text, text, text, text, text, bigint, text, text, text, bigint, uuid, text);
drop function if exists etl_meta.nas_save_take(text, boolean);
drop function if exists etl_meta.nas_subdir_ok(text);
