# _env.py — 프로젝트 루트 .env 로더 (값은 .env에만, 코드/커밋 금지 — CLAUDE.md §1)
import os
import sys

# Windows 콘솔(cp949)에서 한국어·특수문자 출력 깨짐 방지
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

def load_env():
    """프로젝트 루트의 .env를 읽어 os.environ에 주입(이미 있으면 유지)."""
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, "..", ".."))
    path = os.path.join(root, ".env")
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
        raise SystemExit(f"환경변수 {key} 가 없습니다 — 프로젝트 루트 .env 에 추가하세요 (.env.example 참조)")
    return v
