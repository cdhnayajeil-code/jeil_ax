-- 92_dri_agent_rollback.sql — DRI 분석·생성 에이전트 등록 되돌리기(REQ-0112)
-- 대화 기록(agent_turn)·보관함 대장(nas_save)은 지우지 않는다 — 기록으로 남긴다.
-- NAS 의 실제 폴더(부서/6110_사업운영팀)와 그 안의 자료는 그대로 남는다. 허용 폴더 등록만 끈다.
delete from public.ai_agent_member where agent_key = 'dri';
delete from public.ai_agent_version where agent_key = 'dri';
update public.ai_agent set status = 'off', updated_by = 'sql92-rollback', updated_at = now() where agent_key = 'dri';
update etl_meta.nas_folder_scope set active = false where folder_key = 'biz_ops';
