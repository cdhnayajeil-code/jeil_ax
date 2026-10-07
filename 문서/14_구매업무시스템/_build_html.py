# -*- coding: utf-8 -*-
"""
문서/14_구매업무시스템/ 폴더의 각 .md 를 공유 스타일 HTML 로 변환한다.
공통 로직은 문서/00_관리체계/lib/_html_builder.py(단일 출처). 여기서는 문서 목록·라벨만 정의한다.
사용: python _build_html.py
주의: 01_구매업무_프로세스_도식.html 과 index.html 은 직접 쓴 자체완결 문서라 빌드 대상이 아니다.
      실거래 자료가 든 예시 화면은 이 폴더가 아니라 비공개 사례 폴더에 만든다(_build_case.py).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '00_관리체계', 'lib'))
from _html_builder import build_docs  # noqa: E402

DOCS = [
    ("02_현행점검_기존화면_데이터", "02 현행 점검", "8단계 × 기존 화면·데이터 · 결함 · 빈 곳"),
    ("03_구매업무시스템_기획",     "03 시스템 기획", "업무 기준 · 목표 화면 · AI 적용 · 로드맵 · 결정 목록"),
    ("04_예시검증_P05_상태규칙",  "04 예시 검증(P0.5)", "예외 건 4종(선진행·계약금/중도금·분할입고·다업체)으로 상태 규칙 시험 · 규칙 보완 · 결정 5건"),
]

if __name__ == '__main__':
    build_docs(
        HERE, DOCS,
        doc_label='JEIL AX 구매업무시스템',
        title_mid='JEIL AX 구매업무시스템',
        footer_left='JEIL M&S · 구매업무시스템',
        hub_label='구매업무시스템',
        hub_dashboard_label='구매업무시스템 허브',
    )
