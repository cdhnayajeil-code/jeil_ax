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
# 무엇을 읽는가: txt·md·csv · docx·xlsx·pptx·hwpx(전부 zip+xml — 표준 라이브러리) · pdf(pypdf 가 있을 때만).
#   구형 한글(hwp)·스캔본 PDF·이미지는 글자를 못 뽑는다 → 색인에서 빠지고 사유가 남는다(조용히 건너뛰지 않는다 §17.6).
#
# 빼는 것(§1.7): 파일 이름에 급여·연봉·인사평가 등이 들어간 파일, 본문에 주민등록번호 꼴이 있는 파일.
#   빠진 파일은 내용이 색인에 **한 글자도** 들어가지 않는다 — 사유만 남는다.
import datetime
import io
import os
import re
import sqlite3
import time
import zipfile
from xml.etree import ElementTree as ET

INDEX_VERSION = "i1.0"

MAX_FILE_BYTES = 40 * 1024 * 1024      # 이보다 크면 읽지 않는다
MAX_TEXT_CHARS = 1_500_000             # 한 파일에서 색인하는 글자 상한
CHUNK_CHARS = 700
CHUNK_OVERLAP = 80
SCAN_MAX = 50000
DEPTH_MAX = 8

TEXT_EXT = {".txt", ".md", ".csv", ".log"}
ZIP_EXT = {".docx", ".xlsx", ".pptx", ".hwpx"}
PDF_EXT = {".pdf"}
READABLE = TEXT_EXT | ZIP_EXT | PDF_EXT

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
    """셀 글자를 행 단위로. 숫자만 있는 셀도 넣는다(「단가 1,200」 같은 표를 찾을 수 있게)."""
    parts = []
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            cur = []
            for ev, el in ET.iterparse(io.BytesIO(z.read("xl/sharedStrings.xml")), events=("end",)):
                tag = el.tag.rsplit("}", 1)[-1]
                if tag == "t" and el.text:
                    cur.append(el.text)
                elif tag == "si":
                    shared.append("".join(cur))
                    cur = []
        for i, n in enumerate(_zip_members(z, r"xl/worksheets/sheet\d+\.xml$"), 1):
            rows, row = [], []
            for ev, el in ET.iterparse(io.BytesIO(z.read(n)), events=("end",)):
                tag = el.tag.rsplit("}", 1)[-1]
                if tag == "c":
                    v = None
                    for ch in el:
                        ct = ch.tag.rsplit("}", 1)[-1]
                        if ct == "v" and ch.text is not None:
                            v = ch.text
                            if el.get("t") == "s":
                                try:
                                    v = shared[int(v)]
                                except (ValueError, IndexError):
                                    v = ""
                        elif ct == "is":
                            v = "".join(t.text or "" for t in ch.iter() if t.tag.rsplit("}", 1)[-1] == "t")
                    if v not in (None, ""):
                        row.append(str(v).strip())
                elif tag == "row":
                    if row:
                        rows.append(" | ".join(row))
                    row = []
                    el.clear()
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


def _read_text(path):
    with open(path, "rb") as fh:
        raw = fh.read(MAX_TEXT_CHARS * 3)
    for enc in ("utf-8-sig", "cp949", "utf-16"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def extract(path):
    """(글자, 사유). 글자가 None 이면 색인하지 않는다 — 사유가 그 이유다."""
    ext = os.path.splitext(path)[1].lower()
    if ext not in READABLE:
        return None, "읽지 못하는 형식"
    if ext in PDF_EXT and not pdf_ready():
        return None, "PDF 읽기 모듈 없음(pypdf)"
    try:
        if os.path.getsize(path) > MAX_FILE_BYTES:
            return None, "파일이 너무 큼"
        if ext in TEXT_EXT:
            text = _read_text(path)
        elif ext == ".docx":
            text = _read_docx(path)
        elif ext == ".xlsx":
            text = _read_xlsx(path)
        elif ext == ".pptx":
            text = _read_pptx(path)
        elif ext == ".hwpx":
            text = _read_hwpx(path)
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
    for f in folders or []:
        key = str(f.get("key") or "")
        rel = str(f.get("rel_path") or "").replace("\\", "/").strip("/")
        if not key or not rel or any(p in ("", ".", "..") for p in rel.split("/")):
            continue
        base = os.path.join(docs_root, *rel.split("/"))
        if not _inside(docs_root, base) or not os.path.isdir(base) or os.path.islink(base):
            continue
        keep_keys.add(key)
        have = {r[0]: r[1:] for r in con.execute("select rel, id, size, mtime from file where folder_key = ?", (key,))}
        found = set()
        for path, sub in _walk(base):
            found.add(sub)
            try:
                st = os.stat(path)
            except OSError:
                continue
            old = have.get(sub)
            if old and old[1] == st.st_size and abs((old[2] or 0) - st.st_mtime) < 1:
                continue
            if budget_sec and time.time() - t0 > budget_sec:
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
    for fid, key, rel, name, mtime, seq, body in rows:
        files.add(fid)
        if per.get(fid, 0) >= per_file or len(hits) >= limit:
            continue
        per[fid] = per.get(fid, 0) + 1
        sub = rel.rsplit("/", 1)[0] if "/" in rel else ""
        hits.append({"문서": f"{key}:{fid}", "토막": seq, "폴더키": key, "경로": sub, "이름": name,
                     "수정일": datetime.datetime.fromtimestamp(mtime or 0, _KST).strftime("%Y-%m-%d"),
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


def stats(con):
    n_all, n_ok = con.execute("select count(*), sum(status = 'ok') from file").fetchone()
    why = dict(con.execute("select reason, count(*) from file where status != 'ok' group by reason").fetchall())
    as_of = (con.execute("select v from meta where k = 'refreshed_at'").fetchone() or [None])[0]
    return {"files": n_all or 0, "indexed": n_ok or 0, "skipped": why, "as_of": as_of}
