# 02. Azure 이관 계획 — Supabase → Microsoft Azure (운영 전환)

> 작성일: 2026-06-29 · 관리: 최동혁 · 대상: 데모 데이터화([2]) 안정화 이후 운영([3])
> 핵심: 데모를 Supabase로 **본선과 동일한 스키마·RLS·인증 경계**로 만들어 뒀기 때문에, 이 단계는 "재구축"이 아니라 **어댑터 교체 + 데이터 복사** 중심의 이식이다.
> 관련: `00_현황스냅샷`, `01_실행가이드`, `08/03_실구축기획/07`, `실제구축준비 자료/01·02·03·07`, `CLAUDE.md §3·§4·§5·§6`

---

## 1. 언제 옮기나 (전환 트리거)

아래 중 하나라도 해당하면 Azure 전환을 착수한다.

- **상업적/운영 트래픽 발생** — Vercel Hobby(비상업) 약관 한계 도달.
- **Supabase Free 한계** — DB 500MB·Storage 1GB 근접, pause가 업무에 지장.
- **ERP 실연계 필요** — 중간 DB·VPN·야간배치가 본선에 들어오는 시점(`CLAUDE.md §4`).
- **회사 보안/컴플라이언스 요구** — 자체 인증서, 감사, 데이터 국내 보관, Key Vault 등.
- **경영진의 운영 GO 결정**(`실제구축준비 자료/00 종합기획`).

---

## 2. 매핑 — Supabase → Azure

| Supabase(임시) | Azure(운영) | 이전 난이도 | 메모 |
|---|---|---|---|
| Postgres DB | **Azure Database for PostgreSQL** Flexible Server | 낮음 | 표준 SQL·RLS 그대로 이식 |
| RLS 정책 | 동일 Postgres RLS + 앱 계층 2중(`08/03/03 §4-2`) | 낮음 | 클레임 소스만 Entra로 |
| Auth(사내) | **Entra ID**(이미 본선) | 낮음 | 데모부터 Entra라 추가비용 적음 |
| Auth(협력사) | **Entra External ID(B2B)** 또는 전용(`08/03/03 D1`) | 중간 | 운영 D1 결정 의존 |
| Storage(사진) | **Azure Blob Storage** | 낮음 | 객체 복사 + 서명 URL |
| Realtime | **Azure Web PubSub / SignalR** 또는 SSE(`08/03/04`) | 중간 | 구독 코드 어댑터 교체 |
| Edge Functions | **Azure Functions** | 중간 | 시드·검증·BFF |
| anon/service 키 | **Managed Identity + Key Vault** | 낮음 | 비밀값 일원화(`CLAUDE.md §6`) |
| Vercel 호스팅 | **Azure Static Web Apps / App Service** | 낮음 | 프론트 그대로 |
| (없음) | **중간 DB + ERP 야간배치/CDC** | 별도 트랙 | 유니포인트 협의(`실제구축준비 자료/03·07`) |

---

## 3. 이전 절차 (단계별)

### 3-1. 인프라 프로비저닝
- Azure 구독·리소스 그룹·VNet. Azure Database for PostgreSQL(Flexible) 생성, 방화벽/프라이빗 엔드포인트.
- Blob Storage 계정·컨테이너(`vendor-photos`). Static Web Apps/App Service.
- **Key Vault** 생성, 모든 비밀값 이전(소스·문서 금지 유지).

### 3-2. 데이터 이전
- 스키마: Supabase에서 `pg_dump --schema-only` → Azure PG 적용. RLS 정책 포함 확인.
- 데이터: `pg_dump --data-only`(또는 COPY) → Azure PG. **데모는 마스킹 샘플** 그대로.
- 운영 데이터는 별도 — ERP 중간 DB 야간배치로 `erp_ro` 채움(`08/03/02`).
- Storage 객체: Supabase Storage → Azure Blob 복사(azcopy 등), 경로 규칙 유지.

### 3-3. 인증 전환
- 사내: Supabase OIDC(Entra) → **Entra 직접**. 이미 Entra라 클레임 매핑만 정리.
- 협력사: Supabase Auth → **Entra External ID(B2B) 또는 전용**(D1 결정). 계정·`vendor_bp` 매핑 이관 → `supplier_account`·`supplier_bp_map`(`08/03/02 §4`).
- 토큰 보관: localStorage → **BFF/HttpOnly 쿠키**(`CLAUDE.md §6`, XSS 내성).

### 3-4. 애플리케이션 전환
- `api.js`의 어댑터를 `supabaseAdapter` → `azureAdapter`로 교체(데이터 접근·인증·실시간·스토리지 모두 이 뒤에서).
- Realtime → Web PubSub/SignalR 또는 SSE 구현으로 치환.
- 환경변수 → Key Vault 참조.

### 3-5. 검증·컷오버
- RLS 격리 재검증(`01 G절` 동일 테스트, Azure 환경).
- 감사 로그·접근 로깅 동작(`CLAUDE.md §6`, 민감 화면 우선).
- `/security-review` + 권한 인가 테스트(필수).
- 도메인 전환: `ai.jeilm.co.kr` → Azure. 인증서(회사 인증서 가능 — GitHub Pages 제약 해소).

---

## 4. 병행 운영·롤백

- **병행 기간**: 데모(Vercel+Supabase)와 운영(Azure)을 일정 기간 동시 가동, 데모 도메인은 `ai-dev`로 유지.
- **롤백**: Azure 컷오버 실패 시 DNS를 데모/이전으로 복귀(TTL 짧게 설정). 데이터는 단방향 복사라 원본(Supabase) 보존.
- **데이터 정합**: 컷오버 전 최종 동기화 시점 동결(freeze) → 차분 복사 → 전환.

---

## 5. 비용·리스크 메모

- Azure는 **유료**. 전환 착수 전 `실제구축준비 자료/00·01` + 비용기획으로 예산 승인.
- 리스크: 인증(협력사 D1) 미결정 시 3-3 지연 → D1 조기 결정 권고.
- 리스크: ERP 연계는 유니포인트 협의 선행(별도 트랙) — Azure 인프라와 병렬 진행.

---

## 6. 전환 전 확정 항목

- [ ] 운영 호스팅 확정(Azure Static Web Apps vs App Service vs 사내 IIS) — `실제구축준비 자료/01`
- [ ] 협력사 인증 D1(Entra B2B vs 전용) 결정 — `08/03/03`
- [ ] 중간 DB·ERP 배치 파이프라인 — 유니포인트 협의
- [ ] Key Vault·Managed Identity 적용
- [ ] 감사 로그·DR/백업 설계 — `실제구축준비 자료/05`, `CLAUDE.md §11-E`
