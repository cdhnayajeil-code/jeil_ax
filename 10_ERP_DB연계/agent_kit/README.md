# ERP_DB 연결 에이전트 배포 킷 (erp-db-connector)

> 작성 2026-07-07 · 관리 최동혁 · 목적: **ERP(UNIERP) 운영 MSSQL ↔ 중간DB(Supabase erp_ro) 연결·ETL 전담 서브에이전트**를
> jeil_ax 저장소와 **ERP_DB 작업환경(사내 OneDrive `ERP_DB\`) 양쪽에 동일하게 설치**하기 위한 자료 모음.
> 에이전트 정의 원본: `erp-db-connector.agent.md` (이 폴더가 단일 출처 — 수정 시 양쪽 설치본에 재복사)

---

## 1. 역할 분담 (기존 에이전트와의 경계)

| 에이전트 | 소관 | 설치 위치 |
|---|---|---|
| **erp-db-connector** (본 킷) | ERP운영DB 읽기전용 연결·연결테스트·테이블사전(table_dict)·ETL dry-run/실적재·batch_run 점검 | jeil_ax + ERP_DB 작업환경 |
| erp-db-link-manager (기존) | `10_ERP_DB연계/` 문서(현재상태·기획·진행상태) 갱신 + 정책관리 미러 동기화 — **DB 작업 안 함** | jeil_ax 전용 |

connector가 DB 작업을 마치면 → link-manager를 호출해 문서·미러를 갱신한다(이중 관리 금지).

## 2. 설치 방법

**jeil_ax 저장소** (완료 — 2026-07-07):
```
.claude/agents/erp-db-connector.md   ← 이미 설치됨
```

**ERP_DB 작업환경** (사내 OneDrive `ERP_DB\` 폴더를 Claude Code로 열어 쓰는 경우 — 2026-07-07 설치 완료):
```
1) ERP_DB\.claude\agents\ 폴더 생성 (없으면)
2) 본 킷의 erp-db-connector.agent.md 를 ERP_DB\.claude\agents\erp-db-connector.md 로 복사
   (설치본은 ERP_DB 환경 고정 문구·절대경로를 담아 적합화 가능 — 규칙 내용은 킷과 동일해야 함)
3) ERP_DB\JEIL_AX연계\README.md (로컬 포인터 문서)에 ETL 도구 실제 경로·연계 현황을 기재
   ※ .env 는 만들지 않는다 — OneDrive 폴더 내 비밀값 평문 저장은 ERP_DB 보안규칙(2026-06-12) 위반.
     ERP 접속은 %USERPROFILE%\.erp\ DPAPI 저장소(_erp_conn.py 자동 폴백)를 사용한다.
4) Claude Code에서 "erp-db-connector로 연결 테스트해줘" 로 호출 확인
```
※ 에이전트 정의는 작업환경을 자동 인지한다(jeil_ax면 `10_ERP_DB연계/etl/`, ERP_DB 환경이면 `JEIL_AX연계\README.md` 포인터 → ETL 경로·`erp_chat/data` 메타, `정책관리\ERP_DB연계\` 미러는 읽기 전용 참조).

## 3. 사전 준비 체크리스트 (연결이 되기 위한 조건)

| # | 항목 | 담당 | 상태 |
|---|---|---|---|
| 1 | ERP운영DB **읽기 전용 계정** 발급 (유니포인트/인프라 협의) | 관리자 | ☐ |
| 2 | 접속 네트워크 허용 — 파일럿: 작업 PC IP 허용 / 운영: VPN (CLAUDE.md §4.2) | 관리자 | ☐ |
| 3 | 작업 PC에 **ODBC Driver 17/18 for SQL Server** 설치 + `pip install pyodbc` | 작업환경 | ☐ |
| 4 | ERP 접속 수단 준비 — 관리자 PC: `%USERPROFILE%\.erp\` DPAPI 저장소(`.db`+`pw.xml`+`port.xml`, `_erp_conn.py` 자동 폴백) / 서버 배포: 환경변수 `ERP_DB_CONN` (2026-07-07 DPAPI 폴백 가동 확인) | 작업환경 | ☑ |
| 5 | Supabase 키 — jeil_ax 로컬 `.env`에만 둔다(아래 키 이름). **OneDrive 폴더(ERP_DB 작업환경 포함)에는 `.env` 생성 금지** | 작업환경 | ☑ |
| 6 | Supabase `erp_ro`·`etl_meta` 스키마 적용 (2026-07-07 적용 완료) | — | ☑ |

```dotenv
# jeil_ax 루트 .env (키 이름만 예시 — 실제 값은 로컬 전용, 커밋 금지)
ERP_DB_CONN=                    # (선택) 서버 배포용 — 관리자 PC에선 비워두고 DPAPI 폴백 사용, OneDrive에 평문 저장 금지
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=      # 적재 RPC 전용 — 프론트/문서에 절대 노출 금지
ERP_DB_META_DIR=                # (선택) ERP 메타 폴더 경로 재정의
```

## 4. 표준 사용 시나리오

1. **연결 테스트**: "erp-db-connector로 ERP DB 연결 확인" → 드라이버/네트워크/계정 원인 구분 보고
2. **테이블 사전 적재**: `load_table_dict.py` (ERP 접속 없이 로컬 메타 → `erp_ro.table_dict`)
3. **추출 검증**: `etl_run.py --job all --dry-run` (건수만 — 부하·정합 확인)
4. **실적재**: 에이전트가 명령 제시 → **사용자가 `!` 프리픽스로 직접 실행**(운영데이터 외부반출이라 에이전트 자동 실행 차단 — 2026-07-07 실측) → `etl_meta.batch_run` 결과 확인
5. **작업 후**: erp-db-link-manager 호출(jeil_ax 세션) → `02_진행상태` 갱신 + 미러 동기화. ERP_DB 환경 작업분은 `JEIL_AX연계\README.md` 작업로그 + `doc/db_log_*.md`에 기록

## 5. 안전 규칙 요약 (에이전트에 내장된 것)

- ERP운영DB는 **SELECT(화이트리스트·파라미터 바인딩·NOLOCK)만** — DDL/DML 금지
- 비밀값: ERP 접속은 환경변수 `ERP_DB_CONN`(서버) 또는 `%USERPROFILE%\.erp\` DPAPI(관리자 PC 폴백) — **OneDrive 폴더에 `.env` 생성·평문 저장 금지**, 어떤 출력·문서에도 남기지 않음, 서버 지칭은 별칭 "ERP운영DB"
- 대량 추출은 야간 배치 전제, 업무시간엔 dry-run까지 / **실적재는 사용자 `!` 직접 실행**(에이전트는 명령 제시·결과 확인만)
- ERP_DB 작업환경에선 DB 작업 시 `doc/db_log_YYYYMMDD_HHMMSS.md` 기록 의무(ERP_DB CLAUDE.md)
- 쓰기는 Supabase RPC(service_role) 경유만 — `erp_ro` REST 미노출, 프론트의 ERP 직접 접속 금지
- 유니포인트 협의 사항(뷰·계정·스키마)은 임의 진행 금지, 요청 목록으로 제시
