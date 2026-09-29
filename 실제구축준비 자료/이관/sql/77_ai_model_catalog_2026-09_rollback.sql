-- 77_ai_model_catalog_2026-09_rollback.sql — REQ-0056/0091 후속 되돌리기
--
-- 되돌리는 것: 이번에 추가한 8개 행 + 추가한 5개 컬럼.
-- 되돌리지 않는 것: 기존 행의 단가 — 이번 작업은 기존 단가를 고치지 않았다(분류·캐시단가만 채웠다).
--
-- ⚠ 관리자가 신규 행 중 하나를 **활성화해 실제로 쓰고 있으면** 삭제하지 말 것 —
--    그 모델의 과거 비용 추정 근거가 사라진다. 먼저 아래 확인 쿼리로 사용 여부를 본다.
--
-- select model_id, active from public.ai_model where updated_by = 'sql77' and active;
-- select distinct model from public.chat_log
--  where model in ('claude-opus-5-5','claude-sonnet-5-5','claude-fable-5-1','gpt-6-astra','gpt-6-sol','gpt-6-luna','gpt-5-mini','gpt-5.4-mini')
-- union select distinct model from public.agent_turn
--  where model in ('claude-opus-5-5','claude-sonnet-5-5','claude-fable-5-1','gpt-6-astra','gpt-6-sol','gpt-6-luna','gpt-5-mini','gpt-5.4-mini');

begin;

delete from public.ai_model
 where model_id in ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1',
                    'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5-mini', 'gpt-5.4-mini')
   and not active;

alter table public.ai_model drop constraint if exists ai_model_tier_ck;
alter table public.ai_model drop constraint if exists ai_model_token_factor_ck;
alter table public.ai_model drop column if exists tier;
alter table public.ai_model drop column if exists price_cache_in;
alter table public.ai_model drop column if exists context_k;
alter table public.ai_model drop column if exists token_factor;
alter table public.ai_model drop column if exists status_note;

commit;
