-- 31_gl_apply_plain_reasons.sql
-- 실패 사유를 사람 말로 — 「어디가 / 무엇이 / 어떻게」
-- 작성 2026-08-26 · 관리 최동혁 · 선행 `30_gl_apply_diag.sql`
--
-- ▣ 왜
--   사유가 화면에 뜨기 시작하니(30번) 이번엔 **읽히지 않는다**는 문제가 드러났다.
--   회계 담당자가 읽는 문장에 테이블명·컬럼명·ERP 오류번호가 그대로 들어가 있었다.
--
--   종전:
--     입력검증 차단 1건 — ERP에 아무것도 투입하지 않았습니다.
--     1번 줄 21100901(DR) — 미지급금(거래처)(AP) 채무 반제 방향 — 결의전표로 반제하면
--     원장 잔액이 정리되지 않는다. 채무 반제 전용화면에서 처리해야 한다(ERP 오류 119712)
--
--   지금:
--     1번 줄 미지급금(거래처) 차변 — 갚는 처리(반제)라서 결의전표로는 할 수 없습니다
--     → ERP 채무반제 화면에서 처리하세요
--
-- ▣ 규칙 세 가지
--   1. 계정은 **코드가 아니라 이름**으로 부른다(코드는 이름이 없을 때만).
--   2. 차대는 `DR`/`CR` 이 아니라 **차변/대변**으로 쓴다.
--   3. '무엇이 잘못됐다'로 끝내지 않고 **다음에 할 일**(`→`)을 붙인다.
--
--   기술 상세(계정코드·서브시스템·ERP 오류번호)는 `gl_erp_apply_log.detail` 에 그대로 남는다.
--   화면에서 덜어낸 것이지 버린 것이 아니다.
--
-- ▣ 구버전 릴레이 호환
--   서버 EXE 가 아직 구버전이면 가드 블록에 `what`/`fix` 가 없고 `why` 만 온다.
--   그때는 `why` 를 그대로 쓴다 — 배포 시차 때문에 사유가 통째로 비는 일이 없게 한다.

begin;

create or replace function public.gl_apply_record(p jsonb)
 returns bigint language plpgsql security definer set search_path to ''
as $function$
declare v_id bigint; v_err text; v_blocks text; v_n int;
begin
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
     coalesce(p->>'mode','dryrun'), coalesce(p->>'status','failed'), p->>'msg_cd',
     nullif(p->>'lines_in','')::int, nullif(p->>'lines_out','')::int,
     nullif(p->>'line_match','')::boolean, p->'detail', p->>'applied_by')
  returning id into v_id;

  if p->'detail' ? 'guard_blocks' then
    v_n := jsonb_array_length(p->'detail'->'guard_blocks');
    select string_agg(
             -- 어디가: 줄번호 · 계정이름 · 차변/대변  (전표 전체 문제면 위치를 붙이지 않는다)
             case when coalesce(b->>'seq','0') = '0' then ''
                  else format('%s번 줄 %s %s — ', b->>'seq',
                              coalesce(nullif(b->>'nm',''), b->>'acct'),
                              case b->>'fg' when 'DR' then '차변' else '대변' end)
             end
             -- 무엇이 + 어떻게 (구버전 릴레이는 why 만 보낸다)
             || coalesce(nullif(b->>'what',''), b->>'why', '확인이 필요합니다')
             || coalesce(E'\n→ ' || nullif(b->>'fix',''), ''),
             E'\n\n' order by (b->>'seq')::int)
      into v_blocks from jsonb_array_elements(p->'detail'->'guard_blocks') b;
    v_err := case when v_n > 1 then format('고칠 곳이 %s군데입니다.', v_n) || E'\n\n' else '' end
             || v_blocks;
  else
    v_err := nullif(btrim(coalesce(p->>'msg_cd','') || ' ' || coalesce(p->'detail'->>'error','')), '');
    v_err := regexp_replace(coalesce(v_err,''), '^\[(중단|실패|오류)\]\s*', '');  -- 옛 콘솔 접두 제거
    v_err := nullif(v_err, '');
  end if;

  if coalesce(p->>'mode','') = 'commit' and coalesce(p->>'status','') = 'success' then
    update public.gl_draft
       set erp_apply_target = p->>'target_db', erp_apply_status = 'applied',
           erp_apply_gl_no = p->>'gl_no', erp_apply_at = now(), erp_apply_msg = null,
           erp_last_error = null, erp_last_error_at = null, erp_ready_at = null,
           erp_attempts = coalesce(erp_attempts,0) + 1,
           status = case when status = 'submitted' then 'posted' else status end,
           erp_temp_gl_no = coalesce(erp_temp_gl_no, p->>'gl_no'),
           posted_by = coalesce(posted_by, p->>'applied_by'),
           posted_at = coalesce(posted_at, now()), updated_at = now()
     where draft_no = p->>'draft_no';
  elsif coalesce(p->>'mode','') = 'commit' then
    update public.gl_draft
       set erp_apply_target = p->>'target_db', erp_apply_status = 'failed',
           erp_apply_at = now(),
           erp_apply_msg = left(coalesce(v_err,'사유가 기록되지 않았습니다'), 300),
           erp_last_error = left(coalesce(v_err,'사유가 기록되지 않았습니다'), 2000),
           erp_last_error_at = now(), erp_ready_at = null,
           erp_attempts = coalesce(erp_attempts,0) + 1, updated_at = now()
     where draft_no = p->>'draft_no';
  elsif coalesce(p->>'mode','') = 'precheck' then
    update public.gl_draft
       set erp_last_error = case
             when coalesce(p->>'status','') = 'success'
               then '지금 보내면 정상 처리됩니다. (점검 '
                    || to_char(now() at time zone 'Asia/Seoul', 'MM-DD HH24:MI') || ')'
             else left(coalesce(v_err,'확인이 필요합니다'), 2000) end,
           erp_last_error_at = now(), updated_at = now()
     where draft_no = p->>'draft_no';
  elsif coalesce(p->>'mode','') = 'cleanup' and coalesce(p->>'status','') = 'success' then
    update public.gl_draft
       set erp_apply_target = null, erp_apply_status = null, erp_apply_gl_no = null,
           erp_apply_at = null, erp_apply_msg = null,
           erp_last_error = null, erp_last_error_at = null, erp_ready_at = null,
           status = case when status = 'posted' then 'submitted' else status end,
           erp_temp_gl_no = null, posted_by = null, posted_at = null, updated_at = now()
     where draft_no = p->>'draft_no';
  end if;
  return v_id;
end $function$;


-- 점검 통과 문구가 바뀌었으므로 '문제 목록' 제외 조건도 함께 고친다.
-- (옛 문구도 계속 제외한다 — 이미 저장된 값이 남아 있다)
create or replace function public.gl_apply_problems(
  p_target text default 'JEILMNS_DEMO2', p_stale_min integer default 30)
 returns jsonb language sql security definer set search_path to ''
as $function$
  select coalesce(jsonb_agg(t order by t.rank, t.since), '[]'::jsonb) from (
    select d.draft_no, d.draft_dt, d.gl_desc, d.dept_nm, d.owner_nm,
           d.dr_total, d.erp_apply_status, d.erp_attempts,
           coalesce(d.erp_last_error,
                    case when d.erp_apply_status = 'failed' then d.erp_apply_msg end) as reason,
           d.erp_last_error_at,
           case when d.erp_apply_status = 'failed'  then 'failed'
                when d.erp_apply_status = 'sending' then 'stuck'
                when d.erp_apply_status = 'ready'   then 'stale'
                else 'precheck' end                                       as kind,
           case when d.erp_apply_status is null then 1 else 0 end         as rank,
           coalesce(d.erp_ready_at, d.erp_apply_at, d.erp_last_error_at, d.updated_at) as since,
           floor(extract(epoch from (now() - coalesce(d.erp_ready_at, d.erp_apply_at,
                 d.erp_last_error_at, d.updated_at))) / 60)::int          as wait_min
      from public.gl_draft d
     where d.status = 'submitted'
       and (d.erp_apply_status = 'failed'
         or (d.erp_apply_status = 'ready'
             and coalesce(d.erp_ready_at, d.updated_at) < now() - make_interval(mins => greatest(1, p_stale_min)))
         or (d.erp_apply_status = 'sending' and d.erp_apply_at < now() - interval '30 minutes')
         or (d.erp_apply_status is null and d.erp_attempts = 0
             and d.erp_last_error is not null
             and d.erp_last_error not like '지금 보내면 정상 처리됩니다%'
             and d.erp_last_error not like '현재 규칙으로는%'))
     limit 100) t;
$function$;

commit;
