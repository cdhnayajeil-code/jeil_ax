-- 80_ai_model_last_check.sql — 모델 「동작 점검」 결과·학습된 요청 모양 (REQ-0095 · 2026-09-30)
-- 왜: 운영 챗봇 기본 gpt-6-luna 가 chat/completions 에서 도구+reasoning_effort 조합을 400 으로 거부했다
--     ("Function tools with reasoning_effort are not supported for gpt-6-luna … set reasoning_effort to 'none'" — function_logs 2026-09-30).
--     게이트웨이(jeil-chat)가 400 사유로 배운 요청 모양을 저장해 콜드스타트 재학습을 없애고,
--     관리자 콘솔 「모델 설정」이 모델별 점검 결과(정상/빈 답/거부·사유·지연·시각)를 보여 준다.
-- 안전장치: 판정(pickModel · active · callable)에는 쓰지 않는다 — 화면 안내·할 일용. 기존 행 값은 건드리지 않는다(전부 null = 미점검).
-- 적용 순서: 함수(jeil-chat v31 · jeil-chat-admin v16) 배포 **전** 적용 권장.
--   jeil-chat 의 시드 조회는 별도 select 라 순서가 바뀌어도 챗은 동작하지만, 점검 기록은 이 SQL 전까지 실패한다(응답 recorded:false).
begin;

alter table public.ai_model
  add column if not exists last_check_at     timestamptz,
  add column if not exists last_check_ok     boolean,
  add column if not exists last_check_status smallint,
  add column if not exists last_check_ms     integer,
  add column if not exists last_check_note   text,
  add column if not exists last_check_by     text,
  add column if not exists last_check_detail jsonb,
  add column if not exists request_shape     jsonb;

comment on column public.ai_model.last_check_at     is '마지막 동작 점검 시각(jeil-chat action:test_model). null = 미점검(정상이 아니라 「모른다」)';
comment on column public.ai_model.last_check_ok     is 'true 정상(200 + 본문 1자 이상 또는 도구 호출 1건 이상) · false 거부/실패/빈 답. 판정(pickModel)에는 쓰지 않는다';
comment on column public.ai_model.last_check_status is 'HTTP 상태. 0 = 연결 실패/시간 초과';
comment on column public.ai_model.last_check_ms     is '응답 지연(ms) — 적응 재시도 포함';
comment on column public.ai_model.last_check_note   is '사람이 읽는 요약 한 줄(서버가 만든다 — 화면은 문장을 만들지 않는다)';
comment on column public.ai_model.last_check_by     is '점검한 관리자 upn';
comment on column public.ai_model.last_check_detail is '{pt,ct,rt(추론 토큰),finish,content_len,tool_calls,cost_usd,adjustments[],param,raw(벤더 원문 200자 · 키 마스킹)}';
comment on column public.ai_model.request_shape     is '400 사유로 학습한 OpenAI 요청 모양 {temp,maxKey,reasoning}. 손으로 채우지 않는다 — 점검이 기록하고 게이트웨이가 콜드스타트에 화이트리스트 검증 후 시드';

commit;

-- 확인:
-- select model_id, last_check_at, last_check_ok, last_check_status, last_check_ms, left(last_check_note,60) as note, request_shape
--   from public.ai_model order by sort;
