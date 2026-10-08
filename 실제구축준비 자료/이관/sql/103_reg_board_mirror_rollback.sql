-- 103_reg_board_mirror_rollback.sql — 되돌리기: 사내규정 게시판 미러(reg_*)·RPC 삭제 (REQ-0124)
--
-- 주의: 표를 지우면 적재된 규정 사본이 전부 사라진다. 정본은 NAS 00_전사공유/사내규정 이므로
--       103 을 다시 적용한 뒤 사내 PC 에서 `gw_board_collect.py --full` 로 재적재할 수 있다(대장 _state.json 의 db_synced 를
--       지우거나 NAS 대장을 그대로 두고 --full 을 돌리면 meta.json 으로 다시 보낸다).
-- pg_trgm 확장은 남긴다(다른 용도로 쓸 수 있다 — 지우려면 맨 아래 주석 해제).

drop function if exists public.reg_status();
drop function if exists public.reg_search(text, integer);
drop function if exists public.reg_get(text, text, integer, integer);
drop function if exists public.reg_list(text, text);
drop function if exists public.reg_mark_removed(text, text[], uuid);
drop function if exists public.reg_ingest_upsert(jsonb);
drop function if exists public.reg_recalc_current(text);
drop function if exists public.reg_source_list();

drop table if exists public.reg_article;
drop table if exists public.reg_document;
drop table if exists public.reg_attachment;
drop table if exists public.reg_post_history;
drop table if exists public.reg_post;
drop table if exists public.reg_source;

-- drop extension if exists pg_trgm;   -- 권장하지 않음(다른 객체가 쓸 수 있다)
