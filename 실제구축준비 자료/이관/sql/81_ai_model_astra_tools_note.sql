-- 81_ai_model_astra_tools_note.sql — gpt-6-astra 실측 결과를 카탈로그 메모에 남긴다 (REQ-0095 · 2026-09-30)
-- 실측(2026-09-30 07:01 UTC · 실제 지시문+도구 그대로 시험 호출): OpenAI 400
--   "Unsupported value: 'reasoning_effort' does not support 'none' with this model. Supported values are: 'low', 'medium', …"
--   → gpt-6-astra 는 chat/completions 에서 도구와 함께 부를 수 없다(추론을 끌 수 없고, 추론+도구는 Responses API 만 지원).
-- 데이터만 바꾼다(스키마 무변경). active/callable 은 손대지 않는다(이미 꺼져 있음 · 5단계 권장 없음).
-- request_shape 는 실패한 학습 모양이므로 지운다 — 운영 점검(test_model)은 400 이면 스스로 지우지만, 실측 함수는 지우지 않고 기록했다.
begin;

update public.ai_model
   set status_note = 'OpenAI 플래그십 · ⚠ 운영 챗봇(도구 호출)에서 쓸 수 없음 — reasoning_effort none 미지원(2026-09-30 실측) · Responses API 이관 전까지 켜도 답하지 못함',
       request_shape = null
 where model_id = 'gpt-6-astra';

commit;

-- 확인: select model_id, status_note, request_shape, last_check_note from public.ai_model where model_id = 'gpt-6-astra';
