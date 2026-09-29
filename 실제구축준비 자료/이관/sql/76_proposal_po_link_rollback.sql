-- 76_proposal_po_link_rollback.sql — 76 되돌리기
-- ⚠ 게이트웨이 도구 get_proposal_chain 이 이 뷰·함수를 쓴다 — 되돌리기 전에 jeil-chat-lab 을 이전 버전으로.
drop function if exists public.agent_proposal_recon_detail(text, smallint, integer);
drop view if exists public.v_pur_proposal_po_link;
