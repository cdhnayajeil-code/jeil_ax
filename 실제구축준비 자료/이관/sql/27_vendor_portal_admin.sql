-- 27_vendor_portal_admin.sql
-- 협력사 포털 "통합 관리자 계정"(role=vendor_admin) — 전체 거래처 읽기 전용 조회
-- 적용: Supabase 마이그레이션 `vendor_portal_admin_readonly` + `vendor_portal_admin_storage_read` (2026-08-20)
-- 배경: 협력사 포털은 계정 1개 = 거래처 1개(행수준 격리)였다. 구매팀·관리자가 거래처를 골라
--       전 거래처의 발주·사진·검수·메시지를 확인할 수 있도록 별도 역할을 신설한다.
-- 원칙: 읽기 전용. SELECT 정책만 부여하고 INSERT/UPDATE/DELETE 정책은 만들지 않는다
--       (실거래 액션 대행 금지 — CLAUDE.md §1.6). 발급은 사내 portal_admin만(Edge Function).

/* ── 1. 역할 판정 헬퍼 ────────────────────────────────────────────────
   기존: is_internal()=사내(role=internal), is_vendor_admin()=사내 협력사관리 권한자,
        vendor_bp()=협력사 거래처 격리 배열.
   추가: is_vendor_viewer()=협력사 포털 통합 관리자 계정. */
create or replace function public.is_vendor_viewer() returns boolean
language sql stable set search_path to '' as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'vendor_admin', false);
$$;
comment on function public.is_vendor_viewer() is
  '협력사 포털 통합 관리자 계정 여부(JWT app_metadata.role = vendor_admin). 전체 거래처 읽기 전용 — 쓰기 정책은 부여하지 않는다.';

/* ── 2. 계정 대장 ─────────────────────────────────────────────────────
   거래처(bp_cd)에 묶이지 않으므로 vendor_account와 분리한다. */
create table if not exists public.vendor_admin_account (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  auth_user_id  uuid unique,
  display_name  text,
  phone         text,
  status        text not null default 'active' check (status in ('active','disabled')),
  created_by    text,
  created_at    timestamptz not null default now(),
  last_reset_at timestamptz
);
comment on table public.vendor_admin_account is
  '협력사 포털 통합 관리자 계정 대장(role=vendor_admin). 전체 거래처 읽기 전용 계정 — 발급/초기화/비활성은 Edge Function(vendor-admin-provision, service_role)만 수행.';

alter table public.vendor_admin_account enable row level security;

drop policy if exists vaa_select on public.vendor_admin_account;
create policy vaa_select on public.vendor_admin_account
  for select using (public.is_internal());          -- 사내만 열람
drop policy if exists vaa_write on public.vendor_admin_account;
create policy vaa_write on public.vendor_admin_account
  for all using (public.is_vendor_admin()) with check (public.is_vendor_admin());  -- 협력사관리 권한자만

/* ── 3. 전체 거래처 읽기 전용 정책 ───────────────────────────────────
   협력사(vendor_own)·사내(internal_all) 정책은 그대로 두고 SELECT 정책만 병렬로 추가한다. */
drop policy if exists vendor_viewer_select on public.sp_order_header;
create policy vendor_viewer_select on public.sp_order_header   for select using (public.is_vendor_viewer());
drop policy if exists vendor_viewer_select on public.sp_order_state;
create policy vendor_viewer_select on public.sp_order_state    for select using (public.is_vendor_viewer());
drop policy if exists vendor_viewer_select on public.sp_photo;
create policy vendor_viewer_select on public.sp_photo          for select using (public.is_vendor_viewer());
drop policy if exists vendor_viewer_select on public.sp_message;
create policy vendor_viewer_select on public.sp_message        for select using (public.is_vendor_viewer());
drop policy if exists vendor_viewer_select on public.sp_insp_request;
create policy vendor_viewer_select on public.sp_insp_request   for select using (public.is_vendor_viewer());
drop policy if exists vendor_viewer_select on public.sp_inspection;
create policy vendor_viewer_select on public.sp_inspection     for select using (public.is_vendor_viewer());
drop policy if exists vendor_viewer_select on public.sp_inspection_log;
create policy vendor_viewer_select on public.sp_inspection_log for select using (public.is_vendor_viewer());
drop policy if exists vendor_viewer_select on public.vendor_master;
create policy vendor_viewer_select on public.vendor_master     for select using (public.is_vendor_viewer());

-- 검사 증빙 사진 열람(서명 URL 발급)만 허용. 업로드/삭제 불가.
drop policy if exists vendor_photos_viewer on storage.objects;
create policy vendor_photos_viewer on storage.objects
  for select using (bucket_id = 'vendor-photos' and public.is_vendor_viewer());

/* ── 4. 의도적으로 부여하지 않은 것 ───────────────────────────────────
   - vendor_account(협력사 담당자 이메일·연락처) SELECT: 개인정보 최소화(CLAUDE.md §1.7) — 미부여.
   - 모든 쓰기 정책: 상태변경·사진등록·메시지·검수요청·읽음처리는 DB에서 차단된다.
     (실측: UPDATE 0행, INSERT 42501 row-level security 위반)

   ── 5. 검증 쿼리(참고) ───────────────────────────────────────────────
   begin;
     set local role authenticated;
     set local request.jwt.claims = '{"role":"authenticated","email":"vp@example.com",
       "app_metadata":{"role":"vendor_admin","vendor_bp":[]}}';
     select public.is_vendor_viewer(), (select count(*) from public.sp_order_header);
   rollback;
*/
