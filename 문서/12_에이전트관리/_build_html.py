# -*- coding: utf-8 -*-
"""
문서/12_에이전트관리/ 폴더의 각 .md 를 공유 스타일 HTML 로 변환한다.
공통 로직은 문서/00_관리체계/lib/_html_builder.py(단일 출처). 여기서는 문서 목록·라벨만 정의한다.
사용: python _build_html.py
주의: index.html 은 자체완결 허브라 빌드 대상에서 제외(직접 관리).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '00_관리체계', 'lib'))
from _html_builder import build_docs  # noqa: E402

DOCS = [
    ("00_현재상태",           "00 현재상태", "가동 에이전트·모델·구성원·버전·DB·화면 — 사실만"),
    ("01_운영가이드",          "01 운영가이드", "사용자·담당자·관리자 역할별 사용법과 개선 루프"),
    ("02_개발가이드",          "02 개발가이드", "코드 지도·새 도구/에이전트 추가·배포·보안 원칙"),
    ("03_진행상태_변경이력",     "03 진행상태", "체크리스트·작업 로그·결정 기록"),
    ("04_구매도메인_발주통합LIST", "04 구매도메인", "PR·PU·PO 번호 체계·발주통합 LIST 구조·에이전트 지식 반영"),
    ("05_품질테스트_대화검증",    "05 품질테스트", "실업무 대화 실측 결과·발견·조치 — 시나리오별 로그"),
    ("06_에이전트_템플릿_관리포인트", "06 템플릿·관리포인트", "공통 기준 세트·부서 세트·관리 포인트(생성본 — 정본 app/agent-templates.json)"),
]

if __name__ == '__main__':
    # 06 은 생성본 — 항상 JSON 에서 다시 만든 뒤 빌드한다(손으로 고친 06 은 덮어써진다)
    import _gen_templates_md
    _gen_templates_md.main()
    build_docs(
        HERE, DOCS,
        doc_label='JEIL AX 에이전트관리 · 대외비',
        title_mid='JEIL AX 에이전트관리',
        footer_left='JEIL M&S · 부서 에이전트 관리',
        hub_label='에이전트관리 허브',
        hub_dashboard_label='에이전트관리 허브',
    )
