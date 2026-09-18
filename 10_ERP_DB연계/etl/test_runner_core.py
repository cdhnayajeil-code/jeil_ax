# -*- coding: utf-8 -*-
"""test_runner_core.py — 연동 러너(REQ-0046) 단위 테스트(헤드리스, 외부 접속 없음).

    python -m unittest test_runner_core -v

실제 릴레이·ETL·퇴사 처리는 **절대** 돌리지 않는다 — 자식 작업은 noop 이거나 테스트용 스크립트이고,
etl_watch 테스트는 rpc·run_job·수집기·퇴사 축 함수를 전부 가짜로 바꿔 끼운다.
"""
import datetime as dt
import importlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import runner_core as core  # noqa: E402
import jeil_runner  # noqa: E402


def _tmp(testcase):
    d = tempfile.mkdtemp(prefix="runner_test_")
    testcase.addCleanup(shutil.rmtree, d, True)
    return d


def _wait(pred, timeout=30, step=0.1):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(step)
    return pred()


class TestConfig(unittest.TestCase):
    def test_normalize_fills_defaults_and_drops_bad_jobs(self):
        cfg, warns = core.normalize_config({
            "paused": "yes", "log_keep_days": "x",
            "jobs": [
                {"id": "a", "kind": "relay_queue", "schedule": {"type": "interval", "seconds": 5}},
                {"id": "a", "kind": "relay_queue"},                       # 중복 ID
                {"id": "b", "kind": "nope"},                              # 모르는 kind
                {"id": "c", "kind": "etl_batch", "schedule": {"type": "daily", "time": "25:99"}},
                "garbage",
            ]})
        self.assertTrue(cfg["paused"])
        self.assertEqual(cfg["log_keep_days"], 30)
        self.assertEqual([j["id"] for j in cfg["jobs"]], ["a", "c"])
        self.assertEqual(cfg["jobs"][0]["schedule"]["seconds"], 10)      # 최소 10초
        self.assertEqual(cfg["jobs"][1]["schedule"], {"type": "daily", "time": "02:00"})
        self.assertEqual(cfg["jobs"][0]["timeout_min"], core.JOB_KINDS["relay_queue"]["timeout_min"])
        self.assertTrue(any("중복" in w for w in warns))
        self.assertTrue(any("시각" in w for w in warns))

    def test_bad_job_ids_rejected(self):
        ids = ["..\\..\\x", "C:\\ProgramData\\x", "a/b", "CON", "lpt1", "a" * 41, "", "ok_id-1"]
        cfg, warns = core.normalize_config({"jobs": [{"id": i, "kind": "noop"} for i in ids]})
        self.assertEqual([j["id"] for j in cfg["jobs"]], ["ok_id-1"])
        self.assertGreaterEqual(sum("ID 형식" in w for w in warns), 6)

    def test_unknown_params_dropped(self):
        cfg, warns = core.normalize_config({"jobs": [
            {"id": "r", "kind": "relay_queue", "params": {"max": 3, "webhook": "https://secret"}}]})
        self.assertEqual(cfg["jobs"][0]["params"], {"max": 3})
        self.assertTrue(any("webhook" in w for w in warns))

    def test_timeout_normalized(self):
        cfg, warns = core.normalize_config({"jobs": [
            {"id": "a", "kind": "noop", "timeout_min": "abc"},
            {"id": "b", "kind": "noop", "timeout_min": 0},
            {"id": "c", "kind": "noop", "timeout_min": 99999}]})
        self.assertEqual([j["timeout_min"] for j in cfg["jobs"]], [core.JOB_KINDS["noop"]["timeout_min"], 1, 1440])
        self.assertTrue(any("시간 상한" in w for w in warns))

    def test_empty_job_list_stays_empty(self):
        cfg, warns = core.normalize_config({"paused": False, "jobs": []})
        self.assertEqual(cfg["jobs"], [], "사람이 모두 지웠으면 기본값을 켜진 채 되살리지 않는다")
        self.assertFalse(cfg["paused"])
        self.assertTrue(any("작업이 없습니다" in w for w in warns))

    def test_all_invalid_jobs_load_defaults_disabled_and_paused(self):
        for raw in ({"paused": False, "jobs": [{"id": "x", "kind": "nope"}]}, [], {"paused": False}, {"jobs": "x"}):
            cfg, warns = core.normalize_config(raw)
            self.assertTrue(cfg["paused"], raw)
            self.assertEqual([j["id"] for j in cfg["jobs"]], ["relay_queue", "etl_sync", "etl_nightly"])
            self.assertFalse(any(j["enabled"] for j in cfg["jobs"]), "기본 작업은 꺼진 상태로")
        self.assertFalse(core.DEFAULT_JOBS[1]["params"]["allow_sensitive"], "급여 요청 처리는 기본 해제")

    def test_missing_default_jobs(self):
        got = core.missing_default_jobs({"jobs": [{"id": "relay_queue"}]})
        self.assertEqual([j["id"] for j in got], ["etl_sync", "etl_nightly"])
        self.assertFalse(any(j["enabled"] for j in got))

    def test_load_creates_file_and_roundtrip(self):
        p = core.Paths(_tmp(self))
        cfg, warns = core.load_config(p)
        self.assertTrue(os.path.exists(p.config))
        self.assertTrue(any("기본값" in w for w in warns))
        cfg["paused"] = True
        core.save_config(p, cfg)
        cfg2, _ = core.load_config(p)
        self.assertTrue(cfg2["paused"])
        self.assertFalse(os.path.exists(p.config + ".tmp"))

    def test_corrupt_config_is_backed_up_and_starts_paused(self):
        d = _tmp(self)
        p = core.Paths(d)
        with io.open(p.config, "w", encoding="utf-8") as f:
            f.write('{"jobs": [ {"id": "x", ')                           # 쉼표 빠진 손편집
        cfg, warns = core.load_config(p)
        self.assertTrue(cfg["paused"], "읽기 실패는 일시정지로 시작")
        self.assertFalse(any(j["enabled"] for j in cfg["jobs"]))
        backups = [n for n in os.listdir(d) if n.startswith(core.CONFIG_NAME + ".bad-")]
        self.assertEqual(len(backups), 1, "원본 보존")
        with io.open(os.path.join(d, backups[0]), encoding="utf-8") as f:
            self.assertIn('"id": "x"', f.read())
        self.assertTrue(any("일시정지" in w for w in warns))

    def test_dropped_jobs_are_backed_up_on_load(self):
        d = _tmp(self)
        p = core.Paths(d)
        core.save_config(p, {"jobs": [{"id": "ok", "kind": "noop"}, {"id": "bad", "kind": "renamed_kind"}]})
        cfg, warns = core.load_config(p)
        self.assertEqual([j["id"] for j in cfg["jobs"]], ["ok"])
        self.assertEqual(len([n for n in os.listdir(d) if n.startswith(core.CONFIG_NAME + ".bak-")]), 1)


class TestSchedule(unittest.TestCase):
    def test_interval(self):
        t = dt.datetime(2026, 9, 11, 15, 0, 0)
        self.assertEqual(core.compute_next({"type": "interval", "seconds": 60}, t), t + dt.timedelta(seconds=60))

    def test_daily_today_or_tomorrow(self):
        sch = {"type": "daily", "time": "02:00"}
        self.assertEqual(core.compute_next(sch, dt.datetime(2026, 9, 11, 1, 30)), dt.datetime(2026, 9, 11, 2, 0))
        self.assertEqual(core.compute_next(sch, dt.datetime(2026, 9, 11, 2, 0)), dt.datetime(2026, 9, 12, 2, 0))
        self.assertEqual(core.compute_next(sch, dt.datetime(2026, 9, 11, 23, 59)), dt.datetime(2026, 9, 12, 2, 0))

    def test_label(self):
        self.assertEqual(core.schedule_label({"type": "interval", "seconds": 60}), "반복 1분")
        self.assertEqual(core.schedule_label({"type": "interval", "seconds": 45}), "반복 45초")
        self.assertEqual(core.schedule_label({"type": "daily", "time": "02:00"}), "매일 02:00")


class TestParams(unittest.TestCase):
    CAPS_NONE = {"ms_account": False, "gw_account": False, "offboard": False, "supabase": True}

    def test_offboard_on_cannot_exceed_caps(self):
        for o in ("on", True, "auto"):
            p = core.resolve_params({"kind": "etl_sync", "params": {"offboard": o}}, self.CAPS_NONE)
            self.assertFalse(p["offboard"], "능력이 없으면 「포함」도 꺼진다: %r" % (o,))
        caps = dict(self.CAPS_NONE, offboard=True)
        self.assertTrue(core.resolve_params({"kind": "etl_sync", "params": {"offboard": "auto"}}, caps)["offboard"])
        self.assertFalse(core.resolve_params({"kind": "etl_sync", "params": {"offboard": "off"}}, caps)["offboard"])
        notes = core.param_warnings({"kind": "etl_sync", "params": {"offboard": "on"}}, self.CAPS_NONE)
        self.assertTrue(any("퇴사 처리" in n for n in notes))

    def test_collectors_follow_each_capability(self):
        caps = dict(self.CAPS_NONE, ms_account=True)
        self.assertEqual(core.resolve_params({"kind": "etl_sync", "params": {}}, caps)["collectors"], ["ms_account"])
        self.assertEqual(core.resolve_params({"kind": "etl_sync", "params": {"collectors": "on"}}, caps)["collectors"], ["ms_account"])
        self.assertEqual(core.resolve_params({"kind": "etl_sync", "params": {"collectors": "off"}}, caps)["collectors"], [])
        self.assertEqual(core.resolve_params({"kind": "etl_sync", "params": {}}, self.CAPS_NONE)["collectors"], [])

    def test_params_are_whitelisted_per_kind(self):
        p = core.resolve_params({"kind": "etl_sync", "params": {"dry_run": True, "webhook": "x"}}, self.CAPS_NONE)
        self.assertEqual(set(p), {"collectors", "offboard", "full", "allow_sensitive"}, "etl_sync 에는 dry_run 이 없다")
        self.assertFalse(p["allow_sensitive"])
        n = core.resolve_params({"kind": "noop", "params": {"lines": 99999, "sleep": 99, "x": 1}}, {})
        self.assertEqual(n, {"lines": 1000, "sleep": 10.0, "rc": 0})
        b = core.resolve_params({"kind": "etl_batch", "params": {"jobs": ["dept_master", "../x"]}}, {})
        self.assertEqual(b["jobs"], ["dept_master"])

    def test_relay_max_clamped(self):
        self.assertEqual(core.resolve_params({"kind": "relay_queue", "params": {"max": 999}}, {})["max"], 50)
        self.assertEqual(core.resolve_params({"kind": "relay_queue", "params": {"max": "x"}}, {})["max"], 5)

    def test_env_file_parse(self):
        d = _tmp(self)
        with io.open(os.path.join(d, ".env"), "w", encoding="utf-8") as f:
            f.write("\ufeffSUPABASE_URL = https://x.example\nSUPABASE_SERVICE_ROLE_KEY=abc # 주석\n# c\nBAD\n")
        with io.open(os.path.join(d, ".env.local"), "w", encoding="utf-8") as f:
            f.write("gw url: https://gw.example\nGW-ID = u\n")
        env = core._read_env_file(os.path.join(d, ".env"))
        self.assertEqual(env["SUPABASE_URL"], "https://x.example")
        self.assertEqual(env["SUPABASE_SERVICE_ROLE_KEY"], "abc")
        loc = core._read_env_file(os.path.join(d, ".env.local"), normalize=True)
        self.assertEqual(loc["GW_URL"], "https://gw.example")
        self.assertEqual(loc["GW_ID"], "u")

    def test_detect_capabilities_does_not_touch_environ(self):
        d = _tmp(self)
        key = "JEIL_RUNNER_TEST_ONLY_KEY_7Q"
        with io.open(os.path.join(d, ".env"), "w", encoding="utf-8") as f:
            f.write("%s = 1\nSUPABASE_URL = https://x\nSUPABASE_SERVICE_ROLE_KEY = y\n" % key)
        before = dict(os.environ)
        caps = core.detect_capabilities(d)
        self.assertNotIn(key, os.environ, "부모 러너 환경에 .env 값을 넣지 않는다")
        self.assertEqual(dict(os.environ), before)
        self.assertTrue(caps["supabase"])
        self.assertEqual(caps["env_state"], "ok")
        self.assertEqual(core.detect_capabilities(_tmp(self))["env_state"], "missing")


class TestHistoryAndPaths(unittest.TestCase):
    def test_append_read_aggregate_trim(self):
        p = core.Paths(_tmp(self))
        p.ensure()
        for i in range(5):
            core.append_history(p, {"job": "x", "secs": 2.0, "status": "성공", "start": "2026-09-11T10:00:0%d" % i})
        core.append_history(p, {"job": "y", "secs": 4.0, "status": "실패"})
        rows = core.read_history(p)
        self.assertEqual(len(rows), 6)
        agg = core.aggregate_history(rows)
        self.assertEqual(agg["x"]["total_exec"], 5)
        self.assertAlmostEqual(agg["x"]["total_secs"], 10.0)
        self.assertEqual(agg["y"]["last"]["status"], "실패")
        self.assertEqual(core.trim_history(p, 100), 0)               # 여유 있으면 손대지 않음
        for _ in range(200):
            core.append_history(p, {"job": "z"})
        self.assertEqual(core.trim_history(p, 100), 106)
        self.assertEqual(len(core.read_history(p)), 100)

    def test_read_history_tail_only(self):
        p = core.Paths(_tmp(self))
        p.ensure()
        with io.open(p.history, "w", encoding="utf-8") as f:
            for i in range(5000):
                f.write(json.dumps({"job": "j", "i": i}) + "\n")
        rows = core.read_history(p, 10, max_bytes=2000)                # 앞부분은 읽지 않는다
        self.assertEqual([r["i"] for r in rows], list(range(4990, 5000)))

    def test_last_meaningful_line_skips_runner_marks(self):
        d = _tmp(self)
        f = os.path.join(d, "a.log")
        with io.open(f, "w", encoding="utf-8") as h:
            h.write("===== head =====\n[runner] params={}\n진짜 마지막 줄\n[runner] 종료 exit=0\n")
        self.assertEqual(core._last_meaningful_line(f), "진짜 마지막 줄")
        self.assertIn("진짜", core.tail_text(f))

    def test_prune_run_logs(self):
        p = core.Paths(_tmp(self))
        p.ensure()
        old = os.path.join(p.runs, "j", "old.log")
        new = os.path.join(p.runs, "j", "new.log")
        os.makedirs(os.path.dirname(old))
        for f in (old, new):
            io.open(f, "w").close()
        past = time.time() - 40 * 86400
        os.utime(old, (past, past))
        self.assertEqual(core.prune_run_logs(p, 30), 1)
        self.assertFalse(os.path.exists(old))
        self.assertTrue(os.path.exists(new))

    def test_safe_log_path(self):
        d = _tmp(self)
        p = core.Paths(d)
        p.ensure()
        inside = os.path.join(p.runs, "j", "a.log")
        os.makedirs(os.path.dirname(inside))
        io.open(inside, "w").close()
        txt = os.path.join(p.runs, "j", "a.cmd")
        io.open(txt, "w").close()
        outside = os.path.join(d, "x.log")
        io.open(outside, "w").close()
        self.assertEqual(os.path.normcase(core.safe_log_path(p, inside)), os.path.normcase(os.path.realpath(inside)))
        self.assertIsNone(core.safe_log_path(p, txt), "확장자가 .log 가 아니면 거부")
        self.assertIsNone(core.safe_log_path(p, outside), "runs 밖이면 거부")
        self.assertIsNone(core.safe_log_path(p, os.path.join(p.runs, "..", "..", "x.log")))
        self.assertIsNone(core.safe_log_path(p, "Z:\\nowhere\\x.log"))
        self.assertIsNone(core.safe_log_path(p, None))
        self.assertIsNone(core.safe_log_path(p, 123))


class TestSingleInstance(unittest.TestCase):
    def _probe(self, root):
        code = ("import sys; sys.path.insert(0, %r); import runner_core as c; "
                "print(c.acquire_single_instance(sys.argv[1], name=None))" % HERE)
        return subprocess.run([sys.executable, "-c", code, root], capture_output=True, text=True, timeout=60).stdout.strip()

    def test_root_lock_blocks_second_process(self):
        d = _tmp(self)
        self.assertTrue(core.acquire_single_instance(d, name=None))
        self.addCleanup(core.release_single_instance)
        self.assertEqual(self._probe(d), "False", "같은 루트의 두 번째 러너는 뜨지 않는다(세션과 무관)")
        core.release_single_instance()
        self.assertEqual(self._probe(d), "True", "앞 러너가 끝나면 다시 뜬다")


# ─────────────────────────────── 엔진(실제 자식 프로세스) ───────────────────────────────
GRANDCHILD = r'''
import sys, time, io
log = sys.argv[1]
for i in range(600):
    with io.open(log, "a", encoding="utf-8") as f:
        f.write("grandchild tick %d\n" % i)
    time.sleep(0.05)
'''
PARENT = r'''
import subprocess, sys
# onefile 부트로더 흉내 — 실제 일은 손자가 하고 부모는 기다리기만 한다
child = subprocess.Popen([sys.executable, sys.argv[1], sys.argv[2]])
child.wait()
'''
IDLE = r'''
import sys
sys.stdout.reconfigure(encoding="utf-8")
print("대기 요청 없음")
'''


class TestEngine(unittest.TestCase):
    """실제 자식 프로세스를 띄워 본다 — noop 은 jeil_runner.py --job … , 트리 종료는 테스트 스크립트."""

    def setUp(self):
        self.d = _tmp(self)
        self.logs = []
        self.scripts = {}
        for name, body in (("grandchild", GRANDCHILD), ("parent", PARENT), ("idle", IDLE)):
            path = os.path.join(self.d, "_%s.py" % name)
            with io.open(path, "w", encoding="utf-8") as f:
                f.write(body)
            self.scripts[name] = path
        self.engine = None

    def tearDown(self):
        if self.engine:
            self.engine.stop()

    def make(self, jobs, paused=True, builder=None):
        p = core.Paths(self.d)
        p.ensure()
        core.save_config(p, {"paused": paused, "jobs": jobs})
        self.engine = core.RunnerEngine(self.d, builder or jeil_runner.build_child_argv, self.logs.append)
        return self.engine

    def row(self, jid):
        return [r for r in self.engine.snapshot()["jobs"] if r["id"] == jid][0]

    def wait_done(self, jid, timeout=30):
        box = {}

        def done():
            # 스냅샷 한 장으로 판정한다 — 두 번 따로 읽으면 그 사이 기동돼 「실행중」을 완료로 오인한다
            r = box["row"] = self.row(jid)
            return not r["running"] and r["result"] not in ("-", core.STATUS_RUNNING)
        ok = _wait(done, timeout)
        self.assertTrue(ok, "작업 %s 가 %d초 안에 끝나지 않음" % (jid, timeout))
        return box["row"]

    @staticmethod
    def noop(jid, enabled=True, **params):
        return {"id": jid, "kind": "noop", "name": jid, "enabled": enabled,
                "schedule": {"type": "interval", "seconds": 3600}, "params": params}

    def idle_builder(self, cfg, params, log_path, root):
        return [sys.executable, self.scripts["idle"]]

    def test_run_now_success_and_history(self):
        e = self.make([self.noop("n1", lines=2, sleep=0.05)])
        e.start()
        ok, msg = e.run_now("n1")
        self.assertTrue(ok, msg)
        row = self.wait_done("n1")
        self.assertEqual(row["result"], core.STATUS_OK)
        self.assertEqual(row["rc"], 0)
        self.assertIn("[noop] 완료", row["summary"])
        self.assertEqual(row["total_exec"], 1)
        text = core.tail_text(row["log"])
        self.assertIn("[runner] params=", text)
        self.assertIn("[noop] 진행 2/2", text)
        self.assertIn("[runner] 종료 exit=0", text)
        hist = e.history()
        self.assertEqual(hist[0]["job"], "n1")
        self.assertEqual(hist[0]["status"], core.STATUS_OK)
        self.assertFalse(hist[0]["idle"])
        self.assertEqual(core._read_json(e.paths.running), {}, "끝난 실행은 running 기록에서 빠진다")

    def test_failure_rc_recorded(self):
        e = self.make([self.noop("n2", enabled=False, lines=1, sleep=0.05, rc=3)])
        e.start()
        e.run_now("n2")                  # 사용안함이어도 수동 실행은 된다
        row = self.wait_done("n2")
        self.assertEqual(row["result"], core.STATUS_FAIL)
        self.assertEqual(row["rc"], 3)

    def test_child_refuses_log_outside_root(self):
        argv = jeil_runner.build_child_argv({"id": "x", "kind": "noop"}, {}, os.path.join(self.d, "evil.log"), self.d)
        self.assertEqual(jeil_runner.main(argv[argv.index("--job"):]), 2)
        self.assertFalse(os.path.exists(os.path.join(self.d, "evil.log")))

    def test_stop_kills_whole_process_tree(self):
        def builder(cfg, params, log_path, root):
            return [sys.executable, self.scripts["parent"], self.scripts["grandchild"], log_path]
        e = self.make([self.noop("t")], builder=builder)
        e.start()
        ok, msg = e.run_now("t")
        self.assertTrue(ok, msg)
        if os.name == "nt":
            self.assertIsNotNone(e.jobs["t"].job, "Windows 에서는 작업 개체에 넣어야 한다")
        log_path = self.row("t")["log"]
        self.assertTrue(_wait(lambda: "grandchild tick 5" in core.tail_text(log_path), 20), "손자가 시작되지 않음")
        e.stop_job("t")
        row = self.wait_done("t", 20)
        self.assertEqual(row["result"], core.STATUS_STOPPED)
        self.assertTrue(row["summary"].startswith("사용자 중지"))
        size1 = os.path.getsize(log_path)
        time.sleep(1.5)
        self.assertEqual(os.path.getsize(log_path), size1, "중지 뒤에도 손자 프로세스가 로그를 계속 쓴다")

    def test_stop_after_natural_exit_keeps_real_result(self):
        e = self.make([self.noop("q")], builder=self.idle_builder)      # 엔진 스레드를 돌리지 않는다
        ok, _ = e.run_now("q")
        self.assertTrue(ok)
        self.assertTrue(_wait(lambda: e.jobs["q"].proc.poll() is not None, 20))
        ok2, msg = e.stop_job("q")
        self.assertFalse(ok2)
        self.assertIn("이미 끝났", msg)
        e._tick()
        self.assertEqual(self.row("q")["result"], core.STATUS_OK, "스스로 끝난 실행을 「중지됨」으로 적지 않는다")

    def test_timeout_kills_and_marks_failure(self):
        e = self.make([self.noop("slow", lines=600, sleep=0.05)])
        e.start()
        e.run_now("slow")
        self.assertTrue(_wait(lambda: "진행 2/" in core.tail_text(self.row("slow")["log"] or ""), 20))
        st = e.jobs["slow"]
        st.cfg["timeout_min"] = 1
        st.run_start = dt.datetime.now() - dt.timedelta(minutes=2)
        row = self.wait_done("slow", 20)
        self.assertEqual(row["result"], core.STATUS_FAIL)
        self.assertTrue(row["summary"].startswith("시간 초과(1분)"), row["summary"])

    def test_engine_stop_records_interrupted_run(self):
        e = self.make([self.noop("long", lines=200, sleep=0.05)])
        e.start()
        e.run_now("long")
        self.assertTrue(_wait(lambda: "진행 3/" in core.tail_text(self.row("long")["log"] or ""), 20))
        e.stop()
        self.engine = None
        hist = core.read_history(core.Paths(self.d), 5)
        self.assertEqual(hist[-1]["job"], "long")
        self.assertEqual(hist[-1]["status"], core.STATUS_STOPPED)
        self.assertTrue(hist[-1]["summary"].startswith("러너 종료"))

    def test_crashed_runner_is_recorded_on_next_start(self):
        e = self.make([self.noop("long", lines=600, sleep=0.05)])
        e.start()
        e.run_now("long")
        self.assertTrue(_wait(lambda: "진행 2/" in core.tail_text(self.row("long")["log"] or ""), 20))
        # 로그오프·강제 종료 흉내 — _finish 없이 스케줄러만 멈추고 자식을 끝낸다
        e._stop.set()
        e._thread.join(5)
        st = e.jobs["long"]
        if st.job:
            st.job.terminate(1)
            st.proc.wait(10)
            st.job.close()
        else:
            st.proc.kill()
            st.proc.wait(10)
        self.engine = None
        self.assertIn("long", core._read_json(core.Paths(self.d).running))
        e2 = core.RunnerEngine(self.d, jeil_runner.build_child_argv, self.logs.append)
        self.engine = e2
        last = core.read_history(e2.paths, 5)[-1]
        self.assertEqual(last["job"], "long")
        self.assertEqual(last["status"], core.STATUS_STOPPED)
        self.assertIn("비정상 종료", last["summary"])
        self.assertEqual(core._read_json(e2.paths.running), {})
        self.assertEqual(self.row("long")["result"], core.STATUS_STOPPED)

    def test_update_config_keeps_running_job_that_was_removed(self):
        e = self.make([self.noop("keep", lines=200, sleep=0.05), self.noop("other")])
        e.start()
        e.run_now("keep")
        self.assertTrue(_wait(lambda: self.row("keep")["running"], 10))
        warns = e.update_config({"paused": True, "jobs": [self.noop("other")]})
        self.assertTrue(any("삭제를 보류" in w for w in warns))
        self.assertIn("keep", e.jobs)
        e.stop_job("keep")
        self.assertEqual(self.wait_done("keep", 20)["result"], core.STATUS_STOPPED)

    def test_update_config_keeps_state(self):
        e = self.make([self.noop("n1")])
        e.start()
        warns = e.update_config({"paused": True, "jobs": [
            {"id": "n1", "kind": "noop", "name": "이름변경", "enabled": True,
             "schedule": {"type": "daily", "time": "03:15"}, "params": {}}]})
        self.assertEqual(warns, [])
        snap = e.snapshot()
        self.assertEqual([r["id"] for r in snap["jobs"]], ["n1"])
        self.assertEqual(snap["jobs"][0]["type"], "매일 03:15")
        cfg, _ = core.load_config(e.paths)
        self.assertEqual(cfg["jobs"][0]["name"], "이름변경")

    def test_empty_job_list_runs_nothing(self):
        e = self.make([self.noop("a", lines=1)], paused=False)
        e.update_config({"paused": False, "jobs": []})
        self.assertEqual(e.jobs, {}, "모두 지우고 저장하면 기본 작업이 되살아나 돌지 않는다")
        e.start()
        time.sleep(2.0)
        self.assertEqual(core.read_history(e.paths), [])

    def test_scheduler_launches_when_due_and_respects_pause(self):
        e = self.make([self.noop("n1", lines=1, sleep=0.05)])
        e.jobs["n1"].next_run = dt.datetime.now()
        e.start()
        time.sleep(2.5)
        self.assertEqual(self.row("n1")["total_exec"], 0, "일시정지면 예약 실행 없음")
        e.set_paused(False)
        e.jobs["n1"].next_run = dt.datetime.now()
        row = self.wait_done("n1")
        self.assertEqual(row["result"], core.STATUS_OK)
        self.assertGreater(row["next"], dt.datetime.now() + dt.timedelta(seconds=3000))

    def test_resume_does_not_catch_up_missed_daily(self):
        e = self.make([{"id": "d", "kind": "noop", "name": "d", "enabled": True,
                        "schedule": {"type": "daily", "time": "02:00"}, "params": {"lines": 1}}])
        e.jobs["d"].next_run = dt.datetime.now() - dt.timedelta(hours=7)     # 일시정지 중 놓친 회차
        e.start()
        e.set_paused(False)
        self.assertGreater(e.jobs["d"].next_run, dt.datetime.now(), "재개 즉시 따라잡지 않는다")
        time.sleep(2.0)
        self.assertEqual(self.row("d")["total_exec"], 0)

    def test_idle_runs_keep_only_latest_log_and_hide_in_history(self):
        e = self.make([self.noop("idle")], builder=self.idle_builder)
        e.start()
        e.run_now("idle")
        first = self.wait_done("idle")
        self.assertTrue(first["idle"])
        first_log = first["log"]
        time.sleep(1.1)                  # 로그 파일명이 초 단위라 겹치지 않게
        e.run_now("idle")
        _wait(lambda: self.row("idle")["total_exec"] == 2, 20)
        second = self.row("idle")
        self.assertNotEqual(second["log"], first_log)
        self.assertFalse(os.path.exists(first_log), "앞선 idle 로그는 지운다")
        self.assertTrue(os.path.exists(second["log"]), "마지막 idle 로그는 남긴다")
        self.assertEqual(len(e.history(include_idle=True)), 2)
        self.assertEqual(e.history(include_idle=False), [])

    def test_idle_cleanup_never_deletes_outside_runs(self):
        p = core.Paths(self.d)
        p.ensure()
        victim = os.path.join(self.d, "victim.log")
        with io.open(victim, "w", encoding="utf-8") as f:
            f.write("keep me")
        core.append_history(p, {"job": "idle", "status": core.STATUS_OK, "summary": "대기 요청 없음",
                                "log": victim, "idle": True})               # 변조된 내역 한 줄
        e = self.make([self.noop("idle")], builder=self.idle_builder)
        e.start()
        e.run_now("idle")
        self.wait_done("idle")
        _wait(lambda: self.row("idle")["total_exec"] == 2, 10)
        self.assertTrue(os.path.exists(victim), "내역 파일의 경로를 믿고 runs 밖 파일을 지우면 안 된다")

    def test_launch_failure_does_not_block_other_jobs(self):
        def builder(cfg, params, log_path, root):
            if cfg["id"] == "bad":
                raise RuntimeError("boom")
            return jeil_runner.build_child_argv(cfg, params, log_path, root)
        e = self.make([self.noop("bad"), self.noop("good", lines=1, sleep=0.05)], paused=False, builder=builder)
        now = dt.datetime.now()
        e.jobs["bad"].next_run = now
        e.jobs["good"].next_run = now
        e.start()
        good = self.wait_done("good")
        self.assertEqual(good["result"], core.STATUS_OK)
        bad = self.row("bad")
        self.assertEqual(bad["result"], core.STATUS_FAIL)
        self.assertIn("boom", bad["summary"])
        self.assertGreater(bad["next"], dt.datetime.now() + dt.timedelta(seconds=3000), "매초 재시도하지 않는다")


class TestChildArgv(unittest.TestCase):
    def test_child_argv_shape(self):
        argv = jeil_runner.build_child_argv({"id": "x", "kind": "noop"}, {"a": 1}, "C:/l.log", "C:/root")
        self.assertEqual(argv[argv.index("--job") + 1], "x")
        self.assertEqual(json.loads(argv[argv.index("--params") + 1]), {"a": 1})
        self.assertEqual(argv[argv.index("--root") + 1], "C:/root")


# ─────────────────────────────── etl_watch(가짜 RPC) ───────────────────────────────
import etl_watch as w  # noqa: E402


class FakeRpc:
    def __init__(self, responses):
        self.calls = []
        self.responses = responses

    def __call__(self, url, key, fn, payload):
        self.calls.append((fn, payload))
        v = self.responses.get(fn)
        if isinstance(v, list):
            return v.pop(0) if v else None
        return v

    def fns(self):
        return [c[0] for c in self.calls]

    def last(self, fn):
        return [p for f, p in self.calls if f == fn][-1]


class TestEtlWatch(unittest.TestCase):
    def patch(self, obj, name, value):
        old = getattr(obj, name)
        setattr(obj, name, value)
        self.addCleanup(setattr, obj, name, old)

    def forbid(self, obj, name):
        def boom(*a, **k):
            raise AssertionError("%s 가 불리면 안 된다" % name)
        self.patch(obj, name, boom)

    def setUp(self):
        self.patch(w, "notify", lambda *a, **k: False)
        self.patch(w, "log", lambda *a, **k: None)

    # plan_targets
    def test_plan_default_on_workstation_is_unchanged(self):
        names, skipped = w.plan_targets(None, False, True, True)
        self.assertEqual(names, list(w.SAFE_JOBS) + list(w.COLLECTORS))
        self.assertEqual(skipped, [])

    def test_plan_server_without_collectors(self):
        names, skipped = w.plan_targets(None, False, [], False)
        self.assertEqual(names, list(w.SAFE_JOBS))
        self.assertEqual({n for n, _ in skipped}, set(w.COLLECTORS))

    def test_plan_explicit_collectors_only_request_on_server_runs_nothing(self):
        names, skipped = w.plan_targets(["ms_account", "gw_account"], False, [], False)
        self.assertEqual(names, [], "요청과 무관한 ERP 전체를 돌리지 않는다")
        self.assertEqual(len(skipped), 2)

    def test_plan_partial_collectors(self):
        names, skipped = w.plan_targets(None, False, ["ms_account"], True)
        self.assertIn("ms_account", names)
        self.assertNotIn("gw_account", names)
        self.assertEqual([n for n, _ in skipped], ["gw_account"])

    def test_plan_sensitive_needs_allow(self):
        if not w.SENSITIVE_JOBS:
            self.skipTest("민감 job 없음")
        names, skipped = w.plan_targets(None, True, True, False)
        self.assertFalse(set(w.SENSITIVE_JOBS) & set(names))
        self.assertTrue(set(w.SENSITIVE_JOBS) <= {n for n, _ in skipped})
        names2, _ = w.plan_targets(None, True, True, True)
        self.assertTrue(set(w.SENSITIVE_JOBS) <= set(names2))

    def test_plan_unknown_jobs_fall_back_to_default(self):
        names, _ = w.plan_targets(["no_such_job"], False, True, True)
        self.assertEqual(names, list(w.SAFE_JOBS) + list(w.COLLECTORS))

    def test_ping_note_flags(self):
        n = len(w.SAFE_JOBS)
        self.assertEqual(w._ping_note(True, True, True), "jobs=%d+acct2+offboard" % n, "관리자 PC 러너 메모는 종전과 같다")
        self.assertEqual(w._ping_note(False, [], False), "jobs=%d+acct0+nosens" % n)

    def test_redact_connection_details(self):
        s = w._redact("('28000', \"[Microsoft][ODBC Driver 17 for SQL Server][SQL Server]Login failed for user 'erp_ro_user'. "
                      "(18456)\") SERVER=10.20.30.40,1433;DATABASE=JEILMNS;UID=abc;PWD=xyz;")
        for leak in ("erp_ro_user", "10.20.30.40", "UID=abc", "PWD=xyz"):
            self.assertNotIn(leak, s)
        self.assertIn("18456", s, "오류 코드는 남긴다")

    # tick
    def test_tick_without_offboard_never_touches_offboard_queue(self):
        fake = FakeRpc({"erp_sync_request_claim": None})
        self.patch(w, "rpc", fake)
        self.forbid(w, "notify_due_schedules")
        res = w.tick("u", "k", "host", False, False, offboard=False, collectors=[], allow_sensitive=False)
        self.assertIs(res, False)
        self.assertNotIn("offboard_request_claim", fake.fns())
        self.assertEqual(fake.last("erp_sync_runner_ping")["p_note"], "jobs=%d+acct0+nosens" % len(w.SAFE_JOBS))

    def test_default_request_on_server_is_partial_failure_with_reason(self):
        fake = FakeRpc({"erp_sync_request_claim": {"request_id": "r1-aaaaaaaa", "jobs": [], "include_sensitive": False}})
        self.patch(w, "rpc", fake)
        self.patch(w, "run_job", lambda *a, **k: (1, 1))
        self.forbid(w, "run_collector")
        res = w.tick("u", "k", "srv", False, False, offboard=False, collectors=[], allow_sensitive=False)
        self.assertEqual(res, "failed", "계정 수집을 생략했으면 초록 「완료」로 닫지 않는다")
        fin = fake.last("erp_sync_request_finish")
        self.assertEqual(fin["p_status"], "failed")
        self.assertIn("생략 2종", fin["p_error"])
        self.assertEqual(fin["p_rows_upserted"], len(w.SAFE_JOBS), "ERP 데이터는 적재됐다")
        self.assertEqual(sum(1 for j in fin["p_result"]["jobs"] if j["status"] == "skipped"), 2)

    def test_explicit_collectors_request_on_server_fails_without_running(self):
        fake = FakeRpc({"erp_sync_request_claim": {"request_id": "r2-aaaaaaaa", "jobs": ["ms_account", "gw_account"],
                                                   "include_sensitive": False}})
        self.patch(w, "rpc", fake)
        self.forbid(w, "run_job")
        self.forbid(w, "run_collector")
        res = w.tick("u", "k", "srv", False, False, offboard=False, collectors=[], allow_sensitive=False)
        self.assertEqual(res, "failed")
        self.assertEqual(fake.last("erp_sync_request_finish")["p_status"], "failed")
        self.assertNotIn("erp_sync_request_progress", fake.fns())

    def test_sensitive_request_not_allowed_fails(self):
        if not w.SENSITIVE_JOBS:
            self.skipTest("민감 job 없음")
        fake = FakeRpc({"erp_sync_request_claim": {"request_id": "r3-aaaaaaaa", "jobs": None, "include_sensitive": True}})
        self.patch(w, "rpc", fake)
        ran = []
        self.patch(w, "run_job", lambda name, *a, **k: ran.append(name) or (1, 1))
        self.patch(w, "run_collector", lambda *a, **k: (1, 1))
        res = w.tick("u", "k", "srv", False, False, offboard=False, collectors=True, allow_sensitive=False)
        self.assertEqual(res, "failed", "관리자가 급여를 요청했는데 생략했으면 「완료」로 닫지 않는다")
        self.assertFalse(set(ran) & set(w.SENSITIVE_JOBS))

    def test_job_systemexit_is_contained(self):
        name = w.SAFE_JOBS[0]
        fake = FakeRpc({"erp_sync_request_claim": {"request_id": "r4-aaaaaaaa", "jobs": [name], "include_sensitive": False}})
        self.patch(w, "rpc", fake)

        def die(*a, **k):
            raise SystemExit("환경변수 ERP_DB_CONN 가 없습니다")
        self.patch(w, "run_job", die)
        res = w.tick("u", "k", "srv", False, False, offboard=False, collectors=True)
        self.assertEqual(res, "failed")
        fin = fake.last("erp_sync_request_finish")
        self.assertEqual(fin["p_status"], "failed")
        self.assertIn("ERP_DB_CONN", json.dumps(fin["p_result"], ensure_ascii=False))

    def _offboard_env(self, token_exc, mode):
        import offboard_axes as oa
        self.patch(w, "importlib", types.SimpleNamespace(reload=lambda m: m, import_module=importlib.import_module))
        self.patch(w, "notify_due_schedules", lambda *a, **k: None)

        def bad_token():
            raise token_exc
        self.patch(oa, "_token", bad_token)
        called = []

        def fake_axes(t, axes, apply=False, tok=None):
            called.append((list(axes), tok))
            return [{"ok": True, "axis": a, "msg": "ok"} for a in axes]
        self.patch(oa, "run_axes", fake_axes)
        fake = FakeRpc({"offboard_request_claim": {
            "request_id": "o1-aaaaaaaa", "mode": mode, "origin": "manual",
            "targets": [{"email": "a@x", "emp_nm": "가", "axes": ["erp", "gw", "ms"]}]}})
        self.patch(w, "rpc", fake)
        res = w.tick("u", "k", "ws", False, False, offboard=True, collectors=True)
        return res, called, fake.last("offboard_request_finish")

    def test_offboard_missing_graph_config_blocks_ms_and_erp_apply(self):
        res, called, fin = self._offboard_env(SystemExit("환경변수 ENTRA_CLIENT_ID 가 없습니다"), "apply")
        self.assertEqual(res, "failed")
        self.assertEqual([c[0] for c in called], [["gw"]], "접속정보가 없으면 MS 축·ERP 실제 적용은 실행하지 않는다")
        axes = fin["p_result"]["targets"][0]["axes"]
        self.assertEqual([x["axis"] for x in axes], ["erp", "gw", "ms"], "축 순서 유지")
        self.assertIn("Graph 접속정보 없음", axes[0]["msg"])

    def test_offboard_missing_graph_config_check_mode_still_checks_erp(self):
        res, called, fin = self._offboard_env(SystemExit("환경변수 ENTRA_CLIENT_ID 가 없습니다"), "check")
        self.assertEqual([c[0] for c in called], [["erp", "gw"]], "점검 모드의 ERP 축은 토큰 없이 판정한다")

    def test_offboard_transient_token_error_retries_per_axis(self):
        res, called, fin = self._offboard_env(RuntimeError("HTTP Error 503"), "apply")
        self.assertEqual(res, "done", "일시 오류 한 번으로 축을 일괄 실패시키지 않는다")
        self.assertEqual(called, [(["erp", "gw", "ms"], None)], "토큰 없이 넘겨 축마다 다시 받게 한다")
        self.assertEqual(fin["p_status"], "done")

    def _offboard_with_axes(self, axr, collect=None):
        """퇴사 요청 1건을 돌리고 (반환상태, finish 페이로드) 를 준다. 축 결과를 원하는 대로 준다."""
        import offboard_axes as oa
        import ms_collect
        self.patch(w, "importlib", types.SimpleNamespace(reload=lambda m: m, import_module=importlib.import_module))
        self.patch(w, "notify_due_schedules", lambda *a, **k: None)
        self.patch(oa, "_token", lambda: "tok")
        self.patch(oa, "run_axes", lambda t, axes, apply=False, tok=None: list(axr))
        if collect is not None:
            self.patch(ms_collect, "collect", collect)
        fake = FakeRpc({"offboard_request_claim": {
            "request_id": "o2-bbbbbbbb", "mode": "apply", "origin": "manual",
            "targets": [{"email": "a@x", "emp_nm": "가", "axes": ["ms"]}]}})
        self.patch(w, "rpc", fake)
        res = w.tick("u", "k", "ws", False, False, offboard=True, collectors=True)
        return res, fake.last("offboard_request_finish")

    def test_ms_mirror_is_refreshed_when_ms_axis_changed(self):
        """MS 축이 실제로 바꿨으면 미러를 바로 갱신한다 — 화면이 옛 미러로 「남음」을 보이지 않게."""
        calls = []
        res, fin = self._offboard_with_axes(
            [{"ok": True, "axis": "ms", "changed": True, "msg": "차단·표기"}],
            collect=lambda url=None, key=None, **k: (calls.append((url, key)) or (484, 484)))
        self.assertEqual(res, "done")
        self.assertEqual(len(calls), 1, "MS 축이 바뀌었는데 미러를 갱신하지 않았다")
        self.assertIn("484건", fin["p_result"]["ms_refresh"])

    def test_ms_mirror_is_not_refreshed_when_nothing_changed(self):
        """이미 처리된 계정이면 갱신하지 않는다 — 요청마다 Graph 전량 조회를 돌릴 이유가 없다."""
        calls = []
        res, fin = self._offboard_with_axes(
            [{"ok": True, "axis": "ms", "changed": False, "msg": "이미 처리됨"}],
            collect=lambda url=None, key=None, **k: calls.append(1))
        self.assertEqual(calls, [])
        self.assertIsNone(fin["p_result"]["ms_refresh"])

    def test_ms_mirror_refresh_failure_does_not_break_offboard(self):
        """미러 갱신이 실패해도 이미 끝난 퇴사 처리를 뒤집지 않는다."""
        def boom(url=None, key=None, **k):
            raise SystemExit("환경변수 ENTRA_CLIENT_ID 가 없습니다")
        res, fin = self._offboard_with_axes(
            [{"ok": True, "axis": "ms", "changed": True, "msg": "차단·표기"}], collect=boom)
        self.assertEqual(res, "done", "미러 갱신 실패가 퇴사 처리 상태를 바꾸면 안 된다")
        self.assertIn("건너뜀", fin["p_result"]["ms_refresh"])

    def test_due_notice_throttle_survives_new_process(self):
        root = _tmp(self)
        old = os.environ.get("JEIL_AX_ENV_ROOT")
        os.environ["JEIL_AX_ENV_ROOT"] = root
        self.addCleanup(lambda: os.environ.pop("JEIL_AX_ENV_ROOT", None) if old is None
                        else os.environ.__setitem__("JEIL_AX_ENV_ROOT", old))
        sent = []
        self.patch(w, "notify", lambda title, lines, bad=False: sent.append(title) or True)
        self.patch(w, "rpc", FakeRpc({"offboard_schedule_list": {"rows": [
            {"state": "due", "scheduled_at": "2026-09-11T00:00:00", "emails": ["a@x"]}]}}))
        self.patch(w, "_DUE_NOTIFIED_AT", 0.0)
        w.notify_due_schedules("u", "k")
        self.assertEqual(len(sent), 1)
        self.assertTrue(os.path.exists(os.path.join(root, "logs", "due_notified.at")))
        w._DUE_NOTIFIED_AT = 0.0                 # 새 자식 프로세스 흉내
        w.notify_due_schedules("u", "k")
        self.assertEqual(len(sent), 1, "6시간 안에는 다시 보내지 않는다(파일 기준)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
