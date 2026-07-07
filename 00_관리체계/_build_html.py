# -*- coding: utf-8 -*-
"""
00_관리체계/ 폴더의 각 .md 를 공유 스타일 HTML 로 변환한다.
공통 로직은 lib/_html_builder.py(단일 출처). 여기서는 문서 목록·라벨만 정의한다.
사용: python _build_html.py
주의: index.html 은 자체완결 대시보드라 빌드 대상에서 제외(직접 관리).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))
from _html_builder import build_docs  # noqa: E402

DOCS = [
    ("00_문서대장",            "00 문서대장", "전체 문서 인덱스·상태·갱신일"),
    ("01_기준정보_레지스트리", "01 기준정보", "조직·권한·ERP매핑·프로세스·환경 마스터"),
    ("02_명명규칙_폴더규약",   "02 명명규칙", "파일/폴더 규칙·예외·README 템플릿"),
    ("03_변경관리_CHANGELOG",  "03 변경관리", "전체 변경이력·문서 수명주기"),
]

if __name__ == '__main__':
    build_docs(
        HERE, DOCS,
        doc_label='JEIL AX 관리체계 · 대외비',
        title_mid='JEIL AX 관리체계',
        footer_left='JEIL M&S · AI 포털 관리체계',
        hub_label='관리체계 허브',
        hub_dashboard_label='관리체계 대시보드',
    )
