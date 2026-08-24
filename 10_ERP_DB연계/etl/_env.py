# _env.py — 프로젝트 루트 .env 로더 (값은 .env에만, 코드/커밋 금지 — CLAUDE.md §1)
import os
import sys

# Windows 콘솔(cp949)에서 한국어·특수문자 출력 깨짐 방지
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

def env_root() -> str:
    """`.env` 를 찾을 기준 폴더.

    · 평소(.py 실행): 저장소 루트 = 이 파일 기준 두 단계 위.
    · PyInstaller EXE: **exe 가 놓인 폴더**. 번들은 실행 시 임시폴더에 풀리므로
      `__file__` 을 쓰면 그 임시폴더를 가리켜 .env 를 영영 못 찾는다(sys.executable 이 정답).
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", ".."))


def load_env():
    """`.env`(env_root 기준)를 읽어 os.environ에 주입(이미 있으면 유지)."""
    path = os.path.join(env_root(), ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            if " #" in v:  # 인라인 주석 제거 (예: KEY=값  # 설명)
                v = v.split(" #", 1)[0]
            k, v = k.strip().lstrip("﻿"), v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v

def need(key: str) -> str:
    v = os.environ.get(key, "")
    if not v:
        raise SystemExit(
            f"환경변수 {key} 가 없습니다 — {os.path.join(env_root(), '.env')} 에 추가하세요"
        )
    return v
