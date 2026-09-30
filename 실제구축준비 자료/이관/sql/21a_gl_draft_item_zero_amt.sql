-- 21a — 결의전표 라인 0원 허용 (2026-09-30 관리자 지시)
-- 전표 입력 화면에서 0원 라인을 입력할 수 있어야 한다. 음수는 계속 막는다.
-- 화면(validateRows)·Edge Function(jeil-gl-draft)·DB 세 층이 같은 기준(item_amt >= 0)을 쓴다.
alter table public.gl_draft_item drop constraint if exists gl_draft_item_item_amt_check;
alter table public.gl_draft_item add constraint gl_draft_item_item_amt_check check (item_amt >= 0);
