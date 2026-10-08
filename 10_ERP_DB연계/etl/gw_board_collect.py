# -*- coding: utf-8 -*-
"""gw_board_collect.py — 그룹웨어(ONUL Ware) 게시판의 사내규정 게시물·첨부를 사내 NAS 에 누적하고 포털 DB 에 적재한다
(REQ-0124 · 관리자 결정 2026-10-08 · 사내 PC 예약작업 `JEIL_AX_GwBoard` · Playwright)

흐름
  로그인(gw_session · 시크릿키 강제 로그인은 기본 OFF) → reg_source(DB) 에서 게시판·선택자 로드 → 목록 순회(페이징·증분)
  → 본문 HTML→Markdown · 첨부 다운로드 → 글자 추출(.hwp=hwp_text · 그 밖=nas_index.extract · 주민등록번호 꼴 차단)
  → reg_parse 로 규정 메타·조문 → NAS 쓰기 <docs_root>/00_전사공유/사내규정/<board>/<post>/ (옛 판은 history/)
  → 수집 대장(_ledger.jsonl · _state.json) → DB 적재 rpc reg_ingest_upsert(jsonb · 멱등 · 실패분은 다음 회차 재전송)

정본 서열: 사내규정 정본 = 그룹웨어 게시판(NAS 미러) > 포털 DB reg_*(재생성 가능한 파생 사본). doc_data(§19)와 섞지 않는다.

안전 규칙
  · 게시판 URL·선택자는 코드에 없다 — DB `reg_source`(없으면 gw_board_profile.default.json · --selectors). 벤더 UI 가 바뀌면 프로필만 고친다.
  · 선택자를 못 찾으면 즉시 중단(rc 1 · 스크린샷). 이미 NAS 에 쓴 게시물은 유효하다(게시물 단위 원자 쓰기).
  · 로그인 실패(자격증명)는 재시도하지 않는다. 다른 세션이 쓰는 중(시크릿키)이면 건너뛴다(rc 0 · 표시 안 남김).
  · 주민등록번호 꼴이 든 첨부·본문은 NAS 에도 쓰지 않고 DB 에도 글자를 넣지 않는다(blocked · 사유만).
  · SystemExit 를 던지지 않는다(상주 러너 보호) · 계정·경로·IP 는 로그에 남기지 않는다(nas_worker._redact).
  · 하루 1회 표시(logs/gw_board_nightly.json)는 실패 0건으로 완주했을 때만 남긴다.

사용
  python gw_board_collect.py --probe --headed [--selectors gw_board_profile.default.json]   # 선택자 점검만(다운로드·쓰기 없음)
  python gw_board_collect.py --full --dry-run --max 5 --headed                               # 읽기만
  python gw_board_collect.py --full [--max N] [--docs-root <임시 폴더>]                      # 초기 전량
  python gw_board_collect.py --nightly --log <저장소>\\logs\\gw_board.log                       # 예약작업
"""
import argparse
import contextlib
import datetime
import hashlib
import io
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _env import load_env, env_root  # noqa: E402
import gw_session  # noqa: E402
import hwp_text  # noqa: E402
import nas_index  # noqa: E402
import nas_worker  # noqa: E402
import reg_parse  # noqa: E402

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

COLLECTOR_VERSION = "b1.0"
JOB_NAME = "gw_board"
REGS_REL = "00_전사공유/사내규정"          # D-96 「전사공유 사규」 — 허용 폴더 common(00_전사공유) 아래라 색인·조회 범위에 자동 포함
RATE_SLEEP_SEC = 1.5
MAX_POSTS_PER_RUN = 1500
BUDGET_MIN = 75                          # 예약작업 상한 90분보다 짧게
MAX_ATTACH_BYTES = 50 * 1024 * 1024
ATTACH_EXT_DENY = {".exe", ".bat", ".cmd", ".js", ".vbs", ".msi", ".scr", ".ps1", ".com", ".jar"}
INGEST_CHUNK = 20
UNCHANGED_STREAK_STOP = 20               # nightly: 변화 없는 게시물이 연속 이만큼이면 중단
NIGHTLY_MIN_PAGES = 2
NIGHTLY_HASH_PAGES = 3                   # 목록에 수정일이 없는 게시판은 최근 N페이지 본문 해시 비교
REMOVE_MIN_RATIO = 0.5                   # full 완주 때 본 건수가 활성의 절반 미만이면 삭제 표시 거부
DEFAULT_PROFILE = os.path.join(HERE, "gw_board_profile.default.json")
_KST = datetime.timezone(datetime.timedelta(hours=9))


def _now():
    return datetime.datetime.now(_KST).replace(tzinfo=None)


_LOG = [print]


def log(msg):
    _LOG[0]("[gw-board] %s" % nas_worker._redact(msg))


# ────────────────────────────────────────────────────────────── 설정·경로
def load_profile(path=None):
    p = path or DEFAULT_PROFILE
    with io.open(p, encoding="utf-8") as fh:
        return json.load(fh)


def merge_selectors(base, override):
    """DB reg_source.selectors(부분)로 기본 프로필을 덮는다(한 단계 깊이)."""
    out = json.loads(json.dumps(base))
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k].update(v)
        else:
            out[k] = v
    return out


def rpc(url, key, fn, payload):
    """PostgREST RPC 직결(proposal_ledger.rpc 와 같은 규약 · service_role 은 사내 PC 에만 있다)."""
    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    req = urllib.request.Request(
        "%s/rest/v1/rpc/%s" % (url, fn), data=body, method="POST",
        headers={"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode("utf-8", "replace").strip()
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace").strip()
        except Exception:
            pass
        raise RuntimeError("HTTP %s rpc/%s: %s" % (e.code, fn, nas_worker._redact(detail[:800]))) from e
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return raw.strip('"')


def supabase_creds():
    load_env()
    url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
    if not url or not key:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 없습니다(.env 확인)")
    return url, key


def docs_root(arg=None):
    """문서 루트 — --docs-root > NAS_DOCS_ROOT > .claude/nas_docs.path. 없으면 RuntimeError(수집을 미룬다)."""
    if arg:
        p = os.path.abspath(str(arg).strip().strip('"'))
        if not os.path.isdir(p):
            raise RuntimeError("문서 루트(--docs-root)가 없거나 폴더가 아닙니다")
        return p
    p = nas_worker.nas_docs_root()
    if not p:
        raise RuntimeError("NAS 문서 루트가 보이지 않습니다 — NAS_DOCS_ROOT 또는 .claude/nas_docs.path (오늘 수집을 미룹니다)")
    return p


def regs_root(root):
    return os.path.join(root, *REGS_REL.split("/"))


def _stamp_file():
    return os.path.join(env_root(), "logs", "gw_board_nightly.json")


# ────────────────────────────────────────────────────────────── 순수 함수
class _MD(HTMLParser):
    """리치텍스트 HTML → 읽을 수 있는 Markdown 비슷한 평문. 표는 「| a | b |」, 이미지는 [이미지], 스크립트·스타일은 버린다."""
    _BLOCK = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "ul", "ol", "section", "article", "blockquote", "pre"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.skip = 0
        self.in_cell = False
        self.href = None
        self.list_depth = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("script", "style", "head", "noscript"):
            self.skip += 1
            return
        if self.skip:
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.out.append("\n\n" + "#" * int(tag[1]) + " ")
        elif tag == "li":
            self.out.append("\n" + "  " * max(self.list_depth - 1, 0) + "- ")
        elif tag in ("ul", "ol"):
            self.list_depth += 1
            self.out.append("\n")
        elif tag == "tr":
            self.out.append("\n|")
        elif tag in ("td", "th"):
            self.in_cell = True
            self.out.append(" ")
        elif tag == "br":
            self.out.append("\n")
        elif tag in ("p", "div", "section", "article", "blockquote", "pre", "table"):
            self.out.append("\n")
        elif tag in ("b", "strong"):
            self.out.append("**")
        elif tag == "a":
            self.href = a.get("href")
        elif tag == "img":
            alt = (a.get("alt") or "").strip()
            self.out.append("[이미지%s]" % ((":" + alt) if alt else ""))

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head", "noscript"):
            self.skip = max(self.skip - 1, 0)
            return
        if self.skip:
            return
        if tag in ("td", "th"):
            self.in_cell = False
            self.out.append(" |")
        elif tag in ("ul", "ol"):
            self.list_depth = max(self.list_depth - 1, 0)
            self.out.append("\n")
        elif tag in ("p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "blockquote", "pre", "table"):
            self.out.append("\n")
        elif tag in ("b", "strong"):
            self.out.append("**")
        elif tag == "a":
            if self.href and not str(self.href).lower().startswith(("javascript:", "data:")):
                self.out.append(" (%s)" % self.href)
            self.href = None

    def handle_data(self, data):
        if self.skip:
            return
        self.out.append(re.sub(r"\s+", " ", data))


def html_to_md(html):
    p = _MD()
    try:
        p.feed(html or "")
        p.close()
    except Exception:
        return nas_index._strip_markup(html or "")
    t = "".join(p.out)
    t = re.sub(r"[ \t　]+", " ", t)
    t = re.sub(r" *\n *", "\n", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def body_text_norm(md):
    t = re.sub(r"\*\*|^#+\s*|^\|\s*|\s*\|\s*$", "", md or "", flags=re.M)
    t = re.sub(r"\s*\|\s*", " ", t)
    t = re.sub(r"[ \t　]+", " ", t)
    t = re.sub(r" *\n *", "\n", t)
    return re.sub(r"\n{2,}", "\n", t).strip()


def sha256_text(s):
    return hashlib.sha256((s or "").encode("utf-8")).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def attach_sig(atts):
    items = sorted("%s|%s|%s" % (a.get("file_name"), a.get("size_bytes") or 0, a.get("sha256") or "") for a in atts
                   if a.get("text_status") != "skipped")
    return sha256_text("\n".join(items)) if items else None


def safe_name(name, keep_ext=True):
    """파일 이름 정리 — nas_worker._safe_file_name(금지 글자·경로 제거) + 길이 100자(확장자는 보존)."""
    raw = str(name or "").strip()
    stem, ext = (os.path.splitext(raw) if keep_ext else (raw, ""))
    if not re.match(r"^\.[A-Za-z0-9]{1,10}$", ext or ""):
        stem, ext = raw, ""
    s = (nas_worker._safe_file_name(stem) or "파일").rstrip(". ")
    return s[: max(100 - len(ext), 10)].rstrip(". ") + ext


def post_dir_name(post_no, title):
    pn = str(post_no or "").strip()
    head = pn.zfill(6) if pn.isdigit() else (nas_worker._safe_file_name(pn) or "x")[:20]
    t = safe_name(title, keep_ext=False)[:60].rstrip(". ")
    return "%s_%s" % (head, t) if t else head


def classify_ext(name):
    ext = os.path.splitext(str(name or ""))[1].lower()
    if ext in ATTACH_EXT_DENY:
        return ext, False, "실행 파일 형식은 받지 않음"
    return ext, True, None


def extract_text(path):
    """(글자, 사유). .hwp 는 hwp_text, 그 밖은 nas_index.extract — 둘 다 주민등록번호 꼴 검사는 nas_index 규칙."""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".hwp":
        text, why = hwp_text.extract_hwp(path, nas_index.MAX_TEXT_CHARS)
        if text is None:
            return None, why, "hwp_text " + hwp_text.HWP_TEXT_VERSION
        text = re.sub(r"[ \t　]+", " ", text).strip()
        if nas_index._RRN.search(text):
            return None, "민감 정보 꼴(주민등록번호) 포함", "hwp_text " + hwp_text.HWP_TEXT_VERSION
        return text, None, "hwp_text " + hwp_text.HWP_TEXT_VERSION
    text, why = nas_index.extract(path)
    return text, why, "nas_index " + nas_index.INDEX_VERSION


def _parse_dt(s):
    """목록·상세의 날짜 문자열 → ISO(초 단위, 한국시각 · tz 없이). 못 읽으면 None."""
    s = str(s or "").strip()
    if not s:
        return None
    m = re.search(r"(\d{4})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})(?:\s*일)?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?", s)
    if not m:
        m2 = re.search(r"(\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})", s)
        if not m2:
            return None
        y, mo, d = 2000 + int(m2.group(1)), int(m2.group(2)), int(m2.group(3))
        hh = mi = ss = 0
    else:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        hh, mi, ss = int(m.group(4) or 0), int(m.group(5) or 0), int(m.group(6) or 0)
    try:
        return datetime.datetime(y, mo, d, hh, mi, ss).isoformat(timespec="seconds")
    except ValueError:
        return None


# ────────────────────────────────────────────────────────────── 대장
class Ledger:
    """NAS 쪽 수집 대장. _ledger.jsonl 은 append-only 사건 기록, _state.json 은 현재 판 요약(대장에서 재생성 가능)."""

    def __init__(self, root):
        self.root = root
        self.path = os.path.join(root, "_ledger.jsonl")
        self.state_path = os.path.join(root, "_state.json")
        self.state = {}

    @staticmethod
    def key(board_key, post_no):
        return "%s:%s" % (board_key, post_no)

    def load(self):
        try:
            with io.open(self.state_path, encoding="utf-8") as fh:
                self.state = json.load(fh) or {}
        except Exception:
            self.state = {}
        return self

    def append(self, ev):
        os.makedirs(self.root, exist_ok=True)
        ev = dict(ev)
        ev.setdefault("ts", _now().isoformat(timespec="seconds"))
        with io.open(self.path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(ev, ensure_ascii=False, default=str) + "\n")

    def update(self, board_key, post_no, **fields):
        st = self.state.setdefault(self.key(board_key, post_no), {"board_key": board_key, "post_no": str(post_no)})
        st.update(fields)
        return st

    def save(self):
        os.makedirs(self.root, exist_ok=True)
        tmp = self.state_path + ".tmp"
        with io.open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.state, fh, ensure_ascii=False, indent=0, default=str)
        os.replace(tmp, self.state_path)

    def pending_db(self):
        return [(k, st) for k, st in self.state.items()
                if st.get("status", "active") == "active" and st.get("nas_rel") and not st.get("db_synced")]


# ────────────────────────────────────────────────────────────── NAS 쓰기(원자)
def commit_post_dir(regs, board_key, dir_name, tmp_dir, prev_rel=None, prev_rev=0):
    """tmp_dir 의 내용을 <regs>/<board>/<dir_name>/ 로. 옛 판이 있으면 history/<rev>_<stamp>/ 로 먼저 옮긴다.
    반환: 저장소 기준 상대경로(forward slash)."""
    final = os.path.join(regs, board_key, dir_name)
    if prev_rel:
        root = os.path.dirname(os.path.dirname(regs))          # regs = <root>/00_전사공유/사내규정
        prev_abs = os.path.join(root, *prev_rel.split("/")) if prev_rel.startswith(REGS_REL) \
            else os.path.join(regs, *prev_rel.split("/"))
        if os.path.isdir(prev_abs) and os.path.abspath(prev_abs) != os.path.abspath(final) and not os.path.exists(final):
            os.replace(prev_abs, final)                       # 제목이 바뀌어 폴더 이름이 달라진 경우
    if os.path.isdir(final):
        hist = os.path.join(final, "history", "%02d_%s" % (prev_rev, _now().strftime("%Y%m%d-%H%M")))
        os.makedirs(hist, exist_ok=True)
        for name in os.listdir(final):
            if name == "history":
                continue
            os.replace(os.path.join(final, name), os.path.join(hist, name))
    else:
        os.makedirs(final, exist_ok=True)
    for name in os.listdir(tmp_dir):
        os.replace(os.path.join(tmp_dir, name), os.path.join(final, name))
    shutil.rmtree(tmp_dir, ignore_errors=True)
    return "%s/%s/%s" % (REGS_REL, board_key, dir_name)


# ────────────────────────────────────────────────────────────── 드라이버(DOM 은 여기만)
class BoardDriver:
    """Playwright 페이지 위의 게시판 조작. 선택자는 프로필(sel)에서만 온다."""

    def __init__(self, page, base_url, sel, log_fn=log):
        self.page = page
        self.base = (base_url or "").rstrip("/")
        self.sel = sel
        self.log = log_fn
        self._src = None
        self._last_rows = []

    # 유틸
    def _abs(self, href):
        if not href:
            return None
        if re.match(r"^https?://", href, re.I):
            return href
        return urllib.parse.urljoin(self.page.url if self.page.url and self.page.url != "about:blank" else self.base + "/", href)

    def _text(self, el, css):
        if not css or not el:
            return ""
        try:
            sub = el.query_selector(css)
            return (sub.inner_text() if sub else "").strip()
        except Exception:
            return ""

    def _attr(self, el, css, attr):
        if not el:
            return None
        try:
            sub = el.query_selector(css) if css else el
            return sub.get_attribute(attr) if sub else None
        except Exception:
            return None

    def count(self, css):
        try:
            return self.page.locator(css).count() if css else 0
        except Exception:
            return 0

    # 목록
    def open_list(self, src, page_no):
        self._src = src
        lst = self.sel["list"]
        path = str(src.get("list_path") or "")
        url = self._abs(path) if path.startswith("/") else (self.base + "/" + path.lstrip("/"))
        if page_no and page_no > 1 and lst.get("page_param"):
            url += ("&" if "?" in url else "?") + "%s=%d" % (lst["page_param"], page_no)
        self.page.goto(url, wait_until="domcontentloaded")
        try:
            self.page.wait_for_selector(lst.get("wait") or lst["row"], timeout=15000)
        except Exception:
            pass
        self.page.wait_for_timeout(500)

    def read_rows(self):
        lst = self.sel["list"]
        rows = []
        for el in self.page.query_selector_all(lst["row"]):
            title_el = el.query_selector(lst["title"]) if lst.get("title") else None
            if not title_el:
                continue
            href = title_el.get_attribute(lst.get("link_attr") or "href")
            onclick = title_el.get_attribute("onclick")
            if (not href or href.strip().lower().startswith("javascript")) and not onclick:
                parent = el.query_selector("a[onclick]")
                onclick = parent.get_attribute("onclick") if parent else onclick
            cls = (el.get_attribute("class") or "")
            post_no = self._text(el, lst.get("post_no"))
            link_id = None
            if onclick and lst.get("link_onclick_re"):
                m = re.search(lst["link_onclick_re"], onclick)
                link_id = m.group(1) if m else None
            if not post_no or not post_no.strip().isdigit():
                post_no = post_no.strip() or link_id or ""
            rows.append({
                "post_no": post_no.strip(),
                "title": title_el.inner_text().strip(),
                "author": self._text(el, lst.get("author")),
                "dept": self._text(el, lst.get("dept")),
                "posted_at": _parse_dt(self._text(el, lst.get("posted_at"))),
                "modified_at": _parse_dt(self._text(el, lst.get("modified_at"))) if lst.get("modified_at") else None,
                "has_attach": bool(el.query_selector(lst["attach_flag"])) if lst.get("attach_flag") else None,
                "is_notice": bool(lst.get("notice_class")) and lst["notice_class"] in cls.split(),
                "link": {"href": href if href and not href.strip().lower().startswith("javascript") else None,
                         "onclick": onclick, "id": link_id},
            })
        self._last_rows = rows
        return rows

    def has_next(self):
        css = self.sel["list"].get("next_page")
        if not css:
            return False
        try:
            loc = self.page.locator(css)
            if loc.count() == 0:
                return False
            el = loc.first
            cls = (el.get_attribute("class") or "")
            return "disabled" not in cls and el.is_enabled()
        except Exception:
            return False

    # 상세
    def open_post(self, row):
        link = row.get("link") or {}
        pst = self.sel["post"]
        if link.get("href"):
            self.page.goto(self._abs(link["href"]), wait_until="domcontentloaded")
        elif link.get("onclick"):
            self.page.evaluate(link["onclick"])
        else:
            raise RuntimeError("게시물 링크를 찾지 못했습니다: post_no=%s" % row.get("post_no"))
        try:
            self.page.wait_for_selector(pst.get("wait") or pst["body"], timeout=15000)
        except Exception:
            raise RuntimeError("선택자 없음: post.body (게시물 %s)" % row.get("post_no"))
        self.page.wait_for_timeout(400)

    def read_post(self):
        pst = self.sel["post"]
        body_el = self.page.query_selector(pst["body"])
        if not body_el:
            raise RuntimeError("선택자 없음: post.body")
        atts = []
        a_sel = pst.get("attach") or {}
        if a_sel.get("item"):
            for el in self.page.query_selector_all(a_sel["item"]):
                atts.append({"name": (el.inner_text() or "").strip(),
                             "href": el.get_attribute(a_sel.get("href_attr") or "href"),
                             "onclick": el.get_attribute("onclick"),
                             "size_text": ""})
        t = self.page.query_selector(pst.get("title")) if pst.get("title") else None
        return {
            "title": (t.inner_text().strip() if t else ""),
            "body_html": body_el.inner_html(),
            "posted_at": _parse_dt(self._text(self.page, pst.get("posted_at"))),
            "modified_at": _parse_dt(self._text(self.page, pst.get("modified_at"))) if pst.get("modified_at") else None,
            "author": self._text(self.page, pst.get("author")),
            "dept": self._text(self.page, pst.get("dept")),
            "attachments": [a for a in atts if a["name"]],
            "url": self.page.url,
        }

    def _attach_url(self, att):
        a_sel = (self.sel["post"].get("attach") or {})
        href = att.get("href")
        if href and not str(href).strip().lower().startswith("javascript"):
            return self._abs(href)
        tpl = a_sel.get("url_template")
        if tpl and att.get("onclick") and a_sel.get("onclick_re"):
            m = re.search(a_sel["onclick_re"], att["onclick"])
            if m:
                return self._abs(tpl.replace("{id}", m.group(1)))
        return None

    def download(self, att, dest):
        """{ok, size, name_from_header, reason, mode}. 모드 auto: URL 이 있으면 request, 아니면 download 이벤트."""
        a_sel = (self.sel["post"].get("attach") or {})
        mode = a_sel.get("mode") or "auto"
        url = self._attach_url(att)
        if mode in ("auto", "request") and url:
            try:
                r = self.page.request.get(url, timeout=120000)
                ctype = (r.headers.get("content-type") or "").lower()
                if r.status != 200:
                    return {"ok": False, "reason": "HTTP %d" % r.status, "mode": "request"}
                if ctype.startswith("text/html"):
                    return {"ok": False, "reason": "HTML 응답(로그인 만료·권한 없음)", "mode": "request"}
                data = r.body()
                if len(data) > MAX_ATTACH_BYTES:
                    return {"ok": False, "reason": "파일이 너무 큼", "mode": "request"}
                if not data:
                    return {"ok": False, "reason": "빈 응답", "mode": "request"}
                with open(dest, "wb") as fh:
                    fh.write(data)
                cd = r.headers.get("content-disposition") or ""
                name_hdr = None
                m = re.search(r"filename\*=(?:UTF-8|utf-8)''([^;]+)", cd) or re.search(r'filename="?([^";]+)"?', cd)
                if m:
                    try:
                        name_hdr = urllib.parse.unquote(m.group(1)).strip()
                    except Exception:
                        name_hdr = m.group(1).strip()
                return {"ok": True, "size": len(data), "name_from_header": name_hdr, "reason": None, "mode": "request"}
            except Exception as e:
                if mode == "request":
                    return {"ok": False, "reason": "다운로드 실패(%s)" % type(e).__name__, "mode": "request"}
        if att.get("onclick"):
            try:
                with self.page.expect_download(timeout=60000) as dl:
                    self.page.evaluate(att["onclick"])
                d = dl.value
                d.save_as(dest)
                size = os.path.getsize(dest)
                if size > MAX_ATTACH_BYTES:
                    os.remove(dest)
                    return {"ok": False, "reason": "파일이 너무 큼", "mode": "download"}
                return {"ok": True, "size": size, "name_from_header": d.suggested_filename, "reason": None, "mode": "download"}
            except Exception as e:
                return {"ok": False, "reason": "다운로드 실패(%s)" % type(e).__name__, "mode": "download"}
        return {"ok": False, "reason": "첨부 링크를 URL 로 만들 수 없음", "mode": mode}


def _dig(obj, path, default=None):
    """'data.post.title' 꼴 경로로 dict 를 판다."""
    cur = obj
    for k in str(path or "").split("."):
        if not k:
            continue
        if isinstance(cur, dict) and k in cur:
            cur = cur[k]
        else:
            return default
    return cur


def _parse_api_date(v):
    """ONUL Ware JSON 날짜 — '/Date(1762299644533)/'(ms epoch) 또는 '2025-11-05 08:40' → ISO(한국시각 · tz 없이)."""
    s = str(v or "").strip()
    m = re.match(r"^/Date\((-?\d+)\)/$", s)
    if m:
        try:
            return datetime.datetime.fromtimestamp(int(m.group(1)) / 1000, _KST).replace(tzinfo=None).isoformat(timespec="seconds")
        except (OverflowError, OSError, ValueError):
            return None
    return _parse_dt(s)


class ApiDriver:
    """JSON 끝점 드라이버(Step 0 실측 2026-10-08) — 화면을 긁지 않고 앱이 쓰는 목록·상세·다운로드 끝점을 세션 쿠키로 부른다.

    ONUL Ware 는 로그인 뒤 전체 페이지를 이동하면 SSO 로 되돌아가므로, 로그인한 page 의 request(쿠키 공유)만 쓴다.
    끝점·폼 키·응답 키는 전부 프로필 `api` 절에서 온다(코드에 심지 않는다).
      목록  POST list_path  (bModel[boardID]·page·pageCount·startDate·endDate …) → data.list(+topPosts)·totalCount·pageCount
      상세  POST detail_path (boardPostID) → data.post{contents·writeDateTime·editDateTime·attachments[{fileName·filePath·boardFileID·notFound}]}
      첨부  GET  download_path?fileName&filePath&fileType&fileIDStr (Content-Disposition attachment)
    """

    def __init__(self, page, base_url, sel, log_fn=log):
        self.page = page
        # gw url 에 경로·쿼리(예 /?loginType=…)가 붙어 있어도 끝점은 origin 기준이다
        u = urllib.parse.urlsplit(base_url or "")
        self.base = ("%s://%s" % (u.scheme, u.netloc)) if u.scheme and u.netloc else (base_url or "").rstrip("/")
        self.sel = sel
        self.api = sel.get("api") or {}
        self.log = log_fn
        self._src = None
        self._page_no = 1
        self._rows = []
        self._pages = 1
        self._cur = None
        self._cur_id = None

    def _post(self, path, form):
        r = self.page.request.post(self.base + path, form=form,
                                   headers={"X-Requested-With": "XMLHttpRequest", "Referer": self.base + "/Main"}, timeout=60000)
        if r.status != 200:
            raise RuntimeError("API HTTP %d: %s" % (r.status, path))
        ctype = (r.headers.get("content-type") or "").lower()
        if "json" not in ctype:
            head = re.sub(r"\s+", " ", r.text()[:160]) if hasattr(r, "text") else ""
            raise RuntimeError("API 응답이 JSON 이 아님(로그인 만료·권한?): %s · %s · %s" % (path, ctype[:40], nas_worker._redact(head)))
        return r.json()

    def _board_id(self, src):
        bid = _dig(src.get("selectors") or {}, "api.boardID") or self.api.get("boardID")
        if not bid:
            raise RuntimeError("선택자 없음: api.boardID (게시판 %s)" % src.get("board_key"))
        return str(bid)

    def count(self, css):
        return 1                                            # probe 용 — API 모드는 선택자가 없다

    # 목록
    def open_list(self, src, page_no):
        self._src, self._page_no = src, int(page_no or 1)
        today = _now().strftime("%Y-%m-%d")
        vals = {"boardID": self._board_id(src), "page": str(self._page_no), "pageCount": str(self.api.get("page_size") or 100),
                "startDate": self.api.get("start_date") or "2018-01-01", "endDate": today}
        form = {}
        for k, v in (self.api.get("list_form") or {}).items():
            s = str(v)
            for name, val in vals.items():
                s = s.replace("{" + name + "}", val)
            form[k] = s
        j = self._post(self.api.get("list_path") or str(src.get("list_path") or ""), form)
        lk = self.api.get("list_keys") or {}
        items = _dig(j, lk.get("items", "data.list")) or []
        top = _dig(j, lk.get("top", "data.topPosts")) or []
        self._pages = int(_dig(j, lk.get("pages", "data.pageCount")) or 1)
        ik = self.api.get("item_keys") or {}
        rows, seen = [], set()
        for is_top, lst in ((True, top), (False, items)):
            for it in lst or []:
                pid = str(it.get(ik.get("id", "boardPostID")) or "").strip()
                if not pid or pid in seen:
                    continue
                seen.add(pid)
                fc = it.get(ik.get("file_count", "fileCnt"))
                mc = it.get(ik.get("modified_count", "isHistory"))
                rows.append({
                    "post_no": pid,
                    "title": str(it.get(ik.get("title", "title")) or "").strip(),
                    "author": str(it.get(ik.get("author", "memberName")) or "").strip() or None,
                    "dept": str(it.get(ik.get("dept", "partName")) or "").strip() or None,
                    "posted_at": _parse_api_date(it.get(ik.get("posted_at", "writeDate"))),
                    "modified_at": None,                                   # 목록에는 수정일이 없다 — 수정 횟수(mod_count)로 판정
                    "mod_count": int(mc) if isinstance(mc, (int, float)) or (isinstance(mc, str) and mc.isdigit()) else None,
                    "has_attach": (int(fc) > 0) if isinstance(fc, (int, float)) else None,
                    "is_notice": bool(is_top),
                    "category": it.get(ik.get("category", "categoryName")),
                    "link": {"href": None, "onclick": None, "id": pid},
                })
        self._rows = rows

    def read_rows(self):
        return list(self._rows)

    def has_next(self):
        return self._page_no < self._pages

    # 상세
    def open_post(self, row):
        pid = str((row.get("link") or {}).get("id") or row.get("post_no") or "").strip()
        if not pid:
            raise RuntimeError("게시물 링크를 찾지 못했습니다: post_no=%s" % row.get("post_no"))
        form = {k: str(v).replace("{postID}", pid) for k, v in (self.api.get("detail_form") or {"boardPostID": "{postID}"}).items()}
        j = self._post(self.api.get("detail_path") or "", form)
        dk = self.api.get("detail_keys") or {}
        post = _dig(j, dk.get("post", "data.post"))
        if not isinstance(post, dict):
            raise RuntimeError("선택자 없음: api.detail_keys.post (게시물 %s)" % pid)
        self._cur, self._cur_id = post, pid

    def read_post(self):
        p, dk = self._cur or {}, self.api.get("detail_keys") or {}
        atts = []
        for a in (p.get(dk.get("attachments", "attachments")) or []):
            if not isinstance(a, dict):
                continue
            name = str(a.get(dk.get("file_name", "fileName")) or "").strip()
            if not name:
                continue
            atts.append({"name": name, "href": None, "onclick": None, "size_text": str(a.get(dk.get("file_size", "size")) or ""),
                         "_api": {"filePath": str(a.get(dk.get("file_path", "filePath")) or ""), "fileID": str(a.get(dk.get("file_id", "boardFileID")) or ""),
                                  "missing": str(a.get(dk.get("file_missing", "notFound"))).lower() in ("true", "1")}})
        view = str(self.api.get("view_url") or "").replace("{boardID}", self._board_id(self._src or {})).replace("{postID}", self._cur_id or "")
        return {
            "title": str(p.get(dk.get("title", "title")) or "").strip(),
            "body_html": str(p.get(dk.get("body_html", "contents")) or ""),
            "posted_at": _parse_api_date(p.get(dk.get("posted_at", "writeDateTime"))),
            "modified_at": _parse_api_date(p.get(dk.get("modified_at", "editDateTime"))),
            "author": str(p.get(dk.get("author", "writeMemberName")) or "").strip() or None,
            "dept": None,
            "attachments": atts,
            "url": (self.base + view) if view else None,
        }

    def download(self, att, dest):
        a = att.get("_api") or {}
        if a.get("missing"):
            return {"ok": False, "reason": "그룹웨어에 파일 없음(notFound)", "mode": "api"}
        vals = {"fileName": att.get("name") or "", "filePath": a.get("filePath") or "", "fileType": self.api.get("download_file_type") or "FILETYPEBOARD", "fileID": a.get("fileID") or ""}
        params = {}
        for k, v in (self.api.get("download_query") or {}).items():
            s = str(v)
            for name, val in vals.items():
                s = s.replace("{" + name + "}", val)
            params[k] = s
        try:
            r = self.page.request.get(self.base + (self.api.get("download_path") or "/Common/Download"), params=params, timeout=120000)
            ctype = (r.headers.get("content-type") or "").lower()
            if r.status != 200:
                return {"ok": False, "reason": "HTTP %d" % r.status, "mode": "api"}
            if ctype.startswith("text/html"):
                return {"ok": False, "reason": "HTML 응답(로그인 만료·권한 없음)", "mode": "api"}
            data = r.body()
            if not data:
                return {"ok": False, "reason": "빈 응답", "mode": "api"}
            if len(data) > MAX_ATTACH_BYTES:
                return {"ok": False, "reason": "파일이 너무 큼", "mode": "api"}
            with open(dest, "wb") as fh:
                fh.write(data)
            cd = r.headers.get("content-disposition") or ""
            name_hdr = None
            m = re.search(r"filename\*=(?:UTF-8|utf-8)''([^;]+)", cd) or re.search(r'filename="?([^";]+)"?', cd)
            if m:
                try:
                    name_hdr = urllib.parse.unquote(m.group(1)).strip()
                except Exception:
                    name_hdr = m.group(1).strip()
            return {"ok": True, "size": len(data), "name_from_header": name_hdr, "reason": None, "mode": "api"}
        except Exception as e:
            return {"ok": False, "reason": "다운로드 실패(%s)" % type(e).__name__, "mode": "api"}


def make_driver(page, base_url, sel, log_fn=log):
    """프로필 list_mode 에 따라 드라이버를 고른다 — 'api'(JSON 끝점) 또는 'dom'(화면 긁기)."""
    if str(sel.get("list_mode") or "dom").lower() == "api":
        return ApiDriver(page, base_url, sel, log_fn)
    return BoardDriver(page, base_url, sel, log_fn)


# ────────────────────────────────────────────────────────────── 게시물 1건
def process_post(driver, src, row, ledger, regs, opts, run_id):
    """한 게시물: 열기 → 읽기 → 비교 → 첨부 → 추출 → 파싱 → NAS 쓰기 → 대장. 반환 event 문자열."""
    board_key = src["board_key"]
    post_no = str(row["post_no"])
    key = Ledger.key(board_key, post_no)
    st = ledger.state.get(key)
    driver.open_post(row)
    post = driver.read_post()
    title = (post.get("title") or row.get("title") or "").strip() or ("게시물 %s" % post_no)
    body_md = html_to_md(post.get("body_html") or "")
    norm = body_text_norm(body_md)
    body_blocked = bool(nas_index._RRN.search(norm))
    if body_blocked:
        body_md, norm = "", ""
    body_hash = sha256_text(norm)
    dir_name = post_dir_name(post_no, title)
    tmp = None
    atts, att_texts = [], []
    if not opts.get("dry"):
        tmp = os.path.join(regs, board_key, dir_name + ".tmp-%d" % os.getpid())
        if os.path.isdir(tmp):
            shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(os.path.join(tmp, "첨부"), exist_ok=True)
    used = set()
    for i, att in enumerate(post.get("attachments") or [], 1):
        fname = safe_name(att.get("name"))
        ext, allowed, why = classify_ext(fname)
        rec = {"seq": i, "file_name": fname, "ext": ext or None, "size_bytes": None, "sha256": None, "nas_rel_path": None,
               "text_status": "skipped", "text_reason": None, "text_chars": None, "extractor": None, "is_article_source": False}
        if not allowed:
            rec["text_reason"] = why
        elif not src.get("collect_attachments", True):
            rec["text_reason"] = "게시판 설정: 첨부 수집 안 함"
        elif opts.get("dry"):
            rec["text_reason"] = "dry-run"
        else:
            base = fname
            n = 2
            while base.lower() in used:
                stem, e2 = os.path.splitext(fname)
                base = "%s_%d%s" % (stem, n, e2)
                n += 1
            used.add(base.lower())
            rec["file_name"] = base
            dest = os.path.join(tmp, "첨부", base)
            r = driver.download(att, dest)
            if not r.get("ok"):
                rec["text_reason"] = "다운로드 실패: %s" % (r.get("reason") or "")
                atts.append(rec)
                att_texts.append({"name": base, "text": None})
                continue
            rec["size_bytes"] = r.get("size") or os.path.getsize(dest)
            rec["sha256"] = sha256_file(dest)
            if r.get("name_from_header") and r["name_from_header"] != fname:
                rec["name_from_header"] = r["name_from_header"]
            text, why, extractor = extract_text(dest)
            rec["extractor"] = extractor
            if text is None and why and "주민등록번호" in why:
                os.remove(dest)                                  # 전사공유 폴더에 두지 않는다
                rec.update(text_status="blocked", text_reason=why, nas_rel_path=None)
                att_texts.append({"name": base, "text": None})
            elif text is None:
                rec.update(text_status="unreadable", text_reason=why,
                           nas_rel_path="%s/%s/%s/첨부/%s" % (REGS_REL, board_key, dir_name, base))
                att_texts.append({"name": base, "text": None})
            else:
                rec.update(text_status="readable", text_chars=len(text),
                           nas_rel_path="%s/%s/%s/첨부/%s" % (REGS_REL, board_key, dir_name, base))
                att_texts.append({"name": base, "text": text})
        atts.append(rec)
        if len(att_texts) < len(atts):
            att_texts.append({"name": rec["file_name"], "text": None})
    sig = attach_sig(atts)
    unchanged = bool(st) and st.get("body_hash") == body_hash and st.get("attach_sig") == sig and st.get("status", "active") == "active"
    if unchanged:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
        ledger.update(board_key, post_no, last_seen=_now().isoformat(timespec="seconds"), modified_at=post.get("modified_at") or row.get("modified_at"),
                      mod_count=row.get("mod_count"))
        return "unchanged"
    rev = int(st.get("rev") or 0) + 1 if st else 1
    text_source, parsed, src_idx = reg_parse.choose_source(norm, att_texts, hint_title=title)
    if src_idx is not None and src_idx < len(atts):
        atts[src_idx]["is_article_source"] = True
    meta = parsed["meta"]
    nas_rel = "%s/%s/%s" % (REGS_REL, board_key, dir_name)
    gw_url = post.get("url") if str(post.get("url") or "").lower().startswith("http") else None
    payload = {
        "post": {"board_key": board_key, "post_no": post_no, "title": title, "author": post.get("author") or row.get("author"),
                 "dept_nm": post.get("dept") or row.get("dept"), "posted_at": post.get("posted_at") or row.get("posted_at"),
                 "modified_at": post.get("modified_at") or row.get("modified_at"), "body_md": body_md[:200000],
                 "body_hash": body_hash, "attach_sig": sig, "nas_rel_path": nas_rel, "gw_url": gw_url,
                 "revision": rev, "status": "active", "collector_version": COLLECTOR_VERSION, "run_id": run_id,
                 "body_blocked": body_blocked},
        "attachments": [{k: v for k, v in a.items() if k != "name_from_header"} for a in atts],
        "document": {"reg_key": reg_parse.reg_key(board_key, meta.get("name") or title), "name": meta.get("name") or title,
                     "category": src.get("category"), "enact_date": meta.get("enact_date"), "revise_date": meta.get("revise_date"),
                     "effective_date": meta.get("effective_date") or (post.get("posted_at") or row.get("posted_at") or "")[:10] or None,
                     "revision_no": meta.get("revision_no"), "owner_dept": meta.get("owner_dept"),
                     "parse_status": parsed["status"], "parse_version": parsed["version"], "text_source": text_source,
                     "article_count": parsed["stats"]["articles"], "warnings": parsed["warnings"]},
        "articles": parsed["articles"],
    }
    event = "changed" if st else "new"
    if opts.get("dry"):
        log("  (dry-run) %s %s · %s · 첨부 %d · 조문 %d(%s) · 원천 %s" % (
            event, post_no, title[:40], len(atts), parsed["stats"]["articles"], parsed["status"], text_source))
        return event
    with io.open(os.path.join(tmp, "본문.md"), "w", encoding="utf-8") as fh:
        fh.write("---\n제목: %s\n게시판: %s\n게시물번호: %s\n작성자: %s\n부서: %s\n작성일: %s\n수정일: %s\n수집시각: %s\n판: %d\nbody_hash: %s\n---\n\n%s\n"
                 % (title, board_key, post_no, payload["post"]["author"] or "", payload["post"]["dept_nm"] or "",
                    payload["post"]["posted_at"] or "", payload["post"]["modified_at"] or "",
                    _now().isoformat(timespec="seconds"), rev, body_hash,
                    body_md if not body_blocked else "(본문에 주민등록번호 꼴이 있어 저장하지 않음)"))
    if not body_blocked:
        with io.open(os.path.join(tmp, "원본.html"), "w", encoding="utf-8") as fh:
            fh.write(post.get("body_html") or "")
    with io.open(os.path.join(tmp, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1, default=str)
    commit_post_dir(regs, board_key, dir_name, tmp, prev_rel=(st or {}).get("nas_rel"), prev_rev=int((st or {}).get("rev") or 0))
    ledger.append({"run_id": run_id, "board_key": board_key, "post_no": post_no, "rev": rev, "event": event,
                   "body_hash": body_hash, "attach_sig": sig, "modified_at": payload["post"]["modified_at"], "nas_rel": nas_rel,
                   "atts": [{"name": a["file_name"], "size": a["size_bytes"], "sha256": a["sha256"], "text_status": a["text_status"]} for a in atts],
                   "parse": {"status": parsed["status"], "articles": parsed["stats"]["articles"], "text_source": text_source},
                   "db_synced": False, "collector": COLLECTOR_VERSION})
    ledger.update(board_key, post_no, rev=rev, body_hash=body_hash, attach_sig=sig, modified_at=payload["post"]["modified_at"],
                  mod_count=row.get("mod_count"),
                  nas_rel=nas_rel, status="active", db_synced=False, last_seen=_now().isoformat(timespec="seconds"), title=title)
    return event


# ────────────────────────────────────────────────────────────── DB 적재
def db_sync(rpc_fn, url, key, ledger, root, run_id, src_results):
    """db_synced=False 인 게시물의 meta.json 을 청크로 보낸다. 실패해도 회차를 실패로 만들지 않는다(다음 회차 재전송)."""
    pend = ledger.pending_db()
    sent = failed = 0
    by_board = {}
    for k, st in pend:
        by_board.setdefault(st["board_key"], []).append((k, st))
    for board_key, items in by_board.items():
        for i in range(0, len(items), INGEST_CHUNK):
            chunk = items[i:i + INGEST_CHUNK]
            posts = []
            for k, st in chunk:
                mp = os.path.join(root, *st["nas_rel"].split("/"), "meta.json")
                try:
                    with io.open(mp, encoding="utf-8") as fh:
                        posts.append(json.load(fh))
                except Exception as e:
                    log("  meta.json 읽기 실패 %s: %s" % (k, type(e).__name__))
            if not posts:
                continue
            payload = {"run_id": run_id, "collector_version": COLLECTOR_VERSION, "board_key": board_key,
                       "last_post_no": max((p["post"]["post_no"] for p in posts), key=lambda x: (len(x), x)),
                       "last_result": src_results.get(board_key), "posts": posts}
            try:
                rpc_fn(url, key, "reg_ingest_upsert", {"p_payload": payload})
            except Exception as e:
                failed += len(posts)
                log("  DB 적재 실패(%s · %d건 · 다음 회차 재전송): %s" % (board_key, len(posts), str(e)[:300]))
                continue
            for k, st in chunk:
                st["db_synced"] = True
                ledger.append({"run_id": run_id, "board_key": board_key, "post_no": st["post_no"], "rev": st.get("rev"), "event": "db_synced"})
            sent += len(posts)
    ledger.save()
    return sent, failed


# ────────────────────────────────────────────────────────────── 세션
@contextlib.contextmanager
def playwright_session(cfg, headed=False, force_login=False, accept_downloads=True, profile=None):
    """실제 브라우저. (page, login_result) 를 낸다. 끝나면 로그아웃·종료."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser, context, page = gw_session.new_page(p, headed=headed, accept_downloads=accept_downloads)
        res = {"ok": False, "reason": "not_tried", "msg": ""}
        try:
            page.on("dialog", lambda d: d.accept())
            res = gw_session.login(page, cfg, allow_force=force_login, shot_fn=lambda pg, n: gw_session.shot(pg, n, log=log), log=log)
            yield page, res
        finally:
            try:
                if res.get("ok"):
                    gw_session.logout(page, cfg, ((profile or {}).get("login") or {}).get("logout_path"), log=log)
            except Exception:
                pass
            try:
                browser.close()
            except Exception:
                pass


def _sources_from(rpc_fn, url, key, profile, boards_filter, no_db):
    """게시판 목록 — DB reg_source(활성) > 프로필 boards. 0건이면 수집하지 않는다(fail-closed)."""
    rows = []
    if not no_db and rpc_fn and url:
        got = rpc_fn(url, key, "reg_source_list", {}) or []
        rows = [r for r in got if r.get("active", True)]
    if not rows:
        rows = [dict(b) for b in (profile.get("boards") or []) if b.get("board_key") and b.get("list_path")]
    if boards_filter:
        rows = [r for r in rows if r.get("board_key") in set(boards_filter)]
    return rows


# ────────────────────────────────────────────────────────────── 본문
def collect(mode="nightly", boards=None, since=None, dry=False, headed=False, force_login=False, docs_root_arg=None,
            selectors=None, max_posts=None, budget_min=BUDGET_MIN, no_db=False,
            session_factory=None, driver_factory=None, rpc_fn=None, today=None, cfg=None, rate_sleep=None):
    """CLI·러너 공용 진입점. 예외를 밖으로 던지지 않는다 — {"ok","rc","msg",...}."""
    t0 = time.time()
    run_id = str(uuid.uuid4())
    today = today or _now().strftime("%Y-%m-%d")
    out = {"ok": False, "rc": 1, "mode": mode, "run_id": run_id, "new": 0, "changed": 0, "unchanged": 0, "blocked": 0,
           "removed": 0, "errors": [], "boards": {}, "db_sent": 0, "db_failed": 0, "skipped": None}
    try:
        if mode == "nightly" and not dry:
            try:
                with io.open(_stamp_file(), encoding="utf-8") as fh:
                    if json.load(fh).get("date") == today:
                        out.update(ok=True, rc=0, skipped="done_today", msg="오늘 수집 완료 — 건너뜀")
                        log(out["msg"])
                        return out
            except Exception:
                pass
        profile = load_profile(selectors)
        rpc_fn = rpc_fn or rpc
        url = key = None
        if not no_db:
            url, key = supabase_creds()
        try:
            root = docs_root(docs_root_arg)
        except RuntimeError as e:
            out.update(ok=True, rc=0, skipped="no_docs_root", msg=str(e))
            log(out["msg"])
            return out
        regs = regs_root(root)
        sources = _sources_from(rpc_fn, url, key, profile, boards, no_db)
        if not sources:
            raise RuntimeError("수집할 게시판이 없습니다 — DB reg_source(활성) 또는 프로필 boards 에 등록하세요")
        cfg = cfg or gw_session.load_gw_config()
        if session_factory is None:
            session_factory = lambda: playwright_session(cfg, headed=headed, force_login=force_login,  # noqa: E731
                                                         accept_downloads=not dry, profile=profile)
        driver_factory = driver_factory or (lambda page, base, sel: make_driver(page, base, sel, log))
        ledger = Ledger(regs).load()
        max_posts = int(max_posts or MAX_POSTS_PER_RUN)
        opts = {"dry": dry, "sleep": RATE_SLEEP_SEC if rate_sleep is None else float(rate_sleep)}
        src_results = {}
        stopped = False
        with session_factory() as (page, login_res):
            if not login_res.get("ok"):
                if login_res.get("reason") == "session_busy":
                    out.update(ok=True, rc=0, skipped="session_busy", msg=login_res.get("msg"))
                    log(out["msg"])
                    return out
                raise RuntimeError("로그인 실패: %s" % login_res.get("msg"))
            log("로그인 확인 · %s · 게시판 %d개 · %s%s" % (mode, len(sources), "dry-run" if dry else "수집",
                                                       " · 강제 로그인" if login_res.get("forced") else ""))
            n_total = 0
            for src in sources:
                board_key = src["board_key"]
                sel = merge_selectors(profile, src.get("selectors") or {})
                driver = driver_factory(page, cfg.get("url"), sel)
                seen, streak, page_no = set(), 0, 1
                b = {"new": 0, "changed": 0, "unchanged": 0, "blocked": 0, "seen": 0, "pages": 0, "complete": False}
                out["boards"][board_key] = b
                has_mod = bool(sel["list"].get("modified_at"))
                while True:
                    driver.open_list(src, page_no)
                    rows = driver.read_rows()
                    b["pages"] = page_no
                    if page_no == 1 and not rows:
                        raise RuntimeError("선택자 없음: list.row (게시판 %s) — 프로필을 확인하세요" % board_key)
                    for row in rows:
                        pn = str(row.get("post_no") or "").strip()
                        if not pn or pn in seen:
                            continue
                        seen.add(pn)
                        if since and (row.get("posted_at") or "")[:10] < since and (row.get("modified_at") or "")[:10] < since:
                            continue
                        st = ledger.state.get(Ledger.key(board_key, pn))
                        if st is None or st.get("status") == "removed":
                            need_open = True
                        elif row.get("mod_count") is not None:
                            # API 목록은 수정일 대신 수정 횟수(isHistory)를 준다 — 횟수가 같으면 열지 않는다(full 은 첫 회차에만 전부 연다)
                            need_open = row["mod_count"] != st.get("mod_count") or (mode == "full" and st.get("mod_count") is None)
                        elif has_mod:
                            need_open = (row.get("modified_at") or "") != (st.get("modified_at") or "")
                        else:
                            need_open = mode == "full" or page_no <= NIGHTLY_HASH_PAGES
                        if not need_open:
                            streak += 1
                            b["unchanged"] += 1
                            ledger.update(board_key, pn, last_seen=_now().isoformat(timespec="seconds"))
                            continue
                        try:
                            ev = process_post(driver, src, row, ledger, regs, opts, run_id)
                        except RuntimeError as e:
                            if "선택자 없음" in str(e) or "링크를 찾지" in str(e):
                                raise
                            out["errors"].append("%s:%s %s" % (board_key, pn, str(e)[:200]))
                            log("  게시물 %s 실패: %s" % (pn, str(e)[:200]))
                            ev = "error"
                        if ev in ("new", "changed"):
                            streak = 0
                        else:
                            streak += 1
                        if ev in b:
                            b[ev] += 1
                        n_total += 1
                        if not dry:
                            ledger.save()
                        if opts["sleep"] > 0:
                            time.sleep(opts["sleep"])          # 사람 속도 — 그룹웨어에 부하를 주지 않는다
                        if n_total >= max_posts or (time.time() - t0) > budget_min * 60:
                            stopped = True
                            break
                    b["seen"] = len(seen)
                    if stopped:
                        break
                    if mode == "nightly" and streak >= UNCHANGED_STREAK_STOP and page_no >= NIGHTLY_MIN_PAGES:
                        break
                    if not driver.has_next():
                        b["complete"] = True
                        break
                    page_no += 1
                # 삭제 판정 — full 완주 때만
                if mode == "full" and b["complete"] and not since and not dry:
                    active = [k for k, st in ledger.state.items() if st.get("board_key") == board_key and st.get("status", "active") == "active"]
                    gone = [k for k in active if ledger.state[k]["post_no"] not in seen]
                    if gone and len(seen) < REMOVE_MIN_RATIO * len(active):
                        out["errors"].append("%s: 이번에 본 건수(%d)가 활성(%d)의 절반 미만 — 삭제 표시 거부" % (board_key, len(seen), len(active)))
                    else:
                        for k in gone:
                            st = ledger.state[k]
                            st["status"] = "removed"
                            st["removed_at"] = _now().isoformat(timespec="seconds")
                            ledger.append({"run_id": run_id, "board_key": board_key, "post_no": st["post_no"], "event": "removed"})
                            b.setdefault("removed", 0)
                            b["removed"] += 1
                            out["removed"] += 1
                        if gone and not no_db and url:
                            try:
                                rpc_fn(url, key, "reg_mark_removed", {"p_board_key": board_key, "p_seen_post_nos": sorted(seen), "p_run_id": run_id})
                            except Exception as e:
                                out["errors"].append("%s: 삭제 반영 실패 %s" % (board_key, str(e)[:200]))
                src_results[board_key] = dict(b, run_id=run_id, at=_now().isoformat(timespec="seconds"), mode=mode,
                                              errors=[e for e in out["errors"] if e.startswith(board_key + ":")][:20])
                for kk in ("new", "changed", "unchanged", "blocked"):
                    out[kk] += b[kk]
                if stopped:
                    break
        if not dry:
            ledger.save()
            if not no_db and url:
                batch_id = None
                try:
                    batch_id = rpc_fn(url, key, "erp_etl_batch", {"p_action": "start", "p_payload": {"job_name": JOB_NAME}})
                except Exception as e:
                    log("  배치 이력 start 실패(계속): %s" % str(e)[:200])
                sent, failed = db_sync(rpc_fn, url, key, ledger, root, run_id, src_results)
                out["db_sent"], out["db_failed"] = sent, failed
                if batch_id:
                    try:
                        rpc_fn(url, key, "erp_etl_batch", {"p_action": "finish", "p_payload": {
                            "batch_id": batch_id, "status": "success" if not failed and not out["errors"] else "failed",
                            "rows_read": out["new"] + out["changed"] + out["unchanged"], "rows_upserted": sent,
                            "error_msg": ("; ".join(out["errors"])[:500] or None)}})
                    except Exception as e:
                        log("  배치 이력 finish 실패(계속): %s" % str(e)[:200])
        complete = not stopped and all(b.get("complete") for b in out["boards"].values())
        ok = not out["errors"] and out["db_failed"] == 0
        out.update(ok=ok, rc=0 if ok else 1, complete=complete, elapsed_sec=round(time.time() - t0, 1),
                   msg="완료 — 신규 %d · 변경 %d · 불변 %d · 삭제 %d · DB %d(실패 %d)%s" % (
                       out["new"], out["changed"], out["unchanged"], out["removed"], out["db_sent"], out["db_failed"],
                       "" if complete else " · 예산·상한으로 중단(다음 회차에 이어서)"))
        log(out["msg"])
        if mode == "nightly" and ok and complete and not dry:
            try:
                os.makedirs(os.path.dirname(_stamp_file()), exist_ok=True)
                with io.open(_stamp_file(), "w", encoding="utf-8") as fh:
                    json.dump({"date": today, "at": _now().strftime("%Y-%m-%d %H:%M:%S"), "collector": COLLECTOR_VERSION,
                               "result": {k: out[k] for k in ("new", "changed", "unchanged", "removed", "db_sent")}}, fh, ensure_ascii=False)
            except Exception as e:
                log("완료 표시를 못 남겼습니다(다음 회차에 한 번 더): %s" % type(e).__name__)
        return out
    except Exception as e:
        out.update(ok=False, rc=1, msg="실패: %s" % nas_worker._redact(str(e))[:400])
        out["errors"].append(out["msg"])
        log(out["msg"])
        return out


# ────────────────────────────────────────────────────────────── probe
def probe(selectors=None, boards=None, headed=True, no_db=True, session_factory=None, driver_factory=None, rpc_fn=None, cfg=None):
    """선택자 점검만 — 다운로드·NAS·DB 쓰기 없음. 선택자가 하나라도 0건이면 rc 1."""
    profile = load_profile(selectors)
    rpc_fn = rpc_fn or rpc
    url = key = None
    if not no_db:
        url, key = supabase_creds()
    sources = _sources_from(rpc_fn, url, key, profile, boards, no_db)
    cfg = cfg or gw_session.load_gw_config()
    report = {"ok": True, "boards": {}, "rc": 0}
    if not sources:
        report.update(ok=False, rc=1, msg="게시판 목록이 없습니다 — 프로필 boards 또는 DB reg_source")
        log(report["msg"])
        return report
    if session_factory is None:
        session_factory = lambda: playwright_session(cfg, headed=headed, force_login=False, accept_downloads=False, profile=profile)  # noqa: E731
    driver_factory = driver_factory or (lambda page, base, sel: make_driver(page, base, sel, log))
    try:
        with session_factory() as (page, login_res):
            if not login_res.get("ok"):
                report.update(ok=False, rc=1, msg="로그인: %s" % login_res.get("msg"))
                log(report["msg"])
                return report
            for src in sources:
                sel = merge_selectors(profile, src.get("selectors") or {})
                driver = driver_factory(page, cfg.get("url"), sel)
                api_mode = str(sel.get("list_mode") or "dom").lower() == "api"
                b = {"mode": "api" if api_mode else "dom", "selectors": {}, "rows": 0, "sample": [], "post": None}
                report["boards"][src["board_key"]] = b
                driver.open_list(src, 1)
                for name, css in ([] if api_mode else sel["list"].items()):
                    if name in ("page_param", "notice_class", "link_attr", "link_onclick_re") or not css:
                        continue
                    b["selectors"]["list." + name] = driver.count(css)
                rows = driver.read_rows()
                b["rows"] = len(rows)
                b["sample"] = [{"post_no": r["post_no"], "title": r["title"][:40], "posted_at": r["posted_at"],
                                "link": "href" if r["link"].get("href") else ("onclick" if r["link"].get("onclick") else "없음")} for r in rows[:5]]
                if hasattr(driver, "page") and getattr(driver, "page", None) is not None:
                    gw_session.shot(driver.page, "probe_%s_list" % src["board_key"], log=log)
                if rows:
                    driver.open_post(rows[0])
                    for name, css in ([] if api_mode else sel["post"].items()):
                        if name == "attach" or not css:
                            continue
                        b["selectors"]["post." + name] = driver.count(css)
                    a_sel = sel["post"].get("attach") or {}
                    if a_sel.get("item") and not api_mode:
                        b["selectors"]["post.attach.item"] = driver.count(a_sel["item"])
                    post = driver.read_post()
                    b["post"] = {"title": post["title"][:40], "body_chars": len(html_to_md(post["body_html"])),
                                 "attachments": [{"name": a["name"], "link": "href" if a.get("href") else ("onclick" if a.get("onclick") else "없음")}
                                                 for a in post["attachments"]],
                                 "recommended_mode": "api" if api_mode else ("request" if any(a.get("href") and not str(a["href"]).lower().startswith("javascript") for a in post["attachments"]) else "download")}
                    if hasattr(driver, "page") and getattr(driver, "page", None) is not None:
                        gw_session.shot(driver.page, "probe_%s_post" % src["board_key"], log=log)
                zero = [k for k, v in b["selectors"].items() if not v]
                if zero or not rows:
                    report["ok"] = False
                log("게시판 %s: 행 %d · 선택자 0건 %s" % (src["board_key"], len(rows), zero or "없음"))
    except Exception as e:
        report.update(ok=False, msg="probe 실패: %s" % nas_worker._redact(str(e))[:300])
        log(report["msg"])
    report["rc"] = 0 if report["ok"] else 1
    print(json.dumps(report, ensure_ascii=False, indent=1, default=str))
    return report


# ────────────────────────────────────────────────────────────── CLI
def main(argv=None):
    ap = argparse.ArgumentParser(description="그룹웨어 게시판(사내규정) → NAS 정본 미러 + 포털 DB 적재")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--full", action="store_true", help="전량(끝 페이지까지 · 삭제 판정)")
    g.add_argument("--nightly", action="store_true", help="증분 · 하루 1회(예약작업)")
    g.add_argument("--probe", action="store_true", help="선택자 점검만(다운로드·쓰기 없음)")
    ap.add_argument("--dry-run", action="store_true", help="읽기만 — NAS·DB 무변경")
    ap.add_argument("--headed", action="store_true", help="브라우저를 띄워서(디버깅)")
    ap.add_argument("--log", help="출력을 이 파일에 덧붙인다(예약작업·pythonw)")
    ap.add_argument("--since", help="YYYY-MM-DD — 그 뒤 게시·수정된 것만(삭제 판정 안 함)")
    ap.add_argument("--board", action="append", help="게시판 키(반복 가능)")
    ap.add_argument("--max", type=int, help="회차 게시물 상한(기본 %d)" % MAX_POSTS_PER_RUN)
    ap.add_argument("--budget-min", type=int, default=BUDGET_MIN)
    ap.add_argument("--force-login", action="store_true", help="시크릿키 강제 로그인 허용(기존 사람 세션이 끊긴다 — 기본 꺼짐)")
    ap.add_argument("--no-db", action="store_true", help="NAS 만(DB 적재·reg_source 조회 안 함)")
    ap.add_argument("--selectors", help="선택자 프로필 JSON(기본 gw_board_profile.default.json · DB reg_source.selectors 가 우선)")
    ap.add_argument("--docs-root", help="문서 루트(검증용 임시 폴더 · 값은 로그에 남기지 않는다)")
    a = ap.parse_args(argv)
    if a.log:
        os.makedirs(os.path.dirname(os.path.abspath(a.log)), exist_ok=True)
        f = io.open(a.log, "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = f
        print("── %s" % datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    try:
        if a.probe:
            return int(probe(selectors=a.selectors, boards=a.board, headed=a.headed or True, no_db=a.no_db)["rc"])
        mode = "full" if a.full else "nightly"
        res = collect(mode=mode, boards=a.board, since=a.since, dry=a.dry_run, headed=a.headed, force_login=a.force_login,
                      docs_root_arg=a.docs_root, selectors=a.selectors, max_posts=a.max, budget_min=a.budget_min, no_db=a.no_db)
        return int(res.get("rc", 1))
    except Exception as e:                       # SystemExit 를 던지지 않는다(상주 러너 보호)
        print("[gw-board] 실패: %s" % nas_worker._redact(str(e))[:400])
        return 1


if __name__ == "__main__":
    sys.exit(main())
