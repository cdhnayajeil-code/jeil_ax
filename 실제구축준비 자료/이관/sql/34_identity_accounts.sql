-- ============================================================================
-- 34_identity_accounts.sql — 계정 통합관리·대사 (REQ-0018)
--
-- 정본은 **ERP 계정**(Z_USR_MAST_REC.usr_id = 이메일)이다. 인사마스터(HAA010T)는
-- 그 계정에 붙는 **서브 정보**다. 관리 목적이 '계정 관리'이기 때문이다(관리자 지시 2026-09-07).
--
-- 두 테이블은 서로 다른 것을 담는다 — 섞지 않는다.
--   · Z_USR_MAST_REC : ERP '로그인 계정'. PK=usr_id(이메일). usr_nm='부서명_이름[(퇴사)]'.
--                      사번·부서코드 컬럼이 없다.
--   · HAA010T        : '인사 사원' 레코드. PK=EMP_NO. 재입사 시 새 사번이 생겨 한 사람이 2행.
--
-- 계정 ↔ 인사 연결키는 **이메일**(HAA010T.EMAIL_ADDR = usr_id)이다.
-- 부서+이름 대조는 키가 아니라 **대사 검증 표시**로만 쓴다 — 실측 근거:
--   · 이메일 직결 88/94(93.6%)  vs  부서+이름 85/94(90.4%)
--   · 부서+이름이 추가로 건지는 건 0명 (폴백 효용 없음)
--   · 부서+이름은 후보 2건 이상이 8명 → 사번 특정 불가
--   · 두 방식이 다른 사번을 가리키는 건 0명 → 이메일을 써도 잃는 것이 없다
--   · usr_nm 부서 ≠ 인사 부서인 계정 4명 → 계정 부서 표기가 낡았다는 신호(화면에 표시)
--
-- 기타 실측 (2026-09-07, ERP 원천 직접 조회)
--   · ERP 계정(USE_YN=Y·이메일형) 원천 94명 vs 미러 101건 → 미러 7건 과다(증분 upsert 잔재)
--   · HAA010T 745행 / 재직 96명 / RE_ENTR_DT 는 전건 비어 있음(재입사는 새 사번으로만 표현)
--   · 같은 이메일에 사번 2건 = 10명 (재직+퇴사 혼재 1 · 둘 다 퇴사 9)
--   · 계정만 있고 인사 없음 6명 · 인사 재직인데 계정 없음 8명
--   · grw_id 는 재직자 96명 중 59명만 존재 → 그룹웨어 보조키로만
--   · Z_USR_ROLE 역할 마스터 69개(실사용 61) · 배정 1,920행 · 사용자당 평균 18.5개
--
-- 원칙
--   · erp_ro 는 REST 비노출 유지. 화면 조회는 RPC(service_role) 경유만.
--     (REQ-0015 선례 — REST 직접조회는 오류 없이 빈 결과라 검증이 무증상으로 죽는다)
--   · 신규 테이블 전부 RLS ON · 정책 0개 · anon/authenticated 회수
--   · 민감 컬럼 미적재 — RES_NO·주소·연락처·급여·CARD_ID (CLAUDE.md §1.7)
--   · 기존 13KB erp_master_upsert 무수정, 전용 RPC 분리 신설(erp_secure_upsert 선례)
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- 1. 인사 사원마스터 미러 (← JEILMNS.dbo.HAA010T) — 계정의 '서브'
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists erp_ro.hr_emp_s (
  emp_no       text primary key,
  emp_nm       text,
  dept_cd      text,
  dept_nm      text,
  roll_pstn    text,          -- 직위
  email        text,          -- EMAIL_ADDR — 계정과의 유일한 연결키
  entr_dt      date,          -- 입사일
  retire_dt    date,          -- 퇴사일 (null = 재직)
  entr_cd      text,          -- 입사구분 (1/2/3/4 — 코드 의미는 ERP 확인 전)
  grw_id       text,          -- 그룹웨어 ID (재직자 61%만 존재 — 보조키)
  src_updated  timestamptz,
  synced_at    timestamptz not null default now(),
  batch_id     uuid
);

comment on table erp_ro.hr_emp_s is
  'ERP 인사 사원마스터 미러(HAA010T) — 계정(Z_USR_MAST_REC)에 붙는 서브 정보. '
  'PK=사번이라 재입사하면 한 사람이 2행이 된다(같은 이메일·다른 사번, 실측 10명). '
  '주민번호·주소·연락처·급여(호봉)·CARD_ID 는 적재하지 않는다(CLAUDE.md §1.7).';
comment on column erp_ro.hr_emp_s.grw_id is
  '그룹웨어 ID. 재직자 96명 중 59명만 값이 있어 단독 원천으로 쓸 수 없다 — 대사 보조키.';

create index if not exists hr_emp_s_email_idx    on erp_ro.hr_emp_s (lower(email));
create index if not exists hr_emp_s_deptnm_idx   on erp_ro.hr_emp_s (dept_nm, emp_nm);
create index if not exists hr_emp_s_active_idx   on erp_ro.hr_emp_s (retire_dt) where retire_dt is null;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. ERP 권한 등록정보 — 사용자↔역할 배정
--    (← Z_USR_MAST_REC_USR_ROLE_ASSO ⋈ Z_USR_ROLE)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists erp_ro.usr_role_s (
  email      text not null,
  role_id    text not null,
  role_nm    text,            -- 'N.모듈_권한명' 형식 → 접두 숫자·모듈명으로 분류 가능
  synced_at  timestamptz not null default now(),
  batch_id   uuid,
  primary key (email, role_id)
);

comment on table erp_ro.usr_role_s is
  'ERP 사용자별 역할 배정 미러 — 권한 "등록 여부"의 근거. '
  '기존 usr_erp_module_s(모듈 4종)는 전원이 전모듈이라 변별력이 없어 이 표로 보완한다.';

create index if not exists usr_role_s_email_idx on erp_ro.usr_role_s (lower(email));

-- ─────────────────────────────────────────────────────────────────────────
-- 3. 계정 미러 정합 — 비활성 표시 컬럼
--    증분 upsert 라 ERP 에서 USE_YN='N' 이 된 계정은 다시 조회되지도 삭제되지도
--    않는다. 삭제 대신 use_yn=false 로 표시해 이력을 남긴다(관리자 결정 2026-09-07).
-- ─────────────────────────────────────────────────────────────────────────
alter table erp_ro.usr_master_s
  add column if not exists deactivated_at timestamptz;

comment on column erp_ro.usr_master_s.deactivated_at is
  'ERP 원천에서 사라진(비활성화된) 시점. erp_usr_master_reconcile 이 채운다. '
  'null 이면 원천에 살아 있다는 뜻. 삭제하지 않는 이유 — 비활성 이력을 잃지 않기 위해.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. 그룹웨어 계정 (ONUL Ware)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.acct_groupware (
  email        text primary key,
  login_id     text,
  emp_nm       text,
  dept_nm      text,
  position_nm  text,
  status       text,          -- 그룹웨어 표기 그대로
  source       text not null default 'onulware',
  collected_at timestamptz not null default now()
);

comment on table public.acct_groupware is
  '그룹웨어(ONUL Ware) 계정. 비밀번호·개인 연락처는 담지 않는다.';

-- ─────────────────────────────────────────────────────────────────────────
-- 5. MS(Entra) 계정
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.acct_ms (
  email           text primary key,   -- userPrincipalName
  display_name    text,
  dept_nm         text,
  job_title       text,
  account_enabled boolean,
  user_type       text,               -- Member / Guest
  object_id       text,
  collected_at    timestamptz not null default now()
);

comment on table public.acct_ms is
  'Microsoft Entra 계정 미러 — Graph /users 동기화분. '
  '수집에는 Entra 앱 응용권한 User.Read.All + 테넌트 관리자 동의가 필요하다(관리자 작업).';

-- ─────────────────────────────────────────────────────────────────────────
-- 6. 인사 레코드를 이메일 단위로 접은 보조 뷰 (재입사 통합)
--    계정에 붙이기 위한 '서브' 이지 정본이 아니다.
-- ─────────────────────────────────────────────────────────────────────────
create or replace view erp_ro.v_hr_by_email
with (security_invoker = true) as
select
  lower(trim(h.email)) as email,
  -- 대표행: 재직 우선 → 최근 입사
  (array_agg(h.emp_no    order by (h.retire_dt is null) desc, h.entr_dt desc nulls last, h.emp_no desc))[1] as emp_no,
  (array_agg(h.emp_nm    order by (h.retire_dt is null) desc, h.entr_dt desc nulls last, h.emp_no desc))[1] as emp_nm,
  (array_agg(h.dept_cd   order by (h.retire_dt is null) desc, h.entr_dt desc nulls last, h.emp_no desc))[1] as dept_cd,
  (array_agg(h.dept_nm   order by (h.retire_dt is null) desc, h.entr_dt desc nulls last, h.emp_no desc))[1] as dept_nm,
  (array_agg(h.roll_pstn order by (h.retire_dt is null) desc, h.entr_dt desc nulls last, h.emp_no desc))[1] as roll_pstn,
  (array_agg(h.grw_id    order by (h.retire_dt is null) desc, h.entr_dt desc nulls last, h.emp_no desc))[1] as grw_id,
  (array_agg(h.retire_dt order by (h.retire_dt is null) desc, h.entr_dt desc nulls last, h.emp_no desc))[1] as retire_dt,
  bool_or(h.retire_dt is null)                            as hr_active,
  count(*)::int                                           as emp_rec_cnt,
  (count(*) - 1)::int                                     as rehire_cnt,
  array_agg(h.emp_no order by h.entr_dt nulls last)       as emp_no_list,
  min(h.entr_dt)                                          as first_entr_dt,
  max(h.entr_dt)                                          as last_entr_dt
from erp_ro.hr_emp_s h
where h.email like '%@%'
group by lower(trim(h.email));

comment on view erp_ro.v_hr_by_email is
  '인사 레코드를 이메일 단위로 접은 보조 뷰 — 재입사(사번 2개)를 한 줄로 만든다. '
  '정본이 아니라 계정에 붙이는 서브 정보다.';

-- ─────────────────────────────────────────────────────────────────────────
-- 7. 계정 정본 뷰 — usr_id 기준. 인사는 왼쪽 조인으로 '붙인다'.
-- ─────────────────────────────────────────────────────────────────────────
create or replace view public.v_account_identity
with (security_invoker = true) as
select
  lower(trim(u.usr_id))                                              as email,
  u.usr_nm                                                           as acct_nm_raw,
  -- usr_nm = '부서명_이름[(퇴사)|(휴직)]' 파싱
  nullif(split_part(u.usr_nm, '_', 1), '')                           as acct_dept_nm,
  nullif(regexp_replace(split_part(u.usr_nm, '_', 2), '\s*\(.*$', ''), '') as acct_emp_nm,
  (case when u.usr_nm like '%(퇴사)%' then '퇴사'
        when u.usr_nm like '%(휴직)%' then '휴직'
        else '재직' end)                                             as acct_status_note,
  u.use_yn                                                           as acct_active,
  u.deactivated_at,
  u.src_updated                                                      as acct_src_updated,
  u.synced_at                                                        as acct_synced_at,
  -- 인사(서브) — 연결키는 이메일
  h.emp_no, h.emp_nm, h.dept_cd, h.dept_nm, h.roll_pstn, h.grw_id,
  h.hr_active, h.emp_rec_cnt, h.rehire_cnt, h.emp_no_list,
  h.first_entr_dt, h.last_entr_dt, h.retire_dt,
  (h.email is not null)                                              as hr_linked,
  -- 부서·이름 대조 (키가 아니라 검증 표시)
  (h.email is not null
     and trim(h.dept_nm) is distinct from trim(split_part(u.usr_nm, '_', 1))) as dept_mismatch,
  (h.email is not null
     and trim(h.emp_nm) is distinct from
         trim(regexp_replace(split_part(u.usr_nm, '_', 2), '\s*\(.*$', ''))) as name_mismatch,
  -- 권한 등록 여부
  coalesce(r.role_cnt, 0)                                            as erp_role_cnt,
  (coalesce(r.role_cnt, 0) > 0)                                      as erp_perm_registered
from erp_ro.usr_master_s u
left join erp_ro.v_hr_by_email h on h.email = lower(trim(u.usr_id))
left join (select lower(trim(email)) as email, count(*)::int as role_cnt
             from erp_ro.usr_role_s group by 1) r on r.email = lower(trim(u.usr_id))
where u.usr_id like '%@%';

comment on view public.v_account_identity is
  '계정 정본 — ERP 계정(usr_id=이메일)이 기준이고 인사(HAA010T)는 이메일로 붙인 서브 정보. '
  'dept_mismatch/name_mismatch 는 usr_nm 의 부서·이름 표기가 인사와 어긋난 계정을 드러낸다'
  '(매칭 키가 아니라 검증 표시 — 실측상 계정 부서 표기가 낡은 사례 4명).';

-- ─────────────────────────────────────────────────────────────────────────
-- 8. 3축 대사 뷰 — 화면 앞단
--    계정이 기준이지만, '계정이 없는 사람'도 보여야 대사가 된다 → 4축 합집합.
-- ─────────────────────────────────────────────────────────────────────────
drop view if exists public.v_account_recon;
create view public.v_account_recon
with (security_invoker = true) as
with emails as (
  select lower(trim(usr_id)) as email from erp_ro.usr_master_s where usr_id like '%@%'
  union select email from erp_ro.v_hr_by_email
  union select lower(trim(email)) from public.acct_groupware
  union select lower(trim(email)) from public.acct_ms
)
select
  e.email,
  -- 사람 정보 (계정 표기 우선, 없으면 인사·MS·그룹웨어에서 보충)
  coalesce(a.acct_emp_nm, h.emp_nm, m.display_name, g.emp_nm)   as emp_nm,
  coalesce(h.dept_nm, a.acct_dept_nm, g.dept_nm, m.dept_nm)     as dept_nm,
  coalesce(h.roll_pstn, g.position_nm, m.job_title)             as position_nm,
  a.acct_dept_nm,
  a.acct_status_note,
  h.hr_active,
  coalesce(h.rehire_cnt, 0)                                     as rehire_cnt,
  h.emp_no,
  h.emp_no_list,
  h.first_entr_dt,
  h.retire_dt,
  -- 4축 보유 여부
  (a.email is not null and a.acct_active)                       as has_erp,
  (h.email is not null)                                         as has_hr,
  (g.email is not null)                                         as has_gw,
  (m.email is not null)                                         as has_ms,
  -- 권한 등록
  coalesce(a.erp_role_cnt, 0)                                   as erp_role_cnt,
  coalesce(a.erp_perm_registered, false)                        as erp_perm_registered,
  (pa.email is not null)                                        as portal_admin,
  coalesce(a.dept_mismatch, false)                              as dept_mismatch,
  -- 지금 살아 있는 사람인가 - 화면 기본 필터축.
  -- 인사 이메일 612건 중 514건이 퇴사 이력이라, 이 축이 없으면 실제 조치 대상이 묻힌다.
  (coalesce(a.acct_active, false) or coalesce(h.hr_active, false)
   or g.email is not null or m.email is not null)               as is_current,
  -- 대사 판정 (위에서부터 먼저 걸리는 것 하나)
  -- 퇴사·비활성 이력을 먼저 걸러야 남은 분류가 '지금 조치할 것'만 남는다.
  case
    when a.email is null and h.email is not null and not h.hr_active then '퇴사이력'
    when a.email is null and h.email is not null and h.hr_active     then '계정없음'
    when a.email is not null and not a.acct_active                   then '계정비활성'
    when h.email is not null and not h.hr_active
         and a.email is not null and a.acct_active                   then '퇴사자계정활성'
    when a.email is not null and h.email is null                     then '인사없음'
    when coalesce(a.dept_mismatch, false)                            then '부서표기불일치'
    when a.email is not null and not coalesce(a.erp_perm_registered, false) then '권한미등록'
    when coalesce(h.rehire_cnt, 0) > 0                               then '재입사'
    else '정상'
  end                                                           as recon_type
from emails e
left join public.v_account_identity a on a.email = e.email
left join erp_ro.v_hr_by_email       h on h.email = e.email
left join public.acct_groupware      g on lower(trim(g.email)) = e.email
left join public.acct_ms             m on lower(trim(m.email)) = e.email
left join public.portal_admin        pa on lower(trim(pa.email)) = e.email;

comment on view public.v_account_recon is
  '계정 대사 — 이메일 1행에 ERP계정/인사/그룹웨어/MS 보유 여부와 권한 등록 여부를 붙인다. '
  '기준은 계정이지만 "계정이 없는 재직자"도 보여야 대사가 되므로 4축 합집합으로 만든다. '
  '그룹웨어·MS 원천이 비어 있으면 has_gw/has_ms 는 전건 false — 화면이 미연결과 부재를 구분해 표시한다.';

-- ─────────────────────────────────────────────────────────────────────────
-- 9. 적재 RPC — 신규 2종 전용 (기존 erp_master_upsert 무수정)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.erp_identity_upsert(p_table text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to ''
as $$
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
end $$;

comment on function public.erp_identity_upsert(text, jsonb) is
  '계정 대사용 ERP 미러 적재(hr_emp_s·usr_role_s) — service_role 전용. '
  '기존 erp_master_upsert 재작성 위험을 피해 분리 신설(erp_secure_upsert 선례).';

-- ─────────────────────────────────────────────────────────────────────────
-- 10. 정합 RPC — 원천에 없는 ERP 계정을 비활성으로 표시
--     삭제하지 않는 이유: 되돌릴 수 있고, 언제 비활성화됐는지 이력이 남는다.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.erp_usr_master_reconcile(p_active_emails text[])
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare v_off integer := 0; v_on integer := 0;
begin
  if p_active_emails is null or array_length(p_active_emails, 1) is null then
    raise exception '원천 계정 목록이 비어 있습니다 — 전건 비활성화를 막기 위해 거부합니다';
  end if;

  update erp_ro.usr_master_s u
     set use_yn = false, deactivated_at = coalesce(u.deactivated_at, now())
   where u.use_yn
     and lower(trim(u.usr_id)) <> all (select lower(trim(x)) from unnest(p_active_emails) x);
  get diagnostics v_off = row_count;

  update erp_ro.usr_master_s u
     set use_yn = true, deactivated_at = null
   where not u.use_yn
     and lower(trim(u.usr_id)) = any (select lower(trim(x)) from unnest(p_active_emails) x);
  get diagnostics v_on = row_count;

  return jsonb_build_object('deactivated', v_off, 'reactivated', v_on,
                            'source_count', array_length(p_active_emails, 1));
end $$;

comment on function public.erp_usr_master_reconcile(text[]) is
  'ERP 계정 미러 정합 — 원천에 없는 행을 use_yn=false 로 표시(삭제 아님). '
  '빈 목록이 오면 전건 비활성화를 막기 위해 거부한다.';

-- ─────────────────────────────────────────────────────────────────────────
-- 11. 화면 조회 RPC — erp_ro 가 REST 비노출이므로 Edge Function 이 이걸 부른다
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.account_recon_get(p_scope text default 'recon',
                                                    p_q text default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
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
      'role_users',    (select count(distinct email) from erp_ro.usr_role_s),
      'role_rows',     (select count(*) from erp_ro.usr_role_s),
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
                         from erp_ro.usr_role_s group by 1) r on r.e = a.email
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
end $$;

comment on function public.account_recon_get(text, text) is
  '계정관리 화면 조회 — service_role 전용(Edge Function 경유). '
  'erp_ro 는 REST 비노출이라 화면이 직접 조회하면 오류 없이 빈 결과가 된다(REQ-0015 선례).';

-- ─────────────────────────────────────────────────────────────────────────
-- 12. RLS 전면차단 + 권한 회수
-- ─────────────────────────────────────────────────────────────────────────
alter table erp_ro.hr_emp_s        enable row level security;
alter table erp_ro.usr_role_s      enable row level security;
alter table public.acct_groupware  enable row level security;
alter table public.acct_ms         enable row level security;

revoke all on erp_ro.hr_emp_s          from anon, authenticated;
revoke all on erp_ro.usr_role_s        from anon, authenticated;
revoke all on erp_ro.v_hr_by_email     from anon, authenticated;
revoke all on public.acct_groupware    from anon, authenticated;
revoke all on public.acct_ms           from anon, authenticated;
revoke all on public.v_account_identity from anon, authenticated;
revoke all on public.v_account_recon   from anon, authenticated;

revoke all on function public.erp_identity_upsert(text, jsonb) from anon, authenticated;
revoke all on function public.erp_usr_master_reconcile(text[]) from anon, authenticated;
revoke all on function public.account_recon_get(text, text)    from anon, authenticated;

-- ============================================================================
-- 13. 후속 — 그룹웨어 축 연결 (2026-09-07, 마이그레이션 acct_source_upsert ·
--     account_recon_with_groupware · account_recon_gw_history)
--
-- 그룹웨어 원천이 붙어 두 가지가 바뀌었다. 위 §8 의 v_account_recon 정의는 이 절이
-- 대체한다(파일을 처음부터 순서대로 적용하면 최종 상태가 된다).
--   ① 그룹웨어/MS 는 **전량 스냅샷** 적재다 — 원천에 없는 행은 삭제한다.
--      증분 upsert 로 두면 원천에서 지워진 계정이 미러에 영영 남는다(§3 usr_master 결함과 같은 함정).
--   ② 그룹웨어 useState 는 **0=사용 · 1=미사용**이다. 이름과 반대라 실측으로 확정했다:
--        useState=0(117명) → ERP 활성계정 93 · 인사 재직 95 매치
--        useState=1(357명) → ERP 활성계정 0 · 인사 재직 0
--      endDate 는 퇴사일이 아니다 — 전건 값이 있고 최대가 2555-07-01(무기한 센티넬)이라
--      재직 판정에 쓸 수 없다.
--
-- 실측 대사 (2026-09-07, 그룹웨어 474건 적재 후)
--   현재 인원 119 : 정상 86 · 그룹웨어만 14 · 계정없음 8 · 인사없음 6
--                  · 부서표기불일치 3 · 재입사 1 · 권한미등록 1
--   이력          : 퇴사이력 511 · 그룹웨어이력 271 · 계정비활성 7
--   ERP 활성 94 중 그룹웨어 사용중 93 · 없음 1 / 그룹웨어 사용중 117 중 ERP 계정 없음 24
-- ============================================================================

-- 13-1. 그룹웨어·MS 전량 스냅샷 적재 RPC
create or replace function public.acct_source_upsert(p_source text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_up integer := 0; v_del integer := 0; v_in integer;
begin
  v_in := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));
  if v_in = 0 then
    raise exception '원천 행이 0건입니다 — 전건 삭제를 막기 위해 거부합니다';
  end if;

  if p_source = 'gw' then
    insert into public.acct_groupware (email, login_id, emp_nm, dept_nm, position_nm, status, source, collected_at)
    select lower(trim(x.email)), x.login_id, x.emp_nm, x.dept_nm, x.position_nm,
           x.status, coalesce(x.source, 'onulware'), now()
    from jsonb_to_recordset(p_rows) as x(email text, login_id text, emp_nm text, dept_nm text,
                                         position_nm text, status text, source text)
    where x.email like '%@%'
    on conflict (email) do update
      set login_id = excluded.login_id, emp_nm = excluded.emp_nm, dept_nm = excluded.dept_nm,
          position_nm = excluded.position_nm, status = excluded.status,
          source = excluded.source, collected_at = excluded.collected_at;
    get diagnostics v_up = row_count;

    delete from public.acct_groupware
     where email not in (select lower(trim(y.email))
                           from jsonb_to_recordset(p_rows) as y(email text)
                          where y.email like '%@%');
    get diagnostics v_del = row_count;

  elsif p_source = 'ms' then
    insert into public.acct_ms (email, display_name, dept_nm, job_title, account_enabled,
                                user_type, object_id, collected_at)
    select lower(trim(x.email)), x.display_name, x.dept_nm, x.job_title,
           x.account_enabled, x.user_type, x.object_id, now()
    from jsonb_to_recordset(p_rows) as x(email text, display_name text, dept_nm text, job_title text,
                                         account_enabled boolean, user_type text, object_id text)
    where x.email like '%@%'
    on conflict (email) do update
      set display_name = excluded.display_name, dept_nm = excluded.dept_nm,
          job_title = excluded.job_title, account_enabled = excluded.account_enabled,
          user_type = excluded.user_type, object_id = excluded.object_id,
          collected_at = excluded.collected_at;
    get diagnostics v_up = row_count;

    delete from public.acct_ms
     where email not in (select lower(trim(y.email))
                           from jsonb_to_recordset(p_rows) as y(email text)
                          where y.email like '%@%');
    get diagnostics v_del = row_count;

  else
    raise exception '허용되지 않은 source: %', p_source;
  end if;

  return jsonb_build_object('source', p_source, 'received', v_in, 'upserted', v_up, 'deleted', v_del);
end $fn$;

comment on function public.acct_source_upsert(text, jsonb) is
  '그룹웨어(gw)·MS(ms) 계정 전량 스냅샷 적재 — service_role 전용. 원천에 없는 행은 삭제한다(증분 잔재 방지). 빈 배열은 전건 삭제 방지를 위해 거부.';

revoke all on function public.acct_source_upsert(text, jsonb) from anon, authenticated;

-- 13-2. 대사 뷰 최종본 — 그룹웨어 3상태(사용 / 미사용 / 없음) 반영
drop view if exists public.v_account_recon;

create view public.v_account_recon
with (security_invoker = true) as
with emails as (
  select lower(trim(usr_id)) as email from erp_ro.usr_master_s where usr_id like '%@%'
  union select email from erp_ro.v_hr_by_email
  union select lower(trim(email)) from public.acct_groupware
  union select lower(trim(email)) from public.acct_ms
)
select
  e.email,
  coalesce(a.acct_emp_nm, h.emp_nm, g.emp_nm, m.display_name) as emp_nm,
  coalesce(h.dept_nm, a.acct_dept_nm, g.dept_nm, m.dept_nm)   as dept_nm,
  coalesce(h.roll_pstn, g.position_nm, m.job_title)           as position_nm,
  a.acct_dept_nm,
  a.acct_status_note,
  h.hr_active,
  coalesce(h.rehire_cnt, 0)                                   as rehire_cnt,
  h.emp_no,
  h.emp_no_list,
  h.first_entr_dt,
  h.retire_dt,
  (a.email is not null and a.acct_active)                     as has_erp,
  (h.email is not null)                                       as has_hr,
  (g.email is not null and g.status = '사용')                  as has_gw,
  (m.email is not null)                                       as has_ms,
  g.status                                                    as gw_status,
  g.login_id                                                  as gw_login_id,
  coalesce(a.erp_role_cnt, 0)                                 as erp_role_cnt,
  coalesce(a.erp_perm_registered, false)                      as erp_perm_registered,
  (pa.email is not null)                                      as portal_admin,
  coalesce(a.dept_mismatch, false)                            as dept_mismatch,
  (coalesce(a.acct_active, false) or coalesce(h.hr_active, false)
   or (g.email is not null and g.status = '사용') or m.email is not null) as is_current,
  case
    when a.email is null and h.email is not null and not h.hr_active
         and (g.email is null or g.status <> '사용')                     then '퇴사이력'
    when a.email is null and h.email is null
         and g.email is not null and g.status <> '사용'                   then '그룹웨어이력'
    when a.email is not null and not a.acct_active                       then '계정비활성'
    when a.email is null and h.email is not null and h.hr_active         then '계정없음'
    when a.email is null and h.email is null
         and g.email is not null and g.status = '사용'                    then '그룹웨어만'
    when a.email is not null and h.email is null                         then '인사없음'
    when h.email is not null and not h.hr_active
         and a.email is not null and a.acct_active                       then '퇴사자계정활성'
    when a.email is not null and a.acct_active
         and (g.email is null or g.status <> '사용')                      then '그룹웨어없음'
    when coalesce(a.dept_mismatch, false)                                then '부서표기불일치'
    when a.email is not null and a.acct_active
         and not coalesce(a.erp_perm_registered, false)                  then '권한미등록'
    when coalesce(h.rehire_cnt, 0) > 0                                   then '재입사'
    else '정상'
  end                                                         as recon_type
from emails e
left join public.v_account_identity a  on a.email = e.email
left join erp_ro.v_hr_by_email       h  on h.email = e.email
left join public.acct_groupware      g  on lower(trim(g.email)) = e.email
left join public.acct_ms             m  on lower(trim(m.email)) = e.email
left join public.portal_admin        pa on lower(trim(pa.email)) = e.email;

comment on view public.v_account_recon is
  '계정 대사 — 이메일 1행에 ERP계정/인사/그룹웨어/MS 보유 여부와 권한 등록 여부를 붙인다. 기준은 ERP 계정이지만 "계정이 없는 재직자"도 보여야 대사가 되므로 4축 합집합으로 만든다. 그룹웨어는 status=사용 만 보유로 센다(useState 0=사용·1=미사용, 이름과 반대). MS 원천이 비어 있으면 has_ms 는 전건 false — 화면이 미연결과 부재를 구분해 표시한다.';

revoke all on public.v_account_recon from anon, authenticated;
