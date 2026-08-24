# -*- coding: utf-8 -*-
r"""build_exe.py — 결의전표 릴레이를 단일 EXE 로 묶는다(워크스테이션에서 실행).

목적: ERP 서버에 **파이썬 런타임을 설치하지 않고** 파일 하나만 두고 돌리기 위함.
      벤더 운영 서버라 설치 흔적을 최소화한다.

사용:
    python 10_ERP_DB연계/etl/deploy/build_exe.py
    python 10_ERP_DB연계/etl/deploy/build_exe.py --out E:\배포폴더

산출물: dist/gl_relay.exe  (약 15~25MB)

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


def main():
    ap = argparse.ArgumentParser(description="결의전표 릴레이 EXE 빌드")
    ap.add_argument("--out", help="빌드 후 EXE 를 복사할 폴더(선택)")
    ap.add_argument("--keep-build", action="store_true", help="build/ 중간산출물 유지")
    args = ap.parse_args()

    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        raise SystemExit("PyInstaller 가 없습니다 — python -m pip install pyinstaller")

    dist = os.path.join(HERE, "dist")
    work = os.path.join(HERE, "build")

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--console",
        "--name", NAME,
        "--distpath", dist,
        "--workpath", work,
        "--specpath", work,
        "--paths", ETL,                 # _env.py · _erp_conn.py 를 찾게 한다
        "--hidden-import", "pyodbc",
        "--noconfirm",
        "--clean",
        os.path.join(ETL, "gl_apply_demo2.py"),
    ]
    print("[빌드]", " ".join(cmd[2:]))
    r = subprocess.run(cmd)
    if r.returncode != 0:
        raise SystemExit(f"빌드 실패 (exit {r.returncode})")

    exe = os.path.join(dist, NAME + ".exe")
    if not os.path.exists(exe):
        raise SystemExit(f"산출물이 없습니다: {exe}")
    size = os.path.getsize(exe) / (1024 * 1024)
    print(f"\n[완료] {exe}  ({size:.1f} MB)")

    if not args.keep_build:
        shutil.rmtree(work, ignore_errors=True)

    if args.out:
        os.makedirs(args.out, exist_ok=True)
        shutil.copy2(exe, args.out)
        print(f"[복사] {os.path.join(args.out, NAME + '.exe')}")

    print(
        "\n다음: 서버에서\n"
        f"  1) {NAME}.exe 를 실행 폴더에 두고, 같은 폴더에 .env 를 만든다\n"
        f"  2) {NAME}.exe --list        ← 대기 건 조회(읽기 전용)\n"
        f"  3) {NAME}.exe --draft <번호> --dry-run\n"
        f"  4) {NAME}.exe --queue --max 5\n"
    )


if __name__ == "__main__":
    main()
