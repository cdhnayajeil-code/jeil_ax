-- 22_gl_template.sql — 결의전표 템플릿(케이스별 분개 형태)
-- 적용일 2026-08-05 · Supabase 마이그레이션: gl_template_v1
-- 선행: 21_gl_draft.sql(초안 헤더·라인·로그·마감월 + 회계 마스터 미러)
--
-- 무엇을 담고 무엇을 담지 않는가
--   · 담는 것: "이 케이스는 어떤 계정을 차/대변에 쓰고 금액을 어떻게 나누는가" — 형태와 규칙.
--   · 담지 않는 것: 실제 전표 금액. 고정액(fixed)·비율(pct)은 규칙값이지 실적치가 아니다.
--   · 템플릿을 적용해도 검증은 면제되지 않는다. 적용 결과는 gl_draft 저장 시
--     서버 재검증(차대일치·계정유효·금액·마감월·프로젝트필수)을 그대로 통과해야 한다.
--
-- 공개 범위와 편집 권한을 분리한다
--   scope=org  전사 공개  ┐ 편집은 관리자·회계 담당자(finance)만.
--   scope=dept 부서 공개  ┘ 잘못된 분개가 전사로 퍼지는 것을 막는 장치다.
--   scope=user 개인 전용   — 본인만 보고 본인만 고친다(입력 권한자 누구나 생성 가능).
--
-- 보안: 21_gl_draft.sql 계승(C-6) — RLS ON·정책 0 + anon/authenticated 회수 →
--   Edge Function(jeil-gl-draft, service_role) 단일 경로.

create sequence if not exists public.gl_template_seq;

create table if not exists public.gl_template (
  tpl_id        bigserial primary key,
  tpl_code      text not null unique
                default 'TPL-' || lpad(nextval('public.gl_template_seq')::text, 4, '0'),
  tpl_nm        text not null,                         -- 화면에 뜨는 이름(예: 국내 출장 여비 정산)
  category      text,                                  -- 묶음(경비/카드/매입/기타) — 화면 칩 필터
  descr         text,                                  -- 언제 쓰는지 한 줄 설명
  scope         text not null default 'org' check (scope in ('org','dept','user')),
  scope_dept_cd text,
  scope_dept_nm text,
  owner_upn     text,                                  -- 개인 템플릿 소유자(= 작성자)
  -- 헤더 기본값 (적용 시 비어 있는 칸만 채운다 — 사용자가 적은 값을 덮지 않는다)
  gl_type       text default '03',                     -- 실측 상수(C-9)
  cost_cd       text,
  desc_tmpl     text,                                  -- 적요 기본 문구
  ref_hint      text,                                  -- 참조번호 입력 안내(그룹웨어 문서번호 등)
  -- 금액 입력 방식: total = 총액 1칸 입력 후 규칙대로 배분 · manual = 라인별 직접 입력
  amount_mode   text not null default 'total' check (amount_mode in ('total','manual')),
  status        text not null default 'draft' check (status in ('draft','active','archived')),
  erp_case_cd   text,                                  -- ERP_DB 기준 케이스 코드(케이스 확정 시 연결)
  sort_no       integer not null default 100,
  use_cnt       integer not null default 0,            -- 실제로 쓰이는 템플릿을 가려내는 근거
  last_used_at  timestamptz,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_by    text,
  updated_at    timestamptz not null default now(),
  constraint gl_template_scope_ck check (
    (scope = 'org')
    or (scope = 'dept' and scope_dept_cd is not null)
    or (scope = 'user' and owner_upn is not null))
);
comment on table public.gl_template is '결의전표 템플릿 헤더 — 케이스별 분개 형태(계정·배분규칙)를 저장한다. 금액 실적치는 담지 않는다.';

create index if not exists gl_template_scope_idx on public.gl_template (scope, status, sort_no);
create index if not exists gl_template_owner_idx on public.gl_template (owner_upn);

create table if not exists public.gl_template_item (
  tpl_id     bigint not null references public.gl_template(tpl_id) on delete cascade,
  line_seq   smallint not null,
  dr_cr_fg   text not null check (dr_cr_fg in ('D','C')),
  acct_cd    text not null,                            -- 저장 시 acct_master_s 대조(존재하지 않으면 거부)
  acct_nm    text,                                     -- 표시용 사본
  -- 배분 규칙: input=사용자 입력 · pct=총액×비율 · fixed=고정액 · balance=차액 자동
  --   balance 는 방향(차/대)당 1줄까지. 두 줄이면 어느 쪽을 맞출지 정할 수 없다.
  amt_rule   text not null default 'input' check (amt_rule in ('input','pct','fixed','balance')),
  amt_value  numeric,                                  -- pct: 0~100 · fixed: 원 단위 금액
  item_desc  text,
  bp_cd      text,
  bp_nm      text,
  cost_cd    text,
  project_no text,
  vat_type   text,                                     -- 부가세는 U-1 확정 후 사용(현재 미사용)
  acct_lock  boolean not null default false,           -- true면 화면에서 계정 변경 불가(고정 상대계정)
  note       text,
  primary key (tpl_id, line_seq),
  constraint gl_template_item_rule_ck check (
    (amt_rule in ('pct','fixed') and amt_value is not null and amt_value > 0)
    or (amt_rule in ('input','balance') and amt_value is null))
);
comment on table public.gl_template_item is '결의전표 템플릿 라인 — 계정과 금액 배분 규칙. 실제 금액은 적용 시점에 계산된다.';

alter table public.gl_template      enable row level security;
alter table public.gl_template_item enable row level security;
revoke all on public.gl_template, public.gl_template_item from anon, authenticated;
grant select, insert, update, delete on public.gl_template, public.gl_template_item to service_role;
grant usage, select on sequence public.gl_template_seq, public.gl_template_tpl_id_seq to service_role;

-- 감사 로그는 gl_draft_log 를 재사용한다(action: tpl_save · tpl_status · tpl_delete · tpl_use).
