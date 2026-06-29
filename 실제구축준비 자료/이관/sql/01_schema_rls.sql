-- ============================================================
-- JEIL AX 협력사 포털 — 데모 데이터화 스키마 + RLS (Supabase)
-- 대상 프로젝트: dvzohdqtjzocgcclgwro
-- 근거: 08/03_실구축기획/02·07, 이관/01_실행가이드 §B
-- 적용: Supabase 대시보드 → SQL Editor 에 붙여넣고 RUN (또는 MCP apply_migration)
-- 원칙: RLS 전 테이블 ON / 협력사는 자기 거래처(bp_cd)만 / 검수판정 쓰기는 사내만
-- 멱등성: 재실행 안전(if not exists / drop policy if exists)
-- ============================================================

-- ── 1. 테이블 ────────────────────────────────────────────
create table if not exists sp_order_state (
  po_no       text primary key,
  bp_cd       text not null,                 -- 격리 키(거래처코드)
  status      text not null,                 -- new|prod|insp|done
  step        smallint not null,             -- 1~10 상태머신
  updated_by  text,
  updated_at  timestamptz default now()
);

create table if not exists sp_photo (
  id           bigserial primary key,
  po_no        text not null,
  bp_cd        text not null,
  storage_path text not null,                -- 원본은 Storage, DB는 경로만
  tag          text,
  comment      text,
  uploaded_by  text not null,
  confirmed    boolean default false,        -- 사내 확인 여부
  created_at   timestamptz default now()
);

create table if not exists sp_message (
  id           bigserial primary key,
  po_no        text not null,
  bp_cd        text not null,
  sender_role  text not null,                -- supplier|internal
  sender_id    text not null,
  body         text not null,
  created_at   timestamptz default now(),
  read_at      timestamptz
);

create table if not exists sp_insp_request (
  id           bigserial primary key,
  po_no        text not null,
  bp_cd        text not null,
  insp_req_no  text not null,                -- IR+YYYYMMDD+seq
  requested_by text not null,
  requested_at timestamptz default now(),
  cancelled    boolean default false
);

create table if not exists sp_inspection (
  po_no      text primary key,
  bp_cd      text not null,
  result     text not null,                  -- 합격|불합격
  result_no  text,                           -- IQ+YYYYMMDD+seq
  judge_id   text not null,
  opinion    text,
  judged_at  timestamptz default now()
);

create table if not exists sp_inspection_log (
  id         bigserial primary key,
  po_no      text not null,
  bp_cd      text not null,
  result     text not null,
  judge_id   text not null,
  opinion    text,
  judged_at  timestamptz default now()
);

-- ── 2. 클레임 헬퍼 (RLS 동작의 전제) ─────────────────────
-- 사내 여부: app_metadata.role == 'internal'
create or replace function public.is_internal() returns boolean
language sql stable as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'internal', false);
$$;

-- 협력사 허용 거래처 집합: app_metadata.vendor_bp (json 배열)
create or replace function public.vendor_bp() returns text[]
language sql stable as $$
  select coalesce(
    array(select jsonb_array_elements_text(auth.jwt() -> 'app_metadata' -> 'vendor_bp')),
    '{}'::text[]
  );
$$;

-- ── 3. RLS 활성화 ────────────────────────────────────────
alter table sp_order_state    enable row level security;
alter table sp_photo          enable row level security;
alter table sp_message        enable row level security;
alter table sp_insp_request   enable row level security;
alter table sp_inspection     enable row level security;
alter table sp_inspection_log enable row level security;

-- ── 4. 정책: 사내=전체 / 협력사=자기 거래처만 ────────────
-- 4-1. order_state / photo / message / insp_request : 협력사 읽기·쓰기
do $$
declare t text;
begin
  foreach t in array array['sp_order_state','sp_photo','sp_message','sp_insp_request']
  loop
    execute format('drop policy if exists internal_all on %I', t);
    execute format('drop policy if exists vendor_own  on %I', t);
    execute format($p$create policy internal_all on %I for all
        using (public.is_internal()) with check (public.is_internal())$p$, t);
    execute format($p$create policy vendor_own on %I for all
        using (bp_cd = any (public.vendor_bp()))
        with check (bp_cd = any (public.vendor_bp()))$p$, t);
  end loop;
end $$;

-- 4-2. inspection / inspection_log : 검수판정은 사내만 쓰기, 협력사는 읽기만
do $$
declare t text;
begin
  foreach t in array array['sp_inspection','sp_inspection_log']
  loop
    execute format('drop policy if exists internal_all  on %I', t);
    execute format('drop policy if exists vendor_select on %I', t);
    execute format($p$create policy internal_all on %I for all
        using (public.is_internal()) with check (public.is_internal())$p$, t);
    execute format($p$create policy vendor_select on %I for select
        using (bp_cd = any (public.vendor_bp()))$p$, t);
  end loop;
end $$;

-- ── 5. Realtime publication (양방향 실시간) ──────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      sp_order_state, sp_photo, sp_message, sp_insp_request, sp_inspection;
  end if;
exception when duplicate_object then null;
end $$;

-- ── 6. Storage 버킷 (사진 증빙, 비공개) ──────────────────
insert into storage.buckets (id, name, public)
values ('vendor-photos', 'vendor-photos', false)
on conflict (id) do nothing;

-- Storage 정책: 협력사는 자기 bp_cd 접두 경로만, 사내는 전체
-- 경로 규칙: {bp_cd}/{po_no}/{uuid}.ext  → (storage.foldername(name))[1] = bp_cd
drop policy if exists vendor_photos_internal on storage.objects;
drop policy if exists vendor_photos_vendor   on storage.objects;
create policy vendor_photos_internal on storage.objects for all
  using (bucket_id = 'vendor-photos' and public.is_internal())
  with check (bucket_id = 'vendor-photos' and public.is_internal());
create policy vendor_photos_vendor on storage.objects for all
  using (bucket_id = 'vendor-photos' and (storage.foldername(name))[1] = any (public.vendor_bp()))
  with check (bucket_id = 'vendor-photos' and (storage.foldername(name))[1] = any (public.vendor_bp()));

-- 끝. 적용 후: 이관/01_실행가이드 §G(RLS 격리 검증)로 확인.
