# jeil-nas-worker — 적재 워커를 NAS 컨테이너로 옮기기

> REQ-0102 · ADR-110 v3 · 워커 n1.2 · 대상: Synology Container Manager
> 이 문서에는 NAS 주소·공유 경로·계정·토큰 값을 적지 않는다(CLAUDE.md §1.1). 값은 NAS 의 `.env` 에만 둔다.

## 무엇이 달라지는가

| | 지금(사내 PC 예약작업) | 옮긴 뒤(NAS 컨테이너) |
|---|---|---|
| 도는 곳 | 관리자 PC — 꺼져 있거나 로그아웃이면 멈춘다 | NAS — 항상 켜져 있다 |
| NAS 에 쓰는 길 | 네트워크 공유(SMB) | 같은 장비 안의 폴더(바인드 마운트) |
| 가진 키 | DB 전체 권한 키(service_role) | **NAS 적재용 기능 8개만 부를 수 있는 전용 토큰** |
| 열린 포트 | 없음 | 없음 |

## 0. 먼저 정리할 것 — PoC 컨테이너(D-98)

Container Manager 의 프로젝트 `jeil-agent`(PoC)는 **인증 없는 포트 8765** 를 열고 메모리 상한 4GB 를 쥐고 있다.
새 워커는 포트가 필요 없다. 프로젝트를 **중지 → 삭제**한다(`itasset` 프로젝트는 건드리지 않는다).

## 1. 파일 놓기

NAS 의 Container Manager 프로젝트 폴더(예: `docker/jeil-nas-worker`)에 아래 6개를 둔다.

| 파일 | 어디서 |
|---|---|
| `Dockerfile` · `compose.yaml` | 이 폴더 |
| `nas_worker.py` · `nas_index.py` · `_env.py` | 저장소 `10_ERP_DB연계/etl/` |
| `.env` | `.env.example` 을 복사해 값을 채운 것 |

- **줄 끝은 LF, 인코딩은 BOM 없는 UTF-8.** Windows 에서 만든 파일이 CRLF 면 Dockerfile·`.env` 가 오동작한다.
  이 폴더는 저장소에서 LF 로 고정돼 있다(`.gitattributes`). `.env` 는 직접 만들므로 편집기에서 LF 로 저장한다.
- `.env` 는 공유 폴더에 평문으로 놓인다 → 프로젝트 폴더 권한을 관리자 전용으로 둔다.

## 2. `.env` 채우기

| 키 | 값 |
|---|---|
| `NAS_BRIDGE_URL` | 중계 함수 주소(포털 Supabase 프로젝트의 `…/functions/v1/jeil-nas-bridge`) |
| `NAS_WORKER_TOKEN` | 발급한 PC 의 `.claude/nas_worker.token` 한 줄 |
| `NAS_HOST_DATA_DIR` | 적재 폴더의 NAS 내부 경로(File Station → 폴더 속성 → 위치) |
| `NAS_HOST_DOCS_DIR` | 문서 폴더(부서 폴더·전사공유 폴더의 **상위**)의 NAS 내부 경로 — 읽기 전용으로 연결된다. 에이전트의 파일 목록 조회가 여기를 본다 |
| `NAS_RUN_UID` · `NAS_RUN_GID` | 그 폴더에 쓸 수 있는 계정 번호(SSH 에서 `id <계정>`) |

적재 폴더는 지금 PC 가 쓰고 있는 **같은 폴더**를 가리켜야 한다(안에 `대화기록/`·`ERP스냅샷/`·`_manifest/` 가 보이는 곳).

## 3. 빌드·기동

Container Manager → 프로젝트 → 생성 → 경로에 위 폴더 지정(`compose.yaml` 자동 인식) → 빌드 → 시작.
`.env` 를 고쳤으면 **재시작이 아니라 다시 빌드(재생성)** 해야 반영된다.

### 3.1 네트워크 — 전용 네트워크를 만들지 않는다(2026-10-02 장애)

`compose.yaml` 의 `network_mode: bridge` 를 **지우지 않는다.** 이 줄이 없으면 Docker 가 프로젝트 전용 네트워크
`jeil-nas-worker_default` 를 새로 만들고 172.17~172.31 대역을 차례로 배정한다. 실제로 172.20.0.0/16 이 배정돼
**서울사무소 내부망과 겹쳤고**, NAS 가 서울 PC 로 보낼 응답을 컨테이너 쪽으로 보내 서울에서 NAS 접속(DSM·공유폴더)이 통째로 끊겼다.
이 워커는 포트를 열지 않고 밖으로만 나가므로 이미 있는 기본 브리지(docker0)면 충분하다.

빌드 뒤 **Container Manager → 네트워크** 에 `jeil-nas-worker_default` 가 **없어야** 한다.
옛 `compose.yaml` 로 한 번이라도 띄웠다면 그 네트워크가 남아 있다 — §8 순서로 지운다.

## 4. 확인(순서대로)

1. **로그** — 컨테이너 로그 첫 줄에 `NAS 워커 상주 시작 — n1.2 · host=jeil-nas-worker · 전송 bridge`.
2. **밖으로 나가는지** — 이어서 `하루 1회 적재 시작` 또는 `대기 요청 없음` 이 찍힌다.
   `HTTP 401` 이면 토큰 값, `URLError`·시간 초과면 NAS 의 나가는 HTTPS(프록시·SSL 검사·목적지 제한)를 본다.
3. **쓰기 권한** — `NAS 루트 폴더가 없거나 접근할 수 없습니다` 또는 `PermissionError` 면 `NAS_HOST_DATA_DIR`·UID 를 본다.
4. **한글 폴더 이름** — 적재 뒤 File Station 에서 `대화기록`·`ERP스냅샷` 이 **기존 폴더에 이어서** 쌓였는지 본다
   (깨진 이름의 새 폴더가 생겼으면 중지하고 알린다).
5. **심박** — 포털 DB `etl_meta.nas_heartbeat` 에 `jeil-nas-worker` 행이 3분 안쪽으로 갱신된다.

6. **조회 응답** — 로그 첫 줄에 `조회 응답 켬` 이 붙는다. 에이전트가 파일 목록·과거 대화를 물으면 `조회 …… file_list — N건 · NNNms` 가 찍힌다.
   에이전트가 볼 수 있는 폴더는 DB 의 허용 폴더 목록(`etl_meta.nas_folder_scope`)에 **등록한 것만**이다 — 등록이 없으면 전부 거부된다.

7. **문서 색인** — 기동 직후와 10분마다 허용 폴더를 훑어 바뀐 파일만 다시 색인한다. 로그에 `문서 색인 갱신 — 파일 N개(색인 n · 제외 m)`.
   색인 파일은 컨테이너 전용 볼륨(`/state/index/`)에 있다 — NAS 밖으로 나가지 않는다. 이미지 빌드 때 `pypdf` 를 내려받으므로
   **NAS 에서 PyPI(pypi.org)로 나가는 HTTPS** 가 필요하다(막혀 있으면 빌드가 실패한다 — PDF 를 빼려면 Dockerfile 의 `RUN pip …` 줄을 지운다).

## 5. 전환 — PC 예약작업 끄기

컨테이너가 **3일 연속** 적재에 성공한 것을 확인한 뒤, 관리자 PC 에서:

```powershell
.\10_ERP_DB연계\etl\deploy\register_nas_task.ps1 -Remove
```

그 전까지 둘이 함께 돌아도 안전하다 — 「어디까지 가져갔는지」 표시를 DB 가 하나로 갖고 있어 대화기록이 겹치지 않고,
ERP 스냅샷은 같은 날짜 파일을 덮어쓴다.

## 6. 되돌리기 · 차단

- **되돌리기**: 컨테이너 프로젝트 중지 → PC 에서 `register_nas_task.ps1` 다시 등록. 쌓인 파일·표시는 그대로 이어진다.
- **토큰 차단(유출 의심)**: DB 에서 `etl_meta.nas_worker_token` 의 해당 행 `active=false` — 즉시 모든 호출이 401.
- **토큰 회전**: 새 토큰 발급(해시 insert) → `.env` 교체 → 재빌드 → 옛 행 `active=false`.

## 7. 워커를 고쳤을 때

`nas_worker.py`·`nas_index.py`·`_env.py` 를 NAS 프로젝트 폴더에 다시 놓고 **재빌드**한다. EXE 재빌드·ERP 서버 교체는 필요 없다(이 워커는 서버에서 돌지 않는다).
중계 함수의 허용 목록(`jeil-nas-bridge/index.ts` 의 `ALLOWED`)과 워커의 `BRIDGE_FNS` 는 **같은 목록**이어야 한다 — 한쪽만 고치지 않는다.

## 8. 서울에서 NAS 접속이 끊겼을 때 — 겹친 네트워크 지우기

증상: 서울사무소 PC 에서만 DSM·공유폴더가 전 포트 무응답(다른 대역 PC 는 정상). 원인은 §3.1.
**서울 대역 PC 로는 NAS 에 못 들어간다** — 겹치지 않는 대역의 PC(또는 NAS 와 같은 대역)에서 DSM 에 접속해 작업한다.

1. Container Manager → 프로젝트 → `jeil-nas-worker` → **중지**.
   (컨테이너만 멈춰서는 풀리지 않는다 — 네트워크가 남아 있는 한 경로가 그대로다.)
2. 프로젝트 폴더의 `compose.yaml` 을 이 폴더의 것으로 **교체**한다(`network_mode: bridge` 줄이 있는 것 · LF 유지).
   다른 파일(`.env`·`Dockerfile`·`*.py`)은 건드리지 않는다.
3. 프로젝트 → 작업 → **정리(Clean)** — 컨테이너와 전용 네트워크가 함께 지워진다.
   상태 볼륨(`state` — 색인·완료 표시)은 정리로 지워지지 않는다. 볼륨 삭제를 묻는 창이 뜨면 **삭제하지 않는다.**
4. Container Manager → **네트워크** 에 `jeil-nas-worker_default` 가 남아 있으면 선택해 **삭제**한다.
   → 이 시점에 서울 PC 접속이 돌아온다.
5. 프로젝트 → **빌드** → 시작. 네트워크 목록에 `jeil-nas-worker_default` 가 다시 생기지 않았는지 본다.
6. §4 의 로그·심박을 확인한다. 색인은 볼륨에 남아 있어 처음부터 다시 만들지 않는다.

`itasset` 등 다른 프로젝트의 네트워크는 건드리지 않는다. 다만 같은 표에서 **다른 프로젝트의 서브넷이 사내 다른 대역과 겹치지 않는지** 한 번 훑어본다.
