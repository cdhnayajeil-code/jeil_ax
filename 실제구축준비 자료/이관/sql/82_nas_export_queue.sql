-- 82_nas_export_queue.sql — 사내 NAS 적재 큐 · 허용 목록 · 커서 (REQ-0097 · 2026-09-30)
-- 정본. 적용 마이그레이션: nas_export_queue_v1 (2026-09-30 · 이 파일의 begin/commit 만 벗겨 적용)
-- 워커: 10_ERP_DB연계/etl/nas_worker.py (러너 서브커맨드 `jeil_runner nas` · 작업 종류 nas_sync)
-- 기획: 13_NAS_고도화/01_NAS_데이터계층_기획.md (안 D — 역방향 큐) · ADR-110
--
-- 왜 큐인가 — 29번(ERP 데이터 업데이트 큐)과 같은 이유, 방향만 반대다
--   사내 NAS 는 **사내 내부망·내부 방화벽 안**이라 Supabase Edge·브라우저가 NAS 로 들어갈 수 없다.
--   터널을 뚫으면 「외부 세션이 내부존에서 종단」되어 보안 승인·세그먼트 검토·네임서버 이관이 따라온다.
--   그래서 방향을 뒤집는다 — NAS(또는 사내 호스트)의 워커가 **밖으로만** 연결해 이 큐를 집어가고,
--   내보낼 데이터도 이 RPC 로 페이지 단위로 받아 NAS 파일로 쓴다. 인바운드 0 · 방화벽 룰 추가 0건.
--   이 구조는 이미 운영 중이다(사외 IDC ERP 서버의 jeil_runner → etl_meta.sync_request).
--
-- 왜 큐·심박을 ERP 것과 **따로** 두는가 (재사용하면 실제로 깨진다)
--   ① `erp_sync_request_claim` 은 능력 구분 없이 **먼저 온 러너가** 요청을 집는다(deploy/README.md §C-0).
--      능력별 분기 `49_runner_capability_online.sql` 은 아직 미적용(REQ-0052) → NAS 워커가 ERP 적재 요청을
--      집어 실패시킨다.
--   ② `erp_sync_request_create` 의 러너 생존 판정은 `runner_heartbeat` 에 **3분 내 심박이 아무거나** 있으면
--      참이다 → NAS 워커만 켜져 있어도 화면이 「곧 집어갑니다」로 오안내한다.
--   따라서 `etl_meta.nas_request` · `etl_meta.nas_heartbeat` 를 신설한다. SQL 49 승인에 의존하지 않는다.
--
-- 보안(CLAUDE.md §1·§4·§5)
--   · 표는 전부 etl_meta(REST 미노출) + RLS on + **정책 0** + anon/authenticated revoke → public RPC 로만 접근.
--     (45번이 이 두 줄을 빠뜨려 라이브에 RLS 꺼진 표가 남아 있다 — 같은 실수를 반복하지 않는다.)
--   · 요청 생성·조회는 사내 세션(is_internal)만, 집행(claim/progress/finish/ping/export/commit)은 service_role 만.
--   · 내보낼 수 있는 것은 **허용 목록(nas_export_source)에 등재된 public 관계뿐**이다. 스키마는 CHECK 로
--     'public' 만 허용하므로 급여(erp_secure)·인사평가는 등재 자체가 불가능하다(§1.7).
--   · 허용 목록 밖 소스는 **빈 결과가 아니라 예외**다. 0건 성공으로 읽히면 조용히 틀린다
--     (2026-08-31 refValid silent-pass 사고와 같은 모양 — REQ-0015).
--
-- 되돌리기: 82_nas_export_queue_rollback.sql

begin;

create schema if not exists etl_meta;

-- ── 1. 적재 요청 큐 ───────────────────────────────────────
create table if not exists etl_meta.nas_request (
  request_id      uuid primary key default gen_random_uuid(),
  requested_at    timestamptz not null default now(),
  requested_by    text not null default '',           -- 요청자 이메일(감사용)
  kind            text not null default 'turns'
                  check (kind in ('turns','erp_snapshot')),
  sources         text[] not null default '{}',       -- 비우면 그 kind 의 활성 소스 전체
  status          text not null default 'queued'
                  check (status in ('queued','running','done','failed')),
  claimed_at      timestamptz,
  finished_at     timestamptz,
  worker          text,                               -- 집행 호스트명
  progress_done   int not null default 0,
  progress_total  int not null default 0,
  progress_source text,                               -- 지금 내보내는 소스
  rows_read       int not null default 0,
  files_written   int not null default 0,
  result          jsonb,                              -- 소스별 {source,status,rows,bytes,sha256,file,error}
  error_msg       text
);

create index if not exists nas_request_status_idx on etl_meta.nas_request (status, requested_at);

alter table etl_meta.nas_request enable row level security;   -- 정책 0 = RPC(정의자 권한) 전용
revoke all on etl_meta.nas_request from anon, authenticated;

comment on table etl_meta.nas_request is
  'NAS 적재 요청 큐. 화면·CLI 가 요청을 남기면 사내 NAS 워커(nas_worker.py)가 집어가 JSONL 로 내보내고 결과를 되쓴다. ERP 큐(sync_request)와 섞지 않는다 — 러너 경쟁·가동 오판정을 막기 위해서다.';

-- ── 2. NAS 워커 심박 ─────────────────────────────────────
-- ERP 러너 심박(runner_heartbeat)과 별 표인 이유는 파일 머리 ② 참조.
create table if not exists etl_meta.nas_heartbeat (
  worker  text primary key,
  seen_at timestamptz not null default now(),
  note    text                                        -- 능력·버전 표식 (예: +nas r1.0 root=ok)
);
alter table etl_meta.nas_heartbeat enable row level security;
revoke all on etl_meta.nas_heartbeat from anon, authenticated;

-- ── 3. 내보내기 허용 목록 (무엇을 내보낼 수 있는가의 단일 출처) ──
-- 워커에 SQL·소스 목록을 심지 않는다 — 이 표가 정본이고, 백업 등 새 용도는 행 추가로 늘린다
-- (그리드·조회바 표준의 §13.3·§16.3 과 같은 원칙: 도구는 UI·전송만, 정의는 한 곳).
create table if not exists etl_meta.nas_export_source (
  source_key  text primary key,
  kind        text not null check (kind in ('turns','erp_snapshot')),
  rel_schema  text not null default 'public' check (rel_schema = 'public'),
  rel_name    text not null check (rel_name  ~ '^[a-z_][a-z0-9_]*$'),
  mode        text not null check (mode in ('incremental','full')),
  -- incremental: (cursor_col, pk_col) 키셋. 두 컬럼 모두 **not null 이어야** 한다(null 이면 커서가 끊긴다).
  cursor_col  text check (cursor_col is null or cursor_col ~ '^[a-z_][a-z0-9_]*$'),
  cursor_type text check (cursor_type is null or cursor_type in ('bigint','integer','timestamptz','date','text','uuid')),
  pk_col      text check (pk_col is null or pk_col ~ '^[a-z_][a-z0-9_]*$'),
  pk_type     text check (pk_type is null or pk_type in ('bigint','integer','timestamptz','date','text','uuid')),
  label_ko    text not null,
  enabled     boolean not null default true,
  note        text,
  constraint nas_export_source_mode_cols check (
    (mode = 'incremental' and cursor_col is not null and cursor_type is not null
                          and pk_col is not null and pk_type is not null)
 or (mode = 'full')
  )
);
alter table etl_meta.nas_export_source enable row level security;
revoke all on etl_meta.nas_export_source from anon, authenticated;

comment on table etl_meta.nas_export_source is
  'NAS 로 내보낼 수 있는 관계의 허용 목록(단일 출처). rel_schema 는 public 만 — 급여(erp_secure)는 등재 자체가 불가능하다. full 은 전량 스냅샷(행 전체 기준 전순서), incremental 은 (cursor_col, pk_col) 키셋.';

-- ── 4. 증분 커서 ─────────────────────────────────────────
-- 파일 기록이 **성공한 뒤에만** 전진한다(nas_export_commit) → 중단되면 같은 지점부터 다시 한다.
create table if not exists etl_meta.nas_export_state (
  source_key  text primary key references etl_meta.nas_export_source(source_key) on delete cascade,
  last_cursor text,
  last_pk     text,
  last_run_at timestamptz,
  rows_total  bigint not null default 0
);
alter table etl_meta.nas_export_state enable row level security;
revoke all on etl_meta.nas_export_state from anon, authenticated;

-- ── 5. 사용자용 RPC (사내 세션 전용) ─────────────────────
-- 5-1. 요청 생성 — 화면이 보낸 소스 목록을 믿지 않는다(38번 원칙: 조건 미달은 조용히 버리지 않고 거부)
create or replace function public.nas_request_create(
  p_kind text default 'turns', p_sources text[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  v_email  text := coalesce(auth.jwt() ->> 'email', '');
  v_kind   text := coalesce(nullif(btrim(p_kind), ''), 'turns');
  v_src    text[] := coalesce(p_sources, '{}'::text[]);
  v_bad    text;
  v_online boolean;
  v_last   timestamptz;
  r        etl_meta.nas_request%rowtype;
begin
  if not public.is_internal() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_kind not in ('turns','erp_snapshot') then
    raise exception 'nas_request_create: 모르는 kind(%)', v_kind using errcode = '22023';
  end if;

  select string_agg(x, ', ') into v_bad
    from unnest(v_src) as x
   where not exists (select 1 from etl_meta.nas_export_source s
                      where s.source_key = x and s.enabled and s.kind = v_kind);
  if v_bad is not null then
    raise exception 'nas_request_create: 허용 목록에 없는 소스(%)', v_bad using errcode = '42501';
  end if;

  select exists(select 1 from etl_meta.nas_heartbeat where seen_at > now() - interval '3 minutes')
    into v_online;

  -- 같은 kind 의 대기·진행 건이 있으면 새로 만들지 않고 그것을 돌려준다
  select * into r from etl_meta.nas_request
   where status in ('queued','running') and kind = v_kind and requested_at > now() - interval '2 hours'
   order by requested_at limit 1;
  if found then
    return jsonb_build_object('ok', true, 'reused', true, 'worker_online', v_online,
      'request_id', r.request_id, 'kind', r.kind, 'status', r.status, 'requested_at', r.requested_at,
      'requested_by', r.requested_by, 'claimed_at', r.claimed_at, 'finished_at', r.finished_at,
      'worker', r.worker, 'progress_done', r.progress_done, 'progress_total', r.progress_total,
      'progress_source', r.progress_source, 'rows_read', r.rows_read, 'files_written', r.files_written,
      'result', r.result, 'error_msg', r.error_msg);
  end if;

  select max(finished_at) into v_last from etl_meta.nas_request where status in ('done','failed');
  if v_last is not null and v_last > now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'cooldown', true, 'worker_online', v_online,
      'wait_sec', ceil(extract(epoch from (v_last + interval '60 seconds' - now())))::int);
  end if;

  insert into etl_meta.nas_request (requested_by, kind, sources)
  values (v_email, v_kind, v_src)
  returning * into r;

  return jsonb_build_object('ok', true, 'reused', false, 'worker_online', v_online,
    'request_id', r.request_id, 'kind', r.kind, 'status', r.status, 'requested_at', r.requested_at,
    'requested_by', r.requested_by, 'claimed_at', null, 'finished_at', null, 'worker', null,
    'progress_done', 0, 'progress_total', 0, 'progress_source', null,
    'rows_read', 0, 'files_written', 0, 'result', null, 'error_msg', null);
end;
$fn$;

-- 5-2. 요청 상태 조회
create or replace function public.nas_request_status(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  r        etl_meta.nas_request%rowtype;
  v_online boolean;
begin
  if not public.is_internal() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select exists(select 1 from etl_meta.nas_heartbeat where seen_at > now() - interval '3 minutes')
    into v_online;
  select * into r from etl_meta.nas_request where request_id = p_request_id;
  if not found then
    return jsonb_build_object('ok', false, 'not_found', true, 'worker_online', v_online);
  end if;
  return jsonb_build_object('ok', true, 'worker_online', v_online,
    'request_id', r.request_id, 'kind', r.kind, 'status', r.status, 'requested_at', r.requested_at,
    'requested_by', r.requested_by, 'claimed_at', r.claimed_at, 'finished_at', r.finished_at,
    'worker', r.worker, 'progress_done', r.progress_done, 'progress_total', r.progress_total,
    'progress_source', r.progress_source, 'rows_read', r.rows_read, 'files_written', r.files_written,
    'result', r.result, 'error_msg', r.error_msg);
end;
$fn$;

-- ── 6. 집행 RPC (service_role 전용) ──────────────────────
-- 6-1. 심박
create or replace function public.nas_runner_ping(p_worker text, p_note text default null)
returns void
language sql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
  insert into etl_meta.nas_heartbeat (worker, seen_at, note)
  values (coalesce(nullif(btrim(p_worker), ''), 'unknown'), now(), left(p_note, 200))
  on conflict (worker) do update set seen_at = now(), note = excluded.note;
$fn$;

-- 6-2. 선점 — 29번의 4단 관용구(좀비 정리 → 만료 정리 → skip locked 1건 → 없으면 null)
create or replace function public.nas_request_claim(p_worker text)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  r etl_meta.nas_request%rowtype;
begin
  update etl_meta.nas_request
     set status = 'failed', finished_at = now(),
         error_msg = coalesce(error_msg, 'NAS 워커 응답 없음(2시간 타임아웃)')
   where status = 'running' and claimed_at < now() - interval '2 hours';

  update etl_meta.nas_request
     set status = 'failed', finished_at = now(),
         error_msg = coalesce(error_msg, 'NAS 워커 미가동으로 만료(4시간)')
   where status = 'queued' and requested_at < now() - interval '4 hours';

  update etl_meta.nas_request q
     set status = 'running', claimed_at = now(), worker = p_worker
   where q.request_id = (
     select x.request_id from etl_meta.nas_request x
      where x.status = 'queued'
      order by x.requested_at
      for update skip locked
      limit 1)
  returning * into r;

  if not found then return null; end if;

  return jsonb_build_object('request_id', r.request_id, 'kind', r.kind, 'sources', r.sources,
                            'requested_by', r.requested_by, 'requested_at', r.requested_at);
end;
$fn$;

-- 6-3. 진행률
create or replace function public.nas_request_progress(
  p_request_id uuid, p_done int, p_total int, p_source text,
  p_rows_read int default null, p_files int default null)
returns void
language sql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
  update etl_meta.nas_request
     set progress_done   = p_done,
         progress_total  = p_total,
         progress_source = p_source,
         rows_read       = coalesce(p_rows_read, rows_read),
         files_written   = coalesce(p_files, files_written)
   where request_id = p_request_id and status = 'running';
$fn$;

-- 6-4. 종료
create or replace function public.nas_request_finish(
  p_request_id uuid, p_status text, p_result jsonb default null,
  p_rows_read int default null, p_files int default null, p_error text default null)
returns void
language sql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
  update etl_meta.nas_request
     set status          = case when p_status in ('done','failed') then p_status else 'failed' end,
         finished_at     = now(),
         progress_source = null,
         result          = coalesce(p_result, result),
         rows_read       = coalesce(p_rows_read, rows_read),
         files_written   = coalesce(p_files, files_written),
         error_msg       = left(p_error, 1000)
   where request_id = p_request_id;
$fn$;

-- 6-5. 내보낼 소스 목록 + 현재 커서
create or replace function public.nas_export_sources(p_kind text default null)
returns jsonb
language sql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'source_key',  s.source_key,
           'kind',        s.kind,
           'mode',        s.mode,
           'label_ko',    s.label_ko,
           'rel',         s.rel_schema || '.' || s.rel_name,
           'cursor_col',  s.cursor_col,
           'pk_col',      s.pk_col,
           'last_cursor', st.last_cursor,
           'last_pk',     st.last_pk,
           'last_run_at', st.last_run_at,
           'rows_total',  coalesce(st.rows_total, 0)
         ) order by s.kind, s.source_key), '[]'::jsonb)
    from etl_meta.nas_export_source s
    left join etl_meta.nas_export_state st on st.source_key = s.source_key
   where s.enabled
     and (p_kind is null or s.kind = p_kind);
$fn$;

-- 6-6. 남은 건수 — 전량 스냅샷의 **행수 대조**에 쓴다(페이지네이션이 행을 빠뜨렸는지 검출)
create or replace function public.nas_export_count(
  p_source text, p_after_cursor text default null, p_after_pk text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  s     etl_meta.nas_export_source%rowtype;
  v_sql text;
  v_n   bigint;
begin
  select * into s from etl_meta.nas_export_source where source_key = p_source and enabled;
  if not found then
    raise exception 'nas_export_count: 허용 목록에 없는 소스(%)', p_source using errcode = '42501';
  end if;

  if s.mode = 'incremental' and p_after_cursor is not null then
    if p_after_pk is null then
      raise exception 'nas_export_count: 커서를 주면 pk 도 함께 주어야 한다(%)', p_source using errcode = '22023';
    end if;
    v_sql := format($q$select count(*) from %3$I.%4$I where (%1$I, %2$I) > ($1::%5$s, $2::%6$s)$q$,
                    s.cursor_col, s.pk_col, s.rel_schema, s.rel_name, s.cursor_type, s.pk_type);
    execute v_sql into v_n using p_after_cursor, p_after_pk;
  else
    v_sql := format($q$select count(*) from %1$I.%2$I$q$, s.rel_schema, s.rel_name);
    execute v_sql into v_n;
  end if;

  return jsonb_build_object('source', s.source_key, 'mode', s.mode, 'count', v_n, 'as_of', now());
end;
$fn$;

-- 6-7. 한 페이지 내보내기
--   incremental: (cursor_col, pk_col) 키셋. **커서를 text 로 비교하지 않는다** — '9' > '10' 이 참이 되어
--     bigint 증분이 9번째 행에서 멈춘다. 그래서 허용 목록이 컬럼의 원래 타입을 갖고, 여기서 캐스팅한다.
--   full: 행 전체(jsonb)를 기준으로 **전순서**를 잡고 offset 으로 나눈다. 단일 컬럼 정렬 + offset 은
--     같은 값이 여럿일 때 페이지 경계에서 행을 중복·누락시키는데, 그것이 조용히 일어난다.
--     jsonb 비교는 전순서이고, 완전히 같은 행은 서로 바꿔도 결과 집합이 같으므로 안전하다.
create or replace function public.nas_export_page(
  p_source text, p_after_cursor text default null, p_after_pk text default null, p_limit int default 500)
returns jsonb
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  s        etl_meta.nas_export_source%rowtype;
  v_n      int := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_sql    text;
  v_rows   jsonb;
  v_cnt    int;
  v_cursor text;
  v_pk     text;
  v_off    bigint;
begin
  select * into s from etl_meta.nas_export_source where source_key = p_source and enabled;
  if not found then
    -- 빈 결과로 돌려주면 「0건 성공」으로 읽혀 조용히 틀린다 — 예외로 드러낸다(REQ-0015 교훈)
    raise exception 'nas_export_page: 허용 목록에 없는 소스(%)', p_source using errcode = '42501';
  end if;

  if s.mode = 'incremental' then
    if p_after_cursor is not null and p_after_pk is null then
      raise exception 'nas_export_page: 커서를 주면 pk 도 함께 주어야 한다(%)', p_source using errcode = '22023';
    end if;
    v_sql := format($q$
      select coalesce(jsonb_agg(to_jsonb(t) order by t.%1$I, t.%2$I), '[]'::jsonb)
        from (select * from %3$I.%4$I
               where $1 is null or (%1$I, %2$I) > ($1::%5$s, $2::%6$s)
               order by %1$I, %2$I
               limit %7$s) t $q$,
      s.cursor_col, s.pk_col, s.rel_schema, s.rel_name, s.cursor_type, s.pk_type, v_n);
    execute v_sql into v_rows using p_after_cursor, p_after_pk;
  else
    v_off := greatest(coalesce(p_after_cursor::bigint, 0), 0);
    v_sql := format($q$
      select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)), '[]'::jsonb)
        from (select * from %1$I.%2$I as src order by to_jsonb(src) offset %3$s limit %4$s) t $q$,
      s.rel_schema, s.rel_name, v_off, v_n);
    execute v_sql into v_rows;
  end if;

  v_cnt := jsonb_array_length(v_rows);

  if s.mode = 'incremental' then
    if v_cnt = 0 then
      v_cursor := p_after_cursor; v_pk := p_after_pk;
    else
      v_cursor := (v_rows -> (v_cnt - 1)) ->> s.cursor_col;
      v_pk     := (v_rows -> (v_cnt - 1)) ->> s.pk_col;
    end if;
  else
    v_cursor := (v_off + v_cnt)::text;   -- 전량 모드의 커서는 이 회차 안의 offset 이다
    v_pk     := null;
  end if;

  return jsonb_build_object(
    'source',      s.source_key,
    'mode',        s.mode,
    'rel',         s.rel_schema || '.' || s.rel_name,
    'count',       v_cnt,
    'has_more',    v_cnt >= v_n,
    'next_cursor', v_cursor,
    'next_pk',     v_pk,
    'as_of',       now(),
    'rows',        v_rows);
end;
$fn$;

-- 6-8. 커서 전진 — 파일 기록이 **성공한 뒤에만** 부른다
create or replace function public.nas_export_commit(
  p_source text, p_last_cursor text default null, p_last_pk text default null, p_rows int default 0)
returns void
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  s etl_meta.nas_export_source%rowtype;
begin
  select * into s from etl_meta.nas_export_source where source_key = p_source and enabled;
  if not found then
    raise exception 'nas_export_commit: 허용 목록에 없는 소스(%)', p_source using errcode = '42501';
  end if;

  insert into etl_meta.nas_export_state as st (source_key, last_cursor, last_pk, last_run_at, rows_total)
  values (p_source,
          case when s.mode = 'full' then null else p_last_cursor end,   -- 전량 스냅샷은 커서를 남기지 않는다
          case when s.mode = 'full' then null else p_last_pk     end,
          now(), greatest(coalesce(p_rows, 0), 0))
  on conflict (source_key) do update
     set last_cursor = case when s.mode = 'full' then null else coalesce(excluded.last_cursor, st.last_cursor) end,
         last_pk     = case when s.mode = 'full' then null else coalesce(excluded.last_pk,     st.last_pk)     end,
         last_run_at = now(),
         rows_total  = st.rows_total + greatest(coalesce(p_rows, 0), 0);
end;
$fn$;

-- ── 7. 허용 목록 시드 ────────────────────────────────────
-- 기록(turns) — 부서 에이전트 누적 데이터. cursor_col·pk_col 은 모두 not null 컬럼이어야 한다.
insert into etl_meta.nas_export_source
  (source_key, kind, rel_name, mode, cursor_col, cursor_type, pk_col, pk_type, label_ko, note)
values
  ('agent_turn',       'turns', 'agent_turn',       'incremental', 'id',         'bigint',      'id', 'bigint',
   '에이전트 대화 턴', '질문·답변·도구요약·모델·토큰·비용. 개인정보 포함 — NAS 폴더 권한은 시스템·관리자 전용(§1.7)'),
  ('agent_artifact',   'turns', 'agent_artifact',   'incremental', 'created_at', 'timestamptz', 'id', 'uuid',
   '생성 자료 메타',   'Storage 원본이 아니라 메타(경로·크기·만료)만. 원본 이관은 별건'),
  ('agent_improve',    'turns', 'agent_improve',    'incremental', 'updated_at', 'timestamptz', 'id', 'bigint',
   '개선 대장',        '상태가 바뀌면 updated_at 이 올라가 다시 실린다(갱신 이력이 누적된다)'),
  ('agent_golden_run', 'turns', 'agent_golden_run', 'incremental', 'id',         'bigint',      'id', 'bigint',
   '골든셋 회귀 이력', null)
on conflict (source_key) do nothing;

-- ERP 스냅샷(erp_snapshot) — 중간DB 복제본의 복구용 스냅샷. 원천은 그대로 두고 읽기만 한다.
-- erp_ro 는 REST 비노출이라 public.v_erp_* 뷰를 쓴다(08번 원칙). 급여·인사평가는 여기에 없다.
insert into etl_meta.nas_export_source
  (source_key, kind, rel_name, mode, label_ko, note)
values
  ('v_erp_pur_order',        'erp_snapshot', 'v_erp_pur_order',        'full', '발주(PO) 라인',      null),
  ('v_erp_pur_req',          'erp_snapshot', 'v_erp_pur_req',          'full', '구매요청(PR)',       null),
  ('v_erp_pur_list',         'erp_snapshot', 'v_erp_pur_list',         'full', '발주통합 LIST',      null),
  ('v_erp_purchase_monthly', 'erp_snapshot', 'v_erp_purchase_monthly', 'full', '월별 매입(거래처)',  null),
  ('v_erp_sales_monthly',    'erp_snapshot', 'v_erp_sales_monthly',    'full', '월별 수주·매출',     null),
  ('v_erp_inventory_daily',  'erp_snapshot', 'v_erp_inventory_daily',  'full', '일별 입출고·재고',   null),
  ('v_erp_item',             'erp_snapshot', 'v_erp_item',             'full', '품목 마스터',        '약 6만 행 — 페이지 5,000 기준 12회차'),
  ('v_erp_user_dept',        'erp_snapshot', 'v_erp_user_dept',        'full', '사용자-부서 매핑',   '직원 이름 포함(마스킹 예외 §1.7) — 급여·평가 값은 없다'),
  ('v_erp_dept_roster',      'erp_snapshot', 'v_erp_dept_roster',      'full', '부서 인원 명부',     null)
on conflict (source_key) do nothing;

-- ── 8. 권한 ──────────────────────────────────────────────
revoke all on function public.nas_request_create(text, text[]) from public, anon;
revoke all on function public.nas_request_status(uuid)         from public, anon;
grant execute on function public.nas_request_create(text, text[]) to authenticated, service_role;
grant execute on function public.nas_request_status(uuid)         to authenticated, service_role;

revoke all on function public.nas_runner_ping(text, text)                              from public, anon, authenticated;
revoke all on function public.nas_request_claim(text)                                  from public, anon, authenticated;
revoke all on function public.nas_request_progress(uuid, int, int, text, int, int)      from public, anon, authenticated;
revoke all on function public.nas_request_finish(uuid, text, jsonb, int, int, text)     from public, anon, authenticated;
revoke all on function public.nas_export_sources(text)                                 from public, anon, authenticated;
revoke all on function public.nas_export_count(text, text, text)                        from public, anon, authenticated;
revoke all on function public.nas_export_page(text, text, text, int)                    from public, anon, authenticated;
revoke all on function public.nas_export_commit(text, text, text, int)                  from public, anon, authenticated;
grant execute on function public.nas_runner_ping(text, text)                              to service_role;
grant execute on function public.nas_request_claim(text)                                  to service_role;
grant execute on function public.nas_request_progress(uuid, int, int, text, int, int)      to service_role;
grant execute on function public.nas_request_finish(uuid, text, jsonb, int, int, text)     to service_role;
grant execute on function public.nas_export_sources(text)                                 to service_role;
grant execute on function public.nas_export_count(text, text, text)                        to service_role;
grant execute on function public.nas_export_page(text, text, text, int)                    to service_role;
grant execute on function public.nas_export_commit(text, text, text, int)                  to service_role;

commit;

-- ── 확인 쿼리 ────────────────────────────────────────────
-- select source_key, kind, mode, rel_name, label_ko from etl_meta.nas_export_source order by kind, source_key;
-- select * from public.nas_export_sources('turns');
-- select public.nas_export_count('agent_turn');
-- select jsonb_build_object('count', (public.nas_export_page('agent_turn', null, null, 3)) -> 'count',
--                          'next',  (public.nas_export_page('agent_turn', null, null, 3)) -> 'next_cursor');
-- select c.relname, c.relrowsecurity, coalesce(array_to_string(c.relacl,' | '),'(default)')
--   from pg_class c join pg_namespace n on n.oid=c.relnamespace
--  where n.nspname='etl_meta' and c.relname like 'nas%';
