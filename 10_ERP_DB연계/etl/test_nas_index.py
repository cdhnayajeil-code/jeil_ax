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
        self.write(os.path.join(self.pur, "x.doc"), "구형 한글")
        self.assertEqual(ix.extract(os.path.join(self.pur, "x.doc")), (None, "읽지 못하는 형식"))
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


# ── REQ-0117 S1 — 읽는 형식 추가 · 판독 상태 · 표 구조 판독 ─────────────────────
def make_book(path, sheets, date_cols=(), date1904=False):
    """시트 이름·셀 주소·날짜 서식이 있는 진짜 꼴의 xlsx. sheets = [(이름, [[값…], …])], date_cols = 날짜 서식을 줄 열 번호."""
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    rns = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    strings = []
    with zipfile.ZipFile(path, "w") as z:
        wb, rels = [], []
        for si, (name, rows) in enumerate(sheets, 1):
            out = []
            for r, row in enumerate(rows, 1):
                cs = []
                for c, v in enumerate(row, 1):
                    if v is None:
                        continue
                    ref = ix._col_name(c) + str(r)
                    if isinstance(v, (int, float)):
                        style = ' s="1"' if c in date_cols and r > 1 else ""
                        cs.append(f'<c r="{ref}"{style}><v>{v}</v></c>')
                    else:
                        strings.append(v)
                        cs.append(f'<c r="{ref}" t="s"><v>{len(strings) - 1}</v></c>')
                out.append(f'<row r="{r}">{"".join(cs)}</row>')
            # 일부러 파일 번호를 시트 순서와 반대로 준다 — 이름은 workbook.xml 로 찾아야 한다
            fn = f"sheet{len(sheets) - si + 1}.xml"
            z.writestr(f"xl/worksheets/{fn}", f"<worksheet {ns}><sheetData>{''.join(out)}</sheetData>"
                       '<mergeCells count="1"><mergeCell ref="A9:B9"/></mergeCells></worksheet>')
            wb.append(f'<sheet name="{name}" sheetId="{si}" r:id="rId{si}"/>')
            rels.append(f'<Relationship Id="rId{si}" Target="worksheets/{fn}"/>')
        pr = ' date1904="1"' if date1904 else ""
        z.writestr("xl/workbook.xml", f'<workbook {ns} {rns}><workbookPr{pr}/>'
                   f'<sheets>{"".join(wb)}</sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", f'<Relationships>{"".join(rels)}</Relationships>')
        z.writestr("xl/styles.xml", f'<styleSheet {ns}><numFmts><numFmt numFmtId="176" formatCode="yyyy&quot;년&quot; m&quot;월&quot; d&quot;일&quot;"/></numFmts>'
                   '<cellXfs><xf numFmtId="0"/><xf numFmtId="176"/></cellXfs></styleSheet>')
        z.writestr("xl/sharedStrings.xml", f"<sst {ns}>" + "".join(f"<si><t>{s}</t></si>" for s in strings) + "</sst>")


class TestMoreFormats(Base):
    def test_new_text_and_markup_formats(self):
        self.write(os.path.join(self.pur, "a.tsv"), "품목\t단가\n볼트\t1200")
        self.write(os.path.join(self.pur, "b.json"), '{"품목": "너트", "단가": 300}')
        self.write(os.path.join(self.pur, "c.html"), "<html><style>p{color:red}</style><script>var 비밀=1</script><body><p>견적 유효기간</p><p>30일 &amp; 연장</p></body></html>")
        self.assertIn("볼트", ix.extract(os.path.join(self.pur, "a.tsv"))[0])
        self.assertIn("너트", ix.extract(os.path.join(self.pur, "b.json"))[0])
        t = ix.extract(os.path.join(self.pur, "c.html"))[0]
        self.assertIn("견적 유효기간", t)
        self.assertIn("30일 & 연장", t)
        self.assertNotIn("color", t)
        self.assertNotIn("비밀", t, "스크립트·스타일은 색인하지 않는다")
        make_xlsx(os.path.join(self.pur, "m.xlsm"), [["품목", "단가"], ["와셔", 50]])
        self.assertIn("와셔 | 50", ix.extract(os.path.join(self.pur, "m.xlsm"))[0])

    def test_image_reason_is_distinct(self):
        self.write(os.path.join(self.pur, "도면.png"), "x")
        self.assertEqual(ix.extract(os.path.join(self.pur, "도면.png")), (None, ix.REASON_IMAGE))

    def test_version_bump_rereads_only_format_skips(self):
        """색인 판이 오르면 「읽지 못하는 형식」으로 빠졌던 파일만 다시 본다 — 크기·수정시각이 그대로여도."""
        self.write(os.path.join(self.pur, "단가.tsv"), "품목\t단가\n볼트\t1200")
        self.write(os.path.join(self.pur, "규정.txt"), "수의계약 기준")
        self.write(os.path.join(self.pur, "옛한글.doc"), "x")
        ix.refresh(self.con, self.docs, self.folders)
        with self.con:      # 옛 판(i1.0)이 tsv 를 형식 때문에 뺐던 상태를 흉내 낸다
            self.con.execute("delete from chunk where file_id in (select id from file where name = '단가.tsv')")
            self.con.execute("update file set status = 'skipped', reason = ?, n_chunks = 0 where name = '단가.tsv'", (ix.REASON_UNREADABLE,))
            self.con.execute("delete from meta where k = 'index_version'")
        r = ix.refresh(self.con, self.docs, self.folders)
        self.assertEqual(r["changed"], 2, "tsv 와 hwp 만 다시 본다(txt 는 그대로)")
        self.assertEqual(self.con.execute("select status from file where name = '단가.tsv'").fetchone()[0], "ok")
        self.assertEqual(ix.refresh(self.con, self.docs, self.folders)["changed"], 0, "판이 기록된 뒤에는 다시 읽지 않는다")


class TestFileStatus(Base):
    def test_status_lists_reasons_without_content(self):
        os.makedirs(os.path.join(self.pur, "AI저장", "2026"))
        self.write(os.path.join(self.pur, "AI저장", "2026", "견적.txt"), "볼트 단가 1200")
        self.write(os.path.join(self.pur, "AI저장", "2026", "스캔.doc"), "x")
        self.write(os.path.join(self.pur, "양식", "발주서.txt"), "발주서 양식")
        self.write(os.path.join(self.hr, "인사.txt"), "인사 문서")
        ix.refresh(self.con, self.docs, self.folders + [{"key": "hr", "rel_path": "부서/6100_인사팀", "label": "인사팀"}])
        res, n = ix.file_status(self.con, ["pur"], under="AI저장")
        self.assertEqual(n, 2)
        self.assertEqual(res["요약"], {"전체": 2, "읽힘": 1, "못읽음": {ix.REASON_UNREADABLE: 1}})
        by = {r["이름"]: r for r in res["목록"]}
        self.assertEqual((by["견적.txt"]["상태"], by["스캔.doc"]["상태"], by["스캔.doc"]["사유"]), ("읽힘", "못 읽음", ix.REASON_UNREADABLE))
        self.assertEqual(by["견적.txt"]["경로"], "AI저장/2026/견적.txt")
        import json
        self.assertNotIn("1200", json.dumps(res, ensure_ascii=False), "판독 상태에는 내용이 실리지 않는다")
        self.assertEqual(ix.file_status(self.con, ["pur"])[1], 3, "폴더를 좁히지 않으면 그 부서 폴더 전체")
        self.assertNotIn("인사.txt", [r["이름"] for r in ix.file_status(self.con, ["pur", "common"])[0]["목록"]])
        with self.assertRaises(ValueError):
            ix.file_status(self.con, ["pur"], under="../6100_인사팀")
        with self.assertRaises(ValueError):
            ix.file_status(self.con, [])


class TestReadTable(Base):
    def book(self):
        p = os.path.join(self.pur, "견적비교.xlsx")
        rows = [["견적 비교표", None, None, None],
                [None, None, None, None],
                ["품목", "규격", "단가", "납기"],
                ["볼트", "M8", 1200, 45931],          # 45931 = 2025-10-01
                ["너트", None, 300.5, 45931.5],
                ["와셔", "M8", 50, 45962]]
        make_book(p, [("요약", [["메모"], ["첫 시트"]]), ("견적", rows)], date_cols=(4,))
        return p

    def test_keeps_sheet_header_columns_and_dates(self):
        res, n = ix.read_table(self.book(), sheet="견적")
        self.assertEqual([s["이름"] for s in res["시트목록"]], ["요약", "견적"], "시트 이름은 workbook.xml 순서로")
        self.assertEqual(res["시트"], {"번호": 2, "이름": "견적"})
        self.assertEqual(res["머리글행"], 3)
        self.assertEqual(res["머리글"], {"A": "품목", "B": "규격", "C": "단가", "D": "납기"})
        self.assertEqual(res["열"], ["A", "B", "C", "D"])
        self.assertEqual(res["행"][0], [4, "볼트", "M8", "1200", "2025-10-01"])
        self.assertEqual(res["행"][1], [5, "너트", "", "300.5", "2025-10-01 12:00"], "빈 칸이 있어도 열이 밀리지 않는다")
        self.assertEqual((n, res["행범위"], res["다음행"], res["끝까지읽음"]), (3, [4, 6], None, True))
        self.assertEqual(res["병합"], ["A9:B9"])
        self.assertEqual(res["머리글위"], [{"행": 1, "값": {"A": "견적 비교표"}}], "머리글 위 제목 줄은 칸 주소째로 따로 준다")
        self.assertEqual(ix.read_table(self.book(), sheet="견적", start=4)[0]["머리글위"], [], "시작 행을 직접 주면 싣지 않는다")
        one, n1 = ix.read_table(self.book(), sheet="요약")
        self.assertEqual((one["머리글행"], [r[1] for r in one["행"]]), (None, ["메모", "첫 시트"]), "한 열짜리 시트는 머리글 없이 전부 내용")

    def test_sheet_by_number_paging_and_limits(self):
        p = self.book()
        self.assertEqual(ix.read_table(p, sheet=1)[0]["시트"]["이름"], "요약")
        two = os.path.join(self.pur, "조건.csv")
        self.write(two, "결제조건,익월말")
        t, nt = ix.read_table(two)
        self.assertEqual((t["머리글행"], t["행"]), (None, [[1, "결제조건", "익월말"]]), "머리글로 보인 줄 아래가 비면 내용으로 돌려준다")
        res, n = ix.read_table(p, sheet="2", start=5, max_rows=1)
        self.assertEqual((n, res["행"][0][0], res["다음행"]), (1, 5, 6))
        with self.assertRaises(ValueError):
            ix.read_table(p, sheet="없는시트")
        big = os.path.join(self.pur, "큰표.xlsx")
        make_book(big, [("목록", [["번호", "품목", "비고"]] + [[i, f"품목{i}", "가" * 300] for i in range(1, 400)])])
        res, n = ix.read_table(big, max_rows=200)
        self.assertLess(n, 60, "글자 예산을 넘기지 않는다")
        self.assertTrue(res["행"][0][3].endswith("…"), "긴 셀은 자른다")
        self.assertEqual(res["다음행"], res["행범위"][1] + 1)
        nxt, m = ix.read_table(big, start=350, max_rows=5)
        self.assertEqual([r[0] for r in nxt["행"]], [350, 351, 352, 353, 354], "머리글 추정 구간 뒤쪽도 시작 행으로 읽는다")
        self.assertEqual(nxt["머리글"]["B"], "품목")

    def test_csv_and_plain_xlsx_without_workbook(self):
        self.write(os.path.join(self.pur, "단가.csv"), "품목,단가,비고\n볼트,1200,\n너트,300,재고")
        res, n = ix.read_table(os.path.join(self.pur, "단가.csv"))
        self.assertEqual((res["머리글행"], res["행"]), (1, [[2, "볼트", "1200", ""], [3, "너트", "300", "재고"]]))
        make_xlsx(os.path.join(self.pur, "옛꼴.xlsx"), [["품목", "단가"], ["볼트", 1200]])
        res, n = ix.read_table(os.path.join(self.pur, "옛꼴.xlsx"))
        self.assertEqual((res["시트"]["이름"], res["행"]), ("시트 1", [[2, "볼트", "1200"]]), "셀 주소·workbook.xml 이 없어도 읽는다")

    def test_refuses_sensitive_and_wrong_types(self):
        p = os.path.join(self.pur, "명부.csv")
        self.write(p, "이름,번호\n홍길동,900101-1234567")
        with self.assertRaisesRegex(ValueError, "주민등록번호"):
            ix.read_table(p)
        self.write(os.path.join(self.pur, "급여대장.csv"), "a,b\n1,2")
        with self.assertRaisesRegex(ValueError, "민감 파일 이름"):
            ix.read_table(os.path.join(self.pur, "급여대장.csv"))
        self.write(os.path.join(self.pur, "글.txt"), "표가 아니다")
        with self.assertRaisesRegex(ValueError, "표로 읽을 수 있는 형식"):
            ix.read_table(os.path.join(self.pur, "글.txt"))
        self.write(os.path.join(self.pur, "깨짐.xlsx"), "zip 아님")
        with self.assertRaisesRegex(ValueError, "깨졌거나"):
            ix.read_table(os.path.join(self.pur, "깨짐.xlsx"))

    def test_date1904_and_locate_scope(self):
        p = os.path.join(self.pur, "맥.xlsx")
        make_book(p, [("표", [["품목", "납기"], ["볼트", 0]])], date_cols=(2,), date1904=True)
        self.assertEqual(ix.read_table(p)[0]["행"][0], [2, "볼트", "00:00"])
        self.write(os.path.join(self.hr, "인사.csv"), "a,b\n1,2")
        self.write(os.path.join(self.pur, "명부.txt"), "홍길동 900101-1234567")
        ix.refresh(self.con, self.docs, self.folders + [{"key": "hr", "rel_path": "부서/6100_인사팀", "label": "인사팀"}])
        hr_id = self.con.execute("select id from file where folder_key = 'hr'").fetchone()[0]
        with self.assertRaisesRegex(ValueError, "볼 수 없는"):
            ix.locate(self.con, f"hr:{hr_id}", ["pur", "common"])
        rrn_id = self.con.execute("select id from file where name = '명부.txt'").fetchone()[0]
        with self.assertRaisesRegex(ValueError, "민감"):
            ix.locate(self.con, f"pur:{rrn_id}", ["pur"])
        ok_id = self.con.execute("select id from file where name = '맥.xlsx'").fetchone()[0]
        self.assertEqual(ix.locate(self.con, f"pur:{ok_id}", ["pur"])[:3], ("pur", "맥.xlsx", "맥.xlsx"))


class TestFindByNameThenRead(Base):
    """REQ-0117 — 「○○ 파일 내용 알려줘」: 이름으로 찾아 문서 번호를 얻고 그 번호로 읽는다."""

    def seed(self):
        os.makedirs(os.path.join(self.pur, "AI저장", "2026"))
        self.write(os.path.join(self.pur, "AI저장", "2026", "test upload.txt"), "납품 일정 메모 — 10월 20일 1차 입고 예정")
        self.write(os.path.join(self.pur, "양식", "발주서_작성요령.txt"), "발주서에는 납기와 단가를 반드시 적는다.")
        self.write(os.path.join(self.pur, "AI저장", "2026", "단가.csv"), "품목,단가\n볼트,1200")
        self.write(os.path.join(self.pur, "AI저장", "2026", "옛한글.doc"), "x")
        self.write(os.path.join(self.hr, "test upload.txt"), "인사팀의 같은 이름 파일")
        ix.refresh(self.con, self.docs, self.folders + [{"key": "hr", "rel_path": "부서/6100_인사팀", "label": "인사팀"}])

    def test_search_matches_file_name_first(self):
        self.seed()
        res, n = ix.search(self.con, "test upload", ["pur", "common"])
        self.assertEqual(n, 1, "본문에 그 낱말이 없어도 이름으로 찾는다 · 남의 폴더의 같은 이름은 안 나온다")
        h = res["목록"][0]
        self.assertEqual((h["이름"], h["일치"], h["경로"]), ("test upload.txt", "파일 이름", "AI저장/2026"))
        self.assertIn("납품 일정 메모", h["발췌"])
        doc, m = ix.read(self.con, h["문서"], ["pur"])
        self.assertIn("1차 입고 예정", doc["내용"], "검색이 준 문서 번호로 내용을 읽는다")
        res, n = ix.search(self.con, "납기", ["pur"])
        self.assertEqual([(x["이름"], x["일치"]) for x in res["목록"]], [("발주서_작성요령.txt", "본문")])
        res, n = ix.search(self.con, "발주서", ["pur"])
        self.assertEqual([x["일치"] for x in res["목록"]], ["파일 이름"], "이름과 본문에 다 걸려도 한 번만 싣는다")
        self.assertEqual(ix.search(self.con, "옛한글", ["pur"])[1], 0, "읽지 못한 파일은 이름으로도 문서 번호를 주지 않는다")
        self.assertEqual(ix.search(self.con, "100%_", ["pur"])[1], 0, "LIKE 특수문자가 들어와도 깨지지 않는다")
        self.assertTrue(ix.search(self.con, "단가", ["pur"])[0]["목록"][0]["표"])

    def test_lookup_gives_doc_ids_for_listing(self):
        self.seed()
        got = ix.lookup(self.con, "pur", ["AI저장/2026/test upload.txt", "AI저장/2026/옛한글.doc", "AI저장/2026/단가.csv", "없는파일.txt"])
        doc, ok, why, table = got["AI저장/2026/test upload.txt"]
        self.assertTrue(ok and why is None and not table)
        self.assertIn("1차 입고 예정", ix.read(self.con, doc, ["pur"])[0]["내용"])
        self.assertEqual(got["AI저장/2026/옛한글.doc"][1:3], (False, ix.REASON_UNREADABLE))
        self.assertTrue(got["AI저장/2026/단가.csv"][3])
        self.assertNotIn("없는파일.txt", got)
        self.assertEqual(ix.lookup(self.con, "pur", []), {})
        self.assertEqual(ix.lookup(self.con, "common", ["AI저장/2026/test upload.txt"]), {}, "폴더 키가 다르면 같은 경로라도 주지 않는다")

    def test_zip_that_expands_too_big_is_refused(self):
        p = os.path.join(self.pur, "부풀린.xlsx")
        make_xlsx(p, [["품목", "단가"], ["볼트", 1200]])
        old = ix.MAX_UNZIP_BYTES
        ix.MAX_UNZIP_BYTES = 50
        try:
            self.assertEqual(ix.extract(p), (None, "파일이 너무 큼(압축을 풀면 상한 초과)"))
            with self.assertRaisesRegex(ValueError, "너무 큽니다"):
                ix.read_table(p)
        finally:
            ix.MAX_UNZIP_BYTES = old
        self.assertIsNotNone(ix.extract(p)[0])


class TestHardening(Base):
    """독립 검토(2026-10-08) 반영 — 큰 표·기형 파일·민감 파일의 틈."""

    def test_stops_after_window_and_reports_more(self):
        p = os.path.join(self.pur, "긴표.csv")
        self.write(p, "번호,품목\n" + "\n".join(f"{i},품목{i}" for i in range(1, 5001)))
        res, n = ix.read_table(p, max_rows=10)
        self.assertEqual((n, res["행범위"], res["다음행"], res["끝까지읽음"]), (10, [2, 11], 12, False))
        last, m = ix.read_table(p, start=4995, max_rows=50)
        self.assertEqual((last["행"][-1][0], last["다음행"], last["끝까지읽음"]), (5001, None, True))
        with self.assertRaisesRegex(ValueError, "제때 읽지 못했습니다"):
            ix.read_table(p, start=4990, budget_sec=-1)

    def test_output_never_exceeds_budget_even_when_sparse_or_wide(self):
        import json
        p = os.path.join(self.pur, "듬성.xlsx")
        rows = [["머리" + "가" * 300] + [f"열{c}" for c in range(2, 41)]]
        rows += [[i] + [None] * 38 + [f"끝{i}"] for i in range(1, 300)]
        make_book(p, [("넓은표", rows)])
        res, n = ix.read_table(p, max_rows=200)
        self.assertLessEqual(len(json.dumps(res, ensure_ascii=False)), ix.TABLE_MAX_CHARS)
        self.assertGreater(n, 5)
        self.assertEqual(res["다음행"], res["행범위"][1] + 1, "줄인 만큼 다음행이 당겨진다 — 건너뛰는 행이 없다")
        nxt, _ = ix.read_table(p, start=res["다음행"], max_rows=3)
        self.assertEqual(nxt["행"][0][0], res["다음행"])
        self.assertLessEqual(len(res["머리글"]["A"]), 61)

    def test_big_text_is_cut_at_line_and_never_garbled(self):
        p = os.path.join(self.pur, "큰.csv")
        old = ix.TEXT_READ_BYTES
        ix.TEXT_READ_BYTES = 200
        try:
            self.write(p, "품목,비고\n" + "\n".join(f"볼트{i},가나다라마바사" for i in range(200)))
            text, cut = ix._read_text_ex(p)
            self.assertTrue(cut)
            self.assertTrue(text.endswith("가나다라마바사"), "글자·줄 중간에서 끊지 않는다")
            self.assertNotIn("�", text)
            res, n = ix.read_table(p)
            self.assertEqual((res["앞부분만읽음"], res["끝까지읽음"]), (True, False))
        finally:
            ix.TEXT_READ_BYTES = old
        self.write(os.path.join(self.pur, "홀수.txt"), "가나다")
        self.assertEqual(ix.extract(os.path.join(self.pur, "홀수.txt"))[0], "가나다")
        with open(os.path.join(self.pur, "u16.txt"), "wb") as fh:
            fh.write("발주서".encode("utf-16"))
        self.assertEqual(ix.extract(os.path.join(self.pur, "u16.txt"))[0], "발주서", "BOM 이 있는 utf-16 은 읽는다")

    def test_malformed_files_fail_with_a_reason(self):
        ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        p = os.path.join(self.pur, "깨진시트.xlsx")
        with zipfile.ZipFile(p, "w") as z:
            z.writestr("xl/worksheets/sheet1.xml", f'<worksheet {ns}><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c')
        with self.assertRaisesRegex(ValueError, "깨졌거나"):
            ix.read_table(p)
        p2 = os.path.join(self.pur, "이상값.xlsx")
        with zipfile.ZipFile(p2, "w") as z:
            z.writestr("xl/worksheets/sheet1.xml", f'<worksheet {ns}><sheetData><row r="1"><c r="A1"><v>inf</v></c><c r="B1"><v>nan</v></c><c r="C1"><v>1e400</v></c></row></sheetData></worksheet>')
        self.assertEqual(ix.read_table(p2)[0]["행"][0][0], 1, "inf·nan 이 있어도 죽지 않는다")
        self.assertEqual(ix._serial_to_text("2958465", True), "2958465")
        self.write(os.path.join(self.pur, "따옴표.csv"), 'a,b\n"닫히지 않은,1\n' + "x," * 10)
        ix.read_table(os.path.join(self.pur, "따옴표.csv"))          # 예외 없이 끝나거나 사유 있는 ValueError 여야 한다

    def test_index_and_table_see_the_same_sheets(self):
        """색인이 못 본 시트를 표 읽기가 내주면 안 된다 — 시트 파일 이름이 sheetN.xml 꼴이 아니어도 색인이 읽는다."""
        ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        rns = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
        p = os.path.join(self.pur, "별난이름.xlsx")
        with zipfile.ZipFile(p, "w") as z:
            z.writestr("xl/workbook.xml", f'<workbook {ns} {rns}><sheets><sheet name="가" sheetId="1" r:id="r1"/><sheet name="나" sheetId="2" r:id="r2"/></sheets></workbook>')
            z.writestr("xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="r1" Target="worksheets/data.xml"/><Relationship Id="r2" Target="worksheets/people.xml"/></Relationships>')
            z.writestr("xl/worksheets/data.xml", f'<worksheet {ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>볼트</t></is></c></row></sheetData></worksheet>')
            z.writestr("xl/worksheets/people.xml", f'<worksheet {ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>900101-1234567</t></is></c></row></sheetData></worksheet>')
        self.assertEqual(ix.extract(p), (None, "민감 정보 꼴(주민등록번호) 포함"))

    def test_rrn_past_the_text_cap_still_blocks_the_file(self):
        p = os.path.join(self.pur, "뒤쪽.xlsx")
        make_xlsx(p, [["품목", "비고"]] + [["볼트", "가" * 50]] * 40 + [["담당", "900101-1234567"]])
        old = ix.MAX_TEXT_CHARS
        ix.MAX_TEXT_CHARS = 500
        try:
            self.assertEqual(ix.extract(p), (None, "민감 정보 꼴(주민등록번호) 포함"))
        finally:
            ix.MAX_TEXT_CHARS = old

    def test_locate_only_hands_out_files_the_index_read(self):
        self.write(os.path.join(self.pur, "깨짐.xlsx"), "zip 아님")
        self.write(os.path.join(self.pur, "ok.csv"), "a,b\n1,2")
        ix.refresh(self.con, self.docs, self.folders)
        bad = self.con.execute("select id from file where name = '깨짐.xlsx'").fetchone()[0]
        with self.assertRaisesRegex(ValueError, "읽을 수 없는 문서"):
            ix.locate(self.con, f"pur:{bad}", ["pur"])
        ok = self.con.execute("select id, size from file where name = 'ok.csv'").fetchone()
        self.assertEqual(ix.locate(self.con, f"pur:{ok[0]}", ["pur"])[4], ok[1])


if __name__ == "__main__":
    unittest.main()
