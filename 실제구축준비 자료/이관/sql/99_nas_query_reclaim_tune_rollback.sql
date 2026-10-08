-- 99 되돌리기 — 되살리기 시간을 5초로 되돌린다: 98_nas_query_result_sweep.sql 의 nas_query_claim 정의를 다시 실행한다.
-- 색인은 두어도 해가 없지만 지우려면 아래를 실행한다.
drop index if exists etl_meta.nas_query_result_left_ix;
select '98_nas_query_result_sweep.sql 의 nas_query_claim 정의를 다시 실행하세요' as how_to_rollback;
