# 결의전표 ERP 전송 릴레이 — ERP 서버 배포 키트

> 화면에서 [🚀 ERP 전송]을 누르면 **사람 개입 없이 ERP에 반영**되게 하는 상시 러너를 세운다.
> 지금까지는 관리자가 스크립트를 손으로 돌려야 했고, 안 돌리면 전송대기로 계속 쌓였다
> (2026-08-24 실측: 마지막 수동 실행 08-20 이후 4건 적체 — 실패가 아니라 미시도).
> 기획서 `03_중간DB_구축실행기획 §D2-a` 의 "**상시 가동 장비 지정 필수**" 미이행분을 해소한다.
>
> **접속정보·서버가 바뀔 때의 처리는 `변경관리.md` 를 본다.**

## 배치 근거 (2026-08-24 ERP 서버 실측)

| 조건 | 결과 |
|---|---|
| 항상 켜져 있음 | ✅ ERP 운영 서버 |
| ERP MSSQL 접근 | ✅ `JEILMNS_DEMO2` 가 같은 인스턴스 → `SERVER=localhost` |
| Supabase 아웃바운드 443 | ✅ `TcpTestSucceeded : True` |
| ODBC 드라이버 | ✅ `ODBC Driver 17 for SQL Server` (릴레이는 18→17 순 탐색) |
| Python | ❌ 미설치 → **EXE 방식으로 우회**(설치 불필요) |

---

# A안 — EXE 배포 (권장 · 기본)

서버에 **파이썬을 설치하지 않는다.** 벤더 운영 서버라 설치 흔적을 최소화한다.
파일 2개 + `.env` 만 두면 끝이다.

```
E:\ai.jeil\relay\
├─ gl_relay.exe          ← 릴레이 본체 (약 8MB)
├─ .env                  ← 접속정보 3키 · ACL 잠금 · OneDrive 경유 금지
├─ relay.cmd             ← 작업 스케줄러 진입점
└─ logs\relay_YYYYMM.log
```

> `.env` 는 **EXE와 같은 폴더**에 둔다. EXE는 실행 시 자기 자신이 놓인 폴더에서 찾는다
> (`_env.py:env_root()` — frozen 이면 `sys.executable` 기준).

## 0. 두 경로를 구분한다

| 구분 | 경로 | 성격 |
|---|---|---|
| **전달 폴더** | `E:\OneDrive - 제일엠앤에스\jeil_ax\relay\` | OneDrive 동기화. 워크스테이션에서 서버로 **파일을 옮기는 통로**. 여기서 실행하지 않는다 |
| **실행 루트** | `E:\ai.jeil\relay\` | 동기화 없음. 릴레이가 **실제로 도는 자리**. `.env` 도 여기 |

> 전달 폴더에서 직접 실행하면 안 되는 이유 — 작업 스케줄러를 "로그온 여부와 관계없이 실행"으로
> 걸면 OneDrive 클라이언트가 돌지 않는다. 파일 온디맨드 플레이스홀더 상태면 EXE 가 디스크에
> 없어 **조용히 실패**하고, 동기화 충돌 시 `gl_relay-서버명.exe` 같은 복사본이 생겨 어느 것이
> 도는지 모호해진다. 전달 폴더가 바뀌면 이 절과 §1 의 `$src` 만 고치면 된다.

---

## 1. 파일 배치

전달 폴더(OneDrive)에서 실행 루트로 **복사**한다.

```powershell
New-Item -ItemType Directory -Force E:\ai.jeil\relay\logs | Out-Null
$src = "E:\OneDrive - 제일엠앤에스\jeil_ax\relay"
Copy-Item "$src\gl_relay.exe","$src\deploy\relay.cmd" E:\ai.jeil\relay\
```

> **OneDrive 폴더에서 직접 실행하지 않는다.** 작업 스케줄러를 "로그온 여부와 관계없이 실행"으로
> 걸면 OneDrive 클라이언트가 돌지 않아, 파일 온디맨드 플레이스홀더 상태면 **조용히 실패**한다.
> OneDrive 는 파일을 서버로 옮기는 통로로만 쓴다.

## 2. `.env` 작성 — 서버에서 직접

`E:\ai.jeil\relay\.env` 에 키 3개. **OneDrive·메일을 거치지 않는다.**

```
SUPABASE_URL = ...
SUPABASE_SERVICE_ROLE_KEY = ...
ERP_DB_CONN = DRIVER={ODBC Driver 17 for SQL Server};SERVER=localhost;DATABASE=JEILMNS;UID=...;PWD=...;TrustServerCertificate=yes;
```

- `SUPABASE_*` 2개는 워크스테이션 `.env` 의 같은 키를 옮긴다.
- 워크스테이션의 `%USERPROFILE%\.erp\` DPAPI 저장소는 **계정·장비에 묶여 서버에서
  복호화되지 않는다.** 서버는 `ERP_DB_CONN` 경로만 동작한다.
- `DATABASE=JEILMNS` 로 둬도 된다 — 릴레이가 접속 시 `JEILMNS_DEMO2` 로 강제 치환하고,
  붙은 뒤 실제 DB명을 재확인해 다르면 **아무것도 실행하지 않고 중단**한다.

```powershell
icacls E:\ai.jeil\relay\.env /inheritance:r
icacls E:\ai.jeil\relay\.env /grant:r "Administrators:(R)" "SYSTEM:(R)"
```

## 3. 검증 — 작업 등록 **전에** 한다

```powershell
cd E:\ai.jeil\relay
.\gl_relay.exe --list                        # ① 대기 건 조회 (읽기 전용)
.\gl_relay.exe --draft <초안번호> --dry-run    # ② 리허설 — 전 과정 실행 후 ROLLBACK
.\gl_relay.exe --draft <초안번호>              # ③ 실건 1건, 소액으로
```

- ①이 대기 건을 보여주면 `.env`·ODBC·Supabase 연결이 전부 살아 있다는 뜻이다.
- ③에서 **AG 번호 채번 + 라인 완전일치**면 통과. 화면 [ERP 전송] 탭도 `applied` 로 바뀐다.

> ①②③ 을 건너뛰고 작업부터 등록하지 않는다. 대기 건이 쌓여 있으면 1분 안에 전부 나간다.

## 4. 작업 스케줄러 등록

```powershell
cd "E:\OneDrive - 제일엠앤에스\jeil_ax\relay\deploy"
.\register_task.ps1 -Account ADMIN
```

검증을 마쳤는지 되묻고, 비밀번호는 대화형으로만 받는다(명령 기록에 남기지 않는다).
1분 주기로 `relay.cmd` → `gl_relay.exe --queue --max 5` 가 돈다.

## 5. 확인

```powershell
Get-ScheduledTask JEIL_AX_GL_Relay | Get-ScheduledTaskInfo    # LastTaskResult 0 = 정상
Get-Content E:\ai.jeil\relay\logs\relay_$(Get-Date -Format yyyyMM).log -Tail 30
```

대기 건이 없을 때도 1분마다 로그가 한 줄씩 쌓이므로 살아 있는지 바로 보인다.

## 되돌리기

```powershell
.\register_task.ps1 -Remove
```

작업만 지우면 즉시 종전(수동 실행) 상태다. 파일은 남겨 둬도 무해하다.

---

# B안 — Python 설치 (대안)

EXE 를 쓸 수 없거나(백신 차단 등), 서버에서 코드를 직접 고쳐가며 쓰고 싶을 때.
ETL 러너(`etl_watch.py`)까지 같은 서버로 옮길 계획이면 이쪽이 낫다 — 의존 패키지가
`pyodbc` 로 동일해 추가 설치가 없다.

```powershell
.\install.ps1 -PythonInstaller .\python-3.12.10-amd64.exe
#  pypi 가 막혔으면 워크스테이션에서 휠을 받아:
#    python -m pip download pyodbc -d .\wheels --only-binary=:all:
.\install.ps1 -PythonInstaller .\python-3.12.10-amd64.exe -WheelDir E:\ai.jeil\relay\wheels
```

폴더 구조는 아래와 같다. `_env.py` 가 `.env` 를 **스크립트 기준 두 단계 위**에서 찾으므로
`pysrc\etl` 의 두 단계 위 = `E:\ai.jeil\relay` 이 되어 **`.env` 위치가 EXE 방식과 같아진다.**
배포 방식을 바꿔도 `.env` 는 그 자리에 그대로 둔다.

```
E:\ai.jeil\relay\
├─ .env                  ← EXE 방식과 같은 자리
├─ relay.cmd
├─ logs\
├─ python312\
└─ pysrc\etl\            ← gl_apply_demo2.py · _env.py · _erp_conn.py
```

`relay.cmd` 는 EXE 가 없으면 자동으로 이 경로를 쓴다 — 파일을 고칠 필요가 없다.

> **경로에 한글을 쓰지 않는다.** `relay.cmd` 는 cmd.exe 가 코드페이지 단위로 읽어 멀티바이트
> 문자가 있으면 파싱이 깨진다(2026-08-24 실측). 배치 파일과 그 안의 경로는 ASCII 로만 유지한다.

---

## EXE 빌드 (워크스테이션에서)

```powershell
python 10_ERP_DB연계\etl\deploy\build_exe.py
#   → 10_ERP_DB연계\etl\deploy\dist\gl_relay.exe
```

- **`.env` 는 번들에 들어가지 않는다.** 접속정보는 항상 실행 폴더의 `.env` 에서 읽는다.
- ODBC 드라이버는 번들 대상이 아니다 — 대상 서버의 시스템 구성요소를 쓴다.
- 빌드 PC와 서버가 같은 아키텍처여야 한다(둘 다 x64).
- 코드가 바뀌면 재빌드가 필요하다. 무엇이 재빌드를 부르는지는 `변경관리.md §5`.

---

## 안전장치 (코드에 이미 있는 것)

| 장치 | 내용 |
|---|---|
| 대상 DB 하드코딩 | `TARGET_DB = "JEILMNS_DEMO2"` — CLI 파라미터 없음. 운영(`JEILMNS`) 쓰기 불가(C-1) |
| 접속 후 재확인 | 붙은 DB명이 `JEILMNS_DEMO2` 가 아니면 아무것도 실행하지 않고 중단 |
| 선점 | `gl_apply_claim`(`FOR UPDATE SKIP LOCKED`) — 러너를 둘 띄워도 한 초안은 하나만 |
| 멱등 3중 | `A_BATCH.REF_NO` · `A_TEMP_GL.REF_NO` 선조회 + 포털 원장 유니크 |
| 완전대조 | 투입 후 `A_TEMP_GL` 되읽어 라인 1:1 비교, 불일치면 **ROLLBACK** |
| **서브원장** | 엔진 뒤에 `usp_a_create_temp_gl_subsys` 를 **같은 트랜잭션**에서 호출 — 채무(`A_OPEN_AP`)·부가세(`A_VAT`) 생성 + 연결번호(`SUBSYS_NO`) 역기록. 실패하거나 연결번호가 비면 전표 생성까지 **ROLLBACK** |
| 회수 | 죽은 러너가 `sending` 에 가둔 건을 30분 뒤 자동 반납(`gl_apply_reclaim`) |
| 처리 상한 | `--max 5` (1회) |
| 감사 | `gl_erp_apply_log` (mode·status·detail) |
| 마감월 | 제출 단계 Edge Function 이 `gl_period_lock` 으로 차단 |

## 알려진 한계 (자동화해도 남는 것)

1. **내용이 같은 별개 초안은 막지 못한다.** 멱등 방어는 *같은 초안번호* 기준(`REF_NO=draft_no`)이라
   같은 금액·적요를 두 번 올리면 ERP에 전표가 두 장 생긴다. 2026-08-24 큐에 실사례가 있었다
   (동일 적요·금액 2건 → 각각 다른 AG 번호로 정상 생성). 운영 전환 전 화면 중복 경고가 필요하다.
2. **되돌리기는 DEMO2 한정.** `--cleanup` 은 데모 DB에서만 쓸 수 있다.
3. **AX001 계정매핑(U-F)** 이 `A_JNL_ACCT_ASSN` 에 미등재. DEMO2 는 3단계 폴백으로 통과하지만
   개인경비 계정(`21100902`)처럼 폴백도 실패하는 케이스가 있다(2026-08-24 실측 1건).
   운영 전환 전 회계팀 등재가 필요하다.

## 다음 단계 (이 키트 범위 밖)

- ETL 러너(`etl_watch.py`)도 같은 서버로 옮기면 워크스테이션 의존이 완전히 사라진다.
  릴레이 안정 확인 후 별건으로 진행한다.
