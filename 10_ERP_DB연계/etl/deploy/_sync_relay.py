# -*- coding: utf-8 -*-
r"""_sync_relay.py — ERP 동기화 산출물을 **전달 폴더(relay)** 로 취합한다.

왜 필요한가
    ERP 연계는 경로가 셋이고, 그중 하나만 낡으면 조용히 틀린다.

        ① 저장소(정본)        10_ERP_DB연계/etl/            ← 코드·문서를 여기서 고친다
        ② 전달 폴더(relay)    사내 OneDrive jeil_ax/relay/  ← 서버로 건네는 창구(이 스크립트가 채운다)
        ③ 서버(실행)          E:\ai.jeil\relay\             ← 관리자가 ②에서 복사해 교체

    ②가 빠지면 서버는 **옛 EXE 를 계속 돌린다.** 실제로 그런 일이 있었다 —
    2026-09-11 릴레이 서버 v1.6 / 전달본 v1.7. 그래서 「빌드했다」와 「전달했다」를
    사람의 기억이 아니라 이 스크립트 한 줄로 묶는다.

    ⚠ EXE 안에는 `etl_run.py` 가 통째로 박힌다(PyInstaller onefile).
       ETL 추출 SQL 을 한 줄만 고쳐도 **재빌드 없이는 서버에 반영되지 않는다.**

사용
    python 10_ERP_DB연계/etl/deploy/build_exe.py      # ① 먼저 빌드(dist/jeil_runner.exe)
    python 10_ERP_DB연계/etl/deploy/_sync_relay.py    # ② 전달 폴더로 취합
    python ..._sync_relay.py --dry-run                # 무엇이 바뀌는지만 본다
    python ..._sync_relay.py --no-exe                 # 문서·SQL 만(빌드 안 했을 때)

무엇을 옮기는가
    jeil_runner.exe        : 통합 러너 본체 — 서버에 두는 **유일한 실행 파일**(CLAUDE.md §17.1)
    deploy/                : README·변경관리·install.ps1·register_runner_task.ps1·relay.cmd
    sql/                   : ERP 원천 조사·점검 쿼리(읽기 전용) — 서버에서 바로 붙여 쓴다
    README_전달폴더.md     : 이 폴더가 무엇인지, 서버에 어떻게 올리는지(이 스크립트가 생성)

무엇을 옮기지 않는가
    .env                   : 접속정보. **OneDrive 를 경유시키지 않는다**(CLAUDE.md §1.1)
    logs/ · runner_*.json  : 서버가 쓰는 실행 상태 — 반대 방향이다(서버 → 여기)
    pysrc/                 : 통합 EXE 이전의 소스 사본. 새로 올리지 않는다

경로
    전달 폴더 위치는 저장소에 적지 않는다(CLAUDE.md §1.3) — `.claude/erp_relay.path` 에서 읽는다.
    `--out <경로>` 로 덮어쓸 수 있다.
"""
import argparse
import hashlib
import os
import shutil
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ETL = os.path.abspath(os.path.join(HERE, ".."))
REPO = os.path.abspath(os.path.join(ETL, "..", ".."))
PATH_FILE = os.path.join(REPO, ".claude", "erp_relay.path")

# 전달 폴더로 보낼 것 — (원본 상대경로, 대상 상대경로)
DOCS = [
    (os.path.join(HERE, "README.md"), "deploy/README.md"),
    (os.path.join(HERE, "변경관리.md"), "deploy/변경관리.md"),
    (os.path.join(HERE, "install.ps1"), "deploy/install.ps1"),
    (os.path.join(HERE, "register_runner_task.ps1"), "deploy/register_runner_task.ps1"),
    (os.path.join(HERE, "register_task.ps1"), "deploy/register_task.ps1"),
    (os.path.join(HERE, "relay.cmd"), "deploy/relay.cmd"),
]
SQL_DIR = os.path.join(ETL, "sql")          # ERP 조사·점검 쿼리(읽기 전용)
EXE_SRC = os.path.join(HERE, "dist", "jeil_runner.exe")


def relay_root(override=None):
    if override:
        return override
    if not os.path.exists(PATH_FILE):
        sys.exit(
            "전달 폴더 경로를 모른다 — .claude/erp_relay.path 가 없다.\n"
            "  그 파일에 전달 폴더(사내 OneDrive jeil_ax/relay) 절대경로를 한 줄로 적는다.\n"
            "  (저장소에는 경로를 적지 않는다 — CLAUDE.md §1.3)"
        )
    root = open(PATH_FILE, encoding="utf-8").read().strip()
    if not os.path.isdir(root):
        sys.exit("전달 폴더가 없다: %s" % root)
    return root


def sha(path, n=12):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for blk in iter(lambda: f.read(1 << 20), b""):
            h.update(blk)
    return h.hexdigest()[:n]


def runner_version():
    """러너 버전(rX.Y)을 runner_core.py 에서 읽는다 — 버전 사본 이름에 쓴다."""
    src = open(os.path.join(ETL, "runner_core.py"), encoding="utf-8").read()
    for line in src.splitlines():
        if line.startswith("RUNNER_VERSION"):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return "r?"


def copy(src, dst, dry):
    if not os.path.exists(src):
        print("  (없음, 건너뜀) %s" % os.path.relpath(src, REPO))
        return False
    same = os.path.exists(dst) and sha(src) == sha(dst)
    mark = "=" if same else ("+" if not os.path.exists(dst) else "~")
    print("  %s %s" % (mark, os.path.relpath(dst, os.path.dirname(dst)) if False else dst))
    if same or dry:
        return not same
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    return True


def main():
    ap = argparse.ArgumentParser(description="ERP 동기화 산출물을 전달 폴더로 취합")
    ap.add_argument("--out", help="전달 폴더 경로(기본: .claude/erp_relay.path)")
    ap.add_argument("--dry-run", action="store_true", help="바뀔 것만 보여 주고 복사하지 않는다")
    ap.add_argument("--no-exe", action="store_true", help="EXE 는 건너뛴다(문서·SQL 만)")
    a = ap.parse_args()

    root = relay_root(a.out)
    ver = runner_version()
    today = datetime.now().strftime("%Y%m%d")
    print("전달 폴더: %s" % root)
    print("러너 버전: %s · 기준일 %s%s" % (ver, today, "  (dry-run)" if a.dry_run else ""))

    changed = 0

    # 1) 실행 파일 — 버전 사본을 남기고 본체를 교체한다(서버가 뭘 돌리는지 되짚을 수 있게)
    if not a.no_exe:
        print("\n[EXE]")
        if not os.path.exists(EXE_SRC):
            print("  빌드 산출물이 없다 — 먼저 `python deploy/build_exe.py` 를 돌린다.")
            print("  (문서·SQL 만 보내려면 --no-exe)")
            return 2
        keep = os.path.join(root, "jeil_runner.%s-%s.exe" % (ver.replace(".", ""), today))
        changed += int(copy(EXE_SRC, keep, a.dry_run))          # 버전 사본
        changed += int(copy(EXE_SRC, os.path.join(root, "jeil_runner.exe"), a.dry_run))  # 본체

    # 2) 배포 문서
    print("\n[배포 문서]")
    for src, rel in DOCS:
        changed += int(copy(src, os.path.join(root, rel.replace("/", os.sep)), a.dry_run))

    # 3) ERP 조사·점검 SQL (읽기 전용)
    print("\n[조사·점검 SQL]")
    if os.path.isdir(SQL_DIR):
        for fn in sorted(os.listdir(SQL_DIR)):
            if fn.lower().endswith(".sql"):
                changed += int(copy(os.path.join(SQL_DIR, fn), os.path.join(root, "sql", fn), a.dry_run))
    else:
        print("  (etl/sql 없음)")

    # 4) 전달 폴더 안내문 — 이 폴더가 무엇인지 폴더 안에서도 알 수 있게
    print("\n[안내문]")
    guide = os.path.join(root, "README_전달폴더.md")
    body = GUIDE.format(ver=ver, today=datetime.now().strftime("%Y-%m-%d"))
    old = open(guide, encoding="utf-8").read() if os.path.exists(guide) else None
    if old == body:
        print("  = %s" % guide)
    else:
        print("  %s %s" % ("+" if old is None else "~", guide))
        if not a.dry_run:
            open(guide, "w", encoding="utf-8").write(body)
        changed += 1

    print("\n바뀐 항목: %d개%s" % (changed, " (dry-run — 실제로는 쓰지 않았다)" if a.dry_run else ""))
    if changed and not a.dry_run:
        print("\n다음: 관리자가 전달 폴더에서 서버(E:\\ai.jeil\\relay\\)로 jeil_runner.exe 를 교체한다.")
        print("      교체 전 서버의 러너를 멈추고(트레이 종료), 교체 후 다시 켠다.")
    return 0


GUIDE = """# 전달 폴더 (jeil_ax/relay) — ERP 연동 산출물 창구

> 이 폴더는 **저장소에서 서버로 건네는 창구**다. 여기서 직접 고치지 않는다.
> 정본은 저장소 `10_ERP_DB연계/etl/` 이고, 이 폴더는
> `python 10_ERP_DB연계/etl/deploy/_sync_relay.py` 가 채운다.
>
> 최종 동기화: {today} · 러너 **{ver}**

## 경로 셋을 구분한다

| | 경로 | 성격 |
|---|---|---|
| ① 정본 | 저장소 `10_ERP_DB연계/etl/` | 코드·문서를 **여기서만** 고친다 |
| ② 전달 | 이 폴더 | 서버로 건네는 창구. `_sync_relay.py` 가 채운다 |
| ③ 실행 | 서버 `E:\\ai.jeil\\relay\\` | 관리자가 ②에서 복사해 교체 |

②가 빠지면 서버는 **옛 EXE 를 계속 돌린다.** 2026-09-11 에 실제로 그랬다(서버 v1.6 / 전달본 v1.7).

## 이 폴더의 것들

| 파일 | 설명 |
|---|---|
| `jeil_runner.exe` | 통합 러너 — 서버에 두는 **유일한 실행 파일**. 릴레이·ETL·퇴사 CLI 가 이 안에 있다 |
| `jeil_runner.rXX-YYYYMMDD.exe` | 버전 사본(되짚기용). 서버에는 올리지 않는다 |
| `deploy/` | 설치·스케줄 등록 스크립트와 런북(README·변경관리) |
| `sql/` | ERP 원천 조사·점검 쿼리 — **읽기 전용**. 서버에서 바로 붙여 쓴다 |
| `runner_config.json` · `runner_history.jsonl` · `logs/` | **서버가 쓰는 것**. 반대 방향(서버 → 여기)이라 동기화 대상이 아니다 |

## 서버에 올리는 순서

1. 서버 트레이 러너를 멈춘다(아이콘 → 종료).
2. 이 폴더의 `jeil_runner.exe` 를 서버 `E:\\ai.jeil\\relay\\` 로 복사(덮어쓰기).
3. 러너를 다시 켠다. `jeil_runner.exe tools` 로 버전을 확인한다.
4. ETL 추출이 바뀐 배포라면 **신규 컬럼 백필**을 1회 돌린다:
   `jeil_runner.exe etl --job <job> --full`
   (증분은 `UPDT_DT >= watermark` 변경분만 읽어 기존 행을 채우지 않는다)

## 하지 않는 것

- `.env`(접속정보)는 **이 폴더에 두지 않는다.** 서버에서 직접 만든다(CLAUDE.md §1.1).
- 이 폴더의 파일을 손으로 고치지 않는다 — 다음 동기화에서 덮어써진다.

## 낡은 것 (정본이 저장소에 없어 동기화 대상이 아니다)

- `서버설치안내_jeil_runner_r1.3.txt` — **r1.3 시점** 안내다. 최신 절차는 `deploy/README.md §0`.
- `pysrc/` — 통합 EXE 이전(2026-08) 소스 사본. 지금은 쓰지 않는다.
- `gl_relay.exe` · `jeil_runner.r1x-*.exe` — 옛 배포본·버전 사본. 서버에는 `jeil_runner.exe` 하나만 올린다.
"""


if __name__ == "__main__":
    sys.exit(main())
