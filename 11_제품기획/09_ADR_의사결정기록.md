# 09 · ADR — 아키텍처 의사결정 기록

> 관리자: 최동혁(dh.choi@jeilm.co.kr) · 기준일: 2026-07-08 · 상태: Draft
> 관련: [00 개요](00_제품기획_개요.md) · [03 아키텍처](03_시스템아키텍처_설계.md) · [07 이관](07_마이그레이션_Azure이관_설계.md) · [08 보안](08_보안_데이터안정성.md)

이 문서는 **결정(Accepted)·미결정(Proposed)·발견 이슈(Issue)** 를 한 곳에 모은다. 상태가 바뀌면 여기에 갱신하고 관련 문서에 반영한다. 형식: 배경 → 선택지 → 결정/상태.

범례: ✅ Accepted · 🕐 Proposed(결정 대기) · ⚠️ Issue(발견, 조치 필요)

---

## A. 확정된 결정 (Accepted)

### ADR-001 ✅ 3계층 데이터 분리
- **배경**: ERP 운영DB에 프론트가 직접 붙으면 부하·보안·이관 리스크.
- **결정**: 원천(ERP)/읽기사본(중간DB)/자체생성(포털DB) 물리 분리. 프론트는 ERP 직접 접근 금지.
- **근거**: [03 §1](03_시스템아키텍처_설계.md), [CLAUDE.md §4].

### ADR-002 ✅ ERP 읽기전용 + 화이트리스트
- **결정**: ETL은 SELECT+NOLOCK+파라미터 바인딩, 화이트리스트 SQL 5종. 챗봇도 AI SQL 금지·등록 Tool만.
- **근거**: `etl_run.py`, `jeil-chat`.

### ADR-003 ✅ RLS로 백엔드 권한 판정
- **결정**: 권한 차단은 DB RLS/Edge Function. 프론트 메뉴 숨김은 UX만. 라이브 실측으로 전 테이블 RLS ON 확인(2026-07-08).
- **근거**: [08 §3](08_보안_데이터안정성.md).

### ADR-004 ✅ 데이터 접근 단일 진입점 + 어댑터
- **결정**: 프론트 데이터 접근은 `app/lib/api.js` 하나로. `DATA_BACKEND` 스위치로 supabase↔mock, 향후 azure.
- **근거**: [03 §8](03_시스템아키텍처_설계.md), [CLAUDE.md §3.3].

### ADR-005 ✅ 인증 경계 분리(Entra ↔ Supabase Auth)
- **결정**: 사내는 Entra, 협력사는 Supabase Auth. Edge Fn이 Entra 토큰을 Graph로 검증하는 브리지.
- **근거**: [03 §5](03_시스템아키텍처_설계.md), [CLAUDE.md §5.5].

### ADR-006 ✅ 현행 실행 스택 = Supabase(잠정)
- **배경**: 스택 최종 확정 전, 빠른 실동작 필요.
- **결정**: 현재 Supabase(Postgres+Edge+Auth+Storage)로 실가동. **단 "최종 확정" 아님**(ADR-101 참조).
- **근거**: 실동작 코드, [CLAUDE.md §3].

### ADR-007 ✅ ERP 중간DB 노출 = `public` security_invoker 뷰 (2026-07-08)
- **배경**: `erp_ro`를 앱/챗봇에 노출하되 REST 비노출·사내한정·화이트리스트 원칙 유지 필요.
- **선택지**: (A) `security definer` 뷰/RPC(정의자 권한, advisor 경고) / (B) `public`의 `security_invoker` 뷰 + `erp_ro` 최소 GRANT + 기존 `internal_select_*` RLS 게이트 / (C) 별도 `erp_pub` 스키마 REST 노출(프로젝트 config 변경 필요).
- **결정**: **(B)**. `erp_ro`/`etl_meta`는 REST 비노출 유지, 진입점은 `public.v_erp_*` 뷰뿐. 사내(internal)만 RLS 통과, 협력사/anon 0행(격리 테스트 통과 ISS-203). 챗봇은 service_role 전용 read GRANT. definer-뷰 advisor 경고 회피.
- **근거**: [06 §3·§7](06_ERP연계_챗봇활용_설계.md), [`이관/sql/08`](../실제구축준비%20자료/이관/sql/08_erp_pub_reporting_views.sql).

## B. 미결정 (Proposed — 결정 대기)

### ADR-101 🕐 백엔드 스택 최종 확정
- **선택지**: (A) .NET/C#+MSSQL(ERP 백엔드 친화) / (B) Node·서버리스+Postgres(현행 계열) / (하이브리드) 프론트=B·ERP백엔드=A.
- **상태**: 하이브리드 권고([CLAUDE.md §3.2]), 미확정. **결정 필요자**: CTO/경영.

### ADR-102 🕐 호스팅 확정(Azure vs 사내 IIS)
- **선택지**: Azure(Static Web Apps/App Service, 권고) vs 사내 IIS vs 기타.
- **상태**: 미확정([CLAUDE.md §11-B], [07 §6](07_마이그레이션_Azure이관_설계.md)). 인증서·이관 전략에 직결.

### ADR-103 🕐 협력사 인증 방식(D1)
- **선택지**: (A) Entra External ID/B2B 게스트 / (B) 협력사 전용 자체 인증(현행 Supabase Auth 계열).
- **상태**: 보류. 어댑터 `resolveSupplier(authContext)→account_id`로 추상화되어 있어 교체 가능. 이관(ADR-102)과 함께 확정 권장.

### ADR-104 🕐 운영 토큰 보관(BFF/HttpOnly)
- **배경**: 현재 localStorage 토큰은 XSS 노출 위험.
- **선택지**: BFF 패턴 + HttpOnly 쿠키 / 현행 유지.
- **상태**: 운영 전환 시 재설계 예정([CLAUDE.md §6], [08 R3](08_보안_데이터안정성.md)).

### ADR-105 🕐 마이그레이션 파일화 정책
- **배경**: `erp_ro`/`etl_meta` DDL이 MCP 직접 적용되어 리포에 `.sql` 파일 없음 → 이관·감사 취약.
- **선택지**: 향후 모든 스키마 변경을 `supabase/migrations/` 파일로 관리 / 현행.
- **상태**: 파일화 권고. 이관(ADR-102) 전제 조건([07 §5](07_마이그레이션_Azure이관_설계.md)).

### ADR-106 🕐 챗봇 LLM 벤더 확정
- **배경**: 발견 이슈 ISS-201과 연동. Claude(UI 표기·최신 모델) vs OpenAI(현 구현).
- **상태**: 결정 필요. 비용·성능·표기 정합 고려. (Claude 전환 시 게이트웨이 어댑터만 교체.)

## C. 발견 이슈 (Issue — 이번 조사에서 확인, 조치 필요)

### ISS-201 ⚠️ 챗봇 표기/구현 불일치
- **내용**: `04_챗봇_포털_데모UI.html` UI·관리자 콘솔은 "Claude(Haiku/Sonnet/Opus)" 표기, 실제 `jeil-chat`은 OpenAI gpt-4o-mini.
- **영향**: 사용자·관리자 혼선, 비용/모델 관리 왜곡.
- **조치**: 표기를 실제에 맞추거나(문서·UI), LLM 벤더를 확정(ADR-106) 후 정합. **이번 작업은 기록만**(코드 무변경).

### ISS-202 ⚠️ `update_my_vendor_contact` REST 노출
- **내용**: SECURITY DEFINER 함수가 anon/authenticated에 REST로 실행 가능(보안 advisor WARN).
- **조치**: 세션 없는 호출 무효·자기 행만 수정 가드 재확인, 불필요 EXECUTE 회수/INVOKER 검토([08 R1](08_보안_데이터안정성.md)).

### ISS-203 ✅ `erp_ro` RLS 격리 실테스트 (2026-07-08 해소)
- **내용**: 문서상 사내 SELECT·anon/vendor 차단 설계였으나 실사용자 시나리오 격리 테스트 미실시였음.
- **조치 완료**: P4 노출 뷰(`public.v_erp_*`)에 대해 JWT 시뮬레이션 격리 테스트 통과 — 사내(internal) 데이터 정상, 협력사(vendor) 전부 0행, anon 차단 확인. `erp_ro` 원천 테이블도 동일 `internal_select_*` 정책이 게이트. (참고: 뷰가 아닌 erp_ro 직접 접근 경로는 REST 비노출 + GRANT 최소화로 이중 차단.)

### ISS-204 ⚠️ ERP 매핑 "가설" 상태
- **내용**: ETL 추출 SQL·ERP 테이블 매핑이 유니포인트 뷰 스펙 확정 전 초안.
- **조치**: 유니포인트 협의로 확정(전용 계정 `jeilax_ro`, 리포팅 뷰) — 관리자 진행, Claude는 요청목록 제시([06 §5](06_ERP연계_챗봇활용_설계.md)).

### ISS-205 ⚠️ config.js anon 키 소스 존재
- **내용**: `app/config.js`에 Supabase URL·anon(publishable) 키가 소스에 있음.
- **판정**: **설계상 허용**(publishable·RLS가 보호). 단 service_role·Secret은 절대 소스 금지. 문서에 "허용 근거" 명시로 오해 방지.

### ISS-206 🟡 P4 단절(부서 페이지 정적) — 부분 해소 진행 중
- **내용**: `erp_ro`가 앱/챗봇 미노출 → 부서 페이지 정적 샘플.
- **진행(2026-07-08)**: 노출 뷰 6종 + `erpApi` + 구매 페이지 파일럿 + 챗봇 ERP Tool 4종 구현·배포. 나머지 부서 페이지 확대·Entra→Supabase 세션 브리지·권한 등급(P4-4)이 남음. 설계 [06 §7](06_ERP연계_챗봇활용_설계.md), 상태 [`10_ERP_DB연계/02`](../10_ERP_DB연계/02_진행상태.md).

### ISS-207 ⚠️ Entra Client Secret 만료(2026-12-09)
- **내용**: 미갱신 시 로그인 전면 중단.
- **조치**: 11월 중 갱신·일정 등록(관리자, [08 §4](08_보안_데이터안정성.md)).

---

## D. 결정 요청 요약 (경영/CTO 판단 필요)

| 항목 | ADR | 시급도 |
|---|---|---|
| 백엔드 스택 확정 | ADR-101 | 중(이관 전) |
| 호스팅 확정(Azure/IIS) | ADR-102 | 높음(이관 트리거) |
| 협력사 인증 D1 | ADR-103 | 높음(이관·계정 영향) |
| 챗봇 LLM 벤더 | ADR-106/ISS-201 | 중(비용·표기) |
| Entra Secret 갱신 | ISS-207 | **높음(12-09 데드라인)** |
