-- 06_vendor_provisioning.sql
-- 협력사 계정 관리 — 관리자 주도(ERP 거래처 기반) 등록 모델
-- 적용: Supabase Management API(/database/query) 또는 대시보드 SQL Editor
-- 비밀값 없음(CLAUDE.md §1). service_role 작업은 Edge Function에서만 수행.

-- ─────────────────────────────────────────────
-- 1. 협력사관리 권한자 (사내 SSO 사용자 지정)
-- ─────────────────────────────────────────────
create table if not exists public.portal_admin (
  email      text primary key,           -- @jeilm.co.kr (SSO 사용자)
  granted_by text,
  granted_at timestamptz not null default now()
);
-- 부트스트랩: 최초 관리자 1인 보장(잠금 방지)
insert into public.portal_admin(email, granted_by)
values ('dh.choi@jeilm.co.kr', 'system')
on conflict (email) do nothing;

-- ─────────────────────────────────────────────
-- 2. 거래처↔협력사 계정 연결
-- ─────────────────────────────────────────────
create table if not exists public.vendor_account (
  id            uuid primary key default gen_random_uuid(),
  bp_cd         text not null references public.vendor_master(bp_cd),
  email         text not null unique,
  auth_user_id  uuid,
  contact_name  text,
  phone         text,
  status        text not null default 'active',  -- active | disabled
  created_by    text,                            -- 발급 관리자 email
  created_at    timestamptz not null default now(),
  last_reset_at timestamptz
);
create index if not exists idx_vendor_account_bp on public.vendor_account(bp_cd);

-- ─────────────────────────────────────────────
-- 3. 감사로그 (누가·언제·무엇을)
-- ─────────────────────────────────────────────
create table if not exists public.vendor_account_log (
  id           bigserial primary key,
  action       text not null,            -- create | reset_password | disable | enable
  target_email text,
  bp_cd        text,
  actor_email  text,                     -- 처리 관리자
  actor_name   text,
  acted_at     timestamptz not null default now(),
  detail       jsonb
);
create index if not exists idx_vendor_account_log_at on public.vendor_account_log(acted_at desc);

-- ─────────────────────────────────────────────
-- 4. 권한 헬퍼: 협력사관리 권한자 여부 (사내 + portal_admin)
-- ─────────────────────────────────────────────
-- invoker 권한(기본): 호출자가 internal이면 portal_admin(pa_select=is_internal) 조회 가능.
-- SECURITY DEFINER를 쓰지 않아 권한상승 경고를 피한다.
create or replace function public.is_vendor_admin()
returns boolean
language sql stable set search_path = ''
as $$
  select public.is_internal() and exists (
    select 1 from public.portal_admin pa
    where pa.email = (auth.jwt() ->> 'email')
  );
$$;

-- ─────────────────────────────────────────────
-- 5. RLS
-- ─────────────────────────────────────────────
alter table public.portal_admin       enable row level security;
alter table public.vendor_account      enable row level security;
alter table public.vendor_account_log  enable row level security;

-- portal_admin: 사내 조회, 권한자만 추가/삭제
drop policy if exists pa_select on public.portal_admin;
drop policy if exists pa_insert on public.portal_admin;
drop policy if exists pa_delete on public.portal_admin;
create policy pa_select on public.portal_admin for select using (public.is_internal());
create policy pa_insert on public.portal_admin for insert with check (public.is_vendor_admin());
create policy pa_delete on public.portal_admin for delete using (public.is_vendor_admin());

-- vendor_account: 사내 조회, 권한자만 변경(생성은 Edge Function=service_role 우회)
drop policy if exists va_select on public.vendor_account;
drop policy if exists va_write  on public.vendor_account;
create policy va_select on public.vendor_account for select using (public.is_internal());
create policy va_write  on public.vendor_account for all
  using (public.is_vendor_admin()) with check (public.is_vendor_admin());

-- vendor_account_log: 사내 조회만(insert는 Edge Function=service_role 우회)
drop policy if exists val_select on public.vendor_account_log;
create policy val_select on public.vendor_account_log for select using (public.is_internal());

-- ─────────────────────────────────────────────
-- 6. 자유가입 제거 (관리자 주도 일원화)
--    vendor_application 테이블은 레거시로 보존(데이터 손실 방지)
-- ─────────────────────────────────────────────
drop trigger if exists on_auth_vendor_signup on auth.users;
drop function if exists public.handle_new_vendor_signup();
