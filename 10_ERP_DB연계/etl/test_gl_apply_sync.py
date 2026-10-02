# -*- coding: utf-8 -*-
"""릴레이 v1.10 헤드리스 테스트 — ERP·포털에 접속하지 않는다.

확인하는 것(2026-09-30 결정 D-113 · G5):
  · 대상이 운영(JEILMNS)이고 --cleanup 은 운영에서 실행 전에 거부된다
  · 상태 역동기화: A_TEMP_GL 에 없으면 deleted, CONF_FG='C' 면 approved(+GL_NO), 그 외 unapproved
  · 바뀐 것만 포털에 기록하고, ERP 에는 SELECT 만 보낸다
"""
import argparse
import unittest
from unittest import mock

import gl_apply_demo2 as g


class FakeCur:
    def __init__(self, table):
        self.table, self.sqls, self._row = table, [], None

    def execute(self, sql, *params):
        self.sqls.append(sql)
        self._row = self.table.get(params[0]) if params else None
        return self

    def fetchone(self):
        return self._row


class FakeConn:
    def __init__(self, table):
        self.cur = FakeCur(table)
        self.rolled = self.closed = False

    def cursor(self):
        return self.cur

    def rollback(self):
        self.rolled = True

    def close(self):
        self.closed = True


class TargetTest(unittest.TestCase):
    def test_target_is_prod(self):
        self.assertEqual(g.TARGET_DB, "JEILMNS")
        self.assertTrue(g.IS_PROD)

    def test_cleanup_refused_on_prod_before_connecting(self):
        with mock.patch.object(g, "load_env"), mock.patch.object(g, "need", return_value="x"), \
                mock.patch.object(g, "demo_conn") as conn:
            rc = g.cleanup_draft(argparse.Namespace(draft="AX-T-1"))
        self.assertEqual(rc, 1)
        conn.assert_not_called()           # 접속조차 하지 않는다


class SyncStateTest(unittest.TestCase):
    def run_sync(self, targets, erp):
        calls = []

        def fake_rpc(url, key, fn, payload):
            calls.append((fn, payload))
            if fn == "gl_erp_sync_targets":
                return targets
            return {"updated": 0, "deleted": sum(1 for x in payload["p"] if x["state"] == "deleted")}

        conn = FakeConn(erp)
        with mock.patch.object(g, "rpc", side_effect=fake_rpc), \
                mock.patch.object(g, "demo_conn", return_value=conn), \
                mock.patch.object(g, "notify", return_value=False):
            res = g.sync_erp_state("u", "k")
        self.assertTrue(conn.rolled and conn.closed)
        self.assertTrue(all(s.strip().upper().startswith("SELECT") for s in conn.cur.sqls))
        rec = [p for fn, p in calls if fn == "gl_erp_sync_record"]
        return res, (rec[0]["p"] if rec else [])

    def test_states(self):
        targets = [
            {"draft_no": "D1", "erp_temp_gl_no": "AG1", "erp_sync_state": None, "erp_final_gl_no": None},
            {"draft_no": "D2", "erp_temp_gl_no": "AG2", "erp_sync_state": None, "erp_final_gl_no": None},
            {"draft_no": "D3", "erp_temp_gl_no": "AG3", "erp_sync_state": None, "erp_final_gl_no": None},
        ]
        erp = {"AG1": ("U", ""), "AG2": ("C", "GL2026-01")}      # AG3 은 ERP 에서 삭제됨
        (n, d), sent = self.run_sync(targets, erp)
        got = {x["draft_no"]: (x["state"], x["gl_no"]) for x in sent}
        self.assertEqual(got, {"D1": ("unapproved", ""), "D2": ("approved", "GL2026-01"), "D3": ("deleted", "")})
        self.assertEqual((n, d), (3, 1))

    def test_unchanged_not_rewritten(self):
        targets = [{"draft_no": "D1", "erp_temp_gl_no": "AG1",
                    "erp_sync_state": "approved", "erp_final_gl_no": "GL1"}]
        (n, d), sent = self.run_sync(targets, {"AG1": ("C", "GL1")})
        self.assertEqual(sent, [])
        self.assertEqual((n, d), (1, 0))

    def test_no_targets_no_erp_connection(self):
        with mock.patch.object(g, "rpc", return_value=[]), \
                mock.patch.object(g, "demo_conn") as conn:
            self.assertEqual(g.sync_erp_state("u", "k"), (0, 0))
        conn.assert_not_called()


class SeqCur:
    """실행 순서대로 정해 둔 행을 돌려주는 커서 — SQL 과 바인딩 값을 기록한다."""

    def __init__(self, rows):
        self.rows, self.calls, self._row = list(rows), [], None

    def execute(self, sql, *params):
        self.calls.append((sql, params))
        self._row = self.rows.pop(0) if self.rows else None
        return self

    def fetchone(self):
        return self._row


class InternalCdTest(unittest.TestCase):
    """내부부서코드는 최근 배치가 아니라 전표 부서의 마스터에서 온다(REQ-0100).
       실제 사고: 직전 배치가 구매팀(1121)이라 총무팀(181) 전표가 구매팀으로 들어갔다."""

    def test_internal_from_dept_master_not_batch(self):
        cur = SeqCur([("BA1", "02"), ("181",)])
        org, biz, internal, gaap = g.org_info(cur, "3200", "20261")
        self.assertEqual((org, biz, internal, gaap), ("20261", "BA1", "181", "02"))
        self.assertNotIn("INTERNAL_CD", cur.calls[0][0])          # 배치에서는 더 이상 읽지 않는다
        self.assertIn("B_ACCT_DEPT", cur.calls[1][0])
        self.assertEqual(cur.calls[1][1], ("3200", "20261"))      # 전표 부서·현행 조직으로 조회

    def test_missing_internal_stops(self):
        for row in (None, ("",), (None,)):
            with self.assertRaises(SystemExit):
                g.dept_internal_cd(SeqCur([row]), "3200", "20261")

    def test_trims_fixed_width(self):
        self.assertEqual(g.dept_internal_cd(SeqCur([("181   ",)]), "3200", "20261"), "181")


class ErpOrgRuleTest(unittest.TestCase):
    """조직 축은 ERP(usp_a_check_acct)와 같은 규칙으로 정한다(REQ-0100).
       조직개편번호 = 전표일자 이전에 시작한 조직 중 최근 것 · 헤더 코스트센터 = 부서 마스터 값."""

    def test_org_picked_by_voucher_date(self):
        import datetime
        day = datetime.datetime(2026, 3, 31)
        cur = SeqCur([("20251",), (1,)])
        self.assertEqual(g.check_dept_org(cur, "3200", day), "20251")
        sql, params = cur.calls[0]
        self.assertIn("ORG_CHANGE_DT <= ?", sql)                  # 가장 큰 번호(MAX)가 아니라 일자 기준
        self.assertNotIn("MAX(ORG_CHANGE_ID)", sql)
        self.assertEqual(params, (day,))
        self.assertEqual(cur.calls[1][1], ("3200", "20251"))      # 그 조직에 부서가 있는지

    def test_dept_missing_in_that_org_stops(self):
        import datetime
        with self.assertRaises(SystemExit) as e:
            g.check_dept_org(SeqCur([("20261",), (0,)]), "5100", datetime.datetime(2026, 9, 30))
        self.assertIn("2026-09-30", str(e.exception))

    def test_header_cost_from_dept_master(self):
        cur = SeqCur([("C013200 ",)])
        self.assertEqual(g.dept_cost_cd(cur, "3200", "20261"), "C013200")
        self.assertIn("B_ACCT_DEPT", cur.calls[0][0])
        with self.assertRaises(SystemExit):
            g.dept_cost_cd(SeqCur([("",)]), "3200", "20261")

    def test_org_axis_mismatch(self):
        hd = ("3200", "20261", "181", "C013200")
        its = [("3200", "20261", "181", "C011310"), ("3200", "20261", "181", "C013200")]
        ok = g.org_axis_mismatch(hd, its, "3200", "20261", "181", "C013200", ["C013200", "C011310"])
        self.assertEqual(ok, [])                                   # 줄 순서가 바뀌어도 일치
        # 실제 사고 형태 — 내부부서코드만 남의 부서 것
        bad = g.org_axis_mismatch(("3200", "20261", "1121", "C013200"),
                                  [("3200", "20261", "1121", "C013200")],
                                  "3200", "20261", "181", "C013200", ["C013200"])
        self.assertEqual(len(bad), 2)
        # 헤더 코스트센터가 부서 것이 아님
        bad = g.org_axis_mismatch(("3200", "20261", "181", "C017100"), its,
                                  "3200", "20261", "181", "C013200", ["C011310", "C013200"])
        self.assertEqual(len(bad), 1)


if __name__ == "__main__":
    unittest.main()
