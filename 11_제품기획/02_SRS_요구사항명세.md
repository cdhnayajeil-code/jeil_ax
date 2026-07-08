# 02 · SRS — 요구사항 명세서

> 관리자: 최동혁(dh.choi@jeilm.co.kr) · 기준일: 2026-07-08 · 상태: Draft
> 관련: [01 PRD](01_PRD_제품요구사항정의.md) · [04 DB설계](04_데이터베이스_설계.md) · [05 FE·BE](05_프론트엔드_백엔드_설계.md)

기능요구를 **FR-ID 체계**로 명세한다. 각 FR은 화면·테이블·Edge Function으로 추적된다(§4 추적매트릭스). 구현 상태: ✅가동 · 🟡부분 · ⬜계획.

---

## 1. 모듈·FR-ID 체계

`FR-<모듈>-<번호>`. 모듈: CHAT(챗봇) · VP(협력사포털) · INS(검수) · MSG(메시지) · ACC(계정) · CADM(챗봇관리) · DEPT(부서페이지) · ETL(연계) · AUTH(인증) · SEC(보안공통).

## 2. 기능요구 명세

### 2.1 챗봇 (CHAT)

| FR-ID | 요구 | 상태 | 근거 |
|---|---|---|---|
| FR-CHAT-1 | Entra 로그인 사용자만 챗봇 사용(도메인 `@jeilm.co.kr`) | ✅ | `jeil-chat` `verifyEntraUser` |
| FR-CHAT-2 | 사용자 자유질의를 LLM으로 응답(SSE 스트림) | ✅ | `jeil-chat` OpenAI 프록시 |
| FR-CHAT-3 | 사전 등록 읽기전용 Tool만 호출(임의 SQL 금지) | ✅ | `get_order_summary`·`get_order_detail`·`get_inspection_pending` |
| FR-CHAT-4 | Tool은 포털DB(`sp_*`)만 조회(현재 1단계) | ✅ | service_role, ERP 직접조회 없음 |
| FR-CHAT-5 | 입력 상한(메시지 20·문자 24k·토큰 1024) | ✅ | 남용·과금 방지 |
| FR-CHAT-6 | 개인정보·비밀값 응답 금지(시스템 프롬프트) | ✅ | 프롬프트 가드 |
| FR-CHAT-7 | ERP 중간DB 조회 Tool로 확장(2단계, 부서 매핑) | ⬜ | [06](06_ERP연계_챗봇활용_설계.md) 설계 |
| FR-CHAT-8 | 문서 RAG(3단계) | ⬜ | 로드맵, 범위 밖 |

### 2.2 협력사 포털 (VP)

| FR-ID | 요구 | 상태 | 근거 |
|---|---|---|---|
| FR-VP-1 | 협력사 이메일/비번 로그인, `role=vendor`+`vendor_bp` 확인 | ✅ | `vendor-login.html` |
| FR-VP-2 | 자기 거래처(`bp_cd`) 발주만 조회(RLS 자동 격리) | ✅ | `portalApi.getOrders`, `vendor_own` 정책 |
| FR-VP-3 | 생산/검사 사진 업로드(비공개 버킷, 서명 URL) | ✅ | `vendor-photos`, `uploadPhoto`/`photoUrls` |
| FR-VP-4 | 검수요청/취소 | ✅ | `requestInspection`/`cancelInspection` |
| FR-VP-5 | 진행상태 실시간 반영(Realtime) | ✅ | `subscribe` postgres_changes |
| FR-VP-6 | 본인 프로필(담당자명·연락처) 수정 | ✅ | RPC `update_my_vendor_contact` |

### 2.3 검수·판정 (INS)

| FR-ID | 요구 | 상태 | 근거 |
|---|---|---|---|
| FR-INS-1 | 사내만 합격/불합격 판정(협력사 SELECT만) | ✅ | `sp_inspection` 사내쓰기 RLS |
| FR-INS-2 | 판정 시 판정자·차수 기록(비가역 이력) | ✅ | `sp_inspection_log` |
| FR-INS-3 | 판정 즉시 상태 자동 전이(합격→done, 불합격→rework) | ✅ | 상태머신 v2(§3) |
| FR-INS-4 | 사진 검수(사내 코멘트/반려) | ✅ | `reviewPhoto` |

### 2.4 메시지 (MSG)

| FR-ID | 요구 | 상태 | 근거 |
|---|---|---|---|
| FR-MSG-1 | 발주 건별 협력사↔사내 양방향 메시지 | ✅ | `sp_message` |
| FR-MSG-2 | 읽음 처리·실시간 수신 | ✅ | `markRead`/`subscribe` |
| FR-MSG-3 | 사내 관리자는 전 협력사 스레드 접근 | ✅ | `adminMsgApi`, `internal_all` |

### 2.5 계정 (ACC)

| FR-ID | 요구 | 상태 | 근거 |
|---|---|---|---|
| FR-ACC-1 | 관리자 주도 협력사 계정 발급(임시비번) | ✅ | `vendor-provision` Edge Fn |
| FR-ACC-2 | 발급 권한: `@jeilm.co.kr` AND `portal_admin` | ✅ | 함수 내부 검증 |
| FR-ACC-3 | 협력사 비번 초기화 + 로그 | ✅ | `vendor-reset-password` |
| FR-ACC-4 | 협력사 가입신청 승인/거부 | ✅ | `approve-vendor` |
| FR-ACC-5 | 계정 변경 감사로그 | ✅ | `vendor_account_log` |

### 2.6 챗봇 관리 (CADM)

| FR-ID | 요구 | 상태 | 근거 |
|---|---|---|---|
| FR-CADM-1 | 관리자만 사용량·비용·게이트웨이 상태 조회 | ✅ | `jeil-chat-admin`, `portal_admin` |
| FR-CADM-2 | 모델·토큰·추정비용·사용도구 집계(대화원문 미저장) | ✅ | `chat_log` |
| FR-CADM-3 | Entra 보안그룹 기반 등급·모델 차등 | ⬜ | 계획([09 ADR](09_ADR_의사결정기록.md)) |

### 2.7 부서 운영페이지 (DEPT)

| FR-ID | 요구 | 상태 | 근거 |
|---|---|---|---|
| FR-DEPT-1 | 부서별 대시보드 표시(영업·구매·인사·자금·자재·품목·원가) | 🟡 정적 | `pages/*_2026.html`(하드코딩 샘플) |
| FR-DEPT-2 | 외주 발주·검사 대시보드 실연동 | ✅ | `외주발주_검사진행현황_2026.html`(portalApi) |
| FR-DEPT-3 | 부서 대시보드를 ERP 중간DB(`erp_ro`) 실연동 전환 | ⬜ | [06](06_ERP연계_챗봇활용_설계.md) 설계 |

### 2.8 ERP 연계 (ETL)

| FR-ID | 요구 | 상태 | 근거 |
|---|---|---|---|
| FR-ETL-1 | ERP→중간DB 야간배치(화이트리스트 SQL 5종, 읽기전용) | 🟡 파일럿 | `etl_run.py` |
| FR-ETL-2 | 적재는 service_role RPC 경유(`erp_ro` REST 비노출) | ✅ | `erp_etl_upsert`/`erp_etl_batch` |
| FR-ETL-3 | 배치 이력·데이터 기준시각 | ✅ | `etl_meta.batch_run`/`v_last_success` |
| FR-ETL-4 | 전용 읽기계정(`jeilax_ro`)·리포팅 뷰(유니포인트 협의) | ⬜ | P1 대기 |
| FR-ETL-5 | 중간DB→앱/챗봇 노출(P4 연결) | ⬜ | [06](06_ERP연계_챗봇활용_설계.md) 핵심 |
| FR-ETL-6 | 민감영역 `erp_secure`(자금·인사) | ⬜ | P5 예약 |

### 2.9 인증·보안 공통 (AUTH/SEC)

| FR-ID | 요구 | 상태 | 근거 |
|---|---|---|---|
| FR-AUTH-1 | 사내 Entra ID SSO + MFA(조건부 액세스) | ✅ | PKCE 직접구현 |
| FR-AUTH-2 | 협력사·사내 인증 경계 분리 | ✅ | Supabase Auth vs Entra |
| FR-AUTH-3 | 운영 토큰 보관 BFF/HttpOnly 전환 | ⬜ | 미결정([09 ADR](09_ADR_의사결정기록.md)) |
| FR-SEC-1 | 권한 판정은 백엔드/DB(RLS)에서 | ✅ | 프론트 메뉴숨김은 UX만 |
| FR-SEC-2 | 업로드 파일 검증(형식·용량·확장자) | 🟡 | 강화 필요([08](08_보안_데이터안정성.md)) |

## 3. 상태머신 (발주·검사 v2)

현행 구현(`app/lib/api.js` 주석·`order_state_machine_v2` 마이그레이션) = **5상태**:

```
 new ──▶ prod ──▶ insp ──합격──▶ done
                   │
                   └──불합격──▶ rework ──▶ insp (재검수, 차수 +1)
```

- `new`(발주) → `prod`(생산) → `insp`(검수요청/검수중) → 판정.
- 합격: `insp → done`(자동 전이). 불합격: `insp → rework`(재작업) → 다시 `insp`(검사 차수 증가).
- 판정 즉시 자동 전이하여 "검수 불합격 교착"을 해소(재설계 배경: 커밋 `b62e337`).
- 상세 10단계 업무 프로세스(구매요청~매입)와의 매핑은 → [`08/03_실구축기획/08_전체프로세스_상태머신`](../08_협력사발주포털/03_실구축기획/08_전체프로세스_상태머신_로직재설계.md).

## 4. 요구사항 추적 매트릭스 (FR ↔ 화면 ↔ 테이블 ↔ Edge Fn)

| FR 그룹 | 화면(프론트) | 테이블(DB) | Edge Function |
|---|---|---|---|
| CHAT | `04_챗봇_포털_데모UI.html` | `sp_order_*`, `sp_inspection`, `chat_log` | `jeil-chat` |
| VP | `vendor-login.html`, `협력사_모바일_포털.html` | `sp_order_header/state`, `sp_photo`, `sp_insp_request` | (RLS 직접) + `vendor-provision` |
| INS | `외주발주_검사진행현황_2026.html` | `sp_inspection`, `sp_inspection_log` | (RLS 직접) |
| MSG | 양측 포털 | `sp_message` | (RLS 직접) |
| ACC | `admin-vendors.html` | `vendor_master/account/account_log`, `vendor_application`, `portal_admin` | `vendor-provision`, `vendor-reset-password`, `approve-vendor` |
| CADM | `04_…` 관리자 콘솔 | `chat_log` | `jeil-chat-admin` |
| DEPT | `pages/*_2026.html` | (정적) → `erp_ro.*`(계획) | (계획: ERP Query 뷰/RPC) |
| ETL | (배치, 화면 없음) | `erp_ro.*`, `etl_meta.batch_run` | RPC `erp_etl_upsert`/`erp_etl_batch` |

> 화면·테이블·함수의 상세 명세는 [04 DB설계](04_데이터베이스_설계.md)·[05 FE·BE](05_프론트엔드_백엔드_설계.md).
