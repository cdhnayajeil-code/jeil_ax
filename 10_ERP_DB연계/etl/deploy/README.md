# 결의전표 ERP 전송 릴레이 — ERP 서버 배포 키트

> 화면에서 [🚀 ERP 전송]을 누르면 **사람 개입 없이 ERP에 반영**되게 하는 상시 러너를 세운다.
> 지금까지는 관리자가 스크립트를 손으로 돌려야 했고, 안 돌리면 전송대기로 계속 쌓였다
> (2026-08-24 실측: 마지막 수동 실행 08-20 이후 4건 적체 — 실패가 아니라 미시도).
> 기획서 `03_중간DB_구축실행기획 §D2-a` 의 "**상시 가동 장비 지정 필수**" 미이행분을 해소한다.
>
> **접속정보·서버가 바뀔 때의 처리는 `변경관리.md` 를 본다.** 트레이 러너(창에서 켜고 끄는 방식)는 **C안** 을 본다.

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

> **2026-09-18 — EXE 는 하나로 합쳐졌다.** 릴레이는 `jeil_runner.exe relay …` 서브커맨드가 됐다.
> 옛 `gl_relay.exe` 도 당분간 그대로 동작하지만(relay.cmd 가 있으면 쓴다), 새로 올릴 때는
> `jeil_runner.exe` 하나만 둔다. 파일이 둘이면 한쪽만 낡는 일이 실제로 생겼다(09-11 v1.6/v1.7).

```
E:\ai.jeil\relay\
├─ jeil_runner.exe       ← 통합 러너 본체 (약 18MB · 릴레이 CLI 포함)
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

# C안 — 트레이 스케줄 러너 `jeil_runner.exe` (2026-09-11 신설 · REQ-0046 · r1.2)

> A안(EXE + 작업 스케줄러)은 **보이지 않아서** 등록이 보류됐다(08-24). ERP 벤더의 Schedule Runner 처럼
> **오른쪽 아래 트레이 아이콘 + 창**으로 작업 목록·실행 중 출력·실행 내역을 보고, 손으로 켜고 끄고,
> 연동 기준(주기·시각·포함 항목)을 바꾸는 상주 앱이다. 릴레이(A안)와 **같은 폴더·같은 `.env`** 를 쓴다.

## C-0. 무엇을 돌리나

| 작업 ID | 하는 일 | 실체 | 기본 |
|---|---|---|---|
| `relay_queue` | 화면 [ERP 전송] 대기 건을 ERP(DEMO2)에 투입 | `jeil_runner.exe relay --queue --max 5` 와 동일 | 60초 반복 · 사용 |
| `etl_sync` | 화면 [데이터 업데이트] 요청을 집어 ERP→중간DB 적재 | `etl_watch --once` 와 동일(이 호스트가 할 수 있는 범위만) | 60초 반복 · 사용 |
| `etl_nightly` | 정해진 시각에 ERP job 전체(또는 선택) 적재 | `etl_run` | 매일 02:00 · **해제**(관리자가 켠다) |

- 작업은 러너가 **자기 자신을 자식 프로세스**로 띄워 돌린다. 한 작업이 죽어도 러너·다른 작업은 산다.
- **[중지]·러너 종료 = 프로세스 트리째 종료**(Windows 작업 개체). 러너가 작업 관리자로 강제 종료돼도 자식이 함께 끝난다.
- **작업마다 시간 상한**(기본 릴레이 30분 · 요청 처리 120분 · 배치 240분). 넘기면 트리째 끝내고 「실패(시간 초과)」로 남긴다 — 자식이 멈춰 그 종류가 영영 막히지 않게.
- 러너가 로그오프·재부팅·강제 종료로 사라지면, 다음 기동 때 끊긴 실행을 「중지됨(러너 비정상 종료)」으로 내역에 남긴다(`runner_running.json`).
- **이 PC 에 러너는 하나만** — 루트 잠금 파일 + 전역 뮤텍스. 다른 관리자 세션(RDP)에서 또 띄우면 「이미 실행 중」으로 끝난다.
- 출력은 `logs\runner\runs\<작업>\<시각>.log` 에 남고 창이 그 파일을 보여준다. 내역은 `runner_history.jsonl`.
- **할 일이 없던 회차**(「전송 대기 건이 없습니다」·「대기 요청 없음」)는 로그를 작업별 **마지막 1개만** 남기고,
  [실행 내역] 에서 기본으로 숨긴다(체크 해제하면 보인다). 60초 주기라 그대로 두면 하루 2,880개가 쌓인다.
- 같은 종류(etl) 작업은 동시에 돌지 않는다. 배치가 도는 동안 요청 처리는 쉬고, 배치가 러너 심박을 대신 남긴다.
- 일시정지 중 놓친 **매일** 작업은 재개할 때 돌리지 않고 다음 정시로 넘긴다.
- 설정 파일이 깨지거나 쓸 수 있는 작업이 하나도 없으면 원본을 `.bad-`/`.bak-<시각>` 으로 보존하고 **기본 작업을 꺼진 상태·일시정지**로 띄운다(창에 경고).
  [연동 기준] 에서 작업을 모두 지우고 저장하면 작업 없음 그대로다 — 되살리려면 「기본 작업 복원」.

### 이 호스트가 못 하는 일 — 조용히 빼지 않는다

| 항목 | 서버 러너 동작 | 요청 결과 |
|---|---|---|
| 퇴사 처리(브라우저 자동화) | Playwright·그룹웨어 접속정보가 없으면 **퇴사 큐를 선점조차 하지 않는다**. 설정으로도 켤 수 없다(능력이 상한) | 관리자 PC 러너가 처리 |
| 계정 수집(MS·그룹웨어) | `.env` 의 `ENTRA_*` / `.env.local` 의 `GW_DB_*` 가 없으면 생략 | **일부 실패** — 「생략 2종(러너 …에서 불가)」 사유가 데이터 업데이트 화면에 그대로 뜬다(ERP 데이터는 적재됨) · 계정만 요청한 건은 처리 불가로 실패 |
| 급여(erp_secure) 포함 요청 | 기본 **처리 안 함**([연동 기준] 「급여(민감) 포함 요청도 처리」로 켬) | 생략했으면 **실패** |
| 접속 오류 원문 | 요청 결과·오류문에 남기기 전에 계정명·서버·IP·UID/PWD 를 `***` 로 가린다 | — |

> **두 러너를 제대로 나눠 쓰려면 DB 보강이 필요하다(SQL 49 · 승인 대기).** 지금은 먼저 온 러너가 요청을 집고,
> 퇴사·계정 화면의 「러너 가동」은 아무 러너나 심박이 있으면 참이다. 그래서 서버 러너만 켜져 있어도 「곧 집어갑니다」로 안내하고,
> 관리자 PC 러너가 켜져 있어도 서버가 기본 요청을 먼저 집으면 계정 수집이 빠진다.
> `실제구축준비 자료/이관/sql/49_runner_capability_online.sql` 을 적용하면 러너 심박 메모(`+acctK`·`+offboard`·`+nosens`)로
>  · 계정 전용 요청 → 계정 수집 러너만 · 급여 포함 → 급여 처리 러너만 · 기본 요청 → 계정 수집 러너가 켜져 있으면 그쪽 우선
>  · 계정 새로고침은 계정 수집 러너가 없으면 요청을 넣지 않고 안내 · 처리할 러너가 30분 넘게 없으면 사유와 함께 만료
> 로 가른다. 관리자 PC 의 옛 `etl_watch.py` 는 재시작 없이 호환된다(부정형 표식). 되돌리기는 같은 폴더 `49_..._rollback.sql`.

## C-1. 서버 요건 (A안과 같음 + ETL 읽기)

- A안 §0 표 그대로(ODBC 17·Supabase 443·x64). 파이썬 불필요.
- `.env` 의 `ERP_DB_CONN` 계정이 **운영 `JEILMNS` 를 SELECT** 할 수 있어야 ETL 이 돈다(릴레이는 DEMO2 쓰기만 필요했다).
- **권한 점검(실제 요청을 건드리지 않는 방법):** [연동 기준] → `+ 배치 작업 추가` → 대상 job 에서 `dept_master` 하나만 선택 →
  「리허설(dry-run)」 체크 → [저장] → 목록에서 그 작업 선택 → [지금 실행]. 실행 내용에 추출 건수가 나오면 SELECT 권한이 있다.
  (`etl_sync` 에는 리허설이 없다 — 리허설로 실제 요청을 집어 「완료·적재 0건」으로 닫아 버리기 때문이다)

## C-2. 파일 배치 · 폴더 잠금

```
E:\ai.jeil\relay\
├─ jeil_runner.exe       ← **통합 러너 — 서버에 두는 파일은 이것 하나**(약 18MB)
│                          트레이 스케줄러 + 딸린 CLI(relay·sync·etl·offboard·mailbox)
├─ .env                  ← 공용. 키는 §2 와 같다
├─ runner_config.json    ← 연동 기준(창에서 저장). 첫 실행 때 자동 생성
├─ runner_history.jsonl  ← 실행 내역(append)
└─ logs\runner\           ← runner_YYYYMM.log · runs\<작업>\<시각>.log · smoke_last.log
```

```powershell
# 관리자 권한 PowerShell
$src = "E:\OneDrive - 제일엠앤에스\jeil_ax\relay"
Copy-Item "$src\jeil_runner.exe" E:\ai.jeil\relay\
# 폴더 잠금 — 러너는 상승 권한으로 돌므로, 일반 사용자가 EXE·설정·내역을 바꿀 수 없어야 한다
icacls E:\ai.jeil\relay /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F"
```

- `*S-1-5-32-544` = Administrators, `*S-1-5-18` = SYSTEM(로케일과 무관하게 SID 로 준다). `.env` 는 §2 에서 이미 따로 잠겨 그대로 유지된다.
- **상위 폴더도 본다.** `E:\ai.jeil` 처럼 상위 폴더에 일반 사용자 수정(삭제) 권한이 있으면, 폴더째 이름을 바꿔 가짜 `relay` 를 끼워 넣을 수 있다.
  `register_runner_task.ps1 -CheckOnly` 로 루트·안의 파일·상위 폴더 권한을 한 번에 점검한다(허용: Administrators·SYSTEM·TrustedInstaller·등록하는 관리자 본인).
- 잠근 뒤에는 이 폴더의 명령(`jeil_runner.exe`, `gl_relay.exe --list` 등)을 **관리자 권한 PowerShell 에서만** 실행할 수 있다.

## C-3. 점검 → 실행 (관리자 권한 PowerShell)

```powershell
cd E:\ai.jeil\relay
.\jeil_runner.exe --smoke                    # ① 자체 점검 → logs\runner\smoke_last.log 끝줄 "통과"
.\jeil_runner.exe                            # ② 트레이 앱 시작 — 오른쪽 아래 아이콘 + 창
```

- ① 은 임시 폴더에서 **더미 작업만** 돌린다(실제 릴레이·ETL 무실행): 창·트레이 생성 → 더미 성공 → [중지] 가 프로세스 트리를 끝내는지 → `.env` 를 읽을 수 있는지.
  「.env 읽기 권한 없음」이면 관리자 권한으로 다시 실행한다.
- ② 를 띄우면 `relay_queue`·`etl_sync` 가 3초·6초 뒤 첫 회차를 돌고 이후 60초마다 반복한다.
- 창을 닫으면 트레이로 내려가고 계속 돈다. **종료는 트레이 아이콘 우클릭 → 종료**(실행 중인 작업이 있으면 확인창이 뜬다).

| 창 | 용도 |
|---|---|
| 위 표 | 상태(대기·실행중·사용안함·일시정지) · 다음 실행 · 최근 시작/종료 · 결과 · 실행 횟수 · 평균 초. 더블클릭 = 지금 실행 |
| [실행 내용] | 선택한 작업의 **돌고 있는/마지막** 출력(자동 스크롤) · [파일 열기](메모장) |
| [실행 내역] | 최근 300건 — 시작·작업·결과·소요·요약. 「할 일 없던 회차 숨기기」 기본 켜짐. 더블클릭 = 그 실행의 로그 |
| [연동 기준] | 사용/주기(초)/시각(HH:MM)/로그 저장, 릴레이 상한, 계정 수집·퇴사 처리(자동/제외), 전량 재적재, 급여 요청 처리, 배치 대상 job·리허설, 로그 보관일 → [저장(적용)]. 이 호스트가 못 하는 일은 ⚠ 로 표시 |

트레이 아이콘 색: 회색 = 대기 · 초록 = 실행 중 · 주황 = 전체 일시정지 · 빨강 = 마지막 실행 실패 있음.

## C-4. 로그온 시 자동 시작(선택)

```powershell
# 관리자 권한 PowerShell
cd "E:\OneDrive - 제일엠앤에스\jeil_ax\relay\deploy"
.\register_runner_task.ps1            # 현재 계정 로그온 시 jeil_runner.exe 자동 시작(비밀번호 불필요)
.\register_runner_task.ps1 -Remove    # 해제
```

- 등록 전에 실행 루트·안의 파일·상위 폴더 권한을 **허용 목록**으로 점검하고, 걸리면 **등록하지 않는다**(C-2 잠금 먼저). `-CheckOnly` 는 점검만.
- 러너는 **로그인 세션 안에서만** 산다. RDP 는 「연결 끊기」로 나가고 **로그오프하지 않는다.**
  로그오프·재부팅 뒤에는 다시 로그인해야 뜬다(위 작업을 등록해 두면 자동). 서비스화는 별건.

## C-5. 되돌리기

트레이 → 종료(또는 작업 관리자에서 `jeil_runner.exe` 종료 — 돌던 작업도 함께 끝나고, 다음 기동 때 「중지됨(비정상 종료)」으로 기록된다). 파일을 지우지 않아도 A안(relay.cmd)은 그대로 쓸 수 있다.
관리자 PC 의 `etl_watch.py` 도 그대로 — 둘이 동시에 켜져도 큐 **선점(claim)** 으로 같은 요청을 두 번 처리하지 않는다.

## C-6. 빌드 (워크스테이션)

```powershell
python -m pip install pystray pillow pyinstaller        # 최초 1회
python 10_ERP_DB연계\etl\deploy\build_exe.py
#   → 10_ERP_DB연계\etl\deploy\dist\jeil_runner.exe   (이 파일 하나가 전부다)

# 빌드 전 회귀(실제 릴레이·ETL·퇴사 무실행)
cd 10_ERP_DB연계\etl
python -m unittest test_runner_core test_runner_cli test_offboard_axes
```

러너에 딸린 것 중 **무엇이 바뀌든 이 EXE 하나만 다시 만든다** —
`gl_apply_demo2.py`·`etl_watch.py`·`etl_run.py`·수집기·`offboard_axes.py`·`exo_admin.py`·`_env.py`·`runner_*.py`.

### 서버에서 손으로 점검할 때 (딸린 CLI)

```powershell
jeil_runner.exe tools                    # 목록
jeil_runner.exe relay --list             # 전송 대기 건(구 gl_relay.exe --list)
jeil_runner.exe relay --queue --max 5
jeil_runner.exe sync --once              # 화면 요청 1건 처리
jeil_runner.exe etl --job dept_master --dry-run
jeil_runner.exe offboard -e <메일> -a ms  # 퇴사 3축 점검(기본 dry-run)
jeil_runner.exe mailbox -e <메일>         # 사서함 공유 전환 점검
```

EXE 는 **console** 로 빌드돼 위 출력이 그대로 보인다. 인자 없이 실행하면 트레이 앱으로 뜨며
그때는 콘솔 창을 스스로 감춘다(`jeil_runner.hide_console()`).

---

## EXE 빌드 (워크스테이션에서)

```powershell
python 10_ERP_DB연계\etl\deploy\build_exe.py
#   → 10_ERP_DB연계\etl\deploy\dist\jeil_runner.exe   (릴레이는 `relay` 서브커맨드로 들어 있다)
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
