-- 21_gl_draft.sql — 결의전표 초안(포털) + 회계 코드 마스터 미러
-- 적용일 2026-07-31 · Supabase 마이그레이션: gl_draft_v1
-- 설계 정본: 계획 「결의전표 입력 기능 — 사내 운영페이지 파일럿」
-- 원천(읽기 전용): JEILMNS.dbo.A_ACCT(계정과목) · JEILMNS.dbo.B_COST_CENTER(코스트센터)
--
-- 배경 — 무엇을 만들고 무엇을 만들지 않는가 (CLAUDE.md §1.2·§1.6)
--   · 포털은 ERP에 쓰지 않는다. 이 스키마는 "ERP 결의전표(A_TEMP_GL)에 그대로 옮겨 담을 수 있는
--     검증된 초안"까지만 보관한다. ERP 최종 저장은 회계 담당자가 ERP 화면에서 수행한다.
--   · ERP 확정 후 담당자가 TEMP_GL_NO 를 되돌려 기입(erp_temp_gl_no)해야 초안이 닫힌다.
--     이 회기입이 이중 입력을 막는 유일한 장치다 — 선택 절차로 만들지 말 것.
--   · 전표번호는 ERP가 채번한다. 포털은 'DRAFT-' 접두 임시번호만 쓴다(충돌 방지).
--
-- 보안: 회계는 민감 등급이다. chat_*/erp_load_scope 패턴 계승 —
--   RLS 켜고 정책 0개 + anon/authenticated 회수 → Edge Function(service_role) 단일 경로.
--   v_erp_* 같은 뷰 직접 노출을 하지 않는다(금액이 담기는 첫 포털 쓰기 기능).

-- ═══════════════════════════════════════════════════════════════════════
-- 1) 회계 코드 마스터 미러 (erp_ro) — 금액 아님, 코드만
-- ═══════════════════════════════════════════════════════════════════════
-- ⚠ 회계(A 모듈) 첫 개방. 전표·분개 라인(A_GL_ITEM·A_TEMP_GL_ITEM)은 적재 대상이 아니다.

create table if not exists erp_ro.acct_master_s (
  acct_cd       text primary key,          -- 계정코드
  acct_nm       text,                      -- 계정단명(화면 표시)
  acct_full_nm  text,                      -- 계정명(전체)
  gp_cd         text,                      -- 계정그룹
  acct_seq      integer,                   -- 계정순서(표시 정렬)
  bal_fg        text,                      -- 차대구분 — 입력 보조(기본 차/대변 제안)
  bs_pl_fg      text,                      -- 손익/재무상태 구분
  acct_type     text,
  project_fg    text,                      -- 'Y'면 프로젝트 필수 → 화면 검증 규칙에 사용
  mgnt_fg       text,                      -- 미결관리 여부
  mgnt_type     text,
  use_yn        boolean not null default true,   -- DEL_FG<>'Y'
  src_updated   timestamptz,
  synced_at     timestamptz not null default now(),
  batch_id      uuid
);
comment on table erp_ro.acct_master_s is 'ERP 계정과목 마스터 미러(A_ACCT, DEL_FG<>Y) — 결의전표 초안 입력화면의 계정 선택지. 코드 마스터만, 잔액·전표 아님.';

create table if not exists erp_ro.cost_center_s (
  cost_cd       text primary key,
  cost_nm       text,
  org_change_id text not null default '',
  dept_cd       text,                      -- 부서 연동 필터에 사용
  biz_area_cd   text,
  biz_unit_cd   text,
  cost_type     text,
  di_fg         text,                      -- 직간접구분
  plant_cd      text,
  src_updated   timestamptz,
  synced_at     timestamptz not null default now(),
  batch_id      uuid
);
comment on table erp_ro.cost_center_s is 'ERP 코스트센터 마스터 미러(B_COST_CENTER) — 결의전표 헤더·라인 선택지.';

create index if not exists cost_center_s_dept_idx on erp_ro.cost_center_s (dept_cd);
create index if not exists acct_master_s_nm_idx  on erp_ro.acct_master_s (acct_nm);

alter table erp_ro.acct_master_s enable row level security;
alter table erp_ro.cost_center_s enable row level security;
revoke all on erp_ro.acct_master_s, erp_ro.cost_center_s from anon, authenticated;
grant select on erp_ro.acct_master_s, erp_ro.cost_center_s to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 2) 마스터 전용 적재 RPC (service_role) — 기존 erp_etl_upsert 를 건드리지 않는다
-- ═══════════════════════════════════════════════════════════════════════
-- hr_payroll 이 erp_secure_upsert 를 쓰는 선례와 동일한 분리. etl_run.py 의 job spec 에서
-- "rpc": "erp_master_upsert" 로 지정한다.
create or replace function public.erp_master_upsert(p_table text, p_rows jsonb)
  returns integer
  language plpgsql
  security definer
  set search_path to ''
as $function$
declare n integer := 0;
begin
  if p_table = 'acct_master_s' then
    insert into erp_ro.acct_master_s (acct_cd, acct_nm, acct_full_nm, gp_cd, acct_seq,
                                      bal_fg, bs_pl_fg, acct_type, project_fg, mgnt_fg, mgnt_type,
                                      use_yn, src_updated, synced_at, batch_id)
    select x.acct_cd, x.acct_nm, x.acct_full_nm, x.gp_cd, x.acct_seq,
           x.bal_fg, x.bs_pl_fg, x.acct_type, x.project_fg, x.mgnt_fg, x.mgnt_type,
           coalesce(x.use_yn, true), x.src_updated, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(acct_cd text, acct_nm text, acct_full_nm text, gp_cd text,
                                         acct_seq integer, bal_fg text, bs_pl_fg text, acct_type text,
                                         project_fg text, mgnt_fg text, mgnt_type text,
                                         use_yn boolean, src_updated timestamptz, batch_id uuid)
    on conflict (acct_cd) do update
      set acct_nm = excluded.acct_nm, acct_full_nm = excluded.acct_full_nm, gp_cd = excluded.gp_cd,
          acct_seq = excluded.acct_seq, bal_fg = excluded.bal_fg, bs_pl_fg = excluded.bs_pl_fg,
          acct_type = excluded.acct_type, project_fg = excluded.project_fg,
          mgnt_fg = excluded.mgnt_fg, mgnt_type = excluded.mgnt_type, use_yn = excluded.use_yn,
          synced_at = excluded.synced_at, src_updated = excluded.src_updated, batch_id = excluded.batch_id;
  elsif p_table = 'cost_center_s' then
    insert into erp_ro.cost_center_s (cost_cd, cost_nm, org_change_id, dept_cd, biz_area_cd,
                                      biz_unit_cd, cost_type, di_fg, plant_cd, src_updated, synced_at, batch_id)
    select x.cost_cd, x.cost_nm, coalesce(x.org_change_id, ''), x.dept_cd, x.biz_area_cd,
           x.biz_unit_cd, x.cost_type, x.di_fg, x.plant_cd, x.src_updated, now(), x.batch_id
    from jsonb_to_recordset(p_rows) as x(cost_cd text, cost_nm text, org_change_id text, dept_cd text,
                                         biz_area_cd text, biz_unit_cd text, cost_type text, di_fg text,
                                         plant_cd text, src_updated timestamptz, batch_id uuid)
    on conflict (cost_cd) do update
      set cost_nm = excluded.cost_nm, org_change_id = excluded.org_change_id, dept_cd = excluded.dept_cd,
          biz_area_cd = excluded.biz_area_cd, biz_unit_cd = excluded.biz_unit_cd,
          cost_type = excluded.cost_type, di_fg = excluded.di_fg, plant_cd = excluded.plant_cd,
          synced_at = excluded.synced_at, src_updated = excluded.src_updated, batch_id = excluded.batch_id;
  else
    raise exception '허용되지 않은 테이블: %', p_table;
  end if;
  get diagnostics n = row_count;
  return n;
end $function$;

revoke all on function public.erp_master_upsert(text, jsonb) from public, anon, authenticated;
grant execute on function public.erp_master_upsert(text, jsonb) to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 3) 결의전표 초안 (public, Edge Function 전용)
-- ═══════════════════════════════════════════════════════════════════════

create sequence if not exists public.gl_draft_seq;

create table if not exists public.gl_draft (
  id               bigserial primary key,
  draft_no         text not null unique
                   default 'DRAFT-' || to_char((now() at time zone 'Asia/Seoul'), 'YYYYMMDD')
                                    || '-' || lpad(nextval('public.gl_draft_seq')::text, 4, '0'),
  -- 헤더 (A_TEMP_GL 대응)
  draft_dt         date not null,                 -- 결의일자 → TEMP_GL_DT
  gl_type          text,                          -- 전표형태 → GL_TYPE (실코드는 A2 샘플 확인 후 확정)
  dept_cd          text,                          -- 부서 → DEPT_CD
  dept_nm          text,                          -- 표시용 사본(ERP 코드 변경 대비)
  cost_cd          text,                          -- 코스트센터 → COST_CD
  gl_desc          text not null,                 -- 적요 → TEMP_GL_DESC (200자)
  project_no       text,                          -- 프로젝트 → PROJECT_NO
  ref_no           text,                          -- 참조번호 → REF_NO (그룹웨어 결재 문서번호 기입용)
  -- 등록자 — 반드시 서버가 JWT UPN 에서 채운다. 화면 입력값을 신뢰하지 않는다.
  owner_upn        text not null,                 -- MS 계정(UPN)
  owner_erp_usr_id text not null,                 -- ERP USR_ID (usr_master_s 매핑 결과) → INSRT_USER_ID
  owner_nm         text,
  -- 합계 (서버가 라인에서 재계산해 저장 — 화면 값 신뢰 안 함)
  dr_total         numeric not null default 0,
  cr_total         numeric not null default 0,
  -- 상태
  status           text not null default 'draft'
                   check (status in ('draft','submitted','posted','void')),
  erp_temp_gl_no   text,                          -- ERP 확정 후 회기입(A_TEMP_GL.TEMP_GL_NO) — 이중입력 방지 장치
  posted_by        text,
  posted_at        timestamptz,
  submitted_at     timestamptz,
  void_reason      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- posted 는 반드시 ERP 전표번호를 동반한다(상태만 닫고 번호를 빠뜨리는 것을 DB가 막는다)
  constraint gl_draft_posted_needs_no check (status <> 'posted' or erp_temp_gl_no is not null)
);
comment on table public.gl_draft is '결의전표 초안 헤더(포털). ERP A_TEMP_GL 에 사람이 옮겨 담는 원본 — 포털은 ERP에 쓰지 않는다.';

create index if not exists gl_draft_owner_idx  on public.gl_draft (owner_upn, created_at desc);
create index if not exists gl_draft_status_idx on public.gl_draft (status, created_at desc);

create table if not exists public.gl_draft_item (
  draft_no     text not null references public.gl_draft(draft_no) on delete cascade,
  item_seq     smallint not null,                 -- → ITEM_SEQ
  dr_cr_fg     text not null check (dr_cr_fg in ('D','C')),   -- 차변/대변 → DR_CR_FG
  acct_cd      text not null,                     -- 계정코드 → ACCT_CD
  acct_nm      text,                              -- 표시용 사본
  item_amt     numeric not null check (item_amt > 0),         -- 금액 → ITEM_AMT / ITEM_LOC_AMT
  item_desc    text,                              -- 적요 → ITEM_DESC
  bp_cd        text,                              -- 거래처 → BP_CD
  bp_nm        text,
  cost_cd      text,                              -- 코스트센터 → COST_CD
  project_no   text,                              -- 프로젝트 → PROJECT_NO
  vat_type     text,                              -- 부가세유형 → VAT_TYPE
  vat_amt      numeric,
  primary key (draft_no, item_seq)
);
comment on table public.gl_draft_item is '결의전표 초안 라인(포털). ERP A_TEMP_GL_ITEM 대응. 통화/환율은 KRW/1 고정이라 저장하지 않는다.';

-- 감사 로그 — jeil-hr 의 hr_access_log 패턴. 금액이 담기는 첫 포털 쓰기 기능이므로 전 접근 기록.
create table if not exists public.gl_draft_log (
  id         bigserial primary key,
  draft_no   text,
  actor_upn  text not null,
  action     text not null,          -- bootstrap|save|submit|list|view|post|void|denied
  detail     jsonb,
  created_at timestamptz not null default now()
);
create index if not exists gl_draft_log_time_idx on public.gl_draft_log (created_at desc);

-- 회계기간 마감 — 잠긴 월(YYYY-MM)에는 결의일자를 넣을 수 없다.
-- 비어 있으면 제한 없음(A5에서 마감 기준 확정 전까지의 안전한 기본값).
create table if not exists public.gl_period_lock (
  ym         text primary key,       -- 'YYYY-MM'
  locked     boolean not null default true,
  note       text,
  updated_at timestamptz not null default now()
);

alter table public.gl_draft       enable row level security;
alter table public.gl_draft_item  enable row level security;
alter table public.gl_draft_log   enable row level security;
alter table public.gl_period_lock enable row level security;
revoke all on public.gl_draft, public.gl_draft_item, public.gl_draft_log, public.gl_period_lock
  from anon, authenticated;

-- 정책은 만들지 않는다(정책 0개 = 전면 차단). 접근 경로는 Edge Function jeil-gl-draft(service_role) 뿐.

-- ═══════════════════════════════════════════════════════════════════════
-- 4) 롤백 (필요 시)
-- ═══════════════════════════════════════════════════════════════════════
-- drop table if exists public.gl_draft_item, public.gl_draft_log, public.gl_period_lock;
-- drop table if exists public.gl_draft;  drop sequence if exists public.gl_draft_seq;
-- drop function if exists public.erp_master_upsert(text, jsonb);
-- drop table if exists erp_ro.acct_master_s, erp_ro.cost_center_s;
