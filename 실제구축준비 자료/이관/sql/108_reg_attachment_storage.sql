-- ============================================================================
-- 108_reg_attachment_storage.sql — 사내규정 첨부 원본(PDF 등)을 **포털에서 바로 열 수 있게** 비공개 버킷 사본 + 경로 컬럼
--   (REQ-0124 2차 · 2026-10-08 · 관리자 승인 뒤 라이브 적용)
--
-- 왜 필요한가
--   규정 조회 화면·챗봇 카드의 「원본」은 그룹웨어 게시물 링크였다. 그룹웨어는 전체 페이지 이동마다 SSO 계정 선택으로
--   되돌아가고(10-08 실측), 첨부 정본은 사내 NAS 에만 있어 브라우저가 열 수 없다. 관리자 지시(10-08): 「그룹웨어 연결이 아닌
--   실제 PDF 를 연결해 보이도록」 → 수집기가 NAS 에 둔 첨부를 **비공개 Storage 버킷 `reg-files`** 에 사본으로 올리고,
--   화면·챗봇은 사내 로그인 사용자의 서명 URL(1시간)로 연다. 정본 서열은 그대로다(그룹웨어 > NAS 미러 > 포털 사본).
--
-- 무엇을 바꾸나
--   1) public.reg_attachment.storage_path text — 버킷 안 경로(`<board>/<post 6자리>/<sha256 앞 16자><확장자>` · ASCII 만 —
--      Supabase Storage 키는 한글을 거부한다 · 표시 이름은 file_name). null = 사본 없음(blocked·skipped·업로드 실패).
--   2) 버킷 storage.buckets 'reg-files'(비공개 · 50MB 상한 = 수집기 MAX_ATTACH_BYTES) + storage.objects **select 정책 1개**
--      (bucket_id='reg-files' and public.is_internal()) — 쓰기 정책은 없다(수집기 service_role 만 · RLS 우회).
--      서명 URL 은 select 권한으로 만들어지므로 협력사·anon 은 만들 수 없다.
--   3) RPC reg_attachment_storage_set(board_key, post_no, items) — service_role 전용 · 이미 적재된 게시물의 경로만 채운다
--      (초기 1회 `gw_board_collect.py --files-sync` · sha256 이 다르면 건드리지 않는다).
--   4) 재정의: reg_ingest_upsert(첨부 insert 에 storage_path) · reg_list / reg_get / reg_search(원본 파일 file_path·file_name·file_ext —
--      PDF 우선 → 조문 원천 → seq · reg_get.attachments 에 storage_path). 열 추가뿐 — 기존 호출은 그대로 동작한다.
--
-- 기준 정의: 정본 103 의 함수 원문을 생성기(scratchpad gen_sql108.py)가 그대로 꺼내 치환했다 — 손 복사 드리프트 없음.
-- 적용 전 확인: `begin … rollback` 드라이런(역할 3종 · 서명 정책) · 적용 뒤 `--files-sync` 로 사본 28건 업로드 → reg_list.file_path 채워짐 확인.
-- 되돌리기: 108_reg_attachment_storage_rollback.sql (정책·함수·열 되돌림 · 버킷은 비운 뒤 지운다 — 주석)
-- ============================================================================
begin;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. 열
-- ─────────────────────────────────────────────────────────────────────────
alter table public.reg_attachment add column if not exists storage_path text
  check (storage_path is null or (storage_path ~ '^[a-z0-9_-]+/[0-9]{6}/[0-9a-f]{8,64}(\.[a-z0-9]{1,8})?$'));
comment on column public.reg_attachment.storage_path is
  '비공개 버킷 reg-files 안 사본 경로(ASCII · <board>/<post 6자리>/<sha16><ext>). null = 사본 없음. 화면·챗봇은 서명 URL 로 연다. SQL 108.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. 버킷 + 읽기 정책(사내 로그인 전원)
-- ─────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit)
values ('reg-files', 'reg-files', false, 52428800)
on conflict (id) do nothing;

drop policy if exists reg_files_internal_select on storage.objects;
create policy reg_files_internal_select on storage.objects for select
  to authenticated
  using (bucket_id = 'reg-files' and public.is_internal());
-- insert/update/delete 정책 없음 — 수집기(service_role)만 쓴다.

-- ─────────────────────────────────────────────────────────────────────────
-- 3. 경로 보정 RPC(service_role 전용 · 초기 1회 --files-sync)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.reg_attachment_storage_set(p_board_key text, p_post_no text, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_post bigint;
  v_n    integer := 0;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'reg_attachment_storage_set: service_role only' using errcode = '42501';
  end if;
  select post_id into v_post from public.reg_post where board_key = p_board_key and post_no = p_post_no;
  if v_post is null then
    return jsonb_build_object('found', false, 'updated', 0);
  end if;
  update public.reg_attachment a
     set storage_path = nullif(i ->> 'storage_path', '')
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) i
   where a.post_id = v_post
     and a.seq = (i ->> 'seq')::integer
     and (nullif(i ->> 'sha256', '') is null or a.sha256 = i ->> 'sha256');   -- NAS 파일이 바뀌었으면(해시 불일치) 건드리지 않는다
  get diagnostics v_n = row_count;
  return jsonb_build_object('found', true, 'updated', v_n);
end;
$$;
comment on function public.reg_attachment_storage_set(text, text, jsonb) is
  '이미 적재된 게시물 첨부의 버킷 사본 경로를 채운다(service_role · sha256 일치분만). 초기 1회 --files-sync. SQL 108.';
revoke all on function public.reg_attachment_storage_set(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.reg_attachment_storage_set(text, text, jsonb) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. 재정의 — 103 원문 + storage_path / file_path 열 추가(동작 차이는 그것뿐)
-- ─────────────────────────────────────────────────────────────────────────
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
                                       text_chars, extractor, is_article_source, storage_path)
    select v_post, (a ->> 'seq')::integer, a ->> 'file_name', a ->> 'ext', (a ->> 'size_bytes')::bigint, a ->> 'sha256',
           a ->> 'nas_rel_path', coalesce(a ->> 'text_status', 'skipped'), a ->> 'text_reason', (a ->> 'text_chars')::integer,
           a ->> 'extractor', coalesce((a ->> 'is_article_source')::boolean, false), nullif(a ->> 'storage_path', '')
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
  '첨부·문서·조문은 항상 다시 쓴다(첨부 storage_path 포함 · SQL 108). 건드린 reg_key 의 현행 판을 재계산한다. REQ-0124.';
revoke all on function public.reg_ingest_upsert(jsonb) from public, anon, authenticated;
grant execute on function public.reg_ingest_upsert(jsonb) to service_role;

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
         (select count(*) from public.reg_attachment a where a.post_id = p.post_id and a.text_status in ('unreadable', 'blocked')) as unreadable_cnt,
         f.file_path, f.file_name, f.file_ext
    from public.reg_document d
    join public.reg_post p   on p.post_id = d.post_id
    join public.reg_source s on s.board_key = p.board_key
    left join lateral (select a.storage_path as file_path, a.file_name as file_name, a.ext as file_ext
                        from public.reg_attachment a
                       where a.post_id = p.post_id and a.storage_path is not null
                       order by (a.ext = '.pdf') desc nulls last, a.is_article_source desc, a.seq
                       limit 1) f on true, q
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
comment on function public.reg_list(text, text) is '현행 규정 목록(+조문 수·첨부 수·판독 불가 수·원본 파일 경로 file_path — PDF 우선 · SQL 108). 사내 전원. REQ-0124.';
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
         p.nas_rel_path, p.gw_url, p.revision, p.body_blocked,
         f.file_path, f.file_name, f.file_ext
    from public.reg_document d
    join public.reg_post p   on p.post_id = d.post_id
    join public.reg_source s on s.board_key = p.board_key
    left join lateral (select a.storage_path as file_path, a.file_name as file_name, a.ext as file_ext
                        from public.reg_attachment a
                       where a.post_id = p.post_id and a.storage_path is not null
                       order by (a.ext = '.pdf') desc nulls last, a.is_article_source desc, a.seq
                       limit 1) f on true
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
                                      'is_article_source', a.is_article_source, 'storage_path', a.storage_path) order by a.seq) as j
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
  '규정 1건(현행 판) — 메타(+원본 파일 file_path · PDF 우선)·목차·첨부(+storage_path) + 조문(한 조 또는 seq 범위 · 최대 300). 사내 전원. REQ-0124 · SQL 108.';
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
         p.gw_url, p.board_key, f.file_path, f.file_name,
         (d.name ilike '%' || t.terms[1] || '%') as name_hit,
         (coalesce(a.title, '') ilike '%' || t.terms[1] || '%') as title_hit,
         greatest(0, strpos(lower(a.body), lower(t.terms[1]))) as pos1
    from public.reg_article a
    join public.reg_document d on d.document_id = a.document_id
    join public.reg_post p     on p.post_id = d.post_id
    left join lateral (select a.storage_path as file_path, a.file_name as file_name, a.ext as file_ext
                        from public.reg_attachment a
                       where a.post_id = p.post_id and a.storage_path is not null
                       order by (a.ext = '.pdf') desc nulls last, a.is_article_source desc, a.seq
                       limit 1) f on true, t
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
                                 'file_path', file_path, 'file_name', file_name,
                                 'score', round(sim::numeric, 3))
                               order by title_hit desc, name_hit desc, sim desc, effective_date desc nulls last, seq) from lim), '[]'::jsonb)
                         else '[]'::jsonb end)
  from ok
$$;
comment on function public.reg_search(text, integer) is
  '조문·제목·규정명 검색(낱말 ≤6 AND · ILIKE + pg_trgm 유사도 · 현행 판만 · 최대 30건 · 발췌 ±160자 · 원본 파일 file_path). 사내 전원. REQ-0124 · SQL 108.';
revoke all on function public.reg_search(text, integer) from public, anon;
grant execute on function public.reg_search(text, integer) to authenticated, service_role;

commit;
