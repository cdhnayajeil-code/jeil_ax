# -*- coding: utf-8 -*-
"""
11_제품기획/ 폴더의 각 .md 를 공유 스타일 HTML 로 변환한다.
공통 로직은 00_관리체계/lib/_html_builder.py(단일 출처). 여기서는 문서 목록·라벨만 정의한다.
사용: python _build_html.py
주의: index.html 은 자체완결 허브라 빌드 대상에서 제외(직접 관리).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '00_관리체계', 'lib'))
from _html_builder import build_docs  # noqa: E402

DOCS = [
    ("00_제품기획_개요",           "00 개요",     "비전·범위·문서지도·용어집"),
    ("01_PRD_제품요구사항정의",     "01 PRD",      "목표·페르소나·유스케이스·성공지표"),
    ("02_SRS_요구사항명세",         "02 SRS",      "기능요구 FR·상태머신·추적매트릭스"),
    ("03_시스템아키텍처_설계",       "03 아키텍처", "3계층·컴포넌트·인증·배포·어댑터경계"),
    ("04_데이터베이스_설계",         "04 DB설계",   "스키마3분할·ERD·RLS매트릭스·RPC"),
    ("05_프론트엔드_백엔드_설계",     "05 FE·BE",    "모듈구조·화면·Edge Function 명세"),
    ("06_ERP연계_챗봇활용_설계",     "06 ERP연계",  "P4연결·챗봇Tool확장·부서대시보드"),
    ("07_마이그레이션_Azure이관_설계", "07 이관",   "Supabase↔Azure매핑·어댑터교체·롤백"),
    ("08_보안_데이터안정성",         "08 보안",     "위협모델·라이브실측·시크릿·DR"),
    ("09_ADR_의사결정기록",         "09 ADR",      "확정결정·미결정·발견이슈"),
]

if __name__ == '__main__':
    build_docs(
        HERE, DOCS,
        doc_label='JEIL AX 제품기획 · 대외비',
        title_mid='JEIL AX 제품기획',
        footer_left='JEIL M&S · AI 포털 제품기획',
        hub_label='제품기획 허브',
        hub_dashboard_label='제품기획 개요',
    )
