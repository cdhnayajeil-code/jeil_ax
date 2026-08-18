-- 24. 반복전표 자동화 v2 — 관리항목·월반복 구조 (기획 10_반복전표_자동화_기획 §6.3, P1 — 2026-08-12)
-- 적용: 마이그레이션 `gl_template_v2` (2026-08-12, Supabase MCP)
-- 규약: C-6 유지 — RLS ON·정책 0(fail-closed), anon/authenticated 회수, Edge Function(service_role) 단일 경로.
-- 관련: jeil-gl-draft v4(코드 기준 — 플랫폼 배포 카운터로는 3번째 배포) — 신규 op
--       tpl_recur_list(월반복 카드)·tpl_apply_prev(전월 프리필)·tpl_seed_bulk(시드 일괄, 관리자 한정)
--       + save/get/submit/void/post 확장(관리항목·usage 동기, 하위호환 유지)

-- 1) 초안 라인 관리항목 (ERP A_TEMP_GL_DTL 대응, invoice_seq = 계산서 그룹 식별)
create table if not exists public.gl_draft_item_ctrl (
  draft_no    text not null references public.gl_draft(draft_no) on delete cascade,
  item_seq    smallint not null,
  ctrl_cd     text not null,
  ctrl_val    text,
  invoice_seq smallint,
  primary key (draft_no, item_seq, ctrl_cd)
);

-- 2) 템플릿 라인 관리항목 규칙
create table if not exists public.gl_template_item_ctrl (
  tpl_id    bigint not null references public.gl_template(tpl_id) on delete cascade,
  line_seq  smallint not null,
  ctrl_cd   text not null,
  val_rule  text not null default 'input'
            check (val_rule in ('fixed','input','date_shift')),  -- derived는 B2 결정(자동계산 제외)으로 1차 미사용
  fixed_val text,
  primary key (tpl_id, line_seq, ctrl_cd)
);

-- 3) 템플릿 헤더·라인 확장 (월반복 속성)
alter table public.gl_template
  add column if not exists recur_cycle   text check (recur_cycle in ('monthly') or recur_cycle is null),
  add column if not exists title_pattern text,     -- 적요 토큰: {YYYY}·{YY}·{M}
  add column if not exists month_offset  smallint, -- 0=당월 표기, -1=전월분 표기 (실측 오프셋)
  add column if not exists src_family_key text,    -- 분석 패밀리 식별자(시드 유래)
  add column if not exists vat_mode      text check (vat_mode in ('taxable','exempt') or vat_mode is null);
alter table public.gl_template_item
  add column if not exists amt_locked boolean not null default false;  -- true=고정(실측 amt_distinct=1)

-- 4) 회차별 사용 이력 (월반복 배지 4상태·처리율 근거 — 초안 생성 시 기록, 상태 동기)
create table if not exists public.gl_template_usage (
  id       bigserial primary key,
  tpl_id   bigint not null references public.gl_template(tpl_id) on delete cascade,
  use_ym   text not null,             -- 'YYYY-MM' — 결의일자 연월 기본
  draft_no text not null references public.gl_draft(draft_no) on delete cascade,
  status   text not null default 'draft' check (status in ('draft','submitted','posted','void')),
  used_by  text not null,
  used_at  timestamptz not null default now(),
  unique (tpl_id, draft_no)
);
create index if not exists gl_template_usage_ym_idx on public.gl_template_usage (tpl_id, use_ym);

-- 5) RLS·권한 (C-6)
alter table public.gl_draft_item_ctrl    enable row level security;
alter table public.gl_template_item_ctrl enable row level security;
alter table public.gl_template_usage     enable row level security;
revoke all on public.gl_draft_item_ctrl, public.gl_template_item_ctrl, public.gl_template_usage
  from anon, authenticated;

-- 6) 관리항목 마스터 조회 RPC — erp_ro 는 REST 비노출이라 Edge Function이 이 RPC로 읽는다
--    (gl_master_get 선례와 동일: SECURITY DEFINER + service_role 전용)
create or replace function public.gl_ctrl_master_get()
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $$
  select jsonb_build_object(
    'ctrl_items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'ctrl_cd', ctrl_cd, 'ctrl_nm', ctrl_nm,
               'data_type', colm_data_type, 'ref_tbl', ref_tbl) order by ctrl_cd)
      from erp_ro.ctrl_item_s), '[]'::jsonb),
    'acct_ctrl', coalesce((
      select jsonb_agg(jsonb_build_array(acct_cd, ctrl_cd, coalesce(ctrl_item_seq, 999),
                                         coalesce(dr_fg,'N'), coalesce(cr_fg,'N'))
                       order by acct_cd, coalesce(ctrl_item_seq, 999))
      from erp_ro.acct_ctrl_assn_s), '[]'::jsonb),
    'as_of', now());
$$;
revoke all on function public.gl_ctrl_master_get() from public, anon, authenticated;
grant execute on function public.gl_ctrl_master_get() to service_role;
