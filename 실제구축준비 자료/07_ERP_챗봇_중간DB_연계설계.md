# ERP(UNIERP) ↔ 챗봇 중간 DB 연계 설계

> 작성일: 2026-06-25 · 작성: 최동혁  
> 대상: UNIERP(사외 IDC MSSQL) → PostgreSQL 중간 DB → 챗봇·부서 대시보드  
> 관련 문서: `03_ERP_UNIERP_데이터연계.html`, `04_챗봇전환_데이터관리_운영.html`

---

## 1. 핵심 결론

**UNIERP 운영 DB(MSSQL)에 챗봇·대시보드가 직접 연결되지 않습니다.**

```
UNIERP (IDC MSSQL)  →  [야간 배치 ETL]  →  PostgreSQL 중간 DB  →  대시보드 + 챗봇
     ① 원천              ② 동기화           ③ erp_ro / erp_secure      ④ 조회 API
```

| 구분 | 역할 |
|------|------|
| **운영 ERP** | 유니포인트 관리, 읽기전용 계정, **배치 1일 1회**만 접근 |
| **챗봇 ERP DB** | Azure PostgreSQL `erp_ro` / `erp_secure` — 집계·요약 테이블 |
| **챗봇·대시보드** | 중간 DB만 조회, **화이트리스트 SQL 템플릿**만 실행 |

### 이 구조가 효율적인 이유

| 이점 | 설명 |
|------|------|
| **성능 격리** | 직원 100명이 챗봇·대시보드를 써도 ERP 부하 0 |
| **보안** | AI 임의 SQL 실행 불가, 민감 데이터는 스키마·Entra 그룹 분리 |
| **복구 용이** | 중간 DB 유실 시 배치 재실행으로 복구 |

---

## 2. 전체 아키텍처

```
┌─────────────────────────────────────────────────────────────────────────┐
│  사외 IDC                                                                │
│  ┌──────────────────┐     읽기전용 View (jeilax_ro)                      │
│  │ UNIERP MSSQL     │ ─────────────────────────────────────┐            │
│  │ (운영 DB)        │                                      │            │
│  └──────────────────┘                                      │ VPN/TLS    │
└────────────────────────────────────────────────────────────│────────────┘
                                                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Azure (ai.jeilm.co.kr)                                                  │
│  ┌─────────────┐    ┌──────────────────────────────────────────────┐   │
│  │ 배치 Job    │───▶│ PostgreSQL (jeil_portal)                    │   │
│  │ 매일 03:00  │    │  portal      — 사용자·크레딧·대화·감사로그   │   │
│  └─────────────┘    │  erp_ro      — 영업·구매·재고 (일반)         │   │
│                     │  erp_secure  — 자금·인사 집계 (민감)         │   │
│  ┌─────────────┐    │  knowledge   — 문서 벡터 (pgvector)           │   │
│  │ App Service │◀──▶│  etl_meta    — 배치 로그·동기화 상태         │   │
│  │ 게이트웨이  │    └──────────────────────────────────────────────┘   │
│  └──────┬──────┘                                                        │
└─────────│───────────────────────────────────────────────────────────────┘
          │ Entra SSO + REST API / Tool Use
          ▼
   ┌──────────────┐     ┌──────────────┐
   │ 챗봇 포털    │     │ 부서 대시보드 │
   │ (자연어)     │     │ pages/*.html  │
   └──────────────┘     └──────────────┘
```

**핵심:** 챗봇과 대시보드는 **같은 중간 DB**를 쓰되, **같은 조회 API·쿼리 로직**을 공유합니다.

---

## 3. 데이터 4계층

| 계층 | 데이터 | 위치 | 챗봇 접근 |
|------|--------|------|-----------|
| **① 원천** | UNIERP MSSQL, OneDrive/SharePoint | IDC / MS 클라우드 | **불가** (배치만) |
| **② 연계 사본** | ERP 중간 DB, 문서 인덱스 | PostgreSQL | **가능** (유일한 ERP 소스) |
| **③ 생성** | 대화·크레딧·감사로그 | PostgreSQL `portal` | 본인·관리자 |
| **④ 비밀** | API 키, DB 암호 | Key Vault | 서버만 |

---

## 4. PostgreSQL 중간 DB 설계

### 4-1. 스키마 구조

```
jeil_portal (PostgreSQL)
├── portal          ← users, credits, conversations, messages, tool_audit
├── erp_ro          ← 영업·구매·재고·원가 (일반)
├── erp_secure      ← 자금일보·인사 집계 (민감, Entra 그룹)
├── knowledge       ← OneDrive 문서 벡터 (pgvector)
└── etl_meta        ← 배치 실행 로그, sync 상태
```

초기에는 포털 DB와 **동거**, 트래픽·데이터 증가 시 `erp_*`만 분리 가능.

### 4-2. 데모 페이지 → 중간 테이블 매핑

| 데모 페이지 | UNIERP 원천 (읽기만) | 중간 테이블 | 개방 단계 |
|-------------|----------------------|-------------|-----------|
| 영업_수주현황 | `S_BILL_HDR/DTL`, `S_BILL_COLLECTING` | `erp_ro.sales_orders_m` | 1차 |
| 구매_거래처별매입집계 | `M_IV_HDR/DTL`, `B_BP` | `erp_ro.purchase_m` | 1차 |
| 자재물류_재고입출고 | `ITEM_DOCUMENT`, `M_PUR_GOODS_MVMT` | `erp_ro.inventory_d` | 1차 |
| 프로젝트 원가 | `PM_PROJECT_MASTER`, 원가 테이블 | `erp_ro.project_cost_m` | 2차 |
| 자금_자금일보 | `A_GL`, `F_LN_INFO`, `F_NOTE` | `erp_secure.cash_daily` | 2차+승인 |
| 인사_인원급여추이 | `HAA010T`, `HDF070T` (집계만) | `erp_secure.hr_payroll_m` | 2차+승인 |
| 품목중복_조회 | `B_ITEM` | `erp_ro.item_master` | 1차 |

### 4-3. 공통 컬럼 (모든 erp_* 테이블)

```sql
synced_at    TIMESTAMPTZ   -- 포털 적재 시각
src_updated  TIMESTAMPTZ   -- ERP 원천 최종 수정 시각
batch_id     UUID          -- 배치 실행 ID (감사·재처리)
```

**원칙:** 중간 DB는 원본 **전체 복제가 아니라** 챗봇·대시보드가 바로 쓸 **집계·요약 형태**로 적재.

---

## 5. 동기화 배치 (ETL)

| 항목 | 정책 |
|------|------|
| **주기** | 기본 **매일 03:00** (ERP 백업·마감과 겹치지 않게 유니포인트 합의) |
| **방식** | **증분** (수정일시 기준) / 소량 집계 테이블은 **전체 재적재** |
| **변환** | 코드→명칭 (부서·거래처), 월별 집계 — AI가 코드 해석 불필요 |
| **실패** | Teams/메일 알림 + 1시간 후 재시도 1회 |
| **UI 표시** | 모든 화면·답변에 **「데이터 기준: YYYY-MM-DD 03:00」** 표기 |
| **로그** | `etl_meta` — 시작·종료·건수·오류, 90일 보관 |

### 배치 흐름

```
03:00 스케줄 → ERP View SELECT (증분)
            → 코드·집계 변환
            → PostgreSQL UPSERT
            → etl_meta 갱신
            → (실패 시) 알림 + 재시도
```

### ERP 네트워크 연결

| 단계 | 방식 | 비고 |
|------|------|------|
| 파일럿 | IDC IP 허용 + TLS | 빠른 검증 |
| 운영 | **IPSec VPN** | Azure VPN Gateway, DB 포트 비노출 |

직원 일상 조회는 **PostgreSQL만** — ERP VPN 부하는 **하루 1회 배치** 수준.

---

## 6. 챗봇 ERP 조회 (Tool Use)

### 6-1. 핵심 원칙

**AI가 SQL을 생성·실행하지 않습니다.** 사전 검증된 **화이트리스트 템플릿**만 실행.

```
직원 질문 → Claude Tool Use → 파라미터 추출 → 조회 API (RBAC)
         → 고정 SQL 실행 → 결과 주입 → 답변 + 기준시각 + 대시보드 링크
```

### 6-2. 조회 템플릿 예시

| 도구 ID | 파라미터 | 대상 테이블 | Entra 권한 |
|---------|----------|-------------|------------|
| `get_sales_monthly` | year, month | `erp_ro.sales_orders_m` | 전 직원 |
| `get_purchase_by_vendor` | vendor, period | `erp_ro.purchase_m` | 전 직원 |
| `get_inventory_status` | item_code | `erp_ro.inventory_d` | 전 직원 |
| `get_project_cost` | project_code | `erp_ro.project_cost_m` | PM·경영진 |
| `get_cash_daily` | date | `erp_secure.cash_daily` | AI-Portal-Finance |
| `get_hr_headcount_trend` | year | `erp_secure.hr_payroll_m` | AI-Portal-HR |

### 6-3. 보안 장치 (서버 단 강제)

| 장치 | 내용 |
|------|------|
| 권한 검사 | Entra 그룹 — API에서 차단 (챗봇 판단 아님) |
| 행 수 상한 | 1회 최대 200행 |
| 감사 로그 | `portal.tool_audit` — 사용자·템플릿·파라미터·건수 |
| 답변 신뢰성 | 수치 + 동기화 시각 + 해당 `pages/` 링크 |

---

## 7. 대시보드 vs 챗봇 — 동일 DB, 다른 소비

| | 부서 대시보드 (`pages/`) | 챗봇 |
|--|--------------------------|------|
| 데이터 소스 | `erp_ro` / `erp_secure` | 동일 |
| 접근 | REST API (`/api/erp/*`) | Tool Use 템플릿 |
| 적합 | 차트·표·정형 화면 | 자연어·요약 |
| 권한 | 페이지 + Entra | 템플릿별 RBAC |

**효율 포인트:** ETL·중간 테이블 **1벌**, API와 Tool이 **동일 쿼리 로직 공유**.

---

## 8. 단계별 개방 로드맵

| 단계 | 영역 | 스키마 | 권한 | 시기 |
|------|------|--------|------|------|
| **1차** | 영업·구매·재고·품목 | `erp_ro` | 전 직원 | W10 |
| **2차** | 프로젝트 원가 | `erp_ro` | PM·경영진 | W12 |
| **2차+승인** | 자금일보 | `erp_secure` | AI-Portal-Finance | 승인 후 |
| **2차+승인** | 인사 집계(총액만) | `erp_secure` | AI-Portal-HR | 승인 후 |

> **개인별 급여·주민번호·계좌번호는 중간 DB 미연계** — 유니포인트 View 단계에서 제외.

---

## 9. 하지 말아야 할 구조

| 방식 | 문제 |
|------|------|
| 챗봇 → UNIERP 직접 연결 | ERP 성능·장애 전파, AI 임의 SQL 위험 |
| MSSQL 전체 복제 | 용량·민감컬럼 과다 |
| 실시간 ERP 조회 (초기) | 복잡도↑, 일 배치로 대부분 요구 충족 |
| AI `SELECT *` 생성 허용 | SQL 인젝션·대량 유출 |
| OneDrive CSV만으로 ERP 대체 | 권한·갱신·감사 불가 |

---

## 10. 구현 체크리스트

| No. | 완료 기준 | 담당 |
|-----|-----------|------|
| 1 | 유니포인트 협의 — `jeilax_ro` 계정, View, 방화벽/VPN | 최동혁 ↔ 유니포인트 |
| 2 | PostgreSQL `erp_ro`, `erp_secure`, `etl_meta` 스키마 생성 | 최동혁 |
| 3 | 1차 배치 — 영업·구매·재고 ETL 가동 | 최동혁 |
| 4 | REST API — `pages/` 대시보드 실데이터 전환 | 최동혁 |
| 5 | 챗봇 Tool 3종 + `tool_audit` 로깅 | 최동혁 |
| 6 | 2차 민감 영역 — 경영진 승인 + Entra 그룹 | 경영진·최동혁 |

---

## 11. 최종 권고 요약

| 결정 항목 | 권장 |
|-----------|------|
| ERP 연결 대상 (챗봇·UI) | **PostgreSQL 중간 DB만** |
| ERP 원천 접근 | **배치 1일 1회**, 읽기전용 View |
| DB 제품 | UNIERP = MSSQL 유지, 포털 = **PostgreSQL** |
| 챗봇 ERP 조회 | **화이트리스트 Tool + RBAC API** |
| 민감 데이터 | `erp_secure` + Entra 그룹 |
| 네트워크 | 파일럿 IP허용 → 운영 **VPN** |

---

*JEIL AX 실제 구축 준비 · 07 ERP·챗봇 중간DB 연계설계 · 2026-06-25*
