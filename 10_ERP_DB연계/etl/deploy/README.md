# 결의전표 ERP 전송 릴레이 — ERP 서버 배포 키트

> 화면에서 [🚀 ERP 전송]을 누르면 **사람 개입 없이 ERP에 반영**되게 하는 상시 러너를 ERP 서버에 세운다.
> 지금까지는 관리자가 `gl_apply_demo2.py` 를 손으로 돌려 왔고, 그래서 안 돌리면 전송대기로 계속 쌓였다.
> 기획서 `03_중간DB_구축실행기획 §D2-a` 의 "**상시 가동 장비 지정 필수**" 미이행분을 해소하는 작업이다.

## 왜 ERP 서버인가 (2026-08-24 실측)

| 조건 | 결과 |
|---|---|
| 항상 켜져 있음 | ✅ ERP 운영 서버 |
| ERP MSSQL 접근 | ✅ `localhost` — `JEILMNS_DEMO2` 가 같은 인스턴스에 있음 |
| Supabase 아웃바운드 443 | ✅ `TcpTestSucceeded : True` |
| ODBC 드라이버 | ✅ `ODBC Driver 17 for SQL Server` (스크립트는 18→17 순으로 탐색) |
| 외부 파이썬 패키지 | **`pyodbc` 하나뿐** (나머지는 표준 라이브러리, HTTP도 `urllib`) |
| Python | ❌ 미설치 → **이 키트가 설치한다** |

## 폴더 구조 (고정)

`_env.py` 가 `.env` 를 **스크립트 기준 두 단계 위**에서 찾으므로 저장소 구조를 그대로 옮긴다.
구조를 바꾸면 `.env` 를 못 찾는다.

```
E:\ai.jeil\
├─ python312\                         ← 전용 파이썬 (시스템 PATH 미변경)
├─ logs\                              ← 실행 로그(월 단위 파일)
├─ relay.cmd                          ← 작업 스케줄러가 부르는 진입점
└─ jeil_ax\                           ← 저장소 구조
   ├─ .env                            ← ACL 잠금. OneDrive 경유 금지
   └─ 10_ERP_DB연계\etl\
      ├─ gl_apply_demo2.py
      ├─ _env.py
      └─ _erp_conn.py
```

> **OneDrive 폴더에서 직접 실행하지 않는다.** `E:\OneDrive - …\ai.jeil - ax` 는 파일을 서버로
> 옮기는 통로로만 쓴다. 작업 스케줄러를 "로그온 여부와 관계없이 실행"으로 걸면 OneDrive
> 클라이언트가 돌지 않아, 파일 온디맨드 플레이스헐더 상태면 스크립트가 **조용히 실패**한다.

## 배포 순서

### 1. 설치

```powershell
# 관리자 PowerShell
.\install.ps1 -PythonInstaller .\python-3.12.10-amd64.exe
```

Python 3.12 를 `E:\ai.jeil\python312` 에 설치(PATH 미변경)하고 `pyodbc` 를 넣는다.
pypi 가 막혀 있으면 워크스테이션에서 휠을 받아 `-WheelDir` 로 넘긴다.

```powershell
# 워크스테이션에서 미리
python -m pip download pyodbc -d .\wheels --only-binary=:all:
# 서버에서
.\install.ps1 -PythonInstaller .\python-3.12.10-amd64.exe -WheelDir E:\ai.jeil\wheels
```

### 2. 스크립트 3개 복사

```powershell
$src = "E:\OneDrive - 제일엠앤에스\ai.jeil - ax\etl"
$dst = "E:\ai.jeil\jeil_ax\10_ERP_DB연계\etl"
Copy-Item "$src\gl_apply_demo2.py","$src\_env.py","$src\_erp_conn.py" $dst
```

`__pycache__` 는 복사하지 않는다.

### 3. `.env` 작성 — 서버에서 직접

**OneDrive를 거치지 않는다.** `E:\ai.jeil\jeil_ax\.env` 에 키 3개.

```
SUPABASE_URL = ...
SUPABASE_SERVICE_ROLE_KEY = ...
ERP_DB_CONN = DRIVER={ODBC Driver 17 for SQL Server};SERVER=localhost;DATABASE=JEILMNS;UID=...;PWD=...;TrustServerCertificate=yes;
```

- 워크스테이션의 `%USERPROFILE%\.erp\` DPAPI 저장소는 **계정·장비에 묶여 서버에서 복호화되지 않는다.**
  서버에서는 `ERP_DB_CONN` 방식만 동작한다(`_erp_conn.py` 주석의 "서버 배치 배포용"이 이 경로다).
- `DATABASE=JEILMNS` 로 둬도 된다. `gl_apply_demo2.py` 가 접속 시 `JEILMNS_DEMO2` 로 강제 치환하고,
  붙은 뒤 실제 DB명을 재확인해 다르면 **아무것도 실행하지 않고 중단**한다(가드 2).

작성 후 접근 제한:

```powershell
icacls E:\ai.jeil\jeil_ax\.env /inheritance:r
icacls E:\ai.jeil\jeil_ax\.env /grant:r "Administrators:(R)" "SYSTEM:(R)"
```

### 4. 검증 — 스케줄러 등록 **전에** 한다

```powershell
$py  = "E:\ai.jeil\python312\python.exe"
cd   "E:\ai.jeil\jeil_ax\10_ERP_DB연계\etl"

& $py gl_apply_demo2.py --list                       # ① 대기 건이 보이는가 (읽기 전용)
& $py gl_apply_demo2.py --draft <초안번호> --dry-run   # ② 리허설 — 전 과정 실행 후 ROLLBACK
& $py gl_apply_demo2.py --draft <초안번호>             # ③ 실건 1건, 소액으로
```

③에서 **AG 번호가 채번되고 라인이 완전일치**하면 통과다. 화면 [ERP 전송] 탭에도
`applied` + AG 번호로 바뀐다.

> ①②③ 을 건너뛰고 스케줄러부터 걸지 않는다. 대기 건이 쌓여 있으면 1분 안에 전부 나간다.

### 5. 작업 스케줄러 등록

```powershell
.\register_task.ps1 -Account ADMIN          # 비밀번호는 대화형으로 물어본다
```

1분 주기로 `relay.cmd` → `gl_apply_demo2.py --queue --max 5` 를 실행한다.
`--max 5` 는 1회 처리 상한으로, 대량 오전송을 막는 안전장치다.

### 6. 확인

```powershell
Get-ScheduledTask JEIL_AX_GL_Relay | Get-ScheduledTaskInfo    # LastTaskResult 0 이면 정상
Get-Content E:\ai.jeil\logs\relay_$(Get-Date -Format yyyyMM).log -Tail 30
```

## 되돌리기

```powershell
schtasks /Delete /TN "JEIL_AX_GL_Relay" /F
```

작업만 지우면 즉시 종전(수동 실행) 상태로 돌아간다. 파일·Python 은 남겨 둬도 무해하다.

## 안전장치 (이미 코드에 있는 것)

| 장치 | 내용 |
|---|---|
| 대상 DB 하드코딩 | `TARGET_DB = "JEILMNS_DEMO2"` — CLI 파라미터 없음. 운영(`JEILMNS`) 쓰기 불가(C-1) |
| 접속 후 재확인 | 붙은 DB명이 `JEILMNS_DEMO2` 가 아니면 아무것도 실행하지 않고 중단 |
| 선점 | `gl_apply_claim`(`FOR UPDATE SKIP LOCKED`) — 러너를 둘 띄워도 한 초안은 하나만 가져간다 |
| 멱등 3중 | `A_BATCH.REF_NO` · `A_TEMP_GL.REF_NO` 선조회 + 포털 원장 유니크 |
| 완전대조 | 투입 후 `A_TEMP_GL` 을 되읽어 라인 1:1 비교, 불일치면 **ROLLBACK** |
| 회수 | 죽은 러너가 `sending` 에 가둔 건을 30분 뒤 자동 반납(`gl_apply_reclaim`) |
| 처리 상한 | `--max 5` |
| 감사 | `gl_erp_apply_log` (mode·status·detail) |
| 마감월 | 제출 단계 Edge Function 이 `gl_period_lock` 으로 차단 |

## 알려진 한계 (자동화해도 남는 것)

1. **내용이 같은 별개 초안은 막지 못한다.** 멱등 방어는 *같은 초안번호* 기준(`REF_NO=draft_no`)이라,
   같은 금액·적요를 두 번 올리면 ERP에 전표가 두 장 생긴다. 실제로 2026-08-24 큐에
   동일 적요·금액 2건이 함께 있었다. 운영 전환 전 화면 단계의 중복 경고가 필요하다.
2. **되돌리기는 DEMO2 한정.** `--cleanup` 으로 지울 수 있는 건 데모 DB뿐이다. 운영에서는
   전표 취소 절차가 별도로 필요하다.
3. **AX001 계정매핑(U-F)** 이 `A_JNL_ACCT_ASSN` 에 미등재다. DEMO2 에서는 3단계 폴백으로
   통과하지만, 운영 전환 전 회계팀 등재가 필요하다.

## 다음 단계 (이 키트 범위 밖)

- ETL 러너(`etl_watch.py`)도 같은 Python 위로 옮기면 워크스테이션 의존이 완전히 사라진다.
  필요 패키지가 동일(`pyodbc`)해 추가 설치가 없다. 릴레이 안정 확인 후 별건으로 진행한다.
