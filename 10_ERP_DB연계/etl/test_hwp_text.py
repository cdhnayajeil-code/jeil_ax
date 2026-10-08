# -*- coding: utf-8 -*-
"""test_hwp_text.py — hwp_text(HWP 5.0 본문 추출기) 헤드리스 회귀 (REQ-0124)

실제 사내 규정 hwp 는 저장소에 넣지 않는다. 대신 규격대로 레코드·헤더 바이트를 **합성**하고,
OLE 컨테이너는 FakeOle(스트림 dict) 로 갈아끼운다 — olefile 은 OLE 쓰기를 못 하기 때문이다.
실행: python -m unittest test_hwp_text
"""
import io
import os
import struct
import sys
import tempfile
import unittest
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hwp_text  # noqa: E402

TAG_PARA_HEADER = 66
TAG_PARA_TEXT = 67


def w(s):
    """문자열 → UTF-16LE 코드유닛."""
    return s.encode("utf-16-le")


def ctrl(code):
    """인라인·확장 컨트롤 8 코드유닛: 코드 + 6 WCHAR 정보 + 코드."""
    return struct.pack("<H", code) + b"\x00" * 12 + struct.pack("<H", code)


def rec(tag, payload, level=0, long_size=False):
    size = len(payload)
    if size >= 0xFFF or long_size:
        return struct.pack("<I", tag | (level << 10) | (0xFFF << 20)) + struct.pack("<I", size) + payload
    return struct.pack("<I", tag | (level << 10) | (size << 20)) + payload


def para(units, level=0, end=True):
    """PARA_HEADER(더미) + PARA_TEXT. end=True 면 문단 끝(13)을 붙인다."""
    body = units + (struct.pack("<H", 13) if end else b"")
    return rec(TAG_PARA_HEADER, b"\x00" * 22, level) + rec(TAG_PARA_TEXT, body, level)


def deflate(b):
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    return c.compress(b) + c.flush()


def header(version=(5, 0, 3, 0), compressed=True, encrypted=False, distribution=False, drm=False, cert=False):
    ver = (version[0] << 24) | (version[1] << 16) | (version[2] << 8) | version[3]
    flags = (1 if compressed else 0) | (2 if encrypted else 0) | (4 if distribution else 0) \
        | (16 if drm else 0) | (256 if cert else 0)
    sig = hwp_text.SIGNATURE + b"\x00" * (32 - len(hwp_text.SIGNATURE))
    return sig + struct.pack("<I", ver) + struct.pack("<I", flags) + b"\x00" * 216


class FakeOle:
    def __init__(self, streams):
        self.streams = streams
        self.closed = False

    def exists(self, name):
        return name in self.streams

    def openstream(self, name):
        return io.BytesIO(self.streams[name])

    def listdir(self):
        return [n.split("/") for n in self.streams]

    def close(self):
        self.closed = True


class Patched(unittest.TestCase):
    def setUp(self):
        self._orig = (hwp_text._is_ole, hwp_text._open_ole, hwp_text.hwp_ready)
        self.ole = None

    def tearDown(self):
        hwp_text._is_ole, hwp_text._open_ole, hwp_text.hwp_ready = self._orig

    def use(self, streams, ready=True):
        self.ole = FakeOle(streams)
        hwp_text.hwp_ready = lambda: ready
        hwp_text._is_ole = lambda p: True
        hwp_text._open_ole = lambda p: self.ole

    def doc(self, *sections, **hdr):
        compressed = hdr.pop("compressed", True)
        streams = {"FileHeader": header(compressed=compressed, **hdr)}
        for i, sec in enumerate(sections):
            streams["BodyText/Section%d" % i] = deflate(sec) if compressed else sec
        return streams


class TestHeader(unittest.TestCase):
    def test_flags_and_version(self):
        h = hwp_text.parse_file_header(header(version=(5, 0, 2, 1), compressed=True, distribution=True, cert=True))
        self.assertTrue(h["ok"])
        self.assertEqual(h["version"], (5, 0, 2, 1))
        self.assertTrue(h["compressed"] and h["distribution"] and h["cert_encrypted"])
        self.assertFalse(h["encrypted"] or h["drm"])

    def test_bad_signature(self):
        self.assertFalse(hwp_text.parse_file_header(b"PK\x03\x04" + b"\x00" * 60)["ok"])
        self.assertFalse(hwp_text.parse_file_header(b"")["ok"])


class TestRecords(unittest.TestCase):
    def test_para_text_controls(self):
        units = w("제1조(목적)") + ctrl(9) + w("이 규정은") + ctrl(11) + w("표 앞") + struct.pack("<H", 24) \
            + struct.pack("<H", 30) + struct.pack("<H", 10) + w("둘째 줄") + struct.pack("<H", 0) + w("끝")
        t = hwp_text._para_text(units)
        self.assertEqual(t, "제1조(목적)\t이 규정은표 앞- \n둘째 줄끝")

    def test_odd_tail_byte_ignored(self):
        self.assertEqual(hwp_text._para_text(w("가나") + b"\x00"), "가나")

    def test_surrogate_pair(self):
        self.assertEqual(hwp_text._para_text(w("😀규정")), "😀규정")

    def test_long_record_and_order(self):
        long_txt = "조문 " * 1500                       # 6,000자 → 12,000바이트 > 0xFFF
        raw = para(w("제1조 머리")) + para(w(long_txt)) + para(w("부칙"), level=2)
        t = hwp_text.parse_section(raw)
        self.assertTrue(t.startswith("제1조 머리\n"))
        self.assertIn(long_txt.strip(), t)
        self.assertTrue(t.rstrip().endswith("부칙"))

    def test_truncated_stream_no_exception(self):
        raw = para(w("제1조 온전")) + para(w("제2조 잘린 문단"))
        cut = raw[:-6]
        t = hwp_text.parse_section(cut)
        self.assertIn("제1조 온전", t)
        self.assertNotIn("제2조 잘린 문단", t)

    def test_non_text_records_skipped(self):
        raw = rec(71, b"\x01" * 10) + para(w("본문")) + rec(77, b"\x02" * 20)
        self.assertEqual(hwp_text.parse_section(raw).strip(), "본문")


class TestExtract(Patched):
    def test_reads_compressed_sections_in_order(self):
        self.use(self.doc(para(w("제1장 총칙")) + para(w("제1조(목적) 이 규정은 …")),
                          para(w("제2장 복무")) + para(w("제5조(근무시간) 09:00~18:00"))))
        text, why = hwp_text.extract_hwp("x.hwp")
        self.assertIsNone(why)
        self.assertEqual(text.split("\n"), ["제1장 총칙", "제1조(목적) 이 규정은 …", "", "제2장 복무", "제5조(근무시간) 09:00~18:00"])
        self.assertTrue(self.ole.closed)

    def test_section_order_numeric(self):
        s = self.doc(para(w("A")), para(w("B")), para(w("C")))
        s["BodyText/Section10"] = deflate(para(w("K")))
        self.use(s)
        self.assertEqual(hwp_text.extract_hwp("x.hwp")[0].split("\n"), ["A", "", "B", "", "C", "", "K"])

    def test_uncompressed_flag(self):
        self.use(self.doc(para(w("비압축 본문")), compressed=False))
        self.assertEqual(hwp_text.extract_hwp("x.hwp"), ("비압축 본문", None))

    def test_encrypted_distribution_drm(self):
        self.use(self.doc(para(w("x")), encrypted=True))
        self.assertEqual(hwp_text.extract_hwp("x.hwp")[1], hwp_text.REASON_ENCRYPTED)
        self.use(self.doc(para(w("x")), distribution=True))
        self.assertEqual(hwp_text.extract_hwp("x.hwp")[1], hwp_text.REASON_DISTRIBUTION)
        self.use(self.doc(para(w("x")), drm=True))
        self.assertEqual(hwp_text.extract_hwp("x.hwp")[1], hwp_text.REASON_DRM)
        self.use(self.doc(para(w("x")), cert=True))
        self.assertEqual(hwp_text.extract_hwp("x.hwp")[1], hwp_text.REASON_ENCRYPTED)

    def test_not_version_5(self):
        self.use(self.doc(para(w("x")), version=(6, 0, 0, 0)))
        self.assertIn("5.0 아님", hwp_text.extract_hwp("x.hwp")[1])

    def test_no_sections_and_empty(self):
        self.use({"FileHeader": header()})
        self.assertEqual(hwp_text.extract_hwp("x.hwp")[1], "본문 구역 없음")
        self.use(self.doc(para(w("   "))))
        self.assertTrue(hwp_text.extract_hwp("x.hwp")[1].startswith(hwp_text.REASON_EMPTY))

    def test_broken_compressed_section_skipped(self):
        s = self.doc(para(w("정상 구역")))
        s["BodyText/Section1"] = b"\xff\xfe\x00 not deflate"
        self.use(s)
        text, why = hwp_text.extract_hwp("x.hwp")
        self.assertIsNone(why)
        self.assertEqual(text, "정상 구역")

    def test_max_chars(self):
        self.use(self.doc(para(w("가" * 500))))
        self.assertEqual(len(hwp_text.extract_hwp("x.hwp", max_chars=100)[0]), 100)

    def test_no_module_reason(self):
        self.use(self.doc(para(w("x"))), ready=False)
        self.assertEqual(hwp_text.extract_hwp("x.hwp"), (None, hwp_text.REASON_NO_MODULE))

    def test_open_failure_is_reason_not_exception(self):
        hwp_text.hwp_ready = lambda: True
        hwp_text._is_ole = lambda p: True

        def boom(p):
            raise OSError("locked")
        hwp_text._open_ole = boom
        self.assertEqual(hwp_text.extract_hwp("x.hwp"), (None, "읽기 실패(OSError)"))


class TestRealFiles(unittest.TestCase):
    """OLE 가 아닌 실제 파일 — olefile.isOleFile 을 그대로 쓴다(설치돼 있을 때만)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hwp_")

    def _write(self, name, data):
        p = os.path.join(self.tmp, name)
        with open(p, "wb") as fh:
            fh.write(data)
        return p

    @unittest.skipUnless(hwp_text.hwp_ready(), "olefile 없음")
    def test_hwp3_signature(self):
        p = self._write("old.hwp", b"HWP Document File V3.00 \x1a\x01\x02\x03" + b"\x00" * 100)
        self.assertEqual(hwp_text.extract_hwp(p), (None, hwp_text.REASON_V3))

    @unittest.skipUnless(hwp_text.hwp_ready(), "olefile 없음")
    def test_not_ole(self):
        p = self._write("junk.hwp", "구형 한글이라고 적힌 평문".encode("utf-8"))
        self.assertEqual(hwp_text.extract_hwp(p), (None, hwp_text.REASON_NOT_HWP))


class TestNasIndexIntegration(Patched):
    """nas_index.extract() 가 .hwp 를 hwp_text 로 넘기고, 공통 후처리(주민등록번호 꼴 차단)를 그대로 적용한다."""

    def setUp(self):
        super().setUp()
        import nas_index
        self.ix = nas_index
        self.tmp = tempfile.mkdtemp(prefix="hwpix_")
        self.path = os.path.join(self.tmp, "규정.hwp")
        with open(self.path, "wb") as fh:
            fh.write(b"\x00" * 64)                     # 크기만 있으면 된다 — OLE 열기는 FakeOle 로 간다

    def test_extract_routes_to_hwp_text(self):
        self.assertIn(".hwp", self.ix.READABLE)
        self.use(self.doc(para(w("제1조(목적)  이 규정은   취업규칙이다"))))
        text, why = self.ix.extract(self.path)
        self.assertIsNone(why)
        self.assertEqual(text, "제1조(목적) 이 규정은 취업규칙이다")

    def test_rrn_blocked_after_hwp(self):
        self.use(self.doc(para(w("담당자 900101-1234567 연락"))))
        self.assertEqual(self.ix.extract(self.path), (None, "민감 정보 꼴(주민등록번호) 포함"))

    def test_reason_passthrough(self):
        self.use(self.doc(para(w("x")), distribution=True))
        self.assertEqual(self.ix.extract(self.path), (None, hwp_text.REASON_DISTRIBUTION))
        self.use(self.doc(para(w("x"))), ready=False)
        self.assertEqual(self.ix.extract(self.path), (None, hwp_text.REASON_NO_MODULE))

    def test_retry_reasons_cover_hwp_module(self):
        self.assertIn(hwp_text.REASON_NO_MODULE, self.ix.RETRY_REASONS)
        self.assertIn(self.ix.REASON_UNREADABLE, self.ix.RETRY_REASONS)


if __name__ == "__main__":
    unittest.main()
