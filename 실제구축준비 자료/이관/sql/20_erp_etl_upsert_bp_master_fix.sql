-- 20_erp_etl_upsert_bp_master_fix.sql
-- 적용일: 2026-07-24 · 작성: 데이터 갱신 작업 중 발견·수정
--
-- [문제] public.erp_etl_upsert(p_table, p_rows) 의 bp_master_s 분기에서
--   biz_no 주민번호 마스킹 case 식 뒤에 붙인 인라인 '--' 주석이
--   같은 물리적 줄에 있던 x.repre_nm, x.bp_type, x.bp_group 3개 값을 통째로
--   주석 처리 → INSERT 대상 컬럼 20개 vs 값(expression) 17개 불일치
--   → PostgreSQL 42601 "INSERT has more target columns than expressions" 로 bp_master 적재 전면 실패.
--   (2026-07-22 최초 4,649행 적재는 이 마스킹 코드 추가 이전 버전이라 성공했음 — 이후 회귀.)
--
-- [조치] 주석을 세 컬럼 뒤(줄 끝)로 이동. 마스킹 기능·컬럼 매핑은 동일, 컬럼 수만 20=20 으로 정렬.
--   전체 함수를 수기 재작성하지 않고, DB의 현재 정의를 읽어 깨진 한 줄만 문자열 치환 후 재생성한다
--   (다른 정상 분기 오타 위험 배제). 패턴 미발견 시 예외로 중단.
--
-- [주의] erp_etl_upsert 전체 정의는 그동안 번호 마이그레이션 파일로 관리되지 않았고(DB에만 존재),
--   본 파일은 'bp_master_s 분기 버그 픽스'만 기록한다. 함수 전체를 번호 파일로 승격하는 작업은 별도 후속 과제.

DO $$
DECLARE src text; fixed text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'erp_etl_upsert' AND n.nspname = 'public';

  fixed := replace(src,
    'end, -- 주민번호 형태 차단 x.repre_nm, x.bp_type, x.bp_group,',
    'end, x.repre_nm, x.bp_type, x.bp_group, -- 주민번호 형태 차단');

  IF fixed = src THEN
    -- 이미 수정됨(치환 대상 없음) 또는 정의가 예상과 다름 → 안전하게 중단
    RAISE EXCEPTION '패턴 미발견 — 이미 수정되었거나 함수 정의가 예상과 다름(수동 확인 필요)';
  END IF;

  EXECUTE fixed;
END $$;
