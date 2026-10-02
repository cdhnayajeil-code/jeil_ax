-- 86 되돌리기 — NAS 실시간 조회 큐 제거. 먼저 게이트웨이의 nas 도구를 끄거나(에이전트 버전에서 도메인 nas 해제) 내린다.
-- 적재(82·84·85)에는 영향이 없다.
drop function if exists public.nas_query_finish(uuid, text, jsonb, int, text);
drop function if exists public.nas_query_claim(text);
drop function if exists public.nas_query_poll(uuid);
drop function if exists public.nas_query_submit(text, text, jsonb, text[], boolean);
drop table if exists etl_meta.nas_query;
drop table if exists etl_meta.nas_query_worker;
drop table if exists etl_meta.nas_folder_scope;
