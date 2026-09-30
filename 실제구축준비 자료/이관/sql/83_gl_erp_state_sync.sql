-- 83 — 결의전표 ERP 상태 역동기화(게이트 G5, 2026-09-30 관리자 결정)
--
-- 정책(관리자 결정):
--   · 잘못 들어간 전표는 **수정하지 않고 ERP 에서 삭제**한다. 포털에서 ERP 로 삭제를 보내는 길은 없다.
--   · ERP 에서 삭제되면 포털은 그 사실을 **표시만** 한다 — ERP → 포털 단방향.
--   · 함께 승인 여부도 가져온다(미승인 / 승인 + 회계전표번호) — 승인 이후 프로세스 점검용.
--
-- 흐름: 서버 릴레이(queue 회차마다) → gl_erp_sync_targets 로 확인할 전표 목록 →
--       ERP A_TEMP_GL 을 읽기 전용으로 조회 → gl_erp_sync_record 로 결과 기록.
-- 삭제된 전표는 status='void'(종결) + void_reason 에 사유를 남긴다 — 다시 보낼 수 없다.
-- 다시 넣으려면 [전표복사] 로 새 전표를 만든다(원본 번호 재사용 금지 — 감사 추적).

alter table public.gl_draft
  add column if not exists erp_sync_state text,          -- null | unapproved | approved | deleted
  add column if not exists erp_final_gl_no text,         -- 승인 후 회계전표번호(A_TEMP_GL.GL_NO)
  add column if not exists erp_synced_at timestamptz,    -- 마지막 확인 시각
  add column if not exists erp_deleted_at timestamptz;   -- ERP 삭제를 처음 확인한 시각

do $$ begin
  alter table public.gl_draft add constraint gl_draft_erp_sync_state_check
    check (erp_sync_state is null or erp_sync_state in ('unapproved','approved','deleted'));
exception when duplicate_object then null; end $$;

-- 확인 대상 — ERP 에 들어간(posted) 전표 중 아직 삭제 확인이 안 된 것
create or replace function public.gl_erp_sync_targets(p_target text, p_limit int default 200)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(t), '[]'::jsonb) from (
    select d.draft_no, d.erp_temp_gl_no, d.erp_sync_state, d.erp_final_gl_no
      from public.gl_draft d
     where d.status = 'posted'
       and d.erp_apply_target = p_target
       and d.erp_temp_gl_no is not null
       and coalesce(d.erp_sync_state, '') <> 'deleted'
     order by d.erp_synced_at nulls first, d.posted_at desc
     limit greatest(1, least(coalesce(p_limit, 200), 500))
  ) t;
$$;

-- 결과 기록 — p: [{draft_no, state, gl_no}] · state = unapproved | approved | deleted
create or replace function public.gl_erp_sync_record(p jsonb, p_target text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; v_state text; n_upd int := 0; n_del int := 0;
begin
  for r in select * from jsonb_array_elements(coalesce(p, '[]'::jsonb)) loop
    v_state := r->>'state';
    if v_state not in ('unapproved','approved','deleted') then continue; end if;

    if v_state = 'deleted' then
      update public.gl_draft
         set erp_sync_state = 'deleted', erp_synced_at = now(),
             erp_deleted_at = coalesce(erp_deleted_at, now()),
             status = 'void',
             void_reason = format('ERP 에서 삭제됨(%s 확인) — 전표번호 %s. 다시 넣으려면 [전표복사]로 새 전표를 만드세요.',
                                  to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI'), erp_temp_gl_no),
             updated_at = now()
       where draft_no = r->>'draft_no' and erp_apply_target = p_target
         and status = 'posted' and coalesce(erp_sync_state, '') <> 'deleted';
      if found then n_del := n_del + 1; end if;
    else
      update public.gl_draft
         set erp_sync_state = v_state,
             erp_final_gl_no = nullif(btrim(coalesce(r->>'gl_no', '')), ''),
             erp_synced_at = now()
       where draft_no = r->>'draft_no' and erp_apply_target = p_target
         and status = 'posted';
      if found then n_upd := n_upd + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('updated', n_upd, 'deleted', n_del);
end $$;

revoke all on function public.gl_erp_sync_targets(text, int) from public, anon, authenticated;
revoke all on function public.gl_erp_sync_record(jsonb, text) from public, anon, authenticated;
grant execute on function public.gl_erp_sync_targets(text, int) to service_role;
grant execute on function public.gl_erp_sync_record(jsonb, text) to service_role;
