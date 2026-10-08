# -*- coding: utf-8 -*-
"""test_gw_board_collect.py — 사내규정 게시판 수집기 헤드리스 회귀 (REQ-0124)

그룹웨어·Playwright·NAS·DB 에 **절대 접속하지 않는다**: DOM 은 FakeDriver, 로그인은 가짜 세션, RPC 는 FakeRpc,
문서 루트는 임시 폴더, 하루 1회 표시 파일은 임시 경로로 돌린다. 실행: python -m unittest test_gw_board_collect
"""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gw_board_collect as gb  # noqa: E402
import hwp_text  # noqa: E402

ART5 = "취업규칙\n제정 2010.1.1\n제1조(목적) 이 규칙은 직원 복무를 정한다.\n제2조(적용) 전 직원.\n제3조(근무) 09~18.\n제4조(휴가) 연차.\n제5조(징계) 별도.\n부칙\n제1조(시행일) 이 규칙은 2024년 4월 1일부터 시행한다."
FAKE_CFG = {"url": "https://gw.example.invalid", "id": "svc.user.x", "pw": "pw-S3cret-xyz", "secret": "sk-Z9"}
SRC = {"board_key": "rules", "label_ko": "사내규정", "list_path": "/board/list?id=1", "active": True,
       "collect_attachments": True, "category": "인사"}


def post(no, title, body="<p>안내</p>", posted="2026-09-01 10:00", modified=None, atts=None):
    return {"post_no": str(no), "title": title, "body_html": body, "posted_at": posted, "modified_at": modified,
            "author": "홍길동", "dept": "인사팀", "attachments": atts or []}


class FakeDriver:
    """게시판 흉내. data = {board_key: [post, …]} · page_size 로 페이징 · empty=True 면 선택자 0건."""

    def __init__(self, data, page_size=2, empty=False):
        self.data, self.page_size, self.empty = data, page_size, empty
        self.src = None
        self.page_no = 1
        self.cur = None
        self.opened = []
        self.page = None

    def _posts(self):
        return self.data.get(self.src["board_key"], [])

    def open_list(self, src, page_no):
        self.src, self.page_no = src, page_no

    def read_rows(self):
        if self.empty:
            return []
        ps = self._posts()
        s = (self.page_no - 1) * self.page_size
        rows = []
        for p in ps[s:s + self.page_size]:
            rows.append({"post_no": p["post_no"], "title": p["title"], "author": p["author"], "dept": p["dept"],
                         "posted_at": gb._parse_dt(p["posted_at"]), "modified_at": gb._parse_dt(p["modified_at"]) if p.get("modified_at") else None,
                         "has_attach": bool(p["attachments"]), "is_notice": False,
                         "link": {"href": "/board/view?id=%s" % p["post_no"], "onclick": None, "id": p["post_no"]}})
        return rows

    def has_next(self):
        return self.page_no * self.page_size < len(self._posts())

    def open_post(self, row):
        self.cur = next(p for p in self._posts() if p["post_no"] == row["post_no"])
        self.opened.append(row["post_no"])

    def read_post(self):
        p = self.cur
        return {"title": p["title"], "body_html": p["body_html"], "posted_at": gb._parse_dt(p["posted_at"]),
                "modified_at": gb._parse_dt(p["modified_at"]) if p.get("modified_at") else None,
                "author": p["author"], "dept": p["dept"],
                "attachments": [{"name": a["name"], "href": "/board/download?id=%d" % i, "onclick": None, "size_text": ""}
                                for i, a in enumerate(p["attachments"], 1)],
                "url": "https://gw.example.invalid/board/view?id=%s" % p["post_no"]}

    def download(self, att, dest):
        for a in self.cur["attachments"]:
            if a["name"] == att["name"]:
                if a.get("fail"):
                    return {"ok": False, "reason": "HTTP 403", "mode": "request"}
                with open(dest, "wb") as fh:
                    fh.write(a["bytes"])
                return {"ok": True, "size": len(a["bytes"]), "name_from_header": None, "reason": None, "mode": "request"}
        return {"ok": False, "reason": "없음", "mode": "request"}

    def count(self, css):
        return 0 if self.empty else 3


class FakeRpc:
    def __init__(self, responses=None, fail=None):
        self.calls = []
        self.responses = responses or {}
        self.fail = set(fail or [])

    def __call__(self, url, key, fn, payload):
        self.calls.append((fn, payload))
        if fn in self.fail:
            raise RuntimeError("HTTP 500 rpc/%s: 흉내" % fn)
        return self.responses.get(fn)

    def fns(self):
        return [c[0] for c in self.calls]

    def payloads(self, fn):
        return [p for f, p in self.calls if f == fn]


@contextlib.contextmanager
def fake_session(login=None):
    yield None, (login or {"ok": True, "forced": False, "reason": None, "msg": "로그인"})


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="gwb_")
        self.root = os.path.join(self.tmp, "docs")
        os.makedirs(self.root)
        self.stamp = os.path.join(self.tmp, "stamp.json")
        self._orig_stamp = gb._stamp_file
        gb._stamp_file = lambda: self.stamp
        self.logs = []
        self._orig_log = gb._LOG[0]
        gb._LOG[0] = self.logs.append
        self.rpc = FakeRpc({"reg_source_list": [dict(SRC)], "erp_etl_batch": "batch-1",
                            "reg_ingest_upsert": {"posts": 1}, "reg_mark_removed": {"removed": 1}})

    def tearDown(self):
        gb._stamp_file = self._orig_stamp
        gb._LOG[0] = self._orig_log
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_collect(self, data, mode="full", driver=None, login=None, **kw):
        drv = driver or FakeDriver(data)
        kw.setdefault("docs_root_arg", self.root)
        kw.setdefault("rate_sleep", 0)
        res = gb.collect(mode=mode, session_factory=lambda: fake_session(login), driver_factory=lambda p, b, s: drv,
                         rpc_fn=self.rpc, cfg=FAKE_CFG, **kw)
        return res, drv

    @property
    def regs(self):
        return gb.regs_root(self.root)

    def post_dir(self, board, no, title):
        return os.path.join(self.regs, board, gb.post_dir_name(no, title))

    def data3(self):
        return {"rules": [
            post(101, "취업규칙 개정 안내", "<p>첨부 참조 <b>개정</b></p>",
                 atts=[{"name": "취업규칙.txt", "bytes": ART5.encode("utf-8")},
                       {"name": "양식.exe", "bytes": b"MZ"},
                       {"name": "스캔.hwp", "bytes": b"not ole at all"}]),
            post(102, "출장여비규정", "<div>제1조(목적) 출장비.<br>제2조(한도) 숙박 10만원.<br>제3조(정산) 7일 내.</div>", modified="2026-09-02 09:00"),
            post(103, "경조사 지원 기준", "<p>경조사비는 총무팀에 신청한다.</p>"),
        ]}


class TestFull(Base):
    def test_full_builds_nas_tree_ledger_and_db_payload(self):
        res, drv = self.run_collect(self.data3())
        self.assertTrue(res["ok"], res)
        self.assertEqual((res["new"], res["changed"], res["unchanged"], res["removed"]), (3, 0, 0, 0))
        self.assertTrue(res["complete"])
        d = self.post_dir("rules", 101, "취업규칙 개정 안내")
        self.assertTrue(os.path.isdir(d), d)
        for f in ("본문.md", "원본.html", "meta.json"):
            self.assertTrue(os.path.exists(os.path.join(d, f)), f)
        self.assertTrue(os.path.exists(os.path.join(d, "첨부", "취업규칙.txt")))
        self.assertFalse(os.path.exists(os.path.join(d, "첨부", "양식.exe")), "실행 파일은 받지 않는다")
        with io.open(os.path.join(d, "meta.json"), encoding="utf-8") as fh:
            meta = json.load(fh)
        self.assertEqual(meta["post"]["post_no"], "101")
        self.assertEqual(meta["post"]["revision"], 1)
        self.assertEqual(meta["post"]["nas_rel_path"], "00_전사공유/사내규정/rules/000101_취업규칙 개정 안내")
        self.assertEqual(meta["post"]["gw_url"], "https://gw.example.invalid/board/view?id=101")
        by = {a["file_name"]: a for a in meta["attachments"]}
        self.assertEqual(by["취업규칙.txt"]["text_status"], "readable")
        self.assertTrue(by["취업규칙.txt"]["is_article_source"])
        self.assertEqual(by["양식.exe"]["text_status"], "skipped")
        if hwp_text.hwp_ready():
            self.assertEqual((by["스캔.hwp"]["text_status"], by["스캔.hwp"]["text_reason"]), ("unreadable", hwp_text.REASON_NOT_HWP))
        self.assertEqual(meta["document"]["text_source"], "attachment:취업규칙.txt")
        self.assertEqual(meta["document"]["reg_key"], "rules:취업규칙")
        self.assertEqual(meta["document"]["parse_status"], "ok")
        self.assertEqual(meta["document"]["effective_date"], "2024-04-01")
        self.assertEqual(meta["document"]["category"], "인사")
        self.assertEqual(len(meta["articles"]), 6)
        # 102: 본문이 원천 · 103: 조문 없음 → fallback + 게시일로 보완
        with io.open(os.path.join(self.post_dir("rules", 102, "출장여비규정"), "meta.json"), encoding="utf-8") as fh:
            m2 = json.load(fh)
        self.assertEqual((m2["document"]["text_source"], m2["document"]["article_count"]), ("body", 3))
        with io.open(os.path.join(self.post_dir("rules", 103, "경조사 지원 기준"), "meta.json"), encoding="utf-8") as fh:
            m3 = json.load(fh)
        self.assertEqual((m3["document"]["parse_status"], m3["document"]["effective_date"]), ("fallback", "2026-09-01"))
        # 대장·상태
        with io.open(os.path.join(self.regs, "_ledger.jsonl"), encoding="utf-8") as fh:
            evs = [json.loads(l) for l in fh if l.strip()]
        self.assertEqual([e["event"] for e in evs if e["post_no"] == "101"], ["new", "db_synced"])
        with io.open(os.path.join(self.regs, "_state.json"), encoding="utf-8") as fh:
            st = json.load(fh)
        self.assertTrue(all(v["db_synced"] for v in st.values()))
        # DB
        self.assertEqual(self.rpc.fns()[:2], ["reg_source_list", "erp_etl_batch"])
        ing = self.rpc.payloads("reg_ingest_upsert")
        self.assertEqual(len(ing), 1)
        self.assertEqual(len(ing[0]["p_payload"]["posts"]), 3)
        self.assertEqual(ing[0]["p_payload"]["board_key"], "rules")
        self.assertEqual(self.rpc.payloads("erp_etl_batch")[-1]["p_payload"]["status"], "success")
        self.assertEqual(res["db_sent"], 3)

    def test_secrets_never_in_logs_or_files(self):
        self.run_collect(self.data3())
        blob = "\n".join(self.logs)
        for root_, _dirs, files in os.walk(self.regs):
            for f in files:
                with io.open(os.path.join(root_, f), encoding="utf-8", errors="ignore") as fh:
                    blob += fh.read()
        for secret in (FAKE_CFG["pw"], FAKE_CFG["secret"], FAKE_CFG["id"]):
            self.assertNotIn(secret, blob)

    def test_rrn_attachment_and_body_blocked(self):
        data = {"rules": [post(201, "담당자 명단", "<p>주민등록번호 900101-1234567 홍길동</p>",
                               atts=[{"name": "명단.txt", "bytes": "김철수 850505-2345678".encode("utf-8")},
                                     {"name": "규정.txt", "bytes": ART5.encode("utf-8")}])]}
        res, _ = self.run_collect(data)
        d = self.post_dir("rules", 201, "담당자 명단")
        self.assertFalse(os.path.exists(os.path.join(d, "첨부", "명단.txt")), "주민등록번호 꼴 첨부는 NAS 에 두지 않는다")
        self.assertTrue(os.path.exists(os.path.join(d, "첨부", "규정.txt")))
        self.assertFalse(os.path.exists(os.path.join(d, "원본.html")), "본문이 차단되면 원본 HTML 도 두지 않는다")
        with io.open(os.path.join(d, "meta.json"), encoding="utf-8") as fh:
            meta = json.load(fh)
        by = {a["file_name"]: a for a in meta["attachments"]}
        self.assertEqual((by["명단.txt"]["text_status"], by["명단.txt"]["nas_rel_path"]), ("blocked", None))
        self.assertEqual(meta["post"]["body_md"], "")
        self.assertTrue(meta["post"]["body_blocked"])
        self.assertNotIn("1234567", json.dumps(meta, ensure_ascii=False))
        self.assertNotIn("2345678", json.dumps(meta, ensure_ascii=False))

    def test_download_failure_recorded_not_fatal(self):
        data = {"rules": [post(301, "규정", atts=[{"name": "규정.txt", "bytes": b"", "fail": True}])]}
        res, _ = self.run_collect(data)
        self.assertTrue(res["ok"], res)
        with io.open(os.path.join(self.post_dir("rules", 301, "규정"), "meta.json"), encoding="utf-8") as fh:
            meta = json.load(fh)
        self.assertEqual(meta["attachments"][0]["text_status"], "skipped")
        self.assertIn("다운로드 실패", meta["attachments"][0]["text_reason"])


class TestIncremental(Base):
    def test_nightly_unchanged_does_not_rewrite(self):
        data = self.data3()
        self.run_collect(data)
        self.rpc.calls.clear()
        d = self.post_dir("rules", 101, "취업규칙 개정 안내")
        before = os.path.getmtime(os.path.join(d, "meta.json"))
        res, drv = self.run_collect(data, mode="nightly")
        self.assertTrue(res["ok"], res)
        self.assertEqual((res["new"], res["changed"]), (0, 0))
        self.assertEqual(res["unchanged"], 3)
        self.assertEqual(os.path.getmtime(os.path.join(d, "meta.json")), before)
        self.assertFalse(os.path.isdir(os.path.join(d, "history")))
        self.assertEqual(self.rpc.payloads("reg_ingest_upsert"), [], "보낼 것이 없으면 적재 RPC 를 부르지 않는다")
        self.assertTrue(os.path.exists(self.stamp), "완주했으면 하루 1회 표시")
        with io.open(self.stamp, encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["result"]["unchanged"], 3)

    def test_list_modified_at_skips_opening(self):
        data = self.data3()
        _, drv1 = self.run_collect(data)
        prof = {"list": {"modified_at": "td.mod"}}
        p = os.path.join(self.tmp, "prof.json")
        with io.open(gb.DEFAULT_PROFILE, encoding="utf-8") as fh:
            base = json.load(fh)
        base["list"]["modified_at"] = "td.mod"
        with io.open(p, "w", encoding="utf-8") as fh:
            json.dump(base, fh, ensure_ascii=False)
        res, drv2 = self.run_collect(data, mode="nightly", selectors=p)
        self.assertEqual(drv2.opened, [], "목록에 수정일 열이 있으면 값이 같은 게시물은 열지 않는다")
        self.assertEqual(res["unchanged"], 3)
        data["rules"][1]["modified_at"] = "2026-09-05 09:00"
        os.remove(self.stamp)                                   # 같은 날 두 번째 nightly 는 「오늘 완주」로 건너뛰므로
        res, drv3 = self.run_collect(data, mode="nightly", selectors=p)
        self.assertEqual(drv3.opened, ["102"], "수정일이 바뀐 게시물만 연다")
        # 열어 보니 본문·첨부가 같다 → 판은 올리지 않고 수정일만 따라간다(다음 회차에 다시 열지 않는다)
        self.assertEqual((res["changed"], res["unchanged"]), (0, 3))
        with io.open(os.path.join(self.regs, "_state.json"), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["rules:102"]["modified_at"], "2026-09-05T09:00:00")

    def test_changed_post_gets_new_revision_and_history(self):
        data = self.data3()
        self.run_collect(data)
        data["rules"][1]["body_html"] = "<div>제1조(목적) 출장비.<br>제2조(한도) 숙박 12만원.<br>제3조(정산) 7일 내.</div>"
        res, _ = self.run_collect(data, mode="nightly")
        self.assertEqual((res["new"], res["changed"], res["unchanged"]), (0, 1, 2))
        d = self.post_dir("rules", 102, "출장여비규정")
        hist = os.listdir(os.path.join(d, "history"))
        self.assertEqual(len(hist), 1)
        self.assertTrue(hist[0].startswith("01_"))
        self.assertTrue(os.path.exists(os.path.join(d, "history", hist[0], "본문.md")))
        with io.open(os.path.join(d, "meta.json"), encoding="utf-8") as fh:
            meta = json.load(fh)
        self.assertEqual(meta["post"]["revision"], 2)
        self.assertIn("12만원", meta["articles"][1]["body"])
        with io.open(os.path.join(self.regs, "_ledger.jsonl"), encoding="utf-8") as fh:
            evs = [json.loads(l)["event"] for l in fh if l.strip() and json.loads(l)["post_no"] == "102"]
        self.assertEqual(evs, ["new", "db_synced", "changed", "db_synced"])

    def test_title_change_renames_folder(self):
        data = self.data3()
        self.run_collect(data)
        data["rules"][2]["title"] = "경조사 지원 기준(개정)"
        data["rules"][2]["body_html"] = "<p>경조사비는 총무팀에 신청한다. 한도 상향.</p>"
        self.run_collect(data, mode="nightly")
        self.assertFalse(os.path.isdir(self.post_dir("rules", 103, "경조사 지원 기준")))
        self.assertTrue(os.path.isdir(self.post_dir("rules", 103, "경조사 지원 기준(개정)")))

    def test_full_marks_removed_and_refuses_when_too_few_seen(self):
        data = self.data3()
        self.run_collect(data)
        data["rules"] = data["rules"][:2]
        res, _ = self.run_collect(data)
        self.assertEqual(res["removed"], 1)
        with io.open(os.path.join(self.regs, "_state.json"), encoding="utf-8") as fh:
            st = json.load(fh)
        self.assertEqual(st["rules:103"]["status"], "removed")
        self.assertTrue(os.path.isdir(self.post_dir("rules", 103, "경조사 지원 기준")), "삭제 표시만, 파일은 보존")
        self.assertEqual(self.rpc.payloads("reg_mark_removed")[-1]["p_seen_post_nos"], ["101", "102"])
        # 활성 10건인데 2건만 보이면 거부
        for i in range(10):
            gb.Ledger(self.regs).load()
        led = gb.Ledger(self.regs).load()
        for i in range(500, 510):
            led.update("rules", str(i), status="active", nas_rel="x", rev=1, body_hash="h", attach_sig=None, db_synced=True)
        led.save()
        self.rpc.calls.clear()
        res, _ = self.run_collect(data)
        self.assertFalse(res["ok"])
        self.assertTrue(any("절반 미만" in e for e in res["errors"]))
        self.assertEqual(self.rpc.payloads("reg_mark_removed"), [])

    def test_db_failure_keeps_pending_and_resends_next_run(self):
        data = self.data3()
        self.rpc.fail.add("reg_ingest_upsert")
        res, _ = self.run_collect(data)
        self.assertFalse(res["ok"])
        self.assertEqual(res["db_failed"], 3)
        with io.open(os.path.join(self.regs, "_state.json"), encoding="utf-8") as fh:
            st = json.load(fh)
        self.assertFalse(any(v["db_synced"] for v in st.values()))
        self.assertFalse(os.path.exists(self.stamp))
        self.rpc.fail.clear()
        self.rpc.calls.clear()
        res, _ = self.run_collect(data, mode="nightly")
        self.assertTrue(res["ok"], res)
        self.assertEqual(len(self.rpc.payloads("reg_ingest_upsert")[0]["p_payload"]["posts"]), 3)

    def test_since_filter(self):
        data = self.data3()
        data["rules"][0]["posted_at"] = "2025-01-01 09:00"
        res, drv = self.run_collect(data, since="2026-08-01")
        self.assertEqual(drv.opened, ["102", "103"])
        self.assertEqual(res["removed"], 0)

    def test_max_posts_stops_without_stamp(self):
        res, drv = self.run_collect(self.data3(), mode="nightly", max_posts=2)
        self.assertEqual(len(drv.opened), 2)
        self.assertFalse(res["complete"])
        self.assertFalse(os.path.exists(self.stamp))
        res2, _ = self.run_collect(self.data3(), mode="nightly")
        self.assertEqual((res2["new"], res2["unchanged"]), (1, 2))


class TestGuards(Base):
    def test_selector_missing_stops_with_rc1(self):
        res, _ = self.run_collect({"rules": []}, driver=FakeDriver({"rules": []}, empty=True))
        self.assertFalse(res["ok"])
        self.assertEqual(res["rc"], 1)
        self.assertIn("선택자 없음", res["msg"])
        self.assertFalse(os.path.exists(self.stamp))

    def test_session_busy_skips_quietly(self):
        res, drv = self.run_collect(self.data3(), mode="nightly",
                                    login={"ok": False, "reason": "session_busy", "msg": "다른 세션"})
        self.assertEqual((res["ok"], res["rc"], res["skipped"]), (True, 0, "session_busy"))
        self.assertEqual(drv.opened, [])
        self.assertFalse(os.path.exists(self.stamp))

    def test_bad_credentials_is_failure(self):
        res, _ = self.run_collect(self.data3(), login={"ok": False, "reason": "bad_credentials", "msg": "불일치"})
        self.assertEqual((res["ok"], res["rc"]), (False, 1))

    def test_done_today_skips(self):
        with io.open(self.stamp, "w", encoding="utf-8") as fh:
            json.dump({"date": gb._now().strftime("%Y-%m-%d")}, fh)
        res, drv = self.run_collect(self.data3(), mode="nightly")
        self.assertEqual(res["skipped"], "done_today")
        self.assertEqual(drv.opened, [])

    def test_no_docs_root_defers(self):
        res, drv = self.run_collect(self.data3(), docs_root_arg=os.path.join(self.tmp, "없는폴더"))
        self.assertEqual((res["ok"], res["rc"], res["skipped"]), (True, 0, "no_docs_root"))
        self.assertEqual(drv.opened, [])

    def test_no_sources_is_failure(self):
        self.rpc.responses["reg_source_list"] = []
        p = os.path.join(self.tmp, "prof_noboards.json")
        with io.open(gb.DEFAULT_PROFILE, encoding="utf-8") as fh:
            base = json.load(fh)
        base["boards"] = []                                      # DB 0건 + 프로필 0건 → 수집하지 않는다(fail-closed)
        with io.open(p, "w", encoding="utf-8") as fh:
            json.dump(base, fh, ensure_ascii=False)
        res, _ = self.run_collect(self.data3(), selectors=p)
        self.assertEqual(res["rc"], 1)
        self.assertIn("게시판이 없습니다", res["msg"])

    def test_dry_run_touches_nothing(self):
        res, drv = self.run_collect(self.data3(), dry=True)
        self.assertTrue(res["ok"], res)
        self.assertEqual(len(drv.opened), 3)
        self.assertFalse(os.path.exists(self.regs))
        self.assertEqual(self.rpc.payloads("reg_ingest_upsert"), [])
        self.assertFalse(os.path.exists(self.stamp))
        self.assertTrue(any("(dry-run)" in l for l in self.logs))

    def test_no_db_uses_profile_boards(self):
        p = os.path.join(self.tmp, "prof.json")
        with io.open(gb.DEFAULT_PROFILE, encoding="utf-8") as fh:
            base = json.load(fh)
        base["boards"] = [dict(SRC)]
        with io.open(p, "w", encoding="utf-8") as fh:
            json.dump(base, fh, ensure_ascii=False)
        res, _ = self.run_collect(self.data3(), no_db=True, selectors=p)
        self.assertTrue(res["ok"], res)
        self.assertEqual(self.rpc.calls, [])
        self.assertTrue(os.path.isdir(self.post_dir("rules", 101, "취업규칙 개정 안내")))


class FakeResp:
    def __init__(self, status=200, ctype="application/json", body=b"", js=None, headers=None):
        self.status = status
        self.headers = dict({"content-type": ctype}, **(headers or {}))
        self._body, self._js = body, js

    def json(self):
        return self._js

    def body(self):
        return self._body


class FakeRequest:
    """Playwright page.request 흉내 — 끝점별 응답을 돌려주고 호출을 기록한다."""

    def __init__(self):
        self.calls = []
        self.list_pages = {}
        self.detail = {}
        self.files = {}
        self.html_download = False

    def post(self, url, form=None, headers=None, timeout=None):
        self.calls.append(("POST", url, dict(form or {})))
        path = url.split("//", 1)[-1].split("/", 1)[1]
        if path == "Board2/BoardPostList_Get":
            page = int(form.get("bModel[page]", "1"))
            lst, top = self.list_pages.get(page, ([], []))
            return FakeResp(js={"status": 1, "data": {"topPosts": top, "pendingPosts": [], "list": lst, "totalCount": sum(len(v[0]) for v in self.list_pages.values()), "pageCount": len(self.list_pages) or 1}})
        if path == "Board2/BoardPostDetail_Get":
            p = self.detail.get(form.get("boardPostID"))
            return FakeResp(js={"status": 1, "data": {"board": {"boardID": 18}, "post": p}}) if p else FakeResp(ctype="text/html", body=b"<html>login</html>")
        return FakeResp(status=404, ctype="text/html")

    def get(self, url, params=None, timeout=None):
        self.calls.append(("GET", url, dict(params or {})))
        if self.html_download:
            return FakeResp(ctype="text/html; charset=utf-8", body=b"<html>login</html>")
        data = self.files.get(params.get("fileIDStr"))
        if data is None:
            return FakeResp(status=404, ctype="text/html")
        return FakeResp(ctype="application/octet-stream", body=data, headers={"content-disposition": "attachment; filename*=UTF-8''%ED%8C%8C%EC%9D%BC.pdf"})


class FakePage:
    def __init__(self):
        self.request = FakeRequest()
        self.url = "https://gw.example.invalid/Main"


def api_item(pid, title, ms, hist=0, files=1, part="인사팀"):
    return {"boardPostID": pid, "idx": 0, "title": title, "writeDate": "/Date(%d)/" % ms, "isHistory": hist, "fileCnt": files, "partName": part, "memberName": "홍길동", "categoryName": "일반"}


class TestApiDriver(unittest.TestCase):
    def setUp(self):
        with io.open(gb.DEFAULT_PROFILE, encoding="utf-8") as fh:
            self.prof = json.load(fh)
        self.page = FakePage()
        self.page.request.list_pages = {1: ([api_item(7589, "[사내규정] 해외주재원 관리규정 개정(2025.11.04)", 1762299644533, hist=2), api_item(16, "[사내규정] 취업규칙", 1703637961150)],
                                            [api_item(7589, "[사내규정] 해외주재원 관리규정 개정(2025.11.04)", 1762299644533, hist=2)]),
                                        2: ([api_item(15, "[사내규정] 지출전결처리규정", 1703637656097)], [])}
        self.page.request.detail["7589"] = {"boardPostID": 7589, "title": "[사내규정] 해외주재원 관리규정 개정(2025.11.04)", "contents": "<p>해외주재원 관리규정 (2025.11.04 개정)</p>",
                                            "writeDateTime": "2025-11-05 08:40", "editDateTime": "2026-09-04 15:10", "writeMemberName": "김은수",
                                            "attachments": [{"boardFileID": 3613, "fileName": "해외주재원관리규정 20251104.pdf", "filePath": "/UploadResource/BoardResource/Board_18/7589", "size": "392KB", "notFound": False},
                                                            {"boardFileID": 9999, "fileName": "없는파일.hwp", "filePath": "/UploadResource/BoardResource/Board_18/7589", "size": "1KB", "notFound": True}]}
        self.page.request.files["3613"] = b"%PDF-1.4 fake"
        self.src = {"board_key": "rules", "list_path": "/Board2/BoardPostList_Get", "selectors": {"api": {"boardID": 18}}, "collect_attachments": True}
        self.drv = gb.make_driver(self.page, "https://gw.example.invalid", self.prof)

    def test_make_driver_picks_api(self):
        self.assertIsInstance(self.drv, gb.ApiDriver)
        dom = dict(self.prof, list_mode="dom")
        self.assertIsInstance(gb.make_driver(self.page, "https://gw.example.invalid", dom), gb.BoardDriver)

    def test_list_form_and_rows(self):
        self.drv.open_list(self.src, 1)
        m, url, form = self.page.request.calls[-1]
        self.assertEqual((m, url), ("POST", "https://gw.example.invalid/Board2/BoardPostList_Get"))
        self.assertEqual((form["bModel[boardID]"], form["bModel[page]"], form["bModel[pageCount]"], form["stateTargetObject[]"]), ("18", "1", "100", "1"))
        self.assertRegex(form["bModel[endDate]"], r"^\d{4}-\d{2}-\d{2}$")
        rows = self.drv.read_rows()
        self.assertEqual([r["post_no"] for r in rows], ["7589", "16"], "상단 고정과 본문 목록의 같은 게시물은 한 번만")
        self.assertTrue(rows[0]["is_notice"] and not rows[1]["is_notice"])
        self.assertEqual(rows[0]["posted_at"], "2025-11-05T08:40:44")
        self.assertEqual((rows[0]["mod_count"], rows[1]["mod_count"], rows[0]["has_attach"]), (2, 0, True))
        self.assertIsNone(rows[0]["modified_at"])
        self.assertTrue(self.drv.has_next())
        self.drv.open_list(self.src, 2)
        self.assertEqual([r["post_no"] for r in self.drv.read_rows()], ["15"])
        self.assertFalse(self.drv.has_next())

    def test_detail_and_download(self):
        self.drv.open_list(self.src, 1)
        row = self.drv.read_rows()[0]
        self.drv.open_post(row)
        post = self.drv.read_post()
        self.assertEqual(post["title"], "[사내규정] 해외주재원 관리규정 개정(2025.11.04)")
        self.assertEqual((post["posted_at"], post["modified_at"], post["author"]), ("2025-11-05T08:40:00", "2026-09-04T15:10:00", "김은수"))
        self.assertIn("해외주재원 관리규정", post["body_html"])
        self.assertEqual(post["url"], "https://gw.example.invalid/Main#board=18&post=7589")
        self.assertEqual([a["name"] for a in post["attachments"]], ["해외주재원관리규정 20251104.pdf", "없는파일.hwp"])
        dest = os.path.join(tempfile.mkdtemp(prefix="gwapi_"), "a.pdf")
        r = self.drv.download(post["attachments"][0], dest)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["name_from_header"], "파일.pdf")
        with open(dest, "rb") as fh:
            self.assertEqual(fh.read(), b"%PDF-1.4 fake")
        m, url, params = self.page.request.calls[-1]
        self.assertEqual((m, url), ("GET", "https://gw.example.invalid/Common/Download"))
        self.assertEqual((params["fileType"], params["fileIDStr"], params["filePath"]), ("FILETYPEBOARD", "3613", "/UploadResource/BoardResource/Board_18/7589"))
        self.assertFalse(self.drv.download(post["attachments"][1], dest + ".2")["ok"], "notFound 첨부는 받지 않는다")
        self.page.request.html_download = True
        self.assertIn("HTML 응답", self.drv.download(post["attachments"][0], dest + ".3")["reason"])

    def test_non_json_detail_is_error(self):
        self.drv.open_list(self.src, 1)
        with self.assertRaises(RuntimeError):
            self.drv.open_post({"post_no": "404", "link": {"id": "404"}})

    def test_collect_end_to_end_with_api_driver(self):
        """FakePage + 기본 프로필(api) → 수집 파이프라인이 드라이버를 스스로 고른다."""
        tmp = tempfile.mkdtemp(prefix="gwapi_e2e_")
        root = os.path.join(tmp, "docs"); os.makedirs(root)
        stamp = os.path.join(tmp, "stamp.json")
        orig = gb._stamp_file; gb._stamp_file = lambda: stamp
        logs = []; orig_log = gb._LOG[0]; gb._LOG[0] = logs.append
        try:
            self.page.request.detail["16"] = {"boardPostID": 16, "title": "[사내규정] 취업규칙", "contents": "<p>제1조(목적) a</p><p>제2조(범위) b</p><p>제3조(근무) c</p>", "writeDateTime": "2023-12-27 09:00", "editDateTime": None, "attachments": []}
            self.page.request.detail["15"] = {"boardPostID": 15, "title": "[사내규정] 지출전결처리규정", "contents": "<p>전결 기준 안내</p>", "writeDateTime": "2023-12-27 08:00", "attachments": []}
            rpc = FakeRpc({"reg_source_list": [dict(self.src, label_ko="회사규정", category="사내규정")], "erp_etl_batch": "b", "reg_ingest_upsert": {"posts": 3}})

            @contextlib.contextmanager
            def page_session():
                yield self.page, {"ok": True, "forced": False, "reason": None, "msg": "로그인"}
            fake_session = page_session                        # 아래 호출 3곳이 같은 FakePage 를 쓴다
            res = gb.collect(mode="full", docs_root_arg=root, rate_sleep=0, session_factory=lambda: fake_session(), rpc_fn=rpc, cfg=dict(FAKE_CFG, url="https://gw.example.invalid"))
            self.assertTrue(res["ok"], res)
            self.assertEqual((res["new"], res["boards"]["rules"]["pages"], res["complete"]), (3, 2, True))
            d = os.path.join(gb.regs_root(root), "rules", gb.post_dir_name("7589", "[사내규정] 해외주재원 관리규정 개정(2025.11.04)"))
            self.assertTrue(os.path.exists(os.path.join(d, "첨부", "해외주재원관리규정 20251104.pdf")))
            with io.open(os.path.join(d, "meta.json"), encoding="utf-8") as fh:
                meta = json.load(fh)
            self.assertEqual(meta["post"]["modified_at"], "2026-09-04T15:10:00")
            self.assertEqual(meta["post"]["gw_url"], "https://gw.example.invalid/Main#board=18&post=7589")
            by = {a["file_name"]: a for a in meta["attachments"]}
            self.assertEqual(by["없는파일.hwp"]["text_status"], "skipped")
            # 2회차(nightly): 수정 횟수가 같으면 열지 않는다
            n_calls = len(self.page.request.calls)
            res2 = gb.collect(mode="nightly", docs_root_arg=root, rate_sleep=0, session_factory=lambda: fake_session(), rpc_fn=rpc, cfg=dict(FAKE_CFG, url="https://gw.example.invalid"))
            self.assertEqual((res2["new"], res2["changed"], res2["unchanged"]), (0, 0, 3))
            self.assertFalse(any(c[1].endswith("BoardPostDetail_Get") for c in self.page.request.calls[n_calls:]), "수정 횟수가 같은 게시물은 상세를 부르지 않는다")
            # 수정 횟수 증가 → 그 게시물만 다시 연다
            os.remove(stamp)
            self.page.request.list_pages[1][0][1]["isHistory"] = 1
            res3 = gb.collect(mode="nightly", docs_root_arg=root, rate_sleep=0, session_factory=lambda: fake_session(), rpc_fn=rpc, cfg=dict(FAKE_CFG, url="https://gw.example.invalid"))
            details = [c for c in self.page.request.calls if c[1].endswith("BoardPostDetail_Get")]
            self.assertEqual(details[-1][2]["boardPostID"], "16")
            self.assertEqual((res3["changed"], res3["unchanged"]), (0, 3), "내용이 같으면 판은 그대로")
        finally:
            gb._stamp_file = orig; gb._LOG[0] = orig_log
            shutil.rmtree(tmp, ignore_errors=True)


class TestPure(unittest.TestCase):
    def test_html_to_md(self):
        md = gb.html_to_md("<script>x()</script><h2>제1장</h2><p>첫째<br>둘째</p><table><tr><td>a</td><td>b</td></tr></table>"
                           "<ul><li>하나</li><li>둘</li></ul><b>굵게</b> <a href='/f.pdf'>링크</a> <img alt='도장'>")
        self.assertNotIn("x()", md)
        self.assertIn("## 제1장", md)
        self.assertIn("첫째\n둘째", md)
        self.assertIn("| a | b |", md)
        self.assertIn("- 하나\n- 둘", md)
        self.assertIn("**굵게**", md)
        self.assertIn("링크 (/f.pdf)", md)
        self.assertIn("[이미지:도장]", md)

    def test_post_dir_name_and_safe_name(self):
        self.assertEqual(gb.post_dir_name("123", "취업규칙: 개정/안내?"), "000123_취업규칙 개정 안내")
        self.assertEqual(gb.post_dir_name("abc-9", "x" * 100)[:6], "abc-9_")
        self.assertTrue(len(gb.post_dir_name("1", "가" * 200)) <= 70)
        n = gb.safe_name("아주" * 80 + ".hwp")
        self.assertTrue(n.endswith(".hwp") and len(n) <= 100)
        self.assertEqual(gb.classify_ext("x.EXE")[1], False)

    def test_parse_dt(self):
        self.assertEqual(gb._parse_dt("2026.09.01 10:05"), "2026-09-01T10:05:00")
        self.assertEqual(gb._parse_dt("2026-09-01"), "2026-09-01T00:00:00")
        self.assertEqual(gb._parse_dt("26.09.01"), "2026-09-01T00:00:00")
        self.assertIsNone(gb._parse_dt("날짜 아님"))

    def test_attach_sig_ignores_skipped(self):
        a = [{"file_name": "a.txt", "size_bytes": 1, "sha256": "x", "text_status": "readable"},
             {"file_name": "b.exe", "size_bytes": 0, "sha256": None, "text_status": "skipped"}]
        self.assertEqual(gb.attach_sig(a), gb.attach_sig(a[:1]))
        self.assertIsNone(gb.attach_sig([a[1]]))

    def test_merge_selectors(self):
        base = {"list": {"row": "tr", "title": "a"}, "post": {"body": ".b"}}
        m = gb.merge_selectors(base, {"list": {"row": "div.r"}, "login": {"logout_path": "/out"}})
        self.assertEqual((m["list"]["row"], m["list"]["title"], m["login"]["logout_path"]), ("div.r", "a", "/out"))
        self.assertEqual(base["list"]["row"], "tr")


if __name__ == "__main__":
    unittest.main()
