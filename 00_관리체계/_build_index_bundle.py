# -*- coding: utf-8 -*-
"""
00_관리체계/index.html 한 파일에 관리 문서 + 이관 관제 문서 전문을 심는다(단일 파일 전달본).

왜: 이 허브를 메일·메신저로 전달하면 받는 쪽은 사내망·로그인 없이 `index.html` 하나만 연다.
    화면의 링크는 전부 루트 절대경로(`/docs/…`)라 그 환경에서 갈 곳이 없다.
    그래서 ① 주요 문서는 파일 안에 넣어 오프라인에서도 열리게 하고,
    ② 넣지 않은 링크는 뷰어가 운영 도메인(ai.jeilm.co.kr)으로 돌려보낸다.

무엇을: 각 문서 HTML 을 base64(UTF-8)로 index.html 의 [AX_DOCS 데이터] 블록에 넣는다.
        index.html 의 뷰어가 **라우트로** 클릭을 가로채 iframe(srcdoc) 오버레이로 띄운다
        (카드·대시보드 링크 어디서 눌러도 같은 라우트면 열린다).
        내장 문서 안의 링크도 내장 대상이면 오버레이 전환, 아니면 운영 도메인 새 탭.

사용:  python _build_index_bundle.py           문서를 심는다
       python _build_index_bundle.py --clear   데이터를 비운다(편집용 — 파일이 가벼워진다)
순서:  .md 수정 → python _build_html.py → python _build_index_bundle.py
주의:  index.html 의 AX_DOCS 블록은 손으로 고치지 않는다(이 스크립트가 덮어쓴다).
       AX_DASH(대시보드 데이터)·마크업·CSS 는 이 스크립트가 건드리지 않는다.
"""
import base64
import io
import json
import os
import re
import sys
import urllib.parse
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..'))
sys.path.insert(0, os.path.join(HERE, 'lib'))

SITE = 'https://ai.jeilm.co.kr'          # 최신본이 있는 운영 도메인

# (키, 그룹, 칩 라벨, 오버레이 제목, 라우트, 저장소 기준 파일경로)
DOCS = [
    ('00_문서대장', '관리체계', '00 문서대장',
     '00 문서대장 — 전체 문서 인덱스·상태·갱신일',
     '/docs/governance/documents', '00_관리체계/00_문서대장.html'),
    ('01_기준정보_레지스트리', '관리체계', '01 기준정보',
     '01 기준정보 레지스트리 — 조직·권한·ERP매핑·프로세스',
     '/docs/governance/registry', '00_관리체계/01_기준정보_레지스트리.html'),
    ('02_명명규칙_폴더규약', '관리체계', '02 명명규칙',
     '02 명명규칙·폴더규약 — 파일/폴더 규칙·예외',
     '/docs/governance/naming', '00_관리체계/02_명명규칙_폴더규약.html'),
    ('03_변경관리_CHANGELOG', '관리체계', '03 변경관리',
     '03 변경관리 CHANGELOG — 전체 변경이력·문서 수명주기',
     '/docs/governance/changelog', '00_관리체계/03_변경관리_CHANGELOG.html'),
    ('04_현재상태_한장요약', '관리체계', '04 한장요약',
     '04 현재상태 한 장 요약 — 참고 스냅샷',
     '/docs/governance/summary', '00_관리체계/04_현재상태_한장요약.html'),
    ('README', '관리체계', 'README',
     '관리체계 폴더 안내 — README',
     None, '00_관리체계/README.md'),

    ('mig_hub', '이관 관제', '이관 허브',
     '이관 관제 센터 — 현 시스템 상태·Azure 이관 단일 출처',
     '/docs/migration', '실제구축준비 자료/이관/index.html'),
    ('mig_00', '이관 관제', '00 상태스냅샷',
     '00 현재시스템 상태 스냅샷 — 배포·계정·시크릿 현황',
     '/docs/migration/snapshot', '실제구축준비 자료/이관/00_현재시스템_상태스냅샷.html'),
    ('mig_01', '이관 관제', '01 이관가이드',
     '01 이관 실행 가이드 — Vercel·Supabase',
     '/docs/migration/guide', '실제구축준비 자료/이관/01_이관실행가이드_Vercel_Supabase.html'),
    ('mig_02', '이관 관제', '02 Azure계획',
     '02 Azure 이관 계획',
     '/docs/migration/azure', '실제구축준비 자료/이관/02_Azure이관계획.html'),
    ('mig_03', '이관 관제', '03 진행상태',
     '03 이관 진행상태 — 체크리스트·작업로그',
     '/docs/migration/progress', '실제구축준비 자료/이관/03_이관진행상태.html'),
]

_A = re.compile(r'<a\s+([^>]*?)href="([^"]*)"([^>]*)>', re.I)
_NAV = re.compile(r'<div class="docnav">.*?</div>\s*', re.S)
_MDLINK = re.compile(r'<p class="md-link">.*?</p>\s*', re.S)
_ASOF = re.compile(r'최종\s*갱신[:：]?\s*(\d{4}-\d{2}-\d{2})')

# 내장 문서로 전환할 라우트 → 키
ROUTES = {route: key for key, _g, _l, _t, route, _p in DOCS if route}

# 내장 사본 안에서 링크를 처리하는 주입 스크립트
# — 내장 문서를 가리키면 부모 뷰어로 전환, 부모에 닿지 못하면 운영 도메인으로 폴백
INJECT = """<script>
(function(){document.addEventListener("click",function(ev){
  var a=ev.target.closest("a[data-axdoc]");if(!a)return;
  ev.preventDefault();
  var k=a.getAttribute("data-axdoc"),u=a.getAttribute("data-axurl");
  try{if(parent&&parent!==window&&parent.__axOpenDoc){parent.__axOpenDoc(k);return;}}catch(e){}
  if(u)window.open(u,"_blank","noopener");
});})();
</script>
"""


def _abs_link(url, folder):
    """오프라인에서 죽는 링크를 운영 도메인 절대 URL 로(문서 내 앵커·외부 링크는 그대로)."""
    if not url or url.startswith('#') or url.startswith('//') or re.match(r'^[a-z]+:', url, re.I):
        return url
    if url.startswith('/'):
        return SITE + urllib.parse.quote(url, safe='/#?=&')
    path, sep, frag = url.partition('#')
    rel = os.path.normpath(os.path.join(folder, path)).replace(os.sep, '/')
    return SITE + '/' + urllib.parse.quote(rel) + (sep + frag if sep else '')


def _linkify(html, folder):
    """내장 사본의 링크 처리 — 내장 대상이면 뷰어 전환용 표식, 아니면 새 탭(운영 도메인)."""
    def sub(m):
        pre, url, post = m.group(1), m.group(2), m.group(3)
        key = ROUTES.get(url.split('#')[0])
        absu = _abs_link(url, folder)
        attrs = (pre + 'href="' + absu + '"' + post).rstrip()
        if key:                                   # 같은 전달본에 들어 있는 문서 → 오버레이 전환
            return '<a ' + attrs + ' data-axdoc="' + key + '" data-axurl="' + absu + '">'
        if not absu.startswith('#') and 'target=' not in attrs.lower():
            attrs += ' target="_blank" rel="noopener"'
        return '<a ' + attrs + '>'
    return _A.sub(sub, html)


def _banner(route):
    link = '%s%s' % (SITE, route) if route else SITE
    return ('<div style="background:#eef2f8;border:1px solid #d8dee8;border-left:5px solid #1a2f4e;'
            'border-radius:0 8px 8px 0;padding:11px 16px;margin:0 0 22px;font-size:12.5px;color:#33425a">'
            '📦 <b>단일 파일 전달본에 내장된 사본</b>입니다. 문서 간 이동은 화면 위쪽 문서 탭을 쓰세요. '
            '최신본: <a href="' + link + '" target="_blank" rel="noopener" style="color:#2f6fb3">'
            + link + '</a></div>')


def _prep(html, route, folder):
    """내장용 가공: 폴더 상대 이동(docnav·MD 원본 링크) 제거 → 표식 → 링크 처리 → 전환 스크립트."""
    html = _NAV.sub('', html)
    html = _MDLINK.sub('', html)
    html = _linkify(html, folder)
    if 'class="doc-label"' in html:
        i = html.index('class="doc-label"')
        j = html.index('</span>', i) + len('</span>')
        html = html[:j] + '\n  ' + _banner(route) + html[j:]
    else:
        m = re.search(r'<body[^>]*>', html, re.I)
        html = (html[:m.end()] + '\n' + _banner(route) + html[m.end():]) if m else _banner(route) + html
    if '</body>' in html:
        return html.replace('</body>', INJECT + '</body>', 1)
    return html + INJECT


def _md_to_html(path, title):
    """HTML 쌍이 없는 .md 는 공통 스타일로 그 자리에서 변환한다."""
    from _html_builder import CSS
    import markdown
    md = markdown.Markdown(extensions=['tables', 'fenced_code', 'toc', 'sane_lists'])
    body = md.convert(io.open(path, encoding='utf-8').read())
    return ('<!DOCTYPE html>\n<html lang="ko">\n<head>\n<meta charset="UTF-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
            '<title>' + title + '</title>\n<style>' + CSS + '</style>\n</head>\n<body>\n'
            '<div class="page">\n  <span class="doc-label">JEIL AX 관리체계 · 대외비</span>\n'
            '  <div class="content">\n' + body + '\n  </div>\n'
            '  <div class="footer"><span>JEIL M&amp;S · AI 포털 관리체계</span>'
            '<span>' + title + '</span></div>\n</div>\n</body>\n</html>')


def _write_block(payload):
    """index.html 의 AX_DOCS 블록만 갈아끼운다(대시보드 AX_DASH·마크업은 건드리지 않는다)."""
    idx = os.path.join(HERE, 'index.html')
    h = io.open(idx, encoding='utf-8').read()
    pat = re.compile(r'(<script type="application/json" id="AX_DOCS">).*?(</script>)', re.S)
    if not pat.search(h):
        print('index.html 에 AX_DOCS 블록이 없습니다 — 뷰어가 먼저 들어가 있어야 합니다')
        return None
    before = os.path.getsize(idx)
    # 함수형 치환 — payload 안의 백슬래시가 역참조로 해석되지 않는다
    h = pat.sub(lambda m: m.group(1) + payload + m.group(2), h, count=1)
    io.open(idx, 'w', encoding='utf-8', newline='').write(h)
    return before, os.path.getsize(idx)


def clear():
    """전달본 데이터를 비운다 — index.html 을 가볍게 만들어 편집(대시보드 갱신)할 때 쓴다.
       비운 상태에서도 화면은 정상이며, 카드는 기존 클린 URL 링크로 동작한다."""
    r = _write_block('{"built":"","site":"","docs":{},"routes":{}}')
    if r is None:
        return 1
    print('AX_DOCS 비움: index.html %.0fKB → %.0fKB — 편집이 끝나면 다시 빌드하세요'
          % (r[0] / 1024, r[1] / 1024))
    return 0


def build():
    docs, asofs = {}, []
    for key, group, label, title, route, rel in DOCS:
        src = os.path.join(REPO, rel.replace('/', os.sep))
        if not os.path.exists(src):
            print('  skip(없음):', rel)
            continue
        raw = _md_to_html(src, title) if src.lower().endswith('.md') \
            else io.open(src, encoding='utf-8').read()

        m = _ASOF.search(raw)
        asof = m.group(1) if m else datetime.fromtimestamp(os.path.getmtime(src)).strftime('%Y-%m-%d')
        asofs.append(asof)

        folder = os.path.dirname(rel)
        html = _prep(raw, route, folder)
        b64 = base64.b64encode(html.encode('utf-8')).decode('ascii')
        docs[key] = {'group': group, 'label': label, 'title': title,
                     'note': '갱신 ' + asof, 'route': route or '', 'b64': b64}
        print('  담음: [%s] %-24s %7.1fKB → b64 %7.1fKB  (갱신 %s)'
              % (group, label, len(html.encode('utf-8')) / 1024, len(b64) / 1024, asof))

    if not docs:
        print('담을 문서가 없습니다 — 중단')
        return 1

    payload = json.dumps({'built': max(asofs), 'site': SITE, 'docs': docs,
                          'routes': {r: k for r, k in ROUTES.items() if k in docs}},
                         ensure_ascii=False, separators=(',', ':'))
    assert '</script>' not in payload, '문서 데이터에 </script> 가 들어 있습니다'

    r = _write_block(payload)
    if r is None:
        return 1
    groups = {}
    for d in docs.values():
        groups[d['group']] = groups.get(d['group'], 0) + 1
    print('---')
    print('내장 문서 %d종 (%s) · 문서 기준 %s'
          % (len(docs), ' · '.join('%s %d' % (g, n) for g, n in groups.items()), max(asofs)))
    print('index.html %.0fKB → %.0fKB (이 파일 하나만 전달하면 전문이 열립니다)' % (r[0] / 1024, r[1] / 1024))
    return 0


if __name__ == '__main__':
    if '--clear' in sys.argv:
        print('[관리체계 단일 파일 전달본 — 데이터 비우기]')
        sys.exit(clear())
    print('[관리체계 단일 파일 전달본 빌드]')
    sys.exit(build())
