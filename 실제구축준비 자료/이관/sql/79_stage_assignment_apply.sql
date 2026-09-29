-- 79_stage_assignment_apply.sql — 단계별 권장 모델을 실제 배정에 반영 (REQ-0093 · 관리자 지시 2026-09-29)
--
-- 「단계별 권장모델에 값을 반영해줘」 — 권장 표가 실제 배정과 따로 놀지 않게, 배정 쪽을 권장에 맞춘다.
-- 화면은 이 결과를 읽어 「권장 = 배정」인지 보여 준다. 없는 값을 만들지 않는다.
--
-- ① 라우팅 규칙(운영 챗봇 jeil-chat · **OpenAI 전용 게이트웨이**)
--   Claude 는 부를 수 없으므로 OpenAI 쪽 같은 단계 모델로 맞춘다(단가는 2026-09-29 공식표).
--   | 규칙 | 유형 | 전 | 후 | 이유 |
--   | 1 파일 업로드 포함 | file(미연동·표시만) | gpt-4o $2.5/$10 | gpt-6-sol $2/$10 | 3단계 OpenAI 상당 · 이전 세대 제거 |
--   | 2 2,000자↑·분석·보고서·기획 | keyword_length(**적용 중**) | gpt-4o $2.5/$10 | gpt-6-sol $2/$10 | 3단계 · 같은 출력단가에 입력 20% 저렴, 세대 위 |
--   | 3 ERP 조회 | erp(미연동·표시만) | claude-haiku-4-5 | gpt-6-luna $0.10/$0.50 | 1단계 · 부를 수 있는 벤더로 |
--   | 4 기본값 | default(표시) | gpt-4o-mini | gpt-6-luna | 게이트웨이 기본 모델(SQL 78)과 일치시킴 — 어긋나면 화면이 모순돼 보인다 |
--   | 5 교차검증 | cross_check(미연동·표시만) | claude-sonnet-4-6(legacy) | claude-sonnet-5-5 | 3단계 권장 |
--   규칙 4 의 실제 판정은 `ai_gateway_config.default_model` 이 한다(pickModel). 여기 값은 표시용이라 맞춰 두는 것.
--
-- ② 구매 에이전트 **새 버전 초안 v2** — 「현재」로 지정하지 않는다
--   v1(현재): 기본 claude-sonnet-5(legacy) · 예비 gpt-4.1-mini
--   v2(초안): 기본 **claude-sonnet-5-5**(3단계 권장) · 예비 **gpt-6-luna**(1단계 · 예산 초과·장애 시 싼 쪽으로 내려간다)
--   나머지(추론강도·토큰·역할 안내·답변 원칙·도구 묶음·캐싱·라운드)는 v1 을 그대로 복사한다.
--   「현재로 지정」은 관리자(reviewer) 승인 절차라 여기서 하지 않는다 — 에이전트 관리 화면에서 골든셋 돌린 뒤 지정.
--   ANTHROPIC_API_KEY 가 없는 동안은 v2 를 현재로 지정해도 예비 모델(gpt-6-luna)이 응답한다.

begin;

-- ── ① 라우팅 규칙 ───────────────────────────────────────────────────────────
update public.ai_routing_rule set model_id = 'gpt-6-sol',        note = coalesce(note,'') || ' · 2026-09-29 3단계 권장(OpenAI)으로 교체(전: gpt-4o)',            updated_by = 'sql79', updated_at = now() where seq = 1 and model_id = 'gpt-4o';
update public.ai_routing_rule set model_id = 'gpt-6-sol',        note = coalesce(note,'') || ' · 2026-09-29 3단계 권장(OpenAI)으로 교체(전: gpt-4o)',            updated_by = 'sql79', updated_at = now() where seq = 2 and model_id = 'gpt-4o';
update public.ai_routing_rule set model_id = 'gpt-6-luna',       note = coalesce(note,'') || ' · 2026-09-29 1단계로 교체(전: claude-haiku-4-5 — 호출 불가 벤더)', updated_by = 'sql79', updated_at = now() where seq = 3 and model_id = 'claude-haiku-4-5';
update public.ai_routing_rule set model_id = 'gpt-6-luna',       note = coalesce(note,'') || ' · 2026-09-29 게이트웨이 기본과 일치(전: gpt-4o-mini)',           updated_by = 'sql79', updated_at = now() where seq = 4 and model_id = 'gpt-4o-mini';
update public.ai_routing_rule set model_id = 'claude-sonnet-5-5', note = coalesce(note,'') || ' · 2026-09-29 3단계 권장으로 교체(전: claude-sonnet-4-6 legacy)',   updated_by = 'sql79', updated_at = now() where seq = 5 and model_id = 'claude-sonnet-4-6';

-- ── ② 에이전트 v2 초안(v1 복사 + 모델만 교체) ─────────────────────────────────
insert into public.ai_agent_version
  (agent_key, version, state, model_id, fallback_model_id, effort, max_tokens, temperature, prompt_caching,
   role_prompt, answer_rules, modules, max_tool_rounds, note, created_by, created_at)
select agent_key, 2, 'draft', 'claude-sonnet-5-5', 'gpt-6-luna', effort, max_tokens, temperature, prompt_caching,
       role_prompt, answer_rules, modules, max_tool_rounds,
       '단계별 권장 반영(REQ-0093) — 기본 Sonnet 5.5(3단계) · 예비 gpt-6-luna(1단계). 골든셋 회귀 후 「현재로 지정」 필요',
       'sql79', now()
  from public.ai_agent_version
 where agent_key = 'purchase' and version = 1
   and not exists (select 1 from public.ai_agent_version where agent_key = 'purchase' and version = 2);

commit;

-- 확인
-- select seq, label, rule_type, model_id, enforced, active from public.ai_routing_rule order by seq;
-- select version, state, model_id, fallback_model_id, note from public.ai_agent_version where agent_key='purchase' order by version;

-- ── ③ 보정(적용 중 발견) — 규칙 2 가 가리키는 gpt-6-sol 이 비활성이면 조용히 무시된다
--   jeil-chat 의 pickModel 은 `usable.has(rule.model_id)` 를 요구한다(usable = active && callable && openai).
--   SQL 78 은 gpt-6-sol 을 켜지 않았으므로(3단계 권장은 Sonnet 5.5) 규칙 2 가 기본 모델로 떨어진다 — 오류 없이.
--   운영 챗봇은 OpenAI 전용이라 3단계는 gpt-6-sol 이 실제 자리다 → 켠다($2/$10 · Sonnet 5.5 와 같은 단가).
update public.ai_model set active = true, updated_by = 'sql79', updated_at = now()
 where model_id = 'gpt-6-sol' and not active;

-- ── ④ 3단계 권장을 벤더별로 둔다 — 운영 챗봇(OpenAI 전용)에서는 gpt-6-sol 이 3단계 권장이다
--   권장이 Claude 한 줄뿐이면, 챗봇에 gpt-6-sol 을 배정한 것이 「권장≠배정」으로 붉게 떠 헛경고가 된다.
--   같은 단계에 벤더별 권장 1개씩(Claude: claude-sonnet-5-5 · OpenAI: gpt-6-sol). 단가는 둘 다 $2/$10.
update public.ai_model set recommended = true, updated_by = 'sql79', updated_at = now()
 where model_id = 'gpt-6-sol' and stage = 3;
