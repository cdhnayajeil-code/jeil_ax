-- ============================================================================
-- 107_account_identity_role_cnt_exclude_revoked.sql — 계정 대사의 ERP 역할 수에서 **회수된 역할을 뺀다**
--   (REQ-0127 · 2026-10-08 · 관리자 승인 뒤 라이브 적용)
--
-- 왜 필요한가
--   usr_role ETL 은 ERP 에서 회수된 역할 배정을 지우지 않고 `revoked_at` 으로 표시한다(etl_run.py usr_role reconcile ·
--   2026-09-18). 그런데 계정 대사 뷰 `v_account_identity` 의 `erp_role_cnt`·`erp_perm_registered` 와
--   계정관리 화면 함수 `account_recon_get` 의 ERP 탭(roles 문자열)·요약(role_users·role_rows)은 `usr_role_s` 를
--   그대로 세어, 퇴사 처리로 ERP 역할이 전부 회수된 사람이 화면에 「역할 17」로 남는다(2026-10-08 퇴사자 1명 실측).
--   권한 과다 화면(/work/erp-roles · SQL 50)은 이미 `revoked_at is null` 로 거르므로 그쪽과도 어긋났다.
--
-- 무엇을 바꾸나(동작 차이는 이것뿐)
--   · v_account_identity : erp_role_cnt / erp_perm_registered 가 **살아 있는 역할만** 센다(열 목록·순서 불변 → 의존 뷰 v_account_recon 영향 없음).
--   · account_recon_get  : scope 'erp' 의 roles 문자열, scope 'summary' 의 role_users·role_rows 가 살아 있는 역할만 본다.
--   · 파생: 활성 계정인데 역할이 전부 회수된 사람은 v_account_recon 에서 「권한미등록」으로 분류된다 — 실제 상태와 같다.
--
-- 기준 정의: 정본 파일이 아니라 **2026-10-08 라이브 정의(pg_get_viewdef / pg_get_functiondef)** 를 옮겨 고쳤다(REQ-0039 드리프트 교훈).
-- 되돌리기: 107_account_identity_role_cnt_exclude_revoked_rollback.sql (같은 날 라이브 정의 원문)
-- ============================================================================
begin;

create or replace view public.v_account_identity as
 SELECT lower(TRIM(BOTH FROM u.usr_id)) AS email,
    u.usr_nm AS acct_nm_raw,
    NULLIF(split_part(u.usr_nm, '_'::text, 1), ''::text) AS acct_dept_nm,
    NULLIF(regexp_replace(split_part(u.usr_nm, '_'::text, 2), '\s*\(.*$'::text, ''::text), ''::text) AS acct_emp_nm,
        CASE
            WHEN u.usr_nm ~~ '%(퇴사)%'::text THEN '퇴사'::text
            WHEN u.usr_nm ~~ '%(휴직)%'::text THEN '휴직'::text
            ELSE '재직'::text
        END AS acct_status_note,
    u.use_yn AS acct_active,
    u.deactivated_at,
    u.src_updated AS acct_src_updated,
    u.synced_at AS acct_synced_at,
    h.emp_no,
    h.emp_nm,
    h.dept_cd,
    h.dept_nm,
    h.roll_pstn,
    h.grw_id,
    h.hr_active,
    h.emp_rec_cnt,
    h.rehire_cnt,
    h.emp_no_list,
    h.first_entr_dt,
    h.last_entr_dt,
    h.retire_dt,
    h.email IS NOT NULL AS hr_linked,
    h.email IS NOT NULL AND TRIM(BOTH FROM h.dept_nm) IS DISTINCT FROM TRIM(BOTH FROM split_part(u.usr_nm, '_'::text, 1)) AS dept_mismatch,
    h.email IS NOT NULL AND TRIM(BOTH FROM h.emp_nm) IS DISTINCT FROM TRIM(BOTH FROM regexp_replace(split_part(u.usr_nm, '_'::text, 2), '\s*\(.*$'::text, ''::text)) AS name_mismatch,
    COALESCE(r.role_cnt, 0) AS erp_role_cnt,
    COALESCE(r.role_cnt, 0) > 0 AS erp_perm_registered
   FROM erp_ro.usr_master_s u
     LEFT JOIN erp_ro.v_hr_by_email h ON h.email = lower(TRIM(BOTH FROM u.usr_id))
     LEFT JOIN ( SELECT lower(TRIM(BOTH FROM usr_role_s.email)) AS email,
            count(*)::integer AS role_cnt
           FROM erp_ro.usr_role_s
          WHERE usr_role_s.revoked_at IS NULL                      -- REQ-0127: 회수된 역할 제외
          GROUP BY (lower(TRIM(BOTH FROM usr_role_s.email)))) r ON r.email = lower(TRIM(BOTH FROM u.usr_id))
  WHERE u.usr_id ~~ '%@%'::text;

comment on view public.v_account_identity is
  'ERP 계정(usr_master_s) ↔ 인사(v_hr_by_email) 대사. erp_role_cnt 는 살아 있는(revoked_at null) 역할만 센다(REQ-0127).';

CREATE OR REPLACE FUNCTION public.account_recon_get(p_scope text DEFAULT 'recon'::text, p_q text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v jsonb; q text := nullif(trim(coalesce(p_q, '')), '');
begin
  if p_scope = 'summary' then
    select jsonb_build_object(
      'acct_total',    (select count(*) from erp_ro.usr_master_s where usr_id like '%@%'),
      'acct_active',   (select count(*) from erp_ro.usr_master_s where use_yn and usr_id like '%@%'),
      'acct_off',      (select count(*) from erp_ro.usr_master_s where not use_yn),
      'hr_total',      (select count(*) from erp_ro.v_hr_by_email),
      'hr_active',     (select count(*) from erp_ro.v_hr_by_email where hr_active),
      'rehire',        (select count(*) from erp_ro.v_hr_by_email where rehire_cnt > 0),
      'hr_linked',     (select count(*) from public.v_account_identity where hr_linked),
      'gw_total',      (select count(*) from public.acct_groupware),
      'ms_total',      (select count(*) from public.acct_ms),
      -- REQ-0127: 회수된 역할(revoked_at)은 세지 않는다
      'role_users',    (select count(distinct email) from erp_ro.usr_role_s where revoked_at is null),
      'role_rows',     (select count(*) from erp_ro.usr_role_s where revoked_at is null),
      'perm_reg',      (select count(*) from public.v_account_identity where erp_perm_registered),
      'acct_synced_at',(select max(synced_at) from erp_ro.usr_master_s),
      'hr_synced_at',  (select max(synced_at) from erp_ro.hr_emp_s),
      'role_synced_at',(select max(synced_at) from erp_ro.usr_role_s),
      'gw_synced_at',  (select max(collected_at) from public.acct_groupware),
      'ms_synced_at',  (select max(collected_at) from public.acct_ms),
      'by_type',       (select coalesce(jsonb_object_agg(recon_type, c), '{}'::jsonb)
                          from (select recon_type, count(*) c
                                  from public.v_account_recon group by 1) t)
    ) into v;

  elsif p_scope = 'recon' then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.email), '[]'::jsonb) into v
    from (select * from public.v_account_recon
           where q is null or email ilike '%'||q||'%'
              or coalesce(emp_nm,'') ilike '%'||q||'%'
              or coalesce(dept_nm,'') ilike '%'||q||'%'
              or coalesce(recon_type,'') ilike '%'||q||'%') t;

  elsif p_scope = 'erp' then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.email), '[]'::jsonb) into v
    from (select a.*, r.roles
            from public.v_account_identity a
            left join (select lower(trim(email)) e,
                              string_agg(role_nm, ' · ' order by role_nm) roles
                         from erp_ro.usr_role_s
                        where revoked_at is null                 -- REQ-0127: 회수된 역할 제외
                        group by 1) r on r.e = a.email
           where q is null or a.email ilike '%'||q||'%'
              or coalesce(a.acct_nm_raw,'') ilike '%'||q||'%') t;

  elsif p_scope = 'hr' then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.email), '[]'::jsonb) into v
    from (select * from erp_ro.v_hr_by_email
           where q is null or email ilike '%'||q||'%'
              or coalesce(emp_nm,'') ilike '%'||q||'%'
              or coalesce(dept_nm,'') ilike '%'||q||'%') t;

  elsif p_scope = 'gw' then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.email), '[]'::jsonb) into v
    from (select * from public.acct_groupware
           where q is null or email ilike '%'||q||'%' or coalesce(emp_nm,'') ilike '%'||q||'%') t;

  elsif p_scope = 'ms' then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.email), '[]'::jsonb) into v
    from (select * from public.acct_ms
           where q is null or email ilike '%'||q||'%'
              or coalesce(display_name,'') ilike '%'||q||'%') t;

  else
    raise exception '허용되지 않은 scope: %', p_scope;
  end if;

  return coalesce(v, '[]'::jsonb);
end $function$;

commit;

-- ============================================================================
-- 확인 쿼리(적용 후)
-- ============================================================================
-- select email, erp_role_cnt, erp_perm_registered from public.v_account_identity where email = '<퇴사자 이메일>';
--   → 0 / false (2026-10-08 퇴사 처리로 역할 17건 전부 revoked_at 표시된 계정으로 확인)
-- select (select count(*) from erp_ro.usr_role_s) all_rows, (select count(*) from erp_ro.usr_role_s where revoked_at is null) live_rows;
-- select public.account_recon_get('summary') -> 'role_rows';   → live_rows 와 같다
