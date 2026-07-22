-- 17_perm_core.sql
-- 통합 권한 코어 v1 — 부서축 CORE + 개인 예외(perm_grant) + 판정 단일화(perm_effective)
-- 적용일 2026-07-22 · Supabase 마이그레이션: perm_core_v1 / perm_core_v1_functions / perm_core_v1_admin_rpc / perm_core_v1_reason_fix
--
-- 배경(적용 전 상태의 문제):
--   1) 판정 로직이 4곳에 복제 — jeil-me(페이지) · jeil-chat(resolveErpScope) · jeil-hr(dept==='인사팀' 하드코딩)
--      · erp_finance_overview(RPC). 콘솔에서 권한을 바꿔도 게이트마다 결과가 달라질 수 있었다.
--   2) 개인 단위 예외 수단 부재 — 한 사람에게 모듈 하나를 더 주려면 portal_admin(급여 포함 전권)뿐 → 권한 과잉.
--   3) 회수 누락 위험 — 대행·프로젝트성 권한에 기간 개념이 없었다.
--
-- 설계 원칙:
--   · CORE는 부서축: dept_erp_scope(ERP 모듈) · portal_page(페이지 공개범위). 기본은 전부 부서로 준다.
--   · 개인은 예외만: perm_grant(scope_type = role|dept|erp_module|page|onedrive). 판정 우선순위 deny > allow > 부서.
--   · 기간 권한: valid_to 경과 시 자동 소멸(회수를 잊어도 권한이 남지 않음).
--   · 사유 필수 + 전 변경 감사(perm_audit). 부여·회수·유효권한 조회까지 기록.
--   · 확장 축 선반영: scope_type='onedrive' — 팀별 OneDrive 폴더 권한을 같은 체계로 관리하기 위한 자리.
--   · 판정은 public.perm_effective(upn) 하나. 모든 게이트가 이 결과만 강제한다(중복 판정 금지).
-- 재현/이관용 정본 — apply_migration으로 적용된 DDL의 사본.

-- ─────────────────────────────────────────────────────────────────────────
-- 1) 모듈 카탈로그(SSOT) — Edge Function 하드코딩 CATALOG를 대체
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.perm_module_catalog (
  module_key text primary key,
  label      text not null,
  sensitive  boolean not null default false,   -- 민감: 개인 page 예외만으로는 열리지 않음(모듈 권한 필수)
  note       text,
  sort       int not null default 100
);
insert into public.perm_module_catalog(module_key,label,sensitive,sort) values
  ('sales','매출',false,10),('purchase','매입',false,20),('inventory','재고',false,30),
  ('item','품목',false,40),('pur_order','발주·구매요청',false,50),('user_dept','사용자·부서',false,60),
  ('payroll','급여·인사',true,70),('finance','자금·회계',true,80)
on conflict (module_key) do update set label=excluded.label, sensitive=excluded.sensitive, sort=excluded.sort;

-- ─────────────────────────────────────────────────────────────────────────
-- 2) 개인 예외 권한 + 권한 변경 감사
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.perm_grant (
  id         bigint generated always as identity primary key,
  upn        text not null,
  scope_type text not null,                    -- role | dept | erp_module | page | onedrive
  scope_key  text not null,                    -- admin/auditor | 부서명 | 모듈키 | page_key | 폴더키
  effect     text not null default 'allow',    -- allow | deny (deny 우선)
  valid_from timestamptz not null default now(),
  valid_to   timestamptz,                      -- null=무기한
  reason     text not null,
  granted_by text not null,
  granted_at timestamptz not null default now(),
  revoked_by text, revoked_at timestamptz,
  constraint perm_grant_scope_chk check (scope_type in ('role','dept','erp_module','page','onedrive')),
  constraint perm_grant_effect_chk check (effect in ('allow','deny'))
);
create unique index if not exists perm_grant_active_uq
  on public.perm_grant(lower(upn), scope_type, scope_key) where revoked_at is null;
create index if not exists perm_grant_upn_ix on public.perm_grant(lower(upn)) where revoked_at is null;

create table if not exists public.perm_audit (
  id     bigint generated always as identity primary key,
  actor  text not null,
  action text not null,                        -- grant | revoke | view_effective | ...
  target text,
  detail jsonb,
  at     timestamptz not null default now()
);
create index if not exists perm_audit_at_ix on public.perm_audit(at desc);

alter table public.perm_module_catalog enable row level security;
alter table public.perm_grant  enable row level security;
alter table public.perm_audit  enable row level security;
-- perm_module_catalog: 사내 읽기 허용 / perm_grant·perm_audit: 정책 없음 = 전면 차단(service_role 전용)
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='perm_module_catalog' and policyname='internal_select_perm_catalog') then
    create policy internal_select_perm_catalog on public.perm_module_catalog for select to authenticated
      using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
  end if;
end $$;
grant select on public.perm_module_catalog to authenticated, service_role;
grant select, insert, update, delete on public.perm_grant, public.perm_audit to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 3) 판정 SSOT: public.perm_effective(upn) → jsonb
--    { upn, emp_nm, dept_nm, depts[], is_admin, is_auditor, role, dept_admin_of[],
--      erp_modules[], grants[], pages[{page_key,allowed,reason,...}], onedrive[], as_of }
--    ※ 함수 본문 전문은 마이그레이션 perm_core_v1_functions + perm_core_v1_reason_fix 참조.
--      (여기서는 계약과 판정 규칙만 정본으로 남긴다 — 함수 정의는 DB가 정답.)
--    판정 규칙:
--      · is_admin = portal_admin 등록 or 개인 role:admin grant
--      · depts    = 소속부서(v_erp_user_dept) ∪ 개인 dept grant(겸직·대행)
--      · modules  = admin이면 카탈로그 전체, 아니면 (depts의 dept_erp_scope ∪ 개인 allow) − 개인 deny
--      · pages    = portal_page.visibility(전사 공개|부서 전용|지정 부서 공유) + erp_module 보유 강제
--                   개인 page deny는 무조건 차단, 개인 page allow는 허용(단 민감 모듈 페이지는 모듈 권한 필수)
-- ─────────────────────────────────────────────────────────────────────────
--   create or replace function public.perm_effective(p_upn text) returns jsonb
--     language plpgsql stable security definer set search_path to 'public' ...
--   create or replace function public.perm_can(p_upn text, p_scope_type text, p_scope_key text) returns boolean ...
revoke all on function public.perm_effective(text) from public, authenticated, anon;
grant execute on function public.perm_effective(text) to service_role;
revoke all on function public.perm_can(text,text,text) from public, anon;
grant execute on function public.perm_can(text,text,text) to service_role, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 4) 관리 RPC (관리자 콘솔 → jeil-chat-admin(service_role) 경유)
--    perm_grant_set(actor, upn, scope_type, scope_key, effect, reason, valid_to) — 사유 필수·중복 시 재부여
--    perm_grant_revoke(actor, id) — 이력 보존(revoked_at) + 감사
--    perm_grant_list() — 활성/만료/회수 전체 목록(부서_이름 라벨 포함)
-- ─────────────────────────────────────────────────────────────────────────
revoke all on function public.perm_grant_set(text,text,text,text,text,text,timestamptz) from public, authenticated, anon;
revoke all on function public.perm_grant_revoke(text,bigint) from public, authenticated, anon;
revoke all on function public.perm_grant_list() from public, authenticated, anon;
grant execute on function public.perm_grant_set(text,text,text,text,text,text,timestamptz) to service_role;
grant execute on function public.perm_grant_revoke(text,bigint) to service_role;
grant execute on function public.perm_grant_list() to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 5) 게이트 통합(코드 측) — 2026-07-22 배포
--    jeil-me v4        : 자체 판정 제거 → perm_effective 호출. catalog도 DB(perm_module_catalog).
--    jeil-hr v2        : dept==='인사팀' 하드코딩 제거 → payroll 모듈 보유로 판정.
--    jeil-chat v27     : resolveErpScope → perm_effective. get_my_access가 개인 예외·판정 사유까지 표시.
--    jeil-chat-admin v12: grant_perm·revoke_perm·effective_perm 액션 + perm_grants·perm_audit 응답.
--    erp_finance_overview: 부서 하드체크 → perm_effective(finance 모듈)로 교체(이 파일 §3 계약 적용).
-- ─────────────────────────────────────────────────────────────────────────

-- ── 검증(참고) ─────────────────────────────────────────────────────────
--   select public.perm_effective('user@jeilm.co.kr');
--   select public.perm_grant_set('actor@jeilm.co.kr','user@jeilm.co.kr','erp_module','finance','allow','자금 대행', now()+interval '30 days');
--   select * from public.perm_grant_list();
--   ※ perm_effective는 STABLE — 같은 문(statement) 안에서 방금 넣은 grant는 보이지 않는다(문 분리 후 확인).

-- ── 롤백(필요 시) ──────────────────────────────────────────────────────
-- drop function if exists public.perm_grant_list(), public.perm_grant_revoke(text,bigint),
--   public.perm_grant_set(text,text,text,text,text,text,timestamptz), public.perm_can(text,text,text), public.perm_effective(text);
-- drop table if exists public.perm_grant, public.perm_audit, public.perm_module_catalog;
-- (게이트 4종은 이전 버전으로 재배포 필요 — 함수만 되돌리면 판정 호출이 실패한다.)
