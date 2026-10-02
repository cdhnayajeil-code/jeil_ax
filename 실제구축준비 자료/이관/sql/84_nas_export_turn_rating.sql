-- 84 — NAS 적재: 대화 턴에 **나중에 달린 평가**도 NAS 로 간다 (REQ-0097 후속 · 2026-10-02)
--
-- 왜
--   agent_turn 은 id 커서로 증분 내보내기 한다. 한 번 내보낸 턴은 다시 보지 않으므로,
--   그 뒤에 달린 평가(rating·rating_note·rated_at — core/agent_api.ts 가 update 한다)는
--   NAS 사본에 영영 반영되지 않는다. 2026-10-02 실 NAS 검토에서 확인(당시 평가된 턴 0건 — 누락 없음).
--
-- 어떻게
--   평가된 턴만 보여 주는 뷰를 두고, 허용 목록에 (rated_at, id) 커서로 한 줄 등재한다.
--   · agent_turn 을 같은 방식으로 등재할 수는 없다 — rated_at 이 null 인 행이 있어 커서가 끊긴다
--     (허용 목록 주석: incremental 의 cursor_col·pk_col 은 not null 이어야 한다).
--   · 평가를 고치면 rated_at 이 올라가 다시 실린다(개선 대장 agent_improve 와 같은 「갱신 이력 누적」 방식).
--   · 질문·답변 원문은 싣지 않는다 — 턴 본문은 agent_turn 쪽 파일에 이미 있다. id 로 잇는다.
--
-- 보안
--   뷰는 호출자 권한(security_invoker)으로 돌고 anon·authenticated 권한을 걷는다 — REST 로 열리지 않는다.
--   NAS 워커는 정의자 권한 RPC(nas_export_page)로만 읽는다.
--
-- 되돌리기: 84_nas_export_turn_rating_rollback.sql

create or replace view public.v_agent_turn_rating
with (security_invoker = true) as
select t.id, t.agent_key, t.rating, t.rating_note, t.rated_at
  from public.agent_turn t
 where t.rated_at is not null;

revoke all on public.v_agent_turn_rating from anon, authenticated;

comment on view public.v_agent_turn_rating is
  'NAS 적재용 — 평가가 달린 대화 턴의 평가 값만(id 로 agent_turn 과 잇는다). 허용 목록 etl_meta.nas_export_source 의 agent_turn_rating 이 읽는다.';

insert into etl_meta.nas_export_source
  (source_key, kind, rel_schema, rel_name, mode, cursor_col, cursor_type, pk_col, pk_type, label_ko, enabled, note)
values
  ('agent_turn_rating', 'turns', 'public', 'v_agent_turn_rating', 'incremental',
   'rated_at', 'timestamptz', 'id', 'bigint', '대화 턴 평가', true,
   '턴을 내보낸 뒤에 달린 평가. 평가를 고치면 rated_at 이 올라가 다시 실린다(갱신 이력 누적). 본문은 agent_turn 파일에 — id 로 잇는다')
on conflict (source_key) do nothing;
