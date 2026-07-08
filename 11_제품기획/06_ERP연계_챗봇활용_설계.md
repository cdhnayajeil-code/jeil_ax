# 06 · ERP연계·챗봇활용 설계서 (P4 연결)

> 관리자: 최동혁(dh.choi@jeilm.co.kr) · 기준일: 2026-07-08 · 상태: Draft
> 관련: [03 아키텍처](03_시스템아키텍처_설계.md) · [04 DB설계](04_데이터베이스_설계.md) · [08 보안](08_보안_데이터안정성.md)
> ERP 연계 관제 정본(값 복제 금지): [`10_ERP_DB연계/01_연계기획`](../10_ERP_DB연계/01_연계기획.md) · [`10_ERP_DB연계/03_중간DB_구축실행기획`](../10_ERP_DB연계/03_중간DB_구축실행기획.md)

이 문서는 제품기획 세트의 **핵심 신규 설계**다. 현재 끊겨 있는 **중간DB(`erp_ro`) → 앱/챗봇** 구간(P4)을 안전하게 잇는 방법을 정의한다.

---

## 1. 문제: P4 단절

```
ERP운영DB ──ETL──▶ erp_ro(집계 사본) ──✕ 단절 ──▶ 부서 대시보드 / 챗봇
   완료         파일럿 실적재 완료         여기가 비어 있음
```

- `erp_ro`는 REST에 비노출이고 적재만 RPC로 이뤄져, **클라이언트·챗봇이 읽을 경로가 없다.**
- 그래서 부서 페이지는 정적 샘플이고, 챗봇 Tool은 포털DB(`sp_*`)만 본다.
- **목표**: ERP 무영향·읽기전용·RLS·화이트리스트 원칙을 지키면서 `erp_ro`를 (a) 부서 대시보드와 (b) 챗봇에 노출한다.

## 2. 설계 원칙 (P4에서도 불변)

1. `erp_ro` 스키마 자체는 **REST 비노출 유지**. 노출은 **명시적 화이트리스트 뷰/RPC**로만.
2. 노출 객체는 **집계·요약 위주**(원시 행 대량 노출 금지). ERP 원천 직접 접근은 절대 없음.
3. 접근은 **사내 인증(Entra) 사용자만**. anon·vendor 차단. 부서 매핑으로 필요한 데이터만.
4. AI는 SQL 생성 금지. **사전 등록 Tool/뷰만** 호출.
5. 대량/집계는 중간DB에서. ERP 운영 부하 0.

## 3. 노출 계층 설계 (두 가지 방식, 병행)

### 3.1 방식 A — 읽기전용 화이트리스트 뷰(부서 대시보드용)

`erp_ro` 위에 **공개용 뷰**를 별도 스키마(예: `erp_pub`) 또는 `public`에 `security_barrier` 뷰로 정의하고, 그 뷰에만 사내 SELECT를 허용한다.

```
erp_ro.sales_orders_m ──▶ view erp_pub.v_sales_monthly (사내 SELECT, RLS: is_internal())
erp_ro.purchase_m     ──▶ view erp_pub.v_purchase_monthly
erp_ro.inventory_d    ──▶ view erp_pub.v_inventory_daily
erp_ro.pur_order_s    ──▶ view erp_pub.v_pur_order (거래처·상태 요약)
erp_ro.item_master_s  ──▶ view erp_pub.v_item (품목 조회)
```

- 부서 페이지(`pages/*_2026.html`)는 `api.js`에 새 메서드(예: `erpApi.salesMonthly()`)를 추가해 이 뷰를 조회 → 정적 배열을 실데이터로 교체.
- 데이터 기준시각은 `etl_meta.v_last_success`를 사내 노출 뷰로 함께 제공(화면 「기준: YYYY-MM-DD HH:MM」).

### 3.2 방식 B — 챗봇 Tool 확장(2단계, 부서 매핑)

`jeil-chat`에 **ERP 중간DB 조회 Tool**을 추가한다. 각 Tool은 service_role로 `erp_ro`(또는 3.1 뷰)를 집계 조회하고, **부서·권한에 매핑**한다.

| 신규 Tool(예시) | 반환 | 소스 |
|---|---|---|
| `get_sales_monthly(months?)` | 월별 매출 요약 | `sales_orders_m` |
| `get_purchase_by_vendor(months?)` | 거래처별 매입 | `purchase_m` |
| `get_inventory_status()` | 재고 입출고 현황 | `inventory_d` |
| `get_item(keyword)` | 품목 조회/중복 | `item_master_s` |
| `get_pur_order_summary(filter)` | 발주 현황 | `pur_order_s` |

- 현재 1단계 Tool 3종(포털DB)에 **더해** 등록. 임의 SQL 여전히 금지.
- **권한 등급**: 초기에는 전 사내 사용자 동일. 이후 Entra 보안그룹(`AI-Portal-Finance`·`-HR` 등)으로 민감 Tool(자금·인사) 접근을 제한([CLAUDE.md §5], [09 ADR](09_ADR_의사결정기록.md)). 자금·인사는 `erp_secure`(P5)까지 보류.

### 3.3 방식 비교

| | 방식 A(뷰) | 방식 B(챗봇 Tool) |
|---|---|---|
| 소비자 | 부서 대시보드 화면 | 챗봇 대화 |
| 노출 | 사내 SELECT 뷰(RLS) | Edge Fn service_role(집계만) |
| 권장 | 표·차트 정형 화면 | 자유질의 요약 |
| 공통 | erp_ro 비노출 유지·화이트리스트·집계·사내한정 | |

## 4. 데이터 흐름(P4 연결 후, 목표)

```
ERP ─ETL(야간)─▶ erp_ro/etl_meta
                     │
      ┌──────────────┼───────────────────────────┐
      ▼(뷰)                                       ▼(RPC/Tool)
  erp_pub.v_*  ◀─사내 SELECT(RLS)─ 부서 대시보드     jeil-chat Tool ◀─Entra 사내── 챗봇
  + v_last_success (기준시각)                      (부서 매핑·권한 등급)
```

## 5. 매핑 선행 조건 (유니포인트 협의 — 임의 진행 금지)

- 현재 ETL 추출 SQL·ERP 테이블 매핑은 **"가설"**(유니포인트 뷰 스펙 확정 전). 실 연동 전 확정 필요:
  - 전용 읽기계정 `jeilax_ro`(현재는 관리자 계정, P1에서 교체).
  - 리포팅 뷰/화이트리스트 컬럼 스펙(민감 컬럼 제외).
  - 발주·검사 매핑(`M_PUR_ORD_HDR/DTL`·`Q_INSPECTION`·`B_BIZ_PARTNER`) 실스키마 검증.
- 이 협의는 사용자(관리자)가 유니포인트와 진행하고, Claude는 **요청 목록만 제시**([CLAUDE.md §4.6]).

## 6. 데이터 정합·안정성

- **조인축 `po_no`**: 포털 `sp_order_header.po_no` ↔ ERP `pur_order_s`의 발주번호. 매핑 테이블/뷰로 연결(현재 포털 발주는 자체 시드, 실연동 시 ERP 발주를 기준으로 전환 검토).
- **기준시각**: 모든 ERP 파생 화면에 `v_last_success` 기준 표기 → 배치 실패 시 "오래된 데이터"임을 사용자가 인지.
- **증분·리프레시**: 현재 롤링(매출·매입 3개월, 재고 31일) + 스냅샷. 향후 `pg_cron`으로 스케줄 자동화 검토([04 §7](04_데이터베이스_설계.md)).

## 7. 단계별 실행(요약)

| 단계 | 내용 | 선행 | 상태(2026-07-08) |
|---|---|---|---|
| P4-1 | 사내 전용 뷰 `public.v_erp_*` 6종 + RLS + 기준시각 뷰 정의 | 매핑 가설 검증 | ✅ **완료**(마이그레이션 2건 적용, 격리 실테스트 통과) |
| P4-2 | `api.js`에 `erpApi` 추가, 부서 페이지 1종 파일럿 실연동 | P4-1 | ✅ **완료**(`구매_거래처별매입집계` 파일럿) |
| P4-3 | `jeil-chat` ERP Tool 추가, 사내 전체 파일럿 | P4-1 | ✅ **완료**(Tool 4종 배포 v7) |
| P4-4 | Entra 보안그룹 권한 등급 적용(민감 Tool 제한) | 보안그룹 신설([CLAUDE.md §11-C]) | ⬜ 대기 |
| P5 | `erp_secure`(자금·인사) 별도 스키마·강권한 | 정책·법무 검토 | ⬜ 예약 |

> **구현 노트(2026-07-08)**: 노출은 `erp_pub`가 아닌 **`public.v_erp_*` `security_invoker` 뷰**로 구현했다(erp_ro는 REST 비노출 유지, authenticated 최소 GRANT + 기존 `internal_select_*` RLS로 사내만 통과). 챗봇은 service_role 전용 read GRANT로 뷰를 조회한다. 재현 SQL: [`이관/sql/08_erp_pub_reporting_views.sql`](../실제구축준비%20자료/이관/sql/08_erp_pub_reporting_views.sql). 상태 정본은 [`10_ERP_DB연계/02_진행상태`](../10_ERP_DB연계/02_진행상태.md).
> **의존성**: 부서 페이지가 사용자에게 실데이터를 보이려면 내부 Entra→Supabase 세션(role=internal)이 필요하다. 현재는 사내 Supabase 세션 보유자에게만 표시되고, 그 외에는 목업으로 폴백한다(내부 세션 브리지는 [ADR-104/05](09_ADR_의사결정기록.md) 트랙).

> ERP 연계의 상태·진행은 [`10_ERP_DB연계/02_진행상태`](../10_ERP_DB연계/02_진행상태.md)가 정본이다. 본 설계가 실행에 반영되면 전담 에이전트 `erp-db-link-manager`로 해당 문서를 갱신한다.
