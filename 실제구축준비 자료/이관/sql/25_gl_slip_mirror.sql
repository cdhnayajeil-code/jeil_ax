-- 25_gl_slip_mirror.sql — 결의전표 미러(전표복사 원천) + 조회 RPC
-- 적용일 2026-08-18 · Supabase 마이그레이션: gl_slip_mirror_v1 · gl_slip_synced_at_v1 · gl_pad_trim_v1
-- 원천(읽기 전용): JEILMNS.dbo.A_TEMP_GL · A_TEMP_GL_ITEM · A_TEMP_GL_DTL
--
-- 배경 — 결의전표 입력(초안) 화면의 「전표복사」 탭 (ERP 전표복사 메뉴와 동일 흐름)
--   본인이 ERP에 입력한 결의전표를 불러와 새 초안의 출발점으로 복사한다.
--   결정 C-10(2026-08-18 관리자 지시): C-7(코드 마스터만 적재)을 확장해 결의전표 미러를 적재.
--
-- 보안 통제
--   · erp_ro RLS 전면차단 + 정책 0 + anon/authenticated 회수 → RPC(service_role) 단일 경로
--   · 조회 RPC 는 소유 필터(insrt_user_id = 본인 ERP USR_ID)를 RPC 안에서 강제 —
--     Edge Function 이 JWT→gl_erp_user 로 확정한 본인 ID만 넘긴다(1:1 매핑 실측 확정, C-3)
--   · 민감 관리항목(EM/BA/D1/CP/NN — 사번·계좌·신용카드·구매카드·어음)은
--     ETL 추출 SQL 에서 값을 NULL 마스킹(중간DB에 값 자체를 두지 않는다)
--
-- 알려진 한계·특성
--   · upsert 적재라 ERP에서 '삭제'된 전표는 미러에 남을 수 있다(복사 원천 용도로는 허용).
--   · 야간 배치 미러라 실시간이 아니다 — 화면에 최근 동기 시점을 표시한다.
--   · ERP char 컬럼은 뒤 공백(패딩)이 붙는다 — 계정·거래처·관리항목 매칭이 전부 miss 되던
--     원인(2026-08-18 발견). 3중 대응: ETL RTRIM + 기존 데이터 일회성 trim(gl_pad_trim_v1)
--     + 아래 RPC btrim 반환·조인. ETL/RPC 수정 시 이 원칙을 유지할 것.

-- ═══════════════════════════════════════════════════════════════════════
-- 1) 미러 테이블 3종 (erp_ro)
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists erp_ro.gl_slip_s (
  temp_gl_no    text primary key,          -- 결의전표번호(TG+YYYYMMDD+4)
  temp_gl_dt    date,                      -- 결의일자
  gl_no         text,                      -- 전기 후 정식 전표번호(있으면 전기됨)
  dept_cd       text,
  cost_cd       text,
  gl_type       text,                      -- 전표형태(실측 전량 03)
  gl_input_type text,                      -- 입력경로(TG=수기, UX/AP/AR/FN/DP/AC)
  conf_fg       text,                      -- 승인여부(U→C)
  dr_loc_amt    numeric,                   -- 차변 합계(원화)
  temp_gl_desc  text,                      -- 적요
  insrt_user_id text,                      -- 등록자(=MS 이메일, 1:1 매핑 실측 확정 C-3)
  ref_no        text,
  issued_dt     date,
  attach_cnt    integer,
  src_updated   timestamptz,
  synced_at     timestamptz not null default now(),
  batch_id      uuid
);
comment on table erp_ro.gl_slip_s is 'ERP 결의전표 헤더 미러(A_TEMP_GL) — 전표복사 원천. 본인(insrt_user_id=JWT 매핑) 전표만 RPC로 반환. C-10.';

create table if not exists erp_ro.gl_slip_item_s (
  temp_gl_no       text not null,
  item_seq         integer not null,
  acct_cd          text,
  dr_cr_fg         text,                   -- 실측 'DR'/'CR' 2자 — 화면에서 첫 글자로 정규화
  dept_cd          text,
  cost_cd          text,
  vat_type         text,
  item_loc_amt     numeric,
  vat_loc_amt      numeric,
  item_desc        text,
  bp_cd            text,
  tax_biz_area     text,
  relative_acct_cd text,
  item_cd          text,
  project_no       text,
  io_fg            text,
  src_updated      timestamptz,
  synced_at        timestamptz not null default now(),
  batch_id         uuid,
  primary key (temp_gl_no, item_seq)
);
comment on table erp_ro.gl_slip_item_s is 'ERP 결의전표 라인 미러(A_TEMP_GL_ITEM) — 전표복사 원천.';

create table if not exists erp_ro.gl_slip_ctrl_s (
  temp_gl_no  text not null,
  item_seq    integer not null,
  dtl_seq     integer not null,
  ctrl_cd     text,
  ctrl_val    text,                        -- EM/BA/D1/CP/NN 은 NULL(값 미적재)
  src_updated timestamptz,
  synced_at   timestamptz not null default now(),
  batch_id    uuid,
  primary key (temp_gl_no, item_seq, dtl_seq)
);
comment on table erp_ro.gl_slip_ctrl_s is 'ERP 결의전표 관리항목 미러(A_TEMP_GL_DTL) — 민감 항목(사번·계좌·카드·어음) 값은 적재하지 않음.';

create index if not exists gl_slip_s_owner_idx   on erp_ro.gl_slip_s (insrt_user_id, temp_gl_dt desc);
create index if not exists gl_slip_item_s_no_idx on erp_ro.gl_slip_item_s (temp_gl_no);
create index if not exists gl_slip_ctrl_s_no_idx on erp_ro.gl_slip_ctrl_s (temp_gl_no);

alter table erp_ro.gl_slip_s      enable row level security;
alter table erp_ro.gl_slip_item_s enable row level security;
alter table erp_ro.gl_slip_ctrl_s enable row level security;
revoke all on erp_ro.gl_slip_s, erp_ro.gl_slip_item_s, erp_ro.gl_slip_ctrl_s from anon, authenticated;
grant select on erp_ro.gl_slip_s, erp_ro.gl_slip_item_s, erp_ro.gl_slip_ctrl_s to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 2) 적재 RPC 확장 — erp_master_upsert 에 gl_slip 3분기 추가
--    (전체 재정의는 마이그레이션 gl_slip_mirror_v1 참조 — 기존 4분기(acct/cost/ctrl/assn)
--     그대로 두고 아래 3분기를 덧붙인 형태)
-- ═══════════════════════════════════════════════════════════════════════
--   elsif p_table = 'gl_slip_s' then      … on conflict (temp_gl_no) do update …
--   elsif p_table = 'gl_slip_item_s' then … on conflict (temp_gl_no, item_seq) do update …
--   elsif p_table = 'gl_slip_ctrl_s' then … on conflict (temp_gl_no, item_seq, dtl_seq) do update …

-- ═══════════════════════════════════════════════════════════════════════
-- 3) 조회 RPC — 소유 필터를 RPC 안에서 강제. service_role 전용.
-- ═══════════════════════════════════════════════════════════════════════

-- ※ btrim: ERP char 패딩 대비 이중 안전(데이터는 ETL RTRIM·gl_pad_trim_v1 로 이미 정리됨)
create or replace function public.gl_slip_list(p_erp_usr_id text, p_from date, p_to date, p_q text)
  returns jsonb
  language sql
  security definer
  set search_path to ''
as $function$
  select coalesce(jsonb_agg(t), '[]'::jsonb) from (
    select h.temp_gl_no, h.temp_gl_dt, h.gl_no, btrim(h.dept_cd) as dept_cd,
           btrim(h.cost_cd) as cost_cd, btrim(h.gl_type) as gl_type,
           btrim(h.gl_input_type) as gl_input_type, btrim(h.conf_fg) as conf_fg,
           h.dr_loc_amt, h.temp_gl_desc, h.ref_no,
           (select count(*) from erp_ro.gl_slip_item_s i where i.temp_gl_no = h.temp_gl_no) as line_cnt
    from erp_ro.gl_slip_s h
    where length(coalesce(p_erp_usr_id, '')) > 3
      and lower(btrim(h.insrt_user_id)) = lower(btrim(p_erp_usr_id))
      and (p_from is null or h.temp_gl_dt >= p_from)
      and (p_to   is null or h.temp_gl_dt <= p_to)
      and (coalesce(p_q, '') = '' or h.temp_gl_desc ilike '%' || p_q || '%'
           or h.temp_gl_no ilike p_q || '%')
    order by h.temp_gl_dt desc, h.temp_gl_no desc
    limit 300
  ) t;
$function$;

create or replace function public.gl_slip_get(p_erp_usr_id text, p_no text)
  returns jsonb
  language sql
  security definer
  set search_path to ''
as $function$
  select jsonb_build_object(
    'header', jsonb_build_object(
      'temp_gl_no', h.temp_gl_no, 'temp_gl_dt', h.temp_gl_dt, 'gl_no', h.gl_no,
      'dept_cd', btrim(h.dept_cd), 'cost_cd', btrim(h.cost_cd), 'gl_type', btrim(h.gl_type),
      'gl_input_type', btrim(h.gl_input_type), 'conf_fg', btrim(h.conf_fg),
      'dr_loc_amt', h.dr_loc_amt, 'temp_gl_desc', h.temp_gl_desc,
      'ref_no', h.ref_no, 'issued_dt', h.issued_dt, 'attach_cnt', h.attach_cnt),
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'item_seq', i.item_seq, 'dr_cr_fg', btrim(i.dr_cr_fg),
               'acct_cd', btrim(i.acct_cd), 'acct_nm', coalesce(a.acct_nm, a.acct_full_nm),
               'acct_in_master', (a.acct_cd is not null and a.use_yn),
               'item_loc_amt', i.item_loc_amt, 'vat_loc_amt', i.vat_loc_amt,
               'vat_type', btrim(i.vat_type),
               'item_desc', i.item_desc, 'bp_cd', btrim(i.bp_cd), 'bp_nm', b.bp_nm,
               'cost_cd', btrim(i.cost_cd), 'project_no', btrim(i.project_no),
               'dept_cd', btrim(i.dept_cd)
             ) order by i.item_seq), '[]'::jsonb)
      from erp_ro.gl_slip_item_s i
      left join erp_ro.acct_master_s a on a.acct_cd = btrim(i.acct_cd)
      left join erp_ro.bp_master_s b on b.bp_cd = btrim(i.bp_cd)
      where i.temp_gl_no = h.temp_gl_no
    ),
    'ctrls', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'item_seq', d.item_seq, 'dtl_seq', d.dtl_seq,
               'ctrl_cd', btrim(d.ctrl_cd), 'ctrl_val', d.ctrl_val
             ) order by d.item_seq, d.dtl_seq), '[]'::jsonb)
      from erp_ro.gl_slip_ctrl_s d
      where d.temp_gl_no = h.temp_gl_no
    )
  )
  from erp_ro.gl_slip_s h
  where h.temp_gl_no = p_no
    and length(coalesce(p_erp_usr_id, '')) > 3
    and lower(btrim(h.insrt_user_id)) = lower(btrim(p_erp_usr_id));
$function$;

-- 품목 검색(관리항목 MK 팝업용) — 마이그레이션 gl_pad_trim_v1
create or replace function public.gl_item_search(p_q text)
  returns jsonb
  language sql
  security definer
  set search_path to ''
as $function$
  select coalesce(jsonb_agg(t), '[]'::jsonb) from (
    select i.item_code, i.item_name, i.spec, i.unit
    from erp_ro.item_master_s i
    where i.use_yn
      and length(coalesce(p_q, '')) >= 2
      and (i.item_name ilike '%' || p_q || '%' or i.item_code ilike p_q || '%'
           or coalesce(i.spec,'') ilike '%' || p_q || '%')
    order by i.item_name
    limit 30
  ) t;
$function$;
revoke all on function public.gl_item_search(text) from public, anon, authenticated;
grant execute on function public.gl_item_search(text) to service_role;

-- gl_ctrl_master_get(23/마이그레이션 gl_ctrl_master_v1 정의)도 gl_pad_trim_v1 에서
-- btrim 반환으로 재정의됨 — acct_ctrl 의 계정·관리항목 코드가 trim 되어 내려간다.

-- 미러 최근 동기 시점(화면 안내용) — 마이그레이션 gl_slip_synced_at_v1
create or replace function public.gl_slip_synced_at()
  returns timestamptz
  language sql
  security definer
  set search_path to ''
as $function$
  select max(synced_at) from erp_ro.gl_slip_s;
$function$;

revoke all on function public.gl_slip_list(text, date, date, text) from public, anon, authenticated;
revoke all on function public.gl_slip_get(text, text) from public, anon, authenticated;
revoke all on function public.gl_slip_synced_at() from public, anon, authenticated;
grant execute on function public.gl_slip_list(text, date, date, text) to service_role;
grant execute on function public.gl_slip_get(text, text) to service_role;
grant execute on function public.gl_slip_synced_at() to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 4) 롤백 (필요 시)
-- ═══════════════════════════════════════════════════════════════════════
-- drop function if exists public.gl_slip_list(text, date, date, text);
-- drop function if exists public.gl_slip_get(text, text);
-- drop table if exists erp_ro.gl_slip_ctrl_s, erp_ro.gl_slip_item_s, erp_ro.gl_slip_s;
-- erp_master_upsert 는 21/23 정본의 4분기 버전으로 재적용
