# -*- coding: utf-8 -*-
"""
조회플랫폼/ 폴더의 가이드 .md 를 공유 스타일 HTML 로 변환한다.
기존 '그리드/_build_html.py' 와 같은 구조·톤을 따른다.
사용: python _build_html.py
주의: index.html의 QBAR_*_INLINE 마커 블록은 이 스크립트가 주입(그 외 영역은 직접 관리).
"""
import os, re, markdown
import sys as _sys
# 공개 URL 라우트 적용 — 재생성해도 클린 URL(/docs/…) 유지
_sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '00_관리체계', 'lib'))
from _html_builder import _clean_links

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # 프로젝트 루트 (app/lib/querybar.js·querybar.css 위치 계산용)

DOCS = [
    ("조회플랫폼_가이드", "표준 조회 플랫폼 가이드", "app/lib/querybar.js 사용법·API·규약(단일 출처)"),
]

CSS = """
:root{--navy:#1a2f4e;--navy2:#27457a;--accent:#2f6fb3;--red:#b3402f;--green:#2e7d52;--amber:#9a6b1f;
--ink:#222;--muted:#666;--line:#d8dee8;--bg:#f4f6f9;--soft:#eef2f8;}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Pretendard','Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:var(--ink);background:var(--bg);line-height:1.65;font-size:15px;}
.page{max-width:960px;margin:0 auto;background:#fff;padding:52px 60px;box-shadow:0 2px 14px rgba(0,0,0,.08);}
.doc-label{display:inline-block;background:var(--navy);color:#fff;font-size:12px;letter-spacing:.16em;padding:5px 14px;border-radius:3px;margin-bottom:16px;}
.docnav{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 26px;}
.docnav a{font-size:12px;color:var(--navy2);border:1px solid var(--line);border-radius:20px;padding:4px 12px;text-decoration:none;background:var(--soft);}
.docnav a:hover{background:var(--navy);color:#fff;}
.docnav a.cur{background:var(--navy);color:#fff;border-color:var(--navy);}
.md-link{font-size:13px;margin-bottom:22px;color:var(--muted);}
.content h1{font-size:27px;color:var(--navy);line-height:1.35;margin:6px 0 18px;}
.content h2{font-size:20px;color:var(--navy);margin:42px 0 14px;padding-bottom:9px;border-bottom:3px solid var(--navy);}
.content h3{font-size:16px;color:var(--navy2);margin:24px 0 9px;}
.content p{margin:0 0 12px;}
.content ul,.content ol{margin:0 0 14px 22px;}
.content li{margin-bottom:6px;}
.content blockquote{background:var(--soft);border-left:5px solid var(--navy);border-radius:0 8px 8px 0;padding:14px 20px;margin:14px 0;color:#33425a;}
.content blockquote p{margin:0 0 6px;}
.content table{width:100%;border-collapse:collapse;margin:14px 0 20px;font-size:13.3px;}
.content th{background:var(--navy);color:#fff;padding:9px 11px;text-align:left;font-weight:600;}
.content td{padding:8px 11px;border-bottom:1px solid var(--line);vertical-align:top;}
.content tr:nth-child(even) td{background:#fafbfd;}
.content a{color:var(--accent);}
.content code{background:var(--soft);border:1px solid var(--line);border-radius:4px;padding:1px 6px;font-size:12.4px;font-family:Consolas,'Courier New',monospace;}
.content pre{background:#21252e;color:#e8eaf0;border-radius:8px;padding:16px 18px;font-size:12.4px;font-family:Consolas,'Courier New',monospace;overflow-x:auto;margin:12px 0 18px;line-height:1.55;}
.content pre code{background:none;border:none;color:inherit;padding:0;}
.content hr{border:none;border-top:1px solid var(--line);margin:30px 0;}
.content strong{color:var(--navy2);}
.footer{margin-top:50px;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);display:flex;justify-content:space-between;}
@media print{body{background:#fff;}.page{box-shadow:none;padding:18px 0;max-width:100%;}.docnav{display:none;}.content h2{break-after:avoid;}.content table,.content pre,.content blockquote{break-inside:avoid;}}
@media (max-width:720px){.page{padding:30px 20px;}}
"""


def nav_html(cur_slug):
    items = ['<a href="index.html">🔎 조회 플랫폼 데모</a>']
    for slug, label, _ in DOCS:
        cls = ' class="cur"' if slug == cur_slug else ''
        items.append(f'<a{cls} href="{slug}.html">{label}</a>')
    items.append('<a href="/그리드/index.html">🧩 그리드 표준</a>')
    return '<div class="docnav">' + ''.join(items) + '</div>'


def build():
    md = markdown.Markdown(extensions=['tables', 'fenced_code', 'toc', 'sane_lists'])
    for slug, label, sub in DOCS:
        src = os.path.join(HERE, slug + '.md')
        if not os.path.exists(src):
            print('skip(없음):', slug); continue
        text = open(src, encoding='utf-8').read()
        md.reset()
        body = md.convert(text)
        html = f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{label} — JEIL AX 표준 조회 플랫폼 ({sub})</title>
<style>{CSS}</style>
</head>
<body>
<div class="page">
  <span class="doc-label">JEIL AX · 표준 조회 플랫폼</span>
  {nav_html(slug)}
  <p class="md-link">📄 Markdown 원본: <a href="{slug}.md">{slug}.md</a> · 데모 <a href="index.html">조회 플랫폼 데모</a></p>
  <div class="content">
{body}
  </div>
  <div class="footer"><span>JEIL M&amp;S · AI 포털 표준 조회 플랫폼</span><span>{label} · 관리: 최동혁</span></div>
</div>
</body>
</html>"""
        out = os.path.join(HERE, slug + '.html')
        open(out, 'w', encoding='utf-8').write(_clean_links(HERE, html))
        print('built:', slug + '.html')


# ---------------------------------------------------------------------------
# index.html 자기완결화(inline_demo)
# 원본 단일 출처(app/lib/querybar.js · app/lib/querybar.css)는 읽기만 하고 절대
# 수정하지 않는다. index.html의 QBAR_CSS_INLINE / QBAR_JS_INLINE 마커 블록
# "안쪽 내용만" 매 실행마다 통째로 재생성해 주입한다 — file:// 더블클릭으로도
# 데모가 동작하게.
# ---------------------------------------------------------------------------

CSS_MARK_RE = re.compile(
    r'(<!-- \[QBAR_CSS_INLINE 시작\].*?-->\s*<style>)(.*?)(</style>\s*<!-- \[QBAR_CSS_INLINE 끝\] -->)',
    re.DOTALL,
)
JS_MARK_RE = re.compile(
    r'(<!-- \[QBAR_JS_INLINE 시작\].*?-->\s*<script>)(.*?)(</script>\s*<!-- \[QBAR_JS_INLINE 끝\] -->)',
    re.DOTALL,
)

# ESM export → 비모듈 전역. 패턴을 못 찾으면 빌드를 중단해 드리프트를 즉시 드러낸다.
EXPORT_PATTERNS = [
    ('export function createQueryBar', 'function createQueryBar'),
    ('export function readMonthSeries', 'function readMonthSeries'),
    ('export function numOf', 'function numOf'),
    ('export default createQueryBar;', '/* (인라인 빌드) export default 제거 */'),
]


def transform_querybar_js(src):
    if '</script>' in src:
        raise SystemExit('[중단] querybar.js 안에 "</script>" 문자열이 있습니다 — 인라인 주입 시 <script> 블록이 조기 종료됩니다.')
    for pat, rep in EXPORT_PATTERNS:
        if pat not in src:
            raise SystemExit(
                f'[중단] querybar.js에서 예상 패턴을 찾지 못했습니다: {pat!r}\n'
                '        export 형태가 바뀌었다면 _build_html.py의 EXPORT_PATTERNS도 함께 갱신하세요.')
        src = src.replace(pat, rep, 1)
    return src


def inline_demo():
    css_path = os.path.join(ROOT, 'app', 'lib', 'querybar.css')
    js_path = os.path.join(ROOT, 'app', 'lib', 'querybar.js')
    index_path = os.path.join(HERE, 'index.html')

    css_src = open(css_path, encoding='utf-8').read()
    js_src = transform_querybar_js(open(js_path, encoding='utf-8').read())

    html = open(index_path, encoding='utf-8').read()
    if not CSS_MARK_RE.search(html) or not JS_MARK_RE.search(html):
        raise SystemExit('[중단] index.html에서 QBAR_CSS_INLINE / QBAR_JS_INLINE 마커를 찾지 못했습니다.')

    html = CSS_MARK_RE.sub(lambda m: m.group(1) + '\n' + css_src + '\n' + m.group(3), html)
    html = JS_MARK_RE.sub(lambda m: m.group(1) + '\n' + js_src + '\n' + m.group(3), html)
    open(index_path, 'w', encoding='utf-8').write(_clean_links(HERE, html))
    print('inlined: index.html  (css %d자 · js %d자)' % (len(css_src), len(js_src)))


if __name__ == '__main__':
    build()
    inline_demo()
