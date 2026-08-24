# JEIL_AX 연계 — ERP_DB 측 작업 폴더

> 신설 2026-07-07 · 관리 최동혁 · 전담 에이전트: **`erp-db-connector`** (`.claude/agents/erp-db-connector.md`)
> JEIL_AX AI포털 프로젝트의 **ERP운영DB → 중간DB(Supabase `erp_ro`) 연계 작업을 ERP_DB 작업환경에서 수행·기록**하는 폴더.
> 비밀값(IP/ID/비밀번호/키)은 이 폴더를 포함해 OneDrive 어디에도 기록하지 않는다 — `%USERPROFILE%\.erp\` DPAPI 저장소만 사용.

---

## 1. 단일 출처와 역할 분담

| 자산 | 위치 | 비고 |
|---|---|---|
| 연계 기획·진행상태 문서 (단일 출처) | `E:\OneDrive\1.JOB\JEIL_AX\10_ERP_DB연계\` | `00_현재상태` `01_연계기획` `02_진행상태` `03_중간DB_구축실행기획` |
| ETL 도구 | `E:\OneDrive\1.JOB\JEIL_AX\10_ERP_DB연계\etl\` | `load_table_dict.py` · `etl_run.py` · `_env.py` · `_erp_conn.py`(DPAPI 폴백) |
| 에이전트 정의 원본(배포킷) | `E:\OneDrive\1.JOB\JEIL_AX\10_ERP_DB연계\agent_kit\` | 킷 개정 시 본 환경 설치본과 대조 |
| 정책 보고용 미러 | `정책관리\ERP_DB연계\` | erp-db-link-manager(jeil_ax 전용)가 동기화 — 직접 수정 금지 |
| ERP 메타(스키마 사전) | `erp_chat\data\` (dictionary.json 등 2,658테이블) | table_dict 적재 원천 |
| 본 폴더 | `JEIL_AX연계\` | ERP_DB 측 작업 기록·산출물·요청 목록 |

| 에이전트 | 소관 | 설치 위치 |
|---|---|---|
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
| 2026-08-25 | **AX 전표 릴레이 — 서브원장 생성 SP 호출 추가.** 릴레이가 `USP_A_CREATE_GL_BY_BATCH_01` 만 호출하고 `USP_A_CREATE_TEMP_GL_SUBSYS` 를 부르지 않아 채무(`A_OPEN_AP`)·부가세(`A_VAT`)가 0행. 기준정보 5종·SP 진입판정 26/26 정상이라 **호출 1블록 추가만 필요**. 기존 13건 소급은 제외 | `AX전표_서브원장_호출누락_개발요청_20260825.md` · `.html` | **전달 대기** — AX 프로젝트 `10_ERP_DB연계/13_…` 배치 제안 |

> **전달 방법** — 위 2개 파일을 `E:\OneDrive\1.JOB\JEIL_AX\10_ERP_DB연계\` 로 복사하고 해당 프로젝트의 `02_진행상태` 에 등재한다.
> 이 환경(ERP_DB PC)에는 `E:` 드라이브가 없어 직접 배치하지 못했다.

---

## 5. 작업 로그 (최신 우선 — 에이전트가 갱신)

| 일자 | 작업 | 산출물 |
|---|---|---|
| 2026-08-25 | AX 전표 서브원장 미생성 원인규명 완료 → 릴레이 개발요청서 작성. 기준정보(재무제표구분·계정특성·서브시스템·관리항목·A_OBJECT) 5종 전수 정상 확인, SP 진입판정 26/26 통과, 입력필드 수기와 동등 → **데이터 보정 불필요** 판정. 소급 불필요 결정 | `AX전표_서브원장_호출누락_개발요청_20260825.md`·`.html`, `doc/db_log_20260824_180000.md`·`_193000.md` |
| 2026-07-08 | 7/7 정지 점검·재적재 안내(connector). 사전점검: `.erp` 3종·pyodbc 5.2.0·ODBC17 정상, 이 환경 Supabase 키 없음(정상, jeil_ax `.env` 자동로드로 실행 가능). ETL 정의 8종 확장·sales/purchase 연간전환 확인. Supabase 직접조회 안 함(키 미보유). 제시: dry-run `--job all --dry-run --full`(기대 96/351/2,710/3,786/58,256/32/140/659), 재적재 `--job all --full`(사용자 `!` 직접). item_master 58k는 야간 권장 | `doc/db_log_20260708_143604.md` |
| 2026-07-07 | 배포킷 불합리 5건 교정을 jeil_ax에 반영 — 킷 정의·README 개정(.env 지시 삭제→DPAPI 2단계, 실적재 `!` 직접 실행, `JEIL_AX연계` 포인터 규약, db_log 의무, link-manager 호출 경로), jeil_ax 설치본 재복사(해시 일치), `02_진행상태` 작업로그 기록 + HTML 재생성 + 정책관리 미러 동기화 | jeil_ax `agent_kit/`·`.claude/agents/`·`02_진행상태.md`, `정책관리\ERP_DB연계\ERP_DB연계_진행상태.*` |
| 2026-07-07 | 폴더 신설 + `erp-db-connector` ERP_DB 환경 설치(배포킷 기반, 보안규칙 적합화 반영) | `JEIL_AX연계/`, `.claude/agents/erp-db-connector.md` |
