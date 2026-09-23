-- 68_pur_proposal_ledger.sql
-- 구매 기안서 대장 — 중간DB 적재 테이블·뷰·적재 RPC (2026-09-23 · REQ-0077 2단계)
--
-- 배경: 화면(`/work/purchase-proposals`)이 정적 시드(관리대상 169건)로 떠 있다.
--       원천은 ERP 가 아니라 **구매팀 Teams 엑셀 대장**이므로 ERP ETL(erp_ro)이 아니라
--       **포털 전용 데이터**(CLAUDE.md §4.3)로 `public` 에 둔다. 러너가 엑셀을 읽어 여기에 적재하고,
--       화면은 뷰를 조회한다 → 정적 HTML 에 실데이터를 박아 둘 이유가 사라진다.
--
-- 저장 단위: **엑셀 행 그대로**(1,102행). 건(830건) 집계는 뷰가 한다.
--   한 기안(권-번호)이 업체·품목별로 여러 행으로 쪼개져 있어, 행을 버리면 전표·금액 대사를 못 한다.
--
-- ⚠ 통화(currency): 현 대장에 **칸이 없다**. 원화·EUR·CNY 가 금액 한 칸에 섞여 있다.
--   추정해서 채우지 않는다 — 컬럼만 만들어 두고 대장에 칸이 생기면 그때 채운다.
--
-- 되돌리기: 68_pur_proposal_ledger_rollback.sql

-- ── 1. 대장 행 ────────────────────────────────────────────────────────────────
create table if not exists public.pur_proposal (
  vol           smallint     not null,              -- 권(물리 바인더 · 100건 묶음)
  no            integer      not null,              -- 번호(연간 연속 채번)
  seq           smallint     not null,              -- 같은 건 안에서의 행 순번(1..n)
  draft_dt      date,                               -- 기안일
  draft_dt_raw  text,                               -- 기안일 원문(문자열 혼입 행 보존)
  drafter       text,                               -- 기안자(성명 표기 가능 · §1.7)
  job_no        text,                               -- 생산번호(Job No)
  project       text,                               -- 프로젝트 원문(`고객사_프로젝트명`)
  customer      text,                               -- 고객사(표기 정규화 결과)
  content       text,                               -- 내용
  vendor        text,                               -- 업체명
  amt           numeric(18,2),                      -- 금액(숫자로 읽힌 값)
  amt_raw       text,                               -- 금액 원문(`매월 ₩1,936,000` `무상` `CNY 532,000`)
  currency      text,                               -- 통화 — 대장에 칸이 없어 현재는 항상 null
  closed_yn     text,                               -- 종결여부 Y/N
  remark        text,                               -- 비고(결제조건 메모)
  memo          text,                               -- A열 자유 메모(건 간 참조)
  dp_rate numeric(9,6), dp_amt numeric(18,2), dp_slip text, dp_dt date,   -- 계약금
  mp_rate numeric(9,6), mp_amt numeric(18,2), mp_slip text, mp_dt date,   -- 중도금
  bp_rate numeric(9,6), bp_amt numeric(18,2), bp_slip text, bp_dt date,   -- 잔금
  src_row       integer,                            -- 엑셀 행번호(추적용)
  src_updated   timestamptz,                        -- 대장 파일 최종수정 시각
  updated_at    timestamptz  not null default now(),
  primary key (vol, no, seq)
);

comment on table public.pur_proposal is
  '구매 기안서 목록대장(Teams 엑셀) 미러 — 엑셀 행 단위. 러너 jeil_runner proposal 이 적재, 건 집계는 v_pur_proposal_case. REQ-0077';
comment on column public.pur_proposal.currency is
  '대장에 통화 칸이 없어 현재는 항상 null. 추정 금지 — 칸이 생기면 채운다';

create index if not exists ix_pur_proposal_dt     on public.pur_proposal (draft_dt);
create index if not exists ix_pur_proposal_closed on public.pur_proposal (closed_yn);

-- ── 2. 스캔본 대사 결과 ───────────────────────────────────────────────────────
-- 문서중앙화(보호 영역) 파일 목록은 대화형 세션에서만 읽힌다 → 러너가 아니라 사람이 뽑은
-- 목록(CSV)을 넣는다. 파일 자체는 담지 않는다(반출은 별도 승인 사안).
create table if not exists public.pur_proposal_scan (
  vol         smallint    not null,
  no          integer     not null,
  file_name   text,                                  -- `{권}-{번호}.pdf`
  size_kb     integer,
  file_mtime  timestamptz,
  matched     boolean     not null default false,
  checked_at  timestamptz not null default now(),
  primary key (vol, no)
);

comment on table public.pur_proposal_scan is
  '기안서 스캔본 존재 대사 결과 — 경로·파일은 담지 않고 존재/크기/수정일만. 검색어는 화면이 `system.filename:{권}-{번호}.pdf` 로 만든다';

-- ── 3. RLS — 사내 사용자만 조회, 쓰기는 service_role(러너)만 ──────────────────
alter table public.pur_proposal      enable row level security;
alter table public.pur_proposal_scan enable row level security;

drop policy if exists internal_select_pur_proposal      on public.pur_proposal;
drop policy if exists internal_select_pur_proposal_scan on public.pur_proposal_scan;

-- 괄호 위치 주의: `(select 조건)` 이어야 InitPlan 으로 한 번만 계산된다(REQ-0040 실측).
create policy internal_select_pur_proposal on public.pur_proposal
  for select to authenticated
  using ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'));

create policy internal_select_pur_proposal_scan on public.pur_proposal_scan
  for select to authenticated
  using ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'));

grant select on public.pur_proposal, public.pur_proposal_scan to authenticated;
grant all    on public.pur_proposal, public.pur_proposal_scan to service_role;

-- ── 4. 건(권-번호) 단위 뷰 — 화면이 조회하는 것 ───────────────────────────────
create or replace view public.v_pur_proposal_case with (security_invoker = true) as
with l as (
  select p.*, row_number() over (partition by vol, no order by seq) as rn,
         (p.dp_slip is null and p.mp_slip is null and p.bp_slip is null) as no_slip
    from public.pur_proposal p
)
select
  l.vol, l.no, (l.vol || '-' || l.no)                       as key,
  min(l.draft_dt)                                            as draft_dt,
  max(l.draft_dt_raw) filter (where l.draft_dt is null)      as draft_dt_raw,
  max(l.drafter)      filter (where l.rn = 1)                as drafter,
  max(l.job_no)       filter (where l.rn = 1)                as job_no,
  max(l.project)      filter (where l.rn = 1)                as project,
  max(l.customer)     filter (where l.rn = 1)                as customer,
  max(l.content)      filter (where l.rn = 1)                as content,
  max(l.vendor)       filter (where l.rn = 1)                as vendor,
  sum(l.amt)                                                 as amt,
  string_agg(l.amt_raw, ' · ') filter (where l.amt_raw is not null) as amt_raw,
  count(*)::int                                              as lines,
  count(*) filter (where l.no_slip)::int                     as no_slip_lines,
  case when bool_and(l.closed_yn = 'Y') then 'Y'
       when bool_and(l.closed_yn = 'N') then 'N'
       else 'P' end                                          as closed,           -- P = 부분종결
  coalesce(bool_or(s.matched), false)                        as scan_ok,
  max(l.src_updated)                                         as src_updated
from l
left join public.pur_proposal_scan s on s.vol = l.vol and s.no = l.no
group by l.vol, l.no;

comment on view public.v_pur_proposal_case is
  '기안서 대장 건 단위(권-번호) 집계 — 1,102행 → 830건. 화면 /work/purchase-proposals 가 이것만 조회한다';

grant select on public.v_pur_proposal_case to authenticated, service_role;

-- ── 5. 데이터 품질 카운트 — 화면 품질표가 쓰는 한 줄 ──────────────────────────
-- 뷰 컬럼이 늘면 create or replace 가 막힌다(42P16) → drop 후 재생성한다.
drop view if exists public.v_pur_proposal_quality;

create view public.v_pur_proposal_quality with (security_invoker = true) as
with lead_slip as (   -- 기안 → 잔금 전표 발행
  select (bp_dt - draft_dt) as d from public.pur_proposal
   where bp_dt is not null and draft_dt is not null
), lead_scan as (     -- 기안 → 스캔본 반영(건 단위)
  select (s.file_mtime::date - p.draft_dt) as d
    from public.pur_proposal p
    join public.pur_proposal_scan s on s.vol = p.vol and s.no = p.no
   where p.seq = 1 and s.matched and s.file_mtime is not null and p.draft_dt is not null
)
select
  count(*)::int                                                          as lines,
  count(distinct (vol, no))::int                                         as cases,
  count(*) filter (where draft_dt is null and draft_dt_raw is not null)::int as date_str,
  count(*) filter (where amt_raw is not null)::int                       as amt_str,
  count(*) filter (where amt < 0)::int                                   as amt_neg,
  count(*) filter (where coalesce(project, '') = '')::int                as proj_blank,
  count(distinct split_part(coalesce(project, ''), '_', 1))::int         as cust_variants,
  count(*) filter (where memo is not null)::int                          as memo,
  -- 전표번호 앞뒤 공백·탭: **행 수**다(한 행에 여러 칸이 오염됐어도 1). 값 기준이 아니다.
  (select count(*) from public.pur_proposal
     where coalesce(dp_slip,'') <> btrim(coalesce(dp_slip,''))
        or coalesce(mp_slip,'') <> btrim(coalesce(mp_slip,''))
        or coalesce(bp_slip,'') <> btrim(coalesce(bp_slip,'')))::int      as slip_dirty,
  (select count(*) from public.pur_proposal where btrim(bp_slip) like 'TG%'
      or btrim(dp_slip) like 'TG%' or btrim(mp_slip) like 'TG%')::int     as slip_tg,
  (select count(*) from public.pur_proposal where btrim(bp_slip) like 'IV%'
      or btrim(dp_slip) like 'IV%' or btrim(mp_slip) like 'IV%')::int     as slip_iv,
  (select count(*) from lead_slip)::int                                   as lead_n,
  (select percentile_cont(0.5) within group (order by d) from lead_slip)::int  as lead_med,
  (select percentile_cont(0.9) within group (order by d) from lead_slip)::int  as lead_p90,
  (select count(*) from lead_slip where d < 0)::int                       as lead_neg,
  (select percentile_cont(0.5) within group (order by d) from lead_scan)::int as scan_med,
  (select percentile_cont(0.9) within group (order by d) from lead_scan)::int as scan_p90,
  max(src_updated)                                                       as src_updated,
  max(updated_at)                                                        as loaded_at
from public.pur_proposal;

grant select on public.v_pur_proposal_quality to authenticated, service_role;

-- ── 6. 적재 RPC — 러너(service_role)가 부른다 ─────────────────────────────────
-- ERP ETL 의 erp_etl_upsert 계열과 같은 모양(p_table 대신 고정 테이블). 전량 교체가 기본이다:
-- 대장은 행이 사라지기도 해서(행 병합·삭제) 증분만 하면 미러에 유령 행이 남는다.
create or replace function public.pur_proposal_upsert(p_rows jsonb, p_replace boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer := 0;
begin
  if p_replace then
    -- where true: Supabase 는 WHERE 없는 DELETE 를 막는다(21000 DELETE requires a WHERE clause)
    delete from public.pur_proposal where true;      -- 전량 교체(러너 기본값)
  end if;

  insert into public.pur_proposal (
    vol, no, seq, draft_dt, draft_dt_raw, drafter, job_no, project, customer,
    content, vendor, amt, amt_raw, currency, closed_yn, remark, memo,
    dp_rate, dp_amt, dp_slip, dp_dt, mp_rate, mp_amt, mp_slip, mp_dt,
    bp_rate, bp_amt, bp_slip, bp_dt, src_row, src_updated, updated_at)
  select
    (r->>'vol')::smallint, (r->>'no')::integer, (r->>'seq')::smallint,
    nullif(r->>'draft_dt','')::date, nullif(r->>'draft_dt_raw',''),
    nullif(r->>'drafter',''), nullif(r->>'job_no',''), nullif(r->>'project',''),
    nullif(r->>'customer',''), nullif(r->>'content',''), nullif(r->>'vendor',''),
    nullif(r->>'amt','')::numeric, nullif(r->>'amt_raw',''), nullif(r->>'currency',''),
    nullif(r->>'closed_yn',''), nullif(r->>'remark',''), nullif(r->>'memo',''),
    nullif(r->>'dp_rate','')::numeric, nullif(r->>'dp_amt','')::numeric,
    nullif(r->>'dp_slip',''), nullif(r->>'dp_dt','')::date,
    nullif(r->>'mp_rate','')::numeric, nullif(r->>'mp_amt','')::numeric,
    nullif(r->>'mp_slip',''), nullif(r->>'mp_dt','')::date,
    nullif(r->>'bp_rate','')::numeric, nullif(r->>'bp_amt','')::numeric,
    nullif(r->>'bp_slip',''), nullif(r->>'bp_dt','')::date,
    nullif(r->>'src_row','')::integer, nullif(r->>'src_updated','')::timestamptz, now()
  from jsonb_array_elements(p_rows) as r
  on conflict (vol, no, seq) do update set
    draft_dt = excluded.draft_dt, draft_dt_raw = excluded.draft_dt_raw,
    drafter = excluded.drafter, job_no = excluded.job_no, project = excluded.project,
    customer = excluded.customer, content = excluded.content, vendor = excluded.vendor,
    amt = excluded.amt, amt_raw = excluded.amt_raw, currency = excluded.currency,
    closed_yn = excluded.closed_yn, remark = excluded.remark, memo = excluded.memo,
    dp_rate = excluded.dp_rate, dp_amt = excluded.dp_amt, dp_slip = excluded.dp_slip, dp_dt = excluded.dp_dt,
    mp_rate = excluded.mp_rate, mp_amt = excluded.mp_amt, mp_slip = excluded.mp_slip, mp_dt = excluded.mp_dt,
    bp_rate = excluded.bp_rate, bp_amt = excluded.bp_amt, bp_slip = excluded.bp_slip, bp_dt = excluded.bp_dt,
    src_row = excluded.src_row, src_updated = excluded.src_updated, updated_at = now();

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.pur_proposal_upsert(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.pur_proposal_upsert(jsonb, boolean) to service_role;

-- 스캔 대사 결과 적재(사람이 뽑은 목록 CSV → 러너)
create or replace function public.pur_proposal_scan_upsert(p_rows jsonb, p_replace boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer := 0;
begin
  if p_replace then
    delete from public.pur_proposal_scan where true;
  end if;

  insert into public.pur_proposal_scan (vol, no, file_name, size_kb, file_mtime, matched, checked_at)
  select (r->>'vol')::smallint, (r->>'no')::integer, nullif(r->>'file_name',''),
         nullif(r->>'size_kb','')::integer, nullif(r->>'file_mtime','')::timestamptz,
         coalesce((r->>'matched')::boolean, false), now()
  from jsonb_array_elements(p_rows) as r
  on conflict (vol, no) do update set
    file_name = excluded.file_name, size_kb = excluded.size_kb,
    file_mtime = excluded.file_mtime, matched = excluded.matched, checked_at = now();

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.pur_proposal_scan_upsert(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.pur_proposal_scan_upsert(jsonb, boolean) to service_role;

-- ── 확인 ─────────────────────────────────────────────────────────────────────
-- select count(*) from public.pur_proposal;                 -- 1,102행
-- select count(*) from public.v_pur_proposal_case;          -- 830건
-- select * from public.v_pur_proposal_quality;
