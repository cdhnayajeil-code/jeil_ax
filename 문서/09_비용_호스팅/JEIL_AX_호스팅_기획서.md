# JEIL AX 내부 서비스 — 호스팅 · 운영 기획서 (Azure 전면 전환)

작성일 2026-06-18 · 작성 최동혁
대상: ai.jeilm.co.kr / 니즈조사 대시보드 / ERP(MSSQL) 연동

---

## 1. 핵심 결론

SharePoint는 문서·리스트·정적 페이지·SPFx 웹파트·Power Apps 임베드 용도로는 적합하지만, 커스텀 백엔드(API)나 자체 도메인 SPA를 직접 구동하는 **서비스 호스팅 플랫폼이 아니다.** 따라서 JEIL AX 본 서비스(ai.jeilm.co.kr)와 ERP 연동 기능은 SharePoint에 올릴 수 없다.

이미 Entra ID(MFA)·자체 도메인·외부 IDC MSSQL을 사용 중이므로, 동일 Microsoft 생태계인 **Azure로 전면 전환**하는 것이 인증·운영·보안 측면에서 가장 일관되고 효율적이다.

SharePoint는 폐기하지 않고 **기획서·운영 매뉴얼·산출물 보관소** 역할로 계속 활용한다(현재 MS_connect 폴더 흐름 유지).

## 2. SharePoint vs Azure 적합성

| 항목 | SharePoint Online | Azure (권장) |
|---|---|---|
| 정적 페이지/대시보드 | 가능(제한적, 자유도 낮음) | Static Web Apps로 완전 지원 |
| 커스텀 백엔드/API | 불가 | App Service / Container Apps |
| 자체 도메인(ai.jeilm.co.kr) | 사실상 불가 | 커스텀 도메인+SSL 표준 지원 |
| ERP(MSSQL) 직접 연동 | 불가 | VNet/Private Endpoint로 연결 |
| Entra 인증(MFA) | 기본 연동 | Easy Auth로 코드 없이 통합 |
| CI/CD 자동배포 | 어려움 | GitHub Actions 표준 지원 |

> 결론: 보여주기만 하는 화면은 SharePoint로도 흉내낼 수 있으나, ERP를 조회·갱신하는 서버 로직이 필요한 본 서비스는 반드시 서버 호스팅(Azure)이 필요하다.

## 3. 서비스별 호스팅 매핑

| 서비스 | 성격 | 권장 호스팅 | 비고 |
|---|---|---|---|
| 니즈조사 대시보드 | 정적(현재 gh-pages) | Azure Static Web Apps | Entra 인증 내장, 거의 무료, 외부 노출 제거 |
| AX 본 서비스(ai.jeilm.co.kr) | 백엔드+DB | Azure App Service | 자체 도메인+SSL, Easy Auth로 SSO/MFA |
| ERP 데이터(MSSQL) | 사외 IDC | 현행 유지 | Private Endpoint/VNet으로 안전 연결 |
| 문서·산출물 | 문서 | SharePoint | 기획서·매뉴얼 보관소로 계속 활용 |

## 4. 권장 아키텍처

### 4.1 구성 개요

사용자 → (Entra ID 로그인/MFA) → 자체 도메인 → Static Web Apps(프론트) + App Service(API) → Private Endpoint → 사외 IDC MSSQL(ERP)

- **프론트엔드:** Azure Static Web Apps (니즈조사 대시보드 및 AX UI)
- **백엔드 API:** Azure App Service(Web App) — Easy Auth로 Entra 인증 자동 적용
- **데이터:** 사외 IDC MSSQL은 그대로 두고, VNet 통합 + Private Endpoint(또는 Hybrid Connection)로 비공개 연결
- **비밀값:** Azure Key Vault에 Secret·연결 문자열 일원화(Entra 앱 Secret 만료 2026-12-09 관리 포함)
- **모니터링:** Application Insights + Log Analytics
- **배포:** GitHub Actions CI/CD (현재 gh-pages 흐름을 Azure로 이관)

### 4.2 환경 분리

| 환경 | 용도 | 비고 |
|---|---|---|
| dev | 개발/테스트 | App Service 무료/Basic, ERP는 테스트 DB |
| prod | 운영 | Standard 이상, 자동 스케일, Private Endpoint |

## 5. 인증 · 보안 운영

1. **Entra ID 단일 인증:** 이미 앱 등록 완료. App Service Easy Auth 활성화 시 코드 거의 없이 SSO+MFA 적용.
2. **Secret 관리:** Entra 앱 Secret 만료(2026-12-09) 전 갱신, Key Vault 보관 및 자동 회전 검토.
3. **네트워크:** ERP 연결은 Public 노출 없이 Private Endpoint로만 허용, App Service는 VNet 통합.
4. **접근 통제:** 사내 사용자만 허용(Entra 그룹 기반 권한), 외부 게스트 차단.
5. **백업/감사:** App Insights 로그, MSSQL 백업 정책은 IDC 기존 정책 유지.

## 6. 이행 로드맵

| 단계 | 기간(가이드) | 주요 작업 |
|---|---|---|
| 1. 준비 | 1주 | Azure 구독/리소스그룹 생성, 네이밍·태그 정책, Key Vault 구성 |
| 2. 정적 이관 | 1주 | 니즈조사 대시보드를 Static Web Apps로 이관, gh-pages 폐기, Entra 인증 적용 |
| 3. 백엔드 | 2~3주 | App Service 배포, Easy Auth 연동, ai.jeilm.co.kr 도메인+SSL |
| 4. ERP 연결 | 1~2주 | VNet/Private Endpoint로 IDC MSSQL 연결·연결 테스트 |
| 5. 운영화 | 1주 | CI/CD 파이프라인, App Insights 모니터링, 운영 매뉴얼 SharePoint 등록 |

## 7. 비용 개략 (방향성)

정확한 금액은 트래픽·SKU에 따라 달라지며, 아래는 소규모 사내 서비스 기준의 방향성 추정이다. 실제 산정은 Azure Pricing Calculator로 확정 권장.

| 리소스 | SKU 예시 | 월 비용 수준 |
|---|---|---|
| Static Web Apps | Standard | 낮음(무료~소액) |
| App Service | B1~S1 | 소~중 |
| Key Vault / App Insights | 사용량 기반 | 소액 |
| 네트워크(Private Endpoint) | 사용량 기반 | 소액 |

## 8. 다음 액션

- Azure 구독 및 리소스그룹 생성, 네이밍 규칙 확정
- 니즈조사 대시보드 Static Web Apps 이관(파일럿)
- Entra 앱 Secret를 Key Vault로 이전, 만료(2026-12-09) 전 갱신 일정 등록
- IDC MSSQL 네트워크 연결 방식(Private Endpoint vs Hybrid Connection) IDC팀과 협의
