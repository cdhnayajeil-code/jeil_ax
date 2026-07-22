-- ============================================================================
-- 18_portal_request.sql — 포털 요청 원장(챗봇 조회불가 → 사용자 요청 접수) v1
-- 설계 정본: 11_제품기획/11_챗봇_데이터요청접수_설계.md (ADR-011)
-- 적용일: 2026-07-22 · 마이그레이션명: portal_request_v1
--
-- 원칙
--  - RLS 전면차단(정책 0) + Edge Function(service_role) 전용 — chat_* 테이블 패턴 계승.
--  - 요청자는 JWT에서만 취득(본문 무시), 대상 정당성은 접수 시 perm_effective() 재판정으로 검증.
--  - 개인정보 최소화: 질문 원문·민감값 저장 금지. target_detail 은 도구명·인자 "요약"만.
--  - 권한 부여·ETL 확대 실행은 이 원장이 하지 않는다(관리자 화면의 별도 클릭) — CLAUDE.md §1.6·§5.4.
-- ============================================================================

-- 1) 접수번호 시퀀스 (REQ-YYYY-0001 …, 연도 리셋 없음 — 전역 유일)
create sequence if not exists public.portal_request_no_seq;

-- 2) 요청 원장
create table if not exists public.portal_request (
  id            bigserial primary key,
  req_no        text unique not null
                default ('REQ-' || to_char(now() at time zone 'Asia/Seoul', 'YYYY') || '-'
                         || lpad(nextval('public.portal_request_no_seq')::text, 4, '0')),
  kind          text not null
                check (kind in ('perm','perm_sensitive','data','doc','feature','quality')),
  status        text not null default 'open'
                check (status in ('open','ack','doing','done','rejected','duplicate','cancelled')),

  requester_upn  text not null,
  requester_dept text,

  target_module text,                                  -- perm: erp_module / data: 대상·기간 / doc: 경로
  target_detail jsonb not null default '{}'::jsonb,    -- {tool, args_digest, module_ko, …} 개인정보 미포함
  reason        text not null,
  urgency       text not null default 'normal' check (urgency in ('normal','high')),

  supporters    text[] not null default '{}'::text[],  -- 동조자 upn(중복 자동 병합)
  dup_of        bigint references public.portal_request(id),

  assignee_upn  text,
  handled_note  text,                                  -- 처리·반려 사유(요청자에게 그대로 노출)
  needs_vendor_review boolean not null default false,  -- data 유형: 유니포인트 협의 필요

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  acked_at      timestamptz,
  closed_at     timestamptz
);

comment on table public.portal_request is
  '포털 요청 원장 — 챗봇 조회불가(권한·데이터·문서·기능)에서 사용자가 접수. RLS 전면차단, Edge Fn(jeil-portal-request, service_role) 전용. 설계: 11_제품기획/11(ADR-011).';
comment on column public.portal_request.target_detail is
  '요청 컨텍스트 요약 — 막힌 도구명·인자 요약·모듈 한글명 등. 질문 원문·개인정보·민감값 저장 금지.';
comment on column public.portal_request.supporters is
  '동조자 upn 배열 — 동일 (kind,target_module,dept) 요청은 새 행 대신 여기에 누적(개인 예외 남발 대신 부서축 일괄 부여 판단 근거).';
comment on column public.portal_request.handled_note is
  '처리·반려 사유 — 요청자에게 그대로 노출되므로 민감 정보 기재 금지.';

create index if not exists portal_request_status_ix
  on public.portal_request (status, kind, created_at desc);
create index if not exists portal_request_requester_ix
  on public.portal_request (requester_upn, created_at desc);
-- 중복 병합 탐지용(진행 중 건 한정)
create index if not exists portal_request_open_key_ix
  on public.portal_request (kind, target_module, requester_dept)
  where status in ('open','ack','doing');

-- 3) updated_at 자동 갱신
create or replace function public.portal_request_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists portal_request_touch_tg on public.portal_request;
create trigger portal_request_touch_tg
  before update on public.portal_request
  for each row execute function public.portal_request_touch();

-- 4) RLS 전면차단 — 정책을 만들지 않는다(= 익명·인증 사용자 모두 접근 불가).
--    유일한 경로는 Edge Function(service_role). REST 직접 조회 차단.
alter table public.portal_request enable row level security;
revoke all on public.portal_request from anon, authenticated;
revoke all on sequence public.portal_request_no_seq from anon, authenticated;

-- 5) 검증
--   select tablename, rowsecurity from pg_tables where tablename='portal_request';
--   select count(*) from pg_policies where tablename='portal_request';   -- 0 이어야 정상(전면차단)
