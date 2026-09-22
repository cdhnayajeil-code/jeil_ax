-- 62_erp_ro_rls_initplan.sql
-- erp_ro RLS — 술어를 행마다 계산하지 않게 한다 (2026-09-22 · REQ-0040 부분 적용)
--
-- ── 왜 ───────────────────────────────────────────────────────────────────────
-- 2026-09-22 `/work/purchase-list` 가 라이브에서 statement timeout 으로 죽었다.
-- 같은 조회를 service_role 로 하면 358ms 인데 **사내 사용자(authenticated)는 62,878ms** 였다.
-- 뷰가 무거운 게 아니라 RLS 정책이 문제였고, 원인은 두 겹이다.
--
--   ① 행마다 재계산 — 정책이 `auth.jwt()` / `is_internal()` 를 직접 부르면
--      Postgres 가 검사하는 **행마다** 실행한다. 품목 마스터 59,384행을 포함해
--      RLS 테이블 8종을 조인하니 수백만 번이 된다.
--
--   ② 행 추정 붕괴 — `(select …) = 'internal'` 모양은 옵티마이저가 못 읽어
--      **기본 선택도 0.5%** 를 적용한다. 4,619행짜리 pur_order_s 를 23행으로 보고
--      모든 조인을 중첩루프로 골랐다(200배 오차).
--      같은 뷰의 pur_req_s 는 `(select is_internal())` 모양이라 2,766 vs 5,550 으로 멀쩡했다.
--      차이는 **비교식이 서브쿼리 안에 있느냐**뿐이다.
--
-- ── 무엇을 ──────────────────────────────────────────────────────────────────
--   before: (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal')
--   after : ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'))
--
-- 괄호 위치만 바뀐다. **술어 값은 동일하다** — 누가 무엇을 보는지는 하나도 안 바뀐다.
-- 행과 무관한 스칼라라서 InitPlan 으로 한 번만 평가되고, 불리언 하나로 보여 추정도 산다.
--
-- ── 효과(실측) ──────────────────────────────────────────────────────────────
--   v_erp_pur_list 전량 5,609행 · authenticated 기준
--     적용 전            62,878 ms   (화면 타임아웃)
--     ① 행마다 제거 후   12,341 ms
--     ② 추정 복구 후      3,350 ms
--     + 뷰 조인 수정(63)    459 ms   ← 화면 1차 1,000행은 199 ms
--   ERP 공개 뷰 25종 전수 회귀: 오류 0 · 최대 322 ms.
--
-- ── 범위 ────────────────────────────────────────────────────────────────────
-- 발주통합 LIST 가 조인하는 9종만 고쳤다. 나머지 8종(bp_master_s · dept_master_s ·
-- inventory_d · item_group_s · purchase_m · sales_orders_m · table_dict ·
-- usr_erp_module_s)은 같은 함정을 안고 있지만 해당 화면이 아직 안 느려
-- **REQ-0040 잔여분으로 남긴다**(적용은 동일한 한 줄 치환).

alter policy internal_select_pur_order_s   on erp_ro.pur_order_s
  using ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'));
alter policy internal_select_item_master_s on erp_ro.item_master_s
  using ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'));
alter policy internal_select_usr_master_s  on erp_ro.usr_master_s
  using ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'));
alter policy internal_select_wh_master_s   on erp_ro.wh_master_s
  using ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'));
alter policy internal_select_sys_code_s    on erp_ro.sys_code_s
  using ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'));
alter policy internal_select_ud_code_s     on erp_ro.ud_code_s
  using ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'));

-- is_internal() 계열은 이미 비교식이 통째로 들어가 있어 감싸기만 하면 된다.
alter policy internal_select_pur_req_s on erp_ro.pur_req_s using ((select public.is_internal()));
alter policy internal_select_iv_dtl    on erp_ro.iv_dtl_s  using ((select public.is_internal()));
alter policy internal_select_ctrl_ref_project on erp_ro.ctrl_ref_s
  using ((select public.is_internal()) and ctrl_cd in ('PC', 'TK'));

-- ── 확인 ─────────────────────────────────────────────────────────────────────
-- select tablename, policyname,
--        case when qual like '%( SELECT%' then 'O 감쌈' else 'X 행마다' end as 상태
--   from pg_policies where schemaname = 'erp_ro' order by 상태 desc, tablename;
--   -- 위 9종이 'O 감쌈' 이어야 한다.
--
-- 소요시간 재기(역할을 바꿔 재고 되돌린 뒤 기록 — authenticated 로는 temp 쓰기가 막힌다):
-- do $$
-- declare t0 timestamptz; n bigint; ms numeric;
-- begin
--   create temp table if not exists _p(행수 bigint, ms numeric) on commit drop;
--   perform set_config('role', 'authenticated', true);
--   perform set_config('request.jwt.claims',
--     '{"app_metadata":{"role":"internal"},"role":"authenticated"}', true);
--   t0 := clock_timestamp();
--   select count(*) into n from public.v_erp_pur_list;
--   ms := round(extract(epoch from (clock_timestamp() - t0)) * 1000);
--   perform set_config('role', 'postgres', true);
--   insert into _p values (n, ms);
-- end $$;
-- select * from _p;
--
-- ⚠ CTE 안에서 set_config 를 하면 스캔 전에 걸린다는 보장이 없다(2026-09-22에 120ms 라는
--    가짜 값이 나왔다). 반드시 위처럼 do 블록에서 순서를 강제해 잰다.
