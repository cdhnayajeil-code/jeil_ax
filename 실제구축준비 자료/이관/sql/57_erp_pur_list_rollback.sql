-- 57_erp_pur_list_rollback.sql
-- 되돌리기: 발주통합관리 LIST 뷰 + ctrl_ref_s 프로젝트명 개방 (REQ-0069)
--
-- 순서 주의: 뷰를 먼저 지우고 권한을 닫는다(반대로 하면 뷰가 남아 permission denied 를 낸다).

drop view if exists public.v_erp_pur_list;

-- ctrl_ref_s 를 다시 service_role 전용으로 (27_gl_ctrl_ref.sql 상태로 원복)
drop policy if exists internal_select_ctrl_ref_project on erp_ro.ctrl_ref_s;
revoke select on erp_ro.ctrl_ref_s from authenticated;

-- 인덱스는 남겨도 해가 없다(조회 성능만 관여). 굳이 지우려면:
-- drop index if exists erp_ro.idx_ctrl_ref_s_refcd;
-- drop index if exists erp_ro.idx_iv_dtl_s_po;
