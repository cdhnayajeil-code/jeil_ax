-- 93_nas_folder_file_fetch_rollback.sql — 부서 폴더 파일 가져오기 되돌리기(REQ-0112 · D1)
-- 먼저 게이트웨이(jeil-chat-lab)를 이전 버전(v24)으로 되돌린다. 그 뒤 90_nas_save_manage.sql 을 다시 실행하면
-- nas_work_claim · nas_fetch_status 가 90 의 정의로 돌아간다.
drop function if exists public.nas_file_fetch_submit(text, text, text);
delete from etl_meta.nas_fetch where save_id is null;
alter table etl_meta.nas_fetch drop column if exists src_rel;
alter table etl_meta.nas_fetch drop column if exists folder_key;
alter table etl_meta.nas_fetch alter column save_id set not null;
