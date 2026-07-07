# -*- coding: utf-8 -*-
"""
10_ERP_DB연계/ → 사내 OneDrive 정책관리 미러 동기화.

미러 대상 경로는 보안상 저장소에 두지 않고 `.claude/erp_db_mirror.path`(git 제외, 1줄)에서 읽는다.

사용:
    python _sync_mirror.py                              # 02_진행상태만 최신 동기화(항상)
    python _sync_mirror.py --version 0.2 --date 20260710  # + 00·01 버전 사본 추가(의미 있는 개정 시)

규칙(README.md 참조):
- 02_진행상태 → 미러에 버전 없는 단일 파일(ERP_DB연계_진행상태.md/.html) 덮어쓰기.
- 00_현재상태·01_연계기획 → --version 지정 시 ERP_DB연계_<문서명>_v<버전>_<날짜>.md/.html 추가(구버전 보존).
- HTML은 미러에서 자기완결이 되도록 폴더 내 상호링크(docnav·md-link)를 제거해 복사한다.
"""
import argparse
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PATH_FILE = os.path.join(HERE, '..', '.claude', 'erp_db_mirror.path')

DOCS_VERSIONED = [
    ('00_현재상태_스냅샷', 'ERP_DB연계_현재상태'),
    ('01_연계기획',        'ERP_DB연계_기획'),
    ('03_중간DB_구축실행기획', 'ERP_DB연계_중간DB구축기획'),
]
DOC_LIVE = ('02_진행상태', 'ERP_DB연계_진행상태')


def mirror_root():
    if not os.path.exists(PATH_FILE):
        sys.exit('미러 경로 파일이 없습니다: .claude/erp_db_mirror.path (미러 폴더 절대경로 1줄)')
    root = open(PATH_FILE, encoding='utf-8').read().strip()
    if not root:
        sys.exit('.claude/erp_db_mirror.path 가 비어 있습니다.')
    os.makedirs(root, exist_ok=True)
    return root


def strip_nav(html):
    """미러 HTML 자기완결화 — docnav·md-link(폴더 내 상호링크) 제거."""
    html = re.sub(r'<div class="docnav">.*?</div>\s*', '', html, flags=re.S)
    html = re.sub(r'<p class="md-link">.*?</p>\s*', '', html, flags=re.S)
    return html


def copy_doc(slug, out_base, root):
    for ext in ('.md', '.html'):
        src = os.path.join(HERE, slug + ext)
        if not os.path.exists(src):
            print('skip(없음):', slug + ext)
            continue
        text = open(src, encoding='utf-8').read()
        if ext == '.html':
            text = strip_nav(text)
        dst = os.path.join(root, out_base + ext)
        open(dst, 'w', encoding='utf-8').write(text)
        print('sync:', out_base + ext)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--version', help='00·01 버전 사본 버전(예: 0.1)')
    ap.add_argument('--date', help='버전 사본 날짜 YYYYMMDD (–version 과 함께)')
    a = ap.parse_args()

    root = mirror_root()
    copy_doc(*DOC_LIVE, root)

    if a.version:
        if not a.date:
            sys.exit('--version 사용 시 --date YYYYMMDD 도 지정하세요.')
        for slug, base in DOCS_VERSIONED:
            copy_doc(slug, f'{base}_v{a.version}_{a.date}', root)
    print('완료. (정책관리/README.md 프로젝트 표·미러 README 갱신은 별도 확인)')
