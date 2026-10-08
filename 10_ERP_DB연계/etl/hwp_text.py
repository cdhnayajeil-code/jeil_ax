# -*- coding: utf-8 -*-
"""hwp_text.py — 구형 한글(HWP 5.0) 본문 글자 추출기 (순수 파이썬 · olefile + zlib)

왜 있나
  사내규정 첨부의 다수가 구형 `.hwp` 다. NAS 색인(nas_index)은 `.hwpx`(zip+xml)만 읽고 `.hwp` 는
  「읽지 못하는 형식」으로 뺐다(REQ-0117 비목표). 한글 오피스 없이 글자만 뽑는 길은 OLE 컨테이너를
  직접 열어 BodyText 의 문단 레코드를 읽는 것뿐이다(REQ-0124 · 관리자 결정 2026-10-08).

무엇을 읽나(HWP 5.0 파일 형식 공개 규격 기준)
  · OLE 스트림 `FileHeader`(256B): 서명·버전·속성 비트(압축·암호·배포용·DRM·인증서).
  · `BodyText/Section0..N`: 속성에 압축 비트가 있으면 raw deflate(zlib wbits=-15)로 풀고,
    4바이트 레코드 헤더(tag 10비트 · level 10비트 · size 12비트 — size 0xFFF 면 다음 DWORD 가 실제 크기)를
    따라가며 **HWPTAG_PARA_TEXT(67)** 레코드의 UTF-16LE 글자만 문서 순서대로 모은다.
    표 셀·글상자 안 문단도 같은 스트림에 더 깊은 level 로 이어져 있어 순서가 보존된다.
  · 제어 문자(코드 0~31): 인라인·확장 컨트롤은 **8 코드유닛(16바이트)** 를 차지하므로 통째로 건너뛴다.
    탭(9)은 탭으로, 줄 끝(10)·문단 끝(13)은 줄바꿈으로, 하이픈(24)은 '-', 묶음·고정폭 빈칸(30·31)은 공백으로.

읽지 않는 것(사유를 돌려준다 — 복호화·우회를 시도하지 않는다)
  · 암호 문서 · 배포용 문서(본문이 ViewText 로 암호화) · DRM · 인증서 암호화 · hwp 3.0 · OLE 가 아닌 파일
  · 미리보기 스트림(PrvText)은 앞 1KB 뿐이라 쓰지 않는다.

한계(알고 쓴다)
  · 개요 번호·자동 번호(문단 속성·확장 컨트롤 18)는 글자가 아니라 **「1.」「제1조」 같은 번호가 빠질 수 있다**
    → 조문 파서(reg_parse)가 폴백으로 흡수한다.
  · 머리말·꼬리말·각주 문단이 본문에 섞인다(쪽 번호 「- 1 -」 같은 잡음) → 파서가 무시한다.
  · 그리기 개체 안 글자의 순서가 본문과 어긋날 수 있다. 표·그림 구조는 보존하지 않는다(글자만).

사용
  python hwp_text.py <파일.hwp>            # 사유 또는 글자 수·앞 500자 출력(실제 규정 파일 수동 검증용 · 파일은 저장소 밖)
  from hwp_text import extract_hwp         # (text, reason) — nas_index.extract()·gw_board_collect 가 부른다

olefile 은 함수 안에서 늦게 import 한다 — 없는 호스트(EXE·옛 컨테이너)에서도 모듈 import 는 성공하고
`hwp_ready()` 가 False 를 돌려주어 호출측이 사유를 남긴다(nas_index.pdf_ready 와 같은 꼴).
"""
import importlib.util
import os
import re
import struct
import sys
import zlib

HWP_TEXT_VERSION = "h1.0"

SIGNATURE = b"HWP Document File"
SIG_V3 = b"HWP Document File V"            # hwp 3.0 계열은 OLE 가 아니라 평문 서명으로 시작한다
TAG_PARA_TEXT = 67                          # HWPTAG_BEGIN(0x10) + 51
MAX_CHARS = 1_500_000                       # nas_index.MAX_TEXT_CHARS 와 같다

REASON_NO_MODULE = "hwp 읽기 모듈 없음(olefile)"
REASON_NOT_HWP = "hwp 아님/깨짐"
REASON_V3 = "hwp 3.0 — 읽지 못함"
REASON_ENCRYPTED = "암호가 걸린 hwp"
REASON_DISTRIBUTION = "배포용 hwp(본문 암호화) — 읽지 못함"
REASON_DRM = "DRM hwp — 읽지 못함"
REASON_EMPTY = "글자가 없음"

# 8 코드유닛(16바이트)을 차지하는 제어 문자 — 인라인(4·5·6·7·8·9·19·20)과 확장(1·2·3·11·12·14·15·16·17·18·21·22·23).
# 탭(9)은 여기 포함되지만 출력은 '\t' 로 한다.
_CTRL_16 = {1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23}


def hwp_ready():
    """olefile 이 설치돼 있는가. 없으면 호출측이 사유를 남기고 넘어간다."""
    try:
        return importlib.util.find_spec("olefile") is not None
    except Exception:
        return False


def _is_ole(path):
    import olefile
    return olefile.isOleFile(path)


def _open_ole(path):
    import olefile
    return olefile.OleFileIO(path)


def parse_file_header(data):
    """FileHeader 스트림(256B) → 속성 dict. 서명이 다르면 ok False."""
    if not data or len(data) < 40 or not data.startswith(SIGNATURE):
        return {"ok": False, "reason": REASON_NOT_HWP}
    ver = struct.unpack_from("<I", data, 32)[0]
    flags = struct.unpack_from("<I", data, 36)[0]
    return {
        "ok": True,
        "version": ((ver >> 24) & 0xFF, (ver >> 16) & 0xFF, (ver >> 8) & 0xFF, ver & 0xFF),
        "compressed": bool(flags & 0x0001),
        "encrypted": bool(flags & 0x0002),
        "distribution": bool(flags & 0x0004),
        "script": bool(flags & 0x0008),
        "drm": bool(flags & 0x0010),
        "cert_encrypted": bool(flags & 0x0100),
        "cert_drm": bool(flags & 0x0400),
    }


def _records(buf):
    """레코드 헤더를 따라가며 (tag, level, payload) 를 낸다. 잘린 파일은 거기서 조용히 멈춘다."""
    pos, n = 0, len(buf)
    while pos + 4 <= n:
        h = struct.unpack_from("<I", buf, pos)[0]
        pos += 4
        tag = h & 0x3FF
        level = (h >> 10) & 0x3FF
        size = (h >> 20) & 0xFFF
        if size == 0xFFF:
            if pos + 4 > n:
                return
            size = struct.unpack_from("<I", buf, pos)[0]
            pos += 4
        if pos + size > n:
            return
        yield tag, level, buf[pos:pos + size]
        pos += size


def _para_text(payload):
    """PARA_TEXT 레코드의 UTF-16LE 글자. 제어 문자 규칙은 모듈 머리말 참조."""
    out = []
    run = bytearray()
    i = 0
    n = len(payload) - (len(payload) % 2)      # 홀수 꼬리 바이트는 버린다

    def flush():
        if run:
            out.append(bytes(run).decode("utf-16-le", "replace"))
            run.clear()

    while i + 2 <= n:
        c = payload[i] | (payload[i + 1] << 8)
        if c >= 32:
            run += payload[i:i + 2]
            i += 2
            continue
        flush()
        if c == 9:
            out.append("\t")
            i += 16
        elif c in _CTRL_16:
            i += 16
        elif c in (10, 13):
            out.append("\n")
            i += 2
        elif c == 24:
            out.append("-")
            i += 2
        elif c in (30, 31):
            out.append(" ")
            i += 2
        else:                                   # 0 · 25~29 예약
            i += 2
    flush()
    return "".join(out)


def parse_section(raw):
    """해제된 섹션 바이트 → 문단 글자(문서 순서)."""
    parts = []
    for tag, _level, payload in _records(raw):
        if tag == TAG_PARA_TEXT:
            t = _para_text(payload)
            if t:
                parts.append(t if t.endswith("\n") else t + "\n")
    return "".join(parts)


def _section_no(name):
    m = re.search(r"(\d+)$", name)
    return int(m.group(1)) if m else 0


def _inflate(raw):
    """raw deflate 해제. 꼬리가 잘린 스트림은 가능한 데까지만 돌려준다. 실패하면 None."""
    try:
        return zlib.decompress(raw, -15)
    except zlib.error:
        pass
    try:
        d = zlib.decompressobj(-15)
        out = d.decompress(raw)
        return out if out else None
    except zlib.error:
        return None


def extract_hwp(path, max_chars=MAX_CHARS):
    """(글자, 사유). 글자가 None 이면 사유가 그 이유다 — nas_index.extract() 와 같은 규약."""
    if not hwp_ready():
        return None, REASON_NO_MODULE
    try:
        if not _is_ole(path):
            with open(path, "rb") as f:
                head = f.read(32)
            if head.startswith(SIG_V3):
                return None, REASON_V3
            return None, REASON_NOT_HWP
        ole = _open_ole(path)
        try:
            if not ole.exists("FileHeader"):
                return None, REASON_NOT_HWP + "(FileHeader 없음)"
            hdr = parse_file_header(ole.openstream("FileHeader").read())
            if not hdr["ok"]:
                return None, hdr["reason"]
            if hdr["version"][0] != 5:
                return None, "hwp 5.0 아님(v%d)" % hdr["version"][0]
            if hdr["encrypted"] or hdr["cert_encrypted"]:
                return None, REASON_ENCRYPTED
            if hdr["distribution"]:
                return None, REASON_DISTRIBUTION
            if hdr["drm"] or hdr["cert_drm"]:
                return None, REASON_DRM
            names = ["/".join(e) for e in ole.listdir()
                     if len(e) == 2 and e[0] == "BodyText" and e[1].startswith("Section")]
            names.sort(key=_section_no)
            if not names:
                return None, "본문 구역 없음"
            parts, total, bad = [], 0, 0
            for name in names:
                raw = ole.openstream(name).read()
                if hdr["compressed"]:
                    raw = _inflate(raw)
                    if raw is None:
                        bad += 1
                        continue
                txt = parse_section(raw).rstrip("\n")
                if txt:
                    parts.append(txt)             # 구역 사이는 빈 줄 하나로 가른다
                    total += len(txt)
                if total >= max_chars:
                    break
        finally:
            try:
                ole.close()
            except Exception:
                pass
    except Exception as e:                      # 깨진 OLE·권한·I/O — 사유만 남기고 예외는 올리지 않는다
        return None, "읽기 실패(%s)" % type(e).__name__
    text = "\n\n".join(parts)
    text = re.sub(r"[ \t　]+", " ", text)
    text = re.sub(r"[ ]*\n[ ]*", "\n", text).strip()
    if not text:
        return None, REASON_EMPTY + (" · 구역 %d개 해제 실패" % bad if bad else "")
    return text[:max_chars], None


def main(argv=None):
    for _s in (sys.stdout, sys.stderr):
        if hasattr(_s, "reconfigure"):
            _s.reconfigure(encoding="utf-8", errors="replace")
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print("사용: python hwp_text.py <파일.hwp> [--chars N]   (글자만 · 실제 규정 파일은 저장소 밖에서)")
        return 0
    path = argv[0]
    n_show = 500
    if "--chars" in argv:
        try:
            n_show = int(argv[argv.index("--chars") + 1])
        except (IndexError, ValueError):
            pass
    if not os.path.isfile(path):
        print("파일 없음: %s" % os.path.basename(path))
        return 1
    text, why = extract_hwp(path)
    if text is None:
        print("[hwp %s] 읽지 못함 — %s" % (HWP_TEXT_VERSION, why))
        return 1
    lines = text.count("\n") + 1
    print("[hwp %s] %s · %d자 · %d줄" % (HWP_TEXT_VERSION, os.path.basename(path), len(text), lines))
    print(text[:n_show])
    return 0


if __name__ == "__main__":
    sys.exit(main())
