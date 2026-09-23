-- 71_etax_vat_mirror_rollback.sql
-- 되돌리기: 국세청(e세로) 전자세금계산서 + 부가세 계산서 원장 미러 (REQ-0082)
--
-- ⚠ 순서가 있다. 표를 먼저 지우면 `proposal_recon_detail` 이 깨진다 —
--   그 함수가 `erp_ro.vat_s`·`etax_master_s` 를 참조한다(SQL 70 의 2026-09-23 갱신분).
--   ① 먼저 SQL 70 의 **갱신 전 판**으로 `proposal_recon_detail` 을 되돌린다
--      (= 계산서를 전표 관리항목 V1/V2/V4/V8/V11 로만 읽던 판. 커밋 `7afc81a` 시점의 70번 파일).
--   ② 그다음 아래를 실행한다.
--
-- 화면은 되돌릴 필요가 없다 — `pages/구매_기안서대장_2026.html` 은 `src` 가 'vat' 가 아니면
-- 관리항목 표시로 알아서 되돌아간다(대체 경로를 남겨 뒀다).
--
-- ETL 도 함께 꺼야 한다: `10_ERP_DB연계/etl/etl_run.py` 의 `etax_master`·`vat_ledger` 항목 제거
-- → `build_exe.py` 재빌드 → `_sync_relay.py` → 관리자 서버 교체(§17.5).

drop function if exists public.erp_vat_upsert(text, jsonb);

drop table if exists erp_ro.vat_s;
drop table if exists erp_ro.etax_master_s;

-- 배치 이력은 남겨 둔다(감사 흔적) — 지우려면:
-- delete from public.erp_etl_batch where job_name in ('etax_master', 'vat_ledger');
