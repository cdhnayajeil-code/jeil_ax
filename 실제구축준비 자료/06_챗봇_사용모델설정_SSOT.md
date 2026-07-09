# 챗봇 사용모델 설정 — 실연동 SSOT

> **관리: 최동혁** · 최초 작성 2026-07-09 · 대상: 관리자 콘솔(`04_챗봇_포털_데모UI.html`) › **모델 설정** 탭
> 이 문서는 챗봇(jeil-chat) **사용모델·게이트웨이 설정·라우팅**의 단일 출처(SSOT)다.
> 관련: [00_관리체계/03_변경관리_CHANGELOG](../00_관리체계/03_변경관리_CHANGELOG.md) · [10_ERP_DB연계](../10_ERP_DB연계/) · CLAUDE.md §5·§6

---

## 0. 한 줄 요약

관리자 콘솔의 '모델 설정' 탭은 더 이상 데모 목업이 아니다. **Supabase 3개 테이블에 저장 → jeil-chat 게이트웨이가 요청마다 실제 소비**한다. 조회 실패·미설정이면 기존 하드코딩값으로 안전 폴백하므로 전 직원 챗봇은 무중단이다.

---

## 1. 데이터 모델 (Supabase `public`)

세 테이블 모두 **RLS enable + 정책 없음** → 클라이언트(anon/authenticated) 전면 차단. 조회·저장은 **Edge Function(service_role)** 만 수행한다(`chat_log`와 동일 패턴). 비밀값(API 키)은 저장하지 않는다 — 키는 Edge Secret(`OPENAI_API_KEY`) 전용(CLAUDE.md §1).

### 1.1 `ai_model` — 모델 카탈로그
| 컬럼 | 의미 |
|---|---|
| `model_id` (PK) | 실제 API 모델 식별자 (예: `gpt-4o-mini`) |
| `vendor` | `OpenAI` \| `Anthropic` |
| `label` / `purpose` | 표시명 / 용도 설명 |
| `price_in` / `price_out` | USD / 1M 토큰(입력/출력) — **추정비용 산정·표시용** |
| `active` | 게이트웨이 사용 활성화(관리자 스위치) |
| `callable` | **현 게이트웨이가 실제 호출 가능** — 서버가 벤더로 강제(OpenAI만 `true`) |
| `sort` / `note` / `updated_by` / `updated_at` | 정렬·메모·감사 |

> 현 게이트웨이는 **OpenAI 프록시**라 OpenAI 모델만 `callable=true`. Anthropic(claude-*)은 벤더 연동 전이라 **카탈로그·단가 표시용**(호출 불가). 클라이언트가 callable을 임의 지정해도 서버가 벤더 기준으로 덮어쓴다.

### 1.2 `ai_gateway_config` — 게이트웨이 설정(싱글턴 `id=1`)
| 컬럼 | 기본값 | 게이트웨이 반영 |
|---|---|---|
| `default_model` | `gpt-4o-mini` | 라우팅 미매칭 시 사용 모델 |
| `max_tokens` | 1024 | OpenAI `max_tokens` |
| `temperature` | 0.3 | OpenAI `temperature` |
| `prompt_caching` | true | OpenAI 자동 — 정책 표시용 |
| `max_messages` | 20 | 입력 대화 턴 상한 |
| `max_total_chars` | 24000 | 입력 총 글자 상한 |
| `system_prompt` | (현행 프롬프트) | 게이트웨이 system 메시지 |

### 1.3 `ai_routing_rule` — 자동 라우팅 규칙(순서대로 평가)
| 컬럼 | 의미 |
|---|---|
| `seq` | 평가 순서(작을수록 먼저) |
| `label` | 조건 설명 |
| `rule_type` | `keyword_length` \| `file` \| `erp` \| `cross_check` \| `default` |
| `match_keywords` (text[]) / `min_chars` | 포함 키워드(OR) / 입력 최소 글자 |
| `model_id` | 배정 모델 |
| `enforced` | **게이트웨이 실제 적용 여부** — 서버가 유형·활성으로 자동 판정(정직 플래그) |
| `active` | 규칙 사용 여부 |

---

## 2. 라우팅 시맨틱 (중요)

게이트웨이(`jeil-chat`)는 **`keyword_length` 유형만 실제 적용**한다. 그것도 **배정 모델이 `active`+`callable`(OpenAI)일 때만**. 그 외는 저장·표시만 한다.

- **적용됨(`enforced=true`)**: `keyword_length`, `default`(=기본모델과 동일)
- **표시만(`enforced=false`)**: `file`(파일 업로드 플래그 미수신 — 배선 후), `erp`(도구 사용은 모델이 판단), `cross_check`(Anthropic 이중 호출 미연동)

판정 로직(요청마다):
1. 마지막 **사용자** 메시지 텍스트를 기준으로 `active` 규칙을 `seq` 순 평가.
2. `keyword_length` 규칙에서 (키워드 포함 **또는** 글자수≥`min_chars`)이고 대상 모델이 usable(active+callable+OpenAI)이면 그 모델 채택.
3. 미매칭이면 `default_model`(usable 검증) → 아니면 첫 usable → 아니면 env `OPENAI_MODEL`.

> **시드 상태**: 규칙 2(키워드 분석·보고서·기획 / 2000자↑ → `gpt-4o`)는 `enforced=true`지만, `gpt-4o`가 시드에서 `active=false`라 **실제 라우팅은 기본모델(gpt-4o-mini)로 동작**한다. 관리자가 `gpt-4o`를 활성화하면 그 순간부터 라우팅이 발효된다(설계상 안전 기본값).

---

## 3. Edge Function API

### 3.1 `jeil-chat-admin` (v7~) — 관리자 전용
- **인증**: Entra 토큰 Graph 재검증(@jeilm.co.kr) → `portal_admin` 등록자만.
- **조회**(빈 바디): 응답에 `model_settings: { models, config, routing, effective_model }` 포함. `gateway.model`은 DB 기본모델(실효값), `gateway.limits`도 DB값.
- **저장 액션**:
  - `save_ai_models` → `ai_model` upsert. `callable`은 벤더로 강제.
  - `save_ai_config` → `ai_gateway_config` upsert. **기본모델이 active+callable이 아니면 400 거부.** 값 클램프(max_tokens 256~4096, temperature 0~2, max_messages 1~50, max_total_chars 1000~100000).
  - `save_ai_routing` → `ai_routing_rule` 전체 교체(삭제 후 삽입). `enforced`는 유형(`keyword_length`·`default`)+`active`로 서버가 강제.

### 3.2 `jeil-chat` (v15~) — 챗봇 게이트웨이
- 요청마다 `loadAiConfig()`로 3테이블 로드 → **입력 상한·시스템프롬프트·max_tokens·temperature·기본모델·라우팅·모델별 단가**에 실제 적용.
- **안전 폴백**: 조회 실패·config 미존재 시 코드 하드코딩 기본값(`fallbackConfig()`)으로 동작 → 챗봇 무중단.
- `chat_log`에 라우팅으로 선택된 실제 모델·토큰·추정비용(DB 단가 우선) 기록, 응답 헤더 `x-model`에 반영.

---

## 4. 운영 가이드 (관리자)

관리자 콘솔 로그인(MS, `portal_admin`) → **모델 설정** 탭:
- **사용 모델 관리**: 용도·단가 편집, 활성화 스위치(호출 불가 모델은 비활성 잠금). → **모델 저장**.
- **게이트웨이 설정**: 기본 모델(활성·callable만 선택 가능)·응답 파라미터·상한. → **설정 저장**.
- **모델 자동 라우팅 규칙**: 조건·키워드·최소글자·배정 모델. 적용 배지(<span>적용</span>=반영, 표시=연동 전). → **라우팅 저장**.
- **공통 시스템 프롬프트**: 편집 → **설정 저장(프롬프트 포함)**.

저장 즉시 게이트웨이 다음 대화부터 반영된다(별도 배포 불필요).

---

## 5. 재현 SQL / 배포 이력

- 마이그레이션: `ai_model_settings_tables`(DDL+RLS), `ai_model_settings_seed`(현행값 시드).
- Edge: `jeil-chat-admin` v7, `jeil-chat` v15 (둘 다 `verify_jwt=false`, 내부 Entra 검증).
- 소스: `supabase/functions/jeil-chat/index.ts`, `supabase/functions/jeil-chat-admin/index.ts`, 프론트 `04_챗봇_포털_데모UI.html`.

## 6. 한계·후속

- **파일 라우팅**(`file`): 프론트가 파일 첨부 플래그를 게이트웨이로 전달하는 배선 후 `enforced` 가능.
- **멀티 벤더(Anthropic)**: 게이트웨이에 Anthropic 호출 경로 추가 시 해당 모델 `callable=true`·`cross_check` 교차검증 발효.
- **직원 크레딧 차감**: 등급별 크레딧(사용량 탭)과 모델 단가의 연동은 별도 과제(현재 단가는 추정비용 표시까지).
- 프론트(`04`·통합본) 라이브 반영은 git push 필요(CLAUDE.md §8 — OneDrive 직접 push 지양, `/tmp` clone 절차).
