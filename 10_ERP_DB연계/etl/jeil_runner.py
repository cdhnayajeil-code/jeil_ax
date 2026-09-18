# -*- coding: utf-8 -*-
r"""jeil_runner.py — JEIL AX 연동 러너: **서버에 두는 단일 통합 프로그램**의 진입점.

러너와 관련된 것은 전부 이 프로그램 하나로 모은다(EXE 하나만 배포·갱신한다).
예전에는 릴레이가 `gl_relay.exe` 로 따로 있었는데, 서버에 두 파일을 각각 올리고 각각
버전을 맞춰야 해서 실제로 한쪽만 낡는 일이 생겼다(2026-09-11 릴레이 v1.6/v1.7 불일치).

    jeil_runner.exe                      # 트레이 앱(기본). 창 닫으면 트레이로, 트레이 메뉴로 종료
    jeil_runner.exe --headless           # 창 없이 스케줄만(로그 파일). Ctrl+C 로 종료
    jeil_runner.exe --smoke              # 자체 점검: 창(숨김)·더미 작업·중지(트리 종료)·.env 읽기 → exit 0/1
    jeil_runner.exe --root E:\ai.jeil\relay   # 데이터 루트(.env·설정·로그 자리) 지정. 기본 = EXE 폴더
    jeil_runner.exe --no-tray            # 트레이 아이콘 없이 창만

  딸린 CLI(서브커맨드) — 서버에서 손으로 점검할 때. 각 모듈의 CLI 를 그대로 부른다:
    jeil_runner.exe tools                # 쓸 수 있는 서브커맨드 목록
    jeil_runner.exe relay --list         # 결의전표 전송 대기 건(구 gl_relay.exe)
    jeil_runner.exe relay --queue --max 5
    jeil_runner.exe sync --once          # 화면 요청 1건 처리
    jeil_runner.exe etl --job dept_master --dry-run
    jeil_runner.exe offboard -e <메일> -a ms      # 퇴사 3축 점검(기본 dry-run)
    jeil_runner.exe mailbox -e <메일>             # 사서함 공유 전환 점검

  내부용(러너가 자기 자신을 이렇게 띄운다 — 사람이 칠 일 없음):
    jeil_runner.exe --job <id> --kind <kind> --params <json> --log <path> --root <root>

작업 종류(kind)별 실체 — 기존 CLI 를 그대로 부른다(로직 중복 없음):
    relay_queue : gl_apply_demo2.main()  with  --queue --max N
    etl_sync    : etl_watch.tick(...)   (=--once) — 퇴사 처리·계정 수집·급여는 이 호스트가 할 수 있는 범위만
    etl_batch   : etl_run.run_job(...)  선택 job 순차(시작·job 사이 러너 심박)
    noop        : 점검용 — 몇 줄 출력하고 끝

보안(CLAUDE.md §1): 접속정보는 자식이 `.env`(--root) 에서 매번 새로 읽는다. 이 파일은 값을 출력하지 않는다.
"""
import argparse
import io
import json
import os
import socket
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import runner_core as core  # noqa: E402


# ─────────────────────────────── 딸린 CLI(서브커맨드) ───────────────────────────────
# 러너와 같이 배포되던 도구들을 이 EXE 하나에서 부른다. **로직은 각 모듈의 main() 이 그대로 갖는다** —
# 여기서는 이름만 이어 준다. 러너에 새 도구가 생기면 이 표에 한 줄만 추가한다.
CLI_TOOLS = {
    "relay":    ("gl_apply_demo2", "결의전표 ERP 전송(구 gl_relay.exe)"),
    "sync":     ("etl_watch",      "화면 요청 처리 — 데이터 업데이트·퇴사"),
    "etl":      ("etl_run",        "ERP→중간DB 적재 배치"),
    "offboard": ("offboard_axes",  "퇴사 처리 3축 점검·실행(기본 dry-run)"),
    "mailbox":  ("exo_admin",      "Exchange 사서함 공유 전환(기본 dry-run)"),
}


def run_tool(name, argv):
    """서브커맨드 실행 — 해당 모듈의 main() 을 그대로 부른다."""
    import importlib
    mod_name, _desc = CLI_TOOLS[name]
    mod = importlib.import_module(mod_name)
    # 각 모듈이 argparse 로 sys.argv 를 읽는다. 프로그램 이름은 서브커맨드로 보이게 둔다.
    sys.argv = ["jeil_runner " + name] + list(argv)
    return int(mod.main() or 0)


def print_tools():
    print("JEIL AX 연동 러너 %s — 서브커맨드" % core.RUNNER_VERSION)
    for name, (_mod, desc) in CLI_TOOLS.items():
        print("  %-10s %s" % (name, desc))
    print("\n  각 서브커맨드의 도움말:  jeil_runner.exe <이름> --help")
    print("  인자 없이 실행하면 트레이 러너로 뜹니다.")
    return 0


def use_utf8_console():
    """콘솔 출력을 UTF-8 로 맞춘다.

    console 로 빌드한 EXE 는 Windows 기본 코드페이지(cp949)로 stdout 을 연다. 그래서
    `—`·`·` 같은 글자를 찍는 순간 UnicodeEncodeError 로 죽는다(2026-09-18 EXE 실측 —
    `jeil_runner.exe tools` 가 첫 줄에서 터졌다). 각 모듈이 제 main() 에서 따로 하던 일을
    진입점에서 한 번에 해 둔다."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass            # 리다이렉션 등으로 못 바꿔도 러너는 그대로 돈다


def hide_console():
    """트레이 앱으로 뜰 때 콘솔 창을 감춘다.

    EXE 를 console 로 빌드하는 이유는 위 서브커맨드 출력을 서버에서 바로 보기 위해서다.
    트레이 모드에서는 그 창이 방해가 되므로 숨긴다. 자식 작업은 CREATE_NO_WINDOW 로 띄우므로
    (runner_core.spawn_child) 원래 창이 없다."""
    if os.name != "nt" or not getattr(sys, "frozen", False):
        return
    try:
        import ctypes
        hwnd = ctypes.windll.kernel32.GetConsoleWindow()
        if hwnd:
            ctypes.windll.user32.ShowWindow(hwnd, 0)      # SW_HIDE
    except Exception:
        pass                                              # 숨기지 못해도 러너는 그대로 돈다


# ─────────────────────────────── 자식 프로세스(작업 실행) ───────────────────────────────
def build_child_argv(job_cfg, params, log_path, root):
    """부모가 자식을 띄울 명령. EXE 면 자기 자신, .py 면 같은 인터프리터로 이 파일."""
    base = [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, os.path.abspath(__file__)]
    return base + ["--job", job_cfg["id"], "--kind", job_cfg["kind"],
                   "--params", json.dumps(params, ensure_ascii=False), "--log", log_path, "--root", root]


def _bind_output(log_path):
    """자식의 stdout/stderr 를 실행 로그 파일에 묶는다(줄 단위 flush, UTF-8).

    파이프 대신 파일인 이유: --windowed EXE 는 콘솔이 없어 표준 출력이 없을 수 있다.
    파일이면 어느 경우에도 남고, 창은 그 파일을 tail 한다."""
    f = io.open(log_path, "a", encoding="utf-8", errors="replace", buffering=1)
    sys.stdout = f
    sys.stderr = f
    return f


def _log_inside_root(log_path, root):
    base = os.path.normcase(os.path.realpath(core.Paths(root).runs))
    try:
        return os.path.commonpath([os.path.normcase(os.path.realpath(log_path)), base]) == base
    except (ValueError, TypeError):
        return False


def run_child(args):
    if not args.root or not args.log or not _log_inside_root(args.log, args.root):
        return 2            # 러너가 만든 명령이 아니다 — 아무것도 하지 않는다
    root = os.path.abspath(args.root)
    # _env.env_root() 가 이 값을 우선한다 → 부모와 같은 자리의 .env/.env.local 을 매 실행 새로 읽는다
    os.environ["JEIL_AX_ENV_ROOT"] = root
    try:
        params = json.loads(args.params or "{}")
    except ValueError:
        params = {}
    f = _bind_output(args.log)
    try:
        rc = _run_kind(args.kind, params, root)
    except SystemExit as e:           # 기존 CLI 들이 raise SystemExit("메시지") 로 끝내는 경우
        code = e.code
        if isinstance(code, str):
            print(code)
            rc = 1
        else:
            rc = int(code or 0)
    except KeyboardInterrupt:
        rc = 130
    except Exception as e:
        import traceback
        print("[오류] %s: %s" % (type(e).__name__, str(e)[:500]))
        traceback.print_exc()
        rc = 1
    finally:
        try:
            f.flush()
        except Exception:
            pass
    return rc


def _run_kind(kind, params, root):
    if kind == "noop":
        n = int(params.get("lines", 3))
        print("[noop] 러너 점검용 더미 작업 — host=%s pid=%s" % (socket.gethostname(), os.getpid()))
        for i in range(n):
            print("[noop] 진행 %d/%d" % (i + 1, n))
            time.sleep(float(params.get("sleep", 0.3)))
        print("[noop] 완료 — 아무것도 바꾸지 않았습니다")
        return int(params.get("rc", 0))

    if kind == "relay_queue":
        import gl_apply_demo2 as g
        sys.argv = ["gl_relay", "--queue", "--max", str(int(params.get("max", 5)))]
        return int(g.main() or 0)

    if kind == "etl_sync":
        import etl_watch as w
        w.load_env()
        url = w.need("SUPABASE_URL").rstrip("/")
        key = w.need("SUPABASE_SERVICE_ROLE_KEY")
        runner = socket.gethostname()
        # 부모가 넘긴 값을 그대로 믿지 않는다 — 이 호스트 능력으로 한 번 더 자른다(설정 손편집 방어)
        caps = core.detect_capabilities(root)
        offboard = bool(params.get("offboard")) and bool(caps.get("offboard"))
        if params.get("offboard") and not offboard:
            print("[etl_sync] 퇴사 처리: 이 호스트는 불가 — 퇴사 큐를 보지 않습니다")
        c = params.get("collectors")
        c = list(w.COLLECTORS) if c is True else (c if isinstance(c, list) else [])
        collectors = [n for n in c if n in w.COLLECTORS and caps.get(n)]
        allow_sensitive = bool(params.get("allow_sensitive"))
        print("[etl_sync] host=%s · 계정수집=%s · 퇴사처리=%s · 급여요청=%s%s" % (
            runner, "·".join(collectors) or "없음", "포함" if offboard else "제외",
            "처리" if allow_sensitive else "생략", " · full" if params.get("full") else ""))
        res = w.tick(url, key, runner, False, bool(params.get("full")),
                     offboard=offboard, collectors=collectors, allow_sensitive=allow_sensitive)
        if res == "failed":
            print("요청 처리 실패 — 위 로그와 화면의 요청 결과를 확인하세요")
            return 1
        print("요청 처리 1건 완료" if res else "대기 요청 없음")
        return 0

    if kind == "etl_batch":
        import etl_run as r
        r.load_env()
        url = r.need("SUPABASE_URL").rstrip("/")
        key = r.need("SUPABASE_SERVICE_ROLE_KEY")
        host = socket.gethostname()
        caps = core.detect_capabilities(root)
        # 배치 중에는 요청을 집지 않으므로 급여 요청도 처리하지 않는다(+nosens) — SQL 49 판정이 이 표식을 본다
        note = "batch+acct%d%s+nosens" % (sum(1 for n in core.COLLECTOR_NAMES if caps.get(n)),
                                          "+offboard" if caps.get("offboard") else "")

        def ping():
            # 배치 중에는 같은 그룹의 요청 처리가 쉬므로, 화면이 「러너 미가동」으로 오안내하지 않게 심박을 이어 준다
            try:
                r.rpc(url, key, "erp_sync_runner_ping", {"p_runner": host, "p_note": note})
            except Exception as e:
                print("[경고] 심박 기록 실패(계속): %s" % type(e).__name__)

        sensitive = {n for n, s in r.JOBS.items() if s.get("rpc") == "erp_secure_upsert"}
        wanted = [n for n in (params.get("jobs") or []) if n in r.JOBS]
        if not wanted:
            wanted = [n for n in r.JOBS if params.get("include_sensitive") or n not in sensitive]
        elif not params.get("include_sensitive"):
            wanted = [n for n in wanted if n not in sensitive]
        print("[etl_batch] job %d종%s%s: %s" % (
            len(wanted), " · dry-run" if params.get("dry_run") else "", " · full" if params.get("full") else "",
            ", ".join(wanted)))
        fail = []
        for name in wanted:
            ping()
            try:
                r.run_job(name, r.JOBS[name], url, key, bool(params.get("dry_run")), bool(params.get("full")))
            except (Exception, SystemExit) as e:
                fail.append(name)
                msg = str(e.code) if isinstance(e, SystemExit) else str(e)
                print("  ! %s 실패: %s" % (name, msg[:200]))
        print("[etl_batch] 완료 — 성공 %d / 실패 %d%s" % (
            len(wanted) - len(fail), len(fail), (" (" + ", ".join(fail) + ")") if fail else ""))
        return 1 if fail else 0

    print("[오류] 모르는 작업 종류: %s" % kind)
    return 2


# ─────────────────────────────── 부모(러너) ───────────────────────────────
def _runner_logger(paths):
    os.makedirs(paths.logs, exist_ok=True)

    def log(msg):
        line = "[%s] %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
        try:
            with io.open(paths.runner_log, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass
        try:
            print(line, flush=True)
        except Exception:
            pass
    return log


def run_headless(engine, log):
    log("헤드리스 모드 — Ctrl+C 로 종료")
    engine.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log("종료 요청(Ctrl+C)")
    finally:
        engine.stop()
    return 0


def _wait(pred, timeout, ui=None, step=0.2):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if ui:
            try:
                ui.root.update()
            except Exception:
                pass
        if pred():
            return True
        time.sleep(step)
    return pred()


def run_smoke(engine, log, no_tray, real_root):
    """자체 점검 — 실제 릴레이/ETL 은 **절대** 돌리지 않는다(퇴사 처리 큐 등 실동작 방지). 더미 작업만.

    ① 창·트레이 생성 ② 더미 작업 성공·내역 기록 ③ [중지] 가 프로세스 트리를 끝내는지(로그가 더 늘지 않는지)
    ④ 실제 루트의 `.env` 를 읽을 수 있는지(내용은 읽지 않음)."""
    import datetime as dt
    ok = True
    engine.update_config({"paused": True, "jobs": [
        {"id": "smoke_noop", "kind": "noop", "name": "점검 더미", "enabled": True,
         "schedule": {"type": "interval", "seconds": 3600}, "params": {"lines": 2, "sleep": 0.1}},
        {"id": "smoke_stop", "kind": "noop", "name": "점검 중지", "enabled": True,
         "schedule": {"type": "interval", "seconds": 3600}, "params": {"lines": 300, "sleep": 0.1}}]})
    engine.start()
    ui = None
    try:
        import runner_ui
        ui = runner_ui.RunnerWindow(engine, log, tray=not no_tray, hidden=True)
        ui.root.update()
        log("smoke: ① 창 생성 OK%s" % ("" if no_tray else " · 트레이 %s" % ("OK" if ui.tray_ok else "실패(창만)")))
    except Exception as e:
        log("smoke: ① UI 생성 실패 — %s: %s" % (type(e).__name__, str(e)[:200]))
        ok = False

    def row(jid):
        return [r for r in engine.snapshot()["jobs"] if r["id"] == jid][0]

    # ② 더미 성공
    done, msg = engine.run_now("smoke_noop")
    _wait(lambda: not row("smoke_noop")["running"] and row("smoke_noop")["result"] != "-", 30, ui)
    j = row("smoke_noop")
    good = j["result"] == core.STATUS_OK and "[noop] 완료" in (j["summary"] or "")
    hist = engine.history(5)
    good = good and bool(hist) and hist[0].get("job") == "smoke_noop"
    log("smoke: ② 더미 작업 %s (결과=%s exit=%s)" % ("OK" if good else "실패", j["result"], j.get("rc")))
    ok = ok and good

    # ③ 중지 = 트리 종료
    engine.run_now("smoke_stop")
    started = _wait(lambda: "진행 5/" in core.tail_text(row("smoke_stop")["log"] or ""), 30, ui)
    engine.stop_job("smoke_stop")
    _wait(lambda: not row("smoke_stop")["running"], 20, ui)
    j = row("smoke_stop")
    size1 = os.path.getsize(j["log"]) if j["log"] and os.path.exists(j["log"]) else -1
    _wait(lambda: False, 2.0, ui)
    size2 = os.path.getsize(j["log"]) if j["log"] and os.path.exists(j["log"]) else -1
    good = started and j["result"] == core.STATUS_STOPPED and size1 == size2 and size1 > 0
    log("smoke: ③ 중지(트리 종료) %s (결과=%s · 로그 %d→%d바이트)" % ("OK" if good else "실패", j["result"], size1, size2))
    ok = ok and good

    # ④ .env 읽기
    state = core.env_file_state(os.path.join(real_root, ".env"))
    label = {"ok": "읽기 가능", "missing": "없음", "denied": "읽기 권한 없음 — 관리자 권한으로 실행하세요", "error": "오류"}[state]
    log("smoke: ④ .env %s" % label)
    if state in ("denied", "error"):
        ok = False

    if ui:
        try:
            ui.destroy()
        except Exception:
            pass
    engine.stop()
    log("smoke: %s (%s)" % ("통과" if ok else "실패", dt.datetime.now().strftime("%H:%M:%S")))
    return 0 if ok else 1


def main(argv=None):
    use_utf8_console()
    argv = list(sys.argv[1:] if argv is None else argv)
    # 서브커맨드가 먼저다 — 러너 옵션(--root 등)과 섞이지 않게 첫 인자로만 받는다.
    if argv:
        if argv[0] in CLI_TOOLS:
            return run_tool(argv[0], argv[1:])
        if argv[0] in ("tools", "--tools", "help"):
            return print_tools()

    ap = argparse.ArgumentParser(description="JEIL AX 연동 러너(단일 통합 프로그램)",
                                 epilog="딸린 CLI 는 `jeil_runner.exe tools` 로 봅니다.")
    ap.add_argument("--root", help="데이터 루트(.env·설정·로그). 기본 = EXE 폴더(또는 저장소 루트)")
    ap.add_argument("--headless", action="store_true", help="창 없이 스케줄만")
    ap.add_argument("--smoke", action="store_true", help="자체 점검 후 종료")
    ap.add_argument("--no-tray", action="store_true", help="트레이 아이콘 없이 창만")
    ap.add_argument("--job", help=argparse.SUPPRESS)
    ap.add_argument("--kind", help=argparse.SUPPRESS)
    ap.add_argument("--params", help=argparse.SUPPRESS)
    ap.add_argument("--log", help=argparse.SUPPRESS)
    args = ap.parse_args(argv)

    if args.job:
        return run_child(args)

    real_root = os.path.abspath(args.root or core.default_root())
    if args.smoke:
        # 자체 점검은 임시 폴더에서 — 실제 설정(runner_config.json)·내역을 건드리지 않는다
        import tempfile
        root = tempfile.mkdtemp(prefix="jeil_runner_smoke_")
    else:
        root = real_root
    paths = core.Paths(root)
    paths.ensure()
    log = _runner_logger(paths)
    if args.smoke:
        # 창 없는 EXE 는 stdout 이 없으므로 점검 결과를 실제 루트의 logs/runner/smoke_last.log 에도 남긴다
        smoke_log = None
        try:
            real = core.Paths(real_root)
            real.ensure()
            smoke_log = os.path.join(real.logs, "smoke_last.log")
            io.open(smoke_log, "w", encoding="utf-8").close()
        except OSError:
            smoke_log = None
        _inner = log

        def log(msg):
            _inner(msg)
            if smoke_log:
                try:
                    with io.open(smoke_log, "a", encoding="utf-8") as f:
                        f.write("[%s] %s" % (time.strftime("%H:%M:%S"), msg) + chr(10))
                except OSError:
                    pass

    if not args.smoke and not core.acquire_single_instance(real_root):
        log("이미 실행 중인 러너가 있어 종료합니다(같은 루트 또는 이 PC 의 다른 세션)")
        if not args.headless:
            try:
                import tkinter.messagebox as mb
                import tkinter as tk
                r = tk.Tk()
                r.withdraw()
                mb.showwarning("JEIL AX 연동 러너", "이미 실행 중입니다.\n\n오른쪽 아래 트레이 아이콘을 확인하세요. "
                               "보이지 않으면 이 서버의 다른 사용자 세션(RDP)에서 떠 있을 수 있습니다 — "
                               "작업 관리자 [사용자] 탭에서 jeil_runner.exe 를 확인하세요.")
                r.destroy()
            except Exception:
                pass
        return 3

    engine = core.RunnerEngine(root, build_child_argv, log)
    if args.smoke:
        # 점검 엔진은 임시 루트에서 돈다 — 그 경고(.env 없음 등)·능력은 서버 상태가 아니므로 실제 루트 기준으로 보여 준다
        caps = core.detect_capabilities(real_root)
    else:
        caps = engine.caps
        for w in engine.warnings:
            log("설정: " + w)
    log("%s 루트=%s · 능력: supabase=%s erp=%s ms=%s gw=%s offboard=%s · .env=%s" % (
        core.RUNNER_VERSION, real_root, caps["supabase"], caps["erp"], caps["ms_account"], caps["gw_account"],
        caps["offboard"], caps.get("env_state")))

    if args.smoke:
        rc = run_smoke(engine, log, args.no_tray, real_root)
        import shutil
        shutil.rmtree(root, ignore_errors=True)
        return rc
    try:
        if args.headless:
            return run_headless(engine, log)
        hide_console()          # console 빌드라 창이 하나 뜬다 — 트레이 앱에서는 감춘다
        import runner_ui
        ui = runner_ui.RunnerWindow(engine, log, tray=not args.no_tray, hidden=False)
        engine.start()
        ui.mainloop()
        engine.stop()
        log("러너 종료")
        return 0
    finally:
        core.release_single_instance()


if __name__ == "__main__":
    sys.exit(main())
