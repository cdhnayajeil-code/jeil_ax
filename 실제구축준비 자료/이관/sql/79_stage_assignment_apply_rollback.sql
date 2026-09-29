-- 79_stage_assignment_apply_rollback.sql — 배정 반영 되돌리기
begin;
update public.ai_routing_rule set model_id = 'gpt-4o',            updated_by = 'rollback79', updated_at = now() where seq = 1 and model_id = 'gpt-6-sol';
update public.ai_routing_rule set model_id = 'gpt-4o',            updated_by = 'rollback79', updated_at = now() where seq = 2 and model_id = 'gpt-6-sol';
update public.ai_routing_rule set model_id = 'claude-haiku-4-5',  updated_by = 'rollback79', updated_at = now() where seq = 3 and model_id = 'gpt-6-luna';
update public.ai_routing_rule set model_id = 'gpt-4o-mini',       updated_by = 'rollback79', updated_at = now() where seq = 4 and model_id = 'gpt-6-luna';
update public.ai_routing_rule set model_id = 'claude-sonnet-4-6', updated_by = 'rollback79', updated_at = now() where seq = 5 and model_id = 'claude-sonnet-5-5';
-- v2 초안은 「현재」로 지정되지 않았을 때만 지운다(지정됐다면 관리자가 승인한 것이라 되돌리지 않는다)
delete from public.ai_agent_version
 where agent_key = 'purchase' and version = 2 and state = 'draft'
   and not exists (select 1 from public.ai_agent where agent_key = 'purchase' and current_version = 2);
commit;
