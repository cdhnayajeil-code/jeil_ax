# nas_index.py — 사내 NAS 문서 색인·검색 (REQ-0104 · ADR-110 v3 · P3)
#
# 무엇: 허용 폴더(etl_meta.nas_folder_scope)에 있는 문서의 **글자**를 뽑아 NAS 쪽 SQLite 색인에 넣고,
#   에이전트가 묻는 낱말로 찾아 발췌를 돌려준다. 색인은 사내에만 둔다 — 클라우드 DB 에 문서 내용을 쌓지 않는다(D-95).
#   밖으로 나가는 것은 「질문에 걸린 발췌 몇 토막」뿐이고, 그것도 조회 큐에 잠깐 머물다 지워진다.
#
# 왜 SQLite FTS5 trigram 인가: 한글은 띄어쓰기 단위로 자르면 「수의계약」이 「수의계약은」에 안 걸린다.
#   세 글자 조각(trigram)으로 색인하면 부분 일치가 되고, 형태소 분석기 같은 외부 설치가 필요 없다(표준 라이브러리).
#   두 글자 이하 낱말은 trigram 으로 못 찾으므로 그때만 LIKE 로 훑는다.
#
# 무엇을 읽는가: txt·md·csv · docx·xlsx·pptx·hwpx(전부 zip+xml — 표준 라이브러리) · pdf(pypdf 가 있을 때만)
#   · 구형 한글 hwp(hwp_text — olefile 이 있을 때만 · 배포용·암호 문서는 사유만 · i1.2).
#   스캔본 PDF·이미지·doc·xls 는 글자를 못 뽑는다 → 색인에서 빠지고 사유가 남는다(조용히 건너뛰지 않는다 §17.6).
#
# 빼는 것(§1.7): 파일 이름에 급여·연봉·인사평가 등이 들어간 파일, 본문에 주민등록번호 꼴이 있는 파일.
#   빠진 파일은 내용이 색인에 **한 글자도** 들어가지 않는다 — 사유만 남는다.
import csv
import datetime
import html
import io
import json
import math
import os
import re
import sqlite3
import sys
import time
import zipfile
from xml.etree import ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hwp_text  # noqa: E402  (구형 한글 — olefile 은 그 안에서 늦게 import)

INDEX_VERSION = "i1.2"   # i1.2(2026-10-08 · REQ-0124): 구형 한글 .hwp 읽기(hwp_text · olefile) · 판 재시도 사유 확장(RETRY_REASONS) / (i1.1 보강 10-08: 파일 이름으로도 검색 · 목록용 문서 번호 조회 lookup · 압축 해제 크기 상한) / i1.1(2026-10-08 · REQ-0117 S1): 읽는 형식 추가(tsv·json·sql·xml·html·xlsm) · 표 구조 판독(read_table) · 판독 상태(file_status)

MAX_FILE_BYTES = 40 * 1024 * 1024      # 이보다 크면 읽지 않는다
MAX_TEXT_CHARS = 1_500_000             # 한 파일에서 색인하는 글자 상한
MAX_UNZIP_BYTES = 80 * 1024 * 1024     # zip 꼴 문서(xlsx·docx…)를 풀었을 때 합계 상한 — 워커 메모리가 512MB 다(실측: 290MB 짜리가 1.5GB 를 썼다)
MAX_SHARED_CHARS = 20_000_000          # 엑셀 공유 문자열 합계 상한
TEXT_READ_BYTES = MAX_TEXT_CHARS * 3   # 글자 파일은 앞에서 이만큼만 읽는다
CHUNK_CHARS = 700
CHUNK_OVERLAP = 80
SCAN_MAX = 50000
DEPTH_MAX = 8

TEXT_EXT = {".txt", ".md", ".csv", ".log", ".tsv", ".json", ".sql"}
MARKUP_EXT = {".xml", ".html", ".htm"}          # 태그를 걷고 글자만 색인한다
ZIP_EXT = {".docx", ".xlsx", ".xlsm", ".pptx", ".hwpx"}
PDF_EXT = {".pdf"}
HWP_EXT = {".hwp"}                               # 구형 한글 — hwp_text(olefile) · i1.2
READABLE = TEXT_EXT | MARKUP_EXT | ZIP_EXT | PDF_EXT | HWP_EXT
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
TABLE_EXT = {".xlsx", ".xlsm", ".csv", ".tsv"}  # 표 구조를 살려 읽을 수 있는 형식(read_table)
REASON_UNREADABLE = "읽지 못하는 형식"
REASON_NO_PDF = "PDF 읽기 모듈 없음(pypdf)"
# 색인 판이 올라갔을 때 다시 읽어 볼 사유 — 형식 미지원·모듈 없음은 판이 바뀌면 읽힐 수 있다(암호·깨짐은 아니다)
RETRY_REASONS = {REASON_UNREADABLE, REASON_NO_PDF, "hwp 읽기 모듈 없음(olefile)"}
REASON_IMAGE = "이미지 — 글자 색인 없음(대화에 붙이면 모델이 직접 본다)"

_SKIP_NAME = re.compile(r"^(?:[.#@~]|Thumbs\.db$|desktop\.ini$)|\.tmp$", re.I)
# 이름만으로 빼는 파일 — 폴더를 등록할 때 걸러야 하지만 섞여 들어오는 경우의 2차 방어
_SENSITIVE_NAME = re.compile(r"급여|연봉|임금대장|인사평가|고과|주민등록|통장사본|신분증", re.I)
# 주민등록번호 꼴(앞 6자리가 날짜 꼴 + 뒤 첫 자리 1~4)
_RRN = re.compile(r"(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\s?-\s?[1-4]\d{6}(?!\d)")

_KST = datetime.timezone(datetime.timedelta(hours=9))


def pdf_ready():
    try:
        import importlib.util
        return importlib.util.find_spec("pypdf") is not None
    except Exception:
        return False


# ── 글자 뽑기 ────────────────────────────────────────────────────────────────
def _xml_text(data, para_tags, text_tags):
    """xml 에서 글자만. 네임스페이스는 떼고 본다 — 문단 태그마다 줄을 바꾼다."""
    out, buf = [], []
    try:
        for ev, el in ET.iterparse(io.BytesIO(data), events=("end",)):
            tag = el.tag.rsplit("}", 1)[-1]
            if tag in text_tags and el.text:
                buf.append(el.text)
            elif tag in para_tags:
                if buf:
                    out.append("".join(buf))
                    buf = []
            el.clear() if tag in para_tags else None
    except ET.ParseError:
        pass
    if buf:
        out.append("".join(buf))
    return "\n".join(s for s in (x.strip() for x in out) if s)


def _zip_members(z, pattern):
    rx = re.compile(pattern)
    def key(n):
        m = re.search(r"(\d+)", n.rsplit("/", 1)[-1])
        return (int(m.group(1)) if m else 0, n)
    return sorted((n for n in z.namelist() if rx.match(n)), key=key)


def _read_docx(path):
    with zipfile.ZipFile(path) as z:
        return _xml_text(z.read("word/document.xml"), {"p"}, {"t"})


def _read_pptx(path):
    parts = []
    with zipfile.ZipFile(path) as z:
        for i, n in enumerate(_zip_members(z, r"ppt/slides/slide\d+\.xml$"), 1):
            t = _xml_text(z.read(n), {"p"}, {"t"})
            if t:
                parts.append(f"[슬라이드 {i}]\n{t}")
    return "\n\n".join(parts)


def _read_hwpx(path):
    parts = []
    with zipfile.ZipFile(path) as z:
        for n in _zip_members(z, r"Contents/section\d+\.xml$"):
            t = _xml_text(z.read(n), {"p"}, {"t"})
            if t:
                parts.append(t)
    return "\n\n".join(parts)


def _read_xlsx(path):
    """셀 글자를 행 단위로. 숫자만 있는 셀도 넣는다(「단가 1,200」 같은 표를 찾을 수 있게).
    시트 목록은 표 읽기(_xlsx_book)와 같은 것을 쓴다 — 색인이 못 본 시트를 표 읽기가 내주는 일이 없게."""
    parts, total = [], 0
    with zipfile.ZipFile(path) as z:
        sheets, _, _ = _xlsx_book(z)
        shared = _shared_strings(z)
        for i, (_, member) in enumerate(sheets, 1):
            rows = []
            for _, row in _xlsx_rows(z, member, shared, set(), False, [], raw=True):
                line = " | ".join(v for _, v in sorted(row.items()))
                if total > MAX_TEXT_CHARS:
                    # 색인할 글자는 다 찼다 — 더 쌓지 않되, 주민번호 검사는 파일 끝까지 한다(걸린 줄만 실어 extract 가 잡게)
                    if _RRN.search(line):
                        rows.append(line)
                    continue
                rows.append(line)
                total += len(line) + 1
            if rows:
                parts.append(f"[시트 {i}]\n" + "\n".join(rows))
    return "\n\n".join(parts)


def _read_pdf(path):
    from pypdf import PdfReader   # 없으면 호출 전에 걸러진다
    reader = PdfReader(path)
    if getattr(reader, "is_encrypted", False):
        raise ValueError("암호가 걸린 PDF")
    parts, total = [], 0
    for i, page in enumerate(reader.pages, 1):
        t = (page.extract_text() or "").strip()
        if t:
            parts.append(f"[{i}쪽]\n{t}")
            total += len(t)
            if total > MAX_TEXT_CHARS:
                break
    return "\n\n".join(parts)


def _read_text_ex(path):
    """(글자, 잘렸는가). 앞 TEXT_READ_BYTES 만 읽는다 — 잘렸으면 마지막 줄바꿈까지만 써서 글자 중간에서 끊기지 않게 한다."""
    with open(path, "rb") as fh:
        raw = fh.read(TEXT_READ_BYTES + 1)
    cut = len(raw) > TEXT_READ_BYTES
    if cut:
        raw = raw[:TEXT_READ_BYTES]
        nl = raw.rfind(b"\n")
        if nl > 0:
            raw = raw[:nl].rstrip(bytes([13]))
    encs = ["utf-8-sig", "cp949"]
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):           # utf-16 은 BOM 이 있을 때만 — 아무 바이트나 받아들여 깨진 글자를 만들기 때문
        encs.insert(0, "utf-16")
    for enc in encs:
        try:
            return raw.decode(enc), cut
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace"), cut


def _read_text(path):
    return _read_text_ex(path)[0]


def _strip_markup(text):
    """html·xml 에서 글자만. 스크립트·스타일은 통째로 버린다."""
    text = re.sub(r"(?is)<(script|style)\b.*?</\1\s*>", " ", text or "")
    text = re.sub(r"(?s)<!--.*?-->", " ", text)
    text = re.sub(r"(?i)<\s*(br|/p|/div|/tr|/li|/h[1-6])\b[^>]*>", "\n", text)
    return html.unescape(re.sub(r"<[^>]+>", " ", text))


def _unzip_too_big(path):
    """zip 꼴 문서를 풀면 상한을 넘는가. zip 이 아니면 False(읽는 쪽이 깨진 파일로 처리한다)."""
    try:
        with zipfile.ZipFile(path) as z:
            return sum(i.file_size for i in z.infolist()) > MAX_UNZIP_BYTES
    except (zipfile.BadZipFile, OSError):
        return False


def extract(path):
    """(글자, 사유). 글자가 None 이면 색인하지 않는다 — 사유가 그 이유다."""
    ext = os.path.splitext(path)[1].lower()
    if ext in IMAGE_EXT:
        return None, REASON_IMAGE
    if ext not in READABLE:
        return None, REASON_UNREADABLE
    if ext in PDF_EXT and not pdf_ready():
        return None, REASON_NO_PDF
    if ext in HWP_EXT and not hwp_text.hwp_ready():
        return None, hwp_text.REASON_NO_MODULE
    try:
        if os.path.getsize(path) > MAX_FILE_BYTES:
            return None, "파일이 너무 큼"
        if ext in ZIP_EXT and _unzip_too_big(path):
            return None, "파일이 너무 큼(압축을 풀면 상한 초과)"
        if ext in TEXT_EXT:
            text = _read_text(path)
        elif ext in MARKUP_EXT:
            text = _strip_markup(_read_text(path))
        elif ext == ".docx":
            text = _read_docx(path)
        elif ext in (".xlsx", ".xlsm"):
            text = _read_xlsx(path)
        elif ext == ".pptx":
            text = _read_pptx(path)
        elif ext == ".hwpx":
            text = _read_hwpx(path)
        elif ext in HWP_EXT:
            text, why = hwp_text.extract_hwp(path, MAX_TEXT_CHARS)
            if text is None:
                return None, why
        else:
            text = _read_pdf(path)
    except (zipfile.BadZipFile, KeyError):
        return None, "파일이 깨졌거나 암호가 걸림"
    except Exception as e:
        return None, f"읽기 실패({type(e).__name__})"
    text = re.sub(r"[ \t ]+", " ", text or "").strip()
    if not text:
        return None, "글자가 없음(스캔본·빈 문서)"
    if _RRN.search(text):
        return None, "민감 정보 꼴(주민등록번호) 포함"
    return text[:MAX_TEXT_CHARS], None


def chunks_of(text):
    """문단 경계를 살려 700자 안팎으로 자른다. 앞 토막 끝 80자를 겹쳐 경계에 걸친 낱말을 살린다."""
    paras = [p.strip() for p in re.split(r"\n\s*\n|\n", text) if p.strip()]
    out, cur = [], ""
    for p in paras:
        while len(p) > CHUNK_CHARS:                    # 한 문단이 너무 길면 쪼갠다
            head, p = p[:CHUNK_CHARS], p[CHUNK_CHARS - CHUNK_OVERLAP:]
            if cur:
                out.append(cur)
                cur = ""
            out.append(head)
        if len(cur) + len(p) + 1 > CHUNK_CHARS and cur:
            out.append(cur)
            cur = cur[-CHUNK_OVERLAP:] + "\n" + p
        else:
            cur = (cur + "\n" + p) if cur else p
    if cur:
        out.append(cur)
    return out


# ── 색인 ─────────────────────────────────────────────────────────────────────
def connect(db_path):
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    con = sqlite3.connect(db_path, timeout=30)
    con.execute("pragma journal_mode=wal")
    con.executescript("""
        create table if not exists meta (k text primary key, v text);
        create table if not exists file (
          id integer primary key, folder_key text not null, rel text not null, name text not null,
          size integer, mtime real, status text not null, reason text, n_chunks integer default 0, indexed_at text,
          unique (folder_key, rel));
        create virtual table if not exists chunk using fts5(body, file_id unindexed, seq unindexed, tokenize='trigram');
    """)
    return con


def _inside(root, path):
    r = os.path.abspath(root).rstrip("\\/")
    p = os.path.abspath(path).rstrip("\\/")
    return p == r or p.startswith(r + os.sep)


def _walk(base):
    """(절대경로, 폴더 안 상대경로) — 휴지통·숨김·링크는 따라가지 않는다."""
    stack, seen = [(base, 0)], 0
    while stack:
        cur, depth = stack.pop()
        try:
            entries = list(os.scandir(cur))
        except OSError:
            continue
        for e in entries:
            if _SKIP_NAME.search(e.name):
                continue
            try:
                if e.is_symlink():
                    continue
                if e.is_dir(follow_symlinks=False):
                    if depth < DEPTH_MAX:
                        stack.append((e.path, depth + 1))
                elif e.is_file(follow_symlinks=False):
                    seen += 1
                    if seen > SCAN_MAX:
                        return
                    yield e.path, os.path.relpath(e.path, base).replace("\\", "/")
            except OSError:
                continue


def refresh(con, docs_root, folders, log=None, budget_sec=None):
    """허용 폴더를 훑어 바뀐 파일만 다시 색인한다. 등록에서 빠진 폴더·없어진 파일은 색인에서 지운다.

    반환: {"files","indexed","skipped","removed","changed"} — changed 는 이번에 다시 읽은 파일 수.
    """
    t0 = time.time()
    keep_keys = set()
    changed = removed = 0
    # 색인 판이 올라가면(읽는 형식이 늘면) 예전에 형식 때문에 빠진 파일을 다시 읽는다 — 크기·수정시각이 같아도
    old_ver = (con.execute("select v from meta where k = 'index_version'").fetchone() or [None])[0]
    retry = old_ver != INDEX_VERSION
    over_budget = False
    for f in folders or []:
        key = str(f.get("key") or "")
        rel = str(f.get("rel_path") or "").replace("\\", "/").strip("/")
        if not key or not rel or any(p in ("", ".", "..") for p in rel.split("/")):
            continue
        base = os.path.join(docs_root, *rel.split("/"))
        if not _inside(docs_root, base) or not os.path.isdir(base) or os.path.islink(base):
            continue
        keep_keys.add(key)
        have = {r[0]: r[1:] for r in con.execute("select rel, id, size, mtime, status, reason from file where folder_key = ?", (key,))}
        found = set()
        for path, sub in _walk(base):
            found.add(sub)
            try:
                st = os.stat(path)
            except OSError:
                continue
            old = have.get(sub)
            if old and old[1] == st.st_size and abs((old[2] or 0) - st.st_mtime) < 1 \
                    and not (retry and old[3] != "ok" and old[4] in RETRY_REASONS):
                continue
            if budget_sec and time.time() - t0 > budget_sec:
                over_budget = True
                continue                                   # 이번 회차 예산 초과 — 다음 회차에 이어서
            name = os.path.basename(path)
            if _SENSITIVE_NAME.search(name):
                text, reason = None, "민감 파일 이름"
            else:
                text, reason = extract(path)
            parts = chunks_of(text) if text else []
            with con:
                if old:
                    con.execute("delete from chunk where file_id = ?", (old[0],))
                    con.execute("delete from file where id = ?", (old[0],))
                cur = con.execute(
                    "insert into file (folder_key, rel, name, size, mtime, status, reason, n_chunks, indexed_at) values (?,?,?,?,?,?,?,?,?)",
                    (key, sub, name, st.st_size, st.st_mtime, "ok" if parts else "skipped", reason, len(parts),
                     datetime.datetime.now(_KST).strftime("%Y-%m-%d %H:%M:%S")))
                fid = cur.lastrowid
                con.executemany("insert into chunk (body, file_id, seq) values (?,?,?)",
                                [(p, fid, i) for i, p in enumerate(parts)])
            changed += 1
        for sub, old in have.items():
            if sub not in found:
                with con:
                    con.execute("delete from chunk where file_id = ?", (old[0],))
                    con.execute("delete from file where id = ?", (old[0],))
                removed += 1
    # 등록에서 빠진 폴더는 통째로 지운다 — 허용이 끊기면 색인에도 남기지 않는다
    for (key,) in con.execute("select distinct folder_key from file").fetchall():
        if key not in keep_keys:
            with con:
                con.execute("delete from chunk where file_id in (select id from file where folder_key = ?)", (key,))
                con.execute("delete from file where folder_key = ?", (key,))
            removed += 1
    stamp = datetime.datetime.now(_KST).strftime("%Y-%m-%d %H:%M")
    with con:
        con.execute("insert into meta (k, v) values ('refreshed_at', ?) on conflict(k) do update set v = excluded.v", (stamp,))
        if retry and not over_budget:                      # 다 못 돌았으면 판을 올리지 않는다 — 다음 회차가 이어서 본다
            con.execute("insert into meta (k, v) values ('index_version', ?) on conflict(k) do update set v = excluded.v", (INDEX_VERSION,))
    n_all, n_ok = con.execute("select count(*), sum(status = 'ok') from file").fetchone()
    res = {"files": n_all or 0, "indexed": n_ok or 0, "skipped": (n_all or 0) - (n_ok or 0),
           "removed": removed, "changed": changed, "as_of": stamp}
    if log and (changed or removed):
        log(f"문서 색인 갱신 — 파일 {res['files']}개(색인 {res['indexed']} · 제외 {res['skipped']}) · 다시 읽음 {changed} · 지움 {removed}")
    return res


# ── 검색·읽기 ────────────────────────────────────────────────────────────────
def _terms(q):
    return [t for t in re.split(r"\s+", str(q or "").strip()) if t][:6]


def _excerpt(body, terms, width=320):
    s = " ".join(body.split())
    low = s.casefold()
    pos = min((low.find(t.casefold()) for t in terms if t.casefold() in low), default=-1)
    if pos < 0:
        return s[:width] + ("…" if len(s) > width else "")
    a = max(0, pos - width // 4)
    return ("…" if a else "") + s[a:a + width] + ("…" if a + width < len(s) else "")


def search(con, q, folder_keys, limit=8, per_file=2):
    """허용된 폴더(folder_keys) 안에서만 찾는다. 반환 (결과 dict, 건수)."""
    terms = _terms(q)
    keys = [k for k in folder_keys if k]
    if not terms:
        raise ValueError("검색어가 비었습니다")
    if not keys:
        raise ValueError("볼 수 있는 폴더가 없습니다")
    limit = max(1, min(15, int(limit or 8)))
    long_t = [t for t in terms if len(t) >= 3]
    short_t = [t for t in terms if len(t) < 3]
    ph = ",".join("?" * len(keys))
    where, args = [f"f.folder_key in ({ph})"], list(keys)
    if long_t:
        where.append("chunk match ?")
        args.append(" AND ".join('"' + t.replace('"', '""') + '"' for t in long_t))
    for t in short_t:
        where.append("chunk.body like ? escape '\\'")
        args.append("%" + t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
    order = "bm25(chunk)" if long_t else "f.mtime desc"
    sql = (f"select f.id, f.folder_key, f.rel, f.name, f.mtime, chunk.seq, chunk.body from chunk "
           f"join file f on f.id = chunk.file_id where {' and '.join(where)} order by {order} limit 200")
    rows = con.execute(sql, args).fetchall()
    per, hits, files = {}, [], set()
    # 파일 이름이 걸린 문서를 먼저 싣는다 — 「○○ 파일 내용 알려줘」는 본문이 아니라 이름을 말한다(본문에 그 낱말이 없을 수 있다)
    name_w = [f"f.folder_key in ({ph})", "f.status = 'ok'"] + ["f.name like ? escape '\\'"] * len(terms)
    name_a = list(keys) + ["%" + t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%" for t in terms]
    for fid, key, rel, name, mtime in con.execute(
            f"select f.id, f.folder_key, f.rel, f.name, f.mtime from file f where {' and '.join(name_w)} order by f.mtime desc limit ?",
            name_a + [min(limit, 5)]).fetchall():
        first = con.execute("select body from chunk where file_id = ? order by cast(seq as integer) limit 1", (fid,)).fetchone()
        files.add(fid)
        per[fid] = per_file                                 # 이름으로 실은 문서는 본문 토막을 또 싣지 않는다
        sub = rel.rsplit("/", 1)[0] if "/" in rel else ""
        hits.append({"문서": f"{key}:{fid}", "토막": 0, "폴더키": key, "경로": sub, "이름": name,
                     "수정일": datetime.datetime.fromtimestamp(mtime or 0, _KST).strftime("%Y-%m-%d"),
                     "일치": "파일 이름", "표": os.path.splitext(name)[1].lower() in TABLE_EXT,
                     "발췌": _excerpt(first[0] if first else "", [])})
    for fid, key, rel, name, mtime, seq, body in rows:
        files.add(fid)
        if per.get(fid, 0) >= per_file or len(hits) >= limit:
            continue
        per[fid] = per.get(fid, 0) + 1
        sub = rel.rsplit("/", 1)[0] if "/" in rel else ""
        hits.append({"문서": f"{key}:{fid}", "토막": seq, "폴더키": key, "경로": sub, "이름": name,
                     "수정일": datetime.datetime.fromtimestamp(mtime or 0, _KST).strftime("%Y-%m-%d"),
                     "일치": "본문", "표": os.path.splitext(name)[1].lower() in TABLE_EXT,
                     "발췌": _excerpt(body, terms)})
    as_of = (con.execute("select v from meta where k = 'refreshed_at'").fetchone() or [None])[0]
    return {"해당문서수": len(files), "반환수": len(hits), "잘림": len(rows) >= 200 or len(files) > len(per),
            "색인기준": as_of, "목록": hits}, len(hits)


def read(con, doc, folder_keys, seq=0, max_chars=6000):
    """문서 한 건의 글자를 토막 순서대로. 허용 폴더 밖 문서는 없는 것으로 답한다."""
    m = re.fullmatch(r"([a-z0-9_]{1,40}):(\d{1,12})", str(doc or ""))
    if not m:
        raise ValueError("문서 번호 형식이 올바르지 않습니다")
    key, fid = m.group(1), int(m.group(2))
    if key not in set(folder_keys):
        raise ValueError("볼 수 없는 문서입니다")
    row = con.execute("select name, rel, mtime, n_chunks from file where id = ? and folder_key = ? and status = 'ok'",
                      (fid, key)).fetchone()
    if not row:
        raise ValueError("문서를 찾을 수 없습니다(지워졌거나 색인에서 빠졌습니다)")
    name, rel, mtime, n = row
    seq = max(0, min(int(seq or 0), max(0, n - 1)))
    parts, used, last = [], 0, seq
    for s, body in con.execute("select seq, body from chunk where file_id = ? and seq >= ? order by cast(seq as integer)", (fid, seq)):
        if used + len(body) > max_chars and parts:
            break
        parts.append(body)
        used += len(body)
        last = int(s)
    return {"문서": f"{key}:{fid}", "이름": name, "경로": rel.rsplit("/", 1)[0] if "/" in rel else "",
            "수정일": datetime.datetime.fromtimestamp(mtime or 0, _KST).strftime("%Y-%m-%d"),
            "토막범위": [seq, last], "전체토막": n, "다음토막": last + 1 if last + 1 < n else None,
            "내용": "\n".join(parts)}, len(parts)


def lookup(con, folder_key, rels):
    """폴더 안 상대경로들 → {rel: (문서 번호, 읽힘 여부, 사유, 표 여부)}. 파일 목록에 「읽을 수 있는 번호」를 붙일 때 쓴다."""
    out, rels = {}, [r for r in rels if r]
    for i in range(0, len(rels), 200):
        part = rels[i:i + 200]
        ph = ",".join("?" * len(part))
        for fid, rel, name, status, reason in con.execute(
                f"select id, rel, name, status, reason from file where folder_key = ? and rel in ({ph})", [folder_key] + part):
            out[rel] = (f"{folder_key}:{fid}", status == "ok", None if status == "ok" else (reason or "사유 없음"),
                        os.path.splitext(name)[1].lower() in TABLE_EXT)
    return out


def stats(con):
    n_all, n_ok = con.execute("select count(*), sum(status = 'ok') from file").fetchone()
    why = dict(con.execute("select reason, count(*) from file where status != 'ok' group by reason").fetchall())
    as_of = (con.execute("select v from meta where k = 'refreshed_at'").fetchone() or [None])[0]
    return {"files": n_all or 0, "indexed": n_ok or 0, "skipped": why, "as_of": as_of}


# ── 판독 상태(REQ-0117 S1) ───────────────────────────────────────────────────
def file_status(con, folder_keys, under=None, limit=300):
    """허용 폴더 안 파일의 판독 상태 — 읽혔는지, 못 읽었으면 왜인지. 내용은 한 글자도 싣지 않는다."""
    keys = [k for k in folder_keys if k]
    if not keys:
        raise ValueError("볼 수 있는 폴더가 없습니다")
    limit = max(1, min(500, int(limit or 300)))
    ph = ",".join("?" * len(keys))
    where, args = [f"folder_key in ({ph})"], list(keys)
    under = str(under or "").replace("\\", "/").strip("/")
    if under:
        if any(p in ("", ".", "..") for p in under.split("/")):
            raise ValueError("폴더 경로가 올바르지 않습니다")
        where.append("(rel = ? or rel like ? escape '\\')")
        args += [under, under.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "/%"]
    w = " and ".join(where)
    n_all, n_ok = con.execute(f"select count(*), sum(status = 'ok') from file where {w}", args).fetchone()
    why = dict(con.execute(f"select coalesce(reason, '사유 없음'), count(*) from file where {w} and status != 'ok' group by 1", args).fetchall())
    rows = con.execute(f"select id, folder_key, rel, name, status, reason, n_chunks, indexed_at from file where {w} "
                       f"order by mtime desc limit ?", args + [limit]).fetchall()
    as_of = (con.execute("select v from meta where k = 'refreshed_at'").fetchone() or [None])[0]
    items = [{"문서": f"{key}:{fid}", "폴더키": key, "경로": rel, "이름": name,
              "상태": "읽힘" if status == "ok" else "못 읽음", "사유": None if status == "ok" else (reason or "사유 없음"),
              "토막수": n or 0, "표": os.path.splitext(name)[1].lower() in TABLE_EXT, "색인시각": at}
             for fid, key, rel, name, status, reason, n, at in rows]
    return {"색인기준": as_of, "색인판": INDEX_VERSION,
            "요약": {"전체": n_all or 0, "읽힘": n_ok or 0, "못읽음": why},
            "반환수": len(items), "잘림": (n_all or 0) > len(items), "목록": items}, len(items)


# ── 표 구조 판독(REQ-0117 S1) ────────────────────────────────────────────────
# 색인용 글자(_read_xlsx)는 셀을 " | " 로 이어 붙여 열 위치·머리글·날짜가 사라진다. 여기서는 그것을 살려 돌려준다.
# 값은 어디에도 쌓지 않는다 — 요청한 창(행 범위)만 읽어 조회 큐로 한 번 나간다.
TABLE_MAX_ROWS = 200
TABLE_MAX_COLS = 40
TABLE_MAX_CHARS = 8000        # 게이트웨이가 도구 결과를 12,000자에서 자른다 — 그 안에 들어가게
TABLE_CELL_CHARS = 200
TABLE_HEAD_ROWS = 30          # 머리글 행을 추정할 때 보는 앞쪽 행 수
TABLE_BUDGET_SEC = 6          # 표 한 건을 읽는 시간 상한 — 넘으면 거부한다(조회 루프가 한 줄이라 한 건이 전체를 막는다)
_DATE_FMT_IDS = set(range(14, 23)) | set(range(27, 37)) | set(range(45, 48)) | set(range(50, 59))


def locate(con, doc, folder_keys):
    """문서 번호 → (폴더키, 폴더 안 상대경로, 이름, 수정시각, 크기).
    색인이 **읽은(ok)** 문서만 내준다 — 주민번호·민감 이름·읽기 실패로 빠진 파일은 어떤 시트도 내주지 않는다."""
    m = re.fullmatch(r"([a-z0-9_]{1,40}):(\d{1,12})", str(doc or ""))
    if not m:
        raise ValueError("문서 번호 형식이 올바르지 않습니다")
    key, fid = m.group(1), int(m.group(2))
    if key not in set(folder_keys):
        raise ValueError("볼 수 없는 문서입니다")
    row = con.execute("select rel, name, mtime, status, reason, size from file where id = ? and folder_key = ?", (fid, key)).fetchone()
    if not row:
        raise ValueError("문서를 찾을 수 없습니다(지워졌거나 색인에서 빠졌습니다)")
    rel, name, mtime, status, reason, size = row
    if status != "ok":
        if str(reason or "").startswith("민감"):
            raise ValueError("민감 정보가 들어 있어 읽지 않는 문서입니다")
        raise ValueError(f"읽을 수 없는 문서입니다({reason or '사유 없음'})")
    return key, rel, name, mtime, size


def _col_index(ref):
    n = 0
    for ch in ref:
        if not ch.isalpha():
            break
        n = n * 26 + (ord(ch.upper()) - 64)
    return n


def _col_name(n):
    out = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        out = chr(65 + r) + out
    return out


def _is_date_format(code):
    c = re.sub(r'"[^"]*"|\[[^\]]*\]|\\.', "", str(code or ""))
    return bool(re.search(r"[ymdhs]", c, re.I)) and not re.fullmatch(r"general", c.strip(), re.I)


def _serial_to_text(v, date1904=False):
    """엑셀 날짜 일련번호 → 'YYYY-MM-DD'(시각이 있으면 ' HH:MM'). 범위를 벗어나면 원값."""
    try:
        f = float(v)
        if not math.isfinite(f) or not (0 <= f < 2958466):
            return str(v)
        base = datetime.datetime(1904, 1, 1) if date1904 else datetime.datetime(1899, 12, 30)
        dt = base + datetime.timedelta(seconds=round(f * 86400))
    except (TypeError, ValueError, OverflowError):
        return str(v)
    if f < 1:
        return dt.strftime("%H:%M")
    return dt.strftime("%Y-%m-%d") if abs(f - round(f)) < 1e-9 else dt.strftime("%Y-%m-%d %H:%M")


def _num_text(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    if not math.isfinite(f):
        return str(v)
    if f == int(f) and abs(f) < 1e15:
        return str(int(f))
    r = repr(round(f, 10))
    return r if "e" in r else r.rstrip("0").rstrip(".")


def _xlsx_book(z):
    """(시트 [(이름, 파일)], 날짜 서식인 스타일 번호 집합, 1904 기준 여부)"""
    names = z.namelist()
    sheets, date1904 = [], False
    if "xl/workbook.xml" in names:
        rels = {}
        if "xl/_rels/workbook.xml.rels" in names:
            for el in ET.fromstring(z.read("xl/_rels/workbook.xml.rels")):
                t = str(el.get("Target") or "").lstrip("/")
                rels[el.get("Id")] = t if t.startswith("xl/") else "xl/" + t
        for el in ET.fromstring(z.read("xl/workbook.xml")).iter():
            tag = el.tag.rsplit("}", 1)[-1]
            if tag == "workbookPr" and str(el.get("date1904") or "").lower() in ("1", "true"):
                date1904 = True
            elif tag == "sheet":
                rid = next((v for k, v in el.attrib.items() if k.rsplit("}", 1)[-1] == "id"), None)
                target = rels.get(rid)
                if target in names:
                    sheets.append((str(el.get("name") or f"시트 {len(sheets) + 1}"), target))
    if not sheets:
        sheets = [(f"시트 {i}", n) for i, n in enumerate(_zip_members(z, r"xl/worksheets/sheet\d+\.xml$"), 1)]
    date_styles = set()
    if "xl/styles.xml" in names:
        custom, xfs = {}, None
        for el in ET.fromstring(z.read("xl/styles.xml")).iter():
            tag = el.tag.rsplit("}", 1)[-1]
            if tag == "numFmt":
                try:
                    custom[int(el.get("numFmtId"))] = el.get("formatCode")
                except (TypeError, ValueError):
                    pass
            elif tag == "cellXfs":
                xfs = el
        for i, xf in enumerate(list(xfs) if xfs is not None else []):
            try:
                fid = int(xf.get("numFmtId") or 0)
            except ValueError:
                continue
            if fid in _DATE_FMT_IDS or (fid in custom and _is_date_format(custom[fid])):
                date_styles.add(str(i))
    return sheets, date_styles, date1904


def _shared_strings(z):
    """공유 문자열 표. 통째로 올리지 않고 흘려 읽으며, 합계가 상한을 넘으면 멈춘다(그 파일은 너무 큰 것으로 본다)."""
    shared, total = [], 0
    if "xl/sharedStrings.xml" not in z.namelist():
        return shared
    cur, root = [], None
    with z.open("xl/sharedStrings.xml") as fh:
        for ev, el in ET.iterparse(fh, events=("start", "end")):
            if ev == "start":
                if root is None:
                    root = el
                continue
            tag = el.tag.rsplit("}", 1)[-1]
            if tag == "t" and el.text:
                cur.append(el.text)
            elif tag == "si":
                text = "".join(cur)
                shared.append(text)
                total += len(text)
                cur = []
                root.clear()
                if total > MAX_SHARED_CHARS:
                    raise ValueError("파일이 너무 큽니다(문자열이 너무 많음)")
    return shared


def _xlsx_rows(z, member, shared, date_styles, date1904, merges, raw=False):
    """(행 번호, {열 번호: 글자}) 를 차례로 낸다. 병합 범위는 merges 목록에 채운다.
    시트를 통째로 메모리에 올리지 않는다 — 흘려 읽고, 지나간 행은 바로 버린다. raw=True 면 숫자·날짜를 바꾸지 않는다(색인용)."""
    auto_r, row, holder = 0, {}, None
    with z.open(member) as fh:
        for ev, el in ET.iterparse(fh, events=("start", "end")):
            tag = el.tag.rsplit("}", 1)[-1]
            if ev == "start":
                if tag == "sheetData":
                    holder = el
                continue
            if tag == "c":
                v, t, formula = None, el.get("t"), False
                for ch in el:
                    ct = ch.tag.rsplit("}", 1)[-1]
                    if ct == "v" and ch.text is not None:
                        v = ch.text
                    elif ct == "is":
                        v = "".join(x.text or "" for x in ch.iter() if x.tag.rsplit("}", 1)[-1] == "t")
                        t = "inlineStr"
                    elif ct == "f":
                        formula = True
                if v in (None, ""):
                    if not formula or raw:
                        continue
                    v, t = "(수식 — 저장된 값 없음)", "str"     # 계산값이 파일에 없으면 지어내지 않고 그렇게 적는다
                if t == "s":
                    try:
                        v = shared[int(v)]
                    except (ValueError, IndexError):
                        v = ""
                elif t == "b":
                    v = "TRUE" if v == "1" else "FALSE"
                elif t in ("str", "inlineStr", "e") or raw:
                    pass
                elif el.get("s") in date_styles:
                    v = _serial_to_text(v, date1904)
                else:
                    v = _num_text(v)
                v = str(v).strip()
                if v:
                    ci = _col_index(el.get("r") or "") or (max(row) + 1 if row else 1)
                    row[ci] = v
            elif tag == "row":
                try:
                    auto_r = int(el.get("r") or auto_r + 1)
                except ValueError:
                    auto_r += 1
                if row:
                    yield auto_r, row
                row = {}
                if holder is not None:
                    holder.clear()                          # 지나간 행을 부모에서 떼어 낸다(빈 껍데기가 쌓이지 않게)
                else:
                    el.clear()
            elif tag == "mergeCell" and el.get("ref"):
                merges.append(el.get("ref"))


def _csv_rows(path, ext, info):
    text, cut = _read_text_ex(path)
    info["cut"] = cut
    first = text.split("\n", 1)[0]
    delim = "\t" if ext == ".tsv" else max(",;\t", key=first.count)
    for i, cells in enumerate(csv.reader(io.StringIO(text), delimiter=delim), 1):
        row = {j: c.strip() for j, c in enumerate(cells, 1) if c and c.strip()}
        if row:
            yield i, row


def _header_row(head):
    """앞쪽 행들에서 머리글 행을 추정한다 — 칸이 충분히 차 있고 숫자보다 글자가 많은 첫 행. 못 찾으면 None."""
    if not head:
        return None
    most = max(len(r) for _, r in head)
    need = max(2, -(-most * 6 // 10))
    for no, r in head:
        if len(r) >= need:
            texty = sum(1 for v in r.values() if not re.fullmatch(r"[-+]?[\d,.\s%:/-]+", v))
            if texty * 2 >= len(r):
                return no
    return None


def read_table(path, sheet=None, start=None, max_rows=None, max_chars=TABLE_MAX_CHARS, budget_sec=TABLE_BUDGET_SEC):
    """엑셀·CSV 를 표로 읽는다 — 시트 이름 · 머리글(추정) · 열 문자 · 행 번호 · 날짜 복원.

    sheet: 시트 번호(1부터) 또는 이름(이름이 먼저다). start: 시작 행 번호(없으면 머리글 다음 행). 반환 (결과 dict, 행 수).
    필요한 창만 읽고 멈춘다 — 시트 끝까지 훑지 않는다(큰 표 한 건이 조회 전체를 막지 않게). 시간 예산을 넘으면 사유와 함께 거부한다.
    """
    ext = os.path.splitext(path)[1].lower()
    if ext not in TABLE_EXT:
        raise ValueError("표로 읽을 수 있는 형식이 아닙니다(엑셀 xlsx·xlsm, CSV·TSV 만) — 글자는 문서 읽기로 보세요")
    if _SENSITIVE_NAME.search(os.path.basename(path)):
        raise ValueError("민감 파일 이름이라 읽지 않습니다")
    if os.path.getsize(path) > MAX_FILE_BYTES or (ext in ZIP_EXT and _unzip_too_big(path)):
        raise ValueError("파일이 너무 큽니다")
    max_rows = max(1, min(TABLE_MAX_ROWS, int(max_rows or 60)))
    begin = max(1, int(start)) if start not in (None, "") else None
    t0 = time.time()
    z, merges, info = None, [], {"cut": False}
    head, tail, more, ended = [], [], False, False
    try:
        try:
            if ext in (".csv", ".tsv"):
                sheets, idx, it = [("(단일 표)", None)], 0, _csv_rows(path, ext, info)
            else:
                z = zipfile.ZipFile(path)
                sheets, date_styles, date1904 = _xlsx_book(z)
                shared = _shared_strings(z)
                if not sheets:
                    raise ValueError("시트가 없습니다")
                idx = 0
                if sheet not in (None, ""):
                    want = str(sheet).strip()
                    by_name = [i for i, (n, _) in enumerate(sheets) if n == want]
                    if by_name:
                        idx = by_name[0]
                    elif want.isdigit() and 1 <= int(want) <= len(sheets):
                        idx = int(want) - 1
                    else:
                        raise ValueError("그런 시트가 없습니다 — 시트목록을 확인하세요")
                it = _xlsx_rows(z, sheets[idx][1], shared, date_styles, date1904, merges)

            # 앞 30행은 머리글 추정용으로 쥐고, 그 뒤로는 창(시작 행부터 max_rows)이 차면 한 행만 더 보고 멈춘다
            n_seen = 0
            for no, row in it:
                n_seen += 1
                if n_seen % 500 == 0 and time.time() - t0 > budget_sec:
                    raise ValueError("표가 너무 커서 제때 읽지 못했습니다 — 시작 행(start)을 앞쪽으로 잡거나 파일을 나눠 주세요")
                if any(_RRN.search(v) for v in row.values()):
                    raise ValueError("민감 정보 꼴(주민등록번호)이 있어 읽지 않습니다")
                if len(head) < TABLE_HEAD_ROWS:
                    head.append((no, row))
                elif begin is None or no >= begin:
                    if len(tail) >= max_rows:
                        more = True
                        break
                    tail.append((no, row))
            else:
                ended = True
        except (zipfile.BadZipFile, KeyError, ET.ParseError, csv.Error, OverflowError, UnicodeError):
            raise ValueError("파일이 깨졌거나 암호가 걸려 있습니다")
    finally:
        if z is not None:
            z.close()

    hdr = _header_row(head)
    auto = begin is None

    def take(first):
        return [(no, row) for no, row in head + tail if no >= first][:max_rows]

    if auto:
        begin = (hdr + 1) if hdr else (head[0][0] if head else 1)
    window = take(begin)
    if auto and hdr and not window:                        # 머리글로 본 행 아래가 비었다 — 머리글이 아니라 내용이다
        hdr, begin = None, (head[0][0] if head else 1)
        window = take(begin)
    left = [no for no, _ in head + tail if no >= begin][len(window):]     # 읽었지만 창에 못 담은 행

    def clip(v, n=TABLE_CELL_CHARS):
        return v if len(v) <= n else v[:n] + "…"

    hdr_cells = dict(next((r for n, r in head if n == hdr), {})) if hdr else {}
    # 머리글 위쪽(제목·업체명·작성일 같은 줄) — 표의 열과 맞지 않으므로 칸 주소째로 따로 준다. 시작 행을 직접 준 경우엔 뺀다
    above = [{"행": n, "값": {_col_name(c): clip(v, 120) for c, v in sorted(r.items())[:12]}}
             for n, r in head if hdr and auto and n < hdr][:8]
    cols = sorted(set(hdr_cells) | {c for _, r in window for c in r})
    cut_cols = len(cols) > TABLE_MAX_COLS
    cols = cols[:TABLE_MAX_COLS]

    def build(win):
        last = win[-1][0] if win else None
        has_more = bool(win) and (more or bool(left) or len(win) < len(window))
        return {"시트목록": [{"번호": i + 1, "이름": clip(n, 60)} for i, (n, _) in enumerate(sheets[:50])],
                "시트": {"번호": idx + 1, "이름": clip(sheets[idx][0], 60)},
                "머리글행": hdr, "머리글": {_col_name(c): clip(v, 60) for c, v in sorted(hdr_cells.items()) if c in cols},
                "머리글위": above,
                "열": [_col_name(c) for c in cols], "열잘림": cut_cols,
                "행범위": [win[0][0], last] if win else None,
                "다음행": (last + 1) if has_more else None,
                "끝까지읽음": bool(ended and not has_more and not info["cut"]),
                "앞부분만읽음": bool(info["cut"]),
                "병합": merges[:20], "병합수": len(merges),
                "안내": "행의 첫 값은 엑셀 행 번호, 나머지는 「열」 순서의 셀 값이다. 머리글행은 추정이다. 날짜 서식 셀은 날짜로 바꿨다.",
                "행": [[no] + [clip(r.get(c, "")) for c in cols] for no, r in win]}

    # 실제로 나갈 글자 수로 창을 줄인다 — 게이트웨이가 12,000자에서 자르므로 그 전에 여기서 맞춘다(행이 조용히 빠지지 않게)
    win = window
    res = build(win)
    while len(win) > 1 and len(json.dumps(res, ensure_ascii=False)) > max_chars:
        win = win[:max(1, len(win) * 3 // 4)]
        res = build(win)
    return res, len(res["행"])


