# 02. 데이터 모델 — ERP 매핑 · 포털 쓰기 스키마 · 10단계 상태머신

> 작성일: 2026-06-26 · 작성: 최동혁 · 대상 페이즈: P1~P2
> 관련: 01 아키텍처, 05 협의 체크리스트, `08/00_종합정리_요구사항이력`(ERP 매핑 §6)
> 주의: 아래 ERP 컬럼은 **ERP 사전(스키마 스냅샷, 2026-04-15 기준)** 에 근거한다. 운영 DB 직접 쿼리는 망분리로 미수행 → **유니포인트 확정(05 문서) 전까지 가설**로 취급한다.

---

## 1. 데이터 영역 3분할

| 영역 | 스키마 | 출처/주체 | 접근 | 예시 테이블 |
|---|---|---|---|---|
| **ERP 사본** | `erp_ro` | UNIERP(야간배치) | 읽기 전용 | po_header, po_line, pr, goods_mvmt, inspection, item, bp |
| **포털 생성** | `sub_portal` | 협력사·사내(실시간 쓰기) | 읽기/쓰기 | order_state, photo, message, insp_request, inspection, inspection_log |
| **운영 메타** | `sub_meta` | 시스템 | 시스템 | sync_log, audit_log, notify_queue, supplier_account, supplier_bp_map |

**조인 축은 항상 발주번호(`po_no`)** — `PO+YYYYMMDD+일련번호` (예: `PO202606220012`). ERP 사본과 포털 생성물은 `po_no`(필요 시 `po_no + line_no`)로만 연결한다.

---

## 2. ERP → `erp_ro` 매핑 (읽기 전용 사본)

| 구간 | UNIERP 원천(가설) | `erp_ro` 사본 테이블 | 핵심 컬럼 |
|---|---|---|---|
| 구매요청 | `M_PUR_REQ` | `pr` | PR_NO, PR_STS, REQ_QTY, ORD_QTY, RCPT_QTY |
| 발주(헤더) | `M_PUR_ORD_HDR` | `po_header` | PO_NO, BP_CD(거래처), ORD_DT, RELEASE_FLG, PROJECT_CD |
| 발주(명세) | `M_PUR_ORD_DTL` | `po_line` | PO_NO, LINE_NO, ITEM_CD, ORD_QTY, DUE_DT |
| 발주구분 | `M_CONFIG_PROCESS` | `po_header.po_type` | PO_TYPE_CD, PO_TYPE_NM, **SUBCONTRA_FLG**(사급여부) |
| 입고·출하 | `M_PUR_GOODS_MVMT` | `goods_mvmt` | MVMT_RCPT_NO(입고), MVMT_RCPT_DT, DN_NO(출하), INSPECT_REQ_NO, INSPECT_STS, INSPECT_GOOD_QTY/BAD_QTY |
| 검사 의뢰/결과 | `Q_INSPECTION_*` | `inspection_erp` | INSP_REQ_NO, INSP_RESULT_NO, 합격/불합격 |
| 매입 | `M_IV_HDR/DTL` | `iv` | IV_QTY |
| 거래처 | `B_BP` | `bp` | BP_CD, BP_NM (오성테크·이천베아링 등) |
| 품목 | `B_ITEM` | `item` | ITEM_CD, ITEM_NM (PLT-AL5T·UNI-25A-S·ORG-P22N·BRG-6204Z 등) |

### 발주구분 코드(검수요청 단계 분기의 근거)
| 코드 | 의미 | 검수요청(7단계) |
|---|---|---|
| SIE | 외주제작 | 적용(검사신청 생성) |
| SIE-1 | 외주제작(수불X) | 적용 |
| SIF | 외주설치 | 적용 |
| DIV | 국내매입(비외주) | **생략** → 입고검사로 처리 |

`SUBCONTRA_FLG`(사급여부) + `PO_TYPE_CD`로 외주 여부를 판정해, 10단계 중 ⑦검수요청 단계 적용/생략을 결정한다.

### 공통 컬럼 (모든 `erp_ro` 테이블)
```sql
synced_at    TIMESTAMPTZ   -- 포털 적재 시각
src_updated  TIMESTAMPTZ   -- ERP 원천 최종 수정 시각(증분 추출 기준)
batch_id     UUID          -- 배치 실행 ID
```
화면·답변에 "데이터 기준: MM/DD 03:00 동기화" 표기로 신선도 보장.

---

## 3. 포털 쓰기 스키마 `sub_portal` (데모 localStorage 대체)

데모의 `jeilax_link_v1` 공유 객체를 정규화한 것이다. 데모 필드 → 테이블 대응을 함께 표기한다.

```sql
-- 발주별 진행상태 (데모: orders[po].status)
CREATE TABLE sub_portal.order_state (
  po_no        TEXT PRIMARY KEY,           -- erp_ro.po_header 참조(논리 FK)
  status       TEXT NOT NULL,              -- 신규접수|생산중|검수요청|완료
  step         SMALLINT NOT NULL,          -- 1~10 (상태머신, §5)
  updated_by   TEXT, updated_at TIMESTAMPTZ DEFAULT now()
);

-- 사진 메타 (데모: orders[po].photos[]/photoCount). 원본은 Blob, DB는 메타만
CREATE TABLE sub_portal.photo (
  id           BIGSERIAL PRIMARY KEY,
  po_no        TEXT NOT NULL, line_no INT,
  blob_path    TEXT NOT NULL,              -- 스토리지 경로(서명 URL로 노출)
  tag          TEXT, comment TEXT,         -- 가공|완성|포장|출하 등
  uploaded_by  TEXT NOT NULL,              -- 협력사 계정
  confirmed    BOOLEAN DEFAULT false,      -- 사내 확인 여부
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- 양방향 메시지 (데모: orders[po].messages[])
CREATE TABLE sub_portal.message (
  id           BIGSERIAL PRIMARY KEY,
  po_no        TEXT NOT NULL,
  sender_role  TEXT NOT NULL,              -- supplier|internal
  sender_id    TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now(),
  read_at      TIMESTAMPTZ
);

-- 검수요청 (데모: inspRequested/inspReqNo) — 협력사가 생성
CREATE TABLE sub_portal.insp_request (
  id           BIGSERIAL PRIMARY KEY,
  po_no        TEXT NOT NULL,
  insp_req_no  TEXT NOT NULL,             -- 자동생성 IR+YYYYMMDD+seq
  requested_by TEXT NOT NULL, requested_at TIMESTAMPTZ DEFAULT now(),
  cancelled    BOOLEAN DEFAULT false      -- 단계취소 시 자동 철회
);

-- 검수 판정 (데모: inspection) — 사내가 생성. ERP에는 쓰지 않음
CREATE TABLE sub_portal.inspection (
  po_no        TEXT PRIMARY KEY,
  result       TEXT NOT NULL,             -- 합격|불합격
  result_no    TEXT,                      -- IQ+YYYYMMDD+seq
  judge_id     TEXT NOT NULL,             -- 판정자(인원 기록)
  opinion      TEXT,
  judged_at    TIMESTAMPTZ DEFAULT now()
);

-- 검수 판정 이력 (데모: inspLog[]) — 누가 합/부를 눌렀는지 누적
CREATE TABLE sub_portal.inspection_log (
  id           BIGSERIAL PRIMARY KEY,
  po_no        TEXT NOT NULL,
  result       TEXT NOT NULL, judge_id TEXT NOT NULL,
  opinion      TEXT, judged_at TIMESTAMPTZ DEFAULT now()
);
```

### 데모 필드 ↔ 운영 테이블 대응표
| 데모(`jeilax_link_v1`) | 운영 테이블 | 쓰는 주체 |
|---|---|---|
| `status` | `order_state.status/step` | 협력사 |
| `photos[]` / `photoCount` | `photo` (+ Blob 원본) | 협력사 |
| `messages[]` / `lastMsg` | `message` | 협력사·사내(양방향) |
| `inspRequested` / `inspReqNo` | `insp_request` | 협력사 |
| `inspection` | `inspection` | 사내 |
| `inspLog[]` | `inspection_log` | 사내 |

---

## 4. `sub_meta` — 계정·매핑·운영

```sql
-- 협력사 계정 (인증 방식 D1 확정 전 공통 프로파일)
CREATE TABLE sub_meta.supplier_account (
  account_id   TEXT PRIMARY KEY,          -- 데모 hanil-mt 대체
  display_name TEXT, contact TEXT,
  auth_subject TEXT,                      -- Entra B2B oid 또는 자체인증 키
  status       TEXT DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT now()
);

-- ★ 행수준 보안의 핵심: 협력사 계정 ↔ ERP 거래처(B_BP) 매핑 (결정 D2)
CREATE TABLE sub_meta.supplier_bp_map (
  account_id   TEXT REFERENCES sub_meta.supplier_account,
  bp_cd        TEXT NOT NULL,             -- erp_ro.bp.BP_CD
  PRIMARY KEY (account_id, bp_cd)
);

CREATE TABLE sub_meta.audit_log (     -- 누가·언제·무엇을 봤/했나
  id BIGSERIAL PRIMARY KEY, actor TEXT, role TEXT, action TEXT,
  po_no TEXT, detail JSONB, at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE sub_meta.notify_queue ( -- 알림 디스패치 큐 (04 문서)
  id BIGSERIAL PRIMARY KEY, target TEXT, channel TEXT, payload JSONB,
  status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE sub_meta.sync_log (     -- 야간배치 실행 로그(90일)
  batch_id UUID, started TIMESTAMPTZ, ended TIMESTAMPTZ,
  rows INT, status TEXT, error TEXT
);
```

협력사가 발주를 조회하면 백엔드는 `supplier_bp_map`으로 **해당 계정의 `bp_cd` 집합**을 구하고, `erp_ro.po_header.BP_CD IN (...)` 로만 결과를 제한한다(RLS, 03 문서).

---

## 5. 10단계 프로세스 상태머신

| 존 | 단계 | 주체 | `step` | 전이 가능 |
|---|---|---|---|---|
| JEIL | ① 구매요청 | 구매 | 1 | →2 |
| JEIL | ② 발주 | 구매 | 2 | →3 |
| 협력사 | ③ 발주확인 | 협력사 | 3 | →4, ←2 |
| 협력사 | ④ 접수 | 협력사 | 4 | →5, ←3 |
| 협력사 | ⑤ 생산 | 협력사 | 5 | →6, ←4 |
| 협력사 | ⑥ 사진등록 | 협력사 | 6 | →7, ←5 |
| 협력사 | ⑦ 검수요청 | 협력사 | 7 | →8, ←6 (외주만; 검사신청 생성/철회) |
| 협력사 | ⑧ 출하 | 협력사 | 8 | →9, ←7 |
| ERP | ⑨ 입고+검수판정 | 사내/품질 | 9 | →10 (합격) / 보류(불합격) |
| ERP | ⑩ 매입 | 사내 | 10 | 완료 |

전이 규칙(백엔드에서 강제):
- **전진**은 인접 단계로만. 임의 점프 금지.
- **단계취소(역전이)** 는 직전 단계로만 1칸. ⑦ 취소 시 `insp_request.cancelled=true` 자동.
- **DIV(비외주)** 는 ⑦ 생략 → ⑥에서 ⑧로.
- ⑨ 검수판정 **불합격** 시 step 유지(보류), 협력사에 결과 배너+알림. 재작업 후 재요청 가능.
- 모든 전이는 `audit_log`에 기록.

```
신규접수(3~4) → 생산중(5~6) → 검수요청(7) → [검수판정] → 완료(9~10)
        ▲────────── 단계취소(1칸 역전이) ──────────┘
```

---

## 6. 샘플 데이터 정합 (데모 계승)
- 발주번호: `PO202606220012` 형식 / 구매요청 `PR+YYYYMMDD+seq` / 검사 `IR·IQ+YYYYMMDD+seq`.
- 품목: PLT-AL5T(알루미늄 플레이트 5T), UNI-25A-S(유니온 배관 25A SUS), ORG-P22N(오링 P-22 NBR), BRG-6204Z(볼베어링 6204ZZ).
- 거래처: 오성테크·이천베아링·신호종합배관·대신스텐레스·지아이텍.
- 운영 전환 시 이 값들은 `erp_ro` 실데이터로 대체되며, 데모 키와 동일 PO를 유지해 회귀 테스트에 사용.

---

## 7. 이 문서의 확정 필요 항목
- [ ] 유니포인트로 ERP 컬럼 가설 검증(05 협의표) → 매핑 확정
- [ ] D2: 협력사 계정 ↔ 거래처 매핑 단위(1:1 / 1:N) 결정 → `supplier_bp_map` 카디널리티
- [ ] D3: 검수 판정의 ERP 반영 여부 → `inspection` 의 ERP 쓰기 금지 원칙 재확인
- [ ] `po_line` 단위 사진/검수가 필요한지(라인별) vs 발주(헤더) 단위 — 화면 요구와 대조
