# -*- coding: utf-8 -*-
"""reg_parse.py — 사내규정 본문을 조문 단위로 자르는 규칙 파서 (REQ-0124 · 순수 파이썬 · 모델 호출 없음)

왜 규칙인가
  규정은 「제N장 · 제N절 · 제N조(제목) · 부칙」 꼴이 정해져 있어 정규식으로 충분하고, 결과가 결정적이라
  같은 원본이면 같은 조문이 나온다(재생성 가능한 파생 사본 — 포털 DB `reg_*` 의 전제). LLM 추출(§19 doc_data)과
  섞지 않는다.

입력·출력
  parse(text, hint_title=None) → {
    "status": "ok" | "partial" | "fallback",   # 조 3개 이상·순서 정상 = ok · 조 1~2개·번호 역행·중복 = partial · 조 0 = fallback(전문 1조문)
    "version": "p1.0",
    "meta": {name, enact_date, revise_date, effective_date, revision_no, owner_dept},   # 날짜는 'YYYY-MM-DD' 또는 None
    "articles": [{seq, chapter, section, article_no, title, body, amended_tag, amend_history, is_deleted}],
    "warnings": [...], "stats": {lines, articles, chapters, addendum}}

규칙 요지
  · 줄 단위로 읽는다. 빈 줄·쪽 번호(「- 1 -」「3/12」)는 버리고 공백은 한 칸으로.
  · 첫 장/조 이전 블록이 머리말 — 규정 이름(…규정|규칙|지침|세칙|요령|기준 으로 끝나는 첫 줄)·제정/개정/시행일·개정 차수·소관부서.
  · 「제N조의M(제목)」 가 조의 시작. 본문 안의 참조(「제3조에 따라」)가 줄 머리에 오면 번호가 직전 조 이하이므로 새 조로 보지 않는다.
  · 「부칙」 뒤의 조·항목은 article_no="부칙-N". 부칙이 여러 번 나오면 chapter 를 「부칙(2)」 처럼 구분한다.
  · 조마다 「<개정 2024.1.1>」 같은 꼬리표를 모은다(amended_tag=첫 꼬리표 원문 · amend_history=전부). 본문이 삭제 꼬리표뿐이면 is_deleted.
  · 시행일 우선순위: 「…부터 시행」 > 「시행일」 > 개정일 > 제정일. 아무것도 없으면 None(적재 측이 게시일로 보완하고 warnings 에 남긴다).
  · 조문 본문은 20,000자(DB CHECK)까지. 넘으면 같은 조를 seq 를 나눠 이어 붙이고 warning.

본문 출처 고르기(choose_source) — 게시물 본문 vs 첨부 글자
  읽힌 첨부 중 조문이 3개 이상 나오는 것이 있으면 그 첨부(조문 수 최다 · 동률이면 hwp > hwpx > docx > pdf)가 원천,
  아니면 게시물 본문(조문 3개 이상), 둘 다 아니면 더 긴 쪽을 fallback 1조문으로. 양식 xlsx 처럼 조문이 없는 첨부는 후보가 아니다.

reg_key(board_key, name) — 같은 규정의 여러 게시물(개정 공지)을 묶는 힌트. 제목에서 개정·시행·날짜·차수 토큰을 빼고 공백을 지운다.
  문서는 게시물당 1건이고, 현행 판(is_current)은 DB 가 시행일로 고른다 — 제목만으로 합치는 추측을 하지 않는다.
"""
import re

PARSE_VERSION = "p1.0"
MAX_ARTICLE_CHARS = 20_000
MAX_TEXT_CHARS = 1_500_000
MIN_ARTICLES_OK = 3

_D = r"(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?"
RX_DATE = re.compile(_D)
RX_CHAPTER = re.compile(r"^제\s*(\d{1,3})\s*장(?![가-힣\d])\s*(.*)$")
RX_SECTION = re.compile(r"^제\s*(\d{1,3})\s*절(?![가-힣\d])\s*(.*)$")
RX_ARTICLE = re.compile(r"^제\s*(\d{1,4})\s*조(?:\s*의\s*(\d{1,3}))?(?=\s*[\(（\[【]|\s|$)"
                        r"(?:\s*[\(（\[【]\s*([^)）\]】]{1,80}?)\s*[\)）\]】])?\s*(.*)$")
RX_ADDENDUM = re.compile(r"^부\s*칙(?:\s*[\(（<〈\[【]\s*([^)）>〉\]】]*)\s*[\)）>〉\]】])?\s*$")
RX_AMEND = re.compile(r"[<〈\(（\[【]\s*(전문개정|전부개정|일부개정|개정|신설|삭제|제정|변경)\s*([\d.\s년월일,~\-/]*?)\s*[>〉\)）\]】]")
RX_META = re.compile(r"(제정|시행|최종\s*개정|전면\s*개정|전부\s*개정|일부\s*개정|개정|공포)\s*(?:일자|년월일|일)?\s*[:：]?\s*" + _D)
RX_EFFECTIVE = re.compile(_D + r"\s*부터\s*시행")
RX_REVNO = re.compile(r"(?:제\s*)?(\d{1,3})\s*차\s*개정|개정\s*(?:제\s*)?(\d{1,3})\s*(?:차|회|판)")
RX_OWNER = re.compile(r"(?:주관|소관|관리|담당)\s*(?:부서|팀)\s*[:：]?\s*([가-힣A-Za-z0-9&]+(?:팀|부문|본부|실|센터|부))")
RX_NOISE = re.compile(r"^[-–—]\s*\d{1,3}\s*[-–—]$|^\d{1,3}\s*/\s*\d{1,3}$|^\d{1,3}$|^\(?\d{1,3}\)?\s*쪽$")
RX_ITEM_START = re.compile(r"^(?:(\d{1,2})\s*[.)]|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s+")
RX_NAME_END = re.compile(r"(규정|규칙|지침|세칙|요령|기준|준칙|강령|헌장|방침|절차서|매뉴얼|내규)\s*$")
RX_DELETED_BODY = re.compile(r"^\s*(?:삭제|\(삭제\)|<삭제[^>]*>|〈삭제[^〉]*〉)?\s*$")
_CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"


def _date(m, g0=1):
    """RX_DATE 매치 → 'YYYY-MM-DD'. 달·날이 범위 밖이면 None."""
    try:
        y, mo, d = int(m.group(g0)), int(m.group(g0 + 1)), int(m.group(g0 + 2))
    except (TypeError, ValueError):
        return None
    if not (1990 <= y <= 2100 and 1 <= mo <= 12 and 1 <= d <= 31):
        return None
    return "%04d-%02d-%02d" % (y, mo, d)


def _lines(text):
    out = []
    for raw in (text or "")[:MAX_TEXT_CHARS].splitlines():
        ln = re.sub(r"[ \t　]+", " ", raw).strip()
        if not ln or RX_NOISE.match(ln):
            continue
        out.append(ln)
    return out


def _clean_name(line):
    s = re.sub(r"^[\[【(（][^\]】)）]{0,20}[\]】)）]\s*", "", line)      # 머리의 [인사]·【총무】 꼬리표
    s = re.sub(r"[\[【(（<〈][^\]】)）>〉]*(?:개정|시행|제정|차|\d{4})[^\]】)）>〉]*[\]】)）>〉]", "", s)
    return re.sub(r"\s+", " ", s).strip(" -·:：")


def name_norm(name):
    """제목 → 묶음 키 조각. 개정·시행·날짜·차수·안내 토큰과 괄호·공백·기호를 뺀다."""
    s = str(name or "")
    s = re.sub(r"[\[【(（<〈][^\]】)）>〉]*[\]】)）>〉]", " ", s)                 # 괄호 묶음 전부
    s = re.sub(r"(전문개정|전부개정|일부개정|개정|신설|제정|시행|공지|안내|알림|변경|배포|게시|수정|최종|확정|ver\.?\s*\d+(?:\.\d+)*|v\d+(?:\.\d+)*|\d{1,3}\s*차|\d{4}\s*[.\-/년]\s*\d{1,2}(?:\s*[.\-/월]\s*\d{1,2}\s*일?)?|\d{4}년)", " ", s, flags=re.I)
    s = re.sub(r"[\s\-_—–·.,/:：;'\"“”‘’!?~※★☆■□◆◇▶▷○●()\[\]【】<>〈〉]+", "", s)
    return s.lower()


def reg_key(board_key, name):
    return "%s:%s" % (str(board_key or "").strip(), name_norm(name) or "untitled")


def _meta_from(lines, hint_title):
    meta = {"name": None, "enact_date": None, "revise_date": None, "effective_date": None,
            "revision_no": None, "owner_dept": None}
    head = lines[:40]
    for ln in head:
        if RX_NAME_END.search(ln) and len(ln) <= 60 and not RX_ARTICLE.match(ln) and not RX_CHAPTER.match(ln):
            meta["name"] = _clean_name(ln)
            break
    if not meta["name"] and hint_title:
        meta["name"] = _clean_name(hint_title) or str(hint_title).strip()
    revise_dates = []
    for ln in lines:
        for m in RX_META.finditer(ln):
            kind, d = m.group(1).replace(" ", ""), _date(m, 2)
            if not d:
                continue
            if kind == "제정":
                meta["enact_date"] = meta["enact_date"] or d
            elif kind == "시행":
                meta["effective_date"] = meta["effective_date"] or d
            elif kind == "공포":
                meta["effective_date"] = meta["effective_date"] or d
            else:
                revise_dates.append(d)
        m = RX_EFFECTIVE.search(ln)
        if m:
            d = _date(m, 1)
            if d:
                meta["effective_date"] = d if "부터 시행" in ln else (meta["effective_date"] or d)
        m = RX_REVNO.search(ln)
        if m and meta["revision_no"] is None:
            meta["revision_no"] = int(m.group(1) or m.group(2))
        m = RX_OWNER.search(ln)
        if m and not meta["owner_dept"]:
            meta["owner_dept"] = m.group(1)
    if revise_dates:
        meta["revise_date"] = max(revise_dates)
    if not meta["effective_date"]:
        meta["effective_date"] = meta["revise_date"] or meta["enact_date"]
    return meta


def _amend_tags(text):
    hist, first = [], None
    for m in RX_AMEND.finditer(text or ""):
        tag = m.group(0).strip()
        first = first or tag
        hist.append({"kind": m.group(1), "date_text": re.sub(r"\s+", "", m.group(2) or "")})
    return first, hist


def _article_sort_value(no, sub):
    return int(no) * 1000 + (int(sub) if sub else 0)


class _Cursor:
    def __init__(self):
        self.chapter = None
        self.section = None
        self.addendum = 0            # 몇 번째 부칙 안에 있나(0 = 본칙)
        self.addendum_item = 0
        self.cur = None
        self.articles = []
        self.warnings = []
        self.last_val = -1
        self.skipped = 0
        self.dup = 0
        self.regress = 0

    def start(self, article_no, title, rest, is_addendum=False):
        self.flush()
        self.cur = {"chapter": self.chapter, "section": self.section, "article_no": article_no,
                    "title": (title or "").strip() or None, "lines": [], "head": ""}
        if rest:
            self.cur["lines"].append(rest.strip())
        if not is_addendum:
            try:
                base = int(str(article_no).split("의")[0])
                sub = int(str(article_no).split("의")[1]) if "의" in str(article_no) else 0
                v = base * 1000 + sub
            except ValueError:
                v = self.last_val
            if v == self.last_val:
                self.dup += 1
            elif v < self.last_val:
                self.regress += 1
            elif self.last_val >= 0 and (v // 1000) - (self.last_val // 1000) >= 5:
                self.skipped += 1
            self.last_val = max(self.last_val, v)

    def add(self, ln):
        if self.cur is None:
            self.cur = {"chapter": self.chapter, "section": self.section, "article_no": None,
                        "title": "(전문)", "lines": [], "head": ""}
        self.cur["lines"].append(ln)

    def flush(self):
        if self.cur is None:
            return
        c = self.cur
        self.cur = None
        body = "\n".join(c["lines"]).strip()
        tag, hist = _amend_tags((c["title"] or "") + "\n" + body)
        stripped = RX_AMEND.sub("", body).strip()
        deleted = bool(hist) and any(h["kind"] == "삭제" for h in hist) and RX_DELETED_BODY.match(stripped) is not None
        if not body and not deleted and c["article_no"] is None:
            return
        base = {"chapter": c["chapter"], "section": c["section"], "article_no": c["article_no"],
                "title": c["title"], "amended_tag": tag, "amend_history": hist, "is_deleted": deleted}
        if len(body) <= MAX_ARTICLE_CHARS:
            self.articles.append(dict(base, body=body))
            return
        self.warnings.append("조문 본문이 %d자를 넘어 나눔: %s" % (MAX_ARTICLE_CHARS, c["article_no"] or c["title"]))
        pos, part = 0, 1
        while pos < len(body):
            chunk = body[pos:pos + MAX_ARTICLE_CHARS]
            cut = chunk.rfind("\n") if pos + MAX_ARTICLE_CHARS < len(body) else -1
            if cut > MAX_ARTICLE_CHARS // 2:
                chunk = chunk[:cut]
            t = base["title"] if part == 1 else "%s (이어서 %d)" % (base["title"] or "", part)
            self.articles.append(dict(base, title=t, body=chunk.strip()))
            pos += len(chunk)
            part += 1


def parse(text, hint_title=None):
    lines = _lines(text)
    meta = _meta_from(lines, hint_title)
    cur = _Cursor()
    started = False
    for ln in lines:
        m = RX_ADDENDUM.match(ln)
        if m:
            cur.flush()
            cur.addendum += 1
            cur.addendum_item = 0
            cur.chapter = "부칙" if cur.addendum == 1 else "부칙(%d)" % cur.addendum
            cur.section = None
            if m.group(1):
                cur.warnings.append("부칙 꼬리표: %s" % m.group(1).strip())
            started = True
            continue
        if cur.addendum == 0:
            m = RX_CHAPTER.match(ln)
            if m:
                cur.flush()
                cur.chapter = ("제%s장 %s" % (m.group(1), m.group(2).strip())).strip()
                cur.section = None
                started = True
                continue
            m = RX_SECTION.match(ln)
            if m:
                cur.flush()
                cur.section = ("제%s절 %s" % (m.group(1), m.group(2).strip())).strip()
                started = True
                continue
        m = RX_ARTICLE.match(ln)
        if m:
            no = m.group(1) + ("의%s" % m.group(2) if m.group(2) else "")
            title, rest = m.group(3), m.group(4)
            if cur.addendum:
                cur.addendum_item += 1
                cur.start("부칙-%s" % no if cur.addendum == 1 else "부칙%d-%s" % (cur.addendum, no), title, rest, True)
                started = True
                continue
            v = _article_sort_value(m.group(1), m.group(2))
            # 줄 머리의 참조(「제3조에 따라」)는 번호가 직전 조 이하다 — 새 조가 아니라 본문으로 둔다
            if started and cur.cur is not None and v <= cur.last_val and not (title or "").strip():
                cur.add(ln)
                continue
            cur.start(no, title, rest)
            started = True
            continue
        if cur.addendum:
            im = RX_ITEM_START.match(ln)
            if im and (cur.cur is None or not str(cur.cur.get("article_no") or "").startswith("부칙")
                       or cur.addendum_item == 0 or im.group(1)):
                cur.addendum_item += 1
                label = "부칙-%d" % cur.addendum_item if cur.addendum == 1 else "부칙%d-%d" % (cur.addendum, cur.addendum_item)
                cur.start(label, None, ln[im.end():], True)
                continue
            if cur.cur is None or not str(cur.cur.get("article_no") or "").startswith("부칙"):
                cur.addendum_item += 1
                cur.start("부칙-%d" % cur.addendum_item if cur.addendum == 1 else "부칙%d-%d" % (cur.addendum, cur.addendum_item),
                          None, ln, True)
                continue
        if started:
            cur.add(ln)
        # 첫 장/조 이전의 머리말(규정 이름·제정일·소관부서)은 meta 가 가져갔다 — 조문으로 두지 않는다
    cur.flush()
    arts = cur.articles
    main_cnt = sum(1 for a in arts if a["article_no"] and not str(a["article_no"]).startswith("부칙"))
    add_cnt = sum(1 for a in arts if str(a["article_no"] or "").startswith("부칙"))
    warnings = list(cur.warnings)
    if main_cnt == 0:
        status = "fallback"
        whole = "\n".join(lines).strip()
        arts = [{"chapter": None, "section": None, "article_no": None, "title": "(전문)", "body": whole[:MAX_ARTICLE_CHARS],
                 "amended_tag": None, "amend_history": [], "is_deleted": False}] if whole else []
        if whole and len(whole) > MAX_ARTICLE_CHARS:
            warnings.append("전문이 %d자를 넘어 잘림" % MAX_ARTICLE_CHARS)
        warnings.append("조문 구조를 찾지 못해 전문 1조문으로 둠")
    else:
        status = "ok"
        if main_cnt < MIN_ARTICLES_OK:
            status, _ = "partial", warnings.append("조문이 %d개뿐" % main_cnt)
        if cur.regress:
            status, _ = "partial", warnings.append("조 번호 역행 %d회" % cur.regress)
        if cur.dup:
            status, _ = "partial", warnings.append("조 번호 중복 %d회" % cur.dup)
        if cur.skipped:
            status, _ = "partial", warnings.append("조 번호 5 이상 건너뜀 %d회" % cur.skipped)
    if not meta["effective_date"]:
        warnings.append("시행일·개정일·제정일을 찾지 못함(게시일로 보완)")
    for i, a in enumerate(arts, 1):
        a["seq"] = i
    chapters = len({a["chapter"] for a in arts if a["chapter"] and not str(a["chapter"]).startswith("부칙")})
    return {"status": status, "version": PARSE_VERSION, "meta": meta, "articles": arts, "warnings": warnings,
            "stats": {"lines": len(lines), "articles": main_cnt, "chapters": chapters, "addendum": add_cnt}}


_EXT_RANK = {".hwp": 0, ".hwpx": 1, ".docx": 2, ".pdf": 3}


def choose_source(body_text, attachments, hint_title=None):
    """(text_source, parse_result, source_index). attachments = [{"name","text"}] (text None 은 후보 아님)."""
    cands = []
    for i, att in enumerate(attachments or []):
        txt = (att or {}).get("text")
        if not txt:
            continue
        name = str(att.get("name") or "")
        ext = name[name.rfind("."):].lower() if "." in name else ""
        r = parse(txt, hint_title)
        if r["stats"]["articles"] >= MIN_ARTICLES_OK:
            cands.append((-r["stats"]["articles"], _EXT_RANK.get(ext, 9), i, name, r))
    if cands:
        cands.sort(key=lambda c: (c[0], c[1], c[2]))
        _, _, i, name, r = cands[0]
        return "attachment:%s" % name, r, i
    rb = parse(body_text or "", hint_title) if body_text else None
    if rb and rb["stats"]["articles"] >= MIN_ARTICLES_OK:
        return "body", rb, None
    # 둘 다 조문 구조가 없다 — 더 긴 쪽을 fallback 으로
    best_att = None
    for i, att in enumerate(attachments or []):
        txt = (att or {}).get("text")
        if txt and (best_att is None or len(txt) > len(attachments[best_att]["text"])):
            best_att = i
    if best_att is not None and len(attachments[best_att]["text"]) > len(body_text or ""):
        name = str(attachments[best_att].get("name") or "")
        return "attachment:%s" % name, parse(attachments[best_att]["text"], hint_title), best_att
    return "body", (rb or parse("", hint_title)), None
