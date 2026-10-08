-- 97 되돌리기 — 표 구조 판독·판독 상태 조회 종류 제거.
-- 순서: ① 에이전트 설정에서 read_company_table 을 끄고(게이트웨이 이전 판 재배포) ② 이 파일 ③ 87_nas_doc_search.sql 의
--   nas_query_submit 정의를 다시 실행(이 파일은 종류 제약만 되돌린다 — 함수는 87 이 정본).
-- 워커는 n1.9 그대로 둬도 된다(모르는 종류가 들어오지 않을 뿐이다).
delete from etl_meta.nas_query where kind in ('doc_table', 'index_status');
alter table etl_meta.nas_query drop constraint if exists nas_query_kind_check;
alter table etl_meta.nas_query add constraint nas_query_kind_check
  check (kind in ('file_list', 'turn_history', 'doc_search', 'doc_read'));
