# -*- coding: utf-8 -*-
"""test_reg_parse.py — 조문 파서 헤드리스 회귀 (REQ-0124). 실행: python -m unittest test_reg_parse"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reg_parse as rp  # noqa: E402

SAMPLE = """
【인사】 취업규칙
제정 2010. 1. 1.
최종개정 2024. 3. 1. (제5차 개정)
주관부서 : 인사팀

제1장 총칙
제1조(목적) 이 규칙은 회사 직원의 복무에 관한 사항을 정한다.
제2조(적용범위) ① 이 규칙은 전 직원에게 적용한다. <개정 2020.1.1>
② 예외는 따로 정한다.
제3조(정의) 삭제 <삭제 2018.5.1>
제3조의2(용어) 용어의 정의는 다음과 같다.
1. "직원"이란 회사와 근로계약을 맺은 사람을 말한다.
제2장 복무
제1절 근무
제4조(근무시간) 근무시간은 09:00~18:00 으로 한다.
제1조 제2항에 따라 조정할 수 있다.
- 1 -
제5조 (휴가)
연차휴가는 근로기준법에 따른다.
부칙
제1조(시행일) 이 규칙은 2024년 4월 1일부터 시행한다.
제2조(경과조치) 종전 규정에 따른 것은 유효하다.
"""


class TestSample(unittest.TestCase):
    def setUp(self):
        self.r = rp.parse(SAMPLE, hint_title="[인사] 취업규칙 개정 안내")
        self.by = {a["article_no"]: a for a in self.r["articles"]}

    def test_status_and_stats(self):
        self.assertEqual(self.r["status"], "ok", self.r["warnings"])
        self.assertEqual(self.r["stats"]["articles"], 6)
        self.assertEqual(self.r["stats"]["addendum"], 2)
        self.assertEqual(self.r["stats"]["chapters"], 2)
        self.assertEqual([a["seq"] for a in self.r["articles"]], list(range(1, 9)))

    def test_meta(self):
        m = self.r["meta"]
        self.assertEqual(m["name"], "취업규칙")
        self.assertEqual(m["enact_date"], "2010-01-01")
        self.assertEqual(m["revise_date"], "2024-03-01")
        self.assertEqual(m["effective_date"], "2024-04-01")       # 「…부터 시행」이 개정일보다 우선
        self.assertEqual(m["revision_no"], 5)
        self.assertEqual(m["owner_dept"], "인사팀")

    def test_articles_and_structure(self):
        self.assertEqual(self.by["1"]["title"], "목적")
        self.assertEqual(self.by["1"]["chapter"], "제1장 총칙")
        self.assertIsNone(self.by["1"]["section"])
        self.assertEqual(self.by["4"]["chapter"], "제2장 복무")
        self.assertEqual(self.by["4"]["section"], "제1절 근무")
        self.assertEqual(self.by["5"]["title"], "휴가")
        self.assertEqual(self.by["5"]["body"], "연차휴가는 근로기준법에 따른다.")
        self.assertIn("1. \"직원\"이란", self.by["3의2"]["body"])

    def test_reference_at_line_start_is_body(self):
        self.assertIn("제1조 제2항에 따라 조정할 수 있다.", self.by["4"]["body"])
        self.assertNotIn("- 1 -", self.by["4"]["body"])

    def test_amend_tags_and_deleted(self):
        self.assertEqual(self.by["2"]["amended_tag"], "<개정 2020.1.1>")
        self.assertEqual(self.by["2"]["amend_history"], [{"kind": "개정", "date_text": "2020.1.1"}])
        self.assertFalse(self.by["2"]["is_deleted"])
        self.assertTrue(self.by["3"]["is_deleted"])
        self.assertEqual(self.by["3"]["amended_tag"], "<삭제 2018.5.1>")

    def test_addendum(self):
        self.assertEqual(self.by["부칙-1"]["title"], "시행일")
        self.assertEqual(self.by["부칙-1"]["chapter"], "부칙")
        self.assertEqual(self.by["부칙-2"]["title"], "경과조치")


class TestStatus(unittest.TestCase):
    def test_fallback_whole_text(self):
        r = rp.parse("이 문서는 안내문입니다.\n조문 구조가 없습니다.")
        self.assertEqual(r["status"], "fallback")
        self.assertEqual(len(r["articles"]), 1)
        self.assertEqual(r["articles"][0]["title"], "(전문)")
        self.assertIsNone(r["articles"][0]["article_no"])
        self.assertIn("조문 구조를 찾지 못해 전문 1조문으로 둠", r["warnings"])
        self.assertIn("시행일·개정일·제정일을 찾지 못함(게시일로 보완)", r["warnings"])

    def test_empty(self):
        r = rp.parse("")
        self.assertEqual((r["status"], r["articles"]), ("fallback", []))

    def test_partial_few_articles(self):
        r = rp.parse("제1조(목적) a\n제2조(범위) b")
        self.assertEqual(r["status"], "partial")
        self.assertIn("조문이 2개뿐", r["warnings"])

    def test_partial_duplicate_and_regress(self):
        r = rp.parse("제1조(a) x\n제2조(b) y\n제3조(c) z\n제2조(b2) 다시\n제3조(c2) 또")
        self.assertEqual(r["status"], "partial")
        self.assertTrue(any("역행" in w or "중복" in w for w in r["warnings"]))

    def test_partial_skip(self):
        r = rp.parse("제1조(a) x\n제2조(b) y\n제9조(c) z\n제10조(d) w")
        self.assertEqual(r["status"], "partial")
        self.assertIn("조 번호 5 이상 건너뜀 1회", r["warnings"])

    def test_long_body_split(self):
        body = ("가나다라 " * 6000).strip()          # 약 30,000자
        r = rp.parse("제1조(a) x\n제2조(b) y\n제3조(긴조문)\n" + body + "\n제4조(d) w")
        parts = [a for a in r["articles"] if a["article_no"] == "3"]
        self.assertEqual(len(parts), 2)
        self.assertTrue(all(len(a["body"]) <= rp.MAX_ARTICLE_CHARS for a in parts))
        self.assertEqual(parts[1]["title"], "긴조문 (이어서 2)")
        self.assertTrue(any("나눔" in w for w in r["warnings"]))
        self.assertEqual(r["status"], "ok")


class TestAddendum(unittest.TestCase):
    def test_numbered_items(self):
        r = rp.parse("제1조(a) x\n제2조(b) y\n제3조(c) z\n부칙\n1. (시행일) 이 규정은 2023.1.1부터 시행한다.\n2. (경과조치) 종전 것은 유효하다.")
        adds = [a for a in r["articles"] if str(a["article_no"]).startswith("부칙")]
        self.assertEqual([a["article_no"] for a in adds], ["부칙-1", "부칙-2"])
        self.assertIn("시행일", adds[0]["body"])
        self.assertEqual(r["meta"]["effective_date"], "2023-01-01")

    def test_multiple_addenda(self):
        r = rp.parse("제1조(a) x\n제2조(b) y\n제3조(c) z\n부칙 <2020.1.1>\n이 규정은 2020.1.1부터 시행한다.\n부칙 <2024.1.1>\n이 규정은 2024.1.1부터 시행한다.")
        adds = [a for a in r["articles"] if str(a["article_no"]).startswith("부칙")]
        self.assertEqual([a["chapter"] for a in adds], ["부칙", "부칙(2)"])
        self.assertEqual([a["article_no"] for a in adds], ["부칙-1", "부칙2-1"])
        self.assertEqual(r["meta"]["effective_date"], "2024-01-01")


class TestNames(unittest.TestCase):
    def test_name_norm(self):
        self.assertEqual(rp.name_norm("[인사] 취업규칙 개정 안내(2024.3.1 시행)"), "취업규칙")
        self.assertEqual(rp.name_norm("출장여비규정 v2.1 (3차 개정)"), "출장여비규정")
        self.assertEqual(rp.name_norm("구매 규정 — 2024년 일부개정"), "구매규정")
        self.assertEqual(rp.reg_key("rules", "취업규칙 개정 안내"), "rules:취업규칙")
        self.assertEqual(rp.reg_key("rules", ""), "rules:untitled")

    def test_clean_name_from_hint(self):
        r = rp.parse("본문만 있음", hint_title="【총무】 경조사 지원 기준 (2024.1.1 시행)")
        self.assertEqual(r["meta"]["name"], "경조사 지원 기준")

    def test_bad_date_ignored(self):
        r = rp.parse("제정 2024.13.1\n제1조(a) x")
        self.assertIsNone(r["meta"]["enact_date"])


class TestChooseSource(unittest.TestCase):
    ART5 = "제1조(a) x\n제2조(b) y\n제3조(c) z\n제4조(d) w\n제5조(e) v"
    ART4 = "제1조(a) x\n제2조(b) y\n제3조(c) z\n제4조(d) w"

    def test_attachment_with_articles_wins(self):
        src, r, i = rp.choose_source("공지: 첨부 참조", [{"name": "양식.xlsx", "text": "항목 값"},
                                                   {"name": "취업규칙.hwp", "text": self.ART5}])
        self.assertEqual((src, i, r["stats"]["articles"]), ("attachment:취업규칙.hwp", 1, 5))

    def test_tie_prefers_hwp_over_pdf(self):
        src, _, i = rp.choose_source("", [{"name": "a.pdf", "text": self.ART5}, {"name": "a.hwp", "text": self.ART5}])
        self.assertEqual((src, i), ("attachment:a.hwp", 1))

    def test_body_when_attachments_have_no_articles(self):
        src, r, i = rp.choose_source(self.ART4, [{"name": "양식.xlsx", "text": "항목 값"}, {"name": "x.hwp", "text": None}])
        self.assertEqual((src, i, r["status"]), ("body", None, "ok"))

    def test_fallback_longer_side(self):
        src, r, i = rp.choose_source("짧은 본문", [{"name": "안내.pdf", "text": "조문 없는 긴 안내문 " * 10}])
        self.assertEqual((src, i, r["status"]), ("attachment:안내.pdf", 0, "fallback"))
        src, r, i = rp.choose_source("본문이 더 길다 " * 10, [{"name": "안내.pdf", "text": "짧음"}])
        self.assertEqual((src, i, r["status"]), ("body", None, "fallback"))


if __name__ == "__main__":
    unittest.main()
