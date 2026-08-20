-- =====================================================================
-- 26_gl_erp_apply.sql — 결의전표 ERP 직접등록(C-11) 원장·RPC
--   대상: 데모 DB DEMO2 전용 1차. 운영 DB 쓰기는 여전히 금지(C-1).
--   흐름: 포털 [ERP 전송] → erp_apply_status='ready' → 사내 pull 중계
--         (10_ERP_DB연계/etl/gl_apply_demo2.py --queue/--watch) → 결과 회기입
--   포털은 ERP에 직접 쓰지 않는다 — 여기 있는 것은 '요청 마킹'과 '결과 원장'뿐이다.
--
--   적용 이력(Supabase migration):
--     gl_erp_apply_v1 / v1b / v1c / v2      (2026-08-19)
--     gl_erp_apply_v3_autopost              (2026-08-20) 전송 성공 = 확정 처리
--     gl_apply_ready_submitted_only         (2026-08-20) 적용 대상은 제출됨만
-- =====================================================================

-- ── 1. 적용 원장 ─────────────────────────────────────────────────────
--   중계가 수행한 리허설(dryrun)·확정(commit)·정리(cleanup)를 모두 남긴다.
create table if not exists public.gl_erp_apply_log (
  id          bigserial primary key,
  draft_no    text not null,
  target_db   text not null,
  ref_no      text not null,               -- ERP A_BATCH.REF_NO (= 초안번호, 멱등키)
  batch_no    text,
  gl_no       text,                        -- ERP가 채번한 전표번호(AG 대역)
  trans_type  text,
  mode        text not null,               -- dryrun | commit | cleanup
  status      text not null,               -- success | failed | rolled_back
  msg_cd      text,
  lines_in    int,
  lines_out   int,
  line_match  boolean,
  detail      jsonb,
  applied_by  text,
  created_at  timestamptz not null default now()
);

-- 멱등 2중 잠금 — 같은 초안의 2회 성공 커밋, 같은 전표번호의 재사용을 DB가 막는다.
create unique index if not exists gl_erp_apply_once_idx
  on public.gl_erp_apply_log (target_db, draft_no)
  where mode = 'commit' and status = 'success';
create unique index if not exists gl_erp_apply_glno_idx
  on public.gl_erp_apply_log (target_db, gl_no)
  where mode = 'commit' and status = 'success' and gl_no is not null;
create index if not exists gl_erp_apply_draft_idx
  on public.gl_erp_apply_log (draft_no, created_at desc);

alter table public.gl_erp_apply_log enable row level security;   -- 정책 0개 = 전면 차단(service_role만 접근)

-- ── 2. 적용 대상 목록 ────────────────────────────────────────────────
--   '제출됨'만. 확정(posted)은 이미 ERP에 들어간 건(자동 전송 성공 또는 수기 등록)이라
--   목록에 넣으면 수기 등록분이 다시 투입돼 이중계상이 된다.
create or replace function public.gl_apply_ready(p_target text)
  returns jsonb language sql security definer set search_path to ''
as $$
  select coalesce(jsonb_agg(t), '[]'::jsonb) from (
    select d.draft_no, d.draft_dt, d.gl_desc, d.dept_cd, d.dept_nm, d.cost_cd,
           d.owner_erp_usr_id, d.dr_total, d.cr_total, d.submitted_at,
           d.erp_apply_status
    from public.gl_draft d
    where d.status = 'submitted'
      and not exists (select 1 from public.gl_erp_apply_log l
                       where l.draft_no = d.draft_no and l.target_db = p_target
                         and l.mode = 'commit' and l.status = 'success')
    order by d.submitted_at
    limit 50
  ) t;
$$;

-- ── 3. 전송 대기 큐 — 화면에서 [ERP 전송]을 누른 건만 ────────────────
create or replace function public.gl_apply_queue(p_target text)
  returns jsonb language sql security definer set search_path to ''
as $$
  select coalesce(jsonb_agg(t), '[]'::jsonb) from (
    select d.draft_no, d.draft_dt, d.gl_desc, d.dept_nm, d.dr_total, d.submitted_at
    from public.gl_draft d
    where d.status = 'submitted'
      and d.erp_apply_status = 'ready'
      and coalesce(d.erp_apply_target, p_target) = p_target
      and not exists (select 1 from public.gl_erp_apply_log l
                       where l.draft_no = d.draft_no and l.target_db = p_target
                         and l.mode = 'commit' and l.status = 'success')
    order by d.submitted_at
    limit 20
  ) t;
$$;

-- ── 4. 투입 원본 조회(헤더·라인·관리항목) ────────────────────────────
create or replace function public.gl_apply_fetch(p_draft_no text)
  returns jsonb language sql security definer set search_path to ''
as $$
  select jsonb_build_object(
    'header', to_jsonb(d),
    'items', (select coalesce(jsonb_agg(to_jsonb(i) order by i.item_seq), '[]'::jsonb)
              from public.gl_draft_item i where i.draft_no = d.draft_no),
    'ctrls', (select coalesce(jsonb_agg(jsonb_build_object(
                'item_seq', c.item_seq, 'ctrl_cd', c.ctrl_cd, 'ctrl_val', c.ctrl_val,
                'invoice_seq', c.invoice_seq) order by c.item_seq), '[]'::jsonb)
              from public.gl_draft_item_ctrl c where c.draft_no = d.draft_no)
  )
  from public.gl_draft d
  where d.draft_no = p_draft_no;
$$;

-- ── 5. 결과 회기입 ───────────────────────────────────────────────────
--   v3: 전송 성공 = 확정. 화면에서 'ERP 결의전표번호' 수기 입력칸을 없앴으므로
--       ERP가 채번한 번호를 그대로 전표번호로 기록하고 초안을 posted 로 닫는다.
--       cleanup 성공 시에는 확정까지 되돌려 데모 반복 테스트가 가능하게 한다.
create or replace function public.gl_apply_record(p jsonb)
  returns bigint language plpgsql security definer set search_path to ''
as $$
declare v_id bigint;
begin
  -- cleanup 성공 시: 기존 성공 커밋을 철회 처리(유니크 인덱스 해제 → 재적용 허용)
  if coalesce(p->>'mode','') = 'cleanup' and coalesce(p->>'status','') = 'success' then
    update public.gl_erp_apply_log
       set status = 'rolled_back',
           detail = coalesce(detail,'{}'::jsonb) || jsonb_build_object('superseded_by_cleanup', now())
     where draft_no = p->>'draft_no' and target_db = p->>'target_db'
       and mode = 'commit' and status = 'success';
  end if;

  insert into public.gl_erp_apply_log
    (draft_no, target_db, ref_no, batch_no, gl_no, trans_type, mode, status,
     msg_cd, lines_in, lines_out, line_match, detail, applied_by)
  values
    (p->>'draft_no', p->>'target_db', coalesce(p->>'ref_no', p->>'draft_no'),
     p->>'batch_no', p->>'gl_no', p->>'trans_type',
     coalesce(p->>'mode','dryrun'), coalesce(p->>'status','failed'),
     p->>'msg_cd',
     nullif(p->>'lines_in','')::int, nullif(p->>'lines_out','')::int,
     nullif(p->>'line_match','')::boolean,
     p->'detail', p->>'applied_by')
  returning id into v_id;

  if coalesce(p->>'mode','') = 'commit' and coalesce(p->>'status','') = 'success' then
    update public.gl_draft
       set erp_apply_target = p->>'target_db',
           erp_apply_status = 'applied',
           erp_apply_gl_no  = p->>'gl_no',
           erp_apply_at     = now(),
           erp_apply_msg    = null,
           status           = case when status = 'submitted' then 'posted' else status end,
           erp_temp_gl_no   = coalesce(erp_temp_gl_no, p->>'gl_no'),
           posted_by        = coalesce(posted_by, p->>'applied_by'),
           posted_at        = coalesce(posted_at, now()),
           updated_at       = now()
     where draft_no = p->>'draft_no';
  elsif coalesce(p->>'mode','') = 'commit' then
    update public.gl_draft
       set erp_apply_target = p->>'target_db',
           erp_apply_status = 'failed',
           erp_apply_msg    = left(coalesce(p->>'msg_cd','') || ' ' || coalesce(p->'detail'->>'error',''), 300),
           updated_at       = now()
     where draft_no = p->>'draft_no';
  elsif coalesce(p->>'mode','') = 'cleanup' and coalesce(p->>'status','') = 'success' then
    update public.gl_draft
       set erp_apply_target = null, erp_apply_status = null,
           erp_apply_gl_no = null, erp_apply_at = null, erp_apply_msg = null,
           status = case when status = 'posted' then 'submitted' else status end,
           erp_temp_gl_no = null, posted_by = null, posted_at = null,
           updated_at = now()
     where draft_no = p->>'draft_no';
  end if;
  return v_id;
end $$;

-- 실행 권한 — 사내 중계(service_role)만. anon/authenticated 는 호출 불가.
-- (라이브 확인 2026-08-20: 4개 함수 모두 postgres·service_role 만 EXECUTE 보유)
revoke execute on function public.gl_apply_ready(text)   from public, anon, authenticated;
revoke execute on function public.gl_apply_queue(text)   from public, anon, authenticated;
revoke execute on function public.gl_apply_fetch(text)   from public, anon, authenticated;
revoke execute on function public.gl_apply_record(jsonb) from public, anon, authenticated;
grant execute on function public.gl_apply_ready(text)   to service_role;
grant execute on function public.gl_apply_queue(text)   to service_role;
grant execute on function public.gl_apply_fetch(text)   to service_role;
grant execute on function public.gl_apply_record(jsonb) to service_role;
