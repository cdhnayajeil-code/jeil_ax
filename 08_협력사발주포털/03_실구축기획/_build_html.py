# -*- coding: utf-8 -*-
"""
03_실구축기획 폴더의 각 .md 를 공유 스타일 HTML 로 변환한다.
기존 '실제구축준비 자료' 문서와 동일한 톤(네이비/콜아웃/표 스타일)을 따른다.
사용: python _build_html.py
"""
import os, re, markdown

HERE = os.path.dirname(os.path.abspath(__file__))

DOCS = [
    ("00_CTO종합기획_실행개요",            "00 종합기획", "전체 그림·핵심 결정·로드맵 요약"),
    ("01_아키텍처_데이터흐름_연계설계",      "01 아키텍처", "3계층·읽기/쓰기 분리·인증 경계 이중화"),
    ("02_데이터모델_ERP매핑_포털스키마",     "02 데이터모델", "ERP 매핑·포털 쓰기 스키마·10단계 상태머신"),
    ("03_협력사인증_권한_행수준보안_보안",   "03 인증·보안", "인증 2안·RBAC/RLS·파일 검증·감사"),
    ("04_실시간동기화_API_파일업로드_알림",  "04 동기화·API", "localStorage 대체·API 명세·SSE·알림"),
    ("05_사전정의_의사결정_유니포인트협의_체크리스트", "05 사전정의", "결정·협의·체크리스트"),
    ("06_로드맵_단계별실행_운영전환",        "06 로드맵", "데모→파일럿→오픈·운영·DR"),
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
    items=[]
    for slug,label,_ in DOCS:
        cls=' class="cur"' if slug==cur_slug else ''
        items.append(f'<a{cls} href="{slug}.html">{label}</a>')
    items.append('<a href="README.md">README</a>')
    return '<div class="docnav">'+''.join(items)+'</div>'

def build():
    md=markdown.Markdown(extensions=['tables','fenced_code','toc','sane_lists'])
    for slug,label,sub in DOCS:
        src=os.path.join(HERE,slug+'.md')
        if not os.path.exists(src):
            print('skip(없음):',slug); continue
        text=open(src,encoding='utf-8').read()
        md.reset()
        body=md.convert(text)
        html=f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{label} — 협력사 발주·검사 포털 ERP연계 실구축 기획</title>
<style>{CSS}</style>
</head>
<body>
<div class="page">
  <span class="doc-label">협력사 포털 실구축 기획 · 대외비</span>
  {nav_html(slug)}
  <p class="md-link">📄 Markdown 원본: <a href="{slug}.md">{slug}.md</a> · 상위 <a href="../00_종합정리_요구사항이력.html">08 종합정리</a></p>
  <div class="content">
{body}
  </div>
  <div class="footer"><span>JEIL M&amp;S · 협력사 발주·검사 포털 실구축 기획</span><span>{label} · 2026-06-26 · 최동혁</span></div>
</div>
</body>
</html>"""
        out=os.path.join(HERE,slug+'.html')
        open(out,'w',encoding='utf-8').write(html)
        print('built:',slug+'.html')

if __name__=='__main__':
    build()
