-- 74_dept_agent_rollback.sql — 74_dept_agent.sql 되돌리기
-- ⚠ 누적된 질의응답·개선 대장·골든셋이 함께 지워진다. 보존이 필요하면 먼저 내보낸다.
-- Storage 버킷은 객체가 남아 있으면 지워지지 않는다 — 콘솔에서 agent-artifacts 객체를 먼저 비운다.
drop function if exists public.agent_proposal_recon(text);
drop table if exists public.agent_artifact;
drop table if exists public.agent_golden_run;
drop table if exists public.agent_golden;
drop table if exists public.agent_glossary;
drop table if exists public.agent_improve;
drop table if exists public.agent_turn;
drop table if exists public.ai_agent_member;
drop table if exists public.ai_agent_version;
drop table if exists public.ai_agent;
delete from storage.buckets where id = 'agent-artifacts'
  and not exists (select 1 from storage.objects where bucket_id = 'agent-artifacts');
-- 모델 카탈로그: sonnet-5 행은 비활성으로만 되돌린다(다른 곳이 참조할 수 있어 삭제하지 않는다)
update public.ai_model set active = false, updated_by = 'sql74_rollback', updated_at = now()
 where model_id in ('claude-sonnet-5', 'claude-haiku-4-5');
