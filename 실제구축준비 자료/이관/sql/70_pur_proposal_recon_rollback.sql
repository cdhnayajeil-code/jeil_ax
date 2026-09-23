-- 70_pur_proposal_recon_rollback.sql
-- 되돌리기: 기안서 대장 ↔ ERP 전표·세금계산서 대사 (REQ-0081 · 결정 C-15)
--
-- ⚠ 이걸 돌리면 화면의 「대사」 열·행 상세가 죽는다. 화면을 먼저 되돌려야 한다
--   (대사 이전 판 = 커밋 6deee47 시점의 `pages/구매_기안서대장_2026.html`).
--
-- 되돌려도 ERP 미러(`erp_ro.gl_slip_*`)의 기존 경계는 원래대로다 — 이 파일이 만든 것은
-- RPC 두 개와 포털 전용 표뿐이고, `erp_ro` 의 정책·권한은 건드리지 않았다.

drop function if exists public.proposal_recon_detail(smallint, integer);
drop function if exists public.proposal_recon_list();

drop view if exists public.v_pur_proposal_vendor;

drop table if exists public.pur_proposal_recon_log;
drop table if exists public.pur_proposal_vendor_map;

-- 인덱스는 조회 성능용이라 남겨도 무해하지만, 완전 원복이 필요하면:
-- drop index if exists erp_ro.ix_gl_slip_item_bp;
-- drop index if exists erp_ro.ix_gl_slip_ctrl_cd;
-- drop index if exists erp_ro.ix_iv_dtl_iv_no;
-- drop index if exists erp_ro.ix_gl_slip_ref_no;
