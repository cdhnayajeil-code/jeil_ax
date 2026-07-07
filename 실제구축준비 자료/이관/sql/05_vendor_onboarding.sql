-- ============================================================
-- 협력사 온보딩 — ERP 협력사 마스터 + 가입신청/승인 (이미 MCP로 적용됨, 재현용)
-- 흐름: 협력사 이메일 가입 → 이메일 인증 → 트리거가 vendor_application(pending) 생성
--       → 관리자 페이지에서 ERP 마스터 매칭 후 승인(Edge Function approve-vendor)
--       → 승인 시 app_metadata.role='vendor', vendor_bp=[bp_cd] → RLS로 자기 발주만
-- ============================================================

-- (1) ERP 협력사 마스터 (운영: erp_ro.biz_partner = B_BIZ_PARTNER)
create table if not exists vendor_master (
  bp_cd text primary key, bp_nm text not null, biz_no text,
  active boolean default true, synced_at timestamptz default now()
);
alter table vendor_master enable row level security;
drop policy if exists internal_all on vendor_master;
drop policy if exists vendor_self  on vendor_master;
create policy internal_all on vendor_master for all
  using (public.is_internal()) with check (public.is_internal());
create policy vendor_self on vendor_master for select
  using (bp_cd = any (public.vendor_bp()));

-- (2) 가입 신청/계정
create table if not exists vendor_application (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid, email text not null,
  applicant_name text, phone text, company_input text, biz_no_input text,
  matched_bp_cd text references vendor_master(bp_cd),
  status text not null default 'pending',   -- pending|approved|rejected
  reviewed_by text, reviewed_at timestamptz, review_note text,
  created_at timestamptz default now()
);
alter table vendor_application enable row level security;
drop policy if exists internal_all     on vendor_application;
drop policy if exists applicant_own    on vendor_application;
drop policy if exists applicant_insert on vendor_application;
create policy internal_all on vendor_application for all
  using (public.is_internal()) with check (public.is_internal());
create policy applicant_own on vendor_application for select
  using (auth_user_id = auth.uid());
create policy applicant_insert on vendor_application for insert
  with check (auth_user_id = auth.uid());

-- (3) 가입 시 신청서 자동 생성 트리거 (사내 도메인 제외)
create or replace function public.handle_new_vendor_signup()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.email like '%@jeilm.co.kr' then return new; end if;
  insert into public.vendor_application(auth_user_id,email,applicant_name,phone,company_input,biz_no_input)
  values (new.id, new.email,
    new.raw_user_meta_data->>'applicant_name', new.raw_user_meta_data->>'phone',
    new.raw_user_meta_data->>'company', new.raw_user_meta_data->>'biz_no');
  return new;
end; $$;
drop trigger if exists on_auth_vendor_signup on auth.users;
create trigger on_auth_vendor_signup after insert on auth.users
  for each row execute function public.handle_new_vendor_signup();

-- (4) ERP 17개사 시드 (상호 부분마스킹 · 사업자번호 데모값)
insert into vendor_master(bp_cd,bp_nm,biz_no) values
 ('02128','(주)삼성에스티','128-81-43021'),('00206','(주)대신스텐레스','206-81-55012'),
 ('00209','(주)서일스텐','209-81-60113'),('01261','(주)의성쎄니타리','261-81-22014'),
 ('3518','선준테크(주)','518-81-33015'),('00245','이천베아링','245-81-44016'),
 ('01768','(주)엠워텍','768-81-50017'),('00324','(주)상우웰스터','324-81-61018'),
 ('02344','(주)에스티엠자동화','344-81-72019'),('02389','대신전기상사','389-81-83020'),
 ('01699','(주)신호종합배관','699-81-94021'),('02021','한영옥소프트','021-81-15022'),
 ('4521','(주)지아이텍','521-81-26023'),('00196','경인SNS','196-81-37024'),
 ('01020','삼성특수유리','020-81-48025'),('01631','제이에스필터(주)','631-81-59026'),
 ('4229','오성테크','229-81-60027')
on conflict (bp_cd) do nothing;
