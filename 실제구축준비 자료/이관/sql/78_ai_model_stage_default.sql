-- 78_ai_model_stage_default.sql — 단계별 권장 모델 + 기본 모델 교체 + Haiku 표기 정정
--   (관리자 지시 2026-09-29: 「단계별로 합리적인 모델을 보여주고 · 기본모델 변경적용 · 하이쿠 대체 반영」)
--
-- ① 정정 — Haiku 4.5 는 은퇴 예고 상태가 **아니다**
--   SQL 77 에서 `claude-haiku-4-5` 에 「⚠ 은퇴 예고 — 2026-10-15 이후」라고 적었는데 이는 **오독**이었다.
--   공식 폐기 목록(2026-09-29 확인)은 `claude-haiku-4-5-20251001` 을 **Active · Deprecated N/A** 로 두고,
--   "Not sooner than October 15, 2026" 은 **은퇴 공지가 아니라 「그 전에는 은퇴하지 않는다」는 보장 기한**이다.
--   실제 은퇴 시 Anthropic 은 **최소 60일 전 통지**하며, 지금도 Haiku 4.5 를 「최저 지연·최저 단가」 모델로 권장한다.
--   → 문구를 사실대로 고친다.
--
-- ② 단계(stage) — 「무슨 일에 무슨 모델」을 화면이 보여 줄 수 있게 단계와 권장 표시를 둔다.
--   1 일상 조회·간단 질의(대량) / 2 분류·채점(내부 자동화) / 3 부서 업무 질의·분석(워크호스)
--   4 고난도 기획·장시간 작업 / 5 최상위(예외)
--   `recommended` 는 그 단계의 권장 1순위다. 단계·권장은 **판정에 쓰이지 않는다** — 화면 안내용이다.
--   실제 동작은 여전히 `active`(켜짐) + `callable`(어댑터+키) + 배정(기본모델·라우팅·에이전트 버전)이 정한다.
--
-- ③ 기본 모델 교체 — gpt-4o-mini → **gpt-6-luna**
--   같은 「경량」 자리에서 입력 $0.15→$0.10 · 출력 $0.60→$0.50 이고 세대가 위다(2026-09-29 공식표).
--   ⚠ 요청 파라미터 모양이 세대마다 다를 수 있어(temperature 거부·max_completion_tokens) 게이트웨이에
--   **자동 적응 로직**을 함께 넣었다(`jeil-chat`·`jeil-chat-lab/llm/openai.ts`) — 400 사유를 읽어 고쳐 재시도한다.
--   되돌리려면 `ai_gateway_config.default_model` 을 'gpt-4o-mini' 로 되돌리면 된다(행은 그대로 살아 있다).

begin;

alter table public.ai_model add column if not exists stage       smallint;
alter table public.ai_model add column if not exists recommended boolean not null default false;

alter table public.ai_model drop constraint if exists ai_model_stage_ck;
alter table public.ai_model add constraint ai_model_stage_ck check (stage is null or stage between 1 and 5);

comment on column public.ai_model.stage is
  '용도 단계 1~5(1 일상조회 · 2 분류채점 · 3 부서업무 · 4 고난도 · 5 최상위). 화면 안내용이며 판정에 쓰이지 않는다.';
comment on column public.ai_model.recommended is
  '그 단계의 권장 1순위. 화면 배지용 — 실제 배정은 기본모델·라우팅·에이전트 버전이 정한다.';

-- ── ① Haiku 4.5 문구 정정 ─────────────────────────────────────────────────────
update public.ai_model
   set status_note = '최저 지연·최저 단가 모델(Anthropic 권장). 상태 **Active** — 은퇴 공지 없음. '
                     || '보장 기한 2026-10-15(그 전에는 은퇴하지 않는다는 약속이며 은퇴일이 아니다 · 은퇴 시 60일 전 통지). '
                     || '채점·분류 자리에서는 gpt-6-luna 가 10배 싸 뒤로 밀렸다',
       updated_by = 'sql78', updated_at = now()
 where model_id = 'claude-haiku-4-5';

-- ── ② 단계·권장 지정 ──────────────────────────────────────────────────────────
update public.ai_model set stage = 1, recommended = false, updated_by = 'sql78', updated_at = now()
 where model_id in ('gpt-4o-mini', 'gpt-4.1-mini');
update public.ai_model set stage = 1, recommended = true,  updated_by = 'sql78', updated_at = now()
 where model_id = 'gpt-6-luna';                                    -- 1단계 권장 = 새 기본 모델
update public.ai_model set stage = 2, recommended = false, updated_by = 'sql78', updated_at = now()
 where model_id = 'claude-haiku-4-5';                              -- 2단계 대안(단가 10배)
update public.ai_model set stage = 3, recommended = true,  updated_by = 'sql78', updated_at = now()
 where model_id = 'claude-sonnet-5-5';                             -- 3단계 권장(현 에이전트 기본 sonnet-5 의 후속)
update public.ai_model set stage = 3, recommended = false, updated_by = 'sql78', updated_at = now()
 where model_id in ('gpt-6-sol', 'gpt-5-mini', 'gpt-5.4-mini', 'claude-sonnet-5', 'claude-sonnet-4-6', 'gpt-4o');
update public.ai_model set stage = 4, recommended = true,  updated_by = 'sql78', updated_at = now()
 where model_id = 'claude-opus-5-5';                               -- 4단계 권장(Anthropic 권고 기본)
update public.ai_model set stage = 5, recommended = false, updated_by = 'sql78', updated_at = now()
 where model_id in ('claude-fable-5-1', 'gpt-6-astra');            -- 5단계는 권장 없음(예외 사용)

-- ── ③ 권장 모델 활성화 ────────────────────────────────────────────────────────
--   $10/$50 최상위 2종(fable-5-1 · gpt-6-astra)은 **켜지 않는다** — 토글 하나로 청구가 튀는 자리는 사람이 직접 켠다.
update public.ai_model set active = true, updated_by = 'sql78', updated_at = now()
 where model_id in ('gpt-6-luna', 'claude-sonnet-5-5', 'claude-opus-5-5');

-- ── ④ 기본 모델 교체 ──────────────────────────────────────────────────────────
--   교체 전 값을 메모에 남긴다(되돌릴 근거).
update public.ai_gateway_config
   set default_model = 'gpt-6-luna', updated_by = 'sql78', updated_at = now()
 where id = 1
   and exists (select 1 from public.ai_model
                where model_id = 'gpt-6-luna' and active and vendor ilike 'openai');  -- 켜져 있고 OpenAI(키 등록됨)일 때만

commit;

-- 확인
-- select stage, recommended, model_id, tier, price_in, price_out, active from public.ai_model
--   where stage is not null order by stage, recommended desc, price_in;
-- select default_model from public.ai_gateway_config where id = 1;

-- ── ⑤ 보정(적용 중 발견 · 중요) ───────────────────────────────────────────────
--   ④ 만으로는 기본 모델 교체가 **실제로 먹지 않는다.**
--   운영 챗봇(`jeil-chat`)은 DB 의 `callable` 컬럼을 그대로 보고 판정한다:
--     usable = active && callable && vendor='openai'   (index.ts 370~373)
--   SQL 77 이 신규 행을 callable=false 로 넣었으므로 gpt-6-luna 가 usable 에 들지 못하고
--   pickModel 이 조용히 다른 모델로 떨어진다(오류도 나지 않는다 — 그래서 눈에 안 띈다).
--   OPENAI_API_KEY 는 등록돼 있으니 OpenAI 행의 callable=true 가 사실이다.
--   Anthropic 행은 키가 없어 false 를 유지한다 — 키 등록 후 관리자 콘솔 「모델 저장」이
--   서버 판정(vendorCallable: 어댑터+키)으로 켠다.
update public.ai_model set callable = true, updated_by = 'sql78', updated_at = now()
 where vendor ilike 'openai' and callable = false;

-- callable 을 고친 뒤 기본 모델 교체를 다시 시도한다(④ 가 조건 미충족으로 건너뛰었을 수 있다)
update public.ai_gateway_config
   set default_model = 'gpt-6-luna', updated_by = 'sql78', updated_at = now()
 where id = 1
   and exists (select 1 from public.ai_model
                where model_id = 'gpt-6-luna' and active and callable and vendor ilike 'openai');
