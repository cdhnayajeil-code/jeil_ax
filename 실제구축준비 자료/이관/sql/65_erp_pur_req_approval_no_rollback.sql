-- 65_erp_pur_req_approval_no_rollback.sql
-- 65번 되돌리기 (2026-09-22)
--
-- ⚠ 되돌리면 발주통합 LIST 의 「요청번호(결재)」가 다시 빈칸이 된다.
--    화면은 값이 없으면 그 열을 기본 프리셋에서 빼고 검색칸을 잠그므로 **깨지지는 않는다**.
--    먼저 66번(뷰)을 63번으로 되돌린 뒤 이것을 실행한다 — 뷰가 pu_no 를 참조하고 있다.

drop index if exists erp_ro.idx_pur_req_s_pu_no;
drop function if exists public.erp_etl_upsert_pur_req(text, jsonb);

-- 컬럼은 남겨 두는 편이 안전하다(다시 적재하면 그대로 살아난다).
-- 정말 지우려면 아래 주석을 풀되, 66번 뷰를 먼저 되돌려야 한다.
-- alter table erp_ro.pur_req_s drop column if exists pu_no;
-- alter table erp_ro.pur_req_s drop column if exists req_title;
-- alter table erp_ro.pur_req_s drop column if exists dw_ref;

-- etl_run.py 의 JOBS["pur_req"] 에서 "rpc": "erp_etl_upsert_pur_req" 줄과
-- 추출 SQL 의 EXT1_CD/EXT2_CD/EXT3_CD 3줄도 함께 되돌린다(안 그러면 러너가 없는 함수를 부른다).
