-- ============================================================================
-- 52_erp_role_cleanup.sql — ERP 권한 정리(제외 요청) 장부 + 팀장 판정 수정
-- REQ-0057 후속 · 2026-09-18
--
-- 목적
--   각 팀장·부서장이 자기 팀 권한을 훑어 "이건 빼자"를 표시하고, 관리자가 그 요청을 모아 본다.
--   ⚠ ERP 에서 실제로 회수하지는 않는다 — 회수는 사람이 실행한다(CLAUDE.md §1.6).
--     이 표는 **정리 요청 장부**이고, 실제 회수 뒤 관리자가 '처리완료'로 표시한다.
--
-- 화면
--   /work/erp-roles  「권한정리」 탭 — 팀장·부서장이 매트릭스에서 체크 → 담기 → 확인 문구 → 저장
--   /admin/role-cleanup           — 관리자가 조직별로 모아 보고 상태를 바꾼다
--
-- 오조작 방지
--   · 확인 문구 「권한확인 완료」 를 정확히 입력해야 저장된다(서버가 검사한다)
--   · 저장자 이름은 **서버가 붙인다** — 화면이 보낸 이름은 쓰지 않는다
--   · 대상이 정말 그 부서 사람이고 그 역할을 갖고 있는지 서버가 다시 확인한다
--   · 같은 대상·같은 역할의 미처리 요청은 하나만 살아 있다(부분 unique 인덱스)
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────
-- §1. 팀장 판정 수정 (관리자 지적 — 사업관리팀 홍대기)
--   그룹웨어 position_nm 은 '직급 직책' 2토큰인데 종전에는 **둘째(직책)만** 봤다.
--   홍대기는 '팀장 팀원' — 직급이 팀장인데 직책이 팀원으로 등록돼 있어 팀원으로 보였다.
--   둘 중 하나라도 리더 직함이면 리더로 본다.
--   실측(2026-09-18): 이 규칙으로 부서당 리더가 정확히 1명씩 잡힌다. 제일엠앤에스만 2명(공동대표).
--   → erp_ro.v_dept_member 의 gw_title 식만 바꾼다. 컬럼 구성은 그대로다(50번 파일에 반영).
--     case
--       when split_part(position_nm,' ',1) in ('대표','부문장','법인장','팀장') then 그 값
--       when split_part(position_nm,' ',2) in (...)                            then 그 값
--       else nullif(split_part(position_nm,' ',2),'')   -- 종전과 동일(직책)
--     end
-- ─────────────────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────────────────
-- §2. 장부
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.role_cleanup (
  id               bigint generated always as identity primary key,
  batch_id         uuid not null,                 -- 한 번 저장 = 한 묶음
  org_change_id    text not null,
  dept_cd          text not null,
  dept_nm          text,
  email            text not null,                 -- 대상자
  emp_nm           text,
  role_id          text not null,
  role_nm          text,
  action           text not null default 'exclude',
  status           text not null default 'requested',
  confirm_text     text not null,                 -- 「권한확인 완료」 원문 보관(증빙)
  note             text,
  requested_by     text not null,                 -- 저장자 UPN (서버가 채움)
  requested_by_nm  text,                          -- 저장자 이름 (서버가 채움)
  requested_at     timestamptz not null default now(),
  applied_by       text,
  applied_at       timestamptz,
  constraint rc_action_chk check (action in ('exclude')),
  constraint rc_status_chk check (status in ('requested','applied','cancelled'))
);
create index if not exists role_cleanup_dept_ix  on public.role_cleanup (org_change_id, dept_cd, status);
create index if not exists role_cleanup_batch_ix on public.role_cleanup (batch_id);
create unique index if not exists role_cleanup_open_uq
  on public.role_cleanup (org_change_id, dept_cd, lower(email), role_id)
  where status = 'requested';

comment on table public.role_cleanup is
  '팀장·부서장이 표시한 ERP 권한 정리(제외) 요청 장부. ERP 에서 실제 회수하지는 않는다 — '
  '회수는 사람이 실행한다(CLAUDE.md §1.6). 같은 대상·같은 역할의 미처리 요청은 하나만 살아 있다.';

alter table public.role_cleanup enable row level security;
revoke all on public.role_cleanup from anon, authenticated;
grant select, insert, update, delete on public.role_cleanup to service_role;


-- ─────────────────────────────────────────────────────────────────────────
-- §3. RPC (본문은 라이브에 적용된 정의와 동일 — 마이그레이션
--     req0057_cleanup_rpcs / req0057_leader_title_fix_and_cleanup 참조)
--   · erp_role_cleanup_save(p_dept_cd, p_items jsonb, p_confirm, p_note, p_org_change_id)
--       확인 문구 검사 → 열람 범위 검사(관리자 또는 perm_grant dept) → 대상 실재 검사 → 배치 저장
--       반환 {ok, batch_id, saved, skipped, by}
--   · erp_role_cleanup_list(p_dept_cd, p_status, p_limit, p_org_change_id)
--       관리자는 전사, 그 외는 부여받은 부서만. 반환 {ok, is_admin, summary, rows[]}
--   · erp_role_cleanup_mark(p_ids bigint[], p_status)  — 관리자 전용 상태 전이
--   세 RPC 모두 perm_audit 에 기록한다(erp_role_cleanup / erp_role_cleanup_mark).
-- ─────────────────────────────────────────────────────────────────────────

revoke all on function public.erp_role_cleanup_save(text, jsonb, text, text, text) from public, anon;
grant execute on function public.erp_role_cleanup_save(text, jsonb, text, text, text) to authenticated, service_role;
revoke all on function public.erp_role_cleanup_list(text, text, int, text) from public, anon;
grant execute on function public.erp_role_cleanup_list(text, text, int, text) to authenticated, service_role;
revoke all on function public.erp_role_cleanup_mark(bigint[], text) from public, anon;
grant execute on function public.erp_role_cleanup_mark(bigint[], text) to authenticated, service_role;


-- ─────────────────────────────────────────────────────────────────────────
-- §4. 관리자 페이지 등재 — /admin/role-cleanup
--   dept_nm 을 null 로 두는 이유는 50번 §11 과 같다(비관리자 fail-closed).
-- ─────────────────────────────────────────────────────────────────────────
insert into public.portal_page
  (page_key, title, path, icon, dept_nm, visibility, shared_depts, erp_module, note, sort, active, updated_by)
values
  ('erp_role_cleanup', 'ERP 권한정리 내역 (관리)', '/admin/role-cleanup', '🧹',
   null, '부서 전용', '{}', null,
   '관리자 전용(부서 무관). 팀장·부서장이 /work/erp-roles 「권한정리」 탭에서 올린 제외 요청을 모아 본다. '
   '열람은 portal_admin 또는 perm_grant(scope_type=''page'', scope_key=''erp_role_cleanup''). REQ-0057',
   6, true, 'admin:req-0057')
on conflict (page_key) do update
  set title = excluded.title, path = excluded.path, icon = excluded.icon,
      dept_nm = null, visibility = '부서 전용', shared_depts = '{}', erp_module = null,
      note = excluded.note, sort = excluded.sort, active = true,
      updated_by = excluded.updated_by, updated_at = now();


-- ============================================================================
-- 검증
--   1) 팀장 판정 — 부서당 1명(제일엠앤에스만 2명)
--      select dept_nm_raw, string_agg(emp_nm, ', ') from erp_ro.v_dept_member
--       where account_active and gw_title in ('대표','부문장','법인장','팀장') and dept_cd is not null
--       group by 1 order by 1;            -- 사업관리팀 → 홍대기
--   2) 확인 문구 — 틀리면 저장 거부
--      select public.erp_role_cleanup_save('6120', '[]'::jsonb, '완료');   -- 22023
--   3) 범위 강제 — 권한 없는 계정이 남의 부서로 저장 시도 → 42501
--   4) 중복 방지 — 같은 (부서, 대상, 역할) 을 두 번 저장해도 미처리 요청은 1건
-- ============================================================================
