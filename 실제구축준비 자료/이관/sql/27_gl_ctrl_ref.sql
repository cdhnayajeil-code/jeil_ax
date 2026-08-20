-- =====================================================================
-- 27_gl_ctrl_ref.sql — 관리항목 참조 마스터 통합 미러 + 연동 현황 등재
--   결의전표 관리항목의 🔍 검색 원천. 관리자 지시(2026-08-20)로 참조가 있는 관리항목
--   31종을 전부 연결한다(거래처·품목 4종은 기존 전용 RPC, 나머지 27종이 이 미러).
--
--   적용 이력(Supabase migration):
--     gl_ctrl_ref_v1                        (2026-08-20) 테이블·적재·검색 RPC
--     gl_ctrl_ref_v1b_dedupe                (2026-08-20) 배치 내 중복키 제거
--     erp_sync_overview_gl_mirror_ctrl_ref  (2026-08-20) 연동 현황에 4종 등재
--   ETL: 10_ERP_DB연계/etl/etl_run.py  job `ctrl_ref` (야간배치 --job all 에 포함)
-- =====================================================================

-- ── 1. 통합 미러 ─────────────────────────────────────────────────────
--   참조 마스터마다 테이블을 만들지 않고 (관리항목코드, 코드, 명칭)으로 정규화한다.
--   화면은 관리항목 코드만 알면 같은 팝업으로 검색한다.
create table if not exists erp_ro.ctrl_ref_s (
  ctrl_cd     text not null,        -- 관리항목 코드(PC·BK·V4 …)
  ref_cd      text not null,        -- 선택 값(전표에 저장되는 코드)
  ref_nm      text,                 -- 표시 명칭
  ref_sub     text,                 -- 보조 표시(부서·은행·거래처 등)
  src_tbl     text,                 -- 원천 테이블(추적용)
  src_updated timestamptz,
  synced_at   timestamptz not null default now(),
  batch_id    uuid,
  primary key (ctrl_cd, ref_cd)
);
create index if not exists ctrl_ref_s_nm_idx on erp_ro.ctrl_ref_s (ctrl_cd, ref_nm);

alter table erp_ro.ctrl_ref_s enable row level security;   -- 정책 0개 = 전면 차단
revoke all on erp_ro.ctrl_ref_s from anon, authenticated;
grant select, insert, update on erp_ro.ctrl_ref_s to service_role;

-- ── 2. 적재 ──────────────────────────────────────────────────────────
--   기존 erp_master_upsert 를 건드리지 않는 추가 전용 RPC(같은 호출 규약).
--   배치 내 중복키 방어: 프로젝트코드는 V_SO_TRACKING ← PM_PROJECT_MASTER 조인이
--   1:N 이 될 수 있어 같은 키가 두 번 들어온다 → distinct on 으로 정리(명칭 있는 행 우선).
create or replace function public.erp_ctrl_ref_upsert(p_table text, p_rows jsonb)
  returns integer language plpgsql security definer set search_path to ''
as $$
declare n integer := 0;
begin
  if p_table <> 'ctrl_ref_s' then
    raise exception '허용되지 않은 테이블: %', p_table;
  end if;
  insert into erp_ro.ctrl_ref_s (ctrl_cd, ref_cd, ref_nm, ref_sub, src_tbl, src_updated, synced_at, batch_id)
  select ctrl_cd, ref_cd, ref_nm, ref_sub, src_tbl, src_updated, now(), batch_id
  from (
    select distinct on (btrim(x.ctrl_cd), btrim(x.ref_cd))
           btrim(x.ctrl_cd) as ctrl_cd, btrim(x.ref_cd) as ref_cd,
           nullif(btrim(coalesce(x.ref_nm,'')),'')  as ref_nm,
           nullif(btrim(coalesce(x.ref_sub,'')),'') as ref_sub,
           x.src_tbl, x.src_updated, x.batch_id
    from jsonb_to_recordset(p_rows) as x(ctrl_cd text, ref_cd text, ref_nm text, ref_sub text,
                                         src_tbl text, src_updated timestamptz, batch_id uuid)
    where coalesce(btrim(x.ref_cd),'') <> '' and coalesce(btrim(x.ctrl_cd),'') <> ''
    order by btrim(x.ctrl_cd), btrim(x.ref_cd),
             (nullif(btrim(coalesce(x.ref_nm,'')),'') is null)
  ) d
  on conflict (ctrl_cd, ref_cd) do update
    set ref_nm = coalesce(excluded.ref_nm, erp_ro.ctrl_ref_s.ref_nm),
        ref_sub = coalesce(excluded.ref_sub, erp_ro.ctrl_ref_s.ref_sub),
        src_tbl = excluded.src_tbl, synced_at = excluded.synced_at,
        src_updated = excluded.src_updated, batch_id = excluded.batch_id;
  get diagnostics n = row_count;
  return n;
end $$;

-- ── 3. 검색·목록 ─────────────────────────────────────────────────────
create or replace function public.gl_ctrl_ref_search(p_ctrl_cd text, p_q text)
  returns table (ref_cd text, ref_nm text, ref_sub text)
  language sql security definer stable set search_path to ''
as $$
  select r.ref_cd, r.ref_nm, r.ref_sub
  from erp_ro.ctrl_ref_s r
  where r.ctrl_cd = btrim(p_ctrl_cd)
    and (coalesce(btrim(p_q),'') = ''
         or r.ref_cd ilike '%'||btrim(p_q)||'%'
         or coalesce(r.ref_nm,'') ilike '%'||btrim(p_q)||'%')
  order by (r.ref_cd ilike btrim(p_q)||'%') desc nulls last, r.ref_cd
  limit 30;
$$;

-- 화면이 🔍 버튼을 붙일 대상 — 적재된 것만 검색 버튼이 생긴다(코드 하드코딩 없음)
create or replace function public.gl_ctrl_ref_kinds()
  returns jsonb language sql security definer stable set search_path to ''
as $$
  select coalesce(jsonb_object_agg(ctrl_cd, cnt), '{}'::jsonb)
  from (select ctrl_cd, count(*) as cnt from erp_ro.ctrl_ref_s group by ctrl_cd) t;
$$;

revoke execute on function public.erp_ctrl_ref_upsert(text, jsonb) from public, anon, authenticated;
revoke execute on function public.gl_ctrl_ref_search(text, text)   from public, anon, authenticated;
revoke execute on function public.gl_ctrl_ref_kinds()              from public, anon, authenticated;
grant execute on function public.erp_ctrl_ref_upsert(text, jsonb) to service_role;
grant execute on function public.gl_ctrl_ref_search(text, text)   to service_role;
grant execute on function public.gl_ctrl_ref_kinds()              to service_role;

-- ── 4. 연동 현황 등재 ────────────────────────────────────────────────
--   v_erp_sync_overview 에 4종 추가: 결의전표 미러 3종(2026-08-18 신설분 — 등재 누락이었다)
--   + ctrl_ref. 뷰 전체를 손으로 옮겨 적지 않고 pg_get_viewdef 로 읽어 UNION ALL 로 덧붙였다
--   (전사 대시보드가 쓰는 뷰라 전사 오류를 피한다). 실제 SQL 은 migration
--   erp_sync_overview_gl_mirror_ctrl_ref 참조 — 정렬 150/160/170/180.
--
--   민감 표기(sensitive=true): gl_slip_ctrl(전표 관리항목 값) · ctrl_ref(사번·계좌·카드 포함).
--
-- ── 5. 개인정보 취급 ─────────────────────────────────────────────────
--   ETL 이 원천에서 선택하는 컬럼을 최소화한다.
--   · 사번(EM ← HAA010T): 사번·성명·부서명 3개만. 주민번호(RES_NO)·호봉·주소·연락처 등은
--     SELECT 목록에 넣지 않는다. 재직자만(RETIRE_DT is null). 이름은 마스킹 제외(CLAUDE.md §1.7).
--   · 계좌·법인카드·어음·차입은 회사 재무 마스터. 코드와 식별 명칭만.
--   · 조회는 Edge Function(jeil-gl-draft op ctrl_ref)이 감사 로그에 남긴다 —
--     값은 남기지 않고 관리항목 코드·검색어 길이·결과 건수만(gl_draft_log).
