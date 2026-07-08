# -*- coding: utf-8 -*-
"""
10_ERP_DB연계/ 폴더의 각 .md 를 공유 스타일 HTML 로 변환한다.
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
    ("00_현재상태_스냅샷", "00 현재상태", "ERP DB 연계 현황 대장(지속 갱신)"),
    ("01_연계기획",        "01 연계기획", "타부서 개방 + 포털·챗봇 중간DB 통합 기획"),
    ("02_진행상태",        "02 진행상태", "페이즈·체크리스트·작업로그(지속 갱신)"),
    ("03_중간DB_구축실행기획", "03 중간DB 실행기획", "중간 DB 연결 방안·처리방법·준비사항 상세"),
    ("04_증분동기화_확장_거버넌스_기획", "04 증분·확장·거버넌스", "증분 동기화·대용량 확장·권한 거버넌스 방향"),
    ("05_사용자부서_매핑대사", "05 사용자-부서 매핑", "Z_USR_MAST_REC 이메일 SSOT ↔ 부서 대사·매핑"),
]

if __name__ == '__main__':
    build_docs(
        HERE, DOCS,
        doc_label='JEIL AX ERP DB 연계 · 대외비',
        title_mid='ERP DB 연계 관제',
        footer_left='JEIL M&amp;S · ERP DB 연계 관제',
        hub_label='연계 허브',
        hub_dashboard_label='연계 허브',
    )
