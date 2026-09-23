-- 70_pur_proposal_recon.sql
-- 2026-09-23 갱신(REQ-0082): 계산서 축을 **부가세 원장**(erp_ro.vat_s · SQL 73)으로 올렸다.
--   관리항목(V1/V8)은 원장에 없는 전표의 대체 경로로 남는다. 응답에 'src' 와 국세청 'nts' 가 추가됐다.
-- 구매 기안서 대장 ↔ ERP 전표·세금계산서 대사 (2026-09-23 · REQ-0081 · 결정 C-15)
--
-- 배경: 대장(`public.pur_proposal`)에는 구매팀이 손으로 적은 전표번호가 있다(`TG…` 결의전표 · `IV…` 매입).
--       그 전표가 ERP 에 실제로 있는지, 금액이 맞는지, 세금계산서가 났는지는 화면에서 알 수 없었다.
--
-- ⚠ 결정 C-15 — 이 파일이 여는 것과 열지 않는 것
--   결의전표 미러(`erp_ro.gl_slip_*`)는 `25_gl_slip_mirror.sql` 이 **service_role 전용**으로 잠가 두었고,
--   기존 RPC 는 **본인이 작성한 전표만** 돌려준다(C-10 통제 ②). 구매팀이 자금팀 전표의 분개 라인을 보려면
--   그 통제를 여는 결정이 필요하다 → **대장에 적힌 전표번호로 지목된 전표만** 열고,
--   **전표 전문 검색·목록 조회는 열지 않는다**(번호로만 들어간다). 노출 면적은 대장이 적은 499종 전표뿐이다.
--
-- ── 설계를 만든 실측 네 가지 (2026-09-23) ────────────────────────────────────
-- ① **전표칸 한 칸에 전표가 여러 개** 들어간다 — 944칸 → 977토큰, 다중 25칸(개행·슬래시·쉼표·화살표·탭).
--    `=` 비교로는 통째로 놓친다 → 구분자를 열거하지 말고 **토큰 패턴으로 뽑는다**(미파싱 0건).
-- ② **`IV…` 는 매입번호**이고, 그 매입의 결의전표는 `gl_slip_s.ref_no` 로 붙는다(AP 전표 337건 전부 ref_no=IV…).
--    → IV 를 전표로 **승격**시켜 축을 하나로 만든다. `iv_dtl_s` 는 대사 키가 아니라 품목 내역 표시용이다.
-- ③ **거래처는 전표가 확정한다** — 대장이 참조한 전표 491종 중 **490(99.8%)이 단일 거래처**.
--    업체명 매핑을 조인 키로 쓰면 이름이 안 맞을 때 「라인 없음」으로 오분류된다 → 이름은 **경고 플래그**로 강등.
-- ④ **대사 축은 전표 총액이 아니라 세금계산서 공급가액(V1)** 이다. 총액 비교는 정확일치 0건(한 전표에 여러 기안).
--
-- 적용 결과(전 944칸): 일치 575 · 합산/분할 295 · 확인필요 50 · 전표미발견 10 · 계산서없음 8 · 세액차 1 · 미기재 5
--   → **연결률 98.4%**(944 중 929). 응답 149ms.
--
-- ⚠ 채번 정정 — 커밋 `9a70e4c` 메시지의 REQ-0079 는 오기다. 그 번호는 관리체계 단일파일 전달본 세션이,
--   뒤이어 정정했던 REQ-0080 은 입고일 실입고 세션(`dd11280`·`96e52e2`)이 이미 쓰고 있었다.
--   **최종 번호는 REQ-0081**. 푸시된 커밋 메시지는 고칠 수 없어 여기와 백로그에 기록을 남긴다.
--
-- 되돌리기: 70_pur_proposal_recon_rollback.sql

-- ── 1. 업체 매핑 — 사람이 고른 것만 저장한다 ─────────────────────────────────
-- ③ 때문에 **대사 조인에는 쓰이지 않는다.** 「대장 업체명 ≠ 전표 거래처명」 경고(실측 36칸)를 사람이
-- 정리할 때 쓰는 표이고, 나중에 업체 축 집계를 붙일 때의 자리다.
create table if not exists public.pur_proposal_vendor_map (
  vendor_text   text        primary key,          -- 대장 원문 업체명
  bp_cd         text,                             -- null = 「ERP 거래처 없음」으로 사람이 확정한 상태
  note          text,
  confirmed_by  text        not null,
  confirmed_at  timestamptz not null default now()
);

comment on table public.pur_proposal_vendor_map is
  '기안서 대장 업체명 ↔ ERP 거래처(bp_cd) 수동 매핑 — 사람이 고른 것만. 자동 매칭은 v_pur_proposal_vendor 가 계산한다. REQ-0081';

alter table public.pur_proposal_vendor_map enable row level security;
drop policy if exists internal_select_vendor_map on public.pur_proposal_vendor_map;
create policy internal_select_vendor_map on public.pur_proposal_vendor_map
  for select to authenticated
  using ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'));
revoke all on public.pur_proposal_vendor_map from anon;
grant select on public.pur_proposal_vendor_map to authenticated;
grant all    on public.pur_proposal_vendor_map to service_role;

-- ── 2. 업체 매핑 뷰 — 수동 > 정확일치 > 정규화 유일일치 > (모호|없음) ────────
-- 실측 자동화율: 138종 중 정확 122 + 정규화 10 = 132(95.7%) · 모호 2 · 미매칭 4
-- (GCB · 모벤시스코리아 · 상하이TQL테크 · 케이에스테크 — 사람이 판단)
create or replace view public.v_pur_proposal_vendor with (security_invoker = true) as
with v as (
  select distinct vendor as vendor_text from public.pur_proposal where coalesce(vendor, '') <> ''
), nk as (
  select vendor_text,
         regexp_replace(regexp_replace(lower(vendor_text), '(주식회사|\(주\)|㈜|\(유\)|유한회사)', '', 'g'),
                        '[^가-힣a-z0-9]', '', 'g') as nkey
    from v
), nb as (
  select bp_cd, bp_nm,
         regexp_replace(regexp_replace(lower(bp_nm), '(주식회사|\(주\)|㈜|\(유\)|유한회사)', '', 'g'),
                        '[^가-힣a-z0-9]', '', 'g') as nkey
    from erp_ro.bp_master_s where coalesce(bp_nm, '') <> ''
), ex as (
  select nk.vendor_text, min(b.bp_cd) as bp_cd, count(distinct b.bp_cd) as cand
    from nk join erp_ro.bp_master_s b on b.bp_nm = nk.vendor_text
   group by nk.vendor_text
), nm as (
  select nk.vendor_text, min(nb.bp_cd) as bp_cd, count(distinct nb.bp_cd) as cand
    from nk left join nb on nb.nkey = nk.nkey
   group by nk.vendor_text
)
select nk.vendor_text,
       case when m.vendor_text is not null then m.bp_cd
            when ex.cand = 1               then ex.bp_cd
            when nm.cand = 1               then nm.bp_cd
            else null end                                             as bp_cd,
       case when m.vendor_text is not null then 'manual'
            when ex.cand = 1               then 'exact'
            when nm.cand = 1               then 'norm'
            when coalesce(nm.cand, 0) > 1  then 'ambiguous'
            else 'none' end                                           as match_type,
       coalesce(nm.cand, 0)                                           as cand_cnt
  from nk
  left join ex on ex.vendor_text = nk.vendor_text and ex.cand = 1
  left join nm on nm.vendor_text = nk.vendor_text
  left join public.pur_proposal_vendor_map m on m.vendor_text = nk.vendor_text;

comment on view public.v_pur_proposal_vendor is
  '대장 업체명 → ERP 거래처 매핑(수동 우선, 자동은 정확일치→정규화 유일일치). ambiguous·none 은 추정하지 않는다';

grant select on public.v_pur_proposal_vendor to authenticated, service_role;
revoke all on public.v_pur_proposal_vendor from anon;

-- ── 3. 조회 감사 로그 — 건 상세를 연 기록만 남긴다(§6) ───────────────────────
-- 목록(전건 요약)까지 남기면 조회 로그가 아니라 소음이 된다.
create table if not exists public.pur_proposal_recon_log (
  id         bigserial primary key,
  upn        text        not null,
  vol        smallint    not null,
  no         integer     not null,
  viewed_at  timestamptz not null default now()
);
create index if not exists ix_recon_log_at on public.pur_proposal_recon_log (viewed_at desc);

alter table public.pur_proposal_recon_log enable row level security;   -- 정책 없음 = 아무도 못 읽는다(관리자는 SQL 로)
revoke all on public.pur_proposal_recon_log from anon, authenticated;
grant all on public.pur_proposal_recon_log to service_role;

-- ── 4. 인덱스 ────────────────────────────────────────────────────────────────
create index if not exists ix_gl_slip_item_bp   on erp_ro.gl_slip_item_s (bp_cd);
create index if not exists ix_gl_slip_ctrl_cd   on erp_ro.gl_slip_ctrl_s (temp_gl_no, ctrl_cd);
create index if not exists ix_iv_dtl_iv_no      on erp_ro.iv_dtl_s (iv_no);
create index if not exists ix_gl_slip_ref_no    on erp_ro.gl_slip_s (ref_no);   -- IV → TG 승격이 타는 길

-- ── 5. 목록 RPC — 화면 진입 시 1회 ──────────────────────────────────────────
-- jsonb 한 덩이로 돌려준다: PostgREST 는 응답 행 수에 서버 상한(1,000)이 있고,
-- 넘으면 오류가 아니라 「적은 행」으로 조용히 잘린다(app/lib/api.js 의 같은 판단).
--
-- 대사 단위는 **대장 행 × 단계(칸)** 다. 한 칸에 전표가 여럿이어도 금액은 하나이므로,
-- 토큰별로 판정하지 않고 **칸 단위로 되접어** 비교한다.
create or replace function public.proposal_recon_list()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_upn   text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  v_eff   jsonb;
  v_admin boolean;
  v_rows  jsonb;
begin
  -- 권한은 백엔드에서 다시 판정한다(§5.4) — 프론트 게이트를 신뢰하지 않는다.
  if not public.is_internal() then
    raise exception 'forbidden: 사내 계정만 조회할 수 있습니다.' using errcode = '42501';
  end if;
  if v_upn = '' then
    raise exception 'unauthorized: 로그인 세션이 필요합니다.' using errcode = '28000';
  end if;
  v_eff   := public.perm_effective(v_upn);
  v_admin := coalesce((v_eff ->> 'is_admin')::boolean, false);
  if not v_admin and not exists (
       select 1 from jsonb_array_elements(coalesce(v_eff -> 'pages', '[]'::jsonb)) e
        where e ->> 'page_key' = 'purchase_proposal_2026'
          and coalesce((e ->> 'allowed')::boolean, false))
  then
    raise exception 'forbidden: 기안서 대장 열람 권한이 필요합니다.' using errcode = '42501';
  end if;

  with cell as (      -- 대장 행 × 단계 = 대사 단위
    -- ⚠ seq 로 자르지 않는다: 전표는 건이 아니라 **행마다** 적힌다(여러 행짜리 건 166개 중 23개가 행마다 다름)
    select p.vol, p.no, p.seq, s.stage, btrim(s.slip) as slip_raw, s.amt, p.vendor, p.amt_raw
      from public.pur_proposal p
      cross join lateral (values
          ('dp', p.dp_slip, p.dp_amt),
          ('mp', p.mp_slip, p.mp_amt),
          ('bp', p.bp_slip, p.bp_amt)) as s(stage, slip, amt)
     where coalesce(btrim(s.slip), '') <> ''
  ), tok as (         -- ① 토큰 추출 — 구분자를 열거하지 않는다
    select c.*, m[1] as tok, x.ord
      from cell c
      left join lateral regexp_matches(c.slip_raw, '(TG[0-9]{12}|IV[0-9]{12})', 'g')
             with ordinality as x(m, ord) on true
  ), prom as (        -- ② IV → 그 매입의 결의전표로 승격
    select t.*,
           coalesce(g.temp_gl_no, t.tok) as slip_no,
           (g.temp_gl_no is not null)    as via_iv
      from tok t
      left join erp_ro.gl_slip_s g
             on t.tok like 'IV%' and g.ref_no = t.tok and g.gl_input_type = 'AP'
  ), sl as (
    select g.temp_gl_no, g.temp_gl_dt, g.gl_no, g.conf_fg, g.gl_input_type,
           g.dr_loc_amt, g.temp_gl_desc
      from erp_ro.gl_slip_s g
     where g.temp_gl_no in (select slip_no from prom where slip_no is not null)
  ), li as (          -- ③ 전표가 확정하는 거래처 + 라인 집계
    select i.temp_gl_no,
           (array_agg(i.bp_cd) filter (where i.bp_cd is not null))[1] as bp_cd,
           count(*)::int                                              as all_cnt,
           sum(i.item_loc_amt) filter (where i.dr_cr_fg = 'DR')       as dr_sum
      from erp_ro.gl_slip_item_s i
     where i.temp_gl_no in (select temp_gl_no from sl)
     group by i.temp_gl_no
  ), invg as (        -- ④ 세금계산서 관리항목 — 라인(item_seq) 한 묶음이 계산서 한 장
    select c.temp_gl_no, c.item_seq,
           max(c.ctrl_val) filter (where c.ctrl_cd = 'V2')  as inv_dt,
           max(c.ctrl_val) filter (where c.ctrl_cd = 'V4')  as inv_type,
           max(c.ctrl_val) filter (where c.ctrl_cd = 'V11') as inv_elec,
           max(c.ctrl_val) filter (where c.ctrl_cd = 'V5')  as tax_area,
           -- V1·V8 은 천단위 콤마가 붙은 **문자열**이다("996,300")
           sum(nullif(replace(coalesce(c.ctrl_val,''), ',', ''), '')::numeric)
             filter (where c.ctrl_cd = 'V1')                as inv_supply,
           sum(nullif(replace(coalesce(c.ctrl_val,''), ',', ''), '')::numeric)
             filter (where c.ctrl_cd = 'V8')                as inv_vat
      from erp_ro.gl_slip_ctrl_s c
     where c.temp_gl_no in (select temp_gl_no from sl)
       and c.ctrl_cd in ('V1','V2','V4','V5','V8','V11')
     group by c.temp_gl_no, c.item_seq
  ), invs as (
    select temp_gl_no, count(*)::int as inv_cnt,
           sum(inv_supply) as inv_supply, sum(inv_vat) as inv_vat,
           min(inv_dt) as inv_dt, max(inv_type) as inv_type,
           max(inv_elec) as inv_elec, max(tax_area) as tax_area
      from invg
     where inv_supply is not null or inv_dt is not null
     group by temp_gl_no
  ), cohab as (       -- 같은 전표에 걸린 다른 기안 **건**
    select slip_no, count(distinct (vol, no))::int as n,
           jsonb_agg(distinct (vol || '-' || no)) as keys
      from prom where slip_no is not null group by slip_no
  ), t as (
    select p.*, sl.temp_gl_dt, sl.gl_no, sl.conf_fg, sl.gl_input_type,
           sl.dr_loc_amt, sl.temp_gl_desc,
           li.bp_cd, li.all_cnt, li.dr_sum,
           invs.inv_cnt, invs.inv_supply, invs.inv_vat, invs.inv_dt,
           invs.inv_type, invs.inv_elec, invs.tax_area,
           bp.bp_nm, cohab.n as cohabit_n, cohab.keys as cohabit_keys,
           (sl.temp_gl_no is not null) as is_found,   -- ⚠ `found` 는 plpgsql 예약어라 못 쓴다
           hit.hit_amt, hit.hit_gross,
           (p.tok is not null and substring(p.tok from 3 for 4) <> '2026') as out_of_year
      from prom p
      left join sl    on sl.temp_gl_no   = p.slip_no
      left join li    on li.temp_gl_no   = p.slip_no
      left join invs  on invs.temp_gl_no = p.slip_no
      left join cohab on cohab.slip_no   = p.slip_no
      left join erp_ro.bp_master_s bp on bp.bp_cd = li.bp_cd
      -- 이 금액과 같은 분개 라인이 있는가(한 기안 = 보통 라인 하나).
      -- `having count(*) > 0` 이 없으면 빈 집계가 0 인 행으로 돌아와 판정이 어긋난다.
      left join lateral (
        select bool_or(abs(i.item_loc_amt - p.amt) <= 10) as hit_amt,
               bool_or(abs(i.item_loc_amt * 1.1 - p.amt) <= 10
                    or abs(i.item_loc_amt / 1.1 - p.amt) <= 10) as hit_gross
          from erp_ro.gl_slip_item_s i
         where i.temp_gl_no = p.slip_no
        having count(*) > 0
      ) hit on true
  ), agg as (         -- 칸 단위로 되접는다
    select vol, no, seq, stage, slip_raw, amt, vendor, amt_raw,
           count(*) filter (where tok is not null)::int      as n_tok,
           count(*) filter (where is_found)::int             as n_found,
           jsonb_agg(jsonb_build_object(
             'tok', tok, 'slip_no', slip_no, 'via_iv', via_iv, 'found', is_found,
             'slip_dt', temp_gl_dt, 'gl_no', gl_no, 'conf_fg', conf_fg,
             'input_type', gl_input_type, 'slip_total', dr_loc_amt, 'slip_desc', temp_gl_desc,
             'bp_cd', bp_cd, 'bp_nm', bp_nm, 'all_cnt', all_cnt,
             'inv_cnt', inv_cnt, 'inv_supply', inv_supply, 'inv_vat', inv_vat,
             'inv_dt', inv_dt, 'inv_type', inv_type, 'inv_elec', inv_elec, 'tax_area', tax_area
           ) order by ord) filter (where tok is not null)     as slips,
           sum(inv_supply)                                    as inv_supply,
           sum(inv_vat)                                       as inv_vat,
           sum(dr_sum)                                        as dr_sum,
           bool_or(hit_amt)                                   as hit_amt,
           bool_or(hit_gross)                                 as hit_gross,
           max(cohabit_n)                                     as cohabit_n,
           (array_agg(cohabit_keys) filter (where cohabit_keys is not null))[1] as cohabit_keys,
           bool_or(out_of_year)                               as out_of_year,
           bool_or(via_iv)                                    as via_iv,
           bool_or(coalesce(conf_fg,'C') <> 'C')              as unconfirmed,
           bool_or(is_found and gl_no is null)                as unposted,
           bool_or(bp_nm is not null and vendor is not null
                   and btrim(bp_nm) <> btrim(vendor))         as vendor_diff,
           (array_agg(bp_nm) filter (where bp_nm is not null))[1] as slip_vendor
      from t
     group by vol, no, seq, stage, slip_raw, amt, vendor, amt_raw
  ), g as (
    -- 등급 사다리. 붉은 것은 `diff`·`noslip` 둘뿐이고, 회색(`split`)은 「기계가 판단할 수 없다」는 뜻이지
    -- 틀렸다는 뜻이 아니다. ±10원 허용 — 렌탈·통신료는 품목별 절사로 정확히 10% 가 아닌 전표가 실재한다.
    select a.*,
           case
             when a.amt is null                                              then 'none'
             when a.n_found = 0                                              then 'noslip'
             when abs(coalesce(a.inv_supply, -1e18) - a.amt) <= 10           then 'match'
             when coalesce(a.hit_amt, false)                                 then 'match'
             when abs(coalesce(a.inv_supply,0) + coalesce(a.inv_vat,0) - a.amt) <= 10
               or abs(coalesce(a.dr_sum, -1e18) - a.amt * 1.1) <= 10
               or coalesce(a.hit_gross, false)                               then 'vat'
             when a.inv_supply is null                                       then 'noinv'
             when coalesce(a.cohabit_n, 1) > 1 or a.n_tok > 1                then 'split'
             else 'diff' end as recon
      from agg a
  )
  select jsonb_agg(jsonb_build_object(
           'key', g.vol || '-' || g.no, 'vol', g.vol, 'no', g.no, 'seq', g.seq,
           'stage', g.stage, 'slip_raw', g.slip_raw, 'ledger_amt', g.amt,
           'n_tok', g.n_tok, 'n_found', g.n_found, 'slips', g.slips,
           'inv_supply', g.inv_supply, 'inv_vat', g.inv_vat, 'dr_sum', g.dr_sum,
           'slip_vendor', g.slip_vendor, 'ledger_vendor', g.vendor,
           'cohabit', greatest(coalesce(g.cohabit_n, 1) - 1, 0), 'cohabit_keys', g.cohabit_keys,
           'flags', (select jsonb_agg(f) from unnest(array[
                        case when g.out_of_year   then '조회연도밖'   end,
                        case when g.via_iv        then '매입경유'     end,
                        case when g.unconfirmed   then '미승인'       end,
                        case when g.unposted      then '미전기'       end,
                        case when g.vendor_diff   then '업체명상이'   end,
                        case when g.n_tok > 1     then '전표여럿'     end,
                        case when g.amt_raw is not null then '금액문자' end]) f where f is not null),
           'recon', g.recon))
    into v_rows from g;

  return jsonb_build_object(
    'ok', true,
    'as_of', (select max(updated_at) from public.pur_proposal),
    -- 미러 기준일은 **가장 오래된 것**을 쓴다 — 넷 중 하나만 늦어도 대사는 그만큼 낡았다
    'mirror_as_of', (select min(a.last_success) from public.v_erp_data_asof a
                      where a.job_name in ('gl_slip','gl_slip_item','gl_slip_ctrl','iv_dtl')),
    'rows', coalesce(v_rows, '[]'::jsonb));
end $function$;

revoke all on function public.proposal_recon_list() from public, anon;
grant execute on function public.proposal_recon_list() to authenticated, service_role;

-- ── 6. 상세 RPC — 행을 펼칠 때 1건 ──────────────────────────────────────────
-- 「왜 안 맞는가」의 근거를 준다: 전표 라인 전부(어느 라인이 이 금액인지 표시) · 같은 전표의 다른 기안 ·
-- 계산서 장별 내역 · IV 로 적힌 경우 매입 품목.
create or replace function public.proposal_recon_detail(p_vol smallint, p_no integer)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_upn   text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  v_eff   jsonb;
  v_admin boolean;
  v_out   jsonb;
begin
  if not public.is_internal() then
    raise exception 'forbidden: 사내 계정만 조회할 수 있습니다.' using errcode = '42501';
  end if;
  if v_upn = '' then
    raise exception 'unauthorized: 로그인 세션이 필요합니다.' using errcode = '28000';
  end if;
  v_eff   := public.perm_effective(v_upn);
  v_admin := coalesce((v_eff ->> 'is_admin')::boolean, false);
  if not v_admin and not exists (
       select 1 from jsonb_array_elements(coalesce(v_eff -> 'pages', '[]'::jsonb)) e
        where e ->> 'page_key' = 'purchase_proposal_2026'
          and coalesce((e ->> 'allowed')::boolean, false))
  then
    raise exception 'forbidden: 기안서 대장 열람 권한이 필요합니다.' using errcode = '42501';
  end if;

  insert into public.pur_proposal_recon_log (upn, vol, no) values (v_upn, p_vol, p_no);

  with cell as (
    select p.vol, p.no, p.seq, s.stage, btrim(s.slip) as slip_raw, s.amt, p.vendor
      from public.pur_proposal p
      cross join lateral (values
          ('dp', p.dp_slip, p.dp_amt), ('mp', p.mp_slip, p.mp_amt), ('bp', p.bp_slip, p.bp_amt)
        ) as s(stage, slip, amt)
     where p.vol = p_vol and p.no = p_no and coalesce(btrim(s.slip), '') <> ''
  ), tok as (
    select c.*, m[1] as tok, x.ord
      from cell c
      left join lateral regexp_matches(c.slip_raw, '(TG[0-9]{12}|IV[0-9]{12})', 'g')
             with ordinality as x(m, ord) on true
  ), prom as (
    select t.*, coalesce(g.temp_gl_no, t.tok) as slip_no, (g.temp_gl_no is not null) as via_iv
      from tok t
      left join erp_ro.gl_slip_s g
             on t.tok like 'IV%' and g.ref_no = t.tok and g.gl_input_type = 'AP'
  ), det as (
    select p.seq, p.stage, p.amt as ledger_amt, p.slip_raw, p.tok, p.ord, p.slip_no, p.via_iv,
           g.temp_gl_dt, g.gl_no, g.conf_fg, g.gl_input_type, g.dr_loc_amt, g.temp_gl_desc,
           (select bp.bp_nm from erp_ro.gl_slip_item_s i2
              join erp_ro.bp_master_s bp on bp.bp_cd = i2.bp_cd
             where i2.temp_gl_no = p.slip_no and i2.bp_cd is not null limit 1) as slip_vendor,
           (select jsonb_agg(jsonb_build_object(
                     'seq', i.item_seq, 'dr_cr', i.dr_cr_fg, 'acct_cd', i.acct_cd,
                     'acct_nm', a.acct_nm, 'amt', i.item_loc_amt, 'vat', i.vat_loc_amt,
                     'desc', i.item_desc, 'project_no', i.project_no, 'bp_cd', i.bp_cd,
                     'is_hit', (abs(i.item_loc_amt - p.amt) <= 10)) order by i.item_seq)
              from erp_ro.gl_slip_item_s i
              left join erp_ro.acct_master_s a on a.acct_cd = i.acct_cd
             where i.temp_gl_no = p.slip_no)                                    as lines,
           -- 세금계산서 — ① 부가세 원장(A_VAT 미러 · SQL 73)이 정본이다. 전표번호를 컬럼으로 들고 있어
           --   추정이 없고, 금액도 ERP자료대사(CM903M2) 화면과 오차 0 으로 맞는다(2026-09-23 실측).
           --   국세청(e세로) 승인번호·발급일은 A_VAT 에 없어 「구분+작성일+상대 사업자번호+공급가액」 4축으로 잇는다
           --   (기안이 참조한 전표 478칸 전부 승인번호 확보 — 실측).
           -- ② 원장에 없으면(조회연도 밖 등) 전표 관리항목(V1/V2/V4/V8/V11)으로 되돌아간다.
           coalesce(
             (select jsonb_agg(z.o order by z.dt, z.vat_no) from (
                select v.issued_dt as dt, v.vat_no, jsonb_build_object(
                         'src', 'vat', 'vat_no', v.vat_no, 'seq', v.temp_item_seq,
                         'dt', v.issued_dt, 'type', v.vat_type,
                         'type_nm', (select r.ref_nm from erp_ro.ctrl_ref_s r
                                      where r.ctrl_cd = 'V4' and r.ref_cd = v.vat_type),
                         'tax_area', v.report_biz_area_cd, 'tax_area_nm', v.report_biz_area_nm,
                         'bp', v.bp_cd, 'bp_rgst', v.bp_rgst_no,
                         'supply', v.net_loc_amt, 'vat', v.vat_loc_amt,
                         'conf', v.conf_fg, 'gl_no', v.gl_no, 'io_fg', v.io_fg,
                         'nts', case when e.etax_id is null then null else jsonb_build_object(
                                  'aprv_no', e.aprv_no, 'write_date', e.write_date,
                                  'issue_date', e.issue_date, 'transfer_date', e.transfer_date,
                                  'kind', e.etax_kind, 'etax_type', e.etax_type,
                                  'issue_type', e.issue_type, 'sup_nm', e.sup_comp_nm,
                                  'item_nm', e.item_nm, 'supply', e.sup_amt, 'vat', e.vat_amt) end) as o
                  from erp_ro.vat_s v
                  left join lateral (
                    select e2.* from erp_ro.etax_master_s e2
                     where e2.sapu_type = v.io_fg
                       and e2.write_date = v.issued_dt
                       and coalesce(e2.sup_amt, 0) = coalesce(v.net_loc_amt, 0)
                       and (case when v.io_fg = 'I' then e2.sup_busi_no else e2.buy_busi_no end)
                           = v.bp_rgst_no
                     limit 1) e on true
                 where v.temp_gl_no = p.slip_no) z),
             (select jsonb_agg(x.o order by x.item_seq) from (
                select c.item_seq, jsonb_build_object(
                         'src', 'ctrl', 'seq', c.item_seq,
                         'dt',      max(c.ctrl_val) filter (where c.ctrl_cd = 'V2'),
                         'type',    max(c.ctrl_val) filter (where c.ctrl_cd = 'V4'),
                         'type_nm', (select r.ref_nm from erp_ro.ctrl_ref_s r
                                      where r.ctrl_cd = 'V4'
                                        and r.ref_cd = max(c.ctrl_val) filter (where c.ctrl_cd = 'V4')),
                         'elec',    max(c.ctrl_val) filter (where c.ctrl_cd = 'V11'),
                         'tax_area',max(c.ctrl_val) filter (where c.ctrl_cd = 'V5'),
                         'bp',      max(c.ctrl_val) filter (where c.ctrl_cd = 'V6'),
                         'supply',  sum(nullif(replace(coalesce(c.ctrl_val,''), ',', ''), '')::numeric)
                                      filter (where c.ctrl_cd = 'V1'),
                         'vat',     sum(nullif(replace(coalesce(c.ctrl_val,''), ',', ''), '')::numeric)
                                      filter (where c.ctrl_cd = 'V8')) as o
                  from erp_ro.gl_slip_ctrl_s c
                 where c.temp_gl_no = p.slip_no
                   and c.ctrl_cd in ('V1','V2','V4','V5','V6','V8','V11')
                 group by c.item_seq
                 having sum(nullif(replace(coalesce(c.ctrl_val,''), ',', ''), '')::numeric)
                          filter (where c.ctrl_cd = 'V1') is not null
                     or max(c.ctrl_val) filter (where c.ctrl_cd = 'V2') is not null) x)
           )                                                                    as invoices,
           (select jsonb_agg(jsonb_build_object(
                     'seq', d.iv_seq_no, 'item_code', d.item_code, 'item_name', d.item_name,
                     'qty', d.iv_qty, 'price', d.iv_prc, 'amt', d.iv_loc_amt,
                     'vat', d.vat_loc_amt, 'po_no', d.po_no) order by d.iv_seq_no)
              from erp_ro.iv_dtl_s d where d.iv_no = p.tok)                     as iv_lines,
           (select jsonb_agg(distinct (o.vol || '-' || o.no))
              from public.pur_proposal o
             where (o.vol, o.no) is distinct from (p_vol, p_no)
               and (o.bp_slip like '%' || p.tok || '%'
                 or o.dp_slip like '%' || p.tok || '%'
                 or o.mp_slip like '%' || p.tok || '%'))                        as cohabit_keys
      from prom p
      left join erp_ro.gl_slip_s g on g.temp_gl_no = p.slip_no
  )
  select jsonb_build_object('ok', true, 'key', p_vol || '-' || p_no,
    'stages', coalesce(jsonb_agg(to_jsonb(det) order by det.seq,
                 case det.stage when 'dp' then 1 when 'mp' then 2 else 3 end, det.ord), '[]'::jsonb))
    into v_out from det;

  return v_out;
end $function$;

revoke all on function public.proposal_recon_detail(smallint, integer) from public, anon;
grant execute on function public.proposal_recon_detail(smallint, integer) to authenticated, service_role;

-- ── 확인 ─────────────────────────────────────────────────────────────────────
-- 사내 사용자를 가장해 실행한다(do 블록 밖에서 set_config 하면 스캔 순서가 보장되지 않는다 — 62번 주석):
--   select set_config('request.jwt.claims',
--     '{"role":"authenticated","email":"…@jeilm.co.kr","app_metadata":{"role":"internal"}}', true);
--   select r ->> 'recon', count(*) from jsonb_array_elements(public.proposal_recon_list() -> 'rows') r group by 1;
--   → 일치 575 · 합산/분할 295 · 확인필요 50 · 전표미발견 10 · 계산서없음 8 · 세액차 1 · 미기재 5 (2026-09-23)
