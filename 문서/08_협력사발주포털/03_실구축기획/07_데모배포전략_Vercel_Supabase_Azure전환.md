# 07. 데모 배포 전략 — GitHub Pages 한계 · 임시 Vercel+Supabase · Azure 전환

> 작성일: 2026-06-29 · 작성: 최동혁 · 대상 페이즈: P0~P1(데모 데이터화) → P5(운영 전환)
> 관련: 02 데이터모델, 03 인증·보안, 04 동기화·API, 06 로드맵, 루트 `CLAUDE.md §3·§5·§6·§8·§11`
> 배경: 데모에 **실제 데이터 쓰기**가 필요해졌는데 GitHub Pages는 정적 호스팅이라 이를 담을 수 없다. 비용 0으로 데이터화하기 위해 **임시로 Vercel+Supabase**를 쓰고, 운영은 **Azure**로 옮기는 단계 전략을 확정한다.

---

## 1. 왜 바꾸나 — GitHub Pages의 구조적 한계

현재 데모는 `gh-pages` 브랜치의 정적 HTML이다. 협력사 포털의 상태·사진·메시지·검수요청·검수판정은 브라우저 `localStorage`(`jeilax_link_v1`)에만 저장된다. 그 결과:

| 문제 | 내용 |
|---|---|
| **서버·DB 없음** | GitHub Pages는 정적 파일만 서빙. 백엔드 API·DB를 둘 수 없다(`CLAUDE.md §3.1`이 신설하라는 계층이 통째로 빠져 있음). |
| **데이터 비공유** | `localStorage`는 **그 브라우저 한 대**에만 남는다. 협력사 PC ↔ 사내 PC가 같은 데이터를 못 본다(현재는 같은 브라우저의 탭 간 `storage` 이벤트로만 흉내). |
| **데이터를 Git에 넣으면 안 됨** | 응답·상태를 파일로 커밋해 데이터화하려는 시도는 `CLAUDE.md §1`(비밀값·민감데이터 커밋 금지)·운영 데이터의 형상관리 오염 문제로 부적합. |
| **인증서·헤더 제약** | 자체 인증서 불가, 보안 헤더(HSTS/CSP) 통제 제한(`CLAUDE.md §11-B`). |

**결론:** 데모를 "진짜 데이터가 도는" 상태로 만들려면 **백엔드 + DB가 있는 호스팅**이 필요하다. 운영(Azure)을 바로 세우긴 비용·일정 부담이 크므로, **무료로 같은 구조를 먼저 굴린다.**

---

## 2. 3단계 배포 전략 (한 장 요약)

```
[1] 현재          [2] 임시 데모(무료)              [3] 운영
GitHub Pages  →   Vercel + Supabase          →   Microsoft Azure
정적 HTML         프론트 + Postgres/Auth/Storage     Entra + Azure DB/Blob
localStorage      실제 DB 쓰기·RLS·실시간            ERP 실연계·VPN·감사
비용 0            비용 0(무료 티어)                  유료(운영 SLA)
```

| 계층 | [1] 현재 | [2] 임시 데모 (이번 전환) | [3] 운영 (Azure) |
|---|---|---|---|
| 호스팅 | GitHub Pages | **Vercel**(Hobby, 데모 한정) | Azure Static Web Apps / App Service |
| DB | 없음(localStorage) | **Supabase Postgres**(Free) | Azure Database for PostgreSQL |
| 사내 인증 | Entra PKCE(구현됨) | **Entra → Supabase Auth(OIDC) 연결** | Entra ID(본선) |
| 협력사 인증 | 없음(데모 가짜) | **Supabase Auth(분리)** | Entra External ID(B2B) or 전용(03-D1) |
| 파일(사진) | base64 인라인 | **Supabase Storage** | Azure Blob Storage |
| 실시간 | `storage` 이벤트(탭 한정) | **Supabase Realtime** | Azure Web PubSub/SignalR or SSE |
| 데이터 접근 | 화면 곳곳 직접 | **`api.js` 모듈 1곳**(§5) | 동일 모듈, 백엔드만 교체 |
| ERP 연계 | 마스킹 샘플 | 마스킹 샘플(직접연계 X) | 중간 DB 경유 야간배치(`CLAUDE.md §4`) |

핵심 설계 원칙은 **[2]와 [3]의 데이터 모델·RLS·인증 경계를 동일하게** 가져가는 것이다. 그래야 [2]→[3]이 "재구축"이 아니라 "이식"이 된다. 스키마는 02 문서, 인증 경계는 03 문서를 그대로 따른다.

---

## 3. 임시 스택 선택 근거와 무료 티어 주의점

### 3.1 왜 Vercel + Supabase인가
- `CLAUDE.md §3.2` 권고 "후보 B(Node/Next + Postgres)"와 정확히 일치 — 현 HTML 데모를 거의 그대로 올리면서 백엔드/DB를 즉시 얻는다.
- Supabase = **Postgres + Auth + Storage + Realtime + RLS**가 한 묶음. 02·03 문서가 요구한 요소(포털 쓰기 DB, 행수준 보안, 파일 스토리지, 양방향 실시간)를 무료로 한 번에 검증할 수 있다.
- **Azure 전환 경로가 깔끔**(§6): Supabase의 핵심은 표준 Postgres라 Azure Database for PostgreSQL로 거의 1:1 이전된다.

### 3.2 무료 티어의 한계 (반드시 인지)

| 항목 | 한계 | 대응 |
|---|---|---|
| **Vercel Hobby = 비상업 한정** | 약관상 상업적 운영 트래픽 금지. | **순수 데모/PoC·시연까지만** 무료 사용. 실사용·운영 트래픽이 붙는 순간 → Pro 또는 Azure로 이전. 운영 포털을 Hobby로 돌리지 않는다. |
| **Supabase Free 일시정지** | 약 7일 미접속 시 프로젝트 pause. | 시연 전 깨우기(대시보드 접속/요청). 운영 데이터로 쓰지 않으니 영향 한정. |
| **Supabase Free 용량** | DB 500MB·Storage 1GB·프로젝트 2개. | 데모엔 충분(사진은 메타만 DB, 원본은 Storage). 한계 근접 시 정리 또는 Azure 이전 신호. |
| **커스텀 도메인** | `ai.jeilm.co.kr`은 운영 도메인. 데모를 여기 붙이면 상업적 사용 논란·Entra redirect URI 영향. | 데모는 **별도 서브도메인/임시 도메인**(예: `ai-dev.jeilm.co.kr` 또는 Vercel 기본 도메인)으로. 운영 도메인은 [3]에서. |

> **비용 가드레일:** 이 전환의 전제는 "데모 비용 0". Vercel/Supabase 어느 쪽이든 유료 청구가 발생하는 행위(Pro 업그레이드, 유료 애드온, 한도 초과 과금)는 **사전에 사용자(관리자) 승인** 후 진행한다(`CLAUDE.md §10`). MCP로 Supabase 프로젝트를 만들 때도 비용 확인 단계를 거친다.

---

## 4. 인증 분리 — 사내 Entra / 협력사 Supabase (이번 결정 D1' 확정)

03 문서의 협력사 인증(D1)은 운영 본선에서 "Entra B2B vs 전용"으로 **결정 보류** 상태다. **데모 단계에 한해** 다음으로 확정한다(운영 전환 시 03-D1 재평가).

| 구분 | 데모 로그인 | 식별/클레임 | 비고 |
|---|---|---|---|
| **사내 직원** | 기존 **Entra**를 Supabase의 **외부 OIDC provider**로 연결 | `role=internal` + Entra 그룹(`AI-Portal-*`) | 이미 구현된 Entra PKCE 자산 계승, 운영(Azure)에서도 Entra 그대로 |
| **협력사(사외)** | **Supabase Auth**(이메일/매직링크) | `role=vendor`, `vendor_bp=[허용 거래처코드]` | 사내 테넌트와 **완전 분리**(`CLAUDE.md §5.5`). 운영 시 03-D1(B2B/전용)로 승격 |

### 4.1 사용자 구분과 커스텀 클레임
- Supabase `auth.users`에 **두 종류**를 둔다. 구분은 `app_metadata.role`(`internal` | `vendor`).
- 협력사 계정엔 `app_metadata.vendor_bp`(허용 ERP 거래처코드 배열)를 부여 → RLS의 격리 키(02 문서 `supplier_bp_map`의 데모 버전).
- 이 메타데이터를 JWT에 실어야 RLS에서 쓸 수 있다 → Supabase **Custom Access Token Hook**으로 `role`·`vendor_bp`를 액세스 토큰 클레임에 주입.

> **주의(`CLAUDE.md §1·§5.4`):** 권한 판정은 RLS(DB)와 백엔드에서. 프론트의 메뉴 숨김은 UX일 뿐. 협력사는 자기 발주만(아래 RLS). `service_role` 키는 **절대** 프론트/Git에 노출하지 않는다 — anon(publishable) 키만 클라이언트에 둔다.

---

## 5. Supabase 구체화 — 스키마·RLS·Storage·Realtime

02 문서의 `sub_portal` 스키마를 Supabase(단일 DB)로 옮긴다. 스키마 분리는 `public` 단일 + 테이블 접두사(`erp_/sp_/meta_`)로 단순화한다(무료 단일 인스턴스 가정).

### 5.1 테이블 (02 §3을 Supabase로)
`sp_order_state`, `sp_photo`, `sp_message`, `sp_insp_request`, `sp_inspection`, `sp_inspection_log` — 컬럼 정의는 **02 문서 그대로**. 추가로 격리 키를 위해 각 행에 `bp_cd`(거래처코드)를 비정규화해 둔다(RLS 필터를 조인 없이 빠르게).

```sql
-- 격리 키를 토큰 클레임에서 꺼내는 헬퍼
create or replace function auth.vendor_bp() returns text[]
language sql stable as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' -> 'vendor_bp')::jsonb,
    '[]'::jsonb
  )::text[];
$$;

create or replace function auth.is_internal() returns boolean
language sql stable as $$
  select (auth.jwt() -> 'app_metadata' ->> 'role') = 'internal';
$$;
```

### 5.2 RLS — 협력사 격리의 핵심 (03 §4의 Supabase 구현)
**모든 테이블 RLS ON이 전제.** 안 켜면 anon 키로 통째 노출된다.

```sql
alter table sp_order_state enable row level security;

-- 사내: 전체 접근
create policy internal_all on sp_order_state
  for all using (auth.is_internal()) with check (auth.is_internal());

-- 협력사: 자기 거래처 발주만 (읽기/쓰기 모두)
create policy vendor_own on sp_order_state
  for all
  using (bp_cd = any (auth.vendor_bp()))
  with check (bp_cd = any (auth.vendor_bp()));
```
- 같은 패턴을 `sp_photo`·`sp_message`·`sp_insp_request`에 적용.
- `sp_inspection`·`sp_inspection_log`(검수 판정)는 **쓰기=사내만**, 협력사는 자기 발주분 **읽기만**(`for select`).
- **검증(03 §4-3 필수):** 협력사 토큰으로 타 거래처 PO 조회 → 빈 결과. anon 키 직접 호출 → 정책에 막힘.

### 5.3 Storage (사진 증빙, 03 §5 준용)
- 버킷 `vendor-photos`(비공개). 경로 규칙 `{{bp_cd}}/{{po_no}}/{{uuid}}.jpg`.
- Storage RLS로 협력사는 자기 `bp_cd` 접두 경로만 업로드/조회. 노출은 **단기 서명 URL**.
- 업로드 검증(확장자/MIME/용량/재인코딩)은 04 문서 규칙 준수. 데모에선 클라이언트 1차 + 가능 시 Edge Function 2차.

### 5.4 Realtime (양방향 실시간, 04 문서)
- 데모의 `storage` 이벤트 → **Supabase Realtime** 구독으로 대체.
- 협력사 상태·사진·메시지 변경 → 사내 보드 즉시 반영, 사내 검수판정·답장 → 협력사 화면 즉시 반영.
- 구독도 RLS를 따르므로 협력사는 자기 발주 변경만 수신.

---

## 6. `api.js` — 교체 지점 1곳 (Azure 전환 비용 최소화)

`CLAUDE.md §3.3`의 "데이터 접근을 한 모듈로" 원칙. 화면들의 `localStorage`/`fetch`를 전부 이 모듈을 통하게 한다. **내부 구현만 mock → Supabase → Azure로 갈아끼우고 화면은 불변.**

```js
// api.js — 데이터 접근 단일 진입점 (구현체 교체 가능)
export const portalApi = {
  getOrders(),                       // 발주 목록(RLS로 자동 격리)
  getOrder(poNo),
  updateStatus(poNo, status, step),  // 협력사 진행상태
  uploadPhoto(poNo, file, meta),     // Storage 업로드 + 메타 insert
  confirmPhoto(poNo, photoId),       // 사내 확인
  sendMessage(poNo, body),           // 양방향
  requestInspection(poNo),           // 협력사 검수요청
  judge(poNo, result, opinion),      // 사내 합/부 판정(+log)
  subscribe(poNo, onChange),         // Realtime 구독
};
// 구현 어댑터: mockAdapter | supabaseAdapter | azureAdapter
// 03 §2의 resolveSupplier(authContext)도 이 계층 뒤에 둔다.
```
- 인증도 어댑터 뒤로: `auth.login()/logout()/currentUser()` — Entra(사내)/Supabase(협력사) 분기를 화면이 모르게.
- 데모 키(`jeilax_link_v1`, `jeilax_auth`)는 **localStorage 한정**임을 주석에 명시하고, `mockAdapter`에만 남긴다.

---

## 7. Supabase → Azure 이전 매핑 (운영 전환 시)

| Supabase(임시) | Azure(운영) | 이전 난이도 |
|---|---|---|
| Postgres DB | **Azure Database for PostgreSQL** Flexible Server | 낮음(표준 SQL·RLS 정책 그대로 이식) |
| RLS 정책 | 동일 Postgres RLS + 앱 계층(03 §4-2 2중) | 낮음(클레임 소스만 Entra로) |
| Auth(사내) | **Entra ID**(이미 본선) | 낮음(데모부터 Entra 연결) |
| Auth(협력사) | **Entra External ID(B2B)** or 전용(03-D1) | 중간(03-D1 결정 의존) |
| Storage | **Azure Blob Storage** | 낮음(객체 복사 + 서명 URL) |
| Realtime | **Azure Web PubSub/SignalR** or SSE(04) | 중간(구독 코드 어댑터 교체) |
| Edge Functions | **Azure Functions** | 중간 |
| anon/service 키 | **Managed Identity + Key Vault**(`CLAUDE.md §6`) | 낮음 |
| Vercel 호스팅 | **Azure Static Web Apps / App Service** | 낮음 |
| ERP 연계 | 중간 DB 경유 야간배치(`CLAUDE.md §4`, 02 `erp_ro`) | 별도 트랙(유니포인트 협의) |

`api.js`(§6)와 동일 스키마(§5)·동일 RLS(02·03) 덕분에, 이전은 **어댑터 구현 교체 + 데이터 복사**로 수렴한다.

---

## 8. 단계별 실행 (데모 데이터화 P0~P1)

1. **인프라 준비** — Supabase 프로젝트 생성(Free, 비용 확인) + Vercel 연결 + 데모 서브도메인. `api.js` 골격·어댑터 인터페이스.
2. **협력사 포털 데이터화**(가장 동적) — §5 테이블 + RLS + Storage + Realtime. `jeilax_link_v1` → `supabaseAdapter`.
3. **인증 분리** — 사내 Entra(OIDC)·협력사 Supabase Auth + 커스텀 클레임(§4). RLS 격리 검증(03 §4-3).
4. **나머지 데모** — 원가현황(project/ledger/receipt), 니즈조사(survey_response/answer)도 동일 패턴으로 이관.
5. **회귀·보안 점검** — 협력사 격리 모의 점검, `/security-review` 셀프 점검(`CLAUDE.md §6`).

---

## 9. 이 문서의 확정·주의 항목
- [ ] **비용 가드레일 합의** — 무료 범위 한정, 유료 전환은 사전 승인(§3.2).
- [ ] **데모 도메인** 결정 — Vercel 기본 vs `ai-dev.jeilm.co.kr`. 운영 도메인(`ai.jeilm.co.kr`)은 데모에 미사용.
- [ ] **Entra redirect URI** — 데모 호스트 추가는 **관리자가 Entra 앱 등록에서 직접**(`CLAUDE.md §5.2`, 코드만 바꾸면 AADSTS50011). Claude는 변경 목록만 제시.
- [ ] **D1' 한정 확정** — 협력사 데모=Supabase Auth. 운영 전환 시 03-D1(B2B/전용) 재평가.
- [ ] **마스킹 유지** — ERP 실데이터는 Supabase에 넣지 않음. 마스킹 샘플만(`CLAUDE.md §1·§4`).
- [ ] **키 분리** — anon만 프론트, `service_role`은 서버 전용·시크릿 매니저(`CLAUDE.md §1`).
- [ ] **RLS 전수 ON** — 테이블 생성과 동시에 정책. 미설정 노출 방지(§5.2).
