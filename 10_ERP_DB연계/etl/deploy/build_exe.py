# -*- coding: utf-8 -*-
r"""build_exe.py — 연동 러너를 단일 EXE 로 묶는다(워크스테이션에서 실행).

목적: ERP 서버에 **파이썬 런타임을 설치하지 않고** 파일 하나만 두고 돌리기 위함.
      벤더 운영 서버라 설치 흔적을 최소화한다.

사용:
    python 10_ERP_DB연계/etl/deploy/build_exe.py                     # dist/jeil_runner.exe
    python 10_ERP_DB연계/etl/deploy/build_exe.py --out E:\배포폴더    # 빌드 후 그 폴더로 복사까지

산출물: dist/jeil_runner.exe (통합 러너) — **서버에는 이 파일 하나만 둔다**

주의
 · `.env` 는 **절대 번들에 넣지 않는다**. EXE 는 실행 시 **자기 자신이 놓인 폴더**의
   `.env` 를 읽는다(`_env.py:env_root()` 가 frozen 이면 sys.executable 기준).
 · ODBC 드라이버는 번들 대상이 아니다 — 대상 서버의 시스템 구성요소를 쓴다
   (ERP 서버 실측: ODBC Driver 17 for SQL Server 존재).
 · 빌드 PC와 서버의 아키텍처가 같아야 한다(둘 다 x64).
"""
import argparse
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ETL = os.path.abspath(os.path.join(HERE, ".."))
NAME = "gl_relay"

# 빌드 대상은 **하나**다(2026-09-18 통합). 러너와 관련된 것은 전부 이 EXE 안에 있다.
#   jeil_runner.exe — 트레이 스케줄 러너 + 딸린 CLI(relay·sync·etl·offboard·mailbox)
#
# 예전에는 gl_relay.exe 를 따로 빌드해 나란히 뒀는데, 서버에서 한쪽만 낡는 일이 실제로 생겼다
# (2026-09-11 릴레이 심박 v1.6 / 전달본 v1.7). 파일이 하나면 그 불일치가 원천적으로 없다.
#
# console 로 빌드한다 — 서버에서 `jeil_runner.exe relay --list` 같은 점검 출력을 바로 봐야 하기 때문.
# 트레이 앱으로 뜰 때는 jeil_runner.hide_console() 이 그 창을 감춘다.
TARGETS = {
    "runner": {
        "name": "jeil_runner", "entry": "jeil_runner.py", "console": True,
        # 자식 작업·서브커맨드가 import 하는 모듈은 정적 분석에 안 잡힐 수 있어 명시한다
        "hidden": ["pyodbc", "pystray._win32", "PIL.Image", "PIL.ImageDraw",
                   "gl_apply_demo2", "etl_watch", "etl_run", "_erp_conn", "_env",
                   "ms_collect", "gw_collect", "gw_offboard", "offboard_axes", "exo_admin"],
        # 브라우저 자동화(그룹웨어 퇴사 축)는 서버 대상이 아니다 — 번들 제외(용량·의존 차단).
        # 러너가 능력 감지로 알아서 끈다(runner_core.detect_capabilities).
        "exclude": ["playwright"],
    },
}


def build_one(target, dist, work, keep_build):
    spec = TARGETS[target]
    name = spec["name"]
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--console" if spec["console"] else "--windowed",
        "--name", name,
        "--distpath", dist,
        "--workpath", os.path.join(work, name),
        "--specpath", os.path.join(work, name),
        "--paths", ETL,                 # _env.py · _erp_conn.py 등 형제 모듈을 찾게 한다
        "--noconfirm",
        "--clean",
    ]
    for h in spec["hidden"]:
        cmd += ["--hidden-import", h]
    for x in spec["exclude"]:
        cmd += ["--exclude-module", x]
    cmd.append(os.path.join(ETL, spec["entry"]))
    print(f"[빌드:{target}]", " ".join(cmd[2:]))
    r = subprocess.run(cmd)
    if r.returncode != 0:
        raise SystemExit(f"빌드 실패 (exit {r.returncode})")
    exe = os.path.join(dist, name + ".exe")
    if not os.path.exists(exe):
        raise SystemExit(f"산출물이 없습니다: {exe}")
    size = os.path.getsize(exe) / (1024 * 1024)
    print(f"\n[완료] {exe}  ({size:.1f} MB)")
    if not keep_build:
        shutil.rmtree(os.path.join(work, name), ignore_errors=True)
    return exe


def main():
    ap = argparse.ArgumentParser(description="ERP 서버용 통합 러너 EXE 빌드")
    ap.add_argument("--target", choices=[*TARGETS, "all", "relay"], default="runner",
                    help="runner(기본이자 유일 — jeil_runner.exe). relay 는 통합돼 없어졌다")
    ap.add_argument("--out", help="빌드 후 EXE 를 복사할 폴더(선택)")
    ap.add_argument("--keep-build", action="store_true", help="build/ 중간산출물 유지")
    args = ap.parse_args()

    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        raise SystemExit("PyInstaller 가 없습니다 — python -m pip install pyinstaller")
    if args.target == "relay":
        raise SystemExit(
            "gl_relay.exe 는 jeil_runner.exe 에 통합됐습니다(2026-09-18)." + chr(10)
            + "  빌드:  python deploy/build_exe.py" + chr(10)
            + "  사용:  jeil_runner.exe relay --queue --max 5")
    if True:
        try:
            import pystray, PIL  # noqa: F401
        except ImportError:
            raise SystemExit("러너 빌드에는 pystray·Pillow 가 필요합니다 — python -m pip install pystray pillow")

    dist = os.path.join(HERE, "dist")
    work = os.path.join(HERE, "build")
    targets = list(TARGETS) if args.target == "all" else [args.target]
    exes = [build_one(t, dist, work, args.keep_build) for t in targets]
    if not args.keep_build:
        shutil.rmtree(work, ignore_errors=True)

    if args.out:
        os.makedirs(args.out, exist_ok=True)
        for exe in exes:
            shutil.copy2(exe, args.out)
            print(f"[복사] {os.path.join(args.out, os.path.basename(exe))}")

    print(
        chr(10) + "다음: 서버에서" + chr(10)
        + "  1) jeil_runner.exe 를 실행 폴더(.env 있는 곳)에 둔다 — 파일은 이것 하나면 된다" + chr(10)
        + "  2) jeil_runner.exe --smoke   <- 자체 점검(더미 작업만, 설정 안 건드림)" + chr(10)
        + "  3) jeil_runner.exe tools     <- 딸린 CLI 목록(relay·sync·etl·offboard·mailbox)" + chr(10)
        + "  4) jeil_runner.exe           <- 트레이 앱 시작" + chr(10))


if __name__ == "__main__":
    main()
