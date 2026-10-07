-- 95_pur_board_case_chain_rollback.sql — 95 되돌리기(REQ-0116)
-- 뷰·함수는 새로 만든 것이라 지우면 끝. 포털 카드 2행은 지운다(화면 파일·라우트는 저장소에 남는다 — 카드만 사라진다).
drop function if exists public.pur_case_chain(text);
drop function if exists public.pur_case_round(text);
drop function if exists public.pur_case_round_fin(text);
drop view if exists public.v_erp_pur_board;
drop function if exists public.pur_proposal_links();
delete from public.portal_page where page_key in ('purchase_board_2026', 'purchase_trace_2026');
