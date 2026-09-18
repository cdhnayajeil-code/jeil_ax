-- ============================================================================
-- 50_erp_role_matrix.sql — ERP 권한(role) 조직별 현황
-- REQ-0057 · 2026-09-18 · 화면 /work/erp-roles (pages/ERP권한_조직별현황.html)
--
-- 목적
--   조직도에서 조직을 고르면 구성원과 ERP 권한 부여 내역이 보이고, 각 권한이
--   표준 / 별도 / 무관 으로 분류되어 조치 대상이 즉시 드러나게 한다.
--
-- 적재 실측 (2026-09-18, 라이브 직접 조회)
--   · erp_ro.usr_role_s        1,752행 · role 60종 · 사용자 97명
--     - 최근 성공 배치(usr_role, 2026-09-11)가 덮은 행 1,691
--     - 그 배치에 없는 행 = ERP에서 회수됐는데 미러에 남은 행 **61행** (최다 PMS_I 39건)
--     - usr_role job 은 incr_sql 이 없는 전량 스냅샷이라 batch_id 워터마크로 회수분이 정확히 판별된다
--   · erp_ro.dept_master_s     351행 / 조직개편 7버전(19801,20241~20244,20251,20261)
--     - 현행 20261 = 35부서 · 루트 1 · 리프 24 · 전 행 par_dept_cd 보유
--   · erp_ro.hr_emp_s          재직 95명 · 활성 ERP 계정 92명 중 87명 연결, dept_cd 87/87 유령 0건
--   · public.acct_groupware    474행(사용 104 · 미사용 370) · status 는 한글 '사용'|'미사용'
--
-- 설계 판단과 근거
--   1) 부서 키는 dept_nm 이 아니라 **dept_cd**.
--      hr_emp_s.dept_cd ↔ dept_master_s 가 87/87 유령 0건인 반면, usr_nm 파싱 이름은 25종 중 4종이
--      현행 조직에 없다. 이름 매칭이 REQ-0032(유령 부서)·REQ-0033 의 원인이다.
--   2) dept_cd 는 char(10) 공백 패딩("0200      ")이고 루트의 par_dept_cd 는 공백 문자열이다.
--      전 조인·비교에 btrim() 을 강제한다. 루트 판정을 par_dept_cd is null 로 하면
--      재귀 CTE 가 0행을 내고 **오류 없이 조용히 죽는다**.
--   3) role 모듈 축은 접두 숫자가 아니라 **점 뒤 라벨**이다. PMS_T_S 의 role_nm 은 '7.재무회계_…' 라
--      숫자를 키로 쓰면 '사업관리'로 오분류된다. 'Z_TEMP'(임시추가 확인권한)는 '_' 자체가 없어 '미분류' 폴백.
--   4) public.dept_erp_scope 를 '무관' 판정 축으로 재사용하지 않는다 — 25부서 중 21개가 동일 5모듈이라
--      변별력이 0이고, 의미도 "포털 화면 접근 범위"지 "ERP 역할 소관"이 아니며,
--      perm_effective 가 읽는 표라 건드리면 전 게이트가 흔들린다. 전용 축을 신설한다.
--   5) 표준 세트가 없는 부서를 '무관'으로 칠하지 않는다. 엑셀 기준선이 현행 25부서 중 17개에만 닿아
--      활성 92명 중 약 38명(40%)이 기준 없는 부서 소속이다. dept_role_standard_status 로
--      '없음'과 '아직 안 만듦'을 구분하고, 후자는 3분류를 아예 계산하지 않는다.
--   6) 신규 표·뷰는 RLS ON + **정책 0개** + anon/authenticated 회수. 화면은 RPC 로만 읽는다.
--      정책을 만들지 않으면 REQ-0040(auth.jwt() 행마다 계산)의 함정이 생길 자리 자체가 없다.
--      (erp_ro 는 REST 비노출 — 직접 조회하면 오류 없이 빈 결과라 검증이 무증상으로 죽는다, REQ-0015)
--   7) 개인정보(CLAUDE.md §1.7) — 이름은 마스킹 예외이나 사번·입·퇴사일·직위코드·grw_id·MS object_id 는
--      RPC 반환에 **넣지 않는다**. 판단에 기여하지 않는데 이름과 결합되면 그 자체가 인사파일이 된다.
--
-- 롤백: 50_erp_role_matrix_rollback.sql (erp_identity_upsert 원본 복원 + revoked_at 백필 되돌리기 포함)
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────
-- §1. 회수 정합 — 가장 먼저 적용한다
--     이 화면은 '권한 과다'를 찾는 화면이다. 회수 잔재 61행을 그대로 두면
--     사업운영팀·사업관리팀 30명 전원이 PMS_I(프로젝트등록권한) 보유로 보이고,
--     화면의 1번 발견 항목이 통째로 허위가 된다.
-- ─────────────────────────────────────────────────────────────────────────

alter table erp_ro.usr_role_s
  add column if not exists revoked_at timestamptz;

comment on column erp_ro.usr_role_s.revoked_at is
  'ERP 원천에서 사라진(회수된) 시점. erp_usr_role_reconcile 이 채운다. null = 원천에 살아 있음. '
  '삭제하지 않는 이유 — 되돌릴 수 있고 회수 시점 이력이 남는다(usr_master_s.deactivated_at 선례).';

create index if not exists usr_role_s_live_ix
  on erp_ro.usr_role_s (lower(email)) where revoked_at is null;

-- 1회 백필: 최근 성공 배치에 포함되지 않은 행 = 회수 잔재
--   ⚠ 기대값 정확히 61행. 다르면 멈추고 원인을 확인한다(전량 스냅샷 전제가 깨진 것).
with w as (
  select b.batch_id
    from etl_meta.batch_run b
   where b.job_name = 'usr_role' and b.status = 'success' and b.rows_read >= 500
   order by b.finished_at desc
   limit 1
)
update erp_ro.usr_role_s r
   set revoked_at = now()
  from w
 where r.revoked_at is null
   and r.batch_id is distinct from w.batch_id;

-- 상시 정합 RPC — 원천의 살아있는 (email|role_id) 키 전량을 받아 대조한다.
--   erp_usr_master_reconcile 선례를 따라 빈 목록·부분 추출을 거부한다.
create or replace function public.erp_usr_role_reconcile(p_active_keys text[])
returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_off int := 0;
  v_on  int := 0;
  v_n   int := coalesce(array_length(p_active_keys, 1), 0);
begin
  if v_n = 0 then
    raise exception '원천 역할배정 목록이 비어 있습니다 — 전건 회수 표시를 막기 위해 거부합니다';
  end if;
  if v_n < 500 then
    raise exception '원천 역할배정이 %건뿐입니다 — 부분 추출로 보여 거부합니다(실측 정상치 1,691건)', v_n;
  end if;

  update erp_ro.usr_role_s r
     set revoked_at = now()
   where r.revoked_at is null
     and (lower(btrim(r.email)) || '|' || lower(btrim(r.role_id)))
         <> all (select lower(btrim(x)) from unnest(p_active_keys) x);
  get diagnostics v_off = row_count;

  update erp_ro.usr_role_s r
     set revoked_at = null
   where r.revoked_at is not null
     and (lower(btrim(r.email)) || '|' || lower(btrim(r.role_id)))
         =  any (select lower(btrim(x)) from unnest(p_active_keys) x);
  get diagnostics v_on = row_count;

  return jsonb_build_object('revoked', v_off, 'restored', v_on, 'source_count', v_n);
end $fn$;

comment on function public.erp_usr_role_reconcile(text[]) is
  'ERP 역할배정 삭제 정합 — 원천에 없는 미러 행을 revoked_at 으로 표시하고, 다시 나타난 행은 되살린다. '
  '⚠ usr_role job 이 전량 스냅샷이라는 전제에 의존한다. etl_run.py JOBS["usr_role"] 에 incr_sql 을 '
  '추가하면 이 전제가 깨진다.';

-- 적재 RPC 보정: 재부여된 역할은 upsert 시 자동 복구되게 한다.
--   (34_identity_accounts.sql §9 의 정의를 그대로 옮기고 usr_role_s 분기에 revoked_at = null 만 추가)
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
      set role_nm = excluded.role_nm, synced_at = excluded.synced_at, batch_id = excluded.batch_id,
          revoked_at = null;   -- ← REQ-0057: 재부여되면 회수 표시를 푼다

  else
    raise exception '허용되지 않은 테이블: %', p_table;
  end if;
  get diagnostics n = row_count;
  return n;
end $fn$;


-- ─────────────────────────────────────────────────────────────────────────
-- §2. 조직 트리 — dept_master_s 에 적재만 되고 아무데서도 쓰이지 않던 계층을 처음 쓴다
--     현행 버전을 '20261' 로 하드코딩하지 않는다. 박아 두면 다음 조직개편 때
--     오류 없이 옛 조직을 보여준다 — 고장 중에 제일 위험한 종류다.
--     ⚠ dept_full_nm 은 경로가 아니다(R&D팀 → 'R&D'). 경로는 재귀로 만든다.
-- ─────────────────────────────────────────────────────────────────────────

create or replace view erp_ro.v_dept_tree with (security_invoker = true) as
with recursive src as (
  select d.org_change_id,
         btrim(d.dept_cd)                           as dept_cd,
         btrim(d.dept_nm)                           as dept_nm,
         nullif(btrim(coalesce(d.par_dept_cd, '')), '') as par_dept_cd,   -- char(10) 공백 패딩
         (btrim(coalesce(d.end_dept_fg, '')) = 'Y') as end_dept,
         d.synced_at
    from erp_ro.dept_master_s d
   where btrim(coalesce(d.dept_cd, '')) <> ''
), t as (
  select s.org_change_id, s.dept_cd, s.dept_nm, s.par_dept_cd, s.end_dept, s.synced_at,
         1                                as lvl,
         array[s.dept_cd]::text[]         as path_cd,
         s.dept_nm                        as path_nm,
         lpad(s.dept_cd, 10, '0')         as sort_key
    from src s
   where s.par_dept_cd is null
  union all
  select c.org_change_id, c.dept_cd, c.dept_nm, c.par_dept_cd, c.end_dept, c.synced_at,
         p.lvl + 1,
         p.path_cd || c.dept_cd,
         p.path_nm || ' > ' || c.dept_nm,
         p.sort_key || '/' || lpad(c.dept_cd, 10, '0')
    from src c
    join t p on p.org_change_id = c.org_change_id and p.dept_cd = c.par_dept_cd
   where c.dept_cd <> all (p.path_cd)                    -- 순환 방지
)
select t.org_change_id, t.dept_cd, t.dept_nm, t.par_dept_cd, t.lvl,
       t.path_cd, t.path_nm, t.sort_key, t.end_dept,
       exists (select 1 from src c
                where c.org_change_id = t.org_change_id and c.par_dept_cd = t.dept_cd) as has_child,
       (t.org_change_id = (select max(x.org_change_id) from erp_ro.dept_master_s x
                            where x.org_change_id ~ '^[0-9]+$'))                       as is_current,
       t.synced_at
  from t;

comment on view erp_ro.v_dept_tree is
  'ERP 부서 마스터 재귀 트리(조직개편 버전별). path_cd 로 상하위 판정, sort_key 로 깊이우선 정렬. '
  '현행 버전은 is_current = true. dept_full_nm 은 경로가 아니라 별칭이라 쓰지 않는다.';


-- ─────────────────────────────────────────────────────────────────────────
-- §3. role 모듈 사전 — '무관' 판정의 축
--     키는 role_nm('N.<라벨>_<권한명>')의 <라벨> 텍스트다(§설계판단 3).
--     perm_module_catalog 와는 portal_module_key 로 느슨히 잇되 FK 를 걸지 않는다 —
--     생산관리·사업관리는 대응 포털 모듈이 없고 구매관리는 purchase/pur_order 둘로 갈린다.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.erp_role_module_map (
  role_module_key   text primary key,
  label             text not null,
  company_wide      boolean not null default false,
  portal_module_key text,
  sensitive         boolean not null default false,
  sort              int not null default 100,
  note              text
);

comment on table public.erp_role_module_map is
  'ERP 역할명 접두 라벨 → 업무 모듈 사전. 부서 소관 밖 권한(무관) 판정의 축. '
  'company_wide = 전 부서 공통이라 부서 소관과 무관하게 허용.';

insert into public.erp_role_module_map
  (role_module_key, label, company_wide, portal_module_key, sensitive, sort, note) values
  ('공통',     '0.공통',     true,  null,       false,   0, '전 부서 공통 — SHAR_S / SHAR_C / SHAR_Q'),
  ('재무회계', '1.재무회계', false, 'finance',  true,   10, 'PMS_T_S 는 role_nm 이 7.재무회계 — 같은 키로 들어온다'),
  ('인사급여', '2.인사급여', false, 'payroll',  true,   20, null),
  ('영업관리', '3.영업관리', false, 'sales',    false,  30, null),
  ('구매관리', '4.구매관리', false, 'purchase', false,  40, 'purchase/pur_order 로 갈리므로 대표값만'),
  ('생산관리', '5.생산관리', false, null,       false,  50, '대응 포털 모듈 없음 — 억지 매핑 금지'),
  ('자재물류', '6.자재물류', false, 'inventory',false,  60, null),
  ('사업관리', '7.사업관리', false, null,       false,  70, '대응 포털 모듈 없음'),
  ('재고관리', '8.재고관리', false, 'inventory',false,  80, '현재 배정 0건'),
  ('표준설계', '9.표준설계', false, 'item',     false,  90, null),
  ('미분류',   '미분류(역할명 규칙 밖)', false, null, true, 999,
               'Z_TEMP 임시추가 확인권한 등 — 규칙 밖이므로 항상 주의 대상으로 둔다')
on conflict (role_module_key) do update
  set label = excluded.label, company_wide = excluded.company_wide,
      portal_module_key = excluded.portal_module_key, sensitive = excluded.sensitive,
      sort = excluded.sort, note = excluded.note;


-- ─────────────────────────────────────────────────────────────────────────
-- §4. role 파싱 뷰
--     is_write 를 role_id 접미(_I/_A)로 판정하면 안 된다 — ACCT_S_A 는 _A 로 끝나지만
--     '전체모듈 조회 권한'이다. 역할명에 '조회'가 있는지로 본다.
-- ─────────────────────────────────────────────────────────────────────────

create or replace view erp_ro.v_usr_role_parsed with (security_invoker = true) as
select lower(btrim(r.email))  as email,
       btrim(r.role_id)       as role_id,
       r.role_nm,
       case when r.role_nm ~ '^[0-9]+\.[^_]+_'
            then split_part(split_part(r.role_nm, '_', 1), '.', 2)
            else '미분류' end as role_module_key,
       case when r.role_nm ~ '^[0-9]+\.[^_]+_'
            then substr(r.role_nm, position('_' in r.role_nm) + 1)
            else r.role_nm end as role_label,
       (coalesce(r.role_nm, '') !~ '조회') as is_write,
       r.revoked_at, r.synced_at, r.batch_id
  from erp_ro.usr_role_s r;


-- ─────────────────────────────────────────────────────────────────────────
-- §5. 기준 표
-- ─────────────────────────────────────────────────────────────────────────

-- 5-1. 부서 표준 role 세트
create table if not exists public.dept_role_standard (
  org_change_id   text not null,
  dept_cd         text not null,
  role_id         text not null,
  dept_nm_at_seed text,
  role_nm_at_seed text,
  source          text not null,
  source_detail   text,
  confidence      text not null default 'high',
  approved_by     text,
  approved_at     timestamptz,
  valid_from      date not null default current_date,
  valid_to        date,
  note            text,
  updated_by      text,
  updated_at      timestamptz not null default now(),
  primary key (org_change_id, dept_cd, role_id),
  constraint drs_deptcd_chk check (dept_cd = btrim(dept_cd) and dept_cd <> ''),
  constraint drs_roleid_chk check (role_id = btrim(role_id) and role_id <> ''),
  constraint drs_source_chk check (source in ('excel_2025_07', 'majority', 'manual')),
  constraint drs_conf_chk   check (confidence in ('high', 'medium', 'low')),
  constraint drs_period_chk check (valid_to is null or valid_to >= valid_from)
);
create index if not exists drs_dept_ix
  on public.dept_role_standard (org_change_id, dept_cd) where valid_to is null;

comment on table public.dept_role_standard is
  '부서별 ERP 표준 role 세트 — 이상권한 판정의 기준선. 키가 dept_nm 이 아니라 dept_cd 인 이유는 '
  '조직개편에서 이름이 바뀌기 때문이다(제조부문→생산부문, 사업관리1/2팀→사업관리팀/사업운영팀). '
  'source=majority 는 추정치이며 approved_by 가 null 이면 화면에 「추정(미승인)」으로 표시한다.';

-- 5-2. 부서 단위 기준 수립 상태 — "표준 0건"이 '없음'인지 '아직 안 만듦'인지 구분
create table if not exists public.dept_role_standard_status (
  org_change_id text not null,
  dept_cd       text not null,
  state         text not null default 'none',
  seed_source   text,
  mapping_conf  text,
  reviewed_by   text,
  reviewed_at   timestamptz,
  note          text,
  updated_at    timestamptz not null default now(),
  primary key (org_change_id, dept_cd),
  constraint drss_state_chk check (state in ('none', 'seeded', 'reviewed', 'approved')),
  constraint drss_conf_chk  check (mapping_conf is null or mapping_conf in ('high','medium','low','unmapped'))
);

comment on table public.dept_role_standard_status is
  '부서별 표준 세트 수립 상태. 이 표가 없으면 기준 없는 부서(활성 92명 중 약 38명·40%)의 모든 권한이 '
  '「무관」으로 붉게 떠 화면이 첫날 신뢰를 잃는다. state=none 이면 3분류를 계산하지 않는다.';

-- 5-3. 부서 소관 role 모듈 — '별도'와 '무관'을 가르는 선
create table if not exists public.dept_role_module_scope (
  org_change_id   text not null,
  dept_cd         text not null,
  role_module_key text not null references public.erp_role_module_map(role_module_key),
  source          text not null default 'derived',
  updated_by      text,
  updated_at      timestamptz not null default now(),
  primary key (org_change_id, dept_cd, role_module_key),
  constraint drms_deptcd_chk check (dept_cd = btrim(dept_cd) and dept_cd <> ''),
  constraint drms_source_chk check (source in ('derived', 'manual'))
);

comment on table public.dept_role_module_scope is
  '부서가 다루는 ERP 업무 모듈. 표준 세트에서 자동 도출(derived)한 뒤 관리자가 보정(manual)한다. '
  'dept_erp_scope 를 쓰지 않는 이유 — 25부서 중 21개가 동일 5모듈이라 변별력이 0이고, '
  '그 표는 perm_effective 가 읽으므로 건드리면 전 게이트가 흔들린다.';

-- 5-4. 구 부서명 → 현행 부서코드 매핑 (엑셀 2025-07 + 그룹웨어 조직도 실측 통합)
create table if not exists public.dept_map_legacy (
  id             bigint generated always as identity primary key,
  legacy_dept_nm text not null,
  org_change_id  text not null,
  dept_cd        text,
  dept_nm        text,
  rule           text not null,
  confidence     text not null,
  note           text,
  decided_by     text,
  decided_at     timestamptz,
  constraint dml_rule_chk check (rule in ('same','rename','merge','split','unmapped','ignore')),
  constraint dml_conf_chk check (confidence in ('high','medium','low'))
);
create unique index if not exists dml_uq
  on public.dept_map_legacy (legacy_dept_nm, org_change_id, coalesce(dept_cd, ''));

comment on table public.dept_map_legacy is
  '구 부서명(엑셀 2025-07 기준 37종) 및 그룹웨어 표기 → 현행 부서코드 매핑. rule=split 은 1:N 이라 '
  '대리키 + 표현식 unique 를 쓴다. dept_cd 가 null 인 unmapped 행도 지우지 않는다 — 검토 이력이다.';

-- 5-5. 개인 예외 승인 (겸직·대행)
create table if not exists public.usr_role_exception (
  email       text not null,
  role_id     text not null,
  reason      text not null,
  approved_by text not null,
  approved_at timestamptz not null default now(),
  valid_to    timestamptz,
  revoked_by  text,
  revoked_at  timestamptz,
  note        text,
  primary key (email, role_id),
  constraint ure_email_chk check (email = lower(btrim(email)))
);

comment on table public.usr_role_exception is
  '승인된 개인 권한 예외. 겸직·대행 때문에 「무관」으로 뜨지만 결재를 거친 건을 지운다. '
  '이 표가 없으면 같은 건이 매번 빨갛게 떠서 화면 자체가 버려진다.';


-- ─────────────────────────────────────────────────────────────────────────
-- §6. 구성원 뷰 — 계정 · 인사 · 그룹웨어 3축을 이메일로 묶는다
--     소속은 hr_emp_s.dept_cd 가 1순위(87/87 유령 0건), usr_nm 파싱 이름이 폴백.
-- ─────────────────────────────────────────────────────────────────────────

create or replace view erp_ro.v_dept_member with (security_invoker = true) as
with ver as (
  select max(d.org_change_id) as v
    from erp_ro.dept_master_s d where d.org_change_id ~ '^[0-9]+$'
), acct as (
  -- 비이메일 ERP 계정도 포함한다(관리자 지시 2026-09-18) — 외부 회계사 acct2·acct3·acct4·ACCT8·ACCT10,
  -- ERP 관리자 biz_admin. 종전 `usr_id like '%@%'` 필터가 이들을 통째로 가렸다.
  -- ⚠ 필터를 전부 걷으면 사번 기반 중복 계정 365개가 쏟아진다(같은 사람의 옛 로그인·시스템 계정).
  --   실측: 비이메일 활성 371개 중 살아있는 역할을 가진 것은 6개뿐이다.
  --   이 화면은 ERP 권한을 보는 화면이라 "권한이 하나도 없는 계정은 사람으로 세지 않는다"로 자른다.
  select lower(btrim(u.usr_id))                       as email,
         u.usr_nm,
         u.use_yn,
         btrim(split_part(u.usr_nm, '_', 1))          as acct_dept_nm,
         nullif(btrim(regexp_replace(split_part(u.usr_nm, '_', 2), '\s*\(.*$', '')), '') as acct_emp_nm
    from erp_ro.usr_master_s u
   where u.usr_id like '%@%'
      or exists (select 1 from erp_ro.usr_role_s r
                  where lower(btrim(r.email)) = lower(btrim(u.usr_id)) and r.revoked_at is null)
), namecd as (
  select btrim(d.dept_nm) as dept_nm, min(btrim(d.dept_cd)) as dept_cd
    from erp_ro.dept_master_s d, ver
   where d.org_change_id = ver.v and btrim(coalesce(d.dept_nm, '')) <> ''
   group by 1
), base as (
  select ver.v                                            as org_change_id,
         a.email,
         a.usr_nm,
         a.use_yn                                         as account_active,
         coalesce(h.emp_nm, a.acct_emp_nm, a.usr_nm)      as emp_nm,
         coalesce(btrim(h.dept_cd), n.dept_cd)            as dept_cd,
         case when h.dept_cd is not null then 'hr'
              when n.dept_cd is not null then 'name'
              else 'none' end                             as dept_src,
         coalesce(btrim(h.dept_nm), a.acct_dept_nm)       as dept_nm_raw,
         (h.dept_nm is not null
           and btrim(h.dept_nm) is distinct from a.acct_dept_nm) as dept_label_stale,
         coalesce(h.hr_active, false)                     as hr_active,
         -- 팀장 판정 — 그룹웨어 position_nm 은 '직급 직책' 2토큰이다. 종전에는 둘째(직책)만 봤는데
         -- 사업관리팀 홍대기가 '팀장 팀원'(직급 팀장 / 직책 팀원)이라 팀원으로 보였다(2026-09-18 관리자 지적).
         -- 둘 중 하나라도 리더 직함이면 리더로 본다 — 실측상 부서당 리더가 정확히 1명씩 잡힌다.
         case
           when split_part(btrim(coalesce(g.position_nm, '')), ' ', 1)
                in ('대표','부문장','법인장','팀장')
             then split_part(btrim(coalesce(g.position_nm, '')), ' ', 1)
           when split_part(btrim(coalesce(g.position_nm, '')), ' ', 2)
                in ('대표','부문장','법인장','팀장')
             then split_part(btrim(coalesce(g.position_nm, '')), ' ', 2)
           else nullif(split_part(btrim(coalesce(g.position_nm, '')), ' ', 2), '')
         end                                              as gw_title,
         (g.email is not null and g.status = '사용')       as gw_active
    from acct a
    cross join ver
    left join erp_ro.v_hr_by_email h
           on lower(btrim(h.email)) = a.email and h.hr_active
    left join namecd n on n.dept_nm = a.acct_dept_nm
    left join public.acct_groupware g on lower(btrim(g.email)) = a.email
)
select b.*,
       count(*) filter (where b.account_active) over (partition by b.dept_cd)::int as dept_size
  from base b;

comment on view erp_ro.v_dept_member is
  'ERP 계정 1행 = 사람 1명. 소속은 인사(dept_cd) 우선, 계정명 파싱 부서 폴백, 둘 다 없으면 dept_src=none. '
  'gw_title 은 그룹웨어 position_nm 의 둘째 토큰(직책) — 표시·권한부여 제안 전용이며 판정에 쓰지 않는다.';


-- ─────────────────────────────────────────────────────────────────────────
-- §7. 판정 뷰 — 표준 / 별도 / 무관
--     우선순위: 회수 → 예외승인 → 기준없음 → 표준 → 별도 → 무관
-- ─────────────────────────────────────────────────────────────────────────

create or replace view erp_ro.v_dept_role_matrix with (security_invoker = true) as
select m.org_change_id,
       m.email, m.emp_nm, m.dept_cd, m.dept_nm_raw, m.dept_src, m.dept_label_stale,
       m.account_active, m.hr_active, m.gw_active, m.gw_title, m.dept_size,
       p.role_id, p.role_nm, p.role_label, p.role_module_key, p.is_write,
       mm.label      as module_label,
       mm.sensitive  as module_sensitive,
       coalesce(mm.company_wide, false) as company_wide,
       p.revoked_at, p.synced_at,
       (st.role_id is not null)         as in_standard,
       (sc.role_module_key is not null) as in_dept_scope,
       coalesce(stt.state, 'none')      as std_state,
       stt.mapping_conf,
       case
         when p.revoked_at is not null                                  then '회수'
         when ex.email is not null                                      then '예외승인'
         when coalesce(stt.state, 'none') = 'none'
              and st.role_id is null and sc.role_module_key is null     then '기준없음'
         when st.role_id is not null                                    then '표준'
         when coalesce(mm.company_wide, false)
              or sc.role_module_key is not null                         then '별도'
         else '무관'
       end as cls,
       case when st.role_id is not null            then '표준 세트(' || st.source || ')'
            when coalesce(mm.company_wide, false)  then '전사 공통 모듈'
            when sc.role_module_key is not null    then '부서 소관 모듈(' || sc.source || ')'
            when p.revoked_at is not null          then 'ERP 원천에서 회수됨'
            when ex.email is not null              then '승인된 예외'
            when coalesce(stt.state, 'none') = 'none' then '부서 표준 세트 미수립'
            else coalesce(mm.label, '미분류') || ' — 부서 소관 밖'
       end as why,
       count(*) filter (where p.revoked_at is null and m.account_active)
         over (partition by m.dept_cd, p.role_id)::int as peer_cnt,
       round((count(*) filter (where p.revoked_at is null and m.account_active)
              over (partition by m.dept_cd, p.role_id))::numeric
             / nullif(m.dept_size, 0), 3) as peer_ratio
  from erp_ro.v_dept_member m
  join erp_ro.v_usr_role_parsed p on p.email = m.email
  left join public.erp_role_module_map mm on mm.role_module_key = p.role_module_key
  left join public.dept_role_standard st
         on st.org_change_id = m.org_change_id and st.dept_cd = m.dept_cd and st.role_id = p.role_id
        and st.valid_from <= current_date
        and (st.valid_to is null or st.valid_to >= current_date)
  left join public.dept_role_standard_status stt
         on stt.org_change_id = m.org_change_id and stt.dept_cd = m.dept_cd
  left join public.dept_role_module_scope sc
         on sc.org_change_id = m.org_change_id and sc.dept_cd = m.dept_cd
        and sc.role_module_key = p.role_module_key
  left join public.usr_role_exception ex
         on ex.email = m.email and ex.role_id = p.role_id
        and ex.revoked_at is null and (ex.valid_to is null or ex.valid_to > now());

comment on view erp_ro.v_dept_role_matrix is
  '사용자별 ERP 역할 보유 + 표준/별도/무관 분류. peer_ratio 는 같은 부서 보유율(회수분 제외) — '
  '회수분을 포함하면 PMS_I 가 20/20 으로 잡혀 「전원 보유 = 표준」이라는 정반대 결론이 난다.';

-- 표준인데 보유하지 않은 것(과소 권한)
create or replace view erp_ro.v_dept_role_missing with (security_invoker = true) as
select s.org_change_id, s.dept_cd, s.role_id,
       coalesce(s.role_nm_at_seed, r.role_nm) as role_nm,
       coalesce(d.dept_size, 0)               as dept_size,
       coalesce(h.holders, 0)                 as holders
  from public.dept_role_standard s
  left join lateral (
       select x.role_nm from erp_ro.usr_role_s x where btrim(x.role_id) = s.role_id limit 1
  ) r on true
  left join lateral (
       select count(distinct m.email)::int as holders
         from erp_ro.v_dept_role_matrix m
        where m.org_change_id = s.org_change_id and m.dept_cd = s.dept_cd
          and m.role_id = s.role_id and m.revoked_at is null and m.account_active
  ) h on true
  left join lateral (
       select max(m2.dept_size) as dept_size
         from erp_ro.v_dept_member m2
        where m2.org_change_id = s.org_change_id and m2.dept_cd = s.dept_cd
  ) d on true
 where s.valid_to is null
   and coalesce(h.holders, 0) < coalesce(d.dept_size, 0);


-- ─────────────────────────────────────────────────────────────────────────
-- §8. 화면 RPC
--     판정은 public.perm_effective 하나만 쓴다(판정 로직 복제 금지 — 17_perm_core.sql 의 취지).
--     행 범위는 perm_grant(scope_type='dept') 로 명시 부여된 부서 + 하위.
--     ⚠ perm_effective 의 'depts' 는 본인 소속 부서를 자동 포함하므로 쓰지 않는다 —
--       그걸 쓰면 부서원 전원이 동료의 권한 보유 현황을 보게 된다.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.erp_role_org_tree(p_org_change_id text default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_upn   text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  v_eff   jsonb;
  v_admin boolean;
  v_scope text[] := null;
  v_ver   text;
  v_nodes jsonb;
begin
  if not public.is_internal() then
    raise exception 'forbidden: 사내 계정만 조회할 수 있습니다.' using errcode = '42501';
  end if;
  if v_upn = '' then
    raise exception 'unauthorized: 로그인 세션이 필요합니다.' using errcode = '28000';
  end if;

  v_ver := coalesce(nullif(btrim(coalesce(p_org_change_id, '')), ''),
                    (select max(d.org_change_id) from erp_ro.dept_master_s d
                      where d.org_change_id ~ '^[0-9]+$'));

  v_eff   := public.perm_effective(v_upn);
  v_admin := coalesce((v_eff ->> 'is_admin')::boolean, false);

  if not v_admin then
    if not exists (
      select 1 from jsonb_array_elements(coalesce(v_eff -> 'pages', '[]'::jsonb)) e
       where e ->> 'page_key' = 'erp_role_matrix'
         and coalesce((e ->> 'allowed')::boolean, false)
    ) then
      raise exception 'forbidden: ERP 권한현황 열람 권한이 필요합니다.' using errcode = '42501';
    end if;

    select coalesce(array_agg(distinct t.dept_cd), '{}') into v_scope
      from erp_ro.v_dept_tree t
     where t.org_change_id = v_ver
       and exists (
             select 1
               from public.perm_grant g
               join erp_ro.v_dept_tree a
                 on a.org_change_id = t.org_change_id and a.dept_cd = any (t.path_cd)
              where lower(g.upn) = v_upn and g.revoked_at is null
                and g.scope_type = 'dept' and g.effect = 'allow'
                and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
                and btrim(g.scope_key) in (a.dept_cd, a.dept_nm)
           );

    if coalesce(array_length(v_scope, 1), 0) = 0 then
      raise exception 'forbidden: 열람 가능한 조직이 지정되지 않았습니다(perm_grant scope_type=dept 필요).'
        using errcode = '42501';
    end if;
  end if;

  with tr as (
    select * from erp_ro.v_dept_tree where org_change_id = v_ver
  ), mem as (
    select dept_cd, count(*)::int c
      from erp_ro.v_dept_member
     where org_change_id = v_ver and account_active and dept_cd is not null
     group by 1
  ), cl as (
    select dept_cd,
           count(*) filter (where cls = '표준')::int     as std,
           count(*) filter (where cls = '별도')::int     as etc,
           count(*) filter (where cls = '무관')::int     as unrel,
           count(*) filter (where cls = '예외승인')::int as exc,
           count(*) filter (where cls = '기준없음')::int as undef,
           count(*) filter (where cls = '회수')::int     as revoked,
           count(*) filter (where cls <> '회수')::int    as role_cnt
      from erp_ro.v_dept_role_matrix
     where org_change_id = v_ver and account_active and dept_cd is not null
     group by 1
  ), sd as (
    select dept_cd, count(*)::int c
      from public.dept_role_standard
     where org_change_id = v_ver and valid_to is null
     group by 1
  )
  select jsonb_agg(
           jsonb_build_object(
             'dept_cd', t.dept_cd, 'dept_nm', t.dept_nm, 'par_dept_cd', t.par_dept_cd,
             'lvl', t.lvl, 'sort_key', t.sort_key, 'path_nm', t.path_nm,
             'has_child', t.has_child, 'end_dept', t.end_dept,
             'visible', vis.ok,
             'member_cnt',      coalesce(m.c, 0),
             'member_cnt_desc', d.mem_desc,
             'std_state',       coalesce(stt.state, 'none'),
             'std_role_cnt',    coalesce(s.c, 0),
             'mapping_conf',    stt.mapping_conf,
             'role_cnt',   case when vis.ok then coalesce(c.role_cnt, 0) end,
             'std_cnt',    case when vis.ok then coalesce(c.std, 0)      end,
             'etc_cnt',    case when vis.ok then coalesce(c.etc, 0)      end,
             'unrel_cnt',  case when vis.ok then coalesce(c.unrel, 0)    end,
             'exc_cnt',    case when vis.ok then coalesce(c.exc, 0)      end,
             'undef_cnt',  case when vis.ok then coalesce(c.undef, 0)    end,
             'revoked_cnt',case when vis.ok then coalesce(c.revoked, 0)  end,
             'unrel_desc', case when vis.ok then d.unrel_desc            end,
             'etc_desc',   case when vis.ok then d.etc_desc              end
           ) order by t.sort_key
         ) into v_nodes
    from tr t
    left join mem m on m.dept_cd = t.dept_cd
    left join cl  c on c.dept_cd = t.dept_cd
    left join sd  s on s.dept_cd = t.dept_cd
    left join public.dept_role_standard_status stt
           on stt.org_change_id = v_ver and stt.dept_cd = t.dept_cd
    cross join lateral (select (v_admin or t.dept_cd = any (coalesce(v_scope, '{}'))) as ok) vis
    cross join lateral (
      select coalesce(sum(m2.c), 0)::int      as mem_desc,
             coalesce(sum(c2.unrel), 0)::int  as unrel_desc,
             coalesce(sum(c2.etc), 0)::int    as etc_desc
        from tr t2
        left join mem m2 on m2.dept_cd = t2.dept_cd
        left join cl  c2 on c2.dept_cd = t2.dept_cd
       where t.dept_cd = any (t2.path_cd)
    ) d;

  return jsonb_build_object(
    'ok', true,
    'org_change_id', v_ver,
    'org_versions', coalesce((select jsonb_agg(distinct x.org_change_id order by x.org_change_id)
                                from erp_ro.dept_master_s x where x.org_change_id ~ '^[0-9]+$'), '[]'::jsonb),
    'is_admin', v_admin,
    'scope', case when v_admin then 'all' else 'dept' end,
    'visible_dept_cds', case when v_admin then null else to_jsonb(v_scope) end,
    'unassigned_cnt', (select count(*)::int from erp_ro.v_dept_member
                        where org_change_id = v_ver and account_active and dept_cd is null),
    'as_of', public.erp_role_as_of(),
    'mirror', public.erp_role_mirror_health(),
    'nodes', coalesce(v_nodes, '[]'::jsonb)
  );
end $fn$;

comment on function public.erp_role_org_tree(text) is
  'ERP 권한 조직 트리 + 부서별 분류 집계. 개인 행을 내려주지 않는다(집계만). '
  '권한 밖 노드는 구조만 남기고 수치를 null 로 비운다 — 숨기면 조직도의 맥락이 사라진다.';


-- 기준 시각 · 미러 건강도 (RPC 3종이 공유)
create or replace function public.erp_role_as_of()
returns jsonb language sql stable security definer set search_path to '' as $fn$
  select jsonb_build_object(
    'usr_role',    (select max(synced_at) from erp_ro.usr_role_s),
    'hr_emp',      (select max(synced_at) from erp_ro.hr_emp_s),
    'usr_master',  (select max(synced_at) from erp_ro.usr_master_s),
    'dept_master', (select max(synced_at) from erp_ro.dept_master_s),
    'groupware',   (select max(collected_at) from public.acct_groupware),
    'job_usr_role',(select max(finished_at) from etl_meta.batch_run
                     where job_name = 'usr_role' and status = 'success')
  );
$fn$;

create or replace function public.erp_role_mirror_health()
returns jsonb language sql stable security definer set search_path to '' as $fn$
  select jsonb_build_object(
    'role_rows',        (select count(*) from erp_ro.usr_role_s),
    'role_rows_live',   (select count(*) from erp_ro.usr_role_s where revoked_at is null),
    'role_rows_revoked',(select count(*) from erp_ro.usr_role_s where revoked_at is not null),
    'reconcile_ok',     (select count(*) = 0 from erp_ro.usr_role_s
                          where revoked_at is null
                            and batch_id is distinct from (
                                  select b.batch_id from etl_meta.batch_run b
                                   where b.job_name = 'usr_role' and b.status = 'success' and b.rows_read >= 500
                                   order by b.finished_at desc limit 1)),
    'last_job_status',  (select status from etl_meta.batch_run
                          where job_name = 'usr_role' order by finished_at desc nulls last limit 1)
  );
$fn$;


-- 부서 상세
create or replace function public.erp_role_dept_detail(
  p_dept_cd         text,
  p_org_change_id   text    default null,
  p_include_desc    boolean default false,
  p_include_revoked boolean default false
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_upn    text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  v_eff    jsonb;
  v_admin  boolean;
  v_ver    text;
  v_cd     text := btrim(coalesce(p_dept_cd, ''));
  -- 「소속 미확인」 가상 부서 — 인사·부서 마스터에 소속이 없는 계정(실측 4명: 외부 회계사 2·CRO·헝가리 주재원).
  -- 조직도 밖이라 평소 눈에 안 띄는데 실제로는 재무회계 관리자급 권한을 다수 보유하고 있었다.
  -- 부서 범위(perm_grant dept)로 지정할 수 없는 대상이라 관리자 전용으로 연다.
  v_unassigned boolean := (btrim(coalesce(p_dept_cd, '')) = '__unassigned__');
  v_scope  text[] := null;
  v_targets text[];
  v_members jsonb;
  v_dept   jsonb;
begin
  if not public.is_internal() then
    raise exception 'forbidden: 사내 계정만 조회할 수 있습니다.' using errcode = '42501';
  end if;
  if v_upn = '' then
    raise exception 'unauthorized: 로그인 세션이 필요합니다.' using errcode = '28000';
  end if;
  if v_cd = '' then
    raise exception '부서코드가 필요합니다.' using errcode = '22023';
  end if;

  v_ver := coalesce(nullif(btrim(coalesce(p_org_change_id, '')), ''),
                    (select max(d.org_change_id) from erp_ro.dept_master_s d
                      where d.org_change_id ~ '^[0-9]+$'));

  v_eff   := public.perm_effective(v_upn);
  v_admin := coalesce((v_eff ->> 'is_admin')::boolean, false);

  if not v_admin then
    if not exists (
      select 1 from jsonb_array_elements(coalesce(v_eff -> 'pages', '[]'::jsonb)) e
       where e ->> 'page_key' = 'erp_role_matrix'
         and coalesce((e ->> 'allowed')::boolean, false)
    ) then
      raise exception 'forbidden: ERP 권한현황 열람 권한이 필요합니다.' using errcode = '42501';
    end if;
    if v_unassigned then
      raise exception 'forbidden: 「소속 미확인」 계정은 관리자만 열람할 수 있습니다.' using errcode = '42501';
    end if;

    select coalesce(array_agg(distinct t.dept_cd), '{}') into v_scope
      from erp_ro.v_dept_tree t
     where t.org_change_id = v_ver
       and exists (
             select 1
               from public.perm_grant g
               join erp_ro.v_dept_tree a
                 on a.org_change_id = t.org_change_id and a.dept_cd = any (t.path_cd)
              where lower(g.upn) = v_upn and g.revoked_at is null
                and g.scope_type = 'dept' and g.effect = 'allow'
                and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
                and btrim(g.scope_key) in (a.dept_cd, a.dept_nm)
           );

    if not (v_cd = any (coalesce(v_scope, '{}'))) then
      raise exception 'forbidden: 이 조직을 열람할 권한이 없습니다.' using errcode = '42501';
    end if;
  end if;

  if v_unassigned then
    v_targets := '{}';
    v_dept := jsonb_build_object(
      'dept_cd', '__unassigned__', 'dept_nm', '소속 미확인',
      'path_nm', '인사·부서 마스터에 소속이 없는 ERP 계정', 'lvl', 0,
      'include_desc', false, 'std_state', 'none', 'std_source', null,
      'mapping_conf', null, 'std_role_cnt', 0, 'scope_modules', '[]'::jsonb, 'leader_nm', null);
  else
  -- 대상 부서(옵션에 따라 하위 포함). 권한 범위 밖 하위는 제외한다.
  select coalesce(array_agg(t.dept_cd), array[v_cd]) into v_targets
    from erp_ro.v_dept_tree t
   where t.org_change_id = v_ver
     and (t.dept_cd = v_cd or (p_include_desc and v_cd = any (t.path_cd)))
     and (v_admin or t.dept_cd = any (coalesce(v_scope, '{}')));

  select jsonb_build_object(
           'dept_cd', t.dept_cd, 'dept_nm', t.dept_nm, 'path_nm', t.path_nm, 'lvl', t.lvl,
           'include_desc', p_include_desc,
           'std_state', coalesce(stt.state, 'none'),
           'std_source', stt.seed_source,
           'mapping_conf', stt.mapping_conf,
           'std_role_cnt', (select count(*)::int from public.dept_role_standard s
                             where s.org_change_id = v_ver and s.dept_cd = t.dept_cd and s.valid_to is null),
           'scope_modules', coalesce((select jsonb_agg(sc.role_module_key order by sc.role_module_key)
                                        from public.dept_role_module_scope sc
                                       where sc.org_change_id = v_ver and sc.dept_cd = t.dept_cd), '[]'::jsonb),
           'leader_nm', (select m.emp_nm from erp_ro.v_dept_member m
                          where m.org_change_id = v_ver and m.dept_cd = t.dept_cd
                            and m.account_active and m.gw_title in ('팀장','부문장','법인장','대표')
                          order by m.emp_nm limit 1)
         ) into v_dept
    from erp_ro.v_dept_tree t
    left join public.dept_role_standard_status stt
           on stt.org_change_id = v_ver and stt.dept_cd = t.dept_cd
   where t.org_change_id = v_ver and t.dept_cd = v_cd;
  end if;

  select jsonb_agg(x.j order by x.unrel desc, x.etc desc, x.role_cnt desc, x.emp_nm)
    into v_members
    from (
      select m.email, m.emp_nm,
             count(r.role_id) filter (where r.cls = '무관')::int     as unrel,
             count(r.role_id) filter (where r.cls = '별도')::int     as etc,
             count(r.role_id) filter (where r.cls <> '회수')::int    as role_cnt,
             jsonb_build_object(
               'email', m.email, 'emp_nm', m.emp_nm,
               'dept_cd', m.dept_cd, 'dept_nm', m.dept_nm_raw,
               'dept_src', m.dept_src, 'dept_label_stale', m.dept_label_stale,
               'title', m.gw_title,
               'account_active', m.account_active, 'hr_active', m.hr_active, 'gw_active', m.gw_active,
               'role_cnt', count(r.role_id) filter (where r.cls <> '회수')::int,
               'std',      count(r.role_id) filter (where r.cls = '표준')::int,
               'etc',      count(r.role_id) filter (where r.cls = '별도')::int,
               'unrel',    count(r.role_id) filter (where r.cls = '무관')::int,
               'exc',      count(r.role_id) filter (where r.cls = '예외승인')::int,
               'undef',    count(r.role_id) filter (where r.cls = '기준없음')::int,
               'revoked',  count(r.role_id) filter (where r.cls = '회수')::int,
               'roles', coalesce(jsonb_agg(
                          jsonb_build_object(
                            'role_id', r.role_id, 'role_nm', r.role_nm,
                            'module', r.role_module_key, 'module_label', r.module_label,
                            'is_write', r.is_write, 'sensitive', r.module_sensitive,
                            'cls', r.cls, 'why', r.why,
                            'peer_cnt', r.peer_cnt, 'dept_size', r.dept_size, 'peer_ratio', r.peer_ratio,
                            'revoked_at', r.revoked_at)
                          order by (case r.cls when '무관' then 0 when '별도' then 1 when '예외승인' then 2
                                               when '기준없음' then 3 when '표준' then 4 else 5 end),
                                   r.role_nm)
                          filter (where r.role_id is not null), '[]'::jsonb)
             ) as j
        from erp_ro.v_dept_member m
        left join erp_ro.v_dept_role_matrix r
               on r.email = m.email and r.org_change_id = m.org_change_id
              and (p_include_revoked or r.cls <> '회수')
       where m.org_change_id = v_ver
         and m.account_active
         and (case when v_unassigned then m.dept_cd is null
                   else m.dept_cd = any (v_targets) end)
       group by m.email, m.emp_nm, m.dept_cd, m.dept_nm_raw, m.dept_src,
                m.dept_label_stale, m.gw_title, m.account_active, m.hr_active, m.gw_active
    ) x;

  -- 열람 감사 (perm_effective 의 view_effective 선례)
  insert into public.perm_audit (actor, action, target, detail)
  values (v_upn, 'erp_role_view', v_cd,
          jsonb_build_object('org_change_id', v_ver,
                             'include_desc', p_include_desc,
                             'targets', to_jsonb(v_targets),
                             'members', coalesce(jsonb_array_length(v_members), 0)));

  return jsonb_build_object(
    'ok', true,
    'org_change_id', v_ver,
    'dept', v_dept,
    'summary', (
      select jsonb_build_object(
               '표준',     count(*) filter (where cls = '표준'),
               '별도',     count(*) filter (where cls = '별도'),
               '무관',     count(*) filter (where cls = '무관'),
               '예외승인', count(*) filter (where cls = '예외승인'),
               '기준없음', count(*) filter (where cls = '기준없음'),
               '회수',     count(*) filter (where cls = '회수'),
               'write_roles',     count(*) filter (where is_write and cls <> '회수'),
               'sensitive_roles', count(*) filter (where module_sensitive and cls <> '회수'))
        from erp_ro.v_dept_role_matrix
       where org_change_id = v_ver and account_active
         and (case when v_unassigned then dept_cd is null else dept_cd = any (v_targets) end)
    ),
    'members', coalesce(v_members, '[]'::jsonb),
    'std_missing', case when v_unassigned then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('role_id', ms.role_id, 'role_nm', ms.role_nm,
                                          'holders', ms.holders, 'dept_size', ms.dept_size)
                       order by ms.role_nm)
        from erp_ro.v_dept_role_missing ms
       where ms.org_change_id = v_ver and ms.dept_cd = any (v_targets)), '[]'::jsonb) end,
    'as_of', public.erp_role_as_of(),
    'mirror', public.erp_role_mirror_health()
  );
end $fn$;

comment on function public.erp_role_dept_detail(text, text, boolean, boolean) is
  '선택 부서의 구성원 + 역할 상세(표준/별도/무관 분류). 기본 정렬은 무관 → 별도 → 보유수 순 — '
  '첫 화면에서 조치 대상이 맨 위에 오게 한다. 열람은 perm_audit 에 기록된다. '
  '사번·입퇴사일·직위코드는 반환하지 않는다(CLAUDE.md §1.7).';


-- 전사 요약 (관리자 전용)
create or replace function public.erp_role_summary(p_org_change_id text default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_upn   text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  v_admin boolean;
  v_ver   text;
begin
  if not public.is_internal() then
    raise exception 'forbidden: 사내 계정만 조회할 수 있습니다.' using errcode = '42501';
  end if;
  if v_upn = '' then
    raise exception 'unauthorized: 로그인 세션이 필요합니다.' using errcode = '28000';
  end if;

  v_admin := coalesce((public.perm_effective(v_upn) ->> 'is_admin')::boolean, false);
  if not v_admin then
    raise exception 'forbidden: 전사 요약은 관리자 전용입니다.' using errcode = '42501';
  end if;

  v_ver := coalesce(nullif(btrim(coalesce(p_org_change_id, '')), ''),
                    (select max(d.org_change_id) from erp_ro.dept_master_s d
                      where d.org_change_id ~ '^[0-9]+$'));

  insert into public.perm_audit (actor, action, target, detail)
  values (v_upn, 'erp_role_summary', v_ver, jsonb_build_object('org_change_id', v_ver));

  return jsonb_build_object(
    'ok', true,
    'org_change_id', v_ver,
    'totals', (
      select jsonb_build_object(
               'members',  (select count(*) from erp_ro.v_dept_member
                             where org_change_id = v_ver and account_active),
               'role_rows_live', count(*) filter (where cls <> '회수'),
               '표준',     count(*) filter (where cls = '표준'),
               '별도',     count(*) filter (where cls = '별도'),
               '무관',     count(*) filter (where cls = '무관'),
               '예외승인', count(*) filter (where cls = '예외승인'),
               '기준없음', count(*) filter (where cls = '기준없음'))
        from erp_ro.v_dept_role_matrix where org_change_id = v_ver and account_active
    ),
    'by_module', coalesce((
      select jsonb_agg(jsonb_build_object('module', t.role_module_key, 'label', t.module_label,
                                          'sensitive', t.module_sensitive,
                                          'role_cnt', t.role_cnt, 'assign_cnt', t.assign_cnt,
                                          'unrel_cnt', t.unrel_cnt) order by t.assign_cnt desc)
        from (select role_module_key, max(module_label) module_label,
                     bool_or(module_sensitive) module_sensitive,
                     count(distinct role_id)::int role_cnt,
                     count(*) filter (where cls <> '회수')::int assign_cnt,
                     count(*) filter (where cls = '무관')::int  unrel_cnt
                from erp_ro.v_dept_role_matrix
               where org_change_id = v_ver and account_active
               group by 1) t), '[]'::jsonb),
    'top_unrelated', coalesce((
      select jsonb_agg(jsonb_build_object('role_id', t.role_id, 'role_nm', t.role_nm,
                                          'cnt', t.cnt, 'depts', t.depts,
                                          'is_write', t.is_write, 'sensitive', t.sensitive)
                       order by t.cnt desc, t.role_nm)
        from (select role_id, max(role_nm) role_nm, count(*)::int cnt,
                     jsonb_agg(distinct dept_nm_raw) depts,
                     bool_or(is_write) is_write, bool_or(module_sensitive) sensitive
                from erp_ro.v_dept_role_matrix
               where org_change_id = v_ver and account_active and cls = '무관'
               group by 1 order by 3 desc limit 20) t), '[]'::jsonb),
    'dept_no_standard', coalesce((
      select jsonb_agg(jsonb_build_object('dept_cd', t.dept_cd, 'dept_nm', t.dept_nm,
                                          'member_cnt', t.c, 'mapping_conf', t.mapping_conf)
                       order by t.c desc)
        from (select m.dept_cd, max(m.dept_nm_raw) dept_nm, count(*)::int c, max(stt.mapping_conf) mapping_conf
                from erp_ro.v_dept_member m
                left join public.dept_role_standard_status stt
                       on stt.org_change_id = m.org_change_id and stt.dept_cd = m.dept_cd
               where m.org_change_id = v_ver and m.account_active
                 and coalesce(stt.state, 'none') = 'none'
               group by 1) t), '[]'::jsonb),
    'as_of', public.erp_role_as_of(),
    'mirror', public.erp_role_mirror_health()
  );
end $fn$;


-- ─────────────────────────────────────────────────────────────────────────
-- §9. 시드·제안 RPC (service_role 전용 — seed_role_standard.py 가 호출)
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.erp_role_standard_seed(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare n int := 0; d int := 0;
begin
  if coalesce(jsonb_array_length(p_rows), 0) = 0 then
    raise exception '시드 행이 비어 있습니다.';
  end if;

  insert into public.dept_role_standard
    (org_change_id, dept_cd, role_id, dept_nm_at_seed, role_nm_at_seed,
     source, source_detail, confidence, approved_by, approved_at, note, updated_by, updated_at)
  select btrim(x.org_change_id), btrim(x.dept_cd), btrim(x.role_id),
         x.dept_nm_at_seed, x.role_nm_at_seed,
         coalesce(x.source, 'manual'), x.source_detail, coalesce(x.confidence, 'high'),
         x.approved_by, case when x.approved_by is not null then now() end,
         x.note, coalesce(x.updated_by, 'seed_role_standard'), now()
    from jsonb_to_recordset(p_rows) as x(org_change_id text, dept_cd text, role_id text,
                                         dept_nm_at_seed text, role_nm_at_seed text,
                                         source text, source_detail text, confidence text,
                                         approved_by text, note text, updated_by text)
  on conflict (org_change_id, dept_cd, role_id) do update
    set dept_nm_at_seed = excluded.dept_nm_at_seed,
        role_nm_at_seed = excluded.role_nm_at_seed,
        source = excluded.source, source_detail = excluded.source_detail,
        confidence = excluded.confidence, note = excluded.note,
        updated_by = excluded.updated_by, updated_at = now();
  get diagnostics n = row_count;

  -- 상태 표 갱신 + 부서 소관 모듈 자동 도출
  insert into public.dept_role_standard_status (org_change_id, dept_cd, state, seed_source, mapping_conf, updated_at)
  select s.org_change_id, s.dept_cd, 'seeded', min(s.source), min(s.confidence), now()
    from public.dept_role_standard s
   where s.valid_to is null
   group by 1, 2
  on conflict (org_change_id, dept_cd) do update
    set state = case when public.dept_role_standard_status.state in ('reviewed','approved')
                     then public.dept_role_standard_status.state else 'seeded' end,
        seed_source = excluded.seed_source, mapping_conf = excluded.mapping_conf, updated_at = now();

  -- 부서 소관 모듈 자동 도출 — ★ 쓰기 권한(is_write)만 근거로 삼는다.
  --   조회 권한(BP_S '1.재무회계_거래처조회권한', STOC_S '6.자재물류_재고관리조회권한' 등)은
  --   거의 전 부서가 표준으로 갖고 있다. 이걸 근거로 쓰면 재무회계·자재물류 모듈이 모든 부서의
  --   '소관'이 되어 「무관」이 사실상 사라진다 — 2026-09-18 실측으로 실제 붕괴를 확인했다(무관 2건).
  --   "그 부서가 이 모듈을 다루는가"의 판단 기준은 쓰기 권한이다.
  --   company_wide(0.공통)는 이미 분류 단계에서 '별도'로 처리되므로 소관 축에서 제외한다.
  delete from public.dept_role_module_scope where source = 'derived';

  insert into public.dept_role_module_scope (org_change_id, dept_cd, role_module_key, source, updated_by, updated_at)
  select distinct s.org_change_id, s.dept_cd, p.role_module_key, 'derived', 'seed_role_standard', now()
    from public.dept_role_standard s
    join erp_ro.v_usr_role_parsed p on p.role_id = s.role_id
   where s.valid_to is null
     and p.is_write
     and exists (select 1 from public.erp_role_module_map mm
                  where mm.role_module_key = p.role_module_key and not mm.company_wide)
  on conflict (org_change_id, dept_cd, role_module_key) do nothing;
  get diagnostics d = row_count;

  return jsonb_build_object('standard_upserted', n, 'scope_derived', d);
end $fn$;


-- 시드 스크립트용 현행 조직 목록 (화면은 erp_role_org_tree 를 쓴다)
create or replace function public.erp_role_org_list(p_org_change_id text default null)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'org_change_id', t.org_change_id,
           'dept_cd', t.dept_cd, 'dept_nm', t.dept_nm, 'path_nm', t.path_nm,
           'lvl', t.lvl, 'end_dept', t.end_dept,
           'member_cnt', coalesce(m.c, 0),
           'std_state', coalesce(stt.state, 'none'))
         order by t.sort_key), '[]'::jsonb)
    from erp_ro.v_dept_tree t
    left join (select dept_cd, count(*)::int c from erp_ro.v_dept_member
                where account_active and dept_cd is not null group by 1) m
           on m.dept_cd = t.dept_cd
    left join public.dept_role_standard_status stt
           on stt.org_change_id = t.org_change_id and stt.dept_cd = t.dept_cd
   where t.org_change_id = coalesce(nullif(btrim(coalesce(p_org_change_id, '')), ''),
                                    (select max(d.org_change_id) from erp_ro.dept_master_s d
                                      where d.org_change_id ~ '^[0-9]+$'));
$fn$;

-- ERP 에 존재하는 역할 목록.
--   ⚠ 회수분(revoked_at)도 포함한다. 지금 보유자가 0명일 뿐 ERP 에 있는 역할이며, 표준에서 빼면
--     그 모듈이 부서 소관에서 통째로 빠져 같은 모듈의 조회권한이 전원 「무관」이 된다
--     (2026-09-18 실측: PMS_I 39건 회수 → 사업관리팀·사업운영팀 28명의 PMS_END_S 가 무관으로 오탐).
--     보유자 0명인 표준은 v_dept_role_missing(과소 권한)에서 따로 드러난다.
create or replace function public.erp_role_catalog()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'role_id', t.role_id, 'role_nm', t.role_nm,
           'module', t.role_module_key,
           'holders', t.holders, 'revoked_only', (t.holders = 0))
         order by t.role_nm), '[]'::jsonb)
    from (select p.role_id, max(p.role_nm) as role_nm, max(p.role_module_key) as role_module_key,
                 count(*) filter (where p.revoked_at is null)::int as holders
            from erp_ro.v_usr_role_parsed p
           group by p.role_id) t;
$fn$;

create or replace function public.erp_role_majority_suggest(
  p_org_change_id text    default null,
  p_min_size      int     default 3,
  p_threshold     numeric default 0.6
) returns jsonb
language sql
stable
security definer
set search_path to ''
as $fn$
  -- 표준 세트가 없는 부서에 대해 「같은 부서 보유율 >= 임계값」인 role 을 후보로 뽑는다.
  -- ⚠ 회수분(revoked_at)을 제외하지 않으면 PMS_I 가 20/20 으로 잡혀 정반대 결론이 난다.
  -- ⚠ 인원 p_min_size 미만 부서는 제외한다 — 1명 부서는 보유 role 이 전부 100% 라 이상권한이 영영 0건이 된다.
  select coalesce(jsonb_agg(jsonb_build_object(
           'org_change_id', t.org_change_id, 'dept_cd', t.dept_cd, 'dept_nm', t.dept_nm,
           'role_id', t.role_id, 'role_nm', t.role_nm,
           'peer_cnt', t.peer_cnt, 'dept_size', t.dept_size, 'peer_ratio', t.peer_ratio,
           'source', 'majority', 'confidence', 'low',
           'source_detail', t.peer_cnt || '/' || t.dept_size || '=' || t.peer_ratio)
         order by t.dept_cd, t.role_nm), '[]'::jsonb)
    from (
      select distinct m.org_change_id, m.dept_cd, m.dept_nm_raw as dept_nm,
             m.role_id, m.role_nm, m.peer_cnt, m.dept_size, m.peer_ratio
        from erp_ro.v_dept_role_matrix m
        left join public.dept_role_standard_status stt
               on stt.org_change_id = m.org_change_id and stt.dept_cd = m.dept_cd
       where m.org_change_id = coalesce(nullif(btrim(coalesce(p_org_change_id, '')), ''),
                                        (select max(d.org_change_id) from erp_ro.dept_master_s d
                                          where d.org_change_id ~ '^[0-9]+$'))
         and m.account_active
         and m.cls <> '회수'
         and coalesce(stt.state, 'none') = 'none'
         and m.dept_size >= p_min_size
         and coalesce(m.peer_ratio, 0) >= p_threshold
    ) t;
$fn$;


-- ─────────────────────────────────────────────────────────────────────────
-- §10. 권한 — 신규 표·뷰는 RLS ON + 정책 0개. 화면 RPC 만 authenticated 에 연다.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.erp_role_module_map        enable row level security;
alter table public.dept_role_standard         enable row level security;
alter table public.dept_role_standard_status  enable row level security;
alter table public.dept_role_module_scope     enable row level security;
alter table public.dept_map_legacy            enable row level security;
alter table public.usr_role_exception         enable row level security;

revoke all on public.erp_role_module_map, public.dept_role_standard,
              public.dept_role_standard_status, public.dept_role_module_scope,
              public.dept_map_legacy, public.usr_role_exception
  from anon, authenticated;
grant select, insert, update, delete on
              public.erp_role_module_map, public.dept_role_standard,
              public.dept_role_standard_status, public.dept_role_module_scope,
              public.dept_map_legacy, public.usr_role_exception
  to service_role;

revoke all on erp_ro.v_dept_tree, erp_ro.v_usr_role_parsed, erp_ro.v_dept_member,
              erp_ro.v_dept_role_matrix, erp_ro.v_dept_role_missing
  from anon, authenticated;
grant select on erp_ro.v_dept_tree, erp_ro.v_usr_role_parsed, erp_ro.v_dept_member,
                erp_ro.v_dept_role_matrix, erp_ro.v_dept_role_missing
  to service_role;

-- 화면 RPC (선례: 17_perm_core.sql:100 perm_can · 44_item_dup_search.sql)
revoke all on function public.erp_role_org_tree(text) from public, anon;
grant execute on function public.erp_role_org_tree(text) to authenticated, service_role;

revoke all on function public.erp_role_dept_detail(text, text, boolean, boolean) from public, anon;
grant execute on function public.erp_role_dept_detail(text, text, boolean, boolean) to authenticated, service_role;

revoke all on function public.erp_role_summary(text) from public, anon;
grant execute on function public.erp_role_summary(text) to authenticated, service_role;

revoke all on function public.erp_role_as_of() from public, anon;
grant execute on function public.erp_role_as_of() to authenticated, service_role;

revoke all on function public.erp_role_mirror_health() from public, anon;
grant execute on function public.erp_role_mirror_health() to authenticated, service_role;

-- 관리·적재 RPC (42_rpc_execute_public_revoke.sql 관례)
revoke all on function public.erp_usr_role_reconcile(text[]) from public, anon, authenticated;
grant execute on function public.erp_usr_role_reconcile(text[]) to service_role;

revoke all on function public.erp_role_standard_seed(jsonb) from public, anon, authenticated;
grant execute on function public.erp_role_standard_seed(jsonb) to service_role;

revoke all on function public.erp_role_majority_suggest(text, int, numeric) from public, anon, authenticated;
grant execute on function public.erp_role_majority_suggest(text, int, numeric) to service_role;

revoke all on function public.erp_role_org_list(text) from public, anon, authenticated;
grant execute on function public.erp_role_org_list(text) to service_role;

revoke all on function public.erp_role_catalog() from public, anon, authenticated;
grant execute on function public.erp_role_catalog() to service_role;


-- ─────────────────────────────────────────────────────────────────────────
-- §10-2. 연동 현황에 hr_emp · usr_role 2행 추가
--   두 job 은 etl_meta.batch_run 에 이미 기록되고 있는데 v_erp_sync_overview(35번)에는 없어
--   "권한·인사 미러가 언제 갱신됐는지"를 화면에서 볼 수 없었다.
--   기존 정의를 pg_get_viewdef 로 읽어 뒤에 붙인다 — 250줄을 손으로 옮겨 적다 틀리는 것보다 안전하고,
--   적용본이 이미 저장소 정본(35번)보다 앞서 있어(19종 vs 16종) 통째로 다시 쓰면 그 차이를 지워버린다.
--   ⚠ row_count 에 count(*) 를 쓰지 않는다 — hr_emp_s·usr_role_s 는 authenticated 에서 회수돼 있어
--     security_invoker 뷰가 전 사내 사용자에게 permission denied 가 된다(35번 머리말의 사고 유형).
--   회귀 검증: set local role authenticated; select count(*) from public.v_erp_sync_overview;  -- 22행·오류 없음
-- ─────────────────────────────────────────────────────────────────────────
do $$
declare v text;
begin
  select pg_get_viewdef('public.v_erp_sync_overview'::regclass, true) into v;
  if position('''usr_role''::text' in v) > 0 then
    raise notice 'v_erp_sync_overview 에 이미 usr_role 행이 있습니다 — 건너뜁니다';
    return;
  end if;
  v := rtrim(rtrim(v), ';');
  execute 'create or replace view public.v_erp_sync_overview with (security_invoker = true) as ' || v || '
    union all
    select ''hr_emp''::text, ''인사 사원마스터(계정 대사)''::text, ''HAA010T''::text,
           (select max(b.finished_at) from etl_meta.batch_run b
             where b.job_name = ''hr_emp'' and b.status = ''success''),
           (select b.rows_upserted from etl_meta.batch_run b
             where b.job_name = ''hr_emp'' and b.status = ''success''
             order by b.finished_at desc limit 1)::bigint,
           null::text, null::text, false, 85
    union all
    select ''usr_role''::text, ''ERP 역할 배정(권한)''::text,
           ''Z_USR_MAST_REC_USR_ROLE_ASSO + Z_USR_ROLE''::text,
           (select max(b.finished_at) from etl_meta.batch_run b
             where b.job_name = ''usr_role'' and b.status = ''success''),
           (select b.rows_upserted from etl_meta.batch_run b
             where b.job_name = ''usr_role'' and b.status = ''success''
             order by b.finished_at desc limit 1)::bigint,
           null::text, null::text, false, 95';
end $$;


-- ─────────────────────────────────────────────────────────────────────────
-- §11. 포털 페이지 등재 — 관리자 전용(부서 무관)
--   dept_nm 을 null 로 두는 이유: perm_effective 의 '부서 전용' 분기가
--   (p.dept_nm = any(v_depts) or p.dept_nm = any(v_deptadmin)) 이라 null 이면 결과가 NULL 이고,
--   _access-gate.js 의 `if (pg && pg.allowed)` 에서 fail-closed 로 막힌다(라이브 함수 본문 확인).
--   가짜 부서명('관리자' 등)을 넣으면 app/admin-permissions.html 의 부서 수집기에
--   유령 부서가 생겨 REQ-0032 를 재생산한다.
--   erp_module 을 null 로 두는 이유: page grant 단독으로 열려야 하고(민감 모듈이면 모듈 보유를 추가 요구),
--   이 화면은 ERP 데이터 모듈이 아니라 권한 메타데이터를 다룬다.
-- ─────────────────────────────────────────────────────────────────────────

insert into public.portal_page
  (page_key, title, path, icon, dept_nm, visibility, shared_depts, erp_module, note, sort, active, updated_by)
values
  ('erp_role_matrix', 'ERP 권한(role) 조직별 현황', '/work/erp-roles', '🔑',
   null, '부서 전용', '{}', null,
   '관리자 전용(부서 무관). 열람은 portal_admin 또는 perm_grant(scope_type=''page'', scope_key=''erp_role_matrix'') 로만. '
   '행 범위(부서장 자기 부서)는 perm_grant(scope_type=''dept'') 로 부여한다. REQ-0057',
   5, true, 'admin:req-0057')
on conflict (page_key) do update
  set title = excluded.title, path = excluded.path, icon = excluded.icon,
      dept_nm = null, visibility = '부서 전용', shared_depts = '{}', erp_module = null,
      note = excluded.note, sort = excluded.sort, active = true,
      updated_by = excluded.updated_by, updated_at = now();


-- ============================================================================
-- 검증 (적용 후 반드시 수행)
-- ============================================================================
-- 1) 회수 백필 — 기대 정확히 61행
--    select count(*) from erp_ro.usr_role_s where revoked_at is not null;          -- 61
--    select count(*) from erp_ro.usr_role_s where revoked_at is null;              -- 1691
--
-- 2) 조직 트리 — 현행 35행 · 루트 1 · 최대 깊이 4 · 고아 0
--    select count(*), min(lvl), max(lvl) from erp_ro.v_dept_tree where is_current;
--    select count(*) from erp_ro.dept_master_s d
--     where d.org_change_id = (select max(x.org_change_id) from erp_ro.dept_master_s x where x.org_change_id ~ '^[0-9]+$')
--       and btrim(d.dept_cd) not in (select dept_cd from erp_ro.v_dept_tree where is_current);   -- 0
--
-- 3) role 모듈 파싱 — 미분류가 'Z_TEMP' 계열뿐인지
--    select role_module_key, count(*) from erp_ro.v_usr_role_parsed group by 1 order by 2 desc;
--
-- 4) 분류 정합 (시드 적용 후) — 2026-09-18 실측 결과
--    표준 1,426 / 별도 67 / 무관 37(19명) / 기준없음 74(5명) / 회수 37
--    민감·쓰기 4건이 최상단: 인사팀 CMSAUTH · 인사부문 ACCTAUTH·BASE_BP_ROLE · 내부회계관리팀 Z_TEMP
--    select dept_nm_raw, emp_nm, role_id, role_nm, cls, why
--      from erp_ro.v_dept_role_matrix where account_active and cls = '무관'
--      order by module_sensitive desc, is_write desc, dept_nm_raw, role_nm;
--
-- 5) 페이지 판정 — 관리자 true / 일반 null(fail-closed)
--    select jsonb_path_query(public.perm_effective('<관리자>'), '$.pages[*] ? (@.page_key == "erp_role_matrix")');
--    select jsonb_path_query(public.perm_effective('<일반>'),   '$.pages[*] ? (@.page_key == "erp_role_matrix")');
--
-- 6) 서버 강제 (가장 중요) — 권한 없는 사내 계정 세션에서
--    set local role authenticated;  select public.erp_role_org_tree();   -- 42501 forbidden
--    reset role;
--
-- 7) 다수결 후보에 회수분이 섞이지 않는지
--    select * from jsonb_array_elements(public.erp_role_majority_suggest()) e
--     where e->>'role_id' = 'PMS_I';                                      -- 0행이어야 한다
-- ============================================================================
