# -*- coding: utf-8 -*-
"""
문서/13_NAS_고도화/ 폴더의 각 .md 를 공유 스타일 HTML 로 변환한다.
공통 로직은 문서/00_관리체계/lib/_html_builder.py(단일 출처). 여기서는 문서 목록·라벨만 정의한다.
사용: python _build_html.py
주의: PoC 원본(claude_*.md)은 내부 IP 가 있어 빌드·배포 대상에서 제외한다.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '00_관리체계', 'lib'))
from _html_builder import build_docs  # noqa: E402

DOCS = [
    ("00_NAS연계_타당성검토",   "00 타당성검토", "PoC 분석·데이터 4종 적합도·문제점·종합 판정"),
    ("01_NAS_데이터계층_기획",   "01 데이터계층 기획", "아웃바운드 전용 구조·워커·데이터별 설계·단계·결정"),
]

if __name__ == '__main__':
    build_docs(
        HERE, DOCS,
        doc_label='JEIL AX NAS 고도화 · 대외비',
        title_mid='JEIL AX NAS 고도화',
        footer_left='JEIL M&S · 사내 NAS 연계',
        hub_label='NAS 고도화',
        hub_dashboard_label='NAS 고도화',
    )
