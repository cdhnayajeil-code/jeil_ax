-- 68_pur_proposal_ledger_rollback.sql
-- 되돌리기: 구매 기안서 대장 중간DB 적재 구조 제거 (REQ-0077 2단계)
--
-- ⚠ 테이블을 지우면 적재한 대장 미러가 사라진다. 원천(Teams 엑셀)은 그대로이므로
--   러너를 다시 돌리면 복구되지만, 되돌리기 전에 화면(`/work/purchase-proposals`)을
--   정적 시드 판으로 되돌려 두어야 빈 화면이 되지 않는다(커밋 36ff577 이전 판).

drop view if exists public.v_pur_proposal_quality;
drop view if exists public.v_pur_proposal_case;

drop function if exists public.pur_proposal_upsert(jsonb, boolean);
drop function if exists public.pur_proposal_scan_upsert(jsonb, boolean);

drop table if exists public.pur_proposal_scan;
drop table if exists public.pur_proposal;
