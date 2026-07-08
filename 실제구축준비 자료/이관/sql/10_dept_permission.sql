-- 10_dept_permission.sql
-- 부서별 권한 설정(포털) — 관리자 콘솔 '권한 설정' 부서표의 영속 저장소.
-- 적용일 2026-07-08 · Supabase 마이그레이션: dept_permission
-- 부서명 기준은 ERP 사용자-부서 매핑(v_erp_dept_roster / v_erp_user_dept, 09 참조).
-- 관리자 콘솔(04)은 Entra 토큰 → jeil-chat-admin(Edge Function, service_role)로만 읽기/저장한다.
--   조회: jeil-chat-admin 응답의 dept_permissions(+ dept_mapping)
--   저장: POST {action:'save_dept_perm', rows:[...]} — portal_admin 검증 후 upsert.
-- 재현/이관용 정본 — apply_migration으로 적용된 DDL의 사본.

create table if not exists public.dept_permission (
  dept_nm          text primary key,          -- ERP 매핑 부서명(v_erp_dept_roster 기준)
  dept_admin_email text,                       -- 부서 관리자(해당 부서 구성원 이메일)
  erp_scope        text,                       -- ERP 데이터 접근 범위(모듈/설명)
  page_visibility  text default '부서 전용',    -- 페이지 기본 공개범위: 부서 전용 | 전사 공개 | 지정 부서 공유
  note             text,
  updated_by       text,
  updated_at       timestamptz not null default now()
);
comment on table public.dept_permission is '부서별 권한 설정(포털) — 관리자 콘솔에서 관리. 부서명 기준은 ERP 사용자-부서 매핑(v_erp_dept_roster).';

alter table public.dept_permission enable row level security;

-- 사내(role=internal) 읽기 허용. 쓰기 정책 없음 → service_role(Edge Function)만 저장 가능.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='dept_permission' and policyname='internal_select_dept_permission') then
    create policy internal_select_dept_permission on public.dept_permission
      for select to authenticated
      using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
  end if;
end $$;

grant select on public.dept_permission to authenticated;
grant select, insert, update, delete on public.dept_permission to service_role;

-- ── 롤백(필요 시) ──────────────────────────────────────────────────────
-- drop table if exists public.dept_permission;
