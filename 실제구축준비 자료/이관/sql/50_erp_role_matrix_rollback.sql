-- ============================================================================
-- 50_erp_role_matrix_rollback.sql — REQ-0057 되돌리기
--
-- 이 롤백이 별도 파일인 이유: 50번은 drop 만으로 되돌릴 수 없는 작업을 2건 한다.
--   1) public.erp_identity_upsert 를 재정의한다(34_identity_accounts.sql §9 를 덮어씀)
--      → 원본 정의를 여기에 그대로 실어야 복구된다.
--   2) erp_ro.usr_role_s.revoked_at 을 61행 백필한다(UPDATE)
--      → set revoked_at = null 로 되돌려야 한다.
-- (49_runner_capability_online.sql + _rollback.sql 이 같은 이유로 롤백을 분리한 선례)
--
-- ⚠ 순서대로 실행한다. 표를 먼저 지우면 뷰가 함께 떨어진다.
-- ============================================================================

-- ── 1. 포털 페이지 비활성 (행은 남긴다 — 이력) ──────────────────────────
update public.portal_page
   set active = false, updated_by = 'rollback:req-0057', updated_at = now()
 where page_key = 'erp_role_matrix';

-- ── 2. 화면·관리 RPC 제거 ───────────────────────────────────────────────
drop function if exists public.erp_role_org_tree(text);
drop function if exists public.erp_role_dept_detail(text, text, boolean, boolean);
drop function if exists public.erp_role_summary(text);
drop function if exists public.erp_role_majority_suggest(text, int, numeric);
drop function if exists public.erp_role_standard_seed(jsonb);
drop function if exists public.erp_role_org_list(text);
drop function if exists public.erp_role_catalog();
drop function if exists public.erp_role_as_of();
drop function if exists public.erp_role_mirror_health();
drop function if exists public.erp_usr_role_reconcile(text[]);

-- ── 3. 뷰 제거 ──────────────────────────────────────────────────────────
drop view if exists erp_ro.v_dept_role_missing;
drop view if exists erp_ro.v_dept_role_matrix;
drop view if exists erp_ro.v_dept_member;
drop view if exists erp_ro.v_usr_role_parsed;
drop view if exists erp_ro.v_dept_tree;

-- ── 4. 기준 표 제거 ─────────────────────────────────────────────────────
--    ⚠ dept_role_standard / dept_map_legacy 에는 사람이 검토·결정한 내용이 들어 있다.
--      되돌리기 전에 반드시 내보내 둔다:
--        copy (select * from public.dept_role_standard) to stdout with csv header;
--        copy (select * from public.dept_map_legacy)    to stdout with csv header;
drop table if exists public.usr_role_exception;
drop table if exists public.dept_role_module_scope;
drop table if exists public.dept_role_standard_status;
drop table if exists public.dept_role_standard;
drop table if exists public.dept_map_legacy;
drop table if exists public.erp_role_module_map;

-- ── 5. 회수 백필 되돌리기 ───────────────────────────────────────────────
update erp_ro.usr_role_s set revoked_at = null where revoked_at is not null;
drop index if exists erp_ro.usr_role_s_live_ix;
alter table erp_ro.usr_role_s drop column if exists revoked_at;

-- ── 6. erp_identity_upsert 원본 복원 (34_identity_accounts.sql §9 정의 그대로) ──
create or replace function public.erp_identity_upsert(p_table text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to ''
as $fn$
declare n integer := 0;
begin
  if p_table = 'hr_emp_s' then
    insert into erp_ro.hr_emp_s (emp_no, emp_nm, dept_cd, dept_nm, roll_pstn, email,
                                 entr_dt, retire_dt, entr_cd, grw_id,
                                 src_updated, synced_at, batch_id)
    select x.emp_no, x.emp_nm, x.dept_cd, x.dept_nm, x.roll_pstn, x.email,
           x.entr_dt, x.retire_dt, x.entr_cd, x.grw_id, x.src_updated, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(emp_no text, emp_nm text, dept_cd text, dept_nm text,
                                         roll_pstn text, email text, entr_dt date, retire_dt date,
                                         entr_cd text, grw_id text,
                                         src_updated timestamptz, batch_id uuid)
    on conflict (emp_no) do update
      set emp_nm = excluded.emp_nm, dept_cd = excluded.dept_cd, dept_nm = excluded.dept_nm,
          roll_pstn = excluded.roll_pstn, email = excluded.email,
          entr_dt = excluded.entr_dt, retire_dt = excluded.retire_dt,
          entr_cd = excluded.entr_cd, grw_id = excluded.grw_id,
          src_updated = excluded.src_updated, synced_at = excluded.synced_at,
          batch_id = excluded.batch_id;

  elsif p_table = 'usr_role_s' then
    insert into erp_ro.usr_role_s (email, role_id, role_nm, synced_at, batch_id)
    select lower(trim(x.email)), x.role_id, x.role_nm, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(email text, role_id text, role_nm text, batch_id uuid)
    on conflict (email, role_id) do update
      set role_nm = excluded.role_nm, synced_at = excluded.synced_at, batch_id = excluded.batch_id;

  else
    raise exception '허용되지 않은 테이블: %', p_table;
  end if;
  get diagnostics n = row_count;
  return n;
end $fn$;

-- ── 6-2. v_erp_sync_overview 의 hr_emp · usr_role 2행 ───────────────────
--    되돌리지 않아도 무해하다 — 두 행은 etl_meta.batch_run 만 읽고 erp_ro 테이블을 건드리지 않는다.
--    굳이 빼려면 pg_get_viewdef 로 현재 정의를 받아 마지막 두 union all 블록을 잘라내고
--    create or replace view 로 다시 만든다(문자열 절단이라 위험하니, 그때 정의 전문을 눈으로 확인할 것).

-- ── 7. ETL 쪽도 함께 되돌린다 ───────────────────────────────────────────
--    10_ERP_DB연계/etl/etl_run.py 의 JOBS["usr_role"] 에서 "reconcile" 블록을 제거한다.
--    (남겨 두면 매 배치가 존재하지 않는 RPC 를 불러 실패한다)
-- ============================================================================
