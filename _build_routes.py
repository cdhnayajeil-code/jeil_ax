# -*- coding: utf-8 -*-
"""
_routes.py 를 읽어 (1) vercel.json 생성 (2) 문서·화면의 내부 링크를 클린 URL로 치환.

    python _build_routes.py           # 미리보기(변경 없음)
    python _build_routes.py --write   # 실제 반영

치환 규칙: href/src 가 저장소 안의 .html 을 가리키면 → 클린 절대경로(/work/voucher 등).
앵커(#)·쿼리(?)는 보존한다. 외부 링크·data:·mailto: 는 건드리지 않는다.
"""
import io, json, os, re, sys, urllib.parse
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _routes import ROUTES, FILE_TO_ROUTE

ROOT = os.path.dirname(os.path.abspath(__file__))
WRITE = "--write" in sys.argv

SKIP_DIRS = {".git", ".backlog", ".claude", "MS_connect", "doc", "node_modules",
             "scratchpad", ".vercel", "supabase"}
SKIP_FILES = {"JEIL_AX_포털데모_통합본.html"}   # 빌드 산출물(_build_bundle.py 소관)

LINK_RE = re.compile(r'(?P<attr>\b(?:href|src)\s*=\s*)(?P<q>["\'])(?P<url>[^"\']+)(?P=q)')
# 2차: JS 문자열 안의 경로 — href:'…', window.open('…'), location.replace('…') 등
STR_RE = re.compile(r'(?P<q>["\'])(?P<url>[^"\'<>()]+\.html)(?P=q)')


def repo_files():
    for dp, dns, fns in os.walk(ROOT):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for fn in fns:
            if fn in SKIP_FILES or not fn.lower().endswith((".html", ".md")):
                continue
            yield os.path.join(dp, fn)


def resolve(src_file, url):
    """링크 URL → 저장소 상대 파일경로(슬래시). 저장소 밖이면 None."""
    if re.match(r"^(?:[a-z]+:|//|#|\?)", url, re.I):
        return None, "", ""
    path, sep, tail = url.partition("#")
    if not sep:
        path, sep2, q = url.partition("?")
        tail, sep = (q, sep2) if sep2 else ("", "")
        frag = ("?" + tail) if sep2 else ""
    else:
        frag = "#" + tail
        path, sep2, q = path.partition("?")
        if sep2:
            frag = "?" + q + frag
    if not path.lower().endswith(".html"):
        return None, "", ""
    dec = urllib.parse.unquote(path)
    base = ROOT if dec.startswith("/") else os.path.dirname(src_file)
    tgt = os.path.normpath(os.path.join(base, dec.lstrip("/")))
    try:
        rel = os.path.relpath(tgt, ROOT).replace(os.sep, "/")
    except ValueError:
        return None, "", ""
    if rel.startswith(".."):
        return None, "", ""
    return rel, frag, path


def main():
    # ── 1. 라우트 무결성: 대상 파일이 실제로 있는가 ──────────────
    missing = [f for f in ROUTES.values() if not os.path.exists(os.path.join(ROOT, f))]
    if missing:
        print("[중단] 라우트 대상 파일 없음:")
        for m in missing:
            print("   -", m)
        return 1

    # ── 2. vercel.json ──────────────────────────────────────
    # 목적지 규칙(실측으로 확정):
    #  · 원문(비인코딩) 경로를 쓴다 — 퍼센트 인코딩하면 정적 파일 매칭 실패(404).
    #  · `.html` 을 뗀다 — cleanUrls:true 면 출력에서 확장자가 제거돼 `/foo.html` 은 존재하지 않는다.
    def enc(p):
        return "/" + (p[:-5] if p.lower().endswith(".html") else p)

    vercel = {
        "$schema": "https://openapi.vercel.sh/vercel.json",
        "cleanUrls": True,
        "trailingSlash": False,
        "rewrites": [{"source": s, "destination": enc(d)} for s, d in ROUTES.items()],
        "headers": [{
            "source": "/(.*)",
            "headers": [
                {"key": "X-Content-Type-Options", "value": "nosniff"},
                {"key": "Referrer-Policy", "value": "strict-origin-when-cross-origin"},
                {"key": "X-Frame-Options", "value": "SAMEORIGIN"},
            ],
        }],
    }
    vpath = os.path.join(ROOT, "vercel.json")
    vtext = json.dumps(vercel, ensure_ascii=False, indent=2) + "\n"
    if WRITE:
        io.open(vpath, "w", encoding="utf-8", newline="\n").write(vtext)
    print(f"vercel.json — 리라이트 {len(ROUTES)}개 {'생성' if WRITE else '(미리보기)'}")

    # ── 3. 내부 링크 치환 ────────────────────────────────────
    changed, hits, unmapped = 0, 0, Counter()
    for f in repo_files():
        s = io.open(f, encoding="utf-8", errors="replace").read()
        n = [0]

        def sub(m):
            rel, frag, raw = resolve(f, m.group("url"))
            if rel is None:
                return m.group(0)
            route = FILE_TO_ROUTE.get(rel)
            if not route:
                unmapped[rel] += 1
                return m.group(0)
            new = (route if route != "/" else "/") + frag
            if new == m.group("url"):
                return m.group(0)
            n[0] += 1
            return f'{m.group("attr")}{m.group("q")}{new}{m.group("q")}'

        def sub_str(m):
            rel, frag, raw = resolve(f, m.group("url"))
            if rel is None:
                return m.group(0)
            route = FILE_TO_ROUTE.get(rel)
            if not route:
                unmapped[rel] += 1
                return m.group(0)
            n[0] += 1
            return f'{m.group("q")}{route}{frag}{m.group("q")}'

        out = STR_RE.sub(sub_str, LINK_RE.sub(sub, s))
        if n[0]:
            hits += n[0]
            changed += 1
            if WRITE:
                io.open(f, "w", encoding="utf-8", newline="").write(out)

    print(f"내부 링크 — {changed}개 파일 / {hits}개 링크 {'치환' if WRITE else '치환 예정'}")
    if unmapped:
        print(f"\n[주의] 라우트 미등록 대상 {len(unmapped)}종 (기존 .html 경로 유지):")
        for rel, c in unmapped.most_common(20):
            print(f"   {c:>3}회  {rel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
