# -*- coding: utf-8 -*-
"""릴레이 v1.8 헤드리스 테스트 — ERP·포털에 접속하지 않는다.

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


if __name__ == "__main__":
    unittest.main()
