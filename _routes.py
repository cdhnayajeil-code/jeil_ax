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
    "/work/purchase-orders":    "pages/구매_발주관리_2026.html",
    "/work/purchase-list":      "pages/구매_발주통합LIST_2026.html",
    "/work/purchase-proposals": "pages/구매_기안서대장_2026.html",
    "/work/purchase-agent":     "pages/구매_AI에이전트_2026.html",   # 구매 에이전트(REQ-0087 · 14 기획) — 파일럿 구성원·관리자(서버 판정)
    "/work/purchase-board":     "pages/구매_진행판_2026.html",      # 구매 진행판(REQ-0116 · 구매업무시스템 P1) — 발주 1건=1행 · 8단계 실적 판정(뷰 v_erp_pur_board)
    "/work/purchase-trace":     "pages/구매_구매건추적_2026.html",  # 구매 건 추적(REQ-0116 · P1) — 번호 하나로 요청→발주→입고→매입→대장(함수 pur_case_chain)
    "/work/bizops-dri":         "pages/사업운영_DRI분석생성_2026.html",   # 사업운영팀 DRI 분석·생성 에이전트(REQ-0112 · 준비 단계) — 파일럿 구성원·관리자(서버 판정)
    "/work/hr-payroll":         "pages/인사_인원급여추이_2026.html",
    "/work/hr-master":          "pages/인사_인사마스터_조회.html",   # 인사마스터 조회(REQ-0122) — ERP 인사마스터·경력 미러 · 표준 그리드 · 인사팀·전체관리자(서버 판정)
    "/work/inventory":          "pages/자재물류_재고입출고_2026.html",
    "/work/subcon-inspection":  "pages/외주발주_검사진행현황_2026.html",
    "/work/item-duplicates":    "pages/품목중복_조회_2026.html",
    "/work/regulations":        "pages/전사_사내규정_조회_2026.html",  # 사내규정 조회(REQ-0124) — 그룹웨어 규정 게시판 사본(public.reg_* · 정본 SQL 103) · 전사 공개 · 조회바 months:false · 표준 그리드
    "/work/erp-roles":          "pages/ERP권한_조직별현황.html",
    "/docs/erp/role-cleanup":   "pages/ERP권한정리_사용안내.html",
    "/work/project-cost":       "pages/프로젝트원가_요약_2025-095-SUL-EC.html",
    "/work/project-cost-detail":"pages/2025-095-SUL-EC_원가현황_20260514.html",
    "/work/vendor-mobile":      "pages/협력사_모바일_포털.html",

    # ── 관리자 / 협력사 ────────────────────────────────────
    "/admin/erp-status":        "app/erp-status.html",
    "/admin/role-cleanup":      "app/admin-role-cleanup.html",
    "/admin/vendors":           "app/admin-vendors.html",
    # 계정·조직 통합관리 플랫폼(셸). 아래 네 화면은 이 안의 모듈이면서 단독 주소도 유지한다.
    "/admin/identity":          "app/admin-identity.html",
    "/admin/user-dept":         "app/admin-user-dept.html",
    "/admin/accounts":          "app/admin-accounts.html",
    "/admin/permissions":       "app/admin-permissions.html",   # 권한 설정(2026-09-10 REQ-0026) — 콘솔 「권한·계정」 탭도 이 화면을 내장
    "/admin/offboarding":       "app/admin-offboarding.html",
    "/admin/agents":            "app/admin-agents.html",
    "/admin/api-setup":         "app/api-setup-guide.html",  # AI API 설정방법(REQ-0091) — 키 4종 현황·발급·검증·Supabase 시크릿 등록 절차        # 부서 에이전트 관리(REQ-0086/0088) — 에이전트 구성원·관리자(서버 판정)
    "/chatdemo":                "app/chat-lab.html",            # 챗봇 고도화 실험실(REQ-0084) — 전체관리자 전용. §15.2 네임스페이스 예외(관리자 지정 주소)
    "/vendor/login":            "app/vendor-login.html",

    # ── 니즈조사 ───────────────────────────────────────────
    "/survey":                  "문서/05_니즈조사/00_니즈조사_홈.html",
    "/survey/form":             "문서/05_니즈조사/01_니즈조사_설문폼.html",
    "/survey/dashboard":        "문서/05_니즈조사/02_니즈조사_집계_대시보드.html",
    "/survey/evaluation":       "문서/05_니즈조사/03_과제평가_시트.html",
    "/survey/analysis":         "문서/05_니즈조사/04_니즈조사_분석_타당성검토.html",
    "/survey/guide":            "문서/05_니즈조사/05_니즈조사_배포_안내문.html",

    # ── 도구 ───────────────────────────────────────────────
    "/tools/cost-calculator":   "문서/09_비용_호스팅/JEIL_AX_비용계산기.html",

    # ── 문서 센터 (문서/ 폴더 전체 목차 — _build_routes.py 가 이 표에서 자동 생성) ──
    "/docs":                        "문서/index.html",

    # ── 관리체계 (거버넌스 허브) ────────────────────────────
    "/docs/governance":             "문서/00_관리체계/index.html",
    "/docs/governance/documents":   "문서/00_관리체계/00_문서대장.html",
    "/docs/governance/registry":    "문서/00_관리체계/01_기준정보_레지스트리.html",
    "/docs/governance/naming":      "문서/00_관리체계/02_명명규칙_폴더규약.html",
    "/docs/governance/changelog":   "문서/00_관리체계/03_변경관리_CHANGELOG.html",
    "/docs/governance/summary":     "문서/00_관리체계/04_현재상태_한장요약.html",

    # ── 기획 문서 (루트) ───────────────────────────────────
    "/docs/intro":              "문서/01_AI_관리시스템_도입_기획서.html",
    "/docs/survey-plan":        "문서/02_부서별_AI_니즈조사_실행기획.html",
    "/docs/portal-plan":        "문서/03_사내_AI챗봇_포털_구축_기획서.html",
    "/docs/dept-pages-plan":    "문서/07_부서운영페이지_확장기획.html",

    # ── 실행기획 고도화 ────────────────────────────────────
    "/docs/execution":              "문서/06_실행기획_고도화/00_실행계획_요약보고.html",
    "/docs/execution/master":       "문서/06_실행기획_고도화/01_AX_통합_실행기획서.html",
    "/docs/execution/survey-ops":   "문서/06_실행기획_고도화/02_니즈조사_실전_운영계획.html",

    # ── 협력사 발주 포털 ───────────────────────────────────
    "/docs/vendor-portal":              "문서/08_협력사발주포털/00_종합정리_요구사항이력.html",
    "/docs/vendor-portal/plan-1":       "문서/08_협력사발주포털/01_기획문서/1차_협력사_발주사진_포털.html",
    "/docs/vendor-portal/plan-2":       "문서/08_협력사발주포털/01_기획문서/2차_외주발주_검사진행_고도화기획.html",
    "/docs/vendor-portal/mail-env":     "문서/08_협력사발주포털/협력사메일발송_인증_환경변수_정리.html",
    "/demo/subcon-dashboard":           "문서/08_협력사발주포털/02_데모/사내_외주발주_검사_대시보드.html",
    "/demo/vendor-mobile":              "문서/08_협력사발주포털/02_데모/협력사_모바일_포털.html",
    "/docs/vendor-portal/build":              "문서/08_협력사발주포털/03_실구축기획/00_CTO종합기획_실행개요.html",
    "/docs/vendor-portal/build/architecture": "문서/08_협력사발주포털/03_실구축기획/01_아키텍처_데이터흐름_연계설계.html",
    "/docs/vendor-portal/build/data-model":   "문서/08_협력사발주포털/03_실구축기획/02_데이터모델_ERP매핑_포털스키마.html",
    "/docs/vendor-portal/build/security":     "문서/08_협력사발주포털/03_실구축기획/03_협력사인증_권한_행수준보안_보안.html",
    "/docs/vendor-portal/build/sync-api":     "문서/08_협력사발주포털/03_실구축기획/04_실시간동기화_API_파일업로드_알림.html",
    "/docs/vendor-portal/build/decisions":    "문서/08_협력사발주포털/03_실구축기획/05_사전정의_의사결정_유니포인트협의_체크리스트.html",
    "/docs/vendor-portal/build/roadmap":      "문서/08_협력사발주포털/03_실구축기획/06_로드맵_단계별실행_운영전환.html",
    "/docs/vendor-portal/build/deploy":       "문서/08_협력사발주포털/03_실구축기획/07_데모배포전략_Vercel_Supabase_Azure전환.html",
    "/docs/vendor-portal/build/process":      "문서/08_협력사발주포털/03_실구축기획/08_전체프로세스_상태머신_로직재설계.html",

    # ── 비용·호스팅 ────────────────────────────────────────
    "/docs/cost":               "문서/09_비용_호스팅/JEIL_AX_비용기획_보고서.html",
    "/docs/hosting":            "문서/09_비용_호스팅/JEIL_AX_호스팅_기획서.html",

    # ── ERP DB 연계 (관제) ─────────────────────────────────
    "/docs/erp":                        "문서/10_ERP_DB연계/index.html",
    "/docs/erp/status":                 "문서/10_ERP_DB연계/00_현재상태_스냅샷.html",
    "/docs/erp/plan":                   "문서/10_ERP_DB연계/01_연계기획.html",
    "/docs/erp/progress":               "문서/10_ERP_DB연계/02_진행상태.html",
    "/docs/erp/midway-db":              "문서/10_ERP_DB연계/03_중간DB_구축실행기획.html",
    "/docs/erp/incremental-sync":       "문서/10_ERP_DB연계/04_증분동기화_확장_거버넌스_기획.html",
    "/docs/erp/dept-mapping":           "문서/10_ERP_DB연계/05_사용자부서_매핑대사.html",
    "/docs/erp/voucher-roadmap":        "문서/10_ERP_DB연계/06_결의전표_추진계획.html",
    "/docs/erp/voucher-integration":    "문서/10_ERP_DB연계/07_결의전표_연동_종합.html",
    "/docs/erp/voucher-process":        "문서/10_ERP_DB연계/08_결의전표_처리프로세스.html",
    "/docs/erp/voucher-handover":       "문서/10_ERP_DB연계/09_결의전표_인수인계.html",
    "/docs/erp/recurring-voucher":      "문서/10_ERP_DB연계/10_반복전표_자동화_기획.html",
    "/docs/erp/direct-post-demo":       "문서/10_ERP_DB연계/11_ERP직접등록_DEMO2_1차.html",
    "/docs/erp/ax001-acct-mapping":     "문서/10_ERP_DB연계/12_AX001_계정매핑_등재요청.html",
    "/docs/erp/subledger-fix":          "문서/10_ERP_DB연계/13_AX전표_서브원장_호출누락_개발요청.html",
    "/docs/erp/test-cases":             "문서/10_ERP_DB연계/14_AX전표_테스트범위_및_케이스설계.html",
    "/docs/erp/input-guards":           "문서/10_ERP_DB연계/15_AX전표_입력검증_및_차단규칙.html",
    "/docs/erp/trans-type-review":      "문서/10_ERP_DB연계/16_AX전표_거래유형체계_적정성검토.html",
    "/docs/erp/prod-gates":             "문서/10_ERP_DB연계/17_운영전환_게이트.html",
    "/docs/erp/jnl-rule":               "문서/10_ERP_DB연계/18_거래항목_결정규칙.html",
    "/docs/erp/test-set":               "문서/10_ERP_DB연계/19_연동테스트_전표세트.html",
    "/docs/erp/ledger-verify":          "문서/10_ERP_DB연계/20_원장검증_실장부대조.html",
    "/docs/erp/offboarding":            "문서/10_ERP_DB연계/21_퇴사처리_일괄적용_기획.html",
    "/docs/erp/gw-org-recon":           "문서/10_ERP_DB연계/22_그룹웨어_조직도_실측대사.html",
    "/docs/erp/prod-worklist":          "문서/10_ERP_DB연계/23_운영전환_작업항목.html",
    # 유니포인트 전달본(2026-08-25 시점 사본) — 최신본은 위 13~16
    "/docs/erp/sent/subledger-fix":     "문서/10_ERP_DB연계/AX전표 관련/AX전표_서브원장_호출누락_개발요청_20260825.html",
    "/docs/erp/sent/test-cases":        "문서/10_ERP_DB연계/AX전표 관련/AX전표_테스트케이스_설계_20260825.html",
    "/docs/erp/sent/input-guards":      "문서/10_ERP_DB연계/AX전표 관련/AX전표_입력검증_및_차단규칙_20260825.html",
    "/docs/erp/sent/trans-type-review": "문서/10_ERP_DB연계/AX전표 관련/AX전표_거래유형체계_적정성검토_20260825.html",

    # ── 제품기획 ───────────────────────────────────────────
    "/docs/product":                    "문서/11_제품기획/index.html",
    "/docs/product/overview":           "문서/11_제품기획/00_제품기획_개요.html",
    "/docs/product/prd":                "문서/11_제품기획/01_PRD_제품요구사항정의.html",
    "/docs/product/srs":                "문서/11_제품기획/02_SRS_요구사항명세.html",
    "/docs/product/architecture":       "문서/11_제품기획/03_시스템아키텍처_설계.html",
    "/docs/product/database":           "문서/11_제품기획/04_데이터베이스_설계.html",
    "/docs/product/frontend-backend":   "문서/11_제품기획/05_프론트엔드_백엔드_설계.html",
    "/docs/product/erp-chatbot":        "문서/11_제품기획/06_ERP연계_챗봇활용_설계.html",
    "/docs/product/migration-design":   "문서/11_제품기획/07_마이그레이션_Azure이관_설계.html",
    "/docs/product/security":           "문서/11_제품기획/08_보안_데이터안정성.html",
    "/docs/product/adr":                "문서/11_제품기획/09_ADR_의사결정기록.html",
    "/docs/product/chat-rendering":     "문서/11_제품기획/10_챗봇_응답렌더링_설계.html",
    "/docs/product/chat-data-request":  "문서/11_제품기획/11_챗봇_데이터요청접수_설계.html",
    "/docs/product/org-permission":     "문서/11_제품기획/12_권한_조직도기반_공개설정_설계.html",
    "/docs/product/org-permission-mockup": "문서/11_제품기획/12_권한_조직도기반_공개설정_목업.html",
    "/docs/product/chat-modules":       "문서/11_제품기획/13_챗봇_모듈형_고도화_기획.html",
    "/docs/product/dept-agents":        "문서/11_제품기획/14_부서에이전트_운영기획.html",
    "/docs/product/chat-vs-agents":     "문서/11_제품기획/15_챗봇_에이전트_역할구분_적용가이드.html",  # 챗봇 ↔ 부서 에이전트 역할 구분·적용 가이드(ADR-113 제안 · 2026-10-07)
    "/docs/agents":                     "문서/12_에이전트관리/index.html",          # 부서 에이전트 관리 허브(2026-09-29)
    "/docs/agents/status":              "문서/12_에이전트관리/00_현재상태.html",
    "/docs/agents/ops-guide":           "문서/12_에이전트관리/01_운영가이드.html",
    "/docs/agents/dev-guide":           "문서/12_에이전트관리/02_개발가이드.html",
    "/docs/agents/progress":            "문서/12_에이전트관리/03_진행상태_변경이력.html",
    "/docs/agents/purchase-domain":     "문서/12_에이전트관리/04_구매도메인_발주통합LIST.html",
    "/docs/agents/quality-test":        "문서/12_에이전트관리/05_품질테스트_대화검증.html",   # 실업무 대화 실측(REQ-0094 · 2026-09-30)
    "/docs/agents/templates":           "문서/12_에이전트관리/06_에이전트_템플릿_관리포인트.html",  # 템플릿·관리 포인트 생성본(정본 app/agent-templates.json)
    "/docs/agents/integration-test":    "문서/12_에이전트관리/07_통합실측_구매에이전트_NAS연계_2026-10-06.html",  # 구매 에이전트·NAS 연계 통합 실측 보고서
    "/docs/agents/dri-plan":            "문서/12_에이전트관리/08_DRI분석생성_에이전트_기획.html",  # 사업운영팀 DRI 분석·생성 에이전트 기획(REQ-0112)
    "/docs/agents/prompt-tuning":       "문서/12_에이전트관리/09_지시문_오케스트레이션_튜닝.html",  # 지시문 개편·오케스트레이션 튜닝 설계·적용·검증(REQ-0114)
    "/docs/agents/doc-data":            "문서/12_에이전트관리/10_NAS자료_데이터화_기준.html",  # NAS 업로드 자료 데이터화 기준 — 부서 공통(REQ-0117 · 2026-10-08)
    "/docs/agents/regulations":         "문서/12_에이전트관리/11_사내규정_데이터_운영기획.html",  # 사내규정 데이터 운영기획 — 그룹웨어 게시판 → NAS 정본 → 포털 DB → 조회 화면·챗봇 도구(REQ-0124 · 2026-10-08)
    "/docs/nas":                        "문서/13_NAS_고도화/index.html",            # 사내 NAS 연계 검토·기획 허브(2026-09-29)
    "/docs/nas/review":                 "문서/13_NAS_고도화/00_NAS연계_타당성검토.html",
    "/docs/nas/plan":                   "문서/13_NAS_고도화/01_NAS_데이터계층_기획.html",
    "/docs/nas/decision":               "문서/13_NAS_고도화/02_의사결정_브리핑.html",
    "/docs/nas/flow":                   "문서/13_NAS_고도화/03_연동방식_도식.html",   # 지금 돌아가는 연동 방식 도식(2026-10-02)
    "/docs/nas/realtime":               "문서/13_NAS_고도화/04_실시간연계_컨테이너_검토.html",   # 실시간 연계·컨테이너 이관 검토(REQ-0102 · 2026-10-02)
    "/docs/purchase":                   "문서/14_구매업무시스템/index.html",        # 구매업무시스템 허브(REQ-0109 · 2026-10-06) — 이 폴더는 공개물: 실거래 자료 금지
    "/docs/purchase/process":           "문서/14_구매업무시스템/01_구매업무_프로세스_도식.html",   # 구매업무 8단계 프로세스 정본(직접 관리)
    "/docs/purchase/review":            "문서/14_구매업무시스템/02_현행점검_기존화면_데이터.html",
    "/docs/purchase/plan":              "문서/14_구매업무시스템/03_구매업무시스템_기획.html",
    "/docs/purchase/cases":             "문서/14_구매업무시스템/04_예시검증_P05_상태규칙.html",   # P0.5 예시 검증(2026-10-07) — 공개물: 실번호·거래처 없음

    # ── 그리드 표준 ────────────────────────────────────────
    "/docs/grid":               "그리드/index.html",
    "/docs/grid/guide":         "그리드/표준그리드_가이드.html",

    # ── 조회 플랫폼 표준 ───────────────────────────────────
    "/docs/querybar":           "조회플랫폼/index.html",
    "/docs/querybar/guide":     "조회플랫폼/조회플랫폼_가이드.html",

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


# ══ 문서 폴더 통합(2026-10-06 · REQ-0107) ═══════════════════════════════════
# 문서 폴더 9개 + 루트 기획서가 `문서/` 아래로 모였다. 실행 코드 `10_ERP_DB연계/etl` 만 제자리.
DOCS_DIR = "문서"
DOC_CENTER = DOCS_DIR + "/index.html"       # 문서 센터 — _build_routes.py 생성물(손으로 고치지 않는다)


def legacy_path(dest):
    """통합 전 파일 경로(옛 .html 주소 리다이렉트용). 통합 뒤 새로 생긴 문서는 None."""
    if dest == DOC_CENTER or not dest.startswith(DOCS_DIR + "/"):
        return None
    return dest[len(DOCS_DIR) + 1:]


# 문서 센터 묶음 — (파일 경로 접두, 제목, 한 줄 설명). 위에서부터 먼저 맞는 묶음에 들어간다.
DOC_GROUPS = [
    ("문서/00_관리체계/",       "00 관리체계",          "총괄 대시보드 · 문서대장 · 기준정보 · 명명규칙 · 변경관리"),
    ("문서/05_니즈조사/",       "05 니즈조사",          "설문폼 · 집계 대시보드 · 과제평가 · 분석"),
    ("문서/06_실행기획_고도화/", "06 실행기획 고도화",    "실행계획 요약 · 통합 실행기획서 · 니즈조사 운영계획"),
    ("문서/08_협력사발주포털/",  "08 협력사 발주 포털",   "요구사항 이력 · 기획 · 데모 · 실구축기획 9부"),
    ("문서/09_비용_호스팅/",     "09 비용 · 호스팅",      "비용기획 보고서 · 호스팅 기획서 · 비용계산기"),
    ("문서/10_ERP_DB연계/",     "10 ERP DB 연계",       "현재상태 · 기획 · 진행상태 · 결의전표 · 운영전환 (실행 코드는 저장소 루트 10_ERP_DB연계/etl)"),
    ("문서/11_제품기획/",       "11 제품기획",          "PRD · SRS · 아키텍처 · DB · 보안 · ADR · 챗봇·에이전트 기획"),
    ("문서/12_에이전트관리/",    "12 에이전트 관리",      "현재상태 · 운영/개발 가이드 · 품질테스트 · 템플릿"),
    ("문서/13_NAS_고도화/",     "13 NAS 고도화",        "타당성검토 · 데이터계층 기획 · 의사결정 · 연동 도식"),
    ("문서/14_구매업무시스템/",  "14 구매업무시스템",     "구매업무 8단계 프로세스 도식 · 현행 점검 · 구매업무시스템 기획"),
    ("문서/",                  "01~07 기획서",         "도입 기획서 · 니즈조사 실행기획 · 챗봇 포털 구축 · 부서 운영페이지 확장"),
    ("실제구축준비 자료/이관/",  "이관 관제",            "현 시스템 상태 스냅샷 · 이관 가이드 · Azure 계획 · 진행상태 (문서 폴더 밖)"),
    ("실제구축준비 자료/",       "실구축 준비",          "종합기획 · 인프라 · MS연동 · ERP · 챗봇 · 체크리스트 (문서 폴더 밖)"),
    ("그리드/",                "표준 그리드",          "편집 그리드 가이드 · 데모 (문서 폴더 밖)"),
    ("조회플랫폼/",             "표준 조회 플랫폼",      "조회바 가이드 · 데모 (문서 폴더 밖)"),
]

# ── 파일로 열었을 때(file://)도 클린 URL 링크가 이어지게 하는 인라인 로더 ──────────
# 사이트(http/https)에서는 첫 줄에서 바로 끝난다. 실제 보정은 루트 `_local_links.js`(생성물)가 한다.
# 단일 파일로 떼어 보낸 전달본처럼 `_local_links.js` 가 곁에 없으면 조용히 아무 일도 하지 않는다.
LOCAL_MARK_S = "<!-- jeilax:local-links -->"
LOCAL_MARK_E = "<!-- /jeilax:local-links -->"


def local_links_snippet(rel_file):
    """rel_file(저장소 기준 경로, 슬래시)에 맞는 깊이의 로더 조각."""
    up = "../" * rel_file.count("/") or "./"
    return (LOCAL_MARK_S + '<script>(function(){if(location.protocol!=="file:")return;'
            'var r="%s",s=document.createElement("script");s.src=r+"_local_links.js";'
            's.setAttribute("data-root",r);(document.head||document.documentElement).appendChild(s);'
            '})();</script>' % up + LOCAL_MARK_E)


def inject_local_links(html, rel_file):
    """HTML 에 로더를 넣는다(이미 있으면 깊이에 맞게 교체). </head> 가 없으면 그대로 둔다."""
    import re
    block = re.compile(re.escape(LOCAL_MARK_S) + r".*?" + re.escape(LOCAL_MARK_E) + r"\r?\n?", re.S)
    html = block.sub("", html)
    m = re.search(r"</head\s*>", html, re.I)
    if not m:
        return html
    nl = "\r\n" if "\r\n" in html else "\n"      # 파일의 줄바꿈을 따른다 — 다시 돌려도 결과가 같아야 한다
    return html[:m.start()] + local_links_snippet(rel_file) + nl + html[m.start():]
