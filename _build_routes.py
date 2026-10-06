# -*- coding: utf-8 -*-
"""
_routes.py 를 읽어 (1) vercel.json 생성 (2) 문서·화면의 내부 링크를 클린 URL로 치환.

    python _build_routes.py           # 미리보기(변경 없음)
    python _build_routes.py --write   # 실제 반영

치환 규칙: href/src 가 저장소 안의 .html 을 가리키면 → 클린 절대경로(/work/voucher 등).
앵커(#)·쿼리(?)는 보존한다. 외부 링크·data:·mailto: 는 건드리지 않는다.

함께 만드는 것(2026-10-06 문서 폴더 통합 · REQ-0107):
  (3) 문서/index.html      — 문서 센터(/docs). 라우트 표에서 자동 생성 — 손으로 고치지 않는다.
  (4) _local_links.js      — 파일로 열었을 때(file://) 클린 URL 링크를 실제 파일로 이어 준다.
  (5) 문서 영역 HTML 마다 로더 한 줄(_routes.inject_local_links) — 사이트에서는 아무 일도 하지 않는다.
  (6) 통합 전 옛 주소(/10_ERP_DB연계/… 등) → 클린 주소 리다이렉트.
"""
import html as _html
import io, json, os, re, sys, urllib.parse
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _routes import (ROUTES, FILE_TO_ROUTE, DOC_CENTER, DOC_GROUPS, legacy_path,
                     inject_local_links)

ROOT = os.path.dirname(os.path.abspath(__file__))
WRITE = "--write" in sys.argv

SKIP_DIRS = {".git", ".backlog", ".claude", "MS_connect", "doc", "node_modules",
             "scratchpad", ".vercel", "supabase"}
SKIP_FILES = {"JEIL_AX_포털데모_통합본.html"}   # 빌드 산출물(_build_bundle.py 소관)

# 파일로 열어 보는 문서 영역 — 여기 HTML 에만 로컬 링크 로더를 넣는다(운영 화면 pages/·app/ 은 제외)
LOCAL_AREAS = ("문서/", "실제구축준비 자료/", "그리드/", "조회플랫폼/")

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


def _title_of(rel):
    try:
        s = io.open(os.path.join(ROOT, rel), encoding="utf-8", errors="replace").read(20000)
    except OSError:
        return os.path.basename(rel)
    m = re.search(r"<title[^>]*>(.*?)</title>", s, re.I | re.S)
    t = re.sub(r"\s+", " ", _html.unescape(m.group(1))).strip() if m else ""
    return t or os.path.splitext(os.path.basename(rel))[0]


def build_doc_center():
    """문서 센터(문서/index.html) — 라우트 표의 /docs·/survey·/demo·/tools 문서를 묶음별 목차로."""
    groups = [[] for _ in DOC_GROUPS]
    for route, dest in ROUTES.items():
        if dest == DOC_CENTER or not route.startswith(("/docs", "/survey", "/demo/", "/tools/")):
            continue
        for i, (prefix, _t, _d) in enumerate(DOC_GROUPS):
            if dest.startswith(prefix):
                groups[i].append((dest, route))
                break
    esc = _html.escape
    secs, total = [], 0
    for (prefix, title, desc), items in zip(DOC_GROUPS, groups):
        if not items:
            continue
        # 허브(index)가 맨 앞, 나머지는 파일 이름 순
        items.sort(key=lambda x: (not x[0].endswith("/index.html"), x[0]))
        rows = []
        for dest, route in items:
            total += 1
            hub = ' <span class="hub">허브</span>' if dest.endswith("/index.html") else ""
            name = dest[len(prefix):]
            rows.append('<li><a href="%s"><b>%s</b>%s<span class="f">%s</span><span class="r">%s</span></a></li>'
                        % (esc(route), esc(_title_of(dest)), hub, esc(name), esc(route)))
        secs.append('<section class="grp"><h2>%s <span class="n">%d</span></h2><p class="d">%s</p><ul>%s</ul></section>'
                    % (esc(title), len(items), esc(desc), "\n".join(rows)))
    page = r"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>JEIL AX 문서 센터</title>
<style>
:root{--navy:#1a2f4e;--navy2:#27457a;--accent:#2f6fb3;--ink:#222;--muted:#667085;--line:#d8dee8;--bg:#f4f6f9;--soft:#eef2f8;}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Pretendard','Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:var(--ink);background:var(--bg);line-height:1.55;font-size:15px;}
.wrap{max-width:1180px;margin:0 auto;padding:36px 24px 60px;}
.top{background:var(--navy);color:#fff;border-radius:12px;padding:26px 30px;margin-bottom:18px;}
.top h1{font-size:24px;margin-bottom:6px;}
.top p{font-size:13.5px;opacity:.85;}
.top .quick{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px;}
.top .quick a{color:#fff;border:1px solid rgba(255,255,255,.35);border-radius:20px;padding:4px 13px;font-size:12.5px;text-decoration:none;}
.top .quick a:hover{background:#fff;color:var(--navy);}
.bar{display:flex;gap:10px;align-items:center;margin-bottom:18px;}
.bar input{flex:1;padding:11px 14px;border:1px solid var(--line);border-radius:8px;font-size:14.5px;font-family:inherit;}
.bar .cnt{font-size:13px;color:var(--muted);white-space:nowrap;}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px;align-items:start;}
.grp{background:#fff;border:1px solid var(--line);border-radius:10px;padding:18px 18px 12px;}
.grp h2{font-size:16.5px;color:var(--navy);}
.grp h2 .n{font-size:11.5px;background:var(--soft);color:var(--navy2);border-radius:10px;padding:1px 8px;margin-left:4px;font-weight:600;}
.grp .d{font-size:12.3px;color:var(--muted);margin:4px 0 10px;}
.grp ul{list-style:none;}
.grp li a{display:block;padding:7px 9px;border-radius:6px;text-decoration:none;color:var(--ink);border-top:1px solid #f0f2f6;}
.grp li a:hover{background:var(--soft);}
.grp li b{font-weight:600;font-size:13.6px;color:var(--navy2);}
.grp li .f,.grp li .r{display:block;font-size:11.3px;color:var(--muted);word-break:break-all;}
.grp li .r{font-family:Consolas,'Courier New',monospace;color:var(--accent);}
.hub{font-size:10.5px;background:var(--navy);color:#fff;border-radius:3px;padding:1px 6px;margin-left:4px;vertical-align:1px;}
.none{display:none;text-align:center;color:var(--muted);padding:40px 0;}
.foot{margin-top:26px;font-size:12px;color:var(--muted);}
@media (max-width:720px){.wrap{padding:18px 12px 40px;}.grid{grid-template-columns:1fr;}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>📚 JEIL AX 문서 센터</h1>
    <p>기획 · 관리 · 연계 문서 __TOTAL__종을 한 곳에서 찾습니다. 사이트에서도, PC에서 이 파일을 직접 열어도 링크가 그대로 이어집니다.</p>
    <div class="quick">
      <a href="/docs/governance">🧭 총괄 대시보드</a>
      <a href="/docs/governance/documents">🗂 문서대장</a>
      <a href="/docs/erp">🔗 ERP DB 연계</a>
      <a href="/docs/agents">🤖 에이전트 관리</a>
      <a href="/docs/migration">🚚 이관 관제</a>
      <a href="/main">🏠 포털</a>
    </div>
  </div>
  <div class="bar"><input id="q" type="search" placeholder="문서 제목 · 파일 이름 · 주소로 찾기" autocomplete="off"><span class="cnt" id="cnt">__TOTAL__종</span></div>
  <div class="grid" id="grid">
__SECTIONS__
  </div>
  <p class="none" id="none">찾는 문서가 없습니다.</p>
  <p class="foot">이 화면은 저장소 루트 <code>_routes.py</code> 에서 자동 생성됩니다 — 문서를 추가하면 라우트에 한 줄 넣고 <code>python _build_routes.py --write</code>. 직접 고치지 않습니다.</p>
</div>
<script>
(function(){
  var q=document.getElementById("q"),cnt=document.getElementById("cnt"),none=document.getElementById("none");
  var lis=[].slice.call(document.querySelectorAll(".grp li"));
  lis.forEach(function(li){li._t=li.textContent.toLowerCase();});
  q.addEventListener("input",function(){
    var k=q.value.trim().toLowerCase(),n=0;
    lis.forEach(function(li){var ok=!k||li._t.indexOf(k)>=0;li.style.display=ok?"":"none";if(ok)n++;});
    [].forEach.call(document.querySelectorAll(".grp"),function(g){
      g.style.display=[].some.call(g.querySelectorAll("li"),function(li){return li.style.display!=="none";})?"":"none";});
    cnt.textContent=n+"종";none.style.display=n?"none":"block";
  });
})();
</script>
</body>
</html>
"""
    page = page.replace("__TOTAL__", str(total)).replace("__SECTIONS__", "\n".join(secs))
    page = inject_local_links(page, DOC_CENTER)
    if WRITE:
        io.open(os.path.join(ROOT, DOC_CENTER), "w", encoding="utf-8", newline="\n").write(page)
    print(f"문서 센터 — {DOC_CENTER} · {total}종 {'생성' if WRITE else '(미리보기)'}")


LOCAL_JS = r"""/* 자동 생성 — python _build_routes.py --write (손으로 고치지 않는다)
 * 문서를 PC에서 파일로 열었을 때(file://)만 동작한다. 클린 URL(/docs/erp/status 등)을 실제 파일 경로로 바꿔
 * 클릭이 이어지게 한다. 사이트(http/https)에서는 각 문서의 로더가 이 파일을 아예 부르지 않는다. */
(function(){
  if(location.protocol!=="file:")return;
  var me=document.currentScript,ROOT=(me&&me.getAttribute("data-root"))||"./";
  var R=__MAP__;
  function fix(u){
    if(!u||u.charAt(0)!=="/"||u.charAt(1)==="/")return null;
    var m=/^([^?#]*)(.*)$/.exec(u),p=m[1],tail=m[2];
    try{p=decodeURI(p);}catch(e){}
    if(p.length>1)p=p.replace(/\/+$/,"");
    var f=R[p];
    if(!f){f=p.slice(1);if(!/\.[A-Za-z0-9]+$/.test(f))f+=".html";}   /* 라우트 밖: /app/lib/x.css · cleanUrls(/foo → foo.html) */
    return ROOT+encodeURI(f)+tail;
  }
  function patch(el,attr){
    var v=el.getAttribute(attr),n=fix(v);
    if(n){el.setAttribute("data-clean-url",v);el.setAttribute(attr,n);}
  }
  var SEL=[['a[href^="/"],area[href^="/"],link[rel~="stylesheet"][href^="/"]',"href"],['img[src^="/"],iframe[src^="/"]',"src"]];
  function sweep(root){
    if(!root||!root.querySelectorAll)return;
    SEL.forEach(function(s){
      if(root.matches&&root.matches(s[0]))patch(root,s[1]);
      [].forEach.call(root.querySelectorAll(s[0]),function(el){patch(el,s[1]);});
    });
  }
  sweep(document);
  document.addEventListener("DOMContentLoaded",function(){sweep(document);});
  /* 화면이 스크립트로 그린 링크(대시보드 카드 등)도 잡는다 */
  try{new MutationObserver(function(ms){ms.forEach(function(m){
    if(m.type==="attributes")sweep(m.target);
    else [].forEach.call(m.addedNodes,sweep);
  });}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["href","src"]});}catch(e){}
  ["mousedown","focusin","click"].forEach(function(t){document.addEventListener(t,function(ev){
    var a=ev.target&&ev.target.closest&&ev.target.closest('a[href^="/"]');if(a)patch(a,"href");
  },true);});
  window.__jeilaxLocalLink=fix;
})();
"""


def main():
    # ── 0. 문서 센터(라우트 대상이므로 무결성 점검보다 먼저 만든다) ──
    build_doc_center()

    # ── 1. 라우트 무결성: 대상 파일이 실제로 있는가 ──────────────
    missing = [f for f in ROUTES.values() if not os.path.exists(os.path.join(ROOT, f))
               and not (f == DOC_CENTER and not WRITE)]
    if missing:
        print("[중단] 라우트 대상 파일 없음:")
        for m in missing:
            print("   -", m)
        return 1

    # ── 2. vercel.json ──────────────────────────────────────
    # 경로 표기 규칙(라이브 실측으로 확정 — 둘이 서로 다르다):
    #  · 공통: `.html` 을 뗀다. cleanUrls:true 면 출력에서 확장자가 제거돼 `/foo.html` 은 없다.
    #  · rewrite destination = **원문(비인코딩)**. 퍼센트 인코딩하면 정적 파일 매칭 실패(404).
    #  · redirect source     = **퍼센트 인코딩**. 원문이면 한글 경로가 매칭되지 않는다(리다이렉트 미발동).
    def _bare(p):
        return p[:-5] if p.lower().endswith(".html") else p

    def dest(p):
        return "/" + _bare(p)

    def src(p):
        b = _bare(p)
        # cleanUrls 는 `/폴더/index.html` 을 `/폴더/index` 가 아니라 `/폴더` 로 정규화한다
        if b.endswith("/index"):
            b = b[:-len("/index")]
        return "/" + urllib.parse.quote(b)

    vercel = {
        "$schema": "https://openapi.vercel.sh/vercel.json",
        "cleanUrls": True,
        "trailingSlash": False,
        # 구 주소(파일 경로)로 들어오면 새 클린 주소로 보낸다 — 북마크가 새 주소로 수렴한다.
        # permanent=False(307): 브라우저에 영구 캐시되지 않아 라우트를 나중에 고쳐도 즉시 반영된다.
        "redirects": [{"source": src(d), "destination": s, "permanent": False}
                      for s, d in ROUTES.items()]
                     # 문서 폴더 통합(2026-10-06) 전 주소 — /10_ERP_DB연계/… 로 온 북마크도 살린다
                     + [{"source": src(legacy_path(d)), "destination": s, "permanent": False}
                        for s, d in ROUTES.items() if legacy_path(d)],
        "rewrites": [{"source": s, "destination": dest(d)} for s, d in ROUTES.items()],
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

    # ── 2-1. 로컬 링크 보정 스크립트(파일로 열 때 전용) ──────────
    ljs = LOCAL_JS.replace("__MAP__", json.dumps(dict(ROUTES, **{"/": "index.html"}),
                                                 ensure_ascii=False, separators=(",", ":")))
    if WRITE:
        io.open(os.path.join(ROOT, "_local_links.js"), "w", encoding="utf-8", newline="\n").write(ljs)
    print(f"_local_links.js — 라우트 {len(ROUTES) + 1}개 {'생성' if WRITE else '(미리보기)'}")

    # ── 3. 내부 링크 치환 ────────────────────────────────────
    changed, hits, unmapped, loaders = 0, 0, Counter(), 0
    for f in repo_files():
        s = io.open(f, encoding="utf-8", errors="replace", newline="").read()
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
        relf = os.path.relpath(f, ROOT).replace(os.sep, "/")
        if f.lower().endswith(".html") and relf.startswith(LOCAL_AREAS):
            before = out
            out = inject_local_links(out, relf)
            loaders += out != before
        if n[0]:
            hits += n[0]
            changed += 1
        if WRITE and out != s:
            io.open(f, "w", encoding="utf-8", newline="").write(out)

    print(f"내부 링크 — {changed}개 파일 / {hits}개 링크 {'치환' if WRITE else '치환 예정'}")
    print(f"로컬 링크 로더 — {loaders}개 파일 {'반영' if WRITE else '반영 예정'}")
    if unmapped:
        print(f"\n[주의] 라우트 미등록 대상 {len(unmapped)}종 (기존 .html 경로 유지):")
        for rel, c in unmapped.most_common(20):
            print(f"   {c:>3}회  {rel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
