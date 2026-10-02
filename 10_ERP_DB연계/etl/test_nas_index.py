# test_nas_index.py — NAS 문서 색인·검색 회귀(REQ-0104). 실제 NAS·네트워크를 건드리지 않는다(임시 폴더).
#   python -m unittest test_nas_index
import io
import os
import shutil
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import nas_index as ix   # noqa: E402


def make_docx(path, paras):
    body = "".join(f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in paras)
    xml = ('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           f"<w:body>{body}</w:body></w:document>")
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("word/document.xml", xml)


def make_xlsx(path, rows):
    strings, cells = [], []
    for r, row in enumerate(rows, 1):
        cs = []
        for v in row:
            if isinstance(v, (int, float)):
                cs.append(f"<c><v>{v}</v></c>")
            else:
                strings.append(v)
                cs.append(f'<c t="s"><v>{len(strings) - 1}</v></c>')
        cells.append(f'<row r="{r}">{"".join(cs)}</row>')
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("xl/sharedStrings.xml", f"<sst {ns}>" + "".join(f"<si><t>{s}</t></si>" for s in strings) + "</sst>")
        z.writestr("xl/worksheets/sheet1.xml", f"<worksheet {ns}><sheetData>{''.join(cells)}</sheetData></worksheet>")


def make_pptx(path, slides):
    ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
    with zipfile.ZipFile(path, "w") as z:
        for i, t in enumerate(slides, 1):
            z.writestr(f"ppt/slides/slide{i}.xml", f"<p:sld {ns}><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p:sld>")


def make_hwpx(path, paras):
    ns = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"'
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("Contents/section0.xml", f"<hs:sec xmlns:hs=\"http://www.hancom.co.kr/hwpml/2011/section\" {ns}>"
                   + "".join(f"<hp:p><hp:run><hp:t>{p}</hp:t></hp:run></hp:p>" for p in paras) + "</hs:sec>")


class Base(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="nasix_")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.docs = os.path.join(self.root, "docs")
        self.pur = os.path.join(self.docs, "부서", "4300_구매팀")
        self.all = os.path.join(self.docs, "00_전사공유")
        self.hr = os.path.join(self.docs, "부서", "6100_인사팀")
        for d in (self.pur, self.all, self.hr, os.path.join(self.pur, "양식")):
            os.makedirs(d)
        self.folders = [{"key": "pur", "rel_path": "부서/4300_구매팀", "label": "구매팀"},
                        {"key": "common", "rel_path": "00_전사공유", "label": "전사공유"}]
        self.con = ix.connect(os.path.join(self.root, "state", "ix.sqlite"))
        self.addCleanup(self.con.close)

    def write(self, path, text):
        with io.open(path, "w", encoding="utf-8") as fh:
            fh.write(text)


class TestExtract(Base):
    def test_reads_office_and_hwpx(self):
        make_docx(os.path.join(self.pur, "a.docx"), ["구매규정 제3조", "수의계약은 2천만원 이하로 한다"])
        make_xlsx(os.path.join(self.pur, "b.xlsx"), [["품목", "단가"], ["볼트 M8", 1200]])
        make_pptx(os.path.join(self.pur, "c.pptx"), ["협력사 평가 기준", "납기 준수율 95%"])
        make_hwpx(os.path.join(self.pur, "d.hwpx"), ["검수 절차 안내", "입고 후 3일 이내 검수"])
        self.assertIn("수의계약은 2천만원 이하", ix.extract(os.path.join(self.pur, "a.docx"))[0])
        x = ix.extract(os.path.join(self.pur, "b.xlsx"))[0]
        self.assertIn("볼트 M8 | 1200", x)
        self.assertIn("[슬라이드 2]", ix.extract(os.path.join(self.pur, "c.pptx"))[0])
        self.assertIn("입고 후 3일 이내 검수", ix.extract(os.path.join(self.pur, "d.hwpx"))[0])

    def test_reads_cp949_text(self):
        p = os.path.join(self.pur, "old.txt")
        with open(p, "wb") as fh:
            fh.write("발주서 작성 요령".encode("cp949"))
        self.assertEqual(ix.extract(p)[0], "발주서 작성 요령")

    def test_refuses_with_reason(self):
        self.write(os.path.join(self.pur, "x.hwp"), "구형 한글")
        self.assertEqual(ix.extract(os.path.join(self.pur, "x.hwp")), (None, "읽지 못하는 형식"))
        self.write(os.path.join(self.pur, "empty.txt"), "   ")
        self.assertEqual(ix.extract(os.path.join(self.pur, "empty.txt"))[1], "글자가 없음(스캔본·빈 문서)")
        self.write(os.path.join(self.pur, "broken.docx"), "zip 이 아니다")
        self.assertEqual(ix.extract(os.path.join(self.pur, "broken.docx"))[1], "파일이 깨졌거나 암호가 걸림")

    def test_rrn_file_is_never_indexed(self):
        p = os.path.join(self.pur, "명부.txt")
        self.write(p, "담당자 홍길동 900101-1234567 연락처")
        self.assertEqual(ix.extract(p), (None, "민감 정보 꼴(주민등록번호) 포함"))
        self.write(os.path.join(self.pur, "전화.txt"), "대표번호 031-1234-5678 · 사업자 123-45-67890 · 발주 260101-0000001")
        self.assertIsNotNone(ix.extract(os.path.join(self.pur, "전화.txt"))[0], "전화·사업자번호·발주번호를 주민번호로 오인하면 안 된다")

    def test_chunks_overlap_and_cover(self):
        text = "\n".join(f"제{i}조 " + "가나다라마" * 30 for i in range(1, 21))
        parts = ix.chunks_of(text)
        self.assertGreater(len(parts), 3)
        self.assertTrue(all(len(p) <= ix.CHUNK_CHARS + ix.CHUNK_OVERLAP + 2 for p in parts))
        joined = "".join(parts)
        for i in (1, 10, 20):
            self.assertIn(f"제{i}조", joined)


class TestIndexAndSearch(Base):
    def seed(self):
        make_docx(os.path.join(self.pur, "구매규정.docx"), ["제3조(수의계약) 수의계약은 추정가격 2천만원 이하인 경우에 할 수 있다.",
                                                         "제4조(견적) 견적은 2개 업체 이상에서 받는다."])
        self.write(os.path.join(self.pur, "양식", "발주서_작성요령.txt"), "발주서에는 납기와 단가를 반드시 적는다. 수의계약 건은 사유서를 붙인다.")
        self.write(os.path.join(self.all, "사규_출장.md"), "출장비는 실비로 정산한다. 숙박비 상한은 10만원이다.")
        self.write(os.path.join(self.hr, "인사규정.txt"), "수의계약과 무관한 인사팀 문서 — 다른 부서 폴더")
        self.write(os.path.join(self.pur, "급여대장_2026.txt"), "수의계약 급여 내용")
        self.write(os.path.join(self.pur, "#recycle_x.txt"), "수의계약 휴지통")
        return ix.refresh(self.con, self.docs, self.folders)

    def test_refresh_indexes_scope_only_and_records_reasons(self):
        r = self.seed()
        self.assertEqual((r["files"], r["indexed"]), (4, 3))
        st = ix.stats(self.con)
        self.assertEqual(st["skipped"], {"민감 파일 이름": 1})
        names = [n for (n,) in self.con.execute("select name from file")]
        self.assertNotIn("인사규정.txt", names, "허용 목록에 없는 폴더는 색인하지 않는다")
        self.assertNotIn("#recycle_x.txt", names)
        self.assertEqual(self.con.execute("select count(*) from chunk where body like '%급여%'").fetchone()[0], 0,
                         "빠진 파일의 글자는 한 글자도 색인에 없다")

    def test_search_partial_korean_and_scope(self):
        self.seed()
        res, n = ix.search(self.con, "수의계약", ["pur", "common"])
        self.assertEqual(sorted(h["이름"] for h in res["목록"]), ["구매규정.docx", "발주서_작성요령.txt"])
        self.assertIn("수의계약", res["목록"][0]["발췌"])
        self.assertEqual(ix.search(self.con, "수의계약", ["common"])[1], 0, "볼 수 없는 폴더의 문서는 안 나온다")
        self.assertEqual([h["이름"] for h in ix.search(self.con, "숙박비 상한", ["pur", "common"])[0]["목록"]], ["사규_출장.md"])
        self.assertEqual([h["이름"] for h in ix.search(self.con, "견적", ["pur"])[0]["목록"]], ["구매규정.docx"], "두 글자 낱말도 찾는다")
        self.assertEqual(ix.search(self.con, "없는낱말입니다", ["pur", "common"])[1], 0)
        sub = {h["이름"]: h["경로"] for h in ix.search(self.con, "납기", ["pur"])[0]["목록"]}
        self.assertEqual(sub, {"발주서_작성요령.txt": "양식"})
        self.assertNotIn(self.root, str(res), "절대경로를 내보내지 않는다")
        for bad in ("", "   "):
            with self.assertRaises(ValueError):
                ix.search(self.con, bad, ["pur"])
        with self.assertRaises(ValueError):
            ix.search(self.con, "수의계약", [])

    def test_search_survives_fts_special_characters(self):
        self.seed()
        for q in ('"수의계약', "수의계약 OR 1=1", "AND", "NEAR(", "100%", "a_b", "*"):
            ix.search(self.con, q, ["pur", "common"])     # 예외 없이 끝나야 한다

    def test_read_only_within_scope(self):
        self.seed()
        hit = ix.search(self.con, "수의계약", ["pur"])[0]["목록"][0]
        doc, n = ix.read(self.con, hit["문서"], ["pur"])
        self.assertIn("추정가격 2천만원 이하", doc["내용"]) if doc["이름"] == "구매규정.docx" else self.assertIn("사유서", doc["내용"])
        with self.assertRaises(ValueError):
            ix.read(self.con, hit["문서"], ["common"])
        fid = hit["문서"].split(":")[1]
        with self.assertRaises(ValueError):
            ix.read(self.con, f"common:{fid}", ["common"])       # 폴더 키를 바꿔 끼워도 안 된다
        for bad in ("pur:999999", "../x:1", "pur:1;drop", ""):
            with self.assertRaises(ValueError):
                ix.read(self.con, bad, ["pur"])

    def test_incremental_update_delete_and_unregister(self):
        self.seed()
        self.assertEqual(ix.refresh(self.con, self.docs, self.folders)["changed"], 0, "바뀐 게 없으면 다시 읽지 않는다")
        p = os.path.join(self.all, "사규_출장.md")
        self.write(p, "출장비 규정 개정 — 숙박비 상한은 15만원이다. 교통비는 실비.")
        os.utime(p, (os.path.getmtime(p) + 10,) * 2)
        os.remove(os.path.join(self.pur, "양식", "발주서_작성요령.txt"))
        r = ix.refresh(self.con, self.docs, self.folders)
        self.assertEqual((r["changed"], r["removed"]), (1, 1))
        self.assertEqual(ix.search(self.con, "15만원", ["common"])[1], 1)
        self.assertEqual(ix.search(self.con, "10만원", ["common"])[1], 0, "옛 내용이 남으면 안 된다")
        self.assertEqual(ix.search(self.con, "사유서", ["pur"])[1], 0, "지운 파일은 검색되지 않는다")
        ix.refresh(self.con, self.docs, [self.folders[1]])        # 구매팀 폴더 등록 해제
        self.assertEqual(self.con.execute("select count(*) from file where folder_key = 'pur'").fetchone()[0], 0)
        self.assertEqual(ix.search(self.con, "수의계약", ["pur", "common"])[1], 0)

    def test_scope_path_cannot_escape(self):
        self.seed()
        for bad in ("..", "부서/../..", "부서/4300_구매팀/../6100_인사팀", "/etc", ""):
            con = ix.connect(os.path.join(self.root, "state", "b.sqlite"))
            r = ix.refresh(con, os.path.join(self.docs, "부서"), [{"key": "x", "rel_path": bad, "label": "x"}])
            self.assertEqual(r["files"], 0, bad)
            con.close()
            os.remove(os.path.join(self.root, "state", "b.sqlite"))


if __name__ == "__main__":
    unittest.main()
