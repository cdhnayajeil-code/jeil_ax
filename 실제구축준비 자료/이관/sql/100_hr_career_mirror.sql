-- 100_hr_career_mirror.sql — ERP 인사 경력정보(HAA050T) 미러 + 인사마스터 보강 (REQ-0120 · 2026-10-08)
-- 마이그레이션: hr_career_mirror_req0120
--
-- 무엇을
--   1) erp_ro.hr_career_s — 「당사 입사 이전 경력」(ERP 화면 H2006M1 경력등록, 저장 HAA050T) 미러.
--      PK = (사번, 근무시작, 근무종료) — ERP PK 그대로(날짜로 내림). 전량 스냅샷 + 배치 정합(revoked_at).
--   2) erp_ro.hr_emp_s 보강 — 직책코드(ROLE_CD · 종합코드 H0026)·마스터 인정경력 개월(CAREER_MM) 두 열 추가.
--      인정경력 개월은 HAA050T 의 APPLY_YN='Y' 행 합계와 전원 일치한다(2026-10-08 ERP_DB 실측 99/99).
--   3) 코드 이름은 종합코드 미러(erp_ro.sys_code_s · ETL job `sys_code`)에 H0002(직위)·H0016(입사구분)·H0026(직책)
--      세 그룹을 더해 푼다 — 이 파일에는 표 변경이 없다(ETL IN 목록만).
--      입사구분 ENTR_CD 의미(2026-09-07 미결)는 ERP 종합코드 H0016 으로 확정: 1 신규 · 2 경력 · 3 재입사 · 4 기타.
--   4) 적재는 service_role 전용 `erp_identity_upsert` 에 분기 추가(hr_career_s) + hr_emp_s 분기 열 2개 확장.
--      live 정의(4분기: hr_emp_s·usr_role_s·menu_master_s·role_menu_s — SQL 34·50·51)를 그대로 품는다.
--   5) 정합 `erp_hr_career_reconcile(p_table, p_batch_id, p_min_rows)` — erp_menu_reconcile 과 같은 호출 규약.
--      이번 배치가 안 덮은 행 = ERP 에서 지워진 행 → revoked_at 표시(물리 삭제 없음). 부분 적재(min_rows 미만)는 거부.
--   6) 조회 `hr_career_get(p_emp_no, p_q, p_include_revoked)` — 유일한 읽기 경로.
--      허용: service_role(게이트웨이 — 자기 검사 필수) 또는 사내 사용자 중 ERP 모듈 `payroll` 권한자(= 인사팀 · 전체관리자).
--      그 밖은 allowed:false 와 빈 목록. erp_ro 는 REST 비노출이라 화면이 직접 읽으면 오류 없이 빈 결과(REQ-0015 선례).
--
-- 하지 않는 것
--   · 주민번호·주소·연락처·급여·CARD_ID 는 여전히 추출하지 않는다(CLAUDE.md §1.7). 경력 직종(OCPT_TYPE)은 전건 공백이라 뺀다.
--   · erp_secure 로 보내지 않는다 — 경력은 급여·평가류 민감이 아니라 erp_ro + 권한 RPC 로 가둔다(관리자 이견 시 변경).
--   · 학력·자격·가족·병역 등 다른 인사 서브정보는 범위 밖.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. 경력 미러 표
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists erp_ro.hr_career_s (
  emp_no        text not null,
  career_start  date not null,          -- 근무 시작(ERP datetime → date)
  career_end    date not null,          -- 근무 종료
  comp_nm       text,                   -- 회사명(자유입력)
  roll_pstn     text,                   -- 경력 당시 직위(자유입력 — 종합코드 아님)
  func_nm       text,                   -- 담당업무(자유입력)
  career_yy     integer,                -- 인정경력 년(수기)
  career_mm     integer,                -- 인정경력 월(수기)
  apply_yn      text,                   -- 인정 반영 여부 Y/N — 마스터 인정경력 = Y 행 합계
  src_updated   timestamptz,            -- UPDT_DT
  synced_at     timestamptz not null default now(),
  batch_id      uuid,
  revoked_at    timestamptz,            -- ERP 에서 사라진 행 표시(배치 정합) — 되살아나면 null
  primary key (emp_no, career_start, career_end)
);

comment on table erp_ro.hr_career_s is
  'ERP 인사 경력정보 미러(HAA050T — 화면 H2006M1 「당사 입사 이전 경력」). PK=사번+근무시작+근무종료(ERP PK). '
  '전량 스냅샷 + 배치 정합(revoked_at). 주민번호·연락처·급여는 적재하지 않는다(CLAUDE.md §1.7). '
  '읽기는 hr_career_get(payroll 모듈 권한자·전체관리자·service_role)만. REQ-0120.';
comment on column erp_ro.hr_career_s.apply_yn is
  '경력 인정 반영 여부. 마스터(hr_emp_s.career_mm)는 이 값이 Y 인 행의 인정개월 합계와 일치한다(2026-10-08 실측 99/99).';
comment on column erp_ro.hr_career_s.revoked_at is
  '이번 배치가 덮지 않은 행 = ERP 에서 삭제된 행. erp_hr_career_reconcile 이 표시하고, 다시 적재되면 null 로 되돌린다.';

create index if not exists hr_career_s_emp_idx    on erp_ro.hr_career_s (emp_no, career_start);
create index if not exists hr_career_s_active_idx on erp_ro.hr_career_s (emp_no) where revoked_at is null;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. 인사마스터 보강 — 직책코드 · 마스터 인정경력 개월
-- ─────────────────────────────────────────────────────────────────────────
alter table erp_ro.hr_emp_s add column if not exists role_cd   text;
alter table erp_ro.hr_emp_s add column if not exists career_mm integer;
comment on column erp_ro.hr_emp_s.role_cd is
  '직책 코드(HAA010T.ROLE_CD) — 이름은 erp_ro.sys_code_s major H0026. 직위(roll_pstn)는 H0002, 입사구분(entr_cd)은 H0016(1 신규·2 경력·3 재입사·4 기타).';
comment on column erp_ro.hr_emp_s.career_mm is
  '마스터 인정경력 개월(HAA010T.CAREER_MM) — hr_career_s 의 apply_yn=Y 행 인정개월 합계와 같다(실측).';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. 적재 RPC — service_role 전용 (live 4분기 보존 + hr_emp_s 열 확장 + hr_career_s 분기)
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
                                 entr_dt, retire_dt, entr_cd, grw_id, role_cd, career_mm,
                                 src_updated, synced_at, batch_id)
    select x.emp_no, x.emp_nm, x.dept_cd, x.dept_nm, x.roll_pstn, x.email,
           x.entr_dt, x.retire_dt, x.entr_cd, x.grw_id, x.role_cd, x.career_mm,
           x.src_updated, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(emp_no text, emp_nm text, dept_cd text, dept_nm text,
                                         roll_pstn text, email text, entr_dt date, retire_dt date,
                                         entr_cd text, grw_id text, role_cd text, career_mm integer,
                                         src_updated timestamptz, batch_id uuid)
    on conflict (emp_no) do update
      set emp_nm = excluded.emp_nm, dept_cd = excluded.dept_cd, dept_nm = excluded.dept_nm,
          roll_pstn = excluded.roll_pstn, email = excluded.email,
          entr_dt = excluded.entr_dt, retire_dt = excluded.retire_dt,
          entr_cd = excluded.entr_cd, grw_id = excluded.grw_id,
          role_cd = excluded.role_cd, career_mm = excluded.career_mm,
          src_updated = excluded.src_updated, synced_at = excluded.synced_at,
          batch_id = excluded.batch_id;

  elsif p_table = 'hr_career_s' then
    insert into erp_ro.hr_career_s (emp_no, career_start, career_end, comp_nm, roll_pstn, func_nm,
                                    career_yy, career_mm, apply_yn, src_updated, synced_at, batch_id)
    select btrim(x.emp_no), x.career_start, x.career_end, x.comp_nm, x.roll_pstn, x.func_nm,
           x.career_yy, x.career_mm, x.apply_yn, x.src_updated, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(emp_no text, career_start date, career_end date,
                                         comp_nm text, roll_pstn text, func_nm text,
                                         career_yy integer, career_mm integer, apply_yn text,
                                         src_updated timestamptz, batch_id uuid)
    where x.emp_no is not null and x.career_start is not null and x.career_end is not null
    on conflict (emp_no, career_start, career_end) do update
      set comp_nm = excluded.comp_nm, roll_pstn = excluded.roll_pstn, func_nm = excluded.func_nm,
          career_yy = excluded.career_yy, career_mm = excluded.career_mm, apply_yn = excluded.apply_yn,
          src_updated = excluded.src_updated, synced_at = excluded.synced_at,
          batch_id = excluded.batch_id, revoked_at = null;

  elsif p_table = 'usr_role_s' then
    insert into erp_ro.usr_role_s (email, role_id, role_nm, synced_at, batch_id)
    select lower(trim(x.email)), x.role_id, x.role_nm, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(email text, role_id text, role_nm text, batch_id uuid)
    on conflict (email, role_id) do update
      set role_nm = excluded.role_nm, synced_at = excluded.synced_at, batch_id = excluded.batch_id,
          revoked_at = null;

  elsif p_table = 'menu_master_s' then
    insert into erp_ro.menu_master_s (mnu_id, mnu_type, mnu_nm, upper_mnu_id, mnu_seq, sys_lvl,
                                      synced_at, batch_id)
    select btrim(x.mnu_id), btrim(x.mnu_type), x.mnu_nm, nullif(btrim(coalesce(x.upper_mnu_id,'')), ''),
           nullif(btrim(coalesce(x.mnu_seq,'')), ''), x.sys_lvl, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(mnu_id text, mnu_type text, mnu_nm text, upper_mnu_id text,
                                         mnu_seq text, sys_lvl text, batch_id uuid)
    on conflict (mnu_id, mnu_type) do update
      set mnu_nm = excluded.mnu_nm, upper_mnu_id = excluded.upper_mnu_id,
          mnu_seq = excluded.mnu_seq, sys_lvl = excluded.sys_lvl,
          synced_at = excluded.synced_at, batch_id = excluded.batch_id, revoked_at = null;

  elsif p_table = 'role_menu_s' then
    insert into erp_ro.role_menu_s (role_id, mnu_id, mnu_type, action_id, module_initial,
                                    synced_at, batch_id)
    select btrim(x.role_id), btrim(x.mnu_id), btrim(x.mnu_type),
           nullif(btrim(coalesce(x.action_id,'')), ''),
           nullif(btrim(coalesce(x.module_initial,'')), ''), now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(role_id text, mnu_id text, mnu_type text,
                                         action_id text, module_initial text, batch_id uuid)
    on conflict (role_id, mnu_id, mnu_type) do update
      set action_id = excluded.action_id, module_initial = excluded.module_initial,
          synced_at = excluded.synced_at, batch_id = excluded.batch_id, revoked_at = null;

  else
    raise exception '허용되지 않은 테이블: %', p_table;
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

comment on function public.erp_identity_upsert(text, jsonb) is
  '계정·인사·권한 미러 적재(hr_emp_s·hr_career_s·usr_role_s·menu_master_s·role_menu_s) — service_role 전용. '
  'hr_emp_s 는 role_cd·career_mm 포함(REQ-0120). 기존 erp_master_upsert 재작성 위험을 피해 분리 신설(erp_secure_upsert 선례).';

revoke all on function public.erp_identity_upsert(text, jsonb) from public, anon, authenticated;
grant execute on function public.erp_identity_upsert(text, jsonb) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. 정합 RPC — 이번 배치가 덮지 않은 행을 revoked_at 표시 (erp_menu_reconcile 과 같은 규약)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.erp_hr_career_reconcile(p_table text, p_batch_id uuid, p_min_rows integer default 100)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare v_seen integer := 0; v_off integer := 0;
begin
  if p_batch_id is null then
    raise exception 'batch_id 가 필요합니다 — 전건 회수 표시를 막기 위해 거부합니다';
  end if;
  if p_table <> 'hr_career_s' then
    raise exception '허용되지 않은 테이블: %', p_table;
  end if;
  select count(*) into v_seen from erp_ro.hr_career_s where batch_id = p_batch_id;
  if v_seen < p_min_rows then
    raise exception '이번 배치가 덮은 행이 %건뿐입니다 — 부분 적재로 보여 거부합니다', v_seen;
  end if;
  update erp_ro.hr_career_s set revoked_at = now()
   where revoked_at is null and batch_id is distinct from p_batch_id;
  get diagnostics v_off = row_count;
  return jsonb_build_object('table', p_table, 'seen', v_seen, 'revoked', v_off);
end $$;

comment on function public.erp_hr_career_reconcile(text, uuid, integer) is
  '경력 미러 배치 정합 — 이번 배치가 안 덮은 행 = ERP 에서 지워진 행 → revoked_at. 물리 삭제 없음. '
  'min_rows 미만이면 부분 적재로 보고 거부(전건 회수 방지). REQ-0120.';

revoke all on function public.erp_hr_career_reconcile(text, uuid, integer) from public, anon, authenticated;
grant execute on function public.erp_hr_career_reconcile(text, uuid, integer) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. 조회 RPC — 유일한 읽기 경로 (service_role · payroll 모듈 권한자 · 전체관리자)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.hr_career_get(p_emp_no text default null,
                                                p_q text default null,
                                                p_include_revoked boolean default false)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
with ok as (
  select case
           when coalesce(auth.jwt() ->> 'role', '') = 'service_role' then true
           when public.is_internal() then public.perm_can(null, 'erp_module', 'payroll')
           else false
         end as allowed
),
q as (
  select nullif(btrim(coalesce(p_emp_no, '')), '') as emp_no,
         nullif(btrim(coalesce(p_q, '')), '')      as q
),
emp as (     -- 경력이 있는 사람만 · 마스터가 없는 사번(사번 변경 건)도 보인다
  select c.emp_no,
         m.emp_nm, m.dept_cd, m.dept_nm, m.entr_dt, m.retire_dt,
         case when m.emp_no is null then '마스터없음'
              when m.retire_dt is null or m.retire_dt > current_date then '재직'
              else '퇴직' end as status,
         m.roll_pstn as roll_pstn_cd, p.minor_nm as roll_pstn_nm,
         m.role_cd,                  r.minor_nm as role_nm,
         m.entr_cd,                  e.minor_nm as entr_nm,
         m.career_mm as master_career_mm,
         count(*) filter (where c.revoked_at is null) as career_cnt
    from erp_ro.hr_career_s c
    left join erp_ro.hr_emp_s   m on m.emp_no = c.emp_no
    left join erp_ro.sys_code_s p on p.major_cd = 'H0002' and p.minor_cd = m.roll_pstn
    left join erp_ro.sys_code_s r on r.major_cd = 'H0026' and r.minor_cd = m.role_cd
    left join erp_ro.sys_code_s e on e.major_cd = 'H0016' and e.minor_cd = m.entr_cd
   group by c.emp_no, m.emp_no, m.emp_nm, m.dept_cd, m.dept_nm, m.entr_dt, m.retire_dt,
            m.roll_pstn, p.minor_nm, m.role_cd, r.minor_nm, m.entr_cd, e.minor_nm, m.career_mm
),
pick as (
  select emp.* from emp, q
   where (q.emp_no is null or emp.emp_no = q.emp_no)
     and (q.q is null or emp.emp_nm ilike '%' || q.q || '%' or emp.dept_nm ilike '%' || q.q || '%')
),
rows_ as (
  select jsonb_build_object(
           'emp_no', pk.emp_no, 'emp_nm', pk.emp_nm, 'dept_cd', pk.dept_cd, 'dept_nm', pk.dept_nm,
           'status', pk.status, 'entr_dt', pk.entr_dt, 'retire_dt', pk.retire_dt,
           'roll_pstn', coalesce(pk.roll_pstn_nm, pk.roll_pstn_cd), 'role_nm', coalesce(pk.role_nm, pk.role_cd),
           'entr_nm', coalesce(pk.entr_nm, pk.entr_cd), 'master_career_mm', pk.master_career_mm,
           'career_cnt', pk.career_cnt,
           'careers', (select coalesce(jsonb_agg(jsonb_build_object(
                          'comp_nm', c.comp_nm, 'career_start', c.career_start, 'career_end', c.career_end,
                          'roll_pstn', c.roll_pstn, 'func_nm', c.func_nm,
                          'career_yy', c.career_yy, 'career_mm', c.career_mm, 'apply_yn', c.apply_yn,
                          'revoked_at', c.revoked_at) order by c.career_start, c.career_end), '[]'::jsonb)
                         from erp_ro.hr_career_s c
                        where c.emp_no = pk.emp_no and (p_include_revoked or c.revoked_at is null))
         ) as j, pk.emp_nm, pk.emp_no
    from pick pk
)
select jsonb_build_object(
         'allowed', ok.allowed,
         'as_of',   (select max(synced_at) from erp_ro.hr_career_s),
         'count',   case when ok.allowed then (select count(*) from rows_) else 0 end,
         'rows',    case when ok.allowed
                         then coalesce((select jsonb_agg(j order by emp_nm, emp_no) from rows_), '[]'::jsonb)
                         else '[]'::jsonb end)
  from ok
$$;

comment on function public.hr_career_get(text, text, boolean) is
  'ERP 경력정보 조회(유일한 읽기 경로). 허용: service_role(게이트웨이 — 자기 검사 필수) 또는 사내 사용자 중 '
  'ERP 모듈 payroll 권한자(인사팀·전체관리자 — perm_can). 그 밖은 allowed:false·빈 목록. '
  '마스터 이름·부서·재직·직위/직책/입사구분(종합코드 H0002/H0026/H0016)·인정경력 + 경력 행. REQ-0120.';

revoke all on function public.hr_career_get(text, text, boolean) from public, anon;
grant execute on function public.hr_career_get(text, text, boolean) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. RLS 전면차단 + 권한 회수 (hr_emp_s 와 동일 — 정책 0개)
-- ─────────────────────────────────────────────────────────────────────────
alter table erp_ro.hr_career_s enable row level security;
revoke all on erp_ro.hr_career_s from anon, authenticated;
grant select, insert, update, delete on erp_ro.hr_career_s to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. ETL(확정 · etl_run.py)
--   job `hr_emp`    : SELECT 에 ROLE_CD AS role_cd, TRY_CONVERT(int, CAREER_MM) AS career_mm 추가(전량 upsert — 다음 회차에 채워진다).
--   job `hr_career` : HAA050T 전량(EMP_NO·COMP_NM·CAREER_START/END(date)·ROLL_PSTN·FUNC_NM·CAREER_YY/MM(int)·APPLY_YN·UPDT_DT),
--                     rpc=erp_identity_upsert, reconcile mode=batch rpc=erp_hr_career_reconcile min_rows=100.
--   job `sys_code`  : IN ('P1001','H0002','H0016','H0026').
--   ⚠ 추출 SQL 이 바뀌므로 EXE 재빌드(r1.13) + 3경로(§17.5). 신규 표는 전량 스냅샷이라 --full 백필은 필요 없다.
