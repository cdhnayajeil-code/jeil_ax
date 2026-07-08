# 07 · 마이그레이션·Azure 이관 설계서

> 관리자: 최동혁(dh.choi@jeilm.co.kr) · 기준일: 2026-07-08 · 상태: Draft
> 관련: [03 아키텍처 §8 어댑터경계](03_시스템아키텍처_설계.md) · [04 DB설계](04_데이터베이스_설계.md) · [08 보안](08_보안_데이터안정성.md)
> 이관 관제 정본(값 복제 금지): [`이관/00_현재시스템_상태스냅샷`](../실제구축준비%20자료/이관/00_현재시스템_상태스냅샷.md) · [`이관/02_Azure이관계획`](../실제구축준비%20자료/이관/02_Azure이관계획.md)

이 문서는 **"흔들리지 않는 이관"** 을 위한 설계다. 핵심 전략은 [`이관/02`](../실제구축준비%20자료/이관/02_Azure이관계획.md)의 원칙을 계승한다: **재구축이 아니라 어댑터 교체 + 데이터 복사.**

---

## 1. 이관 단계 (전체 그림)

```
[1] GitHub Pages ──완료──▶ [2] Vercel + Supabase ──현재──▶ [3] Azure (미착수, 계획만)
```

- 현재 = **[2] 데이터화 진행 중**. Vercel(`jeil-ax`, ai·ax) + Supabase(`dvzohdqtjzocgcclgwro`).
- [3] Azure는 계획 수립 완료·착수 전. 트리거는 경영 의사결정(호스팅 확정, 상용/보안 요건).

## 2. 이관을 쉽게 만드는 전제 = 어댑터 경계

이관 비용을 좌우하는 것은 코드가 아니라 **경계의 수와 명확성**이다. JEIL AX는 [03 §8](03_시스템아키텍처_설계.md)의 5개 경계로 백엔드 교체를 흡수한다. 이 문서는 그 경계별 Azure 매핑을 정의한다.

## 3. Supabase → Azure 서비스 매핑

| 기능 | 현재(Supabase) | Azure 대응(권고) | 교체 지점(어댑터) | 난이도 |
|---|---|---|---|---|
| DB | PostgreSQL | **Azure Database for PostgreSQL** (Flexible) | 연결문자열/`api.js` | 낮음(동일 Postgres) |
| 인증(사내) | Entra(이미 MS) | Entra 그대로 | 없음 | 없음 |
| 인증(협력사) | Supabase Auth | **Entra External ID**(B2B/B2C) 또는 자체 | `supabaseClient.js`/인증 어댑터 | 높음(협력사 D1 미결) |
| 서버리스 | Edge Functions(Deno) | **Azure Functions** 또는 **Container Apps** | 함수별 재배포 | 중(런타임·시크릿) |
| 스토리지 | Storage(vendor-photos) | **Azure Blob Storage** | 파일 어댑터(서명 URL) | 중 |
| 실시간 | Realtime | **Azure Web PubSub** 또는 폴링 | `subscribe()` 구현 | 중 |
| 시크릿 | `.env`/Supabase Secrets | **Azure Key Vault** | 배포 파이프라인 | 낮음 |
| 배포/호스팅 | Vercel | **Azure Static Web Apps** vs App Service vs 사내 IIS | 빌드·CI | 중(호스팅 미확정) |
| RLS | Postgres RLS | 동일(Postgres RLS 유지) | 없음(DDL 이식) | 낮음 |
| 배치 스케줄 | 수동/PC | **Azure Functions Timer** 또는 pg_cron | ETL 배포 | 낮음 |

> RLS·DDL은 Postgres 공통이라 **데이터/스키마 이관 자체는 비교적 안전**하다. 리스크는 인증(협력사)·서버리스 런타임·실시간에 집중된다.

## 4. 어댑터 교체 지점(코드)

| 경계 | 파일 | 지금 | 이관 시 |
|---|---|---|---|
| 데이터 백엔드 | `app/lib/api.js` | `DATA_BACKEND='supabase'`, `supabaseAdapter` | `azureAdapter` 추가·스위치 |
| 세션/인증 | `app/lib/supabaseClient.js` | supabase-js PKCE | Azure 인증 클라이언트 |
| 공개설정 | `app/config.js` | Supabase URL/anon | Azure 엔드포인트 |
| 서버 | `supabase/functions/*` | Deno | Azure Functions/Container Apps |

- **원칙**: 화면 HTML은 `portalApi`/`authApi`만 부르므로 **화면 코드를 건드리지 않고** 어댑터만 바꾼다. 신규 코드도 이 계약을 지켜야 이관성이 유지된다.

## 5. 데이터 복사 절차(개요)

1. **스키마 이식**: `이관/sql/01~07` + `erp_ro`/`etl_meta` 마이그레이션을 Azure PostgreSQL에 적용. RLS·Hook·함수 포함.
   - **선행 개선**: 현재 `erp_ro`/`etl_meta` DDL이 파일로 없으므로(직접 apply), 이관 전 마이그레이션을 파일로 추출·정리 → 재현 가능성 확보([04 §6](04_데이터베이스_설계.md), [09 ADR](09_ADR_의사결정기록.md)).
2. **데이터 복사**: `pg_dump`/`pg_restore` 또는 논리 복제로 `public`·`erp_ro` 복사. 대상 행수는 [04 §2](04_데이터베이스_설계.md) 기준으로 검증.
3. **Auth 이관**: 협력사 계정은 인증 방식 확정(D1) 후 재발급/마이그레이션. 사내는 Entra 유지라 무영향.
4. **스토리지 복사**: `vendor-photos` → Blob. 경로 규약(`{bp_cd}/{po_no}/{uuid}`)·서명 URL 재구현.
5. **시크릿 이전**: Key Vault로. 값은 문서에 남기지 않음.
6. **컷오버**: `config.js`/어댑터 스위치, DNS(`ai.jeilm.co.kr`) 전환.

## 6. 롤백·전환 게이트

- **롤백**: 컷오버 전까지 Supabase 병행 유지. DNS·어댑터 스위치만 되돌리면 원복(데이터는 이관 시점 스냅샷 차이 주의).
- **전환 게이트(선행 확정 항목)**:
  - [ ] 호스팅 확정(Azure SWA vs App Service vs 사내 IIS) — [CLAUDE.md §11-B]
  - [ ] 협력사 인증 D1 확정(Entra External ID vs 전용)
  - [ ] 시크릿 Key Vault 구성, `erp_ro`/`etl_meta` 마이그레이션 파일화
  - [ ] RLS 격리 실테스트(실사용자 시나리오) 통과 — 현재 미실시([08](08_보안_데이터안정성.md))
  - [ ] Entra redirect URI에 신규 호스트 등록(관리자 작업, [CLAUDE.md §5.2])

## 7. 이관 시 위험·완화

| 위험 | 영향 | 완화 |
|---|---|---|
| 협력사 인증 재설계 | 계정 전면 영향 | D1 조기 확정, 어댑터 `resolveSupplier()` 추상화 |
| Edge Fn 런타임 차이(Deno→Azure) | 함수 재작성 | 로직을 얇게·DB RPC로 이전 가능분 최대화 |
| Realtime 대체 | 실시간 UX 저하 | Web PubSub 또는 폴링 폴백 |
| DDL 재현 불가(파일 없음) | 이관 누락 | 이관 전 마이그레이션 파일화 |
| RLS 미검증 | 데이터 노출 | 이관 전·후 격리 테스트 필수 |

> 세부 절차·체크리스트·롤백은 [`이관/02_Azure이관계획`](../실제구축준비%20자료/이관/02_Azure이관계획.md)이 실행 정본이다. 본 문서는 제품 관점의 설계·경계 정의를 담고, 값·현황은 이관 스냅샷을 참조한다.
