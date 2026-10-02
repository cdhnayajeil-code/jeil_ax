-- 85 되돌리기 — 전용 토큰 제거. 먼저 Edge Function jeil-nas-bridge 를 내리거나 NAS 컨테이너를 멈춘다
-- (브리지가 남아 있으면 모든 호출이 401 로 끝난다 — 워커는 요청을 집지 못하고 사유를 로그에 남긴다).
drop function if exists public.nas_worker_token_check(text);
drop table if exists etl_meta.nas_worker_token;
