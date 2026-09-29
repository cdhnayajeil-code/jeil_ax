-- 75_agent_turn_attachments_rollback.sql — 75 되돌리기(첨부 메타 열 제거)
-- ⚠ 게이트웨이가 이 열에 쓰므로, 되돌리기 전에 jeil-chat-lab 을 첨부 기능 이전 버전으로 먼저 되돌린다.
alter table public.agent_turn drop column if exists attachments;
