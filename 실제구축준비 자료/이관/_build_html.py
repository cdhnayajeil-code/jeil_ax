# -*- coding: utf-8 -*-
"""
실제구축준비 자료/이관/ 폴더의 각 .md 를 공유 스타일 HTML 로 변환한다.
공통 로직은 00_관리체계/lib/_html_builder.py(단일 출처). 여기서는 문서 목록·라벨만 정의한다.
사용: python _build_html.py
주의: index.html 은 자체완결 대시보드라 빌드 대상에서 제외(직접 관리).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', '00_관리체계', 'lib'))
from _html_builder import build_docs  # noqa: E402

DOCS = [
    ("00_현재시스템_상태스냅샷",            "00 현황 스냅샷", "배포·자산·데이터·인증·시크릿 현황 대장(지속 갱신)"),
    ("01_이관실행가이드_Vercel_Supabase",   "01 실행 가이드", "Vercel+Supabase 단계별 이관 디테일 가이드"),
    ("02_Azure이관계획",                   "02 Azure 계획", "Supabase→Azure 운영 전환 매핑·절차·롤백"),
    ("03_이관진행상태",                     "03 진행 상태", "페이즈·체크리스트·작업로그·이슈(지속 갱신)"),
]

if __name__ == '__main__':
    build_docs(
        HERE, DOCS,
        doc_label='JEIL AX 이관 관제 · 대외비',
        title_mid='JEIL AX 이관 관제',
        footer_left='JEIL M&amp;S · AI 포털 이관 관제 센터',
        hub_label='이관 허브',
        hub_dashboard_label='이관 대시보드',
    )
