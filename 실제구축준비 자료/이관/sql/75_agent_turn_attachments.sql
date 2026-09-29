-- 75_agent_turn_attachments.sql — 에이전트 대화 첨부 파일 메타(REQ-0089 · 12_에이전트관리)
-- 첨부 **원본·내용은 저장하지 않는다.** 이 열에는 이번 질문에 붙은 파일의 이름·종류·크기(글자 수/바이트)만 남긴다
-- → 개선 대장에서 "파일을 붙인 질문이었다"는 맥락만 보이게.
-- 롤백: 75_agent_turn_attachments_rollback.sql
alter table public.agent_turn
  add column if not exists attachments jsonb not null default '[]'::jsonb;
comment on column public.agent_turn.attachments is '첨부 파일 메타 [{name,kind(text|image|pdf),chars|bytes}] — 원본·내용 미저장(REQ-0089)';
