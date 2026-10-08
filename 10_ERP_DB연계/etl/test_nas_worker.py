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


# ─────────────────────────── 실시간 조회(에이전트 → NAS) ───────────────────────────
class TestQuery(Base):
    def _mk(self, rel, text="x", age_days=0):
        p = os.path.join(self.root, *rel.split("/"))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with io.open(p, "w", encoding="utf-8") as fh:
            fh.write(text)
        if age_days:
            t = w.time.time() - age_days * 86400
            os.utime(p, (t, t))
        return p

    def setUp(self):
        super().setUp()
        self._mk("부서/5200_구매팀/구매규정_2026.docx")
        self._mk("부서/5200_구매팀/양식/발주서_양식.xlsx", age_days=40)
        self._mk("부서/5200_구매팀/#recycle/지운파일.docx")
        self._mk("부서/5200_구매팀/.숨김.txt")
        self._mk("부서/6100_인사팀/급여대장.xlsx")
        self._mk("00_전사공유/사규.pdf")
        self.scope = {"folders": [{"key": "pur", "rel_path": "부서/5200_구매팀", "label": "구매팀"}]}

    def names(self, res):
        return sorted(r["이름"] for r in res["목록"])

    def test_lists_only_scoped_folder_and_skips_recycle_hidden(self):
        res, n = w.query_file_list({}, self.scope, self.root)
        self.assertEqual(self.names(res), ["구매규정_2026.docx", "발주서_양식.xlsx"])
        self.assertEqual(n, 2)
        self.assertNotIn("급여대장.xlsx", json.dumps(res, ensure_ascii=False), "다른 부서 폴더가 새면 안 된다")
        self.assertNotIn(self.root, json.dumps(res, ensure_ascii=False), "절대경로를 내보내지 않는다")
        sub = {r["이름"]: r["경로"] for r in res["목록"]}
        self.assertEqual(sub, {"구매규정_2026.docx": "", "발주서_양식.xlsx": "양식"})

    def test_filters_by_name_days_and_limit(self):
        self.assertEqual(self.names(w.query_file_list({"q": "양식"}, self.scope, self.root)[0]), ["발주서_양식.xlsx"])
        self.assertEqual(self.names(w.query_file_list({"days": 7}, self.scope, self.root)[0]), ["구매규정_2026.docx"])
        res, n = w.query_file_list({"limit": 1}, self.scope, self.root)
        self.assertEqual((n, res["해당"], res["잘림"]), (1, 2, True))
        self.assertEqual(self.names(res), ["구매규정_2026.docx"], "최신 수정이 먼저")

    def test_scope_cannot_escape_docs_root(self):
        """요청 행의 경로가 상위로 나가려 해도(DB CHECK 가 뚫렸다고 가정) 워커가 막는다."""
        for bad in ("..", "부서/../..", "부서/5200_구매팀/../6100_인사팀", "/etc", ""):
            sc = {"folders": [{"key": "x", "rel_path": bad, "label": "x"}]}
            res, n = w.query_file_list({}, sc, os.path.join(self.root, "부서"))
            self.assertEqual((n, res["목록"]), (0, []), bad)

    def test_inside_tolerates_trailing_separator_on_root(self):
        """공유 최상위를 루트로 쓰면 끝에 구분자가 붙는다 — 2026-10-02 실 NAS 에서 허용 폴더가 전부 「밖」으로 판정됐다."""
        root = self.root + os.sep
        self.assertTrue(w._inside(root, os.path.join(self.root, "부서")))
        self.assertTrue(w._inside(root, self.root))
        self.assertFalse(w._inside(root, os.path.dirname(self.root)))
        self.assertFalse(w._inside(self.root, self.root + "x"))

    def test_file_list_needs_docs_root_and_scope(self):
        with self.assertRaises(RuntimeError):
            w.query_file_list({}, self.scope, None)
        with self.assertRaises(RuntimeError):
            w.query_file_list({}, {"folders": []}, self.root)

    def test_turn_history_is_self_only(self):
        d = os.path.join(self.root, "대화기록", "agent_turn", "2026")
        os.makedirs(d)
        rows = [
            {"id": 1, "upn": "Me@jeilm.co.kr", "created_at": "2026-09-28T05:00:00+00:00", "agent_key": "purchase", "question": "미입고 발주 알려줘", "answer": "미입고는 3건입니다"},
            {"id": 2, "upn": "other@jeilm.co.kr", "created_at": "2026-09-29T05:00:00+00:00", "agent_key": "purchase", "question": "미입고 급여 비밀", "answer": "남의 대화"},
            {"id": 3, "upn": "me@jeilm.co.kr", "created_at": "2026-09-30T05:00:00+00:00", "agent_key": "purchase", "question": "거래처 매입", "answer": "매입 합계"},
        ]
        with io.open(os.path.join(d, "agent_turn_a.jsonl"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
        with io.open(os.path.join(d, "agent_turn_b.jsonl"), "w", encoding="utf-8") as fh:
            fh.write(json.dumps(rows[0], ensure_ascii=False) + "\n")          # 같은 턴이 두 파일에(재적재 흉내)
        res, n = w.query_turn_history({}, {"upn": "me@jeilm.co.kr"}, self.root)
        self.assertEqual([r["턴번호"] for r in res["목록"]], [3, 1], "본인 것만 · 최신 먼저 · 중복 없음")
        self.assertNotIn("남의 대화", json.dumps(res, ensure_ascii=False))
        res, n = w.query_turn_history({"q": "미입고"}, {"upn": "me@jeilm.co.kr"}, self.root)
        self.assertEqual([r["턴번호"] for r in res["목록"]], [1])
        with self.assertRaises(RuntimeError):
            w.query_turn_history({}, {}, self.root)

    def test_handle_query_always_finishes(self):
        f = self.use({})
        self.assertEqual(w.handle_query("u", "k", {"query_id": "q1", "kind": "file_list", "params": {}, "scope": self.scope}, self.root, self.root), "done")
        self.assertEqual(f.last("nas_query_finish")["p_status"], "done")
        self.assertEqual(f.last("nas_query_finish")["p_rows"], 2)
        self.assertEqual(w.handle_query("u", "k", {"query_id": "q2", "kind": "delete_all", "params": {}, "scope": {}}, self.root, self.root), "failed")
        self.assertEqual(f.last("nas_query_finish")["p_status"], "failed")
        self.assertEqual(w.handle_query("u", "k", {"query_id": "q3", "kind": "file_list", "params": {}, "scope": self.scope}, self.root, None), "failed")
        self.assertNotIn(self.root, f.last("nas_query_finish")["p_error"])
        self.assertNoErpRpc(f)

    def test_doc_search_and_read_through_worker(self):
        """색인 → 검색 → 읽기가 워커 경로로 이어지고, 범위(scope) 밖 폴더는 끝까지 안 보인다."""
        db = os.path.join(_tmp(self), "ix.sqlite")
        self.patch(w, "index_db_path", lambda: db)
        with io.open(os.path.join(self.root, "부서", "5200_구매팀", "구매규정.txt"), "w", encoding="utf-8") as fh:
            fh.write("제3조 수의계약은 추정가격 2천만원 이하인 경우에 할 수 있다.")
        with io.open(os.path.join(self.root, "부서", "6100_인사팀", "인사.txt"), "w", encoding="utf-8") as fh:
            fh.write("수의계약 낱말이 들어 있는 인사팀 문서")
        f = self.use({"nas_index_folders": [[{"key": "pur", "rel_path": "부서/5200_구매팀", "label": "구매팀"},
                                             {"key": "hr", "rel_path": "부서/6100_인사팀", "label": "인사팀"}]]})
        self.patch(w, "nas_docs_root", lambda: self.root)
        w.index_loop("u", "k", rounds=1)
        res, n = w.query_doc_search({"q": "수의계약"}, self.scope)
        self.assertEqual([(h["이름"], h["폴더"]) for h in res["목록"]], [("구매규정.txt", "구매팀")])
        self.assertNotIn("폴더키", res["목록"][0])
        doc, m = w.query_doc_read({"doc": res["목록"][0]["문서"]}, self.scope)
        self.assertIn("2천만원 이하", doc["내용"])
        hr_doc = w.query_doc_search({"q": "수의계약"}, {"folders": [{"key": "hr", "rel_path": "x", "label": "인사팀"}]})[0]["목록"][0]["문서"]
        self.assertEqual(w.query_doc_read({"doc": hr_doc}, self.scope)[0]["내용"], "", "남의 폴더 문서 번호를 알아도 못 읽는다")
        self.assertEqual(w.query_doc_search({"q": ""}, self.scope)[1], 0)
        self.assertEqual(w.handle_query("u", "k", {"query_id": "q9", "kind": "doc_search", "params": {"q": "수의계약"}, "scope": self.scope}, self.root, self.root), "done")
        self.assertEqual(f.last("nas_query_finish")["p_rows"], 1)
        self.assertNoErpRpc(f)

    def test_doc_search_without_index_fails_loudly(self):
        self.patch(w, "index_db_path", lambda: os.path.join(self.root, "없는색인.sqlite"))
        with self.assertRaises(RuntimeError):
            w.query_doc_search({"q": "x"}, self.scope)

    def test_query_loop_claims_and_answers(self):
        f = self.use({"nas_query_claim": [{"query_id": "q1", "kind": "file_list", "params": {}, "scope": self.scope}, None]})
        self.patch(w, "nas_docs_root", lambda: self.root)
        self.patch(w.time, "sleep", lambda s: None)
        w.query_loop("u", "k", "host", self.root, rounds=2)
        self.assertEqual(f.fns().count("nas_query_claim"), 2)
        self.assertEqual(f.fns().count("nas_query_finish"), 1)

    def test_queries_run_in_parallel_not_in_a_line(self):
        """여럿이 같이 물으면 한 줄로 서지 않는다 — 느린 조회 하나가 뒤 조회를 붙잡지 않는다(REQ-0117 동시 조회 지연)."""
        import threading, time as _t
        qs = [{"query_id": f"p{i}", "kind": "file_list", "params": {}, "scope": self.scope} for i in range(4)]
        f = self.use({"nas_query_claim": qs + [None]})
        self.patch(w, "nas_docs_root", lambda: self.root)
        gate, seen, peak, lock = threading.Event(), [], [0, 0], threading.Lock()

        def slow(url, key, q, data_root, docs_root):
            with lock:
                peak[0] += 1; peak[1] = max(peak[1], peak[0]); seen.append(q["query_id"])
            if len(seen) >= 4:
                gate.set()
            gate.wait(5)                           # 네 건이 모두 시작돼야 풀린다 — 한 줄 처리라면 첫 건에서 5초 멈춘다
            with lock:
                peak[0] -= 1
            return "done"
        self.patch(w, "handle_query", slow)
        t0 = _t.time()
        w.query_loop("u", "k", "host", self.root, rounds=5)
        self.assertEqual(sorted(seen), ["p0", "p1", "p2", "p3"])
        self.assertEqual(peak[1], 4, "네 건이 동시에 돌아야 한다")
        self.assertLess(_t.time() - t0, 4, "한 줄로 처리하지 않는다")

    def test_no_more_than_parallel_limit_at_once(self):
        import threading
        qs = [{"query_id": f"p{i}", "kind": "file_list", "params": {}, "scope": self.scope} for i in range(9)]
        self.use({"nas_query_claim": qs + [None]})
        self.patch(w, "nas_docs_root", lambda: self.root)
        peak, lock = [0, 0], threading.Lock()

        def work(url, key, q, data_root, docs_root):
            with lock:
                peak[0] += 1; peak[1] = max(peak[1], peak[0])
            threading.Event().wait(0.05)
            with lock:
                peak[0] -= 1
            return "done"
        self.patch(w, "handle_query", work)
        w.query_loop("u", "k", "host", self.root, rounds=10)
        self.assertLessEqual(peak[1], w.QUERY_PARALLEL)
        self.assertGreaterEqual(peak[1], 2)

    def test_claim_error_retries_quickly_and_one_bad_query_does_not_stop_others(self):
        naps = []
        self.patch(w.time, "sleep", lambda s: naps.append(s))
        calls = {"n": 0}

        def flaky(url, key, fn, payload, wait_sec=0):
            if fn == "nas_query_claim":
                calls["n"] += 1
                if calls["n"] in (1, 2):
                    raise RuntimeError("연결이 끊겼습니다")
                if calls["n"] == 3:
                    return {"query_id": "bad", "kind": "file_list", "params": {}, "scope": self.scope}
                if calls["n"] == 4:
                    return {"query_id": "good", "kind": "file_list", "params": {}, "scope": self.scope}
                return None
            return None
        self.patch(w, "rpc", flaky)
        self.patch(w, "nas_docs_root", lambda: self.root)
        done = []

        def work(url, key, q, data_root, docs_root):
            if q["query_id"] == "bad":
                raise RuntimeError("처리 중 예외")
            done.append(q["query_id"])
            return "done"
        self.patch(w, "handle_query", work)
        w.query_loop("u", "k", "host", self.root, rounds=6)
        self.assertEqual(naps[:2], [0.5, 1.0], "첫 오류는 0.5초만 쉬고 다시 문다(예전에는 5초)")
        self.assertEqual(done, ["good"], "한 조회가 예외로 죽어도 다음 조회는 처리된다")


# ─────────────────────────── 내보내기 정합 ───────────────────────────

    # ── REQ-0117 S1 — 표 구조 판독·판독 상태가 워커 경로로 이어지고, 범위 밖은 끝까지 안 보인다 ──
    def prep(self):
        db = os.path.join(_tmp(self), "ix.sqlite")
        self.patch(w, "index_db_path", lambda: db)
        pur = os.path.join(self.root, "부서", "5200_구매팀")
        os.makedirs(os.path.join(pur, "AI저장", "2026"), exist_ok=True)
        with io.open(os.path.join(pur, "AI저장", "2026", "단가.csv"), "w", encoding="utf-8") as fh:
            fh.write("품목,단가,납기\n볼트,1200,2026-10-01\n너트,300,2026-10-02")
        with io.open(os.path.join(pur, "AI저장", "2026", "옛한글.doc"), "w", encoding="utf-8") as fh:
            fh.write("x")
        with io.open(os.path.join(self.root, "부서", "6100_인사팀", "인원.csv"), "w", encoding="utf-8") as fh:
            fh.write("이름,부서\n가,나")
        f = self.use({"nas_index_folders": [[{"key": "pur", "rel_path": "부서/5200_구매팀", "label": "구매팀"},
                                             {"key": "hr", "rel_path": "부서/6100_인사팀", "label": "인사팀"}]]})
        self.patch(w, "nas_docs_root", lambda: self.root)
        w.index_loop("u", "k", rounds=1)
        return f

    def test_index_status_scope_and_reasons(self):
        f = self.prep()
        res, n = w.query_index_status({"under": "AI저장"}, self.scope)
        by = {r["이름"]: r for r in res["목록"]}
        self.assertEqual(set(by), {"단가.csv", "옛한글.doc"})
        self.assertEqual((by["단가.csv"]["상태"], by["단가.csv"]["표"], by["옛한글.doc"]["사유"]), ("읽힘", True, "읽지 못하는 형식"))
        self.assertEqual(by["단가.csv"]["폴더"], "구매팀")
        self.assertNotIn("1200", json.dumps(res, ensure_ascii=False))
        self.assertNotIn("인원.csv", json.dumps(w.query_index_status({}, self.scope)[0], ensure_ascii=False))
        self.assertEqual(w.query_index_status({"under": "../x"}, self.scope)[1], 0)
        self.assertEqual(w.handle_query("u", "k", {"query_id": "s1", "kind": "index_status", "params": {}, "scope": self.scope}, self.root, self.root), "done")
        self.assertNoErpRpc(f)

    def test_doc_table_reads_structure_within_scope_only(self):
        f = self.prep()
        st = w.query_index_status({}, self.scope)[0]["목록"]
        doc = next(r["문서"] for r in st if r["이름"] == "단가.csv")
        res, n = w.query_doc_table({"doc": doc}, self.scope, self.root)
        self.assertEqual((res["이름"], res["경로"], res["머리글"], res["행"]),
                         ("단가.csv", "AI저장/2026", {"A": "품목", "B": "단가", "C": "납기"},
                          [[2, "볼트", "1200", "2026-10-01"], [3, "너트", "300", "2026-10-02"]]))
        hr_scope = {"folders": [{"key": "hr", "rel_path": "부서/6100_인사팀", "label": "인사팀"}]}
        hr_doc = w.query_index_status({}, hr_scope)[0]["목록"][0]["문서"]
        denied, m = w.query_doc_table({"doc": hr_doc}, self.scope, self.root)
        self.assertEqual((denied["행"], m), ([], 0), "남의 폴더 문서 번호를 알아도 표를 못 읽는다")
        hwp = next(r["문서"] for r in st if r["이름"] == "옛한글.doc")
        self.assertIn("읽을 수 없는 문서", w.query_doc_table({"doc": hwp}, self.scope, self.root)[0]["사유"])
        # scope 의 폴더 경로가 조작돼도 문서 폴더 밖으로 나가지 못한다
        bad = {"folders": [{"key": "pur", "rel_path": "../밖", "label": "구매팀"}]}
        self.assertEqual(w.query_doc_table({"doc": doc}, bad, self.root)[1], 0)
        self.assertEqual(w.handle_query("u", "k", {"query_id": "t1", "kind": "doc_table", "params": {"doc": doc, "rows": 1}, "scope": self.scope}, self.root, self.root), "done")
        self.assertEqual(f.last("nas_query_finish")["p_rows"], 1)
        self.assertEqual(w.handle_query("u", "k", {"query_id": "t2", "kind": "doc_table", "params": {"doc": doc}, "scope": self.scope}, self.root, None), "failed")
        self.assertNoErpRpc(f)

    def test_file_list_carries_doc_ids_so_the_agent_can_read(self):
        """목록 → 읽기 연결(REQ-0117): 목록의 '문서' 번호로 곧바로 내용을 읽는다. 못 읽는 파일은 사유가 붙는다."""
        f = self.prep()
        res, n = w.query_file_list({"q": "단가"}, self.scope, self.root)
        row = res["목록"][0]
        self.assertEqual((row["이름"], row["읽기"], row.get("표")), ("단가.csv", "가능", True))
        self.assertNotIn("_key", row)
        doc, m = w.query_doc_read({"doc": row["문서"]}, self.scope)
        self.assertIn("볼트", doc["내용"])
        self.assertEqual(w.query_doc_table({"doc": row["문서"]}, self.scope, self.root)[0]["행"][0][1], "볼트")
        hwp = w.query_file_list({"q": "옛한글"}, self.scope, self.root)[0]["목록"][0]
        self.assertEqual((hwp["문서"], hwp["읽기"], hwp["사유"]), (None, "불가", "읽지 못하는 형식"))
        with io.open(os.path.join(self.root, "부서", "5200_구매팀", "방금.txt"), "w", encoding="utf-8") as fh:
            fh.write("아직 색인 전")
        fresh = w.query_file_list({"q": "방금"}, self.scope, self.root)[0]["목록"][0]
        self.assertEqual((fresh["문서"], fresh["읽기"]), (None, "준비 중"))
        self.assertNotIn("볼트", json.dumps(res, ensure_ascii=False), "목록에는 내용이 실리지 않는다")
        # 색인이 깨져도 목록은 나간다
        self.patch(w.nas_index, "lookup", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("색인 깨짐")))
        broken = w.query_file_list({"q": "단가"}, self.scope, self.root)[0]["목록"][0]
        self.assertEqual((broken["이름"], broken["문서"], broken["읽기"]), ("단가.csv", None, "확인 불가"))
        self.assertNoErpRpc(f)

    def test_file_list_without_index_still_lists(self):
        self.patch(w, "index_db_path", lambda: os.path.join(self.root, "없는색인.sqlite"))
        res, n = w.query_file_list({}, self.scope, self.root)
        self.assertEqual(n, 2)
        self.assertTrue(all(r["문서"] is None and r["읽기"] == "준비 중" for r in res["목록"]))

    def test_doc_table_refuses_a_file_changed_after_indexing(self):
        """색인 뒤에 바뀐 파일은 다시 검사받기 전까지 표로 내주지 않는다(주민번호가 새로 들어갔을 수 있다)."""
        f = self.prep()
        doc = next(r["문서"] for r in w.query_index_status({}, self.scope)[0]["목록"] if r["이름"] == "단가.csv")
        p = os.path.join(self.root, "부서", "5200_구매팀", "AI저장", "2026", "단가.csv")
        with io.open(p, "a", encoding="utf-8") as fh:
            fh.write("\n담당,900101-1234567")
        res, n = w.query_doc_table({"doc": doc}, self.scope, self.root)
        self.assertEqual((res["행"], n), ([], 0))
        self.assertIn("다시 확인하는 중", res["사유"])
        self.assertTrue(w._INDEX_WAKE.is_set(), "바로 다시 색인하도록 깨운다")
        w._INDEX_WAKE.clear()
        con = w.nas_index.connect(w.index_db_path())
        try:
            w.nas_index.refresh(con, self.root, [{"key": "pur", "rel_path": "부서/5200_구매팀", "label": "구매팀"}])
        finally:
            con.close()
        again, _ = w.query_doc_table({"doc": doc}, self.scope, self.root)
        self.assertEqual(again["행"], [])
        self.assertTrue(again["사유"], "다시 색인된 뒤에도 내주지 않는다(옛 번호는 없어지고, 새 번호는 민감 사유로 막힌다)")
        st = {r["이름"]: r for r in w.query_index_status({}, self.scope)[0]["목록"]}["단가.csv"]
        self.assertEqual((st["상태"], st["사유"]), ("못 읽음", "민감 정보 꼴(주민등록번호) 포함"))


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


class TurnHistoryKoreanTime(Base):
    """과거 대화의 일시는 한국시간으로 보여 주고, 기간 조건도 한국 날짜로 건다(N-2 · 적재 파일은 UTC)."""

    def setUp(self):
        super().setUp()
        d = os.path.join(self.root, "대화기록", "agent_turn", "2026")
        os.makedirs(d)
        rows = [
            {"id": 1, "upn": "me@jeilm.co.kr", "agent_key": "purchase", "created_at": "2026-09-30T06:03:23.007752+00:00", "question": "미입고", "answer": "가"},
            {"id": 2, "upn": "me@jeilm.co.kr", "agent_key": "purchase", "created_at": "2026-09-30T16:30:00+00:00", "question": "자정 넘김", "answer": "나"},
            {"id": 3, "upn": "me@jeilm.co.kr", "agent_key": "purchase", "created_at": "깨진값", "question": "깨진 시각", "answer": "다"},
            {"id": 4, "upn": "me@jeilm.co.kr", "agent_key": "purchase", "created_at": "2026-09-30T07:00:00+00:00", "question": "회귀 문항", "answer": "라", "golden_run_id": 2},
        ]
        with io.open(os.path.join(d, "agent_turn_2026-10-01_000000.jsonl"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(json.dumps(r, ensure_ascii=False) for r in rows))

    def test_shows_korean_time(self):
        res, _ = w.query_turn_history({}, {"upn": "me@jeilm.co.kr"}, self.root)
        by = {x["턴번호"]: x["일시"] for x in res["목록"]}
        self.assertEqual(by[1], "2026-09-30 15:03")
        self.assertEqual(by[2], "2026-10-01 01:30")      # UTC 로는 9월 30일이지만 한국에서는 10월 1일
        self.assertEqual(by[3], "깨진값")                  # 못 읽는 값은 그대로 — 지어내지 않는다
        self.assertNotIn(4, by)                           # 자동 회귀 턴은 「내 대화」가 아니다

    def test_date_filter_uses_korean_day(self):
        res, _ = w.query_turn_history({"date_from": "2026-10-01", "date_to": "2026-10-01"}, {"upn": "me@jeilm.co.kr"}, self.root)
        self.assertEqual([x["턴번호"] for x in res["목록"]], [2])
        res, _ = w.query_turn_history({"date_to": "2026-09-30"}, {"upn": "me@jeilm.co.kr"}, self.root)
        self.assertEqual([x["턴번호"] for x in res["목록"]], [1])


class SaveToDeptFolder(Base):
    """부서 폴더 저장(REQ-0108 · SQL 89) — 폴더 밖으로 쓰지 않는다 · 받은 내용이 다르면 쓰지 않는다 · 실패를 방치하지 않는다."""

    def setUp(self):
        super().setUp()
        self.folder = os.path.join(self.root, "부서", "4300_구매팀")
        os.makedirs(self.folder)
        self.data = "발주번호,금액\nPO1,1000\n".encode("utf-8")

    def job(self, **over):
        j = {"save_id": "11111111-2222-3333-4444-555555555555", "kind": "attachment", "file_name": "검토 자료.csv",
             "size_bytes": len(self.data), "sha256": hashlib.sha256(self.data).hexdigest(),
             "folder_key": "pur_team", "folder_rel": "부서/4300_구매팀", "saved_on": "2026-10-06"}
        j.update(over)
        return j

    def run_save(self, job, data=None):
        f = self.use({"nas_save_finish": {"ok": True}})
        ok = w.handle_save("u", "k", job, self.root, "wk", fetch=lambda *a: self.data if data is None else data)
        return ok, f

    def test_writes_under_ai_folder_and_reports_relative_path(self):
        ok, f = self.run_save(self.job())
        self.assertTrue(ok)
        fin = f.last("nas_save_finish")
        self.assertEqual(fin["p_status"], "done")
        self.assertEqual(fin["p_rel_path"], "AI저장/2026/검토 자료.csv")
        with open(os.path.join(self.folder, "AI저장", "2026", "검토 자료.csv"), "rb") as fh:
            self.assertEqual(fh.read(), self.data)
        self.assertNotIn(self.root, json.dumps(f.calls, ensure_ascii=False))     # 절대 경로가 밖으로 나가지 않는다
        self.assertNoErpRpc(f)

    def test_same_name_gets_suffix_not_overwrite(self):
        self.run_save(self.job())
        ok, f = self.run_save(self.job())
        self.assertTrue(ok)
        self.assertEqual(f.last("nas_save_finish")["p_rel_path"], "AI저장/2026/검토 자료_2.csv")
        self.assertEqual(sorted(os.listdir(os.path.join(self.folder, "AI저장", "2026"))), ["검토 자료.csv", "검토 자료_2.csv"])

    def test_hash_or_size_mismatch_writes_nothing(self):
        for bad in (self.job(sha256="0" * 64), self.job(size_bytes=len(self.data) + 1)):
            ok, f = self.run_save(bad)
            self.assertFalse(ok)
            self.assertEqual(f.last("nas_save_finish")["p_status"], "failed")
        self.assertFalse(os.path.exists(os.path.join(self.folder, "AI저장")) and os.listdir(os.path.join(self.folder, "AI저장", "2026")))

    def test_folder_escape_and_unknown_folder_are_refused(self):
        outside = os.path.join(self.root, "밖")
        os.makedirs(outside)
        for rel in ("../밖", "부서/../밖", "", "부서/없는팀", "/"):
            ok, f = self.run_save(self.job(folder_rel=rel))
            self.assertFalse(ok, rel)
            self.assertEqual(f.last("nas_save_finish")["p_status"], "failed")
        self.assertEqual(os.listdir(outside), [])

    def test_file_name_cannot_carry_a_path(self):
        ok, f = self.run_save(self.job(file_name="..\\..\\밖\\x.csv"))
        self.assertTrue(ok)
        rel = f.last("nas_save_finish")["p_rel_path"]
        self.assertTrue(rel.startswith("AI저장/2026/"))
        self.assertNotIn("..", rel.split("/")[-1].replace(" ", "")[:2])
        self.assertEqual(len(os.listdir(os.path.join(self.folder, "AI저장", "2026"))), 1)

    def test_sensitive_name_is_refused(self):
        ok, f = self.run_save(self.job(file_name="2026 급여대장.xlsx"))
        self.assertFalse(ok)
        self.assertIn("민감", f.last("nas_save_finish")["p_error"])

    def test_no_docs_root_fails_cleanly(self):
        f = self.use({"nas_save_finish": {"ok": True}})
        self.assertFalse(w.handle_save("u", "k", self.job(), None, "wk", fetch=lambda *a: self.data))
        self.assertEqual(f.last("nas_save_finish")["p_status"], "failed")

    def test_fetch_error_leaves_no_temp_file(self):
        def boom(*a):
            raise RuntimeError("HTTP 404 내려받기 실패")
        f = self.use({"nas_save_finish": {"ok": True}})
        self.assertFalse(w.handle_save("u", "k", self.job(), self.root, "wk", fetch=boom))
        self.assertEqual(f.last("nas_save_finish")["p_status"], "failed")
        left = [n for _, _, fs in os.walk(self.folder) for n in fs]
        self.assertEqual(left, [])

    def test_save_wakes_index_loop(self):
        w._INDEX_WAKE.clear()
        self.addCleanup(w._INDEX_WAKE.clear)
        ok, _ = self.run_save(self.job())
        self.assertTrue(ok)
        self.assertTrue(w._INDEX_WAKE.is_set())          # 저장한 문서가 10분을 기다리지 않고 색인된다
        w._INDEX_WAKE.clear()
        ok, _ = self.run_save(self.job(sha256="0" * 64))
        self.assertFalse(ok)
        self.assertFalse(w._INDEX_WAKE.is_set())         # 실패한 저장은 깨우지 않는다

    def test_save_loop_claims_and_handles(self):
        self.patch(w, "nas_docs_root", lambda: self.root)
        self.patch(w, "fetch_save_bytes", lambda *a: self.data)
        self.patch(w.time, "sleep", lambda s: None)
        f = self.use({"nas_work_claim": [self.job(), None], "nas_save_finish": {"ok": True}})
        w.save_loop("u", "k", "wk", rounds=2)
        self.assertEqual(f.fns().count("nas_work_claim"), 2)
        self.assertEqual(f.last("nas_save_finish")["p_status"], "done")
        self.assertNoErpRpc(f)

    def test_user_folder_goes_under_ai_folder(self):
        ok, f = self.run_save(self.job(subdir="견적서"))
        self.assertTrue(ok)
        self.assertEqual(f.last("nas_save_finish")["p_rel_path"], "AI저장/견적서/검토 자료.csv")
        self.assertTrue(os.path.isfile(os.path.join(self.folder, "AI저장", "견적서", "검토 자료.csv")))

    def test_bad_user_folder_is_refused(self):
        for bad in ("../밖", "a/b", "2026", " 앞공백", "급여자료", ".숨김", "끝점."):
            ok, f = self.run_save(self.job(subdir=bad))
            self.assertFalse(ok, bad)
            self.assertEqual(f.last("nas_save_finish")["p_status"], "failed")
        self.assertFalse(os.path.exists(os.path.join(self.root, "밖")))

    def test_fetch_uploads_saved_file_only(self):
        self.run_save(self.job())
        sent = []
        f = self.use({"nas_fetch_finish": {"ok": True}})
        job = {"job": "fetch", "fetch_id": "f1", "folder_key": "pur_team", "folder_rel": "부서/4300_구매팀",
               "rel_path": "AI저장/2026/검토 자료.csv"}
        self.assertTrue(w.handle_fetch("u", "k", job, self.root, "wk", put=lambda *a: sent.append(a[-1])))
        self.assertEqual(sent, [self.data])
        self.assertEqual(f.last("nas_fetch_finish")["p_status"], "done")
        # 「AI저장」 밖·없는 파일·폴더 탈출은 올리지 않는다
        keep = os.path.join(self.folder, "부서원 문서.txt")
        with open(keep, "w", encoding="utf-8") as fh:
            fh.write("내보내면 안 된다")
        for rel in ("부서원 문서.txt", "AI저장/../부서원 문서.txt", "AI저장/2026/없는파일.csv", ""):
            sent.clear()
            f = self.use({"nas_fetch_finish": {"ok": True}})
            self.assertFalse(w.handle_fetch("u", "k", dict(job, rel_path=rel), self.root, "wk", put=lambda *a: sent.append(a[-1])), rel)
            self.assertEqual(sent, [])
            self.assertEqual(f.last("nas_fetch_finish")["p_status"], "failed")

    def test_fetch_folder_file_images_only_inside_folder(self):
        dri = os.path.join(self.folder, "DRI", "1차")
        os.makedirs(dri)
        png = b"\x89PNG\r\n\x1a\n" + b"x" * 40
        for name, body in (("배치도.png", png), ("메모.txt", b"t"), ("급여표.png", png), (".숨김.png", png)):
            with open(os.path.join(dri, name), "wb") as fh:
                fh.write(body)
        other = os.path.join(self.root, "부서", "9999_다른팀")
        os.makedirs(other)
        with open(os.path.join(other, "남의도면.png"), "wb") as fh:
            fh.write(png)
        job = {"job": "fetch", "fetch_id": "f2", "folder_key": "pur_team", "folder_rel": "부서/4300_구매팀"}
        sent = []
        f = self.use({"nas_fetch_finish": {"ok": True}})
        self.assertTrue(w.handle_fetch("u", "k", dict(job, src_rel="DRI/1차/배치도.png"), self.root, "wk", put=lambda *a: sent.append(a[-1])))
        self.assertEqual(sent, [png])
        self.assertEqual(f.last("nas_fetch_finish")["p_status"], "done")
        for rel in ("DRI/1차/메모.txt", "DRI/1차/급여표.png", "DRI/1차/.숨김.png", "DRI/1차/없는파일.png",
                    "../9999_다른팀/남의도면.png", "DRI/../../9999_다른팀/남의도면.png", "DRI/1차", ""):
            sent.clear()
            f = self.use({"nas_fetch_finish": {"ok": True}})
            self.assertFalse(w.handle_fetch("u", "k", dict(job, src_rel=rel, rel_path="AI저장/x") if rel == "" else dict(job, src_rel=rel),
                                            self.root, "wk", put=lambda *a: sent.append(a[-1])), rel)
            self.assertEqual(sent, [], rel)
            self.assertEqual(f.last("nas_fetch_finish")["p_status"], "failed")

    def test_work_loop_dispatches_fetch_and_purge(self):
        self.patch(w, "nas_docs_root", lambda: self.root)
        self.patch(w.time, "sleep", lambda s: None)
        calls = []
        self.patch(w, "handle_fetch", lambda *a, **k: calls.append("fetch"))
        self.patch(w, "purge_saved", lambda *a, **k: calls.append("purge") or 1)
        self.patch(w, "handle_save", lambda *a, **k: calls.append("save"))
        self.use({"nas_work_claim": [{"job": "fetch", "fetch_id": "f"}, {"job": "purge"}, self.job(), None]})
        w.save_loop("u", "k", "wk", rounds=4)
        self.assertEqual(calls, ["fetch", "purge", "save"])

    def test_purge_removes_empty_folder_and_wakes_index(self):
        self.run_save(self.job(subdir="견적서"))
        w._INDEX_WAKE.clear()
        self.addCleanup(w._INDEX_WAKE.clear)
        rows = [{"save_id": "a", "folder_key": "pur_team", "folder_rel": "부서/4300_구매팀", "rel_path": "AI저장/견적서/검토 자료.csv"}]
        self.use({"nas_save_purge_list": [rows], "nas_save_purged": {"ok": True}})
        self.assertEqual(w.purge_saved("u", "k", self.root), 1)
        self.assertFalse(os.path.exists(os.path.join(self.folder, "AI저장", "견적서")))     # 빈 폴더는 함께 정리
        self.assertTrue(os.path.isdir(os.path.join(self.folder, "AI저장")))
        self.assertTrue(w._INDEX_WAKE.is_set())

    def test_purge_deletes_only_inside_ai_folder(self):
        self.run_save(self.job())
        keep = os.path.join(self.folder, "부서원이 올린 문서.txt")
        with open(keep, "w", encoding="utf-8") as fh:
            fh.write("지우면 안 된다")
        rows = [
            {"save_id": "a", "folder_key": "pur_team", "folder_rel": "부서/4300_구매팀", "rel_path": "AI저장/2026/검토 자료.csv"},
            {"save_id": "b", "folder_key": "pur_team", "folder_rel": "부서/4300_구매팀", "rel_path": "부서원이 올린 문서.txt"},
            {"save_id": "c", "folder_key": "pur_team", "folder_rel": "부서/4300_구매팀", "rel_path": "AI저장/../부서원이 올린 문서.txt"},
            {"save_id": "d", "folder_key": "pur_team", "folder_rel": "부서/4300_구매팀", "rel_path": "AI저장/2026/이미 없는 파일.csv"},
        ]
        f = self.use({"nas_save_purge_list": [rows], "nas_save_purged": {"ok": True}})
        self.assertEqual(w.purge_saved("u", "k", self.root), 2)
        res = {p["p_save_id"]: p["p_ok"] for p in f.payloads("nas_save_purged")}
        self.assertEqual(res, {"a": True, "b": False, "c": False, "d": True})
        self.assertFalse(os.path.exists(os.path.join(self.folder, "AI저장", "2026", "검토 자료.csv")))
        self.assertTrue(os.path.exists(keep))


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    unittest.main(verbosity=2)
