-- 87 되돌리기 — 문서 내용 검색 종류 제거. 먼저 게이트웨이의 search_company_docs·read_company_doc 를 끈다.
-- nas_query_submit 은 86_nas_query_queue.sql 의 정의를 다시 실행해 되돌린다(이 파일은 종류 제약과 색인 폴더 함수만 걷는다).
drop function if exists public.nas_index_folders();
delete from etl_meta.nas_query where kind in ('doc_search', 'doc_read');
alter table etl_meta.nas_query drop constraint if exists nas_query_kind_check;
alter table etl_meta.nas_query add constraint nas_query_kind_check check (kind in ('file_list', 'turn_history'));
