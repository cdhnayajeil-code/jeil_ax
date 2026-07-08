-- 09_erp_user_dept_mapping.sql
-- ERP 사용자↔부서↔사원 대사·매핑 계층 (중간DB erp_ro)
-- 적용일 2026-07-08 · Supabase 마이그레이션: erp_user_dept_mapping
-- 원천: JEILMNS.dbo.Z_USR_MAST_REC(사용자 마스터) · JEILMNS.dbo.B_ACCT_DEPT(부서 마스터)
-- 배경(관리자 확인 2026-07-08):
--   · usr_id = MS 이메일 계정(SSOT). @ 포함 + USE_YN='Y' 건만 적용(99건).
--   · usr_nm = '부서명_이름'. 밑줄 정확히 1개(파싱 안전). (휴직)/(퇴사)는 이름 접미로 상태 표기.
--   · 부서는 usr_nm의 부서명으로 매칭. B_ACCT_DEPT 대조는 대사 값(존재 여부)으로만 사용, 인사테이블 실검증은 추후.
--   · Z_USR_MAST_REC에는 EMP_NO/DEPT_CD 컬럼이 없어 부서 정보는 usr_nm 텍스트가 유일 소스.
-- 원칙(CLAUDE.md §4): erp_ro/etl_meta는 REST 비노출. 노출 진입점은 public.v_erp_* 뷰(security_invoker + RLS)뿐.
-- 재현/이관용 정본 — apply_migration으로 적용된 DDL의 사본.

-- ─────────────────────────────────────────────────────────────────────────
-- 1) 원천 미러 테이블
-- ─────────────────────────────────────────────────────────────────────────

-- 1-a) 사용자 마스터 미러 (Z_USR_MAST_REC 중 사용·이메일 계정만)
create table if not exists erp_ro.usr_master_s (
  usr_id      text primary key,            -- 계정ID = MS 이메일(SSOT)
  usr_nm      text not null,               -- 원문 '부서명_이름[(휴직)|(퇴사)]'
  use_yn      boolean not null default true,
  src_updated timestamptz,                 -- Z_USR_MAST_REC.UPDT_DT
  synced_at   timestamptz not null default now(),
  batch_id    uuid
);
comment on table erp_ro.usr_master_s is 'ERP 사용자 마스터 미러(Z_USR_MAST_REC) — USE_YN=Y AND usr_id LIKE %@% 만 적재. 부서/사원은 usr_nm 파싱(v_user_dept_map).';

-- 1-b) 부서 마스터 미러 (B_ACCT_DEPT) — 대사(부서명 존재 확인)·부서-사원 관계용
create table if not exists erp_ro.dept_master_s (
  org_change_id text not null default '',   -- 조직개편ID(이력 버전)
  dept_cd       text not null,
  dept_nm       text,                       -- 부서명(usr_nm 부서명과 매칭)
  par_dept_cd   text,
  dept_full_nm  text,
  end_dept_fg   text,                        -- 말단부서여부
  src_updated   timestamptz,
  synced_at     timestamptz not null default now(),
  batch_id      uuid,
  primary key (org_change_id, dept_cd)
);
comment on table erp_ro.dept_master_s is 'ERP 부서 마스터 미러(B_ACCT_DEPT) — 파싱 부서명 대사·부서-사원 관계 기준.';

alter table erp_ro.usr_master_s  enable row level security;
alter table erp_ro.dept_master_s enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='erp_ro' and tablename='usr_master_s' and policyname='internal_select_usr_master_s') then
    create policy internal_select_usr_master_s on erp_ro.usr_master_s
      for select to authenticated
      using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
  end if;
  if not exists (select 1 from pg_policies where schemaname='erp_ro' and tablename='dept_master_s' and policyname='internal_select_dept_master_s') then
    create policy internal_select_dept_master_s on erp_ro.dept_master_s
      for select to authenticated
      using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2) 적재 RPC 확장 (service_role 전용, erp_etl_upsert에 분기 추가)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.erp_etl_upsert(p_table text, p_rows jsonb)
  returns integer
  language plpgsql
  security definer
  set search_path to ''
as $function$
declare n integer := 0;
begin
  if p_table = 'table_dict' then
    insert into erp_ro.table_dict (table_name, module, row_cnt, columns, keywords, synced_at)
    select x.table_name, x.module, x.row_cnt, x.columns,
           (select coalesce(array_agg(v), '{}') from jsonb_array_elements_text(coalesce(x.keywords,'[]'::jsonb)) v),
           now()
    from jsonb_to_recordset(p_rows) as x(table_name text, module text, row_cnt bigint, columns jsonb, keywords jsonb)
    on conflict (table_name) do update
      set module = excluded.module, row_cnt = excluded.row_cnt,
          columns = excluded.columns, keywords = excluded.keywords, synced_at = now();
  elsif p_table = 'item_master_s' then
    insert into erp_ro.item_master_s (item_code, item_name, spec, unit, item_class, use_yn, synced_at, src_updated, batch_id)
    select x.item_code, x.item_name, x.spec, x.unit, x.item_class, x.use_yn, now(), x.src_updated, x.batch_id
    from jsonb_to_recordset(p_rows) as x(item_code text, item_name text, spec text, unit text, item_class text, use_yn boolean, src_updated timestamptz, batch_id uuid)
    on conflict (item_code) do update
      set item_name = excluded.item_name, spec = excluded.spec, unit = excluded.unit,
          item_class = excluded.item_class, use_yn = excluded.use_yn,
          synced_at = excluded.synced_at, src_updated = excluded.src_updated, batch_id = excluded.batch_id;
  elsif p_table = 'sales_orders_m' then
    insert into erp_ro.sales_orders_m (ym, bp_code, bp_name, order_amt, sales_amt, collect_amt, order_cnt, synced_at, src_updated, batch_id)
    select x.ym, x.bp_code, x.bp_name, coalesce(x.order_amt,0), coalesce(x.sales_amt,0), coalesce(x.collect_amt,0), coalesce(x.order_cnt,0), now(), x.src_updated, x.batch_id
    from jsonb_to_recordset(p_rows) as x(ym text, bp_code text, bp_name text, order_amt numeric, sales_amt numeric, collect_amt numeric, order_cnt integer, src_updated timestamptz, batch_id uuid)
    on conflict (ym, bp_code) do update
      set bp_name = excluded.bp_name, order_amt = excluded.order_amt, sales_amt = excluded.sales_amt,
          collect_amt = excluded.collect_amt, order_cnt = excluded.order_cnt,
          synced_at = excluded.synced_at, src_updated = excluded.src_updated, batch_id = excluded.batch_id;
  elsif p_table = 'purchase_m' then
    insert into erp_ro.purchase_m (ym, bp_code, bp_name, purchase_amt, iv_cnt, synced_at, src_updated, batch_id)
    select x.ym, x.bp_code, x.bp_name, coalesce(x.purchase_amt,0), coalesce(x.iv_cnt,0), now(), x.src_updated, x.batch_id
    from jsonb_to_recordset(p_rows) as x(ym text, bp_code text, bp_name text, purchase_amt numeric, iv_cnt integer, src_updated timestamptz, batch_id uuid)
    on conflict (ym, bp_code) do update
      set bp_name = excluded.bp_name, purchase_amt = excluded.purchase_amt, iv_cnt = excluded.iv_cnt,
          synced_at = excluded.synced_at, src_updated = excluded.src_updated, batch_id = excluded.batch_id;
  elsif p_table = 'inventory_d' then
    insert into erp_ro.inventory_d (ymd, item_code, wh_code, in_qty, out_qty, stock_qty, synced_at, src_updated, batch_id)
    select x.ymd, x.item_code, x.wh_code, coalesce(x.in_qty,0), coalesce(x.out_qty,0), x.stock_qty, now(), x.src_updated, x.batch_id
    from jsonb_to_recordset(p_rows) as x(ymd date, item_code text, wh_code text, in_qty numeric, out_qty numeric, stock_qty numeric, src_updated timestamptz, batch_id uuid)
    on conflict (ymd, item_code, wh_code) do update
      set in_qty = excluded.in_qty, out_qty = excluded.out_qty, stock_qty = excluded.stock_qty,
          synced_at = excluded.synced_at, src_updated = excluded.src_updated, batch_id = excluded.batch_id;
  elsif p_table = 'pur_order_s' then
    insert into erp_ro.pur_order_s (po_no, po_seq, po_dt, bp_code, bp_name, item_code, item_name, dlvy_dt, po_qty, po_unit, po_amt, po_sts, rcpt_qty, subcontra_flg, cls_flg, synced_at, src_updated, batch_id)
    select x.po_no, x.po_seq, x.po_dt, x.bp_code, x.bp_name, x.item_code, x.item_name, x.dlvy_dt, x.po_qty, x.po_unit, x.po_amt, x.po_sts, x.rcpt_qty, x.subcontra_flg, x.cls_flg, now(), x.src_updated, x.batch_id
    from jsonb_to_recordset(p_rows) as x(po_no text, po_seq int, po_dt date, bp_code text, bp_name text, item_code text, item_name text, dlvy_dt date, po_qty numeric, po_unit text, po_amt numeric, po_sts text, rcpt_qty numeric, subcontra_flg text, cls_flg text, src_updated timestamptz, batch_id uuid)
    on conflict (po_no, po_seq) do update
      set po_dt = excluded.po_dt, bp_code = excluded.bp_code, bp_name = excluded.bp_name,
          item_code = excluded.item_code, item_name = excluded.item_name, dlvy_dt = excluded.dlvy_dt,
          po_qty = excluded.po_qty, po_unit = excluded.po_unit, po_amt = excluded.po_amt,
          po_sts = excluded.po_sts, rcpt_qty = excluded.rcpt_qty,
          subcontra_flg = excluded.subcontra_flg, cls_flg = excluded.cls_flg,
          synced_at = excluded.synced_at, src_updated = excluded.src_updated, batch_id = excluded.batch_id;
  elsif p_table = 'usr_master_s' then
    insert into erp_ro.usr_master_s (usr_id, usr_nm, use_yn, src_updated, synced_at, batch_id)
    select x.usr_id, x.usr_nm, coalesce(x.use_yn,true), x.src_updated, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(usr_id text, usr_nm text, use_yn boolean, src_updated timestamptz, batch_id uuid)
    on conflict (usr_id) do update
      set usr_nm = excluded.usr_nm, use_yn = excluded.use_yn,
          synced_at = excluded.synced_at, src_updated = excluded.src_updated, batch_id = excluded.batch_id;
  elsif p_table = 'dept_master_s' then
    insert into erp_ro.dept_master_s (org_change_id, dept_cd, dept_nm, par_dept_cd, dept_full_nm, end_dept_fg, src_updated, synced_at, batch_id)
    select coalesce(x.org_change_id,''), x.dept_cd, x.dept_nm, x.par_dept_cd, x.dept_full_nm, x.end_dept_fg, x.src_updated, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(org_change_id text, dept_cd text, dept_nm text, par_dept_cd text, dept_full_nm text, end_dept_fg text, src_updated timestamptz, batch_id uuid)
    on conflict (org_change_id, dept_cd) do update
      set dept_nm = excluded.dept_nm, par_dept_cd = excluded.par_dept_cd,
          dept_full_nm = excluded.dept_full_nm, end_dept_fg = excluded.end_dept_fg,
          synced_at = excluded.synced_at, src_updated = excluded.src_updated, batch_id = excluded.batch_id;
  else
    raise exception '허용되지 않은 테이블: %', p_table;
  end if;
  get diagnostics n = row_count;
  return n;
end $function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3) 파싱·대사 뷰 (erp_ro 내부)
-- ─────────────────────────────────────────────────────────────────────────

-- 3-0) 부서명 사전(대사 기준): B_ACCT_DEPT 부서명 distinct(공백 정리)
create or replace view erp_ro.v_dept_dim as
  select btrim(dept_nm) as dept_nm, min(dept_cd) as dept_cd
  from erp_ro.dept_master_s
  where dept_nm is not null and btrim(dept_nm) <> ''
  group by btrim(dept_nm);

-- 3-1) 사용자→부서→사원 파싱 매핑(대사 값 포함)
create or replace view erp_ro.v_user_dept_map as
with parsed as (
  select
    m.usr_id                                             as email,
    m.usr_nm                                             as usr_nm_raw,
    m.use_yn,
    m.src_updated,
    m.synced_at,
    (position('_' in m.usr_nm) > 0)                      as has_sep,
    btrim(split_part(m.usr_nm, '_', 1))                  as dept_nm,
    btrim(substr(m.usr_nm, position('_' in m.usr_nm) + 1)) as name_part
  from erp_ro.usr_master_s m
)
select
  p.email,
  p.usr_nm_raw,
  p.dept_nm,
  -- 상태(이름 접미)
  case when p.name_part like '%(퇴사)%' then '퇴사'
       when p.name_part like '%(휴직)%' then '휴직'
       else '재직' end                                   as status,
  -- 이름(상태 접미 제거)
  btrim(regexp_replace(p.name_part, '\((퇴사|휴직)\)', '', 'g')) as emp_nm,
  d.dept_cd                                              as matched_dept_cd,
  (d.dept_nm is not null)                                as dept_matched,
  -- 테스트/더미 계정 여부
  (lower(p.dept_nm) = 'admin' or p.email ilike 'test@%' or p.email ilike 'test_%@%') as is_test,
  p.has_sep,
  p.use_yn,
  p.src_updated,
  p.synced_at
from parsed p
left join erp_ro.v_dept_dim d on d.dept_nm = p.dept_nm;

-- 3-2) 정상 매핑(연동용): 재직 · 형식정상 · 비테스트 · 부서일치(불일치 자동제외, 2026-07-08 관리자 결정)
--      불일치(형식오류·테스트계정·상태이상·부서불일치)는 v_user_dept_recon 에만 잔존.
create or replace view erp_ro.v_user_dept as
  select email, dept_nm, emp_nm, matched_dept_cd, dept_matched, src_updated, synced_at
  from erp_ro.v_user_dept_map
  where has_sep and emp_nm <> '' and status = '재직' and not is_test and dept_matched;

-- 3-3) 대사 리포트(불일치 목록) — 유형별 사유
create or replace view erp_ro.v_user_dept_recon as
  select email, usr_nm_raw, dept_nm, emp_nm, status,
    case
      when not has_sep or emp_nm = '' then '형식오류'
      when is_test                    then '테스트계정'
      when status <> '재직'           then '상태이상'   -- 활성계정인데 (퇴사)/(휴직) 표기
      when not dept_matched           then '부서불일치' -- 파싱 부서명이 B_ACCT_DEPT에 없음
    end as recon_type,
    dept_matched, is_test, has_sep, src_updated
  from erp_ro.v_user_dept_map
  where (not has_sep) or emp_nm = '' or is_test or status <> '재직' or not dept_matched;

-- 3-4) 부서별 사원 명부(부서-사원 관계)
create or replace view erp_ro.v_dept_roster as
  select dept_nm,
         count(*)                              as emp_cnt,
         bool_or(dept_matched)                 as dept_matched,
         string_agg(emp_nm, ', ' order by emp_nm) as members
  from erp_ro.v_user_dept
  group by dept_nm;

-- ─────────────────────────────────────────────────────────────────────────
-- 4) public 노출 뷰(사내 전용, security_invoker + erp_ro RLS)
-- ─────────────────────────────────────────────────────────────────────────
grant usage on schema erp_ro to authenticated, service_role;
grant select on erp_ro.usr_master_s, erp_ro.dept_master_s to authenticated, service_role;

create or replace view public.v_erp_user_dept with (security_invoker=true) as
  select email, dept_nm, emp_nm, matched_dept_cd, dept_matched, src_updated, synced_at
  from erp_ro.v_user_dept;

create or replace view public.v_erp_user_dept_recon with (security_invoker=true) as
  select email, usr_nm_raw, dept_nm, emp_nm, status, recon_type, dept_matched, src_updated
  from erp_ro.v_user_dept_recon;

create or replace view public.v_erp_dept_roster with (security_invoker=true) as
  select dept_nm, emp_cnt, dept_matched, members
  from erp_ro.v_dept_roster;

grant select on
  public.v_erp_user_dept, public.v_erp_user_dept_recon, public.v_erp_dept_roster
to authenticated, service_role;

-- ── 검증(참고) ─────────────────────────────────────────────────────────
--   select count(*) from public.v_erp_user_dept;          -- 정상 매핑(재직·비테스트)
--   select recon_type, count(*) from public.v_erp_user_dept_recon group by recon_type;
--   select * from public.v_erp_dept_roster order by emp_cnt desc;

-- ── 롤백(필요 시) ──────────────────────────────────────────────────────
-- drop view if exists public.v_erp_user_dept, public.v_erp_user_dept_recon, public.v_erp_dept_roster;
-- drop view if exists erp_ro.v_dept_roster, erp_ro.v_user_dept, erp_ro.v_user_dept_recon, erp_ro.v_user_dept_map, erp_ro.v_dept_dim;
-- drop table if exists erp_ro.usr_master_s, erp_ro.dept_master_s;
-- (erp_etl_upsert의 usr_master_s/dept_master_s 분기 제거는 함수 재정의로)
