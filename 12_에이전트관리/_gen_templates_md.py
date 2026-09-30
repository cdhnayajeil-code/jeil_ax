# -*- coding: utf-8 -*-
"""
app/agent-templates.json(템플릿 단일 출처) → 12_에이전트관리/06_에이전트_템플릿_관리포인트.md 생성.
손으로 06 을 고치지 않는다 — JSON 을 고치고 이 스크립트(또는 _build_html.py)를 돌린다.
사용: python 12_에이전트관리/_gen_templates_md.py   (_build_html.py 가 먼저 호출한다)
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'app', 'agent-templates.json')
OUT = os.path.join(HERE, '06_에이전트_템플릿_관리포인트.md')


def cell(s):
    if isinstance(s, bool):
        s = '켬' if s else '끔'
    elif isinstance(s, (list, tuple)):
        s = ', '.join(str(x) for x in s)
    return str(s if s is not None else '').replace('|', '\\|').replace('\n', ' ')


def table(head, rows):
    out = ['| ' + ' | '.join(head) + ' |', '|' + '---|' * len(head)]
    out += ['| ' + ' | '.join(cell(c) for c in r) + ' |' for r in rows]
    return '\n'.join(out)


def main():
    d = json.load(open(SRC, encoding='utf-8'))
    c, doms = d['common'], d['domains']
    L = []
    L.append('# 06 · 에이전트 템플릿 · 관리 포인트 (생성본)')
    L.append('')
    L.append(f"> 정본은 `app/agent-templates.json`(갱신 {d['updated']}) — 이 문서는 `_gen_templates_md.py` 가 만든다. 손으로 고치지 말 것. "
             "관리 콘솔 `/admin/agents` 「📐 관리 포인트·템플릿」 탭이 같은 파일을 읽어 DB 와 대조한다. "
             "실제 적용값은 DB(`ai_agent`·`ai_agent_version`·`agent_glossary`·`agent_golden`)가 정본이고, 여기는 **기준 세트**다.")
    L.append('')
    L.append('## 1. 이 문서가 답하는 것')
    L.append('')
    L.append('- 새 부서 에이전트를 만들 때 **무엇을 공통으로 가져가고 무엇을 부서별로 채우나** (§2 공통 / §4 부서 세트)')
    L.append('- 운영자가 **주기적으로 봐야 할 관리 포인트와 기준값** (§3) — 콘솔 탭이 같은 기준으로 정상·주의·경고를 판정한다')
    L.append('- 라이브 실측에 쓰는 **표준 테스트 시나리오** (§2-5 · §4-5) — 결과는 `05_품질테스트_대화검증` 에 남긴다')
    L.append('')
    L.append('## 2. 공통 기준 세트(모든 에이전트)')
    L.append('')
    L.append('### 2-1. 운영 기본값')
    L.append('')
    df = d['defaults']
    L.append(table(['항목', '기본값'], [[k, v] for k, v in df.items()]))
    L.append('')
    L.append('### 2-2. 답변 원칙(프롬프트 `answer_rules` 에 들어가는 문장)')
    L.append('')
    L.append('콘솔은 문장 전체가 아니라 **핵심 문구(key)** 가 현재 버전 답변 원칙에 있는지로 반영 여부를 본다 — 담당자가 문장을 다듬어도 깨지지 않게.')
    L.append('')
    L.append(table(['#', '핵심 문구', '문장'], [[r['id'], r['key'], r['text']] for r in c['answer_rules']]))
    L.append('')
    L.append('### 2-3. 안전 규칙(프롬프트가 아니라 **검증 기준** — T-SAFE 시나리오로 확인)')
    L.append('')
    L.append(table(['#', '핵심', '기준'], [[s['id'], s['key'], s['text']] for s in c['safety_rules']]))
    L.append('')
    L.append('### 2-4. 공통 칩 · 공통 용어')
    L.append('')
    L.append(table(['칩', '질문'], [[s['label'], s['q']] for s in c['suggestions']]))
    L.append('')
    L.append(table(['용어', '뜻'], [[g['term'], g['meaning']] for g in c['glossary']]))
    L.append('')
    L.append('### 2-5. 공통 테스트 시나리오')
    L.append('')
    for s in c['test_scenarios']:
        L.append(f"**{s['id']} · {s['title']}** — {s['persona']}  ")
        L.append(f"통과 기준: {s['pass']}")
        L.append('')
        L.append(table(['#', '질문', '기대', '기대 도구'], [[i + 1, q['q'], q['expect'], ', '.join(q.get('expect_tools') or [])] for i, q in enumerate(s['questions'])]))
        L.append('')
    L.append('## 3. 관리 포인트(운영자가 보는 것 — 기준·조치·주기)')
    L.append('')
    L.append('콘솔 「📐 관리 포인트·템플릿」 탭이 이 표 그대로 지금 값을 계산해 **정상·주의·경고** 로 보여 준다. '
             '값의 출처는 `usage`(최근 30일 `agent_turn`) 와 `admin_boot`(버전·구성원·개선 대장) 뿐이라 서버 변경 없이 동작한다.')
    L.append('')
    rows = []
    for m in c['management_points']:
        unit = m.get('unit', '')
        def f(v):
            if v is None:
                return '-'
            return (f"{round(v * 100)}%" if unit == '%' else f"{v}{unit}")
        thr = '-' if m.get('warn') is None else f"{f(m['warn'])} / {f(m['bad'])}" + (' (낮을수록 좋음)' if m.get('lower_is_better') else ' (높을수록 좋음)')
        rows.append([m['id'], m['name'], thr, m['where'], m['action'], m['cadence']])
    L.append(table(['#', '관리 포인트', '기준(주의 / 경고)', '어디서 보나', '조치', '주기'], rows))
    L.append('')
    L.append('## 4. 부서 세트')
    L.append('')
    for key, p in doms.items():
        if key.startswith('_'):
            continue
        L.append(f"### 4-{key} · {p['name']} (`{p['agent_key']}`)")
        L.append('')
        L.append(f"- 도메인 묶음: `{', '.join(p['domains'])}` · 요약: {p['summary']}")
        L.append(f"- 역할 안내: {p['role_prompt']}")
        L.append('')
        L.append('**부서 추가 답변 원칙**')
        L.append('')
        L.append(table(['#', '핵심 문구', '문장'], [[r['id'], r['key'], r['text']] for r in p.get('answer_rules_extra', [])]))
        L.append('')
        L.append(f"**자주 쓰는 질문(칩) {len(p['suggestions'])}개**")
        L.append('')
        L.append(table(['칩', '질문'], [[s['label'], s['q']] for s in p['suggestions']]))
        L.append('')
        L.append(f"**용어집 {len(p['glossary'])}개**(DB `agent_glossary` 스냅샷 — 콘솔에서 빠진 것만 채운다)")
        L.append('')
        L.append(table(['용어', '뜻'], [[g['term'], g['meaning']] for g in p['glossary']]))
        L.append('')
        L.append(f"**골든셋 표준 문항 {len(p['golden'])}개**(기대 도구 · 답 요건)")
        L.append('')
        L.append(table(['#', '질문', '기대 도구', '답 요건'], [[i + 1, g['q'], ', '.join(g.get('expect_tools') or []) or '(도구 없음)', g.get('rules', '')] for i, g in enumerate(p['golden'])]))
        L.append('')
        L.append('**테스트 시나리오**')
        L.append('')
        for s in p.get('test_scenarios', []):
            L.append(f"**{s['id']} · {s['title']}** — {s['persona']}  ")
            L.append(f"통과 기준: {s['pass']}")
            L.append('')
            L.append(table(['#', '질문', '기대', '기대 도구'], [[i + 1, q['q'], q['expect'], ', '.join(q.get('expect_tools') or [])] for i, q in enumerate(s['questions'])]))
            L.append('')
    cand = doms.get('_candidates')
    if cand:
        L.append('## 5. 다음 부서 후보(골격만)')
        L.append('')
        L.append(f"> {cand.get('note', '')}")
        L.append('')
        rows = []
        for k, v in cand.items():
            if k == 'note':
                continue
            rows.append([k, v.get('name', ''), ', '.join(v.get('domains', [])), ' · '.join(s['label'] for s in v.get('suggestions', [])), v.get('note', '')])
        L.append(table(['키', '부서', '도메인 묶음', '칩 후보', '비고'], rows))
        L.append('')
    L.append('## 6. 새 에이전트에 적용하는 순서')
    L.append('')
    L.append('1. `02_개발가이드 §3` 대로 정본 SQL 로 `ai_agent`·`ai_agent_version` v1·`ai_agent_member` 행을 만든다(역할 안내·답변 원칙은 §2-2 + 부서 추가 원칙을 그대로 붙여 넣는다).')
    L.append('2. `app/agent-templates.json` 의 `domains` 에 부서 키를 추가한다(§5 골격 복사).')
    L.append('3. `/admin/agents?agent=<key>` → 「📐 관리 포인트·템플릿」 탭에서 **빠진 용어·골든셋 등록**, 빠진 규칙·칩은 편집기로 옮겨 저장(새 버전 초안 → 회귀 → 관리자 지정).')
    L.append('4. 공통 시나리오(T-SAFE·T-REPORT) + 부서 시나리오로 라이브 실측 → 결과는 `05_품질테스트_대화검증` 형식으로 남긴다.')
    L.append('')
    open(OUT, 'w', encoding='utf-8', newline='\n').write('\n'.join(L) + '\n')
    print('generated:', os.path.basename(OUT))


if __name__ == '__main__':
    main()
