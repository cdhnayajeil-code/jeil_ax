# -*- coding: utf-8 -*-
"""test_runner_cli.py — 통합 러너의 서브커맨드 회귀 테스트(외부 접속 없음).

    python -m unittest test_runner_cli -v

러너를 EXE 하나로 합치면서 `jeil_runner.exe relay ...` 같은 서브커맨드가 생겼다.
여기서 지키려는 것은 세 가지다.
  ① 표에 올린 도구가 전부 **실제로 존재하고 main() 을 갖는다**(오타·모듈 삭제를 빌드 전에 잡는다).
  ② 서브커맨드가 그 모듈의 main() 으로 **인자를 그대로** 넘긴다.
  ③ 서브커맨드가 아닌 인자는 종전대로 러너 옵션으로 간다(`--smoke` 등이 가로채이지 않는다).
"""
import importlib
import io
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import jeil_runner as jr  # noqa: E402


class CliToolsTest(unittest.TestCase):
    def setUp(self):
        self._argv = list(sys.argv)
        self.addCleanup(lambda: sys.argv.__setitem__(slice(None), self._argv))

    def test_every_tool_module_exists_and_has_main(self):
        """표에 올린 도구는 전부 import 되고 main() 이 있어야 한다 — 빌드 전에 잡는다."""
        for name, (mod_name, desc) in jr.CLI_TOOLS.items():
            mod = importlib.import_module(mod_name)
            self.assertTrue(callable(getattr(mod, "main", None)),
                            "%s(%s) 에 main() 이 없습니다" % (name, mod_name))
            self.assertTrue(desc.strip(), "%s 설명이 비었습니다" % name)

    def test_tool_names_are_stable(self):
        """서버 문서·relay.cmd 가 이 이름을 그대로 친다 — 바꾸면 배포본이 깨진다."""
        self.assertEqual(set(jr.CLI_TOOLS), {"relay", "sync", "etl", "offboard", "mailbox", "roleseed"})

    def test_subcommand_passes_argv_through(self):
        import gl_apply_demo2 as g
        seen = {}

        def fake_main():
            seen["argv"] = list(sys.argv)
            return 0
        orig = g.main
        g.main = fake_main
        self.addCleanup(lambda: setattr(g, "main", orig))

        rc = jr.main(["relay", "--queue", "--max", "3"])
        self.assertEqual(rc, 0)
        self.assertEqual(seen["argv"][1:], ["--queue", "--max", "3"])
        self.assertTrue(seen["argv"][0].endswith("relay"), seen["argv"][0])

    def test_subcommand_return_code_is_propagated(self):
        import exo_admin as x
        orig = x.main
        x.main = lambda: 1
        self.addCleanup(lambda: setattr(x, "main", orig))
        self.assertEqual(jr.main(["mailbox", "-e", "a@x"]), 1)

    def test_tools_listing_prints_every_tool(self):
        buf = io.StringIO()
        old = sys.stdout
        sys.stdout = buf
        try:
            rc = jr.print_tools()
        finally:
            sys.stdout = old
        self.assertEqual(rc, 0)
        out = buf.getvalue()
        for name in jr.CLI_TOOLS:
            self.assertIn(name, out)

    def test_runner_options_are_not_swallowed(self):
        """`--smoke` 같은 러너 옵션은 서브커맨드로 오해되면 안 된다."""
        called = {}

        def fake_smoke(engine, log, no_tray, real_root):
            called["yes"] = True
            return 0
        orig = jr.run_smoke
        jr.run_smoke = fake_smoke
        self.addCleanup(lambda: setattr(jr, "run_smoke", orig))
        rc = jr.main(["--smoke", "--no-tray"])
        self.assertEqual(rc, 0)
        self.assertTrue(called.get("yes"), "--smoke 가 서브커맨드로 가로채였습니다")

    def test_main_fixes_console_encoding(self):
        """EXE 콘솔은 cp949 라 그대로 두면 한국어 출력이 터진다 — 진입점이 맞춰야 한다."""
        called = []
        orig = jr.use_utf8_console
        jr.use_utf8_console = lambda: called.append(1)
        self.addCleanup(lambda: setattr(jr, "use_utf8_console", orig))
        import exo_admin as x
        o2 = x.main
        x.main = lambda: 0
        self.addCleanup(lambda: setattr(x, "main", o2))
        jr.main(["mailbox", "-e", "a@x"])
        self.assertTrue(called, "main() 이 use_utf8_console() 을 부르지 않았습니다")

    def test_hide_console_is_noop_outside_frozen_exe(self):
        """개발 중(.py 실행)에는 아무것도 하지 않는다 — 콘솔을 숨기면 출력이 사라진다."""
        self.assertFalse(getattr(sys, "frozen", False))
        jr.hide_console()          # 예외 없이 그냥 지나가야 한다


if __name__ == "__main__":
    for _s in (sys.stdout, sys.stderr):
        if hasattr(_s, "reconfigure"):
            _s.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
