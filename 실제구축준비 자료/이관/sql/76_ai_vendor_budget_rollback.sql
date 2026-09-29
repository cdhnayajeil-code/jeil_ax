-- 76_ai_vendor_budget_rollback.sql — REQ-0091 되돌리기
-- 관리자가 입력한 예산·충전액이 사라진다. 화면(「💳 AI 비용·예산」 탭)을 먼저 내린 뒤 실행한다.
drop table if exists public.ai_vendor_budget;
