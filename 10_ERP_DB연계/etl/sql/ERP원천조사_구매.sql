-- ERP원천조사_구매.sql
-- 구매 발주·요청 원천 조사 (2026-09-22 · REQ-0070) — **읽기 전용, ERP 운영 MSSQL**
--
-- 왜: 발주통합 LIST(`/work/purchase-list`)의 빈 칸을 채우려면 ERP 원천에서 두 가지를 가려야 한다.
--   (가) 미러 추출만 넓히면 되는 것 — 단가·적요·비고·입고처·담당자. 후보 컬럼을 **전부 가져와**
--        미러에서 판정하므로 이 파일의 조사는 **확인용**이다(조사 없이도 적재는 진행할 수 있다).
--   (나) 추출로 풀 수 없는 것 — **구매요청결재번호 `PU2026…`**. ERP 구매 3테이블
--        (`M_PUR_REQ` 49컬럼 · `M_PUR_ORD_HDR` 100 · `M_PUR_ORD_DTL` 81)에 결재 컬럼이
--        **하나도 없음**을 ERP 사전(`dictionary.json` 2,658테이블)으로 확인했다. §3~§5 가 그 추적이다.
--
-- 실행: 관리자가 직접(§1.5 · 벤더 운영 서버). 전부 SELECT 이며 WITH (NOLOCK) 이다.
--   서브에이전트 `erp-db-connector` 로 돌리거나, ERP 접속 호스트에서 SSMS 로 붙여 넣는다.
--   ⚠ 이 파일은 **쓰기 구문을 하나도 담지 않는다.** 추가할 일이 있어도 SELECT 로만 남긴다.
--
-- 결과 회신: 각 절의 출력을 그대로 붙여 주면 된다(행이 많으면 TOP 20 그대로).

/* ══════════════════════════════════════════════════════════════════════════
   §1. 담당자 — 엑셀 「담당자」가 HDR 의 어느 컬럼인가
   기대: 엑셀 2026년 분포 = 장민지 2,138 · 정희원 2,029 · 김윤정 506 · 박태랑 266 · '-' 87
   → 아래 세 컬럼 중 이 분포와 맞는 것이 정답. (미러에는 세 개를 다 가져올 것이므로 확인용)
   ══════════════════════════════════════════════════════════════════════════ */
SELECT 'AGENT' AS col, ISNULL(h.AGENT, '(null)') AS val, COUNT(*) AS cnt
FROM JEILMNS.dbo.M_PUR_ORD_HDR h WITH (NOLOCK)
WHERE h.PO_DT >= '2026-01-01' AND h.PO_DT < '2027-01-01'
GROUP BY h.AGENT
UNION ALL
SELECT 'APPLICANT', ISNULL(h.APPLICANT, '(null)'), COUNT(*)
FROM JEILMNS.dbo.M_PUR_ORD_HDR h WITH (NOLOCK)
WHERE h.PO_DT >= '2026-01-01' AND h.PO_DT < '2027-01-01'
GROUP BY h.APPLICANT
UNION ALL
SELECT 'INSRT_USER_ID', ISNULL(h.INSRT_USER_ID, '(null)'), COUNT(*)
FROM JEILMNS.dbo.M_PUR_ORD_HDR h WITH (NOLOCK)
WHERE h.PO_DT >= '2026-01-01' AND h.PO_DT < '2027-01-01'
GROUP BY h.INSRT_USER_ID
ORDER BY col, cnt DESC;

/* ══════════════════════════════════════════════════════════════════════════
   §2. 입고처 — 자유입력(DELIVERY_PLCE)인가 창고코드(DTL.SL_CD)인가
   기대: 엑셀 = 본사 3,433 · 이천 2공장 373 · 신영기계 105 · 삼광테크 64 …(고유 62, 협력사명 혼재)
   → 협력사명이 섞여 있으니 자유입력일 가능성이 높다. 코드라면 창고 마스터로 이름을 붙여야 한다.
   ══════════════════════════════════════════════════════════════════════════ */
SELECT TOP 30 'HDR.DELIVERY_PLCE' AS src, ISNULL(h.DELIVERY_PLCE, '(null)') AS val, COUNT(*) AS cnt
FROM JEILMNS.dbo.M_PUR_ORD_HDR h WITH (NOLOCK)
WHERE h.PO_DT >= '2026-01-01' AND h.PO_DT < '2027-01-01'
GROUP BY h.DELIVERY_PLCE ORDER BY cnt DESC;

SELECT TOP 30 'DTL.SL_CD' AS src, ISNULL(d.SL_CD, '(null)') AS val, COUNT(*) AS cnt
FROM JEILMNS.dbo.M_PUR_ORD_DTL d WITH (NOLOCK)
JOIN JEILMNS.dbo.M_PUR_ORD_HDR h WITH (NOLOCK) ON h.PO_NO = d.PO_NO
WHERE h.PO_DT >= '2026-01-01' AND h.PO_DT < '2027-01-01'
GROUP BY d.SL_CD ORDER BY cnt DESC;

/* ══════════════════════════════════════════════════════════════════════════
   §3. 구분 「외주」 — 엑셀 738건은 무엇으로 갈리는가
   미러 실측: SUBCONTRA_FLG 가 2026년 전건 'N' 이라 이걸로는 못 가린다.
   후보: PO_TYPE_CD(발주유형). 코드명은 종합코드/사용자코드에서 찾는다.
   ══════════════════════════════════════════════════════════════════════════ */
SELECT h.PO_TYPE_CD, COUNT(*) AS po_cnt, COUNT(DISTINCT h.PO_NO) AS po_no_cnt
FROM JEILMNS.dbo.M_PUR_ORD_HDR h WITH (NOLOCK)
WHERE h.PO_DT >= '2026-01-01' AND h.PO_DT < '2027-01-01'
GROUP BY h.PO_TYPE_CD ORDER BY po_cnt DESC;

-- 라인 수 기준(엑셀은 라인 단위라 이쪽과 비교해야 한다 — 「외주 738」)
SELECT h.PO_TYPE_CD, h.SUBCONTRA_FLG, COUNT(*) AS line_cnt
FROM JEILMNS.dbo.M_PUR_ORD_HDR h WITH (NOLOCK)
JOIN JEILMNS.dbo.M_PUR_ORD_DTL d WITH (NOLOCK) ON d.PO_NO = h.PO_NO
WHERE h.PO_DT >= '2026-01-01' AND h.PO_DT < '2027-01-01'
GROUP BY h.PO_TYPE_CD, h.SUBCONTRA_FLG ORDER BY line_cnt DESC;

-- PO_TYPE_CD 코드명 찾기(종합코드 · 사용자코드 양쪽)
SELECT TOP 40 'B_SYS_CODE' AS src, s.MAJOR_CD, s.MINOR_CD, s.MINOR_NM
FROM JEILMNS.dbo.B_SYS_CODE s WITH (NOLOCK)
WHERE s.MAJOR_CD LIKE '%PO%' OR s.MINOR_NM LIKE '%외주%' OR s.MINOR_NM LIKE '%발주유형%';

SELECT TOP 40 'B_UD_CODE' AS src, u.UD_MAJOR_CD, u.UD_MAJOR_NM, u.UD_MINOR_CD, u.UD_MINOR_NM
FROM JEILMNS.dbo.B_UD_CODE u WITH (NOLOCK)
WHERE u.UD_MAJOR_NM LIKE '%발주%' OR u.UD_MINOR_NM LIKE '%외주%';

/* ══════════════════════════════════════════════════════════════════════════
   §4. 구매요청결재번호 `PU2026…` — 어디서 채번되는가  ★ 이 파일의 핵심
   엑셀 C열: PU + YYYYMMDD + 4자리, 5,077행 / **고유 1,060**(한 번호당 평균 4.8행)
   → 헤더:명세 관계로 보인다. 미러 데이터로는 재구성 실패(요청자+요청일 495 · 요청일+부서 165).
   ══════════════════════════════════════════════════════════════════════════ */
-- ① 자동채번표에서 PU 접두 역추적 — tmp_key 가 어느 화면/테이블의 채번인지 알려 준다
SELECT TOP 30 a.tmp_key, a.tmp_auto_no_type, a.tmp_auto_no, a.tmp_gl_dt, a.tmp_dt
FROM JEILMNS.dbo.a_tmp_auto_number a WITH (NOLOCK)
WHERE a.tmp_auto_no LIKE 'PU%'
ORDER BY a.tmp_dt DESC;

-- ② 같은 채번표에서 PR·PO 가 어떻게 생기는지 비교(대조군)
SELECT TOP 10 'PR' AS pfx, a.tmp_key, a.tmp_auto_no_type, a.tmp_auto_no
FROM JEILMNS.dbo.a_tmp_auto_number a WITH (NOLOCK) WHERE a.tmp_auto_no LIKE 'PR2026%'
UNION ALL
SELECT TOP 10 'PO', a.tmp_key, a.tmp_auto_no_type, a.tmp_auto_no
FROM JEILMNS.dbo.a_tmp_auto_number a WITH (NOLOCK) WHERE a.tmp_auto_no LIKE 'PO2026%';

-- ③ MRO 구매요청 헤더/명세 — ERP 사전에 컬럼이 문서화돼 있지 않아 구조부터 본다
SELECT TOP 5 * FROM JEILMNS.dbo.M_MRO_PUR_REQ_HDR WITH (NOLOCK);
SELECT TOP 5 * FROM JEILMNS.dbo.M_MRO_PUR_REQ_DTL WITH (NOLOCK);

-- ④ 컬럼명을 모를 때 — 어느 테이블·컬럼이 'PU2026…' 을 담는지 스키마에서 먼저 좁힌다
--    (문자열 컬럼만 추려서 후보를 만든 다음, 그 컬럼만 실제로 조회한다)
SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH
FROM INFORMATION_SCHEMA.COLUMNS c
WHERE c.TABLE_NAME IN ('M_MRO_PUR_REQ_HDR', 'M_MRO_PUR_REQ_DTL')
  AND c.DATA_TYPE IN ('char', 'nchar', 'varchar', 'nvarchar')
ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION;

--    위 목록에서 번호처럼 보이는 컬럼(길이 14~20, 이름에 NO/DOC 포함)을 골라 실값 하나로 확인한다.
--    엑셀 표본 실값: PU202607240005 · PU202606040002 · PU202604150002
--    예) SELECT TOP 5 * FROM JEILMNS.dbo.M_MRO_PUR_REQ_HDR WITH (NOLOCK) WHERE <고른컬럼> = 'PU202607240005';

-- ⑤ 참조번호(REF_NO)가 결재번호를 담고 있는지 — 미러로도 가져오지만 형식만 미리 본다
SELECT TOP 20 h.PO_NO, h.REF_NO, h.PO_DT
FROM JEILMNS.dbo.M_PUR_ORD_HDR h WITH (NOLOCK)
WHERE h.PO_DT >= '2026-01-01' AND ISNULL(h.REF_NO, '') <> ''
ORDER BY h.PO_DT DESC;

SELECT COUNT(*) AS 전체, SUM(CASE WHEN ISNULL(h.REF_NO,'') <> '' THEN 1 ELSE 0 END) AS ref_no_있음,
       SUM(CASE WHEN h.REF_NO LIKE 'PU%' THEN 1 ELSE 0 END) AS ref_no_PU형식
FROM JEILMNS.dbo.M_PUR_ORD_HDR h WITH (NOLOCK)
WHERE h.PO_DT >= '2026-01-01' AND h.PO_DT < '2027-01-01';

/* ══════════════════════════════════════════════════════════════════════════
   §5. §4 가 빈손일 때 — 그룹웨어 전자결재 인터페이스
   ERP 도움말: 「전자결재문서매핑등록(BA105M1)」·「전자결재승인후처리(BA116M1) — MM 발주등록
   결재 승인 시 발주확정」. 인터페이스 테이블은 사전에 컬럼이 없어 구조부터 본다.
   ══════════════════════════════════════════════════════════════════════════ */
SELECT TOP 5 * FROM JEILMNS.dbo.ERP_IF_APPROVAL_DOCUMENT WITH (NOLOCK);
SELECT TOP 5 * FROM JEILMNS.dbo.ERP_IF_APPROVAL_DOCUMENT_MAPPING WITH (NOLOCK);
SELECT TOP 5 * FROM JEILMNS.dbo.INTERFACE_KO174 WITH (NOLOCK);

-- INTERFACE_KO174 에 PU 문자열이 있는지(컬럼명을 모를 때 쓰는 전수 탐색 — 컬럼 수가 많으면 시간이 걸린다)
-- SELECT TOP 20 * FROM JEILMNS.dbo.INTERFACE_KO174 WITH (NOLOCK)
--  WHERE CAST(<후보컬럼> AS nvarchar(100)) LIKE 'PU2026%';

/* ══════════════════════════════════════════════════════════════════════════
   §6. 확장 대상 컬럼의 채움률 — 적재 전에 값이 실제로 있는지 본다
   (비어 있는 컬럼을 가져오면 화면만 「대기」에서 「빈칸」으로 바뀌어 더 나빠진다)
   ══════════════════════════════════════════════════════════════════════════ */
SELECT COUNT(*) AS 라인수,
       SUM(CASE WHEN d.PO_PRC IS NOT NULL AND d.PO_PRC <> 0 THEN 1 ELSE 0 END) AS 단가있음,
       SUM(CASE WHEN ISNULL(d.REMRK, '') <> '' THEN 1 ELSE 0 END)              AS 적요있음,
       SUM(CASE WHEN ISNULL(h.REMARK, '') <> '' THEN 1 ELSE 0 END)             AS 비고있음,
       SUM(CASE WHEN ISNULL(h.DELIVERY_PLCE, '') <> '' THEN 1 ELSE 0 END)      AS 입고처있음,
       SUM(CASE WHEN ISNULL(d.SL_CD, '') <> '' THEN 1 ELSE 0 END)              AS 창고코드있음,
       SUM(CASE WHEN ISNULL(d.TRACKING_NO, '') <> '' THEN 1 ELSE 0 END)        AS 명세추적번호있음,
       SUM(CASE WHEN ISNULL(h.TRACKING_NO, '') <> '' THEN 1 ELSE 0 END)        AS 헤더추적번호있음,
       SUM(CASE WHEN ISNULL(h.PO_TYPE_CD, '') <> '' THEN 1 ELSE 0 END)         AS 발주유형있음
FROM JEILMNS.dbo.M_PUR_ORD_HDR h WITH (NOLOCK)
JOIN JEILMNS.dbo.M_PUR_ORD_DTL d WITH (NOLOCK) ON d.PO_NO = h.PO_NO
WHERE h.PO_DT >= '2026-01-01' AND h.PO_DT < '2027-01-01';

-- 단가 검산: 단가 × 수량 = 금액 인지(엑셀 T·R·U 대조와 같은 계산)
SELECT TOP 20 d.PO_NO, d.PO_SEQ_NO, d.PO_QTY, d.PO_PRC, d.PO_LOC_AMT,
       (d.PO_QTY * d.PO_PRC) AS 계산금액,
       ABS(ISNULL(d.PO_LOC_AMT,0) - ISNULL(d.PO_QTY,0) * ISNULL(d.PO_PRC,0)) AS 차이
FROM JEILMNS.dbo.M_PUR_ORD_DTL d WITH (NOLOCK)
JOIN JEILMNS.dbo.M_PUR_ORD_HDR h WITH (NOLOCK) ON h.PO_NO = d.PO_NO
WHERE h.PO_DT >= '2026-09-01'
ORDER BY 차이 DESC;

/* ══════════════════════════════════════════════════════════════════════════
   §7. 적재 후 미러에서 판정할 것 (ERP 가 아니라 Supabase 에서 실행 — 참고용)
   ══════════════════════════════════════════════════════════════════════════ */
-- select 'agent' k, agent_id v, count(*) from erp_ro.pur_order_s group by 2
-- union all select 'applicant', applicant_id, count(*) from erp_ro.pur_order_s group by 2
-- union all select 'insrt', insrt_user_id, count(*) from erp_ro.pur_order_s group by 2
-- order by 1, 3 desc;            -- 엑셀 담당자 분포(2,138/2,029/506/266)와 맞는 것이 정답
--
-- select po_type_cd, count(*) from erp_ro.pur_order_s group by 1 order by 2 desc;  -- 외주 738 과 대조
-- select count(*) filter (where ref_no like 'PU%') as pu형식, count(*) filter (where coalesce(ref_no,'')<>'') as 있음
--   from erp_ro.pur_order_s;     -- REF_NO 가 결재번호인지
