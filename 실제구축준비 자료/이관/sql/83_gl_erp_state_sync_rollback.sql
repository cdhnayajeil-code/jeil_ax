-- 83 롤백 — ERP 상태 역동기화 제거. 이미 'ERP 삭제'로 종결된 전표(status=void)는 되돌리지 않는다
-- (ERP 에서 실제로 지워진 사실이므로). 컬럼을 지우기 전에 필요하면 erp_sync_state 를 백업한다.
drop function if exists public.gl_erp_sync_record(jsonb, text);
drop function if exists public.gl_erp_sync_targets(text, int);
alter table public.gl_draft drop constraint if exists gl_draft_erp_sync_state_check;
alter table public.gl_draft
  drop column if exists erp_deleted_at,
  drop column if exists erp_synced_at,
  drop column if exists erp_final_gl_no,
  drop column if exists erp_sync_state;
