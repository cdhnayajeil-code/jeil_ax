-- 89_nas_save_queue_rollback.sql — NAS 저장 큐 되돌리기(REQ-0108)
-- 주의: 저장 대장(etl_meta.nas_save)을 지우면 「무엇을 누가 언제 저장했는지」 기록이 사라진다.
--       NAS 에 이미 쓴 파일은 그대로 남는다(부서 폴더의 「AI저장」) — 파일은 NAS 에서 직접 정리한다.
-- 먼저 게이트웨이(jeil-chat-lab)·중계 함수(jeil-nas-bridge)를 이전 버전으로 되돌린 뒤 실행한다.
drop function if exists public.nas_save_purged(uuid, boolean, text);
drop function if exists public.nas_save_purge_list(int);
drop function if exists public.nas_save_request_purge(uuid, text, boolean);
drop function if exists public.nas_save_list(text, int);
drop function if exists public.nas_save_finish(uuid, text, text, text);
drop function if exists public.nas_save_source(uuid, text);
drop function if exists public.nas_save_claim(text);
drop function if exists public.nas_save_submit(text, text, text, text, text, text, bigint, text, text, text, bigint, uuid);
drop table if exists etl_meta.nas_save;
drop table if exists etl_meta.nas_save_policy;
-- 임시 버킷은 비어 있을 때만 지워진다(남은 파일이 있으면 대시보드에서 비운 뒤 삭제).
delete from storage.buckets where id = 'nas-outbox' and not exists (select 1 from storage.objects where bucket_id = 'nas-outbox');
