# JEIL_AX 연계 — ERP_DB 측 작업 폴더

> 신설 2026-07-07 · 관리 최동혁
> 전담 에이전트: **`ax-erp-bridge`**(AX 전표 연계 창구) · **`erp-db-connector`**(중간DB ETL)
> ★ **작업 전 `AX_ERP_연계규약.md` 를 먼저 읽는다** — 경로·3단 흐름·번호 대응표·동기화 절차
> JEIL_AX AI포털 프로젝트의 **ERP운영DB → 중간DB(Supabase `erp_ro`) 연계 작업을 ERP_DB 작업환경에서 수행·기록**하는 폴더.
> 비밀값(IP/ID/비밀번호/키)은 이 폴더를 포함해 OneDrive 어디에도 기록하지 않는다 — `%USERPROFILE%\.erp\` DPAPI 저장소만 사용.

---

## 1. 단일 출처와 역할 분담

| 자산 | 위치 | 비고 |
|---|---|---|
| 연계 기획·진행상태 문서 (단일 출처) | `%USERPROFILE%\onedrive-job\OneDrive\1.JOB\JEIL_AX\10_ERP_DB연계\` | `00_현재상태` `01_연계기획` `02_진행상태` `03_중간DB_구축실행기획` |
| ETL 도구 | `%USERPROFILE%\onedrive-job\OneDrive\1.JOB\JEIL_AX\10_ERP_DB연계\etl\` | `load_table_dict.py` · `etl_run.py` · `_env.py` · `_erp_conn.py`(DPAPI 폴백) |
| 에이전트 정의 원본(배포킷) | `%USERPROFILE%\onedrive-job\OneDrive\1.JOB\JEIL_AX\10_ERP_DB연계\agent_kit\` | 킷 개정 시 본 환경 설치본과 대조 |
| 정책 보고용 미러 | `정책관리\ERP_DB연계\` | erp-db-link-manager(jeil_ax 전용)가 동기화 — 직접 수정 금지 |
| ERP 메타(스키마 사전) | `erp_chat\data\` (dictionary.json 등 2,658테이블) | table_dict 적재 원천 |
| **연계 규약(헌장)** | `JEIL_AX연계\AX_ERP_연계규약.md` | **경로·3단 흐름·번호 대응표·역할 분담** |
| 동기화 도구 | `JEIL_AX연계\_sync_ax.ps1` | Push/Pull/Promote · 비밀값 자동 점검 |
| AX 미러 | `…\10_ERP_DB연계\AX전표 관련\` | 발신본 사본(덮어씀) |
| 회신 수신함 | `JEIL_AX연계\_회신\` | AX 회신블록 회수본(읽기용) |
| 본 폴더 | `JEIL_AX연계\` | ERP_DB 측 작업 기록·산출물·요청 목록 |

| 에이전트 | 소관 | 설치 위치 |
|---|---|---|
| **ax-erp-bridge** | **AX 전표 연계 창구** — 발신문서 작성·미러 동기화·회신 회수·번호 대응표 유지 | **ERP_DB(본 환경)** |
| **erp-db-connector** | ERP운영DB 읽기전용 연결·테스트·table_dict·ETL dry-run·실적재 안내·batch_run 점검 | jeil_ax + **ERP_DB(본 환경)** |
| erp-db-link-manager | `10_ERP_DB연계/` 문서 갱신 + 정책관리 미러 동기화 (DB 작업 안 함) | jeil_ax 전용 |
| erp-db-analyst | ERP 스키마·데이터 심층 분석(추출 SQL 검증용 원천 조회) | ERP_DB 전용 |

## 2. 접속·보안 (ERP_DB CLAUDE.md 상속 — 위반 금지)

- ERP 접속: `%USERPROFILE%\.erp\` (`.db` + `pw.xml` + `port.xml`, DPAPI) — `_erp_conn.py`가 자동 폴백.
- **이 환경(OneDrive)에 `.env`를 만들지 않는다.** `ERP_DB_CONN`·`SUPABASE_SERVICE_ROLE_KEY` 평문 저장 금지. Supabase 키가 필요한 실적재는 jeil_ax 환경(로컬 `.env`)에서 수행하거나 세션 한정 환경변수로 주입.
- ERP운영DB는 SELECT만(화이트리스트·NOLOCK). 실적재(`etl_run.py --job …`)는 운영데이터 외부반출에 해당해 에이전트 자동 실행이 차단됨 — **사용자가 `!` 프리픽스로 직접 실행**하고 에이전트는 명령만 제시한다.
- DB 작업(조회 포함) 시 `doc/db_log_YYYYMMDD_HHMMSS.md` 로그 필수(ERP_DB 규칙).

## 3. 연계 현황 요약 (2026-07-07 기준)

- 중간DB: Supabase `erp_ro`·`etl_meta` 스키마 적용, 적재는 service_role 전용 RPC(`erp_etl_upsert`/`erp_etl_batch`)만.
- 1차 5종 실적재 완료: pur_order_s 2,699(발주 2026년 우선연동) / item_master_s 58,246 / sales_orders_m 10 / purchase_m 63 / inventory_d 656행. `table_dict` 2,658건.
- 남은 것: 야간배치 정기화, 유니포인트 협의(읽기전용 계정 `jeilax_ro`·뷰 스펙 → 추출 SQL 확정·재적재 가능성).

## 4. JEIL_AX 프로젝트 전달 요청 (ERP_DB 발신)

| 일자 | 요청 | 산출물 | 상태 |
|---|---|---|---|
| 2026-08-25 | **AX 전표 릴레이 — 서브원장 생성 SP 호출 추가.** 릴레이가 `USP_A_CREATE_GL_BY_BATCH_01` 만 호출하고 `USP_A_CREATE_TEMP_GL_SUBSYS` 를 부르지 않아 채무(`A_OPEN_AP`)·부가세(`A_VAT`)가 0행. 기준정보 5종·SP 진입판정 26/26 정상이라 **호출 1블록 추가만 필요**. 기존 13건 소급은 제외 | `AX전표_서브원장_호출누락_개발요청_20260825.md` · `.html` | ✅ **처리완료 회신 수령 (2026-08-25)** — 요청 1~4 반영·DEMO2 실증(`AG202608240004`) 통과, 5(NULL 표기)는 별건 분리. **서버 실행본 교체 미완** · 회신 `회계/260819_AX_결의전표_ERP연동_기회검토/AX전표_서브원장_처리완료회신_20260825.md` |
| 2026-08-25 | **AX 전표 테스트 범위 및 케이스 설계 (v2).** `AG202608250001` 승인 점검(전 구간 정상). **테스트 범위 = 결의전표 화면 수동입력분만** — 법인카드·타모듈 연동 전면 제외, 판별기준 `REF_NO = TEMP_GL_NO` 확정 → **12,085건**. 서브원장 조합 19종, 검증완료 1종(41.6%), 최대 미검증은 **미결(`OC`) 2,976전표(24.6%)** 로 판정기준이 다름. 테스트 케이스 11종 + 권고순서 + 검증쿼리 + AX 확인요청 5건 | `AX전표_테스트케이스_설계_20260825.md` · `.html` | ✅ **회신 수령** — `14_…` 배치 + AX 수행결과 4건 전건통과(T3·T4·T5·T11). **T2 는 `21100902` 계정 미등재로 차단** |

| 2026-08-25 | **AX 전표 입력검증 및 차단규칙.** 결의전표 화면오류 `[119712] 반제할 수 없습니다` 분석 → 발생 SP `usp_a_check_acct` 규명. **서브원장 개선이 이 검증까지 자동 활성화**(SP 내부 호출)함을 확인. 반제방향 차단 규칙표(AP/AR/PP/PR/SS/OC 8종) 도출. **검증공백 2건 발견** — 부가세(TP/TR) 반제방향 미검증(실측 위반 8라인)·결의전표 차대균형 미검증. 음성테스트 N1~N10 | `AX전표_입력검증_및_차단규칙_20260825.md` · `.html` | ✅ **배치 완료** — `15_AX전표_입력검증_및_차단규칙` · 회신 대기 |

> **동기화** — `.\_sync_ax.ps1 -Push` 로 AX 미러(`10_ERP_DB연계\AX전표 관련\`)를 갱신하고,
> `-Promote NN -File <문서>.md -Force` 로 정식 등재본을 배치한다. 회신은 `-Pull` 로 회수해 `_회신\` 에 쌓인다.
> 절차와 원칙은 `AX_ERP_연계규약.md` 참조.

---

## 5. 작업 로그 (최신 우선 — 에이전트가 갱신)

| 일자 | 작업 | 산출물 |
|---|---|---|
| 2026-08-25 | **입력검증·차단규칙 전수 분석.** 화면오류 119712 → `usp_a_check_acct` 규명(B_MESSAGE + 소스). `usp_a_create_temp_gl_subsys` 가 이 SP 를 실호출 → **서브원장 개선으로 입력검증까지 자동 적용**됨 확인. A_OBJECT 기반 반제방향 차단규칙 8종 도출. TG 전체 위반 전수스캔 → **위반 8라인/7전표, 전부 부가세(TP/TR) 계정**(AP·AR·PP·PR·SS·OC 위반 0). TP/TR 검증블록 부재·113119 은 GL 한정 확인 → 검증공백 2건. 오탐 3건(외화 209·폐쇄계정 10·마감 8,625) 정리 | `AX전표_입력검증_및_차단규칙_20260825.md`·`.html`, `doc/db_log_20260825_200000.md` |
| 2026-08-25 | **테스트 범위 재정의(v2).** 사용자 지적 반영 — 테스트 대상은 **결의전표 입력화면 수동입력분에 한함**. A_BATCH 경유 여부로 재분류하니 기존 12,559건 중 **474건이 법인카드 정산 배치분**이었음(REF_NO=`IF…`) → 범위 **12,085건** 확정. 판별기준 `REF_NO = TEMP_GL_NO`(A_BATCH 미경유와 100% 일치). 조합·라인수·특수케이스·계정순위 전 지표 재집계. 전달 안내절 신설 | `AX전표_테스트케이스_설계_20260825.md`·`.html`(v2), `doc/db_log_20260825_170000.md` |
| 2026-08-25 | `AG202608250001` 승인 점검(채무 `AP202608250001`·부가세 `VT202608050002`·연결번호·정식장부 승계 전건 정상) + DEMO2 결의전표 실태조사. **미결(OC)은 `A_OPEN_ACCT` 경로라 판정기준이 다름** 확인(63,967행 근거) | `doc/db_log_20260825_140000.md` |
| 2026-08-25 | AX 전표 서브원장 미생성 원인규명 완료 → 릴레이 개발요청서 작성. 기준정보(재무제표구분·계정특성·서브시스템·관리항목·A_OBJECT) 5종 전수 정상 확인, SP 진입판정 26/26 통과, 입력필드 수기와 동등 → **데이터 보정 불필요** 판정. 소급 불필요 결정 | `AX전표_서브원장_호출누락_개발요청_20260825.md`·`.html`, `doc/db_log_20260824_180000.md`·`_193000.md` |
| 2026-07-08 | 7/7 정지 점검·재적재 안내(connector). 사전점검: `.erp` 3종·pyodbc 5.2.0·ODBC17 정상, 이 환경 Supabase 키 없음(정상, jeil_ax `.env` 자동로드로 실행 가능). ETL 정의 8종 확장·sales/purchase 연간전환 확인. Supabase 직접조회 안 함(키 미보유). 제시: dry-run `--job all --dry-run --full`(기대 96/351/2,710/3,786/58,256/32/140/659), 재적재 `--job all --full`(사용자 `!` 직접). item_master 58k는 야간 권장 | `doc/db_log_20260708_143604.md` |
| 2026-07-07 | 배포킷 불합리 5건 교정을 jeil_ax에 반영 — 킷 정의·README 개정(.env 지시 삭제→DPAPI 2단계, 실적재 `!` 직접 실행, `JEIL_AX연계` 포인터 규약, db_log 의무, link-manager 호출 경로), jeil_ax 설치본 재복사(해시 일치), `02_진행상태` 작업로그 기록 + HTML 재생성 + 정책관리 미러 동기화 | jeil_ax `agent_kit/`·`.claude/agents/`·`02_진행상태.md`, `정책관리\ERP_DB연계\ERP_DB연계_진행상태.*` |
| 2026-07-07 | 폴더 신설 + `erp-db-connector` ERP_DB 환경 설치(배포킷 기반, 보안규칙 적합화 반영) | `JEIL_AX연계/`, `.claude/agents/erp-db-connector.md` |
