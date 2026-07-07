# ERP → 중간DB(Supabase) ETL

> `03_중간DB_구축실행기획.md`(D1-a안) 실행 도구. 원칙: **운영 MSSQL 읽기 전용, 포털·챗봇은 중간DB(erp_ro)만 조회** (CLAUDE.md §4).

## 구성

| 파일 | 역할 | ERP DB 접속 |
|---|---|---|
| `load_table_dict.py` | ERP 테이블 사전 적재 — `ERP_DB/erp_chat/data` 로컬 메타(2,600여 테이블·컬럼 문서) → `erp_ro.table_dict` | **안 함**(로컬 파일만) |
| `etl_run.py` | 1차 4종 집계 적재(품목·영업월·구매월·재고일) → `erp_ro.*` + `etl_meta.batch_run` 기록 | **읽기 전용 SELECT** |
| `_env.py` | 프로젝트 루트 `.env` 로더 | - |

## 필요 환경변수 (루트 `.env` — 값 커밋 금지)

- `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` — 적재(RPC `erp_etl_upsert`/`erp_etl_batch`, service_role 전용)
- `ERP_DB_CONN` — pyodbc 연결 문자열(읽기 전용 계정 권장) — `etl_run.py`만 사용
- `ERP_DB_META_DIR` — (선택) 메타 폴더 경로 재정의

## 실행

```bash
pip install pyodbc                      # etl_run.py만 필요
python load_table_dict.py               # 테이블 사전 (ERP 접속 없음)
python etl_run.py --job all --dry-run   # 추출 건수만 확인 (적재 안 함)
python etl_run.py --job all             # 실제 적재 (⚠ 관리자 확인 후)
```

## 보안·운영 규칙

1. **추출 SQL은 이 저장소의 화이트리스트만** — 임의 쿼리 추가 시 반드시 검토. 전부 `SELECT` + 파라미터 바인딩, `WITH (NOLOCK)`.
2. 추출 SQL은 **유니포인트 뷰 스펙 협의 전 초안** — 테이블·컬럼명 상이 시 `--dry-run`으로 확인 후 수정.
3. 적재 경로는 RPC(`security definer`, service_role 전용)라서 `erp_ro` 스키마를 REST에 노출하지 않는다. 사내 화면 조회는 추후 공개 뷰/RPC 또는 Edge Function으로 제공.
4. 배치 이력은 `etl_meta.batch_run`, 화면 「데이터 기준 시각」은 `etl_meta.v_last_success`.
5. 운영 정식 스케줄(03:00)·알림은 03 기획 §5 — 파일럿은 수동 실행.
