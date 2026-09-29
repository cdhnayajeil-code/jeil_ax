-- 77_ai_model_catalog_2026-09.sql — 모델 카탈로그 현행화 (REQ-0056 · REQ-0091 후속 · 관리자 지시 2026-09-29)
--
-- 왜
--   관리자 콘솔의 모델 선택지·추정 단가가 낡아 「고성능 모델」과 「많이 쓰는 모델」을 고를 수 없었다.
--   카탈로그에 있던 것: OpenAI gpt-4o/4o-mini/4.1-mini · Anthropic sonnet-5/haiku-4-5/sonnet-4-6.
--   두 벤더 공식 가격표를 **2026-09-29 직접 확인**한 결과 현행 라인업이 이미 한 세대 더 올라가 있었다.
--     · Anthropic  https://platform.claude.com/docs/en/about-claude/models/overview
--     · OpenAI     https://developers.openai.com/api/docs/pricing · /api/docs/models
--
-- 무엇을 넣지 않았나 — 확인하지 못한 값은 비운다(CLAUDE.md §16.6 없는 데이터를 만들어내지 않는다)
--   OpenAI 공식 가격표는 모델별 컨텍스트 길이를 주지 않는다 → OpenAI 행의 context_k 는 NULL(화면은 「—」).
--   토큰 계수(token_factor)는 **화면의 「질문 1천건 환산」 비교에만** 쓰는 가정값이다.
--   실제 비용 기록(est_cost_usd)은 벤더가 돌려준 실제 토큰 수로 계산하므로 이 값과 무관하다.
--
-- 안전장치 — **신규 행은 active=false** 로 넣는다.
--   active 가 usable 판정(게이트웨이·에이전트 모델 선택)에 직접 들어가므로, 행을 추가하는 것만으로
--   동작이 바뀌면 안 된다. 관리자가 콘솔에서 켜는 순간 선택지가 된다(REQ-0056 열린 질문에 대한 보수적 답).
--   기존 active 행(gpt-4o-mini 기본 · gpt-4.1-mini 예비 등)은 건드리지 않는다.
--
-- 기존 행을 지우지 않는다 — `chat_log.model`·`agent_turn.model` 이 과거 모델명을 참조하고,
--   그 행의 단가가 사라지면 지난 비용 추정이 폴백표로 떨어진다. 이전 세대는 tier='legacy' 로만 표시한다.

begin;

-- ── 1. 컬럼 추가 ──────────────────────────────────────────────────────────────
alter table public.ai_model add column if not exists tier           text;
alter table public.ai_model add column if not exists price_cache_in numeric(10,4);
alter table public.ai_model add column if not exists context_k      integer;
alter table public.ai_model add column if not exists token_factor   numeric(4,2) not null default 1.00;
alter table public.ai_model add column if not exists status_note    text;

alter table public.ai_model drop constraint if exists ai_model_tier_ck;
alter table public.ai_model add constraint ai_model_tier_ck
  check (tier is null or tier in ('flagship', 'workhorse', 'light', 'legacy'));
alter table public.ai_model drop constraint if exists ai_model_token_factor_ck;
alter table public.ai_model add constraint ai_model_token_factor_ck
  check (token_factor > 0 and token_factor <= 3);

comment on column public.ai_model.tier is
  'flagship=고성능 · workhorse=범용(많이 쓰는) · light=경량·대량 · legacy=이전 세대(선택지에서 내림). 화면 묶음 축.';
comment on column public.ai_model.price_cache_in is
  '캐시 읽기 입력 단가(USD/1M). 비우면 코드가 입력 단가의 0.1배로 가정한다 — Fable 5.1(0.025배)·Opus 5.5(0.05배)는 그 가정이 틀리므로 반드시 채운다.';
comment on column public.ai_model.context_k is
  '컨텍스트 창(1,000 토큰 단위). 공식 문서로 확인한 값만 채운다 — 모르면 NULL(화면은 「—」).';
comment on column public.ai_model.token_factor is
  '같은 글을 세는 토큰 수 배율(기준 1.00). 화면의 「질문 1천건 환산」 비교에만 쓰는 가정값이며 실제 비용 기록에는 쓰지 않는다. Claude 4.7 이후 토크나이저는 약 1.30.';

-- ── 2. 기존 행 분류(단가는 건드리지 않는다 — 과거 비용 추정의 근거다) ───────────
update public.ai_model set tier = 'legacy',
       status_note = coalesce(status_note, '이전 세대 — 신규 배정 대상 아님'),
       updated_by = 'sql77', updated_at = now()
 where model_id in ('gpt-4o', 'claude-sonnet-4-6', 'claude-sonnet-5') and tier is null;

-- 지금 실제로 도는 모델은 legacy 로 내리지 않는다(현 기본·예비)
update public.ai_model set tier = 'light', price_cache_in = 0.0750, token_factor = 1.00,
       status_note = '현 운영 기본 모델 — 교체 검토 대상(gpt-6-luna 대비 출력 단가 1.2배)',
       updated_by = 'sql77', updated_at = now()
 where model_id = 'gpt-4o-mini';
update public.ai_model set tier = 'light', price_cache_in = 0.1000, token_factor = 1.00,
       status_note = '부서 에이전트 예비 모델(Claude 키 미등록 시 실제 응답)',
       updated_by = 'sql77', updated_at = now()
 where model_id = 'gpt-4.1-mini';
update public.ai_model set price_cache_in = 1.2500 where model_id = 'gpt-4o' and price_cache_in is null;
update public.ai_model set price_cache_in = 0.3000 where model_id = 'claude-sonnet-4-6' and price_cache_in is null;
update public.ai_model set price_cache_in = 0.2000 where model_id = 'claude-sonnet-5' and price_cache_in is null;
update public.ai_model set tier = 'light', price_cache_in = 0.1000, context_k = 200, token_factor = 1.00,
       status_note = '에이전트 분류·골든셋 채점용. ⚠ 은퇴 예고 — 2026-10-15 이후(Anthropic 공지)',
       updated_by = 'sql77', updated_at = now()
 where model_id = 'claude-haiku-4-5';

-- ── 3. 현행 라인업 추가(전부 active=false — 관리자가 콘솔에서 켠다) ─────────────
--    callable 은 서버가 「어댑터 있는 벤더 + 키 등록」으로 매번 판정하므로 여기 값은 초기값일 뿐이다.
insert into public.ai_model
  (model_id, vendor, label, purpose, tier, price_in, price_cache_in, price_out,
   context_k, token_factor, active, callable, sort, status_note, note, updated_by, updated_at)
values
  -- Anthropic ───────────────────────────────────────────────────────────────
  ('claude-opus-5-5', 'Anthropic', 'Claude Opus 5.5', '고난도 기획·분석·장시간 에이전트 작업', 'flagship',
   4.0000, 0.2000, 20.0000, 1000, 1.30, false, false, 110,
   'Anthropic 권고 기본(대부분 작업). 캐시 읽기 0.05배', '공식표 2026-09-29 확인', 'sql77', now()),
  ('claude-sonnet-5-5', 'Anthropic', 'Claude Sonnet 5.5', '전사 워크호스 — 속도·지능 균형', 'workhorse',
   2.0000, 0.2000, 10.0000, 1000, 1.30, false, false, 120,
   'Sonnet 5 후속. 같은 단가에 성능 개선', '공식표 2026-09-29 확인', 'sql77', now()),
  ('claude-fable-5-1', 'Anthropic', 'Claude Fable 5.1', '최상위 추론·장시간 자율 작업', 'flagship',
   10.0000, 0.2500, 50.0000, 1000, 1.30, false, false, 100,
   '가장 비싸다 — Opus 5.5 로 부족할 때만. 캐시 읽기 0.025배', '공식표 2026-09-29 확인', 'sql77', now()),
  -- OpenAI ──────────────────────────────────────────────────────────────────
  ('gpt-6-astra', 'OpenAI', 'GPT-6 astra', '최상위 — 가장 어려운 end-to-end 작업', 'flagship',
   10.0000, 1.0000, 50.0000, null, 1.00, false, false, 210,
   'OpenAI 플래그십', '공식표 2026-09-29 확인 · 컨텍스트 길이는 공식표 미기재', 'sql77', now()),
  ('gpt-6-sol', 'OpenAI', 'GPT-6 sol', '복잡한 코딩·에이전트 워크플로', 'flagship',
   2.0000, 0.2000, 10.0000, null, 1.00, false, false, 220,
   'Claude Sonnet 5.5 와 동일 단가($2/$10) — 직접 비교 대상', '공식표 2026-09-29 확인', 'sql77', now()),
  ('gpt-6-luna', 'OpenAI', 'GPT-6 luna', '대량·집중 작업(가장 효율적)', 'light',
   0.1000, 0.0100, 0.5000, null, 1.00, false, false, 230,
   '현 기본 gpt-4o-mini 보다 입력 1/1.5·출력 1/1.2 저렴 — 기본 모델 교체 1순위 후보', '공식표 2026-09-29 확인', 'sql77', now()),
  ('gpt-5-mini', 'OpenAI', 'GPT-5 mini', '경량 범용 — 대량 단순 처리', 'workhorse',
   0.2500, 0.0250, 2.0000, null, 1.00, false, false, 240,
   '이전 세대지만 여전히 널리 쓰인다', '공식표 2026-09-29 확인', 'sql77', now()),
  ('gpt-5.4-mini', 'OpenAI', 'GPT-5.4 mini', '중급 범용', 'workhorse',
   0.7500, 0.0750, 4.5000, null, 1.00, false, false, 250,
   'gpt-6-sol 과 gpt-6-luna 사이', '공식표 2026-09-29 확인', 'sql77', now())
on conflict (model_id) do update set
  label = excluded.label, purpose = excluded.purpose, tier = excluded.tier,
  price_in = excluded.price_in, price_cache_in = excluded.price_cache_in, price_out = excluded.price_out,
  context_k = excluded.context_k, token_factor = excluded.token_factor,
  sort = excluded.sort, status_note = excluded.status_note, note = excluded.note,
  updated_by = 'sql77', updated_at = now();
  -- active·callable 은 덮어쓰지 않는다 — 관리자가 켠 상태를 재적용으로 되돌리면 안 된다.

commit;

-- 확인
-- select tier, model_id, vendor, price_in, price_cache_in, price_out, context_k, token_factor, active, callable
--   from public.ai_model order by tier nulls last, sort;

-- ── 4. 보정(적용 중 발견) ─────────────────────────────────────────────────────
--   claude-sonnet-5 는 4.7 이후 토크나이저인데 계수가 1.00 으로 남아 있었다.
--   또 tier='legacy' 이지만 **구매 에이전트 v1 의 기본 모델로 지정돼 있어** 화면에서 오해될 수 있다 — 상태 메모로 밝힌다.
update public.ai_model
   set token_factor = 1.30,
       status_note = '이전 세대(Sonnet 5.5 가 후속) · **구매 에이전트 v1 의 기본 모델로 지정돼 있다** — 키 등록 시 실제 호출된다. 4.7 이후 토크나이저(계수 1.30)',
       updated_by = 'sql77', updated_at = now()
 where model_id = 'claude-sonnet-5';
