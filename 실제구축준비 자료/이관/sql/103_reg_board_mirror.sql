-- 103_reg_board_mirror.sql — 사내규정 게시판 미러(public.reg_*) + 조문 파생 사본 + 적재·조회 RPC (REQ-0124 · 2026-10-08)
-- 마이그레이션: reg_board_mirror_req0124
--
-- 무엇을
--   1) public.reg_source      — 수집할 그룹웨어 게시판 등록표(단일 출처). 수집기(gw_board_collect.py)는 여기서 게시판·선택자를 읽는다.
--                               코드에 URL·선택자를 심지 않는다(§17.7 ② 와 같은 원칙). list_path 는 GW_URL 기준 **상대경로**만(호스트 금지 §1.1).
--   2) public.reg_post        — 게시물 원장(본문 Markdown·해시·첨부 서명·NAS 상대경로·판·상태) · reg_post_history(이전 판 요약)
--   3) public.reg_attachment  — 첨부 메타(이름·크기·sha256·NAS 경로·판독 상태 readable/unreadable/blocked/skipped·사유)
--   4) public.reg_document    — 규정 단위(게시물당 1건 · reg_key 로 묶음 · 제정/개정/시행일 · 파싱 상태 · 본문 출처 · is_current)
--   5) public.reg_article     — 조문(장·절·조·제목·본문·개정 꼬리표) — pg_trgm GIN 으로 본문·제목 검색
--   6) 적재 RPC(service_role 전용 · 사내 PC 수집기): reg_source_list · reg_ingest_upsert(jsonb · 멱등 · 판 변경 시 history+revision)
--      · reg_mark_removed(절반 안전장치) · reg_recalc_current(내부)
--   7) 조회 RPC(definer · 사내 로그인 전원 · service_role): reg_list · reg_get · reg_search · reg_status — 유일한 읽기 경로
--      (public 표는 RLS 전면차단 · 정책 0개 · anon/authenticated 권한 회수 — 메모리 definer-functions-revoke-anon-guard)
--
-- 왜(관리자 결정 2026-10-08 · D-153)
--   사내규정은 전 직원 공개 문서라 D-95(문서 내용은 사내 NAS 에만)의 **예외**로 본문·조문을 포털 DB 에 둔다.
--   정본 서열: 그룹웨어 게시판(원본·첨부는 NAS 00_전사공유/사내규정 미러) > 이 표들(규칙 기반 조문 파싱 · 재생성 가능한 파생 사본).
--   §19 의 doc_data(LLM 추출 · REQ-0117 S2)와 섞지 않는다 — 규정은 추출이 아니라 게시판 정본의 미러다.
--   한국어 검색에 tsvector 대신 pg_trgm 을 쓰는 이유: 기본 구성은 조사를 못 떼어 「수의계약은」이 「수의계약」에 안 걸린다
--   (NAS 색인이 SQLite trigram 을 고른 것과 같은 근거 · nas_index.py:7-8). 규모가 커지면 pgroonga 재검토.
--
-- 하지 않는 것
--   · 급여·인사평가·개인정보가 섞인 문서는 대상이 아니다 — 수집기가 주민등록번호 꼴 첨부·본문을 blocked 로 두고 글자를 넣지 않는다.
--   · 규정 편집·승인 워크플로 없음(읽기 전용 사본). 조문 원천이 아닌 첨부의 글자는 저장하지 않는다(메타만).
--   · erp_ro 를 건드리지 않는다. ERP 키와 잇지 않는다.
--
-- 적용 전 확인: pg_trgm 미설치(2026-10-08 list_extensions 실측) → 첫 줄에서 설치. 적용 뒤 역할 3종 실측(anon 42501 · internal ok · service_role ok).
-- 되돌리기: 103_reg_board_mirror_rollback.sql (표·함수 삭제 — 데이터는 NAS 에서 `gw_board_collect --full` 로 재적재 가능 · pg_trgm 은 남긴다)

create extension if not exists pg_trgm with schema extensions;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. 게시판 등록표
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.reg_source (
  board_key           text primary key check (board_key ~ '^[a-z0-9_]{1,40}$'),
  label_ko            text not null,
  list_path           text not null check (list_path ~ '^/' and list_path !~* '^https?:'),   -- GW_URL 기준 상대경로 · 호스트 금지(§1.1)
  selectors           jsonb,                       -- null = 수집기 기본 프로필(gw_board_profile.default.json) · 부분만 적어도 된다(한 단계 덮어쓰기)
  category            text,                        -- 이 게시판 규정의 기본 분류(인사·총무·구매 …)
  active              boolean not null default true,
  collect_attachments boolean not null default true,
  last_collected_at   timestamptz,
  last_post_no        text,
  last_result         jsonb,                       -- 마지막 회차 요약(new/changed/unchanged/blocked/seen/pages/complete/errors/at/run_id/mode)
  approved_by         text,
  approved_at         timestamptz not null default now(),
  note                text
);
comment on table public.reg_source is
  '사내규정 수집 대상 그룹웨어 게시판 등록표(단일 출처). 수집기는 활성 행만 읽고, 0건이면 수집하지 않는다(fail-closed). '
  'list_path 는 상대경로만 · selectors 는 기본 프로필을 덮는 부분 JSON. REQ-0124.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. 게시물 원장 · 이전 판 · 첨부
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.reg_post (
  post_id           bigint generated always as identity primary key,
  board_key         text not null references public.reg_source(board_key),
  post_no           text not null,                 -- 게시물 번호(체계 실측 전이라 text)
  title             text not null,
  author            text,
  dept_nm           text,
  posted_at         timestamptz,
  modified_at       timestamptz,
  body_md           text check (body_md is null or length(body_md) <= 200000),
  body_blocked      boolean not null default false, -- 본문에 주민등록번호 꼴 → 글자 미저장
  body_hash         text not null,                 -- 정규화 본문 sha256
  attach_sig        text,                          -- 첨부(이름|크기|sha256) 서명
  nas_rel_path      text not null check (nas_rel_path !~ '^[/\\]' and nas_rel_path !~ '\\' and nas_rel_path !~ ':' and nas_rel_path !~ '(^|/)\.\.?(/|$)'),
  gw_url            text check (gw_url is null or gw_url ~* '^https?://'),
  revision          integer not null default 1,
  status            text not null default 'active' check (status in ('active', 'removed')),
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  collector_version text,
  run_id            uuid,
  unique (board_key, post_no)
);
comment on table public.reg_post is
  '그룹웨어 규정 게시판 게시물 원장(본문 Markdown 사본 · NAS 상대경로 · 판). 원본·첨부 정본은 NAS 00_전사공유/사내규정. '
  'removed 는 게시판에서 사라진 게시물(파일은 NAS 에 보존). REQ-0124 · D-153(D-95 예외).';

create table if not exists public.reg_post_history (
  post_id      bigint not null references public.reg_post(post_id) on delete cascade,
  revision     integer not null,
  body_hash    text,
  attach_sig   text,
  modified_at  timestamptz,
  nas_rel_path text,
  replaced_at  timestamptz not null default now(),
  primary key (post_id, revision)
);
comment on table public.reg_post_history is '게시물 이전 판 요약(본문은 NAS history/ 폴더). REQ-0124.';

create table if not exists public.reg_attachment (
  attachment_id     bigint generated always as identity primary key,
  post_id           bigint not null references public.reg_post(post_id) on delete cascade,
  seq               integer not null,
  file_name         text not null,
  ext               text,
  size_bytes        bigint,
  sha256            text,
  nas_rel_path      text,                          -- null = 저장 안 함(blocked·skipped)
  text_status       text not null check (text_status in ('readable', 'unreadable', 'blocked', 'skipped')),
  text_reason       text,
  text_chars        integer,
  extractor         text,                          -- 'hwp_text h1.0' · 'nas_index i1.2'
  is_article_source boolean not null default false,
  unique (post_id, seq)
);
comment on table public.reg_attachment is '게시물 첨부 메타·판독 상태. blocked = 주민등록번호 꼴(NAS 에도 없음). REQ-0124.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. 규정 단위 · 조문
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.reg_document (
  document_id    bigint generated always as identity primary key,
  post_id        bigint not null unique references public.reg_post(post_id) on delete cascade,
  reg_key        text not null,                    -- '<board_key>:<정규화 규정명>' — 같은 규정의 여러 게시물(개정 공지)을 묶는 힌트
  name           text not null,
  category       text,
  enact_date     date,
  revise_date    date,
  effective_date date,                             -- 시행 > 개정 > 제정 > 게시일(파서·수집기가 보완)
  revision_no    integer,
  owner_dept     text,
  parse_status   text not null check (parse_status in ('ok', 'partial', 'fallback')),
  parse_version  text,
  text_source    text not null,                    -- 'body' | 'attachment:<file_name>'
  article_count  integer not null default 0,
  warnings       jsonb,
  is_current     boolean not null default true,    -- reg_key 안의 현행 판 — reg_recalc_current 가 시행일·게시일로 1건만 참
  updated_at     timestamptz not null default now()
);
comment on table public.reg_document is
  '규정 단위(게시물당 1건). is_current 는 같은 reg_key 활성 게시물 중 effective_date·posted_at 최신 1건 — DB 가 계산한다. '
  '제목만으로 합치는 추측은 하지 않는다. REQ-0124.';
create index if not exists reg_document_key_cur_ix on public.reg_document (reg_key) where is_current;
create index if not exists reg_document_name_trgm on public.reg_document using gin (name extensions.gin_trgm_ops);

create table if not exists public.reg_article (
  article_id    bigint generated always as identity primary key,
  document_id   bigint not null references public.reg_document(document_id) on delete cascade,
  seq           integer not null,
  chapter       text,
  section       text,
  article_no    text,                              -- '3' · '3의2' · '부칙-1' · null(fallback 전문)
  title         text,
  body          text not null check (length(body) <= 20000),
  amended_tag   text,
  amend_history jsonb,
  is_deleted    boolean not null default false,
  unique (document_id, seq)
);
comment on table public.reg_article is '조문(규칙 파서 reg_parse p1.x). 본문 20,000자/조. 검색은 pg_trgm(ILIKE). REQ-0124.';
create index if not exists reg_article_doc_ix     on public.reg_article (document_id, seq);
create index if not exists reg_article_body_trgm  on public.reg_article using gin (body extensions.gin_trgm_ops);
create index if not exists reg_article_title_trgm on public.reg_article using gin ((coalesce(title, '')) extensions.gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────────────────
-- 4. RLS 전면차단 + 권한 회수 (정책 0개 — RPC 만이 읽기 경로)
-- ─────────────────────────────────────────────────────────────────────────
alter table public.reg_source       enable row level security;
alter table public.reg_post         enable row level security;
alter table public.reg_post_history enable row level security;
alter table public.reg_attachment   enable row level security;
alter table public.reg_document     enable row level security;
alter table public.reg_article      enable row level security;
revoke all on public.reg_source, public.reg_post, public.reg_post_history, public.reg_attachment, public.reg_document, public.reg_article
  from anon, authenticated;
grant select, insert, update, delete on public.reg_source, public.reg_post, public.reg_post_history, public.reg_attachment,
  public.reg_document, public.reg_article to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. 적재 RPC (service_role 전용 — 사내 PC 수집기 gw_board_collect.py)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.reg_source_list()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
  select case when coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then '[]'::jsonb
         else coalesce((select jsonb_agg(jsonb_build_object(
                  'board_key', s.board_key, 'label_ko', s.label_ko, 'list_path', s.list_path, 'selectors', s.selectors,
                  'category', s.category, 'active', s.active, 'collect_attachments', s.collect_attachments,
                  'last_collected_at', s.last_collected_at, 'last_post_no', s.last_post_no)
                  order by s.board_key)
                 from public.reg_source s where s.active), '[]'::jsonb) end
$$;
revoke all on function public.reg_source_list() from public, anon, authenticated;
grant execute on function public.reg_source_list() to service_role;

-- reg_key 안의 현행 판 1건 계산(내부용)
create or replace function public.reg_recalc_current(p_reg_key text)
returns void
language sql
security definer
set search_path to ''
as $$
  with ranked as (
    select d.document_id,
           row_number() over (order by d.effective_date desc nulls last, p.posted_at desc nulls last, d.document_id desc) as rn
      from public.reg_document d
      join public.reg_post p on p.post_id = d.post_id
     where d.reg_key = p_reg_key and p.status = 'active'
  )
  update public.reg_document d
     set is_current = (r.rn = 1)
    from ranked r
   where d.document_id = r.document_id
     and d.is_current is distinct from (r.rn = 1);
$$;
revoke all on function public.reg_recalc_current(text) from public, anon, authenticated;
grant execute on function public.reg_recalc_current(text) to service_role;

create or replace function public.reg_ingest_upsert(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_run    uuid := nullif(p_payload ->> 'run_id', '')::uuid;
  v_board  text := p_payload ->> 'board_key';
  r        jsonb;                        -- (jsonb 별칭 a 는 SELECT 안에서만 쓴다 — 같은 이름의 변수를 두면 42702 모호성)
  v_old    public.reg_post%rowtype;
  v_post   bigint;
  v_doc    bigint;
  v_new    integer := 0;
  v_chg    integer := 0;
  v_unch   integer := 0;
  v_arts   integer := 0;
  v_n      integer;
  v_keys   text[] := '{}';
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'reg_ingest_upsert: service_role only' using errcode = '42501';
  end if;
  if v_board is null or not exists (select 1 from public.reg_source where board_key = v_board) then
    raise exception 'reg_ingest_upsert: unknown board_key %', coalesce(v_board, '(null)');
  end if;

  for r in select * from jsonb_array_elements(coalesce(p_payload -> 'posts', '[]'::jsonb)) loop
    if (r #>> '{post,post_no}') is null or (r #>> '{post,body_hash}') is null or (r #>> '{post,nas_rel_path}') is null then
      raise exception 'reg_ingest_upsert: post_no/body_hash/nas_rel_path 누락';
    end if;
    select * into v_old from public.reg_post where board_key = v_board and post_no = (r #>> '{post,post_no}');
    if found then
      v_post := v_old.post_id;
      if v_old.body_hash = (r #>> '{post,body_hash}')
         and v_old.attach_sig is not distinct from (r #>> '{post,attach_sig}')
         and v_old.status = 'active' then
        update public.reg_post
           set last_seen_at = now(), modified_at = coalesce((r #>> '{post,modified_at}')::timestamptz, modified_at),
               run_id = coalesce(v_run, run_id)
         where post_id = v_old.post_id;
        v_unch := v_unch + 1;
      else
        insert into public.reg_post_history (post_id, revision, body_hash, attach_sig, modified_at, nas_rel_path)
        values (v_old.post_id, v_old.revision, v_old.body_hash, v_old.attach_sig, v_old.modified_at, v_old.nas_rel_path)
        on conflict (post_id, revision) do nothing;
        update public.reg_post
           set title = r #>> '{post,title}', author = r #>> '{post,author}', dept_nm = r #>> '{post,dept_nm}',
               posted_at = (r #>> '{post,posted_at}')::timestamptz, modified_at = (r #>> '{post,modified_at}')::timestamptz,
               body_md = r #>> '{post,body_md}', body_blocked = coalesce((r #>> '{post,body_blocked}')::boolean, false),
               body_hash = r #>> '{post,body_hash}', attach_sig = r #>> '{post,attach_sig}',
               nas_rel_path = r #>> '{post,nas_rel_path}', gw_url = r #>> '{post,gw_url}',
               revision = greatest(v_old.revision + 1, coalesce((r #>> '{post,revision}')::integer, 0)),
               status = 'active', last_seen_at = now(),
               collector_version = r #>> '{post,collector_version}', run_id = coalesce(v_run, run_id)
         where post_id = v_old.post_id;
        v_chg := v_chg + 1;
      end if;
    else
      insert into public.reg_post (board_key, post_no, title, author, dept_nm, posted_at, modified_at, body_md, body_blocked,
                                   body_hash, attach_sig, nas_rel_path, gw_url, revision, status, collector_version, run_id)
      values (v_board, r #>> '{post,post_no}', coalesce(r #>> '{post,title}', '(제목 없음)'), r #>> '{post,author}', r #>> '{post,dept_nm}',
              (r #>> '{post,posted_at}')::timestamptz, (r #>> '{post,modified_at}')::timestamptz,
              r #>> '{post,body_md}', coalesce((r #>> '{post,body_blocked}')::boolean, false),
              r #>> '{post,body_hash}', r #>> '{post,attach_sig}', r #>> '{post,nas_rel_path}', r #>> '{post,gw_url}',
              greatest(coalesce((r #>> '{post,revision}')::integer, 1), 1), 'active', r #>> '{post,collector_version}', v_run)
      returning post_id into v_post;
      v_new := v_new + 1;
    end if;

    -- 첨부·문서·조문은 항상 다시 쓴다(멱등 — DB 적재 실패 뒤 재전송도 같은 결과)
    delete from public.reg_attachment where post_id = v_post;
    insert into public.reg_attachment (post_id, seq, file_name, ext, size_bytes, sha256, nas_rel_path, text_status, text_reason,
                                       text_chars, extractor, is_article_source)
    select v_post, (a ->> 'seq')::integer, a ->> 'file_name', a ->> 'ext', (a ->> 'size_bytes')::bigint, a ->> 'sha256',
           a ->> 'nas_rel_path', coalesce(a ->> 'text_status', 'skipped'), a ->> 'text_reason', (a ->> 'text_chars')::integer,
           a ->> 'extractor', coalesce((a ->> 'is_article_source')::boolean, false)
      from jsonb_array_elements(coalesce(r -> 'attachments', '[]'::jsonb)) a;

    insert into public.reg_document (post_id, reg_key, name, category, enact_date, revise_date, effective_date, revision_no,
                                     owner_dept, parse_status, parse_version, text_source, article_count, warnings, updated_at)
    values (v_post, coalesce(r #>> '{document,reg_key}', v_board || ':untitled'), coalesce(r #>> '{document,name}', r #>> '{post,title}', '(제목 없음)'),
            r #>> '{document,category}', (r #>> '{document,enact_date}')::date, (r #>> '{document,revise_date}')::date,
            (r #>> '{document,effective_date}')::date, (r #>> '{document,revision_no}')::integer, r #>> '{document,owner_dept}',
            coalesce(r #>> '{document,parse_status}', 'fallback'), r #>> '{document,parse_version}',
            coalesce(r #>> '{document,text_source}', 'body'), coalesce((r #>> '{document,article_count}')::integer, 0),
            r #> '{document,warnings}', now())
    on conflict (post_id) do update
      set reg_key = excluded.reg_key, name = excluded.name, category = excluded.category, enact_date = excluded.enact_date,
          revise_date = excluded.revise_date, effective_date = excluded.effective_date, revision_no = excluded.revision_no,
          owner_dept = excluded.owner_dept, parse_status = excluded.parse_status, parse_version = excluded.parse_version,
          text_source = excluded.text_source, article_count = excluded.article_count, warnings = excluded.warnings,
          updated_at = now()
    returning document_id into v_doc;

    delete from public.reg_article where document_id = v_doc;
    insert into public.reg_article (document_id, seq, chapter, section, article_no, title, body, amended_tag, amend_history, is_deleted)
    select v_doc, (a ->> 'seq')::integer, a ->> 'chapter', a ->> 'section', a ->> 'article_no', a ->> 'title',
           left(coalesce(a ->> 'body', ''), 20000), a ->> 'amended_tag', a -> 'amend_history', coalesce((a ->> 'is_deleted')::boolean, false)
      from jsonb_array_elements(coalesce(r -> 'articles', '[]'::jsonb)) a;
    get diagnostics v_n = row_count;
    v_arts := v_arts + v_n;

    v_keys := array_append(v_keys, coalesce(r #>> '{document,reg_key}', v_board || ':untitled'));
  end loop;

  -- 현행 판 재계산(건드린 reg_key 만)
  perform public.reg_recalc_current(k) from unnest(array(select distinct x from unnest(v_keys) x)) k;

  update public.reg_source
     set last_collected_at = now(),
         last_post_no = coalesce(p_payload ->> 'last_post_no', last_post_no),
         last_result = coalesce(p_payload -> 'last_result', last_result)
   where board_key = v_board;

  return jsonb_build_object('posts', v_new + v_chg + v_unch, 'new', v_new, 'changed', v_chg, 'unchanged', v_unch, 'articles', v_arts);
end;
$$;
comment on function public.reg_ingest_upsert(jsonb) is
  '수집기 적재(service_role 전용 · 트랜잭션 · 멱등). 본문 해시·첨부 서명이 바뀐 게시물은 history 에 옛 판을 남기고 revision+1. '
  '첨부·문서·조문은 항상 다시 쓴다. 건드린 reg_key 의 현행 판을 재계산한다. REQ-0124.';
revoke all on function public.reg_ingest_upsert(jsonb) from public, anon, authenticated;
grant execute on function public.reg_ingest_upsert(jsonb) to service_role;

create or replace function public.reg_mark_removed(p_board_key text, p_seen_post_nos text[], p_run_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_active integer;
  v_seen   integer := coalesce(array_length(p_seen_post_nos, 1), 0);
  v_gone   integer := 0;
  k        text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'reg_mark_removed: service_role only' using errcode = '42501';
  end if;
  select count(*) into v_active from public.reg_post where board_key = p_board_key and status = 'active';
  if v_active > 0 and v_seen < v_active * 0.5 then      -- 목록을 절반도 못 본 회차(선택자 깨짐·페이징 실패)에는 삭제 표시를 하지 않는다
    return jsonb_build_object('ok', false, 'reason', '이번에 본 건수가 활성의 절반 미만 — 삭제 표시 거부',
                              'active', v_active, 'seen', v_seen);
  end if;
  update public.reg_post
     set status = 'removed', last_seen_at = now(), run_id = coalesce(p_run_id, run_id)
   where board_key = p_board_key and status = 'active' and not (post_no = any(coalesce(p_seen_post_nos, '{}')));
  get diagnostics v_gone = row_count;
  update public.reg_document d set is_current = false
    from public.reg_post p where p.post_id = d.post_id and p.board_key = p_board_key and p.status = 'removed' and d.is_current;
  for k in select distinct d.reg_key from public.reg_document d join public.reg_post p on p.post_id = d.post_id
            where p.board_key = p_board_key loop
    perform public.reg_recalc_current(k);
  end loop;
  return jsonb_build_object('ok', true, 'removed', v_gone, 'active_before', v_active, 'seen', v_seen);
end;
$$;
comment on function public.reg_mark_removed(text, text[], uuid) is
  '--full 완주 뒤 목록에 없는 게시물을 removed 로(파일은 NAS 보존). 본 건수가 활성의 절반 미만이면 거부. REQ-0124.';
revoke all on function public.reg_mark_removed(text, text[], uuid) from public, anon, authenticated;
grant execute on function public.reg_mark_removed(text, text[], uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. 조회 RPC — 유일한 읽기 경로 (사내 로그인 전원 · service_role)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.reg_list(p_category text default null, p_q text default null)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
with ok as (
  select (coalesce(auth.jwt() ->> 'role', '') = 'service_role' or public.is_internal()) as allowed
),
q as (select nullif(btrim(coalesce(p_q, '')), '') as q, nullif(btrim(coalesce(p_category, '')), '') as cat),
docs as (
  select d.document_id, d.reg_key, d.name, d.category, d.enact_date, d.revise_date, d.effective_date, d.revision_no,
         d.owner_dept, d.parse_status, d.text_source, d.article_count, d.warnings, d.updated_at,
         p.post_id, p.board_key, s.label_ko as board_label, p.post_no, p.title, p.posted_at, p.modified_at,
         p.nas_rel_path, p.gw_url, p.revision, p.last_seen_at, p.body_blocked,
         (select count(*) from public.reg_attachment a where a.post_id = p.post_id) as attach_cnt,
         (select count(*) from public.reg_attachment a where a.post_id = p.post_id and a.text_status in ('unreadable', 'blocked')) as unreadable_cnt
    from public.reg_document d
    join public.reg_post p   on p.post_id = d.post_id
    join public.reg_source s on s.board_key = p.board_key, q
   where d.is_current and p.status = 'active'
     and (q.cat is null or d.category = q.cat)
     and (q.q is null or d.name ilike '%' || q.q || '%' or p.title ilike '%' || q.q || '%')
)
select jsonb_build_object(
         'allowed', ok.allowed,
         'source',  '사내규정 사본(그룹웨어 게시판 · 시행일 기준)',
         'as_of',   (select max(last_collected_at) from public.reg_source where active),
         'count',   case when ok.allowed then (select count(*) from docs) else 0 end,
         'categories', case when ok.allowed
                            then coalesce((select jsonb_agg(distinct category) from docs where category is not null), '[]'::jsonb)
                            else '[]'::jsonb end,
         'rows',    case when ok.allowed
                         then coalesce((select jsonb_agg(to_jsonb(docs) order by category nulls last, name, effective_date desc) from docs), '[]'::jsonb)
                         else '[]'::jsonb end)
  from ok
$$;
comment on function public.reg_list(text, text) is '현행 규정 목록(+조문 수·첨부 수·판독 불가 수). 사내 전원. REQ-0124.';
revoke all on function public.reg_list(text, text) from public, anon;
grant execute on function public.reg_list(text, text) to authenticated, service_role;

create or replace function public.reg_get(p_reg_key text, p_article_no text default null,
                                          p_from_seq integer default 1, p_limit integer default 80)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
with ok as (
  select (coalesce(auth.jwt() ->> 'role', '') = 'service_role' or public.is_internal()) as allowed
),
doc as (
  select d.document_id, d.reg_key, d.name, d.category, d.enact_date, d.revise_date, d.effective_date, d.revision_no,
         d.owner_dept, d.parse_status, d.parse_version, d.text_source, d.article_count, d.warnings, d.updated_at,
         p.post_id, p.board_key, s.label_ko as board_label, p.post_no, p.title, p.author, p.dept_nm, p.posted_at, p.modified_at,
         p.nas_rel_path, p.gw_url, p.revision, p.body_blocked
    from public.reg_document d
    join public.reg_post p   on p.post_id = d.post_id
    join public.reg_source s on s.board_key = p.board_key
   where d.reg_key = nullif(btrim(coalesce(p_reg_key, '')), '') and d.is_current and p.status = 'active'
   limit 1
),
arts as (select a.* from public.reg_article a, doc where a.document_id = doc.document_id),
pick as (
  select * from arts
   where (p_article_no is not null and article_no = btrim(p_article_no))
      or (p_article_no is null and seq >= greatest(coalesce(p_from_seq, 1), 1))
   order by seq
   limit least(greatest(coalesce(p_limit, 80), 1), 300)
),
atts as (
  select jsonb_agg(jsonb_build_object('seq', a.seq, 'file_name', a.file_name, 'ext', a.ext, 'size_bytes', a.size_bytes,
                                      'text_status', a.text_status, 'text_reason', a.text_reason,
                                      'is_article_source', a.is_article_source) order by a.seq) as j
    from public.reg_attachment a, doc where a.post_id = doc.post_id
)
select case
         when not ok.allowed then jsonb_build_object('allowed', false, 'found', false, 'reg', null, 'articles', '[]'::jsonb)
         when not exists (select 1 from doc) then jsonb_build_object('allowed', true, 'found', false, 'reg', null, 'articles', '[]'::jsonb,
                                                                    'source', '사내규정 사본(그룹웨어 게시판 · 시행일 기준)')
         else jsonb_build_object(
           'allowed', true, 'found', true,
           'source', '사내규정 사본(그룹웨어 게시판 · 시행일 기준)',
           'as_of', (select max(last_collected_at) from public.reg_source where active),
           'reg', (select to_jsonb(doc) from doc),
           'toc', coalesce((select jsonb_agg(jsonb_build_object('seq', seq, 'article_no', article_no, 'title', title, 'chapter', chapter,
                                                                 'section', section, 'is_deleted', is_deleted) order by seq) from arts), '[]'::jsonb),
           'attachments', coalesce((select j from atts), '[]'::jsonb),
           'articles', coalesce((select jsonb_agg(to_jsonb(pick) order by seq) from pick), '[]'::jsonb),
           'total_articles', (select count(*) from arts),
           'next_seq', (select case when exists (select 1 from arts where seq > (select max(seq) from pick))
                                    then (select max(seq) from pick) + 1 else null end))
       end
  from ok
$$;
comment on function public.reg_get(text, text, integer, integer) is
  '규정 1건(현행 판) — 메타·목차·첨부 + 조문(한 조 또는 seq 범위 · 최대 300). 사내 전원. REQ-0124.';
revoke all on function public.reg_get(text, text, integer, integer) from public, anon;
grant execute on function public.reg_get(text, text, integer, integer) to authenticated, service_role;

create or replace function public.reg_search(p_q text, p_limit integer default 8)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
with ok as (
  select (coalesce(auth.jwt() ->> 'role', '') = 'service_role' or public.is_internal()) as allowed
),
t as (   -- 낱말 최대 6개 AND · 와일드카드 문자는 공백으로
  select coalesce((select array_agg(x order by i)
                     from unnest(array_remove(regexp_split_to_array(
                            btrim(regexp_replace(coalesce(p_q, ''), '[%_\\]', ' ', 'g')), '\s+'), '')) with ordinality u(x, i)
                    where i <= 6 and length(x) >= 1), '{}'::text[]) as terms
),
hit as (
  select a.article_id, a.document_id, a.seq, a.article_no, a.title, a.body, d.reg_key, d.name, d.effective_date,
         p.gw_url, p.board_key,
         (d.name ilike '%' || t.terms[1] || '%') as name_hit,
         (coalesce(a.title, '') ilike '%' || t.terms[1] || '%') as title_hit,
         greatest(0, strpos(lower(a.body), lower(t.terms[1]))) as pos1
    from public.reg_article a
    join public.reg_document d on d.document_id = a.document_id
    join public.reg_post p     on p.post_id = d.post_id, t
   where cardinality(t.terms) > 0
     and d.is_current and p.status = 'active' and not a.is_deleted
     and (select count(*) from unnest(t.terms) x
           where a.body ilike '%' || x || '%' or coalesce(a.title, '') ilike '%' || x || '%' or d.name ilike '%' || x || '%')
         = cardinality(t.terms)
),
scored as (
  select h.*, extensions.similarity(left(h.body, 2000), array_to_string(t.terms, ' ')) as sim
    from hit h, t
),
lim as (
  select * from scored
   order by title_hit desc, name_hit desc, sim desc, effective_date desc nulls last, seq
   limit least(greatest(coalesce(p_limit, 8), 1), 30)
)
select jsonb_build_object(
         'allowed', ok.allowed,
         'source',  '사내규정 사본(그룹웨어 게시판 · 시행일 기준)',
         'q',       p_q,
         'terms',   (select to_jsonb(terms) from t),
         'as_of',   (select max(last_collected_at) from public.reg_source where active),
         'count',   case when ok.allowed then (select count(*) from lim) else 0 end,
         'rows',    case when ok.allowed
                         then coalesce((select jsonb_agg(jsonb_build_object(
                                 'reg_key', reg_key, 'name', name, 'document_id', document_id, 'seq', seq,
                                 'article_no', article_no, 'title', title,
                                 'excerpt', case when pos1 > 0 then substr(body, greatest(pos1 - 160, 1), 320) else left(body, 320) end,
                                 'effective_date', effective_date, 'gw_url', gw_url, 'board_key', board_key,
                                 'score', round(sim::numeric, 3))
                               order by title_hit desc, name_hit desc, sim desc, effective_date desc nulls last, seq) from lim), '[]'::jsonb)
                         else '[]'::jsonb end)
  from ok
$$;
comment on function public.reg_search(text, integer) is
  '조문·제목·규정명 검색(낱말 ≤6 AND · ILIKE + pg_trgm 유사도 · 현행 판만 · 최대 30건 · 발췌 ±160자). 사내 전원. REQ-0124.';
revoke all on function public.reg_search(text, integer) from public, anon;
grant execute on function public.reg_search(text, integer) to authenticated, service_role;

create or replace function public.reg_status()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
with ok as (
  select (coalesce(auth.jwt() ->> 'role', '') = 'service_role' or public.is_internal()) as allowed
),
adm as (   -- 전체관리자(portal_admin) · service_role 만 상세(게시판별·실패·판독 불가 목록)를 본다
  select (coalesce(auth.jwt() ->> 'role', '') = 'service_role'
          or exists (select 1 from public.portal_admin where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))) as is_admin
),
src as (
  select s.board_key, s.label_ko, s.active, s.category, s.last_collected_at, s.last_post_no, s.last_result,
         (select count(*) from public.reg_post p where p.board_key = s.board_key and p.status = 'active') as post_cnt,
         coalesce(jsonb_array_length(case when jsonb_typeof(s.last_result -> 'errors') = 'array' then s.last_result -> 'errors' else '[]'::jsonb end), 0) as error_cnt
    from public.reg_source s
),
cur as (
  select d.document_id, d.parse_status, p.post_id
    from public.reg_document d join public.reg_post p on p.post_id = d.post_id
   where d.is_current and p.status = 'active'
),
unread as (
  select d.name as reg_name, p.board_key, p.post_no, a.file_name, a.ext, a.size_bytes, a.text_status, a.text_reason
    from public.reg_attachment a
    join public.reg_post p on p.post_id = a.post_id
    left join public.reg_document d on d.post_id = p.post_id
   where p.status = 'active' and a.text_status in ('unreadable', 'blocked')
   order by p.board_key, p.post_no, a.seq
   limit 300
)
select case when not ok.allowed then jsonb_build_object('allowed', false, 'ok', false)
       else jsonb_build_object(
         'allowed', true, 'ok', true,
         'source', '사내규정 사본(그룹웨어 게시판 · 시행일 기준)',
         'as_of', (select max(last_collected_at) from src where active),
         'interval_hours', 24,
         'source_cnt', (select count(*) from src where active),
         'post_cnt', (select coalesce(sum(post_cnt), 0) from src),
         'doc_cnt', (select count(*) from cur),
         'article_cnt', (select count(*) from public.reg_article a where a.document_id in (select document_id from cur)),
         'attach_cnt', (select count(*) from public.reg_attachment a where a.post_id in (select post_id from cur)),
         'unreadable_cnt', (select count(*) from public.reg_attachment a join public.reg_post p on p.post_id = a.post_id
                             where p.status = 'active' and a.text_status in ('unreadable', 'blocked')),
         'parse', coalesce((select jsonb_object_agg(parse_status, n) from (select parse_status, count(*) as n from cur group by 1) x), '{}'::jsonb),
         'last_fail_at', (select max((last_result ->> 'at')::timestamptz) from src where error_cnt > 0),
         'is_admin', adm.is_admin,
         'sources', case when adm.is_admin then coalesce((select jsonb_agg(to_jsonb(src) order by board_key) from src), '[]'::jsonb) else null end,
         'unreadable', case when adm.is_admin then coalesce((select jsonb_agg(to_jsonb(unread)) from unread), '[]'::jsonb) else null end)
       end
  from ok, adm
$$;
comment on function public.reg_status() is
  '수집 현황 — 사내 전원: 기준시각·건수·판독 불가 수·마지막 실패 / 전체관리자(portal_admin)·service_role: 게시판별·판독 불가 목록. REQ-0124.';
revoke all on function public.reg_status() from public, anon;
grant execute on function public.reg_status() to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. 게시판 시드 — Step 0 실측(문서 12/11 부록) 뒤 값을 채워 넣는다. 그 전에는 활성 행이 없어 수집기가 돌지 않는다(fail-closed).
-- ─────────────────────────────────────────────────────────────────────────
-- insert into public.reg_source (board_key, label_ko, list_path, selectors, category, active, approved_by, note)
-- values ('rules', '사내규정', '/board/list.do?boardId=<실측값>', null, '규정', true, 'dh.choi@jeilm.co.kr', 'Step 0 실측 2026-10-xx')
-- on conflict (board_key) do nothing;

-- ── 확인 ─────────────────────────────────────────────────────────────────────
-- select extname, extversion from pg_extension where extname = 'pg_trgm';
-- select relname, relrowsecurity from pg_class where relname like 'reg\_%' and relnamespace = 'public'::regnamespace;
-- select public.reg_status();                                    -- 사내 사용자: allowed:true · 관리자: is_admin:true
-- select public.reg_search('연차', 5);                           -- 수집 뒤
-- select has_function_privilege('anon', 'public.reg_list(text,text)', 'execute');   -- false 여야 한다
