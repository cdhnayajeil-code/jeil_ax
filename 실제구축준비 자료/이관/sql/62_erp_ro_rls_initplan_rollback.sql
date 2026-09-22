-- 62_erp_ro_rls_initplan_rollback.sql
-- 62번 되돌리기 — 정책을 행마다 계산하던 원래 모양으로 (2026-09-22)
--
-- ⚠ 되돌리면 `/work/purchase-list` 는 다시 statement timeout 으로 죽는다(실측 62,878ms).
--    되돌릴 이유가 생겼다면 63번(뷰 조인 수정)도 함께 되돌릴지 먼저 판단한다.
-- 술어 값은 어느 쪽이나 동일하므로 **권한이 바뀌지는 않는다** — 속도만 돌아간다.

alter policy internal_select_pur_order_s   on erp_ro.pur_order_s
  using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
alter policy internal_select_item_master_s on erp_ro.item_master_s
  using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
alter policy internal_select_usr_master_s  on erp_ro.usr_master_s
  using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
alter policy internal_select_wh_master_s   on erp_ro.wh_master_s
  using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
alter policy internal_select_sys_code_s    on erp_ro.sys_code_s
  using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');
alter policy internal_select_ud_code_s     on erp_ro.ud_code_s
  using (coalesce(((auth.jwt() -> 'app_metadata') ->> 'role'), '') = 'internal');

alter policy internal_select_pur_req_s on erp_ro.pur_req_s using (public.is_internal());
alter policy internal_select_iv_dtl    on erp_ro.iv_dtl_s  using (public.is_internal());
alter policy internal_select_ctrl_ref_project on erp_ro.ctrl_ref_s
  using (public.is_internal() and ctrl_cd in ('PC', 'TK'));
