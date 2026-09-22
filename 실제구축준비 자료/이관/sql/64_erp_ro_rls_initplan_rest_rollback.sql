-- 64_erp_ro_rls_initplan_rest_rollback.sql
-- 64번 되돌리기 — 잔여 8종을 행마다 계산하던 원래 모양으로 (2026-09-22)
--
-- 술어 값은 어느 쪽이나 동일하므로 **권한이 바뀌지는 않는다** — 속도만 돌아간다.
-- 이 8종이 쓰이는 화면(영업 수주·구매 매입·자재 입출고·품목·ERP권한)은 데이터가 작아
-- 되돌려도 당장은 체감되지 않겠지만, 행이 늘면 62번이 겪은 타임아웃을 그대로 겪는다.

alter policy internal_select_bp_master_s      on erp_ro.bp_master_s
  using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
alter policy internal_select_dept_master_s    on erp_ro.dept_master_s
  using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
alter policy internal_select_inventory_d      on erp_ro.inventory_d
  using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
alter policy internal_select_item_group_s     on erp_ro.item_group_s
  using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
alter policy internal_select_purchase_m       on erp_ro.purchase_m
  using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
alter policy internal_select_sales_orders_m   on erp_ro.sales_orders_m
  using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
alter policy internal_select_table_dict       on erp_ro.table_dict
  using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
alter policy internal_select_usr_erp_module_s on erp_ro.usr_erp_module_s
  using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
