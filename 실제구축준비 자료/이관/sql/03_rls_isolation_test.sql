-- ============================================================
-- RLS 격리 테스트 — JWT 시뮬레이션 (로그인 없이 SQL Editor에서 검증)
-- 원리: SQL Editor 기본 롤(postgres)은 RLS를 우회하므로,
--       set local role authenticated + request.jwt.claims 로 실제 사용자처럼 흉내낸다.
--       auth.jwt()가 request.jwt.claims 를 읽어 RLS 헬퍼(is_internal/vendor_bp)가 동작.
-- 사용법: 아래 블록을 "하나씩" 드래그해서 RUN (각 블록은 begin~rollback 자기완결).
-- ============================================================

-- ── 0. 최소 시드 (postgres 롤이라 RLS 우회되어 삽입됨) ────
insert into sp_order_state(po_no, bp_cd, status, step) values
  ('PO202606220012','V-1027','prod',5),   -- 협력사 A(한일정밀)
  ('PO202606220033','V-2050','new', 3)    -- 협력사 B
on conflict (po_no) do nothing;

-- ── [A] 사내(role=internal): 둘 다 보여야 함 → 2행 ───────
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"app_metadata":{"role":"internal"}}';
  select po_no, bp_cd from sp_order_state order by 1;   -- 기대: 2행
rollback;

-- ── [B] 협력사 V-1027: 자기 것만 → 1행 (PO...12) ────────
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"app_metadata":{"role":"vendor","vendor_bp":["V-1027"]}}';
  select po_no, bp_cd from sp_order_state order by 1;   -- 기대: PO202606220012 만
rollback;

-- ── [C] 협력사 V-2050: 자기 것만 → 1행 (PO...33) ────────
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"app_metadata":{"role":"vendor","vendor_bp":["V-2050"]}}';
  select po_no, bp_cd from sp_order_state order by 1;   -- 기대: PO202606220033 만
rollback;

-- ── [D] vendor_bp 없는 협력사: 아무것도 못 봄 → 0행 ─────
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"app_metadata":{"role":"vendor","vendor_bp":[]}}';
  select count(*) as visible_rows from sp_order_state;  -- 기대: 0
rollback;

-- ── [E] 쓰기 격리: V-1027이 V-2050 발주 수정 시도 → 0건 영향 ─
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"app_metadata":{"role":"vendor","vendor_bp":["V-1027"]}}';
  update sp_order_state set status='done' where po_no='PO202606220033'
    returning po_no;   -- 기대: 0행 (남의 발주 못 고침)
rollback;

-- 모두 기대대로면 협력사 행수준 격리 정상. 결과를 03_이관진행상태에 기록.
