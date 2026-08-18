-- 23. 관리항목 코드 마스터 2종 미러 + erp_master_upsert 확장 (반복전표 자동화 v2 — B1 승인 2026-08-11)
-- 적용: 마이그레이션 `gl_ctrl_master_v1` (2026-08-11, Supabase MCP)
-- 원천: A_CTRL_ITEM(관리항목 52행) · A_ACCT_CTRL_ASSN(계정별 관리항목 요건 997행)
-- 규약: 회계 마스터 기존 2종(acct_master_s·cost_center_s)과 동일 — RLS ON·정책 0(fail-closed),
--       anon/authenticated 회수, 적재는 erp_master_upsert(service_role) 단일 경로. 코드/설정 마스터만(C-7 유지).
-- 기획: 10_ERP_DB연계/10_반복전표_자동화_기획.md §6.3·§6.5

create table if not exists erp_ro.ctrl_item_s (
  ctrl_cd        text primary key,
  ctrl_nm        text,
  ctrl_eng_nm    text,
  sys_fg         text,
  colm_data_type text,          -- 값 데이터형(입력 위젯 결정용)
  data_len       integer,
  ref_tbl        text,          -- 참조 테이블(TBL_ID — 값 검증·룩업 근거)
  major_cd       text,
  gl_ctrl_fld    text,
  desc_fg        text,
  src_updated    timestamptz,
  synced_at      timestamptz not null default now(),
  batch_id       uuid
);
comment on table erp_ro.ctrl_item_s is 'ERP 관리항목 마스터 미러(A_CTRL_ITEM) — 결의전표 라인 관리항목 자동 생성의 코드 사전. 코드 마스터만.';

create table if not exists erp_ro.acct_ctrl_assn_s (
  acct_cd          text not null,
  ctrl_cd          text not null,
  ctrl_item_seq    integer,      -- ERP 입력 순서(회계 담당자 요약 정렬 기준)
  dr_fg            text,         -- 차변 필수 플래그(Y/N)
  cr_fg            text,         -- 대변 필수 플래그(Y/N)
  default_gl_field text,
  default_value    text,
  sys_fg           text,
  src_updated      timestamptz,
  synced_at        timestamptz not null default now(),
  batch_id         uuid,
  primary key (acct_cd, ctrl_cd)
);
comment on table erp_ro.acct_ctrl_assn_s is 'ERP 계정별 관리항목 요건 미러(A_ACCT_CTRL_ASSN) — 계정 선택 시 관리항목 필드 자동 생성·필수(플래그 Y) 검증 근거.';

alter table erp_ro.ctrl_item_s enable row level security;
alter table erp_ro.acct_ctrl_assn_s enable row level security;
revoke all on erp_ro.ctrl_item_s from anon, authenticated;
revoke all on erp_ro.acct_ctrl_assn_s from anon, authenticated;

-- erp_master_upsert 확장 — 기존 2분기(acct_master_s·cost_center_s) 유지 + 신규 2분기 추가
-- (전체 정의는 마이그레이션 gl_ctrl_master_v1 참조 — 기존 분기 원문 보존, 신규 분기만 발췌)
--   elsif p_table = 'ctrl_item_s' then
--     insert into erp_ro.ctrl_item_s (ctrl_cd, ctrl_nm, ctrl_eng_nm, sys_fg, colm_data_type, data_len,
--                                     ref_tbl, major_cd, gl_ctrl_fld, desc_fg, src_updated, synced_at, batch_id)
--     ... on conflict (ctrl_cd) do update ...
--   elsif p_table = 'acct_ctrl_assn_s' then
--     insert into erp_ro.acct_ctrl_assn_s (acct_cd, ctrl_cd, ctrl_item_seq, dr_fg, cr_fg,
--                                          default_gl_field, default_value, sys_fg, src_updated, synced_at, batch_id)
--     ... on conflict (acct_cd, ctrl_cd) do update ...

-- [2026-08-12 후속] B1 실적재 완료(관리자 지시) — ctrl_item 52/52 · acct_ctrl_assn 1,002/1,002(필수 플래그 Y 377행),
--   batch_run success 2건(유실 0). erp_load_scope에 accounting/ctrl_item·acct_ctrl_assn 'loaded' 등재.
--   연동 현황 뷰 14→16종 확장(마이그레이션 `erp_sync_overview_ctrl_master`) — fail-closed 규약에 따라 batch_run 기반 count.

-- 부수 등재(같은 날, DDL 아님 — 기록용):
-- ① gl_period_lock: ERP 월마감(C_CLOSE_STATUS, CLOSE_FLAG='Y') 연동으로 2023-10 ~ 2026-06 33개월 locked=true 등재 (B2-1)
--    ⚠ ERP 실측상 마감월에도 결의전표(A_TEMP_GL) 소급 등록이 관찰됨 — 포털이 ERP보다 엄격해지며, 예외는 회계 담당이 lock 해제로 처리
--    ⚠ 재동기화 수동: 새 달이 마감되면 gl_period_lock에 해당 월 추가 필요(자동 동기 job은 후속 과제)
-- ② perm_module_catalog: 'accounting'(회계/결의전표 입력, sensitive=true) 신설 — A3 모듈 신설의 실행(B3)
-- ③ perm_grant: hh.lee2@jeilm.co.kr 에 erp_module/accounting allow (B3 파일럿 — 이훈희·최동혁), perm_audit 기록 동반
