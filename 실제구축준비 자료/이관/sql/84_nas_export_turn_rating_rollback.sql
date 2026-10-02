-- 84 되돌리기 — 평가 내보내기 소스 제거. NAS 에 이미 놓인 파일은 건드리지 않는다.
delete from etl_meta.nas_export_source where source_key = 'agent_turn_rating';   -- 커서(nas_export_state)는 cascade 로 함께 지워진다
drop view if exists public.v_agent_turn_rating;
