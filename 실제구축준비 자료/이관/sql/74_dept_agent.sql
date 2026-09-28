-- 74_dept_agent.sql — 부서 에이전트(프로필·버전·구성원) + 질의응답 누적·개선 대장·골든셋 + 생성 자료
-- 기획: 11_제품기획/14_부서에이전트_운영기획.md (ADR-109) · REQ-0085~0088 · 2026-09-28 관리자 승인(D-87~D-92)
--
-- 원칙
--   · 이 테이블들은 **Edge Function(service_role)만** 읽고 쓴다. RLS 를 켜고 정책을 두지 않는다 → anon/authenticated 접근 0.
--     권한 판정은 게이트웨이(jeil-chat-lab)가 perm_effective + ai_agent_member 로 한다(CLAUDE.md §5.4).
--   · agent_turn 에는 도구 결과 **행 데이터를 넣지 않는다**(건수·결과 유형만). 인사·급여 도구가 낀 턴은 답변을 저장하지 않는다(§1.7).
--   · 보존: agent_turn 180일(ai_agent.retention_days) · 생성 자료 30일 — 삭제는 게이트웨이가 조회 시점에 정리한다.
-- 롤백: 74_dept_agent_rollback.sql

-- ── 1. 에이전트 프로필 ───────────────────────────────────────────────────────
create table if not exists public.ai_agent (
  agent_key          text primary key check (agent_key ~ '^[a-z][a-z0-9_]{1,30}$'),
  name_ko            text not null,
  summary_ko         text,
  icon               text default '🤖',
  dept_nm            text,
  status             text not null default 'pilot' check (status in ('dev','pilot','live','off')),
  current_version    integer,
  daily_limit        integer not null default 50,      -- 1인 1일 질문 수
  monthly_budget_usd numeric(10,2) not null default 150,
  collect_turns      boolean not null default true,     -- D-89: 기본 수집 + 화면 고지
  retention_days     integer not null default 180,
  suggestions        jsonb not null default '[]'::jsonb, -- 화면 「자주 쓰는 질문」 [{label,q}]
  created_at         timestamptz not null default now(),
  updated_by         text,
  updated_at         timestamptz not null default now()
);

-- ── 2. 설정 버전(저장할 때마다 1행 · 수정 대신 새 버전) ─────────────────────────
create table if not exists public.ai_agent_version (
  agent_key          text not null references public.ai_agent(agent_key) on delete cascade,
  version            integer not null,
  state              text not null default 'draft' check (state in ('draft','current','retired')),
  model_id           text not null,
  fallback_model_id  text,
  effort             text check (effort in ('low','medium','high','xhigh','max')),
  max_tokens         integer not null default 2048 check (max_tokens between 256 and 16000),
  temperature        numeric(3,2),                       -- 벤더가 허용할 때만 전송(Claude Sonnet 5 는 미지원)
  prompt_caching     boolean not null default true,
  role_prompt        text not null default '',
  answer_rules       text not null default '',
  modules            jsonb not null default '{}'::jsonb, -- {"domains":[...],"off":[...]}
  max_tool_rounds    integer not null default 4 check (max_tool_rounds between 1 and 8),
  note               text,
  golden_pass        integer,
  golden_total       integer,
  golden_run_at      timestamptz,
  created_by         text,
  created_at         timestamptz not null default now(),
  approved_by        text,
  approved_at        timestamptz,
  primary key (agent_key, version)
);
create unique index if not exists ux_agent_version_current on public.ai_agent_version(agent_key) where state = 'current';

-- ── 3. 구성원 — operator(실작업) · reviewer(확인·점검·승인) ────────────────────
create table if not exists public.ai_agent_member (
  agent_key   text not null references public.ai_agent(agent_key) on delete cascade,
  upn         text not null check (upn = lower(upn) and upn like '%@jeilm.co.kr'),
  role        text not null check (role in ('operator','reviewer')),
  added_by    text,
  added_at    timestamptz not null default now(),
  primary key (agent_key, upn)
);

-- ── 4. 턴 기록(사용자에게 보이지 않음 · 품질 개선용) ───────────────────────────
create table if not exists public.agent_turn (
  id                 bigint generated always as identity primary key,
  agent_key          text not null references public.ai_agent(agent_key) on delete cascade,
  agent_version      integer,
  upn                text not null,
  dept_nm            text,
  created_at         timestamptz not null default now(),
  question           text not null,
  answer             text,                                -- 인사·급여 도구가 낀 턴은 null
  tools              jsonb not null default '[]'::jsonb,  -- [{tool,args,ms,outcome,rows}] — 결과 행 데이터 없음
  model              text,
  fallback_used      boolean not null default false,
  prompt_tokens      integer,
  completion_tokens  integer,
  cache_read_tokens  integer,
  est_cost_usd       numeric(12,6),
  latency_ms         integer,
  rounds             integer,
  flags              text[] not null default '{}',
  rating             smallint check (rating in (-1, 1)),
  rating_note        text,
  rated_at           timestamptz,
  chat_log_id        bigint,
  golden_run_id      bigint                               -- 회귀 시험 턴이면 채워진다(사용량·개선 대장에서 제외)
);
create index if not exists ix_agent_turn_agent_time on public.agent_turn(agent_key, created_at desc);
create index if not exists ix_agent_turn_upn_time   on public.agent_turn(upn, created_at desc);

-- ── 5. 개선 대장(백로그형) ────────────────────────────────────────────────────
create table if not exists public.agent_improve (
  id               bigint generated always as identity primary key,
  agent_key        text not null references public.ai_agent(agent_key) on delete cascade,
  status           text not null default 'inbox' check (status in ('inbox','triage','planned','applied','verified','wontfix')),
  source           text not null default 'auto' check (source in ('auto','thumbs_down','owner')),
  turn_ids         bigint[] not null default '{}',
  category         text check (category in ('prompt','glossary','new_module','data_gap','golden','model','none')),
  summary          text not null,
  proposal         text,
  applied_version  integer,
  req_id           text,
  owner_upn        text,
  reviewed_by      text,
  reviewed_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  resolved_at      timestamptz
);
create index if not exists ix_agent_improve_agent_status on public.agent_improve(agent_key, status);

-- ── 6. 용어집 ────────────────────────────────────────────────────────────────
create table if not exists public.agent_glossary (
  id          bigint generated always as identity primary key,
  agent_key   text not null references public.ai_agent(agent_key) on delete cascade,
  term        text not null,
  meaning     text not null,
  active      boolean not null default true,
  created_by  text,
  created_at  timestamptz not null default now(),
  unique (agent_key, term)
);

-- ── 7. 골든셋(회귀 시험 문항) + 실행 기록 ─────────────────────────────────────
create table if not exists public.agent_golden (
  id              bigint generated always as identity primary key,
  agent_key       text not null references public.ai_agent(agent_key) on delete cascade,
  question        text not null,
  expect_tools    text[] not null default '{}',
  expect_rules    text,
  source_turn_id  bigint,
  active          boolean not null default true,
  created_by      text,
  created_at      timestamptz not null default now()
);
create table if not exists public.agent_golden_run (
  id           bigint generated always as identity primary key,
  agent_key    text not null references public.ai_agent(agent_key) on delete cascade,
  version      integer not null,
  started_by   text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  pass         integer not null default 0,
  total        integer not null default 0,
  cost_usd     numeric(12,6) not null default 0,
  results      jsonb not null default '[]'::jsonb        -- [{golden_id,pass,tools,judge,why}]
);

-- ── 8. 생성 자료(파일은 Storage agent-artifacts/<upn>/…) ──────────────────────
create table if not exists public.agent_artifact (
  id            uuid primary key default gen_random_uuid(),
  agent_key     text not null references public.ai_agent(agent_key) on delete cascade,
  upn           text not null,
  turn_id       bigint,
  title         text not null,
  kind          text not null check (kind in ('csv','html')),
  storage_path  text not null unique,
  size_bytes    integer,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '30 days'
);
create index if not exists ix_agent_artifact_upn on public.agent_artifact(upn, created_at desc);

-- ── 9. 접근 차단(service_role 전용) ──────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['ai_agent','ai_agent_version','ai_agent_member','agent_turn','agent_improve',
                           'agent_glossary','agent_golden','agent_golden_run','agent_artifact'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ── 10. Storage 버킷(비공개 · CSV/HTML · 5MB) ────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('agent-artifacts', 'agent-artifacts', false, 5242880, array['text/csv','text/html'])
on conflict (id) do nothing;

-- ── 11. 모델 카탈로그 — Claude Sonnet 5(부서 에이전트 기본) · Haiku 4.5(분류·채점) ──
--   운영 jeil-chat 은 벤더 openai 만 호출하므로(usableModels) 이 두 행은 운영 챗봇에 영향이 없다.
insert into public.ai_model (model_id, vendor, label, purpose, price_in, price_out, active, callable, sort, note, updated_by, updated_at)
values ('claude-sonnet-5', 'Anthropic', 'Claude Sonnet 5', '부서 에이전트 기본', 2.0000, 10.0000, true, false, 5,
        '부서 에이전트(jeil-chat-lab) 전용 — ANTHROPIC_API_KEY 등록 시 호출. 운영 jeil-chat 은 미사용', 'sql74', now())
on conflict (model_id) do update set active = true, price_in = excluded.price_in, price_out = excluded.price_out,
  label = excluded.label, purpose = excluded.purpose, note = excluded.note, updated_by = 'sql74', updated_at = now();
update public.ai_model set active = true, purpose = coalesce(nullif(purpose, ''), '개선 대장 분류·골든셋 채점'),
       note = '부서 에이전트 분류·채점용(jeil-chat-lab) — 운영 jeil-chat 은 미사용', updated_by = 'sql74', updated_at = now()
 where model_id = 'claude-haiku-4-5';

-- ── 12. 기안서 대사 — 게이트웨이용 래퍼(service_role 전용) ─────────────────────
--   proposal_recon_list() 는 auth.jwt() 의 email 로 권한을 판정한다. 게이트웨이는 Entra 토큰만 가지고 있어
--   Supabase 세션이 없으므로, 검증된 upn 을 이 트랜잭션 한정 클레임으로 넣고 **같은 함수**를 부른다.
--   권한 판정(perm_effective 의 purchase_proposal_2026 페이지 권한)은 원 함수가 그대로 한다 — 로직 복제 없음.
create or replace function public.agent_proposal_recon(p_upn text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if coalesce(p_upn, '') !~ '^[a-z0-9._-]+@jeilm\.co\.kr$' then
    raise exception 'invalid upn' using errcode = '22023';
  end if;
  perform set_config('request.jwt.claims',
    jsonb_build_object('email', p_upn, 'app_metadata', jsonb_build_object('role', 'internal'))::text, true);
  return public.proposal_recon_list();
end $function$;
revoke all on function public.agent_proposal_recon(text) from public, anon, authenticated;
grant execute on function public.agent_proposal_recon(text) to service_role;

-- ── 13. 1호 에이전트 — 구매 ──────────────────────────────────────────────────
insert into public.ai_agent (agent_key, name_ko, summary_ko, icon, dept_nm, status, current_version, suggestions, updated_by)
values ('purchase', '구매 에이전트', '발주·구매요청·입고·매입·기안서 대장을 대화로 조회하고 자료를 만든다', '🛒', '구매팀', 'pilot', 1,
  '[{"label":"미입고(납기경과)","q":"납기 지난 미입고 발주를 거래처별로 보여줘"},
    {"label":"발주 top 10","q":"발주 금액 top 10 보여줘"},
    {"label":"이번 달 발주","q":"이번 달 발주 현황 알려줘"},
    {"label":"거래처 매입 순위","q":"올해 거래처별 매입 순위 보여줘"},
    {"label":"기안서 대사 확인필요","q":"기안서 대장에서 ERP 전표와 금액이 안 맞는 건 보여줘"},
    {"label":"거래처 한 장 요약","q":"거래처 프로필 보여줘 — 거래처명을 물어봐줘"}]'::jsonb, 'sql74')
on conflict (agent_key) do nothing;

insert into public.ai_agent_version (agent_key, version, state, model_id, fallback_model_id, effort, max_tokens,
  prompt_caching, role_prompt, answer_rules, modules, note, created_by, approved_by, approved_at)
values ('purchase', 1, 'current', 'claude-sonnet-5', 'gpt-4.1-mini', 'medium', 2048, true,
  '당신은 제일엠앤에스 구매팀의 업무 에이전트입니다. 구매팀 실무자가 발주·구매요청·입고·매입·기안서 대장·거래처 상황을 빠르게 파악하고 보고 자료를 만들도록 돕습니다.',
  E'- 수치는 반드시 도구 결과만 쓰고, 도구에 없는 숫자를 만들지 마세요. 합계·순위는 도구가 준 값을 그대로 인용하세요.\n'
  || E'- 금액은 원 단위 콤마로, 날짜는 YYYY-MM-DD 로 씁니다. 답변 첫 줄에 결론을 한 문장으로 쓰세요.\n'
  || E'- 발주 확정·구매요청 승인·기안 상신·메일 발송 같은 실거래는 하지 않습니다. 필요하면 초안만 만들고 ERP·그룹웨어에서 담당자가 처리하도록 안내하세요.\n'
  || E'- 조건이 모호하면(거래처·기간·품목) 한 번만 짧게 되묻고, 합리적인 기본값(이번 달·최근 3개월)을 제안하세요.\n'
  || E'- 보고서·자료를 요청받으면 표는 화면 카드가 담당하니, 요약·특이사항·조치 제안 중심으로 쓰세요.',
  '{"domains":["purchase","item","portal","common","docs"],"off":[]}'::jsonb,
  '초기 설정(14 기획 · D-87~D-92)', 'sql74', 'sql74', now())
on conflict (agent_key, version) do nothing;

insert into public.ai_agent_member (agent_key, upn, role, added_by)
values ('purchase', 'dh.choi@jeilm.co.kr', 'reviewer', 'sql74')
on conflict do nothing;

insert into public.agent_glossary (agent_key, term, meaning, created_by) values
  ('purchase', 'PU번호', '그룹웨어 결재번호. ERP 구매요청의 확장 슬롯 M_PUR_REQ.EXT1_CD 에 적힌다.', 'sql74'),
  ('purchase', '미입고', '발주는 됐으나 입고수량이 발주수량보다 적은 라인. 납기가 지났으면 「납기경과 미입고」.', 'sql74'),
  ('purchase', '매입', '송장(IV) 기준 집계. 발주 상태 IV 는 그 발주의 매입완료 표시일 뿐 매입 집계와 합산하지 않는다.', 'sql74'),
  ('purchase', '기안서 대장', '구매팀 엑셀 대장(선급·중도·잔금 전표번호 칸). ERP 전표·세금계산서와 칸 단위로 대사한다.', 'sql74')
on conflict do nothing;
