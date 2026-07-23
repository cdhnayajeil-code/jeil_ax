-- 19. 중간DB 적재범위 레지스트리 (erp_load_scope)
-- 정본. 적용 마이그레이션: erp_load_scope_v1 (2026-07-23)
-- 설계: 11_제품기획/11_챗봇_데이터요청접수_설계.md §14-4a·§15
--
-- 목적: 코드에 문자열로 흩어져 있던 "무엇이 어디까지 적재됐나"를 데이터로 승격한다.
--   ① 챗봇 카드의 결측 배지  ② 데이터 요청의 완료 게이트  ③ 요청함 「미연계 항목 현황」
--   세 곳이 모두 이 표 하나를 본다 → 안내 문구를 바꾸려고 Edge Function을 재배포하지 않는다.
-- 보안: chat_* 패턴 계승(RLS 켜고 정책 0 + anon/authenticated 회수) → Edge Function(service_role) 전용.
--   erp_source 에 ERP 내부 테이블명이 담기므로 사용자 화면에 노출하지 않는다(관리자 요청함에서만).

create table if not exists public.erp_load_scope (
  id           bigserial primary key,
  module       text not null,                       -- dept_erp_scope 와 동일 키
  field_key    text not null,                       -- 컬럼 키. '*' = 모듈 전체(주로 적재 기간)
  label_ko     text not null,
  state        text not null default 'none'
               check (state in ('loaded','partial','none')),
  gap_label    text,                                -- 화면 배지 문구('미적재'·'미연계'·'기간제한')
  gap_why      text,                                -- 왜 없는지(툴팁)
  fix_type     text check (fix_type in ('period','column','table')),   -- 담당자 작업 유형 = 요청 묶음 축
  erp_source   text,                                -- 원천 ERP 테이블(내부정보)
  period_from  date,
  period_to    date,
  expandable   boolean not null default true,       -- 확대 가능 여부(원천에 아예 없으면 false)
  note         text,
  updated_at   timestamptz not null default now(),
  unique (module, field_key)
);

create index if not exists erp_load_scope_module_idx on public.erp_load_scope (module, state);

alter table public.erp_load_scope enable row level security;
revoke all on public.erp_load_scope from anon, authenticated;

-- 시드는 2026-07-23 실측 기준(추정값 없음). 상태 변경은 관리자 콘솔 「미연계 항목 현황」 또는 이 파일 갱신.
-- (시드 INSERT 본문은 마이그레이션 erp_load_scope_v1 참조 — 재적용 시 on conflict do nothing)
