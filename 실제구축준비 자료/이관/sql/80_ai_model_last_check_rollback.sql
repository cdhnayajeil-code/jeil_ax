-- 80_ai_model_last_check_rollback.sql — 80 되돌리기 (REQ-0095)
-- 유실되는 것은 점검 이력·학습된 요청 모양뿐이다. 함수는 이전 커밋으로 재배포한다
-- (jeil-chat 의 시드 select 가 error 를 돌려도 무시되므로 순서는 무관 · 점검 기록만 recorded:false 로 실패한다).
begin;

alter table public.ai_model
  drop column if exists last_check_at,
  drop column if exists last_check_ok,
  drop column if exists last_check_status,
  drop column if exists last_check_ms,
  drop column if exists last_check_note,
  drop column if exists last_check_by,
  drop column if exists last_check_detail,
  drop column if exists request_shape;

commit;
