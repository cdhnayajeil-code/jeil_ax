-- 98 되돌리기 — nas_query_claim 을 87 판으로 되돌린다.
-- 87_nas_doc_search.sql 의 「집어 간 뒤 사라진 요청 되살리기」 절(create or replace function public.nas_query_claim …)을 다시 실행한다.
-- 이 파일이 지운 결과(result)는 되살릴 수 없고 되살릴 필요도 없다(이미 시간 초과로 버려진 조회의 결과다).
select '87_nas_doc_search.sql 의 nas_query_claim 정의를 다시 실행하세요' as how_to_rollback;
