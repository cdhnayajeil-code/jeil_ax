-- 78_ai_model_stage_default_rollback.sql — 되돌리기
--
-- 가장 급한 되돌림은 **기본 모델**이다. 챗봇이 이상하면 이 한 줄만 먼저 실행하면 된다:
--   update public.ai_gateway_config set default_model = 'gpt-4o-mini', updated_by = 'rollback78', updated_at = now() where id = 1;
--
-- 아래는 전체 되돌림. 채점·분류 모델 우선순위(JUDGE_MODELS)는 코드라 함수 재배포로 되돌린다.

begin;

-- ① 기본 모델 원복
update public.ai_gateway_config
   set default_model = 'gpt-4o-mini', updated_by = 'rollback78', updated_at = now()
 where id = 1;

-- ② 이번에 켠 모델 되돌림 — 그 사이 실제로 쓴 모델은 끄지 않는다(비용 기록의 근거를 남긴다)
update public.ai_model set active = false, updated_by = 'rollback78', updated_at = now()
 where model_id in ('gpt-6-luna', 'claude-sonnet-5-5', 'claude-opus-5-5')
   and model_id not in (select distinct model from public.chat_log where model is not null)
   and model_id not in (select distinct model from public.agent_turn where model is not null);

-- ③ 단계·권장 컬럼 제거
alter table public.ai_model drop constraint if exists ai_model_stage_ck;
alter table public.ai_model drop column if exists stage;
alter table public.ai_model drop column if exists recommended;

-- ④ Haiku 문구는 **되돌리지 않는다** — SQL 77 의 「은퇴 예고」가 사실과 달랐으므로 정정본이 맞다.

commit;
