# -*- coding: utf-8 -*-
"""proposal_ledger 회귀 — 파일·네트워크를 건드리지 않는다(헤드리스).

실제 대장 엑셀이나 Supabase 를 부르지 않고, 시트에서 읽은 셀 구조만 흉내 내
**정규화 규칙**(건 안의 행 순번·날짜·금액·전표번호 원문 보존)을 고정한다.
"""
import unittest

import proposal_ledger as pl
import runner_core as core
import jeil_runner as jr

C = pl.COL


def cell(**kw):
    """{열번호: 값} 셀 묶음 — 키워드는 COL 이름."""
    return {C[k]: v for k, v in kw.items()}


class BuildRowsTest(unittest.TestCase):
    def rows(self, sheet):
        return pl.build_rows(sheet, "2026-09-22T05:02:32+00:00")

    def test_한_건이_여러_행이면_seq_가_1부터_붙는다(self):
        sheet = [
            (3, cell(vol=1, no=1, draft_dt=46027, drafter="정희원", amt=100)),
            (4, cell(vol=1, no=1, draft_dt=46027, drafter="정희원", amt=200)),
            (5, cell(vol=1, no=2, draft_dt=46028, drafter="장민지", amt=300)),
        ]
        recs, cases, _ = self.rows(sheet)
        self.assertEqual([r["seq"] for r in recs], [1, 2, 1])
        self.assertEqual(cases, 2, "건 수는 (권,번호) 기준")
        self.assertEqual(len(recs), 3, "행은 합치지 않는다 — 전표·금액 대사가 행 단위다")

    def test_권_번호가_없는_행은_버린다(self):
        sheet = [(3, cell(drafter="합계", amt=999)), (4, cell(vol=1, no=1, amt=1))]
        recs, cases, _ = self.rows(sheet)
        self.assertEqual(len(recs), 1)
        self.assertEqual(cases, 1)

    def test_날짜는_시리얼을_ISO_로_바꾸고_문자열은_원문으로_남긴다(self):
        sheet = [
            (3, cell(vol=1, no=1, draft_dt=46027)),
            (4, cell(vol=7, no=696, draft_dt="08/21")),
        ]
        recs, _, warns = self.rows(sheet)
        self.assertEqual(recs[0]["draft_dt"], "2026-01-05")
        self.assertIsNone(recs[0]["draft_dt_raw"])
        self.assertIsNone(recs[1]["draft_dt"], "날짜로 못 읽으면 비운다")
        self.assertEqual(recs[1]["draft_dt_raw"], "08/21", "원문은 보존한다")
        self.assertTrue(warns, "못 읽은 날짜는 경고로 남긴다")

    def test_금액은_숫자와_문자를_나눠_담는다(self):
        sheet = [
            (3, cell(vol=1, no=1, amt=17900000)),
            (4, cell(vol=1, no=10, amt="매월 ₩1,936,000")),
            (5, cell(vol=1, no=45, amt="무상")),
        ]
        recs, _, _ = self.rows(sheet)
        self.assertEqual(recs[0]["amt"], 17900000.0)
        self.assertIsNone(recs[0]["amt_raw"])
        self.assertIsNone(recs[1]["amt"], "문자가 섞이면 숫자 칸은 비운다")
        self.assertEqual(recs[1]["amt_raw"], "매월 ₩1,936,000")
        self.assertEqual(recs[2]["amt_raw"], "무상")

    def test_통화는_추정하지_않는다(self):
        recs, _, _ = self.rows([(3, cell(vol=8, no=775, amt="CNY 532,000", vendor="상하이TQL테크"))])
        self.assertIsNone(recs[0]["currency"], "대장에 통화 칸이 없다 — 업체명으로 추측하면 집계가 거짓이 된다")

    def test_전표번호의_공백과_탭을_지우지_않는다(self):
        recs, _, _ = self.rows([(3, cell(vol=1, no=1, bp_slip="\tTG202512300021"))])
        self.assertEqual(recs[0]["bp_slip"], "\tTG202512300021",
                         "앞뒤 공백·탭은 품질 지표다 — 적재가 지우면 오염을 셀 수 없다")

    def test_종결여부는_한_글자_대문자로_정리한다(self):
        recs, _, _ = self.rows([(3, cell(vol=1, no=1, closed_yn=" y "))])
        self.assertEqual(recs[0]["closed_yn"], "Y")


class NormCustomerTest(unittest.TestCase):
    def test_같은_고객의_표기_흔들림을_묶는다(self):
        for raw, want in [
            ("(주)엔시스_NSYS #1", "엔시스"),
            ("㈜ 엔시스_라인증설", "엔시스"),
            ("삼성에스디아이(주)_헝가리", "삼성SDI 계열"),
            ("삼성SDI㈜_중대형", "삼성SDI 계열"),
            ("StarPlus Energy LLC_SPE", "StarPlus Energy"),
            ("엘아이지넥스원(주)_사업", "LIG넥스원"),
            ("LIG 넥스원㈜_사업", "LIG넥스원"),
        ]:
            self.assertEqual(pl.norm_customer(raw), want, raw)

    def test_단정할_수_없는_표기는_그대로_둔다(self):
        self.assertEqual(pl.norm_customer("LGESMI_라인"), "LGESMI",
                         "같은 그룹인지 확실하지 않으면 묶지 않는다")

    def test_빈칸은_None(self):
        self.assertIsNone(pl.norm_customer(""))
        self.assertIsNone(pl.norm_customer(None))


class WiringTest(unittest.TestCase):
    """§17.2 — 러너에 이름이 이어져 있는가(로직은 모듈이 갖는다)."""

    def test_작업_종류와_파라미터_화이트리스트가_있다(self):
        self.assertIn("proposal_ledger", core.JOB_KINDS)
        self.assertEqual(core.PARAM_KEYS["proposal_ledger"], ("file", "scan", "dry_run", "append"))

    def test_서브커맨드가_모듈에_연결돼_있다(self):
        self.assertEqual(jr.CLI_TOOLS["proposal"][0], "proposal_ledger")
        self.assertTrue(hasattr(pl, "main") and hasattr(pl, "collect"))

    def test_기본_스케줄은_꺼진_채로_들어간다(self):
        job = [j for j in core.DEFAULT_JOBS if j["id"] == "proposal_ledger"][0]
        self.assertFalse(job["enabled"], "대장 파일이 있는 호스트에서만 사람이 켠다")
        self.assertEqual(job["schedule"]["type"], "daily")

    def test_능력_판정_키가_있다(self):
        caps = core.detect_capabilities(core.default_root())
        self.assertIn("proposal_ledger", caps)
        self.assertIsInstance(caps["proposal_ledger"], bool)


class ConfigTest(unittest.TestCase):
    """설정 창(runner_ui)이 이 작업의 파라미터를 읽고 쓰는가 — 창을 띄우지 않고 표만 본다."""

    def test_저장_분기가_있다(self):
        """분기가 없으면 창에서 [저장] 할 때 params 가 {} 로 날아간다(대장 경로 유실)."""
        import inspect, runner_ui
        src = inspect.getsource(runner_ui.JobsTab.collect) if hasattr(runner_ui, "JobsTab")             else inspect.getsource(runner_ui)
        self.assertIn('r["kind"] == "proposal_ledger"', src)
        for key in ("file", "scan", "dry_run", "append"):
            self.assertIn('"%s"' % key, src, "저장 시 %s 파라미터를 읽어야 한다" % key)

    def test_파일이_없으면_설정_경고가_뜬다(self):
        job = {"id": "proposal_ledger", "kind": "proposal_ledger", "params": {}}
        warns = core.param_warnings(job, {"supabase": True, "proposal_ledger": False})
        self.assertTrue(any("PROPOSAL_LEDGER_XLSX" in w for w in warns),
                        "대장 파일이 안 보이는 호스트면 사유를 보여줘야 한다")

    def test_경로를_직접_준_경우엔_경고하지_않는다(self):
        job = {"id": "proposal_ledger", "kind": "proposal_ledger", "params": {"file": "D:/x.xlsx"}}
        warns = core.param_warnings(job, {"supabase": True, "proposal_ledger": False})
        self.assertFalse(any("PROPOSAL_LEDGER_XLSX" in w for w in warns))

    def test_supabase_접속정보가_없으면_경고한다(self):
        job = {"id": "proposal_ledger", "kind": "proposal_ledger", "params": {"file": "D:/x.xlsx"}}
        warns = core.param_warnings(job, {"supabase": False, "proposal_ledger": True})
        self.assertTrue(any("Supabase" in w for w in warns))


if __name__ == "__main__":
    unittest.main()
