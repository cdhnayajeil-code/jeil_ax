-- 81_ai_model_astra_tools_note_rollback.sql — 81 되돌리기 (REQ-0095)
begin;

update public.ai_model
   set status_note = 'OpenAI 플래그십'
 where model_id = 'gpt-6-astra';
-- request_shape 는 되살리지 않는다(실패한 학습 모양 — 다음 호출이 다시 배운다)

commit;
