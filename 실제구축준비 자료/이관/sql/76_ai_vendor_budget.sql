-- 76_ai_vendor_budget.sql — AI 벤더(계정) 단위 예산·충전잔액 대장 (REQ-0091 · ADR-111)
--
-- 왜 이 표가 필요한가
--   OpenAI·Anthropic 모두 **잔여 크레딧을 알려주는 API 가 없다**(2026-09-29 문서 실측).
--   사용량·비용 조회 API 만 있다:
--     OpenAI    GET /v1/organization/usage/completions · /v1/organization/costs   (Admin key sk-admin-…)
--     Anthropic GET /v1/organizations/usage_report/messages · /cost_report        (Admin key sk-ant-admin01-…)
--   그래서 「잔여」는 관리자가 적어 둔 예산·충전액에서 **실사용을 빼서 역산**한다.
--   역산이라는 사실과 기준일을 화면에 함께 적는다 — 없는 데이터를 만들어내지 않는다(CLAUDE.md §16.6).
--
-- 에이전트 예산(ai_agent.monthly_budget_usd)과 다른 축이다
--   ai_agent   = "구매 에이전트가 이번 달 얼마까지" (서비스 단위 · 초과 시 예비 모델로 강등)
--   이 표      = "OpenAI 계정이 이번 달 얼마까지 / 충전 잔액이 얼마" (벤더 계정 단위 · 떨어지면 전부 멈춤)
--
-- API 키는 이 표에 담지 않는다. 시크릿은 Supabase Edge Function 시크릿에만 둔다(CLAUDE.md §1.1).

create table if not exists public.ai_vendor_budget (
  vendor              text primary key,                      -- 'openai' | 'anthropic' (소문자 · ai_model.vendor 와 lower() 로 대응)
  label               text not null,
  billing_mode        text not null default 'prepaid_credit', -- prepaid_credit(선불 충전) | postpaid_invoice(후불 청구)
  monthly_budget_usd  numeric(12,2) not null default 0,       -- 0 = 미설정(화면은 「미설정」으로 표시하고 소진율을 계산하지 않는다)
  credit_added_usd    numeric(12,2),                         -- 관리자가 마지막으로 **확인한** 잔액(충전 직후 금액)
  credit_as_of        date,                                   -- 그 잔액을 확인한 날 — 이 날 이후 실사용을 빼서 역산한다
  alert_ratio         numeric(4,3) not null default 0.800,    -- 소진율 경고선(0.8 = 80%)
  console_url         text,                                   -- 벤더 콘솔 주소(화면 링크 · 비밀값 아님)
  note                text,
  updated_by          text,
  updated_at          timestamptz not null default now(),
  constraint ai_vendor_budget_mode_ck check (billing_mode in ('prepaid_credit', 'postpaid_invoice')),
  constraint ai_vendor_budget_ratio_ck check (alert_ratio > 0 and alert_ratio <= 1),
  constraint ai_vendor_budget_budget_ck check (monthly_budget_usd >= 0),
  constraint ai_vendor_budget_credit_ck check (credit_added_usd is null or credit_added_usd >= 0),
  -- 잔액을 적었으면 확인일도 있어야 한다 — 기준일 없는 잔액은 역산할 수 없다
  constraint ai_vendor_budget_credit_asof_ck check ((credit_added_usd is null) = (credit_as_of is null))
);

comment on table public.ai_vendor_budget is
  'AI 벤더(계정) 단위 예산·충전잔액 — 잔여 크레딧 API 가 없어 관리자 입력값에서 실사용을 빼 역산한다(ADR-111). API 키는 담지 않는다. REQ-0091';
comment on column public.ai_vendor_budget.credit_as_of is
  '충전 잔액 확인일. 이 날 00:00(UTC) 이후의 벤더 실사용을 빼서 현재 잔액을 역산한다. 없으면 역산하지 않고 「미확인」으로 표시.';
comment on column public.ai_vendor_budget.monthly_budget_usd is
  '0 이면 미설정 — 화면은 소진율·잔여를 계산하지 않고 「예산 미설정」으로 표시한다.';

alter table public.ai_vendor_budget enable row level security;
-- 정책 없음 = 클라이언트 전면 차단. 조회·저장은 Edge Function(jeil-chat-admin, service_role)만.

-- 초기 2행 — 금액은 0(미설정). 관리자가 콘솔 「💳 AI 비용·예산」 탭에서 채운다.
insert into public.ai_vendor_budget (vendor, label, billing_mode, console_url, note)
values
  ('openai',    'OpenAI',    'prepaid_credit', 'https://platform.openai.com/settings/organization/billing/overview',
   '사용량 조회에는 Admin key(sk-admin-…)가 필요하다 — 호출 키(OPENAI_API_KEY)로는 401.'),
  ('anthropic', 'Anthropic (Claude)', 'prepaid_credit', 'https://platform.claude.com/settings/billing',
   '사용량 조회에는 Admin API key(sk-ant-admin01-…)가 필요하다. 개인 계정은 Admin API 사용 불가 — 조직 설정 필요.')
on conflict (vendor) do nothing;
