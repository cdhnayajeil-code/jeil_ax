-- 93_nas_folder_file_fetch.sql — 부서 폴더의 파일을 화면으로 가져오기(DRI 에이전트 D1 · REQ-0112)
--
-- 90 의 내려받기는 「저장 대장(AI저장)에 있는 파일」만 가져온다. D1 은 사업운영팀이 NAS 공유폴더에 직접 넣은
-- 이미지·도면(DRI 폴더)을 화면에서 골라 에이전트에게 보여 줘야 하므로, **부서 폴더 안의 파일**도 가져올 수 있게 한다.
--
-- 지키는 것
--   · 어느 폴더인지는 여전히 DB 가 정한다 — 에이전트 담당 부서의 허용 폴더(nas_folder_scope) 하나뿐이다.
--   · 경로는 그 폴더 기준 상대 경로만(.. · 절대 경로 · 숨김 금지). 볼 수 있는 형식은 이미지·PDF 로 한정(워커도 다시 검사).
--   · 가져온 사본은 90 과 같이 임시 버킷 `_fetch/` 에 잠깐 머물고 10분 뒤 지워진다. 클라우드 DB 에 원본을 쌓지 않는다.
--   · 누가 무엇을 가져갔는지는 nas_fetch 에 남는다(upn · 경로 · 시각).
-- 워커 n1.8 부터 처리한다. 이전 워커(n1.7)가 이 요청을 집으면 「경로가 올바르지 않습니다」로 실패 처리된다(헛돌지 않는다).
-- 되돌리기: 93_nas_folder_file_fetch_rollback.sql

alter table etl_meta.nas_fetch alter column save_id drop not null;
alter table etl_meta.nas_fetch add column if not exists folder_key text;
alter table etl_meta.nas_fetch add column if not exists src_rel text;      -- 부서 폴더 기준 상대 경로(대장 밖 파일일 때)

-- ── 요청(게이트웨이) ──────────────────────────────────────────────────────────
create or replace function public.nas_file_fetch_submit(p_upn text, p_dept text, p_rel_path text)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  f     etl_meta.nas_folder_scope%rowtype;
  v_rel text := replace(btrim(coalesce(p_rel_path, '')), '\', '/');
  v_id  uuid := gen_random_uuid();
begin
  select * into f from etl_meta.nas_folder_scope where active and audience = 'dept' and dept_nm = p_dept order by folder_key limit 1;
  if not found then return jsonb_build_object('status', 'no_folder'); end if;
  if v_rel = '' or length(v_rel) > 400 or v_rel ~ '^/' or v_rel ~ '(^|/)\.\.?(/|$)' or v_rel ~ '(^|/)[.#@~]'
     or v_rel ~ '[:*?"<>|]' or v_rel ~ '[[:cntrl:]]' then
    return jsonb_build_object('status', 'bad_path');
  end if;
  if v_rel !~* '\.(png|jpe?g|gif|webp|pdf)$' then
    return jsonb_build_object('status', 'bad_type');
  end if;
  if v_rel ~* '급여|연봉|임금대장|인사평가|고과|주민등록|통장사본|신분증' then
    return jsonb_build_object('status', 'sensitive');
  end if;
  if not exists (select 1 from etl_meta.nas_query_worker where seen_at > now() - interval '60 seconds') then
    return jsonb_build_object('status', 'offline');
  end if;
  if (select count(*) from etl_meta.nas_fetch where upn = lower(p_upn) and created_at > now() - interval '1 minute') >= 20 then
    return jsonb_build_object('status', 'busy');
  end if;
  insert into etl_meta.nas_fetch (fetch_id, save_id, upn, out_path, folder_key, src_rel)
  values (v_id, null, lower(coalesce(p_upn, '')), '_fetch/' || v_id::text, f.folder_key, v_rel);
  return jsonb_build_object('status', 'queued', 'fetch_id', v_id, 'file_name', regexp_replace(v_rel, '^.*/', ''));
end;
$fn$;

-- ── 워커 일감 — 폴더 파일 가져오기를 함께 다룬다(90 의 정의를 바꾼다) ─────────
create or replace function public.nas_work_claim(p_worker text)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  j  jsonb;
  ft etl_meta.nas_fetch%rowtype;
  s  etl_meta.nas_save%rowtype;
  f  etl_meta.nas_folder_scope%rowtype;
begin
  if p_worker is null or p_worker !~ '^[A-Za-z0-9_.-]{1,60}$' then
    raise exception 'nas_work_claim: 워커 이름이 올바르지 않다' using errcode = '22023';
  end if;

  j := etl_meta.nas_save_take(p_worker, true);
  if j is not null then return j; end if;

  select * into ft from etl_meta.nas_fetch
   where created_at > now() - interval '2 minutes'
     and (status = 'queued' or (status = 'running' and claimed_at < now() - interval '30 seconds'))
   order by created_at
   limit 1
   for update skip locked;
  if found then
    if ft.save_id is null then
      -- 부서 폴더의 파일(대장 밖) — 폴더는 요청 때 DB 가 정해 둔 것만
      select * into f from etl_meta.nas_folder_scope where folder_key = ft.folder_key and active;
      if f.folder_key is null or ft.src_rel is null then
        update etl_meta.nas_fetch set status = 'failed', finished_at = now(), error_msg = '대상 폴더가 등록에서 빠졌다' where fetch_id = ft.fetch_id;
        return null;
      end if;
      update etl_meta.nas_fetch set status = 'running', claimed_at = now(), worker = p_worker where fetch_id = ft.fetch_id;
      return jsonb_build_object('job', 'fetch', 'fetch_id', ft.fetch_id, 'folder_key', f.folder_key, 'folder_rel', f.rel_path,
                                'src_rel', ft.src_rel);
    end if;
    select * into s from etl_meta.nas_save where save_id = ft.save_id and status = 'done';
    if found then
      select * into f from etl_meta.nas_folder_scope where folder_key = s.folder_key and active;
    end if;
    if s.save_id is null or f.folder_key is null or s.rel_path is null then
      update etl_meta.nas_fetch set status = 'failed', finished_at = now(), error_msg = '보관된 파일이 아니다' where fetch_id = ft.fetch_id;
      return null;
    end if;
    update etl_meta.nas_fetch set status = 'running', claimed_at = now(), worker = p_worker where fetch_id = ft.fetch_id;
    return jsonb_build_object('job', 'fetch', 'fetch_id', ft.fetch_id, 'folder_key', f.folder_key, 'folder_rel', f.rel_path,
                              'rel_path', s.rel_path, 'size_bytes', s.size_bytes);
  end if;

  if exists (select 1 from etl_meta.nas_save where status = 'purge' and error_msg is null) then
    return jsonb_build_object('job', 'purge');
  end if;

  if random() < 0.02 then
    update etl_meta.nas_fetch set status = 'failed', finished_at = now(), error_msg = '시간 초과'
     where status in ('queued', 'running') and created_at < now() - interval '2 minutes';
    delete from etl_meta.nas_fetch where created_at < now() - interval '30 days';
  end if;
  return null;
end;
$fn$;

-- ── 상태 확인 — 대장 밖 파일은 경로의 마지막 이름을 파일 이름으로 ─────────────
create or replace function public.nas_fetch_status(p_fetch_id uuid, p_upn text)
returns jsonb
language sql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
  select jsonb_build_object('status', ft.status, 'path', ft.out_path, 'error', ft.error_msg,
                            'file_name', coalesce(s.file_name, regexp_replace(ft.src_rel, '^.*/', '')))
    from etl_meta.nas_fetch ft left join etl_meta.nas_save s on s.save_id = ft.save_id
   where ft.fetch_id = p_fetch_id and ft.upn = lower(p_upn);
$fn$;

revoke all on function public.nas_file_fetch_submit(text, text, text) from public, anon, authenticated;
grant execute on function public.nas_file_fetch_submit(text, text, text) to service_role;
