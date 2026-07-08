-- 12_erp_dept_module_suggest.sql
-- 부서별 ERP 모듈 '제안값'(참고용) — ERP 역할·메뉴 권한 기반. 자동 덮어쓰기 아님.
-- 적용일 2026-07-08 · Supabase 마이그레이션: erp_dept_module_suggest + erp_dept_erp_suggest_public_view
-- 관리자 결정(2026-07-08): ERP 역할 기반 자동값은 콘솔 '권한 상세'에 ◆ 참고표시로만 노출,
--   실제 dept_erp_scope(편집형 업무기준)는 그대로 권위. 자동 upsert 안 함.
-- 원천: JEILMNS.dbo.Z_USR_MAST_REC_USR_ROLE_ASSO → Z_USR_ROLE_MNU_AUTHZTN_ASSO(MNU_USE_YN='Y') → Z_CO_MAST_MNU(ModuleInitial)
--   ETL job usr_erp_module(etl_run.py) → erp_ro.usr_erp_module_s. 부서는 v_user_dept(email→dept) 매핑.
-- 재현/이관용 정본 — apply_migration으로 적용된 DDL의 사본.

-- 사용자별 ERP 접근 모듈(ModuleInitial) 미러
create table if not exists erp_ro.usr_erp_module_s (
  email          text not null,
  module_initial text not null,   -- ERP ModuleInitial (SD/MM/IM/MDM 등)
  synced_at      timestamptz not null default now(),
  batch_id       uuid,
  primary key (email, module_initial)
);
comment on table erp_ro.usr_erp_module_s is 'ERP 사용자별 접근 모듈(ModuleInitial) 미러 — 역할·메뉴 권한 기반. 부서별 ERP 모듈 제안값(v_dept_erp_suggest) 원천.';

alter table erp_ro.usr_erp_module_s enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='erp_ro' and tablename='usr_erp_module_s' and policyname='internal_select_usr_erp_module_s') then
    create policy internal_select_usr_erp_module_s on erp_ro.usr_erp_module_s for select to authenticated
      using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
  end if;
end $$;
grant select on erp_ro.usr_erp_module_s to authenticated, service_role;

-- 적재 RPC(public.erp_etl_upsert)에 usr_erp_module_s 분기 추가(전체 함수는 erp_etl_upsert_restore_full 마이그레이션 참조):
--   elsif p_table = 'usr_erp_module_s' then
--     insert ... on conflict (email, module_initial) do update ...

-- 부서별 ERP 모듈 제안값 (ModuleInitial→포털모듈 매핑은 아래 VALUES에서 편집)
--   MM(구매관리)은 purchase·pur_order 둘 다로 확장(ERP상 분리 불가 — 제안값이므로 둘 다 제시).
create or replace view erp_ro.v_dept_erp_suggest with (security_invoker=true) as
with map(module_initial, module_key) as (
  values ('SD','sales'), ('MM','purchase'), ('MM','pur_order'), ('IM','inventory'), ('MDM','item')
)
select distinct ud.dept_nm, m.module_key
from erp_ro.usr_erp_module_s u
join erp_ro.v_user_dept ud on ud.email = u.email
join map m on m.module_initial = u.module_initial;
grant select on erp_ro.v_dept_erp_suggest to authenticated, service_role;

-- public 노출(콘솔 jeil-chat-admin이 service_role로 조회)
create or replace view public.v_erp_dept_erp_suggest with (security_invoker=true) as
  select dept_nm, module_key from erp_ro.v_dept_erp_suggest;
grant select on public.v_erp_dept_erp_suggest to authenticated, service_role;

-- ── 롤백(필요 시) ──────────────────────────────────────────────────────
-- drop view if exists public.v_erp_dept_erp_suggest;
-- drop view if exists erp_ro.v_dept_erp_suggest;
-- drop table if exists erp_ro.usr_erp_module_s;
