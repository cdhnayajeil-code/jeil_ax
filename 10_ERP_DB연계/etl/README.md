# ERP → 중간DB(Supabase) ETL

> `03_중간DB_구축실행기획.md`(D1-a안) 실행 도구. 원칙: **운영 MSSQL 읽기 전용, 포털·챗봇은 중간DB(erp_ro)만 조회** (CLAUDE.md §4).

## 구성

| 파일 | 역할 | ERP DB 접속 |
|---|---|---|
| `load_table_dict.py` | ERP 테이블 사전 적재 — `ERP_DB/erp_chat/data` 로컬 메타(2,600여 테이블·컬럼 문서) → `erp_ro.table_dict` | **안 함**(로컬 파일만) |
| `etl_run.py` | 1차 4종 집계 적재(품목·영업월·구매월·재고일) → `erp_ro.*` + `etl_meta.batch_run` 기록 | **읽기 전용 SELECT** |
| `etl_watch.py` | 웹 「데이터 업데이트」 요청 감시·실행 러너 — Supabase 큐(`etl_meta.sync_request`)를 폴링해 `etl_run.run_job` 실행 | **읽기 전용 SELECT**(요청 처리 시) |
| `_env.py` | 프로젝트 루트 `.env` 로더 | - |

## 필요 환경변수 (루트 `.env` — 값 커밋 금지)

- `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` — 적재(RPC `erp_etl_upsert`/`erp_etl_batch`, service_role 전용)
- `ERP_DB_CONN` — pyodbc 연결 문자열(읽기 전용 계정 권장) — `etl_run.py`만 사용
- `ERP_DB_META_DIR` — (선택) 메타 폴더 경로 재정의

## 실행 환경 (ODBC 드라이버 — 실행 전 확인)

`etl_run.py`는 pyodbc로 ERP에 붙는다. **`ODBC Driver 18 for SQL Server`(또는 17) 설치를 권장**하고,
연결 문자열의 `Driver=` 를 여기에 맞춘다(연결 문자열 자체는 `.env`·DPAPI에만 — 커밋 금지).

> **레거시 `SQL Server` 드라이버 주의(2026-08-11 실측)**: Windows 기본 제공 레거시 드라이버는
> `SQL_TYPE_DATE` **파라미터 바인딩을 구현하지 않아**, 날짜 파라미터를 쓰는 job 7종
> (`pur_order`·`pur_req`·`sales`·`purchase`·`iv_dtl`·`inventory`·`hr_payroll`)이
> `HYC00 (SQLBindParameter)`로 전부 실패한다. 무파라미터·`datetime` job 7종은 정상 동작해
> **부분 성공으로 보이는 것이 함정**이다.
> → `etl_run.py`가 `date` 파라미터를 `datetime`(자정)으로 승격해 회피하므로 레거시 드라이버에서도
> 동작한다(경계 비교가 `>= 시작 AND < 종료`라 결과 동일, `CONVERT(date,…)` 결과 컬럼은 영향 없음).
> 이 승격은 드라이버 교체 후에도 안전장치로 유지한다.

## 실행

```bash
pip install pyodbc                        # etl_run.py만 필요
python load_table_dict.py                 # 테이블 사전 (ERP 접속 없음)
python etl_run.py --job all --dry-run     # 추출 건수만 확인 (적재 안 함)
python etl_run.py --job all               # 실제 적재 (⚠ 관리자 확인 후)
python etl_run.py --job usr_master --dry-run   # 사용자 계정(Z_USR_MAST_REC) 단독 확인
python etl_run.py --job dept_master            # 부서 마스터(B_ACCT_DEPT) 단독 적재
```

### 웹 「데이터 업데이트」 버튼 러너 (`etl_watch.py`)

`app/erp-status.html`(ERP 데이터 연동 현황)의 **🔄 데이터 업데이트** 버튼은 ERP에 직접 붙지 않는다 —
Supabase 큐 `etl_meta.sync_request`에 요청만 남긴다. **ERP 접속이 되는 이 호스트에서 러너를 띄워 둬야**
요청이 실제 ETL로 집행되고, 화면이 자동으로 갱신된다(러너가 꺼져 있으면 화면이 "실행 러너 미가동"으로 안내).

```bash
python etl_watch.py                 # 상주(20초 주기 폴링) — 콘솔 켜두면 됨
python etl_watch.py --once          # 1회 확인 후 종료 — 작업 스케줄러 1분 주기용
python etl_watch.py --once --dry-run  # 적재 없이 흐름만 검증
```

Windows 작업 스케줄러 등록(1분 주기, 창 숨김):

```powershell
# <repo> = 저장소 경로. pythonw.exe 로 등록하면 콘솔 창 없이 돈다.
schtasks /Create /TN "JEIL_AX ETL 요청러너" /SC MINUTE /MO 1 /RL LIMITED ^
  /TR "pythonw.exe \"<repo>\10_ERP_DB연계\etl\etl_watch.py\" --once"
```

- 대상 job = `JOBS` 중 **민감분(급여 `hr_payroll`, `erp_secure`) 제외 전 종**(현재 19종). 증분(watermark) 기준이라 변경분만 돈다.
- 진행률·결과는 `etl_meta.sync_request`(진행 job·건수·job별 성패)에, 배치 이력은 기존대로 `etl_meta.batch_run`에 남는다.
- 중복 실행 방지: 진행 중 요청이 있으면 버튼은 그 요청에 붙고, 종료 60초 내 재요청은 쿨다운으로 거절된다.
- 좀비 정리: `running` 2시간·`queued` 4시간 초과 요청은 다음 claim 때 `failed`로 정리된다.
- SQL 정본: `실제구축준비 자료/이관/sql/29_erp_sync_request.sql`(마이그레이션 `erp_sync_request_v1`).

### JOB 목록

| job | 원천 | 대상 테이블 | 비고 |
|---|---|---|---|
| `usr_master` | `Z_USR_MAST_REC` | `erp_ro.usr_master_s` | 사용(`USE_YN='Y'`)·이메일(`@`) 계정만. 부서/사원은 `usr_nm` 파싱(뷰) |
| `dept_master` | `B_ACCT_DEPT` | `erp_ro.dept_master_s` | 부서명 대사 기준·부서-사원 관계 |
| `usr_erp_module` | `Z_USR_MAST_REC_USR_ROLE_ASSO`→`Z_USR_ROLE_MNU_AUTHZTN_ASSO`→`Z_CO_MAST_MNU` | `erp_ro.usr_erp_module_s` | 사용자별 ERP 접근 모듈(ModuleInitial). 부서별 ERP 모듈 **제안값**(`v_dept_erp_suggest`)용 — 콘솔 ◆ 참고표시, 자동 덮어쓰기 아님 |
| `hr_payroll` ⚠민감 | `HDF070T`(월급여대장)·`HGA070T`(퇴직) | **`erp_secure.hr_payroll_m`** (rpc=`erp_secure_upsert`) | 인사 급여 **집계만**(월×부서 인원·급여총액, 월×전사 퇴직). 개인별·이름·주민번호·계좌 미포함. 인사팀 전용(jeil-hr). 실 적재는 관리자 `!` 직접 실행(거버넌스 게이트) |
| `pur_order`·`item_master`·`sales`·`purchase`·`inventory` | (기존) | `erp_ro.*` | 1차 5종 |
| `acct_master`·`cost_center`·`ctrl_item`·`acct_ctrl_assn` | `A_ACCT`·`B_COST_CENTER`·`A_CTRL_ITEM`·`A_ACCT_CTRL_ASSN` | `erp_ro.*` | 결의전표 회계 마스터 4종(코드·설정만) |
| `gl_slip`·`gl_slip_item`·`gl_slip_ctrl` | `A_TEMP_GL`·`_ITEM`·`_DTL` | `erp_ro.gl_slip*_s` | 결의전표 미러(「전표복사」 원천, 결정 C-10). 관리항목 값 중 민감 5종(`EM`·`BA`·`D1`·`CP`·`NN`)은 적재 시 NULL 마스킹 |
| `ctrl_ref` | `V_SO_TRACKING`·`B_MINOR`·`B_BANK`·`F_DPST`·`B_CREDIT_CARD`·`HAA010T` 등 **25종** | **`erp_ro.ctrl_ref_s`** (rpc=`erp_ctrl_ref_upsert`) | 관리항목 🔍 검색 원천. 참조 보유 관리항목 31종 중 27종(거래처·품목 4종은 전용 RPC). **사번은 사번·성명·부서명만·재직자만** — 주민번호·급여·주소·연락처는 추출하지 않는다. 민감 항목 조회는 `gl_draft_log` 감사기록 |

> **사용자↔부서↔사원 대사**: `usr_master`+`dept_master` 적재 후 `public.v_erp_user_dept`(정상 매핑)·`v_erp_user_dept_recon`(불일치)·`v_erp_dept_roster`(부서 명부)로 조회. 파싱·판정 로직은 마이그레이션 `erp_user_dept_mapping`(정본 `실제구축준비 자료/이관/sql/09_erp_user_dept_mapping.sql`).
>
> **알려진 한계(usr_master)**: 적재는 upsert-only라 재직→퇴사로 `USE_YN`이 `N`으로 바뀐 계정은 `usr_master_s`에 잔존할 수 있음(증분·`--full` 모두 삭제는 안 함). 정합이 필요하면 주기적 prune(현재 활성셋에 없는 `usr_id` 삭제)을 후속 도입.

## 보안·운영 규칙

1. **추출 SQL은 이 저장소의 화이트리스트만** — 임의 쿼리 추가 시 반드시 검토. 전부 `SELECT` + 파라미터 바인딩, `WITH (NOLOCK)`.
2. 추출 SQL은 **유니포인트 뷰 스펙 협의 전 초안** — 테이블·컬럼명 상이 시 `--dry-run`으로 확인 후 수정.
3. 적재 경로는 RPC(`security definer`, service_role 전용)라서 `erp_ro` 스키마를 REST에 노출하지 않는다. 사내 화면 조회는 추후 공개 뷰/RPC 또는 Edge Function으로 제공.
4. 배치 이력은 `etl_meta.batch_run`, 화면 「데이터 기준 시각」은 `etl_meta.v_last_success`.
5. 운영 정식 스케줄(03:00)·알림은 03 기획 §5 — 파일럿은 수동 실행.
