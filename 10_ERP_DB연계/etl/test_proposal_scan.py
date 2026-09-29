# -*- coding: utf-8 -*-
"""proposal_scan 회귀 — 파일명 인식·대표 파일 선택·밤 1회 경계·안전장치·러너 연결.
실제 문서중앙화·중간DB 에 접속하지 않는다(헤드리스)."""
import datetime
import unittest
from unittest import mock

import proposal_scan as ps
import runner_core as core


class ParseName(unittest.TestCase):
    def test_recognizes_vol_no(self):
        self.assertEqual(ps.parse_name("9-830.pdf"), (9, 830))
        self.assertEqual(ps.parse_name("9 - 830 재스캔.pdf"), (9, 830))
        self.assertEqual(ps.parse_name("9-830(2).pdf"), (9, 830))
        self.assertEqual(ps.parse_name("12-7.PDF"), (12, 7))

    def test_rejects_other_names(self):
        for n in ("Thumbs.db", "기안서 목록.xlsx", "9_830.pdf", "2026-0931.pdf", "", None):
            self.assertIsNone(ps.parse_name(n), n)


class BuildRows(unittest.TestCase):
    def test_one_row_per_ledger_case_and_missing_marked(self):
        files = [{"name": "9-830.pdf", "size": 836608, "mtime": "2026-09-21T21:05:00"},
                 {"name": "Thumbs.db", "size": 10, "mtime": None},
                 {"name": "9-999.pdf", "size": 1000, "mtime": None}]            # 대장에 없는 파일
        rows, st = ps.build_rows(files, {(9, 830), (9, 829)})
        self.assertEqual([(r["vol"], r["no"], r["matched"]) for r in rows], [(9, 829, False), (9, 830, True)])
        hit = rows[1]
        self.assertEqual(hit["file_name"], "9-830.pdf")
        self.assertEqual(hit["size_kb"], 817)
        self.assertEqual(hit["file_mtime"], "2026-09-21T21:05:00+09:00")
        self.assertIsNone(rows[0]["file_name"])
        self.assertEqual((st["files"], st["named"], st["orphans"], st["unnamed"]), (3, 2, 1, 1))

    def test_duplicate_prefers_pdf_then_recent(self):
        files = [{"name": "9-830.jpg", "size": 999999, "mtime": "2026-09-25T10:00:00"},
                 {"name": "9-830.pdf", "size": 100, "mtime": "2026-09-01T10:00:00"},
                 {"name": "9-830(2).pdf", "size": 100, "mtime": "2026-09-20T10:00:00"}]
        rows, st = ps.build_rows(files, {(9, 830)})
        self.assertEqual(rows[0]["file_name"], "9-830(2).pdf")
        self.assertEqual(st["dup"], 2)


class Nightly(unittest.TestCase):
    def test_boundary(self):
        k = ps.KST
        self.assertEqual(ps.night_boundary(datetime.datetime(2026, 9, 29, 21, 0, tzinfo=k)),
                         datetime.datetime(2026, 9, 29, 20, 0, tzinfo=k))
        self.assertEqual(ps.night_boundary(datetime.datetime(2026, 9, 30, 8, 0, tzinfo=k)),
                         datetime.datetime(2026, 9, 29, 20, 0, tzinfo=k), "아침엔 어젯밤 기준 — 놓친 밤을 따라잡는다")

    def _collect(self, last, files, prev=800, **kw):
        env = {"PROPOSAL_SCAN_DIR": "X:\\scan", "SUPABASE_URL": "https://x", "SUPABASE_SERVICE_ROLE_KEY": "k"}
        with mock.patch.dict("os.environ", env), mock.patch.object(ps, "load_env"), \
             mock.patch.object(ps, "current_state", return_value=(prev, last)), \
             mock.patch.object(ps, "ledger_cases", return_value={(9, n) for n in range(1, 831)}), \
             mock.patch.object(ps, "list_scan_dir", side_effect=files if isinstance(files, Exception) else None,
                               return_value=None if isinstance(files, Exception) else files), \
             mock.patch.object(ps, "rpc", return_value=830) as rpc:
            return ps.collect(**kw), rpc

    def test_skip_when_already_done_tonight(self):
        last = ps.night_boundary() + datetime.timedelta(minutes=5)
        res, rpc = self._collect(last, [], nightly=True)
        self.assertEqual(res, "skip"); rpc.assert_not_called()

    def test_locked_session_is_skip_not_failure(self):
        res, rpc = self._collect(None, ps.ScanUnavailable("잠금"), nightly=True)
        self.assertEqual(res, "skip"); rpc.assert_not_called()

    def test_empty_listing_never_wipes(self):
        res, rpc = self._collect(None, [], nightly=True)
        self.assertEqual(res, "skip"); rpc.assert_not_called()
        with self.assertRaises(RuntimeError):
            self._collect(None, [])

    def test_half_guard(self):
        few = [{"name": "9-%d.pdf" % n, "size": 1, "mtime": None} for n in range(1, 100)]
        with self.assertRaises(RuntimeError):
            self._collect(None, few, prev=800)
        res, rpc = self._collect(None, few, prev=800, force=True)
        self.assertEqual(res, "done")

    def test_full_run_replaces(self):
        files = [{"name": "9-%d.pdf" % n, "size": 1024, "mtime": None} for n in range(1, 820)]
        res, rpc = self._collect(None, files, nightly=True)
        self.assertEqual(res, "done")
        upsert = [c for c in rpc.call_args_list if c.args[2] == "pur_proposal_scan_upsert"][0]
        self.assertTrue(upsert.args[3]["p_replace"])
        self.assertEqual(len(upsert.args[3]["p_rows"]), 830)


class RunnerWiring(unittest.TestCase):
    def test_job_defined_off_by_default_and_params_whitelisted(self):
        self.assertIn("proposal_scan", core.JOB_KINDS)
        job = [j for j in core.DEFAULT_JOBS if j["id"] == "proposal_scan"][0]
        self.assertFalse(job["enabled"], "문서중앙화 PC 에서만 켠다 — 기본 꺼짐")
        self.assertEqual(job["schedule"]["type"], "interval")
        p = core.resolve_params({"kind": "proposal_scan", "params": {"dry_run": "on", "force": 0, "x": 1}}, {})
        self.assertEqual(p, {"dry_run": True, "force": False})

    def test_warning_when_host_cannot(self):
        w = core.param_warnings({"kind": "proposal_scan", "params": {}}, {"supabase": True, "proposal_scan": False})
        self.assertTrue(any("스캔본" in x for x in w))


if __name__ == "__main__":
    unittest.main()
