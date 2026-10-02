# -*- coding: utf-8 -*-
"""test_nas_worker.py — 사내 NAS 적재 워커(REQ-0097) 단위 테스트(헤드리스, 외부 접속 없음).

    python -m unittest test_nas_worker -v

실제 Supabase·NAS 를 **절대** 건드리지 않는다 — `rpc` 를 가짜로 바꿔 끼우고, NAS 루트는
tempfile 임시 폴더를 쓴다. 검증하는 불변식은 「조용히 틀리지 않는다」 계열이다:
ERP 큐를 집지 않는다 · 못 하면 선점조차 하지 않는다 · 파일이 놓인 뒤에만 커서가 전진한다 ·
건수가 어긋나면 실패로 닫는다 · 오류 문자열에 계정·IP·NAS 경로가 남지 않는다.
"""
import gzip
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import runner_core as core   # noqa: E402
import nas_worker as w       # noqa: E402

# 이 워커가 절대 부르면 안 되는 RPC — ERP 러너의 큐·심박이다.
# 부르면 ERP 「데이터 업데이트」 요청을 집어 실패시키거나, 화면이 러너 가동을 오판정한다(SQL 49 미적용).
ERP_RPCS = ("erp_sync_request_claim", "erp_sync_runner_ping", "erp_sync_request_progress",
            "erp_sync_request_finish", "offboard_request_claim")


def _tmp(testcase):
    d = tempfile.mkdtemp(prefix="nas_test_")
    testcase.addCleanup(shutil.rmtree, d, True)
    return d


def page(rows, has_more=False, cursor=None, pk=None):
    return {"count": len(rows), "rows": rows, "has_more": has_more,
            "next_cursor": cursor, "next_pk": pk, "mode": "incremental"}


def src(key="agent_turn", mode="incremental", kind="turns", last_cursor=None, last_pk=None):
    return {"source_key": key, "kind": kind, "mode": mode, "label_ko": key,
            "cursor_col": "id", "pk_col": "id",
            "last_cursor": last_cursor, "last_pk": last_pk, "rows_total": 0}


class FakeRpc:
    """호출을 기록하고 정해둔 응답을 돌려준다. 리스트면 순서대로 꺼낸다(페이지 흉내)."""

    def __init__(self, responses):
        self.calls = []
        self.responses = responses
        self.raise_on = {}          # {fn: 몇 번째 호출에서 터질지(1부터)}
        self._seen = {}

    def __call__(self, url, key, fn, payload):
        self.calls.append((fn, payload))
        self._seen[fn] = self._seen.get(fn, 0) + 1
        if fn in self.raise_on and self._seen[fn] == self.raise_on[fn]:
            raise RuntimeError("HTTP 500 rpc/%s: 서버 오류 흉내" % fn)
        v = self.responses.get(fn)
        if isinstance(v, list):
            return v.pop(0) if v else None
        return v

    def fns(self):
        return [c[0] for c in self.calls]

    def payloads(self, fn):
        return [p for f, p in self.calls if f == fn]

    def last(self, fn):
        return self.payloads(fn)[-1]


class Base(unittest.TestCase):
    def patch(self, obj, name, value):
        old = getattr(obj, name)
        setattr(obj, name, value)
        self.addCleanup(setattr, obj, name, old)

    def setUp(self):
        self.root = _tmp(self)
        self.logs = []
        self.patch(w, "log", self.logs.append)

    def use(self, responses):
        f = FakeRpc(responses)
        self.patch(w, "rpc", f)
        return f

    def assertNoErpRpc(self, f):
        hit = [n for n in f.fns() if n in ERP_RPCS or n.startswith("erp_")]
        self.assertEqual(hit, [], "ERP 큐·심박 RPC 를 불렀다: %s" % hit)

    def read_lines(self, path):
        if path.endswith(".gz"):
            with gzip.open(path, "rt", encoding="utf-8") as fh:
                return fh.read().splitlines()
        with io.open(path, encoding="utf-8") as fh:
            return fh.read().splitlines()


# ─────────────────────────── 경계: 무엇을 부르지 않는가 ───────────────────────────
class TestBoundary(Base):
    def test_never_calls_erp_queue_rpcs(self):
        f = self.use({
            "nas_request_claim": {"request_id": "r1-aaaaaaaa", "kind": "turns", "sources": []},
            "nas_export_sources": [[src()]],
            "nas_export_page": [page([{"id": 1}], False, "1", "1")],
        })
        self.assertEqual(w.tick("u", "k", "host", self.root), "done")
        self.assertNoErpRpc(f)

    def test_source_has_no_erp_queue_reference(self):
        """소스에 ERP 큐 이름이 아예 없어야 한다 — 실수로 되살아나는 것을 막는다."""
        with io.open(os.path.join(HERE, "nas_worker.py"), encoding="utf-8") as fh:
            text = fh.read()
        for name in ("erp_sync_request_claim", "erp_sync_runner_ping", "offboard_request_claim"):
            self.assertNotIn(name, text, "%s 참조가 남아 있다" % name)

    def test_no_root_does_not_claim(self):
        def boom(*a, **k):
            raise RuntimeError("NAS 루트를 모릅니다 — .claude/nas.path 를 채우세요")
        self.patch(w, "nas_root", boom)
        f = self.use({})
        self.assertIs(w.tick("u", "k", "host", None), False)
        self.assertIn("nas_runner_ping", f.fns(), "심박은 남겨야 화면이 상태를 안다")
        self.assertNotIn("nas_request_claim", f.fns(),
                         "못 하는 일이면 선점조차 하지 않는다 — 집어놓고 실패시키면 사람이 다시 눌러야 한다")
        self.assertIn("root=none", f.last("nas_runner_ping")["p_note"])
        self.assertTrue(any("NAS 루트" in m for m in self.logs), "사유를 남겨야 한다(§17.6)")

    def test_explicit_root_missing_does_not_claim(self):
        """--root 로 받은 경로도 없으면 선점하지 않는다 — 2026-10-02 실 NAS 시험에서 없는 폴더로 done 이 찍혔다."""
        f = self.use({"nas_request_claim": {"request_id": "r1-aaaaaaaa", "kind": "turns", "sources": []}})
        self.assertIs(w.tick("u", "k", "host", os.path.join(self.root, "없는폴더")), False)
        self.assertNotIn("nas_request_claim", f.fns())
        self.assertIn("root=none", f.last("nas_runner_ping")["p_note"])

    def test_idle_marker_matches_runner_core(self):
        """이 문자열이 runner_core.IDLE_MARKERS 와 어긋나면 idle 로그 정리가 조용히 멈춘다."""
        self.assertIn("대기 요청 없음", core.IDLE_MARKERS)
        f = self.use({"nas_request_claim": None})
        self.assertIs(w.tick("u", "k", "host", self.root), False)
        self.assertIn("대기 요청 없음", self.logs)
        self.assertNoErpRpc(f)


# ─────────────────────────── 하루 한 번(예약작업) ───────────────────────────
class TestNightly(Base):
    def setUp(self):
        super().setUp()
        self.stamp = os.path.join(_tmp(self), "logs", "nas_nightly.json")
        self.patch(w, "_stamp_file", lambda: self.stamp)
        self.ran = []

        def fake_export(url, key, root, kind, wanted, dry=False, **kw):
            self.ran.append(kind)
            return {"rows": 3, "files": 1, "failed": list(self.fail.get(kind, []))}
        self.fail = {}
        self.patch(w, "run_export", fake_export)

    def test_runs_both_kinds_once_per_day(self):
        f = self.use({"nas_request_claim": None})
        self.assertEqual(w.nightly("u", "k", "host", self.root, today="2026-10-02"), 0)
        self.assertEqual(self.ran, ["turns", "erp_snapshot"])
        self.assertEqual(w.nightly("u", "k", "host", self.root, today="2026-10-02"), 0)
        self.assertEqual(self.ran, ["turns", "erp_snapshot"], "같은 날 두 번 내보내지 않는다")
        self.assertIn("nas_request_claim", f.fns(), "그날 끝났어도 화면 요청은 본다")
        self.assertEqual(w.nightly("u", "k", "host", self.root, today="2026-10-03"), 0)
        self.assertEqual(len(self.ran), 4, "날이 바뀌면 다시 한다")
        self.assertNoErpRpc(f)

    def test_failure_leaves_no_stamp_so_it_retries(self):
        self.use({})
        self.fail = {"erp_snapshot": ["v_erp_item"]}
        self.assertEqual(w.nightly("u", "k", "host", self.root, today="2026-10-02"), 1)
        self.assertFalse(os.path.exists(self.stamp))
        self.fail = {}
        self.assertEqual(w.nightly("u", "k", "host", self.root, today="2026-10-02"), 0)
        self.assertTrue(os.path.exists(self.stamp))

    def test_missing_root_postpones_without_export(self):
        f = self.use({})
        self.assertEqual(w.nightly("u", "k", "host", os.path.join(self.root, "없는폴더"), today="2026-10-02"), 0)
        self.assertEqual(self.ran, [])
        self.assertFalse(os.path.exists(self.stamp))
        self.assertIn("root=none", f.last("nas_runner_ping")["p_note"])


# ─────────────────────────── 브리지 전송·상주(컨테이너) ───────────────────────────
class TestBridgeAndServe(Base):
    def test_bridge_refuses_rpc_outside_whitelist(self):
        """브리지 모드에서는 목록 밖 RPC 를 네트워크로 보내기 전에 막는다."""
        self.patch(w, "_TRANSPORT", "bridge")
        sent = []
        self.patch(w.urllib.request, "urlopen", lambda *a, **k: sent.append(a) or (_ for _ in ()).throw(AssertionError("보내면 안 된다")))
        with self.assertRaises(RuntimeError):
            w.rpc("https://bridge.example/fn", "tok", "gl_draft_list", {})
        self.assertEqual(sent, [])

    def test_bridge_request_shape_carries_token_not_service_key(self):
        self.patch(w, "_TRANSPORT", "bridge")
        seen = {}

        class Resp:
            def __enter__(s): return s
            def __exit__(s, *a): return False
            def read(s): return b'{"ok": true}'

        def fake(req, timeout=None):
            seen["url"] = req.full_url
            seen["headers"] = {k.lower(): v for k, v in req.header_items()}
            seen["body"] = json.loads(req.data.decode("utf-8"))
            return Resp()
        self.patch(w.urllib.request, "urlopen", fake)
        self.assertEqual(w.rpc("https://bridge.example/fn", "tok-123", "nas_runner_ping", {"p_worker": "x"}), {"ok": True})
        self.assertEqual(seen["url"], "https://bridge.example/fn")
        self.assertEqual(seen["headers"].get("x-nas-worker-token"), "tok-123")
        self.assertNotIn("authorization", seen["headers"])
        self.assertNotIn("apikey", seen["headers"])
        self.assertEqual(seen["body"], {"fn": "nas_runner_ping", "payload": {"p_worker": "x"}})

    def test_worker_only_uses_bridgeable_rpcs(self):
        """워커가 부르는 RPC 는 전부 브리지 목록 안에 있어야 한다 — 하나라도 빠지면 컨테이너에서만 죽는다."""
        import re as _re
        with io.open(os.path.join(HERE, "nas_worker.py"), encoding="utf-8") as fh:
            used = set(_re.findall(r'rpc\(url, key, "([a-z_]+)"', fh.read()))
        self.assertTrue(used, "RPC 호출을 하나도 못 찾았다 — 정규식을 고칠 것")
        self.assertEqual(sorted(used - set(w.BRIDGE_FNS)), [])

    def test_serve_keeps_going_after_error(self):
        calls = []

        def flaky(*a, **k):
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("HTTP 500 흉내")
            return 0
        self.patch(w, "nightly", flaky)
        self.patch(w.time, "sleep", lambda s: None)
        self.assertEqual(w.serve("u", "k", "host", self.root, rounds=3), 0)
        self.assertEqual(len(calls), 3)

    def test_today_is_kst_even_on_utc_host(self):
        utc = w.datetime.datetime.now(w.datetime.timezone.utc).replace(tzinfo=None)
        diff = (w._now() - utc).total_seconds()
        self.assertAlmostEqual(diff, 9 * 3600, delta=5)

    def test_redacts_container_mount_paths(self):
        s = w._redact("PermissionError: [Errno 13] Permission denied: '/volume1/공유/agent/x.tmp' 그리고 /data/대화기록/a")
        self.assertNotIn("volume1", s)
        self.assertNotIn("대화기록", s)


# ─────────────────────────── 내보내기 정합 ───────────────────────────
class TestExport(Base):
    def test_pages_appended_and_sha256_matches_file(self):
        rows = [[{"id": i, "q": "질문%d" % i} for i in (1, 2)],
                [{"id": i, "q": "질문%d" % i} for i in (3, 4)],
                [{"id": 5, "q": "질문5"}]]
        f = self.use({
            "nas_export_sources": [[src()]],
            "nas_export_page": [page(rows[0], True, "2", "2"),
                                page(rows[1], True, "4", "4"),
                                page(rows[2], False, "5", "5")],
        })
        body = w.run_export("u", "k", self.root, "turns", [])
        self.assertEqual(body["failed"], [])
        self.assertEqual(body["rows"], 5)
        d = body["sources"][0]
        path = os.path.join(self.root, d["file"].replace("/", os.sep))
        lines = self.read_lines(path)
        self.assertEqual(len(lines), 5, "세 페이지가 한 파일에 이어 붙어야 한다")
        sha = hashlib.sha256(("".join(l + "\n" for l in lines)).encode("utf-8")).hexdigest()
        self.assertEqual(d["sha256"], sha, "기록한 본문과 해시가 일치해야 복원 대조가 성립한다")
        self.assertEqual(f.last("nas_export_commit")["p_last_cursor"], "5")
        self.assertEqual(f.last("nas_export_commit")["p_rows"], 5)

    def test_cursor_is_passed_through_verbatim(self):
        """커서를 워커가 숫자로 바꿔 비교하면 '9' > '10' 함정이 되살아난다 — 받은 값을 그대로 넘긴다."""
        f = self.use({
            "nas_export_sources": [[src()]],
            "nas_export_page": [page([{"id": i} for i in range(1, 10)], True, "9", "9"),
                                page([{"id": i} for i in range(10, 13)], False, "12", "12")],
        })
        body = w.run_export("u", "k", self.root, "turns", [])
        sent = f.payloads("nas_export_page")
        self.assertIsNone(sent[0]["p_after_cursor"])
        self.assertEqual(sent[1]["p_after_cursor"], "9", "9 다음 페이지는 커서 '9' 로 요청해야 한다")
        self.assertEqual(sent[1]["p_after_pk"], "9")
        self.assertEqual(body["rows"], 12, "9→10 경계에서 멈추지 않아야 한다")

    def test_resumes_from_stored_cursor(self):
        f = self.use({
            "nas_export_sources": [[src(last_cursor="88", last_pk="88")]],
            "nas_export_page": [page([{"id": 89}], False, "89", "89")],
        })
        w.run_export("u", "k", self.root, "turns", [])
        self.assertEqual(f.payloads("nas_export_page")[0]["p_after_cursor"], "88")

    def test_stalled_cursor_is_reported_not_looped(self):
        """커서가 안 오는데 has_more 가 참이면 같은 페이지를 영원히 받는다 — 드러내고 멈춘다."""
        self.use({
            "nas_export_sources": [[src()]],
            "nas_export_page": [page([{"id": 1}], True, None, None)],
        })
        body = w.run_export("u", "k", self.root, "turns", [])
        self.assertEqual(body["failed"], ["agent_turn"])
        self.assertIn("커서", body["sources"][0]["error"])

    def test_full_mode_count_mismatch_fails_without_commit(self):
        f = self.use({
            "nas_export_sources": [[src("v_erp_item", mode="full", kind="erp_snapshot")]],
            "nas_export_count": {"count": 10},
            "nas_export_page": [page([{"item_code": "A%d" % i} for i in range(8)], False, "8")],
        })
        body = w.run_export("u", "k", self.root, "erp_snapshot", [])
        self.assertEqual(body["failed"], ["v_erp_item"])
        self.assertIn("건수 불일치", body["sources"][0]["error"])
        self.assertNotIn("nas_export_commit", f.fns(), "어긋난 스냅샷으로 커서를 전진시키지 않는다")
        self.assertEqual(self._files_under(self.root, ".jsonl.gz"), [], "반쪽 파일을 남기지 않는다")

    def test_failure_midway_leaves_no_file_and_no_commit(self):
        f = self.use({
            "nas_export_sources": [[src()]],
            "nas_export_page": [page([{"id": 1}], True, "1", "1")],
        })
        f.raise_on["nas_export_page"] = 2
        body = w.run_export("u", "k", self.root, "turns", [])
        self.assertEqual(body["failed"], ["agent_turn"])
        self.assertNotIn("nas_export_commit", f.fns())
        self.assertEqual(self._files_under(self.root, ".jsonl"), [])
        self.assertEqual(self._files_under(self.root, ".tmp"), [], "임시 파일을 치워야 한다")

    def test_missing_source_is_failed_not_dropped(self):
        f = self.use({"nas_export_sources": [[src()]]})
        body = w.run_export("u", "k", self.root, "turns", ["agent_turn_없음"])
        self.assertEqual(body["failed"], ["agent_turn_없음"])
        self.assertIn("허용 목록", body["sources"][0]["error"])
        self.assertNotIn("nas_export_page", f.fns())

    def test_dry_run_writes_nothing(self):
        f = self.use({
            "nas_export_sources": [[src()]],
            "nas_export_page": [page([{"id": 1}], True, "1", "1")],
        })
        body = w.run_export("u", "k", self.root, "turns", [], dry=True)
        self.assertEqual(body["files"], 0)
        self.assertNotIn("nas_export_commit", f.fns())
        self.assertEqual(self._files_under(self.root, ".jsonl"), [])
        self.assertEqual(body["sources"][0]["status"], "dry")

    def test_manifest_records_hash_and_encryption_state(self):
        self.use({
            "nas_export_sources": [[src()]],
            "nas_export_page": [page([{"id": 1}], False, "1", "1")],
        })
        body = w.run_export("u", "k", self.root, "turns", [])
        man = self._files_under(self.root, ".json")
        self.assertEqual(len(man), 1, "회차마다 manifest 한 장")
        with io.open(man[0], encoding="utf-8") as fh:
            got = json.load(fh)
        self.assertEqual(got["rows"], 1)
        self.assertTrue(got["sources"][0]["sha256"])
        self.assertIn("encrypted", got)
        if not got["encrypted"]:
            self.assertTrue(got["encrypt_note"], "암호화를 못 했으면 사유를 적는다(§17.6)")

    def test_one_source_failure_does_not_stop_the_rest(self):
        f = self.use({
            "nas_export_sources": [[src("agent_turn"), src("agent_improve")]],
            "nas_export_page": [page([{"id": 1}], False, "1", "1"),
                                page([{"id": 2}], False, "2", "2")],
        })
        f.raise_on["nas_export_page"] = 1
        body = w.run_export("u", "k", self.root, "turns", [])
        self.assertEqual(body["failed"], ["agent_turn"])
        self.assertEqual(body["rows"], 1, "뒤 소스는 계속 간다")

    def _files_under(self, root, suffix):
        out = []
        for base, _dirs, names in os.walk(root):
            for n in names:
                if n.endswith(suffix):
                    out.append(os.path.join(base, n))
        return sorted(out)


# ─────────────────────────── 큐 처리·실패 닫기 ───────────────────────────
class TestQueue(Base):
    def test_request_is_closed_failed_on_systemexit(self):
        """need() 는 SystemExit(BaseException)을 던진다 — 놓치면 요청이 running 에 2시간 갇힌다."""
        def boom(*a, **k):
            raise SystemExit("환경변수 SUPABASE_URL 가 없습니다")
        self.patch(w, "run_export", boom)
        f = self.use({"nas_request_claim": {"request_id": "r2-bbbbbbbb", "kind": "turns", "sources": []}})
        self.assertEqual(w.tick("u", "k", "host", self.root), "failed")
        self.assertEqual(f.last("nas_request_finish")["p_status"], "failed")

    def test_partial_failure_closes_request_as_failed(self):
        f = self.use({
            "nas_request_claim": {"request_id": "r3-cccccccc", "kind": "turns", "sources": []},
            "nas_export_sources": [[src("agent_turn"), src("agent_improve")]],
            "nas_export_page": [page([{"id": 1}], False, "1", "1"),
                                page([{"id": 2}], False, "2", "2")],
        })
        f.raise_on["nas_export_page"] = 1
        self.assertEqual(w.tick("u", "k", "host", self.root), "failed")
        fin = f.last("nas_request_finish")
        self.assertEqual(fin["p_status"], "failed", "일부라도 못 했으면 초록 「완료」로 닫지 않는다")
        self.assertIn("agent_turn", fin["p_error"])

    def test_progress_is_reported_per_source(self):
        f = self.use({
            "nas_request_claim": {"request_id": "r4-dddddddd", "kind": "turns", "sources": []},
            "nas_export_sources": [[src("agent_turn"), src("agent_improve")]],
            "nas_export_page": [page([{"id": 1}], False, "1", "1"),
                                page([{"id": 2}], False, "2", "2")],
        })
        self.assertEqual(w.tick("u", "k", "host", self.root), "done")
        got = [(p["p_done"], p["p_total"], p["p_source"]) for p in f.payloads("nas_request_progress")]
        self.assertEqual(got, [(1, 2, "agent_turn"), (2, 2, "agent_improve")])

    def test_ping_note_carries_version_and_root_state(self):
        f = self.use({"nas_request_claim": None})
        w.tick("u", "k", "host", self.root)
        note = f.last("nas_runner_ping")["p_note"]
        self.assertIn("+nas", note)
        self.assertIn(w.WORKER_VERSION, note)
        self.assertIn("root=ok", note)


# ─────────────────────────── 비밀·경로 방어 ───────────────────────────
class TestRedactAndPaths(Base):
    def test_redact_hides_account_ip_and_unc_path(self):
        s = w._redact("Login failed for user 'sa'; SERVER=10.1.2.3,1433; 경로 \\\\NASHOST\\share\\AI포털")
        self.assertNotIn("'sa'", s)
        self.assertNotIn("10.1.2.3", s)
        self.assertNotIn("NASHOST", s, "NAS 공유 경로는 DB·로그에 남기지 않는다(§1.1)")
        self.assertIn("Login failed", s, "진단에 필요한 문구는 남긴다")

    def test_out_path_rejects_bad_source_name(self):
        with self.assertRaises(RuntimeError):
            w.out_path(self.root, {"source_key": "../../탈출", "mode": "incremental", "kind": "turns"},
                       "2026-09-30 120000")

    def test_out_path_layout(self):
        p, rel = w.out_path(self.root, src(), "2026-09-30 120000")
        self.assertTrue(rel.startswith("대화기록/agent_turn/2026/"))
        self.assertTrue(rel.endswith(".jsonl"))
        p2, rel2 = w.out_path(self.root, src("v_erp_item", mode="full", kind="erp_snapshot"),
                              "2026-09-30 120000")
        self.assertEqual(rel2, "ERP스냅샷/2026-09-30/v_erp_item.jsonl.gz",
                         "전량 스냅샷은 날짜 폴더에 하루 한 장")

    def test_nas_root_prefers_argument_then_env(self):
        self.assertEqual(w.nas_root(self.root), os.path.abspath(self.root))
        os.environ["NAS_DATA_ROOT"] = self.root
        self.addCleanup(os.environ.pop, "NAS_DATA_ROOT", None)
        self.assertEqual(w.nas_root(), os.path.abspath(self.root))

    def test_nas_root_missing_folder_is_error(self):
        os.environ["NAS_DATA_ROOT"] = os.path.join(self.root, "없는폴더")
        self.addCleanup(os.environ.pop, "NAS_DATA_ROOT", None)
        with self.assertRaises(RuntimeError):
            w.nas_root()


# ─────────────────────────── 러너 편입 ───────────────────────────
class TestRunnerWiring(Base):
    def test_job_kind_and_params_registered(self):
        self.assertIn("nas_sync", core.JOB_KINDS)
        self.assertIn("nas_sync", core.PARAM_KEYS)
        self.assertEqual(core.JOB_KINDS["nas_sync"]["group"], "nas",
                         "ERP·릴레이와 다른 그룹이어야 동시에 돌 수 있다")

    def test_unknown_params_dropped(self):
        job = {"id": "j", "kind": "nas_sync", "params": {"dry_run": True, "webhook": "https://x"}}
        p = core.resolve_params(job, {"nas": True, "supabase": True})
        self.assertEqual(p, {"dry_run": True}, "모르는 키는 자식 명령줄·로그로 흘러가지 않는다")

    def test_capability_warning_when_root_unset(self):
        job = {"id": "j", "kind": "nas_sync", "params": {}}
        msgs = core.param_warnings(job, {"supabase": True, "nas": False})
        self.assertTrue(any("NAS 루트" in m for m in msgs))

    def test_not_in_default_jobs(self):
        """검증이 끝난 뒤 관리자가 켠다 — 기본값으로 돌기 시작하지 않는다."""
        self.assertNotIn("nas_sync", [j["kind"] for j in core.DEFAULT_JOBS])


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    unittest.main(verbosity=2)
