# -*- coding: utf-8 -*-
"""gl_precheck_prod 헤드리스 테스트 — ERP·포털에 접속하지 않는다.

확인하는 것:
  · 읽기 전용 커서가 쓰기·EXEC·다중문장을 실행 전에 거부한다
  · 판정 경로(judge)가 릴레이 함수를 거치며 SELECT 만으로 끝난다
  · 운영에 없는 거래처(G7)·거래유형(TT)을 문제로 모아 돌려준다
"""
import unittest

import gl_apply_demo2 as relay
import gl_precheck_prod as p


class FakeCur:
    """SQL 문자열로 대충 응답하는 가짜 커서 — 실행된 문장을 기록한다."""

    def __init__(self, bp_exists=True, tt="T"):
        self.sqls, self._rows = [], []
        self.bp_exists, self.tt = bp_exists, tt

    def execute(self, sql, *params):
        self.sqls.append(sql)
        s = sql.upper()
        if "A_ACCT_TRANS_TYPE" in s:
            self._rows = [(self.tt,)] if self.tt else []
        elif "MAX(ORG_CHANGE_ID)" in s:
            self._rows = [(20264,)]
        elif "B_ACCT_DEPT" in s or "REF_NO" in s:
            self._rows = [(1,)] if "B_ACCT_DEPT" in s else [(0,)]
        elif "A_JNL_ACCT_ASSN" in s:
            self._rows = []
        elif "A_JNL_ITEM" in s:
            self._rows = [(1,)]
        elif "A_ACCT_CTRL_ASSN" in s:
            self._rows = [("BP", "거래처")] if params and params[0] == "21100901" else []
        elif "A_CTRL_ITEM" in s:
            self._rows = [("B_BIZ_PARTNER", "거래처")]
        elif "B_BIZ_PARTNER" in s:
            self._rows = [(1 if self.bp_exists else 0,)]
        elif "A_OBJECT" in s:
            self._rows = [("AP", "CR"), ("TP", "DR")]
        elif "B_COST_CENTER" in s:
            self._rows = [("I",)]
        elif "A_ACCT" in s:
            acct = params[0] if params else ""
            sub = {"21100901": "AP", "11103301": "TP"}.get(acct, "")
            if "ACCT_NM" in s and "SUBSYS_TYPE" in s and "BAL_FG" not in s:
                self._rows = [("계정" + acct, sub)] if acct != "99999999" else []
            elif "SUBSYS_TYPE" in s and "BAL_FG" in s:
                self._rows = [(sub, "CR", "계정" + acct)]
            elif "SUBSYS_TYPE" in s:
                self._rows = [(sub,)]
            else:
                self._rows = [("계정" + acct,)]
        else:
            self._rows = []
        return self

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


DRAFT = {
    "header": {"draft_no": "AX-T-001", "dept_cd": "1000", "cost_cd": "C100",
               "dr_total": 110, "cr_total": 110},
    "items": [
        {"item_seq": 1, "acct_cd": "53013901", "dr_cr_fg": "D", "item_amt": 100},
        {"item_seq": 2, "acct_cd": "11103301", "dr_cr_fg": "D", "item_amt": 10},
        {"item_seq": 3, "acct_cd": "21100901", "dr_cr_fg": "C", "item_amt": 110},
    ],
    "ctrls": [{"item_seq": 3, "ctrl_cd": "BP", "ctrl_val": "4624"}],
}


class ReadOnlyCursorTest(unittest.TestCase):
    def test_rejects_writes(self):
        cur = p.ReadOnlyCursor(FakeCur())
        for bad in ("INSERT INTO dbo.A_BATCH VALUES (1)",
                    "UPDATE dbo.A_TEMP_GL SET CONF_FG='C'",
                    "DELETE FROM dbo.A_BATCH",
                    "SET NOCOUNT ON; DECLARE @no nvarchar(30); EXEC dbo.usp_a_tempgl_no_auto_gen ?",
                    "EXEC sp_who",
                    "SELECT 1; DELETE FROM dbo.A_BATCH",
                    "SELECT * INTO #t FROM dbo.A_ACCT",
                    "SELECT 1 -- x"):
            with self.assertRaises(PermissionError, msg=bad):
                cur.execute(bad)

    def test_allows_select(self):
        cur = p.ReadOnlyCursor(FakeCur())
        cur.execute("SELECT COUNT(*) FROM dbo.A_BATCH WITH (NOLOCK) WHERE REF_NO = ?", "x")
        self.assertEqual(cur.fetchone(), (0,))


class JudgeTest(unittest.TestCase):
    def setUp(self):
        p._reset_caches()

    def run_judge(self, **kw):
        fake = FakeCur(**kw)
        issues = p.judge(p.ReadOnlyCursor(fake), DRAFT, "AX001")
        self.assertTrue(all(s.strip().upper().startswith("SELECT") for s in fake.sqls))
        return issues

    def test_pass_when_master_has_values(self):
        self.assertEqual(self.run_judge(), [])

    def test_missing_partner_is_g7(self):
        issues = self.run_judge(bp_exists=False)
        self.assertEqual([x["code"] for x in issues], ["G7"])
        self.assertEqual(issues[0]["seq"], 3)

    def test_missing_trans_type_collected_not_stopped(self):
        issues = self.run_judge(tt=None, bp_exists=False)
        self.assertEqual(sorted(x["code"] for x in issues), ["G7", "TT"])

    def test_caches_reset(self):
        relay._REF_HIT[("B_BIZ_PARTNER", "4624")] = False
        p._reset_caches()
        self.assertEqual(relay._REF_HIT, {})


class AccountModeTest(unittest.TestCase):
    def setUp(self):
        p._reset_caches()

    def test_collect_pairs_merges_sources(self):
        data = {
            "gl_draft_item": [{"acct_cd": "53013901 ", "dr_cr_fg": "D", "cost_cd": "C1"},
                              {"acct_cd": "53013901", "dr_cr_fg": "D", "cost_cd": "C1"},
                              {"acct_cd": "21100901", "dr_cr_fg": "C", "cost_cd": ""}],
            "gl_template_item": [{"acct_cd": "53013901", "dr_cr_fg": "D"}],
        }
        orig = p.rest_get
        p.rest_get = lambda url, key, path: data[path.split("?")[0]]
        try:
            pairs = p.collect_pairs("u", "k")
        finally:
            p.rest_get = orig
        self.assertEqual(pairs[("53013901", "DR")]["n"], 3)
        self.assertEqual(pairs[("53013901", "DR")]["src"], {"전표", "템플릿"})
        self.assertEqual(pairs[("53013901", "DR")]["cost"], "C1")
        self.assertIn(("21100901", "CR"), pairs)

    def judge(self, acct, fg):
        fake = FakeCur()
        j = p.judge_account(p.ReadOnlyCursor(fake), acct, fg, "C1", "AX001")
        self.assertTrue(all(s.strip().upper().startswith("SELECT") for s in fake.sqls))
        return j

    def test_ap_credit_passes_with_required_bp(self):
        j = self.judge("21100901", "CR")
        self.assertEqual(j["blocks"], [])
        self.assertEqual(j["req"], ["BP"])
        self.assertTrue(j["jnl"].startswith("AP/"))

    def test_vat_credit_blocked_g1(self):
        j = self.judge("11103301", "CR")
        self.assertTrue(any(b.startswith("G1") for b in j["blocks"]))

    def test_card_credit_blocked_like_relay(self):
        j = self.judge("21100907", "CR")
        self.assertTrue(any(b.startswith("CARD") for b in j["blocks"]))

    def test_missing_account(self):
        j = self.judge("99999999", "DR")
        self.assertFalse(j["exists"])


if __name__ == "__main__":
    unittest.main()
