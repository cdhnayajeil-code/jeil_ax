# 01. 이관 실행 가이드 — Vercel + Supabase (데이터화 데모)

> 작성일: 2026-06-29 · 관리: 최동혁 · 전제: **Vercel·Supabase 계정 생성 완료**
> 목표: GitHub Pages 정적 데모를 **실제 DB가 도는 데모**로 전환(비용 0). 운영(Azure) 이전이 "이식"이 되도록 스키마·RLS·인증 경계를 본선과 동일하게 깐다.
> 관련: `00_현황스냅샷`, `08/03_실구축기획/02·03·07`, `CLAUDE.md §1·§3·§4·§5·§6·§8`

---

## 0. 진행 원칙 (먼저 읽기)

1. **비용 0 유지** — Vercel Hobby·Supabase Free 범위 내에서만. 유료 전환(Pro·과금 애드온·한도초과)은 **사전 승인 후**. MCP로 Supabase 프로젝트 생성 시 비용 확인 단계를 거친다.
2. **비밀값 분리** — `SERVICE_ROLE_KEY`·`ENTRA_CLIENT_SECRET`·DB 접속은 환경변수/시크릿에만. **소스·문서·Git 금지**(`CLAUDE.md §1`). 프론트엔 `ANON_KEY`만.
3. **ERP 실데이터 금지** — 데모는 **마스킹 샘플만**. 운영 MSSQL 직접 연계 안 함(`CLAUDE.md §4`).
4. **RLS 먼저** — 테이블 만들 때 **RLS ON + 정책**을 같이. 안 켜면 anon 키로 통째 노출.
5. **OneDrive에서 직접 push 금지** — 배포 빌드는 `/tmp` clone 후(`CLAUDE.md §8.3`). Vercel은 GitHub 연동 자동배포 권장.
6. 각 단계 끝에 **체크포인트**를 확인하고 `03_이관진행상태`에 결과를 기록한다.

---

## A. 저장소·프로젝트 준비

1. **데모용 디렉터리 정리(권고)** — 운영 코드와 혼재 방지(`CLAUDE.md §11-A`).
   ```
   /demo   ← 현 정적 데모(이관 출발점)
   /app    ← Vercel에 올릴 프론트(데모 계승)
   /api    ← 서버리스 함수(BFF·시드·검증)
   /docs   ← 기획·이관 문서
   ```
   초기엔 기존 구조 유지 + `app/`에 `api.js`만 신설해도 무방. 전면 이동은 무리하지 않는다.
2. **`.gitignore` 보강** — `.env`, `*.key`, `*.pem`, `node_modules/`, `.vercel/`, `supabase/.temp/` 추가(`CLAUDE.md §11-A`).
3. **`.env.example`** 추가(키 이름만, 값 없음) — `00_현황스냅샷 §7` 목록 기준.

**체크포인트 A** — `.env`가 `git status`에 안 잡히는지, anon/service 키가 코드에 없는지 확인.

---

## B. Supabase 프로젝트·스키마·RLS

### B-1. 프로젝트 생성
- 리전: 가까운 곳(예: Northeast Asia / Seoul 가능 리전). 조직 = 생성해둔 계정.
- **Free 플랜**. 생성 시 비용 0 확인. DB 비밀번호는 시크릿 매니저에 보관.
- 생성 후 `SUPABASE_URL`·`ANON_KEY`·`SERVICE_ROLE_KEY` 확보(키는 환경변수로만).

### B-2. 스키마 (협력사 포털 우선)
`08/03_실구축기획/02 §3` + `07 §5`를 적용. 단일 `public` + 접두사(`sp_`). 격리 키 `bp_cd`를 각 행에 비정규화.

```sql
-- 진행상태
create table sp_order_state (
  po_no text primary key,
  bp_cd text not null,                 -- 격리 키(거래처)
  status text not null,                -- new|prod|insp|done
  step smallint not null,              -- 1~10 상태머신
  updated_by text, updated_at timestamptz default now()
);
-- 사진 메타(원본은 Storage)
create table sp_photo (
  id bigserial primary key, po_no text not null, bp_cd text not null,
  storage_path text not null, tag text, comment text,
  uploaded_by text not null, confirmed boolean default false,
  created_at timestamptz default now()
);
-- 양방향 메시지
create table sp_message (
  id bigserial primary key, po_no text not null, bp_cd text not null,
  sender_role text not null,           -- supplier|internal
  sender_id text not null, body text not null,
  created_at timestamptz default now(), read_at timestamptz
);
-- 검수요청(협력사 생성)
create table sp_insp_request (
  id bigserial primary key, po_no text not null, bp_cd text not null,
  insp_req_no text not null, requested_by text not null,
  requested_at timestamptz default now(), cancelled boolean default false
);
-- 검수판정(사내 생성) — ERP에는 쓰지 않음
create table sp_inspection (
  po_no text primary key, bp_cd text not null,
  result text not null, result_no text, judge_id text not null,
  opinion text, judged_at timestamptz default now()
);
-- 판정 이력(누적, 수정 불가)
create table sp_inspection_log (
  id bigserial primary key, po_no text not null, bp_cd text not null,
  result text not null, judge_id text not null,
  opinion text, judged_at timestamptz default now()
);
```

### B-3. 클레임 헬퍼 + RLS (필수)
```sql
-- 토큰 클레임에서 역할·허용 거래처 추출
create or replace function auth.is_internal() returns boolean
language sql stable as $$
  select (auth.jwt() -> 'app_metadata' ->> 'role') = 'internal';
$$;
create or replace function auth.vendor_bp() returns text[]
language sql stable as $$
  select coalesce((auth.jwt() -> 'app_metadata' -> 'vendor_bp'),'[]'::jsonb)::text[];
$$;

-- 모든 테이블 RLS ON + 정책 (예: order_state)
alter table sp_order_state enable row level security;
create policy internal_all on sp_order_state for all
  using (auth.is_internal()) with check (auth.is_internal());
create policy vendor_own on sp_order_state for all
  using (bp_cd = any (auth.vendor_bp()))
  with check (bp_cd = any (auth.vendor_bp()));
```
- `sp_photo`·`sp_message`·`sp_insp_request`에 같은 패턴.
- `sp_inspection`·`sp_inspection_log`는 **협력사 읽기만**(`for select using (bp_cd = any(auth.vendor_bp()))`), 쓰기는 `internal`만.

### B-4. Storage·Realtime
- 버킷 `vendor-photos`(비공개). 경로 `{bp_cd}/{po_no}/{uuid}.ext`. Storage 정책으로 협력사는 자기 `bp_cd` 접두만. 노출은 단기 서명 URL.
- Realtime: `sp_*` 테이블 publication 활성. 구독도 RLS 적용 → 협력사는 자기 발주 변경만 수신.

**체크포인트 B** — `select` 시 RLS가 막는지(anon으로 빈 결과), 사진 업로드가 자기 경로만 되는지.

---

## C. 인증 — 사내 Entra / 협력사 Supabase

### C-1. 사내(Entra → Supabase OIDC)
- Supabase Auth → Providers에 **Azure(Entra) OIDC** 등록. tenant/client는 환경변수.
- 로그인 성공 사용자에 `app_metadata.role='internal'`(+Entra 그룹). 기존 Entra PKCE 자산 계승.

### C-2. 협력사(Supabase Auth, 분리)
- 이메일/매직링크. 계정에 `app_metadata.role='vendor'`, `app_metadata.vendor_bp=['거래처코드',...]`.
- 사내 테넌트와 **완전 분리**(`CLAUDE.md §5.5`). 초대/온보딩은 관리자 콘솔/스크립트.

### C-3. 커스텀 클레임 주입 (RLS 동작의 전제)
- **Custom Access Token Hook**으로 `role`·`vendor_bp`를 액세스 토큰에 심는다. 이게 있어야 B-3 RLS가 작동.

**체크포인트 C** — 협력사 토큰 디코드 시 `vendor_bp`가 들어오는지, 사내 토큰에 `role=internal`인지.

---

## D. `api.js` 데이터 접근 모듈 (교체 지점 1곳)

`CLAUDE.md §3.3`. 화면의 `localStorage`/`fetch`를 전부 이 모듈 경유로. 어댑터만 갈아끼운다.

```js
// app/api.js
const adapter = supabaseAdapter; // ← mockAdapter | supabaseAdapter | azureAdapter
export const portalApi = {
  getOrders: ()=>adapter.getOrders(),
  updateStatus:(po,s,step)=>adapter.updateStatus(po,s,step),
  uploadPhoto:(po,file,meta)=>adapter.uploadPhoto(po,file,meta),
  sendMessage:(po,body)=>adapter.sendMessage(po,body),
  requestInspection:(po)=>adapter.requestInspection(po),
  judge:(po,result,opinion)=>adapter.judge(po,result,opinion),
  subscribe:(po,cb)=>adapter.subscribe(po,cb),
};
export const auth = { login:adapter.login, logout:adapter.logout, currentUser:adapter.currentUser };
```
- `협력사_모바일_포털.html`·`외주발주_검사진행현황_2026.html`의 `jxLoad/jxSave/syncOut/syncIn`을 `portalApi` 호출로 치환.
- 데모 키(`jeilax_link_v1`)는 `mockAdapter`에만 남기고 "데모 한정" 주석.

**체크포인트 D** — 화면이 `localStorage` 직접 접근을 더는 안 하는지(grep), 한 모듈만 바꿔 mock↔supabase 전환되는지.

---

## E. 데이터 시드 (마스킹 샘플 적재)

- 기존 데모 샘플(발주 `PO+YYYYMMDD+seq`, 품목 PLT-AL5T·UNI-25A-S·ORG-P22N·BRG-6204Z, 거래처 마스킹)을 `sp_*`에 시드.
- 시드는 서버측 스크립트(`SERVICE_ROLE_KEY`, 로컬/CI에서만)로. **ERP 실데이터 금지**.
- 회귀 테스트 위해 데모와 동일 PO 키 유지(`08/03/02 §6`).

**체크포인트 E** — 사내 계정으로 전체 보임, 협력사 계정으로 자기 거래처만 보임.

---

## F. Vercel 배포

1. Vercel에서 GitHub 저장소 **Import**(브랜치/디렉터리 지정). 자동배포.
2. **환경변수** 등록: `SUPABASE_URL`·`ANON_KEY`(+서버함수용 `SERVICE_ROLE_KEY`는 서버 스코프). 값은 Vercel UI에만.
3. **데모 도메인**: Vercel 기본(`*.vercel.app`) 또는 `ai-dev.jeilm.co.kr`(운영 `ai.jeilm.co.kr` 미사용). 도메인 확정은 `00 §8`.
4. HTTPS 강제 확인(`isHttps()` 동작).

**체크포인트 F** — 배포 URL 접속, 로그인→발주 조회→사진/메시지/검수가 DB에 실제 반영되는지.

---

## G. 검증 — RLS 격리 (보안 게이트, 필수)

`08/03_실구축기획/03 §4-3` 준용. 통과 못 하면 배포 중단.

- [ ] 협력사 A 토큰으로 협력사 B의 PO 직접 호출 → **빈 결과/거부**
- [ ] `vendor_bp` 없는 계정 → 전체 빈 결과
- [ ] 사진·메시지·검수요청 **쓰기**도 자기 PO 외 차단
- [ ] anon 키 직접 REST 호출로 테이블 덤프 시도 → RLS에 막힘
- [ ] 검수 판정(`sp_inspection`) 쓰기는 사내만, 협력사는 읽기만
- [ ] 변경 시 `/security-review` 셀프 점검(`CLAUDE.md §6`)

### 관리자 작업 — Entra redirect URI 추가 (코드로 안 됨)
데모 호스트를 Entra SSO에 쓰려면 **관리자가 Entra 앱 등록 → 인증 → SPA 플랫폼**에 아래를 직접 추가해야 한다(`CLAUDE.md §5.2`, 누락 시 AADSTS50011):
- `https://<vercel-배포도메인>/`
- (`ai-dev.jeilm.co.kr` 사용 시) `https://ai-dev.jeilm.co.kr/`

> Claude는 이 목록 제시까지만. **실제 Entra 변경은 관리자가** 수행.

---

## H. 완료 정의 (Definition of Done — 데모 데이터화)

- 협력사 포털·사내 대시보드가 **Supabase 데이터**로 양방향 동작(Realtime).
- 사내=Entra / 협력사=Supabase 인증 분리, RLS 격리 검증 통과.
- 사진=Storage, 비밀값=환경변수, ERP=마스킹 샘플.
- `api.js` 단일 모듈로 추상화(Azure 전환 준비 완료).
- `00 현황스냅샷`·`03 진행상태` 갱신.

→ 이후 운영 전환은 `02_Azure이관계획`.
