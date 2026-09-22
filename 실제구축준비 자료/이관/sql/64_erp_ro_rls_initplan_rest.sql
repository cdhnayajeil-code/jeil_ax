-- 64_erp_ro_rls_initplan_rest.sql
-- erp_ro RLS — 잔여 8종도 같은 모양으로 (2026-09-22 · REQ-0040 완결 · 관리자 승인)
--
-- 62번은 발주통합 LIST 가 조인하는 9종만 고쳤다. 나머지 8종은 해당 화면이 아직 안 느려
-- 남겨 뒀는데, 관리자 승인으로 함께 적용한다.
--   · 모양이 섞여 있으면 다음 사람이 어느 쪽이 맞는지 헷갈린다
--   · 데이터가 늘면 **같은 타임아웃이 영업·자재·품목 화면에서 되풀이된다**(예방)
--
--   before: (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal')
--   after : ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'))
--
-- 괄호 위치만 바뀐다. 술어 값은 동일하다 — 누가 무엇을 보는지는 하나도 안 바뀐다.
-- 왜 이 모양이어야 하는지(행마다 재계산 + 행 추정 붕괴 두 겹)는 62번 주석에 있다.

alter policy internal_select_bp_master_s      on erp_ro.bp_master_s
  using ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'));
alter policy internal_select_dept_master_s    on erp_ro.dept_master_s
  using ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'));
alter policy internal_select_inventory_d      on erp_ro.inventory_d
  using ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'));
alter policy internal_select_item_group_s     on erp_ro.item_group_s
  using ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'));
alter policy internal_select_purchase_m       on erp_ro.purchase_m
  using ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'));
alter policy internal_select_sales_orders_m   on erp_ro.sales_orders_m
  using ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'));
alter policy internal_select_table_dict       on erp_ro.table_dict
  using ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'));
alter policy internal_select_usr_erp_module_s on erp_ro.usr_erp_module_s
  using ((select coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal'));

-- ── 적용 결과(2026-09-22 실측) ────────────────────────────────────────────────
-- erp_ro 정책 **17종 전부**가 감싼 모양이 됐다:
--   select case when qual like '%( SELECT%' then 'O 감쌈' else 'X 행마다' end 상태, count(*)
--     from pg_policies where schemaname = 'erp_ro' group by 1;   -- O 감쌈 17
--
-- ERP 공개 뷰 25종 전수 재조회 — **행수가 적용 전과 한 건도 다르지 않다**:
--   v_erp_item 59,384 · v_erp_pur_list 5,609 · v_erp_pur_req 5,550 · v_erp_pur_order 4,619
--   · v_erp_po_pr_link 4,619 · v_erp_iv_dtl 3,242 · v_erp_iv_dtl_monthly 3,156
--   · v_erp_inventory_daily 2,863 · v_erp_item_group(_path) 2,391 · v_erp_pur_order_hdr 977
--   · v_erp_pur_top_po 977 · v_erp_user_dept_recon 723 · v_erp_ud_code 704 · v_erp_purchase_monthly 249
--   · v_erp_dept_erp_suggest 109 · v_erp_user_dept 88 · v_erp_sales_monthly 54 · v_erp_wh 53
--   · v_erp_item_category_stat 52 · v_erp_data_asof 30 · v_erp_dept_roster 22 · v_erp_sync_overview 22
--   · v_erp_pur_order_monthly 9 · v_erp_sys_code 8
-- 이번 8종 테이블 자체도 사내 계정으로 직접 세어 확인:
--   bp_master_s 4,678 · inventory_d 2,863 · item_group_s 2,391 · usr_erp_module_s 402
--   · dept_master_s 351 · purchase_m 249 · sales_orders_m 54
--
-- ⚠ `table_dict` 는 **authenticated 에 GRANT 자체가 없다**(소유자 postgres 전용) —
--    정책이 있든 없든 사내 계정은 못 읽는다. ERP 테이블 사전은 관리 도구 전용이라 의도된 상태이며,
--    이번 변경과 무관한 기존 설정이다(모양만 맞춰 둔다).
--
-- ⚠ Supabase 대시보드의 성능 권고(`auth_rls_initplan`)는 **주기적으로 캐시**된다 —
--    적용 직후 두 번 조회해도 고친 테이블이 그대로 올라와 있었다(pur_order_s 등 포함).
--    라이브 진실은 위 `pg_policies` 조회와 실측 소요시간이다. 권고판은 다음 갱신 때 확인한다.
--
-- 되돌리기: 64_erp_ro_rls_initplan_rest_rollback.sql
