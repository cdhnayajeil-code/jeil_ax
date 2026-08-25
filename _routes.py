# -*- coding: utf-8 -*-
"""
JEIL AX 포털 — 공개 URL 라우트 단일 출처.

파일명(한글·번호 접두)은 그대로 두고, 사용자에게 보이는 주소만 영문 클린 URL로 제공한다.
  예) https://ai.jeilm.co.kr/main        → 04_챗봇_포털_데모UI.html
      https://ai.jeilm.co.kr/work/voucher → pages/자금_결의전표_입력_2026.html

- 이 표가 정답이다. 페이지를 추가하면 여기에 한 줄 넣고 `python _build_routes.py` 실행.
- 실제 파일은 그대로 있으므로 기존 .html 주소도 계속 동작한다(cleanUrls 자동 리다이렉트).
"""

# 클린 경로 → 실제 파일 (저장소 루트 기준)
ROUTES = {
    # ── 진입 ────────────────────────────────────────────────
    "/main":                    "04_챗봇_포털_데모UI.html",
    "/demo":                    "JEIL_AX_포털데모_통합본.html",

    # ── 업무 화면 (부서 운영 페이지) ──────────────────────────
    "/work/voucher":            "pages/자금_결의전표_입력_2026.html",
    "/work/cash-daily":         "pages/자금_자금일보_대시보드_2026.html",
    "/work/cash-status":        "pages/자금현황_대시보드.html",
    "/work/sales-orders":       "pages/영업_수주현황_2026.html",
    "/work/purchase-vendor":    "pages/구매_거래처별매입집계_2026.html",
    "/work/hr-payroll":         "pages/인사_인원급여추이_2026.html",
    "/work/inventory":          "pages/자재물류_재고입출고_2026.html",
    "/work/subcon-inspection":  "pages/외주발주_검사진행현황_2026.html",
    "/work/item-duplicates":    "pages/품목중복_조회_2026.html",
    "/work/project-cost":       "pages/프로젝트원가_요약_2025-095-SUL-EC.html",
    "/work/project-cost-detail":"pages/2025-095-SUL-EC_원가현황_20260514.html",
    "/work/vendor-mobile":      "pages/협력사_모바일_포털.html",

    # ── 관리자 / 협력사 ────────────────────────────────────
    "/admin/erp-status":        "app/erp-status.html",
    "/admin/vendors":           "app/admin-vendors.html",
    "/admin/user-dept":         "app/admin-user-dept.html",
    "/vendor/login":            "app/vendor-login.html",

    # ── 니즈조사 ───────────────────────────────────────────
    "/survey":                  "05_니즈조사/00_니즈조사_홈.html",
    "/survey/form":             "05_니즈조사/01_니즈조사_설문폼.html",
    "/survey/dashboard":        "05_니즈조사/02_니즈조사_집계_대시보드.html",
    "/survey/evaluation":       "05_니즈조사/03_과제평가_시트.html",
    "/survey/analysis":         "05_니즈조사/04_니즈조사_분석_타당성검토.html",
    "/survey/guide":            "05_니즈조사/05_니즈조사_배포_안내문.html",

    # ── 도구 ───────────────────────────────────────────────
    "/tools/cost-calculator":   "09_비용_호스팅/JEIL_AX_비용계산기.html",

    # ── 관리체계 (거버넌스 허브) ────────────────────────────
    "/docs/governance":             "00_관리체계/index.html",
    "/docs/governance/documents":   "00_관리체계/00_문서대장.html",
    "/docs/governance/registry":    "00_관리체계/01_기준정보_레지스트리.html",
    "/docs/governance/naming":      "00_관리체계/02_명명규칙_폴더규약.html",
    "/docs/governance/changelog":   "00_관리체계/03_변경관리_CHANGELOG.html",
    "/docs/governance/summary":     "00_관리체계/04_현재상태_한장요약.html",

    # ── 기획 문서 (루트) ───────────────────────────────────
    "/docs/intro":              "01_AI_관리시스템_도입_기획서.html",
    "/docs/survey-plan":        "02_부서별_AI_니즈조사_실행기획.html",
    "/docs/portal-plan":        "03_사내_AI챗봇_포털_구축_기획서.html",
    "/docs/dept-pages-plan":    "07_부서운영페이지_확장기획.html",

    # ── 실행기획 고도화 ────────────────────────────────────
    "/docs/execution":              "06_실행기획_고도화/00_실행계획_요약보고.html",
    "/docs/execution/master":       "06_실행기획_고도화/01_AX_통합_실행기획서.html",
    "/docs/execution/survey-ops":   "06_실행기획_고도화/02_니즈조사_실전_운영계획.html",

    # ── 협력사 발주 포털 ───────────────────────────────────
    "/docs/vendor-portal":              "08_협력사발주포털/00_종합정리_요구사항이력.html",
    "/docs/vendor-portal/plan-1":       "08_협력사발주포털/01_기획문서/1차_협력사_발주사진_포털.html",
    "/docs/vendor-portal/plan-2":       "08_협력사발주포털/01_기획문서/2차_외주발주_검사진행_고도화기획.html",
    "/docs/vendor-portal/mail-env":     "08_협력사발주포털/협력사메일발송_인증_환경변수_정리.html",
    "/demo/subcon-dashboard":           "08_협력사발주포털/02_데모/사내_외주발주_검사_대시보드.html",
    "/demo/vendor-mobile":              "08_협력사발주포털/02_데모/협력사_모바일_포털.html",
    "/docs/vendor-portal/build":              "08_협력사발주포털/03_실구축기획/00_CTO종합기획_실행개요.html",
    "/docs/vendor-portal/build/architecture": "08_협력사발주포털/03_실구축기획/01_아키텍처_데이터흐름_연계설계.html",
    "/docs/vendor-portal/build/data-model":   "08_협력사발주포털/03_실구축기획/02_데이터모델_ERP매핑_포털스키마.html",
    "/docs/vendor-portal/build/security":     "08_협력사발주포털/03_실구축기획/03_협력사인증_권한_행수준보안_보안.html",
    "/docs/vendor-portal/build/sync-api":     "08_협력사발주포털/03_실구축기획/04_실시간동기화_API_파일업로드_알림.html",
    "/docs/vendor-portal/build/decisions":    "08_협력사발주포털/03_실구축기획/05_사전정의_의사결정_유니포인트협의_체크리스트.html",
    "/docs/vendor-portal/build/roadmap":      "08_협력사발주포털/03_실구축기획/06_로드맵_단계별실행_운영전환.html",
    "/docs/vendor-portal/build/deploy":       "08_협력사발주포털/03_실구축기획/07_데모배포전략_Vercel_Supabase_Azure전환.html",
    "/docs/vendor-portal/build/process":      "08_협력사발주포털/03_실구축기획/08_전체프로세스_상태머신_로직재설계.html",

    # ── 비용·호스팅 ────────────────────────────────────────
    "/docs/cost":               "09_비용_호스팅/JEIL_AX_비용기획_보고서.html",
    "/docs/hosting":            "09_비용_호스팅/JEIL_AX_호스팅_기획서.html",

    # ── ERP DB 연계 (관제) ─────────────────────────────────
    "/docs/erp":                        "10_ERP_DB연계/index.html",
    "/docs/erp/status":                 "10_ERP_DB연계/00_현재상태_스냅샷.html",
    "/docs/erp/plan":                   "10_ERP_DB연계/01_연계기획.html",
    "/docs/erp/progress":               "10_ERP_DB연계/02_진행상태.html",
    "/docs/erp/midway-db":              "10_ERP_DB연계/03_중간DB_구축실행기획.html",
    "/docs/erp/incremental-sync":       "10_ERP_DB연계/04_증분동기화_확장_거버넌스_기획.html",
    "/docs/erp/dept-mapping":           "10_ERP_DB연계/05_사용자부서_매핑대사.html",
    "/docs/erp/voucher-roadmap":        "10_ERP_DB연계/06_결의전표_추진계획.html",
    "/docs/erp/voucher-integration":    "10_ERP_DB연계/07_결의전표_연동_종합.html",
    "/docs/erp/voucher-process":        "10_ERP_DB연계/08_결의전표_처리프로세스.html",
    "/docs/erp/voucher-handover":       "10_ERP_DB연계/09_결의전표_인수인계.html",
    "/docs/erp/recurring-voucher":      "10_ERP_DB연계/10_반복전표_자동화_기획.html",
    "/docs/erp/direct-post-demo":       "10_ERP_DB연계/11_ERP직접등록_DEMO2_1차.html",
    "/docs/erp/ax001-acct-mapping":     "10_ERP_DB연계/12_AX001_계정매핑_등재요청.html",
    "/docs/erp/subledger-fix":          "10_ERP_DB연계/13_AX전표_서브원장_호출누락_개발요청.html",
    "/docs/erp/test-cases":             "10_ERP_DB연계/14_AX전표_테스트범위_및_케이스설계.html",
    "/docs/erp/input-guards":           "10_ERP_DB연계/15_AX전표_입력검증_및_차단규칙.html",

    # ── 제품기획 ───────────────────────────────────────────
    "/docs/product":                    "11_제품기획/index.html",
    "/docs/product/overview":           "11_제품기획/00_제품기획_개요.html",
    "/docs/product/prd":                "11_제품기획/01_PRD_제품요구사항정의.html",
    "/docs/product/srs":                "11_제품기획/02_SRS_요구사항명세.html",
    "/docs/product/architecture":       "11_제품기획/03_시스템아키텍처_설계.html",
    "/docs/product/database":           "11_제품기획/04_데이터베이스_설계.html",
    "/docs/product/frontend-backend":   "11_제품기획/05_프론트엔드_백엔드_설계.html",
    "/docs/product/erp-chatbot":        "11_제품기획/06_ERP연계_챗봇활용_설계.html",
    "/docs/product/migration-design":   "11_제품기획/07_마이그레이션_Azure이관_설계.html",
    "/docs/product/security":           "11_제품기획/08_보안_데이터안정성.html",
    "/docs/product/adr":                "11_제품기획/09_ADR_의사결정기록.html",
    "/docs/product/chat-rendering":     "11_제품기획/10_챗봇_응답렌더링_설계.html",
    "/docs/product/chat-data-request":  "11_제품기획/11_챗봇_데이터요청접수_설계.html",

    # ── 그리드 표준 ────────────────────────────────────────
    "/docs/grid":               "그리드/index.html",
    "/docs/grid/guide":         "그리드/표준그리드_가이드.html",

    # ── 실구축 준비 ────────────────────────────────────────
    "/docs/build":                  "실제구축준비 자료/00_실제구축_종합기획서.html",
    "/docs/build/infra":            "실제구축준비 자료/01_도메인_DNS_인프라구성.html",
    "/docs/build/ms365":            "실제구축준비 자료/02_MS연동_OneDrive_데이터연계.html",
    "/docs/build/erp":              "실제구축준비 자료/03_ERP_UNIERP_데이터연계.html",
    "/docs/build/chatbot":          "실제구축준비 자료/04_챗봇전환_데이터관리_운영.html",
    "/docs/build/checklist":        "실제구축준비 자료/05_실행체크리스트_로드맵.html",
    "/docs/build/chat-access":      "실제구축준비 자료/06_챗봇_데이터접근권한_사용량관리_고도화.html",
    "/docs/build/erp-midway-db":    "실제구축준비 자료/07_ERP_챗봇_중간DB_연계설계.html",
    "/docs/build/erp-sample-data":  "실제구축준비 자료/08_ERP_중간DB_샘플데이터.html",

    # ── 이관 관제 ──────────────────────────────────────────
    "/docs/migration":              "실제구축준비 자료/이관/index.html",
    "/docs/migration/snapshot":     "실제구축준비 자료/이관/00_현재시스템_상태스냅샷.html",
    "/docs/migration/guide":        "실제구축준비 자료/이관/01_이관실행가이드_Vercel_Supabase.html",
    "/docs/migration/azure":        "실제구축준비 자료/이관/02_Azure이관계획.html",
    "/docs/migration/progress":     "실제구축준비 자료/이관/03_이관진행상태.html",
}

# 실제 파일 → 클린 경로 (링크 치환용 역인덱스)
FILE_TO_ROUTE = {v: k for k, v in ROUTES.items()}
FILE_TO_ROUTE["index.html"] = "/"
