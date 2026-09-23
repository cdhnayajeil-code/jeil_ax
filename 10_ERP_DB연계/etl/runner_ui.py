# -*- coding: utf-8 -*-
"""runner_ui.py — JEIL AX 연동 러너 창(tkinter) + 트레이 아이콘(pystray).

화면 구성은 ERP 벤더의 Schedule Runner 를 따른다(관리자가 이미 익숙한 모양):
  · 위: 작업 목록 — 상태 · ID · 이름 · 유형 · 다음 실행 · 최근 시작 · 최근 종료 · 결과 · 실행 · 평균
  · 아래: [실행 내용](돌고 있는/마지막 실행의 출력) · [실행 내역] · [연동 기준](설정)
  · 창을 닫으면 트레이로 내려가고 스케줄은 계속 돈다. 트레이 메뉴: 열기 · 일시정지/재개 · 종료.

UI 만 담당한다. 스케줄·실행·내역은 runner_core.RunnerEngine.
"""
import datetime as _dt
import os
import subprocess
import tkinter as tk
from tkinter import messagebox, ttk

import runner_core as core

APP_TITLE = "JEIL AX 연동 러너"
REFRESH_MS = 1000


def _tray_image(color):
    """트레이 아이콘 그림 — 파일 없이 PIL 로 그린다(단일 EXE 유지)."""
    from PIL import Image, ImageDraw
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((4, 4, 60, 60), radius=14, fill=(23, 43, 77, 255))       # navy
    d.ellipse((18, 18, 46, 46), fill=color)
    return img


COLOR = {"run": (46, 204, 113, 255), "pause": (243, 156, 18, 255), "fail": (231, 76, 60, 255), "idle": (149, 165, 166, 255)}


def _enable_dpi_awareness():
    """Windows 고DPI: 시스템 DPI 인식으로 선언해 비트맵 확대(흐림)를 막는다. 실패해도 무해."""
    if os.name != "nt":
        return
    try:
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)      # PROCESS_SYSTEM_DPI_AWARE
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


class RunnerWindow:
    def __init__(self, engine, log, tray=True, hidden=False):
        self.engine = engine
        self.log = log
        self.paths = engine.paths
        _enable_dpi_awareness()          # 125%/150% 화면에서 흐릿하게 확대되지 않게(픽셀 치수는 아래 s 로 보정)
        self.root = tk.Tk()
        self.s = s = max(1.0, self.root.winfo_fpixels("1i") / 96.0)
        self.root.title("%s · %s · %s" % (APP_TITLE, os.environ.get("COMPUTERNAME") or "", core.RUNNER_VERSION))
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        w, h = min(int(1180 * s), sw - 40), min(int(700 * s), sh - 90)
        self.root.geometry("%dx%d+%d+%d" % (w, h, max(0, (sw - w) // 2), max(0, (sh - h) // 3)))
        self.root.minsize(int(880 * s), int(520 * s))
        try:
            self.root.option_add("*Font", ("Malgun Gothic", 9))
        except Exception:
            pass
        self._quitting = False
        self._selected = None
        self._log_shown_for = None
        self._log_len = -1
        self._last_state_color = None
        self._snap = {"jobs": [], "paused": False, "caps": {}, "warnings": [], "running": 0}
        self.tray = None
        self.tray_ok = False
        self._build()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        if tray:
            self._setup_tray()
        if hidden:
            self.root.withdraw()
        elif engine.warnings:
            # 설정 파일 손상·.env 권한 같은 경고는 창을 띄울 때 한 번 알린다(로그에만 있으면 아무도 못 본다)
            self.root.after(600, lambda: messagebox.showwarning(APP_TITLE, "\n\n".join(engine.warnings)))
        self.refresh()

    # ─────────────── 구성 ───────────────
    def _build(self):
        style = ttk.Style(self.root)
        try:
            style.theme_use("vista")
        except Exception:
            pass
        s = self.s
        style.configure("Treeview", rowheight=int(24 * s))
        style.configure("Treeview.Heading", font=("Malgun Gothic", 9, "bold"))

        bar = ttk.Frame(self.root, padding=(6, 6, 6, 2))
        bar.pack(fill="x")
        self.btn_run = ttk.Button(bar, text="▶ 지금 실행", command=self.on_run_now)
        self.btn_stop = ttk.Button(bar, text="■ 중지", command=self.on_stop)
        self.btn_toggle = ttk.Button(bar, text="사용/해제", command=self.on_toggle)
        self.btn_pause = ttk.Button(bar, text="⏸ 전체 일시정지", command=self.on_pause)
        for b in (self.btn_run, self.btn_stop, self.btn_toggle):
            b.pack(side="left", padx=(0, 4))
        ttk.Separator(bar, orient="vertical").pack(side="left", fill="y", padx=6)
        self.btn_pause.pack(side="left", padx=(0, 4))
        ttk.Button(bar, text="📂 로그 폴더", command=lambda: _open_folder(self.paths.logs)).pack(side="left", padx=(0, 4))
        ttk.Button(bar, text="트레이로 내리기", command=self.hide).pack(side="right")

        pane = ttk.PanedWindow(self.root, orient="vertical")
        pane.pack(fill="both", expand=True, padx=6, pady=(2, 0))

        # ── 작업 목록 ──
        top = ttk.Frame(pane)
        cols = ("state", "id", "name", "type", "next", "last_start", "last_end", "result", "total", "avg")
        heads = {"state": "상태", "id": "ID", "name": "이름", "type": "유형", "next": "다음 실행",
                 "last_start": "최근 시작", "last_end": "최근 종료", "result": "결과", "total": "실행", "avg": "평균(초)"}
        widths = {"state": 66, "id": 96, "name": 190, "type": 76, "next": 136, "last_start": 136,
                  "last_end": 136, "result": 56, "total": 46, "avg": 66}
        self.tree = ttk.Treeview(top, columns=cols, show="headings", selectmode="browse", height=7)
        for c in cols:
            self.tree.heading(c, text=heads[c])
            self.tree.column(c, width=int(widths[c] * s), minwidth=int(widths[c] * s * 0.6),
                             anchor="center" if c in ("state", "type", "result", "total", "avg") else "w",
                             stretch=(c == "name"))
        self.tree.tag_configure("running", background="#dff5e3")
        self.tree.tag_configure("fail", background="#fde2e0")
        self.tree.tag_configure("off", foreground="#8a8f98")
        self.tree.tag_configure("paused", foreground="#8a6d00")
        vs = ttk.Scrollbar(top, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vs.set)
        self.tree.pack(side="left", fill="both", expand=True)
        vs.pack(side="right", fill="y")
        self.tree.bind("<<TreeviewSelect>>", self.on_select)
        self.tree.bind("<Double-1>", lambda e: self.on_run_now())
        pane.add(top, weight=3)

        # ── 하단 탭 ──
        self.nb = ttk.Notebook(pane)
        pane.add(self.nb, weight=4)

        f1 = ttk.Frame(self.nb, padding=4)
        self.nb.add(f1, text="  실행 내용  ")
        head = ttk.Frame(f1)
        head.pack(fill="x")
        self.lbl_log = ttk.Label(head, text="작업을 선택하세요")
        self.lbl_log.pack(side="left")
        self.autoscroll = tk.BooleanVar(value=True)
        ttk.Checkbutton(head, text="자동 스크롤", variable=self.autoscroll).pack(side="right")
        ttk.Button(head, text="파일 열기", command=self.on_open_log).pack(side="right", padx=4)
        self.txt = tk.Text(f1, wrap="none", font=("Consolas", 9), state="disabled", background="#fbfbfb")
        ys = ttk.Scrollbar(f1, orient="vertical", command=self.txt.yview)
        xs = ttk.Scrollbar(f1, orient="horizontal", command=self.txt.xview)
        self.txt.configure(yscrollcommand=ys.set, xscrollcommand=xs.set)
        ys.pack(side="right", fill="y")
        xs.pack(side="bottom", fill="x")
        self.txt.pack(fill="both", expand=True)

        f2 = ttk.Frame(self.nb, padding=4)
        self.nb.add(f2, text="  실행 내역  ")
        hbar = ttk.Frame(f2)
        hbar.pack(fill="x", pady=(0, 4))
        self.hide_idle = tk.BooleanVar(value=True)
        ttk.Checkbutton(hbar, text="할 일 없던 회차 숨기기", variable=self.hide_idle,
                        command=lambda: self.refresh_hist(force=True)).pack(side="left")
        ttk.Label(hbar, text="더블클릭 = 그 실행의 로그 열기", foreground="#5b6470").pack(side="right")
        hwrap = ttk.Frame(f2)
        hwrap.pack(fill="both", expand=True)
        hcols = ("start", "job", "status", "secs", "summary")
        self.hist = ttk.Treeview(hwrap, columns=hcols, show="headings", selectmode="browse")
        for c, t, w in (("start", "시작", 140), ("job", "작업", 180), ("status", "결과", 60), ("secs", "소요(초)", 70), ("summary", "요약", 500)):
            self.hist.heading(c, text=t)
            self.hist.column(c, width=int(w * s), anchor="center" if c in ("status", "secs") else "w", stretch=(c == "summary"))
        self.hist.tag_configure("fail", background="#fde2e0")
        self.hist.tag_configure("stopped", background="#fff3d6")
        hs = ttk.Scrollbar(hwrap, orient="vertical", command=self.hist.yview)
        self.hist.configure(yscrollcommand=hs.set)
        self.hist.pack(side="left", fill="both", expand=True)
        hs.pack(side="right", fill="y")
        self.hist.bind("<Double-1>", self.on_open_hist_log)
        self._hist_rows = []
        self._hist_key = None

        f3 = ttk.Frame(self.nb, padding=4)
        self.nb.add(f3, text="  연동 기준  ")
        self.settings = SettingsPanel(f3, self)

        # ── 상태줄 ──
        self.status = ttk.Label(self.root, anchor="w", padding=(8, 3), relief="sunken")
        self.status.pack(fill="x", side="bottom")

    def _setup_tray(self):
        try:
            import pystray
        except Exception as e:
            self.log("트레이 아이콘 사용 불가(창만 사용): %s" % str(e)[:120])
            return
        try:
            menu = pystray.Menu(
                pystray.MenuItem("열기", self._tray_open, default=True),
                pystray.MenuItem("전체 일시정지", self._tray_pause, checked=lambda item: bool(self.engine.cfg["paused"])),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem("종료", self._tray_quit),
            )
            self.tray = pystray.Icon("jeil_runner", _tray_image(COLOR["idle"]), APP_TITLE, menu)
            self.tray.run_detached()
            self.tray_ok = True
        except Exception as e:
            self.log("트레이 아이콘 생성 실패(창만 사용): %s" % str(e)[:160])
            self.tray = None
            self.tray_ok = False

    # ─────────────── 트레이 콜백(다른 스레드 → Tk 스레드로 넘긴다) ───────────────
    def _tray_open(self, icon=None, item=None):
        self.root.after(0, self.show)

    def _tray_pause(self, icon=None, item=None):
        self.root.after(0, self.on_pause)

    def _tray_quit(self, icon=None, item=None):
        self.root.after(0, self.quit)

    # ─────────────── 창 동작 ───────────────
    def show(self):
        self.root.deiconify()
        self.root.lift()
        try:
            self.root.focus_force()
        except Exception:
            pass

    def hide(self):
        if self.tray_ok:
            self.root.withdraw()
        else:
            self.root.iconify()

    def on_close(self):
        if self.tray_ok:
            self.hide()
            return
        if messagebox.askyesno(APP_TITLE, "트레이 아이콘이 없어 창을 닫으면 러너가 종료됩니다.\n종료할까요?"):
            self.quit()

    def quit(self):
        if self._quitting:
            return
        snap = self.engine.snapshot()
        if snap["running"]:
            # 트레이로 내려간 상태에서도 반드시 묻는다 — 창을 먼저 띄워 무엇이 도는지 보이게
            self.show()
            names = ", ".join(r["name"] for r in snap["jobs"] if r["running"])
            if not messagebox.askyesno(APP_TITLE, "실행 중인 작업이 있습니다: %s\n\n러너를 닫으면 이 작업을 강제로 끝냅니다(내역에 「중지됨」으로 남음).\n닫을까요?" % names):
                return
        self._quitting = True
        try:
            if self.tray:
                self.tray.stop()
        except Exception:
            pass
        self.root.after(0, self.root.quit)

    def destroy(self):
        self._quitting = True
        self._cancel_refresh()
        try:
            if self.tray:
                self.tray.stop()
        except Exception:
            pass
        try:
            self.root.destroy()
        except Exception:
            pass

    def mainloop(self):
        self.root.mainloop()
        self._cancel_refresh()
        try:
            self.root.destroy()
        except Exception:
            pass

    # ─────────────── 버튼 ───────────────
    def _sel_id(self):
        sel = self.tree.selection()
        return sel[0] if sel else None

    def on_select(self, _e=None):
        self._selected = self._sel_id()
        self._log_shown_for = None
        self.refresh_log(force=True)

    def on_run_now(self):
        jid = self._sel_id()
        if not jid:
            return
        ok, msg = self.engine.run_now(jid)
        if not ok:
            messagebox.showinfo(APP_TITLE, msg)
        self.refresh()

    def on_stop(self):
        jid = self._sel_id()
        if not jid:
            return
        if not messagebox.askyesno(APP_TITLE, (
                "실행 중인 작업을 프로세스째 강제 종료합니다.\n\n"
                "· 결의전표 전송 중이면: 커밋 전 전표는 ERP 트랜잭션이 되돌려지고, 선점 상태는 30분 뒤 대기로 돌아갑니다"
                "(같은 초안은 중복 투입 확인으로 두 번 들어가지 않습니다).\n"
                "· 데이터 업데이트 중이면: 요청은 「실행 중」으로 남았다가 서버 정리(최대 2시간) 뒤 실패로 닫힙니다.\n"
                "· 작업마다 「시간 상한(분)」을 넘기면 러너가 같은 방식으로 자동 종료하고 「실패(시간 초과)」로 남깁니다.\n\n계속할까요?")):
            return
        ok, msg = self.engine.stop_job(jid)
        if not ok:
            messagebox.showinfo(APP_TITLE, msg)
        self.refresh()

    def on_toggle(self):
        jid = self._sel_id()
        if not jid:
            return
        st = self.engine.jobs.get(jid)
        if st:
            self.engine.set_enabled(jid, not st.cfg.get("enabled", True))
            self.settings.reload()
            self.refresh()

    def on_pause(self):
        self.engine.set_paused(not self.engine.cfg["paused"])
        self.refresh()

    def _open_log(self, path):
        rp = core.safe_log_path(self.paths, path)
        if not rp:
            if path:
                self.log("로그 열기 거부(러너 로그 폴더 밖 또는 없음): %s" % str(path)[:160])
            messagebox.showinfo(APP_TITLE, "이 실행의 로그 파일이 없거나, 러너 로그 폴더 밖의 경로라 열지 않습니다.")
            return
        try:
            # 뷰어를 고정한다 — 파일 연결(확장자)에 따라 무엇이 실행될지 모르는 os.startfile 을 쓰지 않는다
            subprocess.Popen(["notepad.exe", rp], creationflags=core.CREATE_NO_WINDOW if os.name == "nt" else 0)
        except Exception as e:
            messagebox.showinfo(APP_TITLE, "열 수 없습니다: %s" % str(e)[:120])

    def on_open_log(self):
        row = self._row_for(self._selected)
        if row:
            self._open_log(row.get("log"))

    def on_open_hist_log(self, _e=None):
        sel = self.hist.selection()
        if not sel:
            return
        try:
            rec = self._hist_rows[int(sel[0])]
        except (ValueError, IndexError):
            return
        self._open_log(rec.get("log"))

    # ─────────────── 갱신 ───────────────
    def _row_for(self, jid):
        for r in self._snap["jobs"]:
            if r["id"] == jid:
                return r
        return None

    def refresh(self):
        if self._quitting:
            return
        try:
            self._snap = snap = self.engine.snapshot()
            self._refresh_tree(snap)
            self._refresh_status(snap)
            self._refresh_tray(snap)
            tab = self.nb.index(self.nb.select()) if self.nb.tabs() else 0
            if tab == 0:
                self.refresh_log()
            elif tab == 1:
                self.refresh_hist()
        except Exception as e:
            self.log("화면 갱신 오류: %s" % str(e)[:160])
        self._after_id = self.root.after(REFRESH_MS, self.refresh)

    def _cancel_refresh(self):
        # 창을 없앤 뒤 예약된 갱신이 불리면 Tcl 이 「invalid command name」을 찍는다 — 닫기 전에 취소
        aid, self._after_id = getattr(self, "_after_id", None), None
        if aid:
            try:
                self.root.after_cancel(aid)
            except Exception:
                pass

    def _refresh_tree(self, snap):
        existing = set(self.tree.get_children())
        keep = set()
        for r in snap["jobs"]:
            tags = ()
            if r["running"]:
                tags = ("running",)
            elif not r["enabled"]:
                tags = ("off",)
            elif r["result"] == core.STATUS_FAIL:
                tags = ("fail",)
            elif snap["paused"]:
                tags = ("paused",)
            vals = (r["state"], r["id"], r["name"], r["type"], core.fmt_dt(r["next"]),
                    core.fmt_dt(r["last_start"]), core.fmt_dt(r["last_end"]), r["result"],
                    r["total_exec"], "%.1f" % r["avg_secs"])
            if r["id"] in existing:
                self.tree.item(r["id"], values=vals, tags=tags)
            else:
                self.tree.insert("", "end", iid=r["id"], values=vals, tags=tags)
            keep.add(r["id"])
        for iid in existing - keep:
            self.tree.delete(iid)
        if not self.tree.selection() and snap["jobs"]:
            self.tree.selection_set(snap["jobs"][0]["id"])
            self._selected = snap["jobs"][0]["id"]
        self.btn_pause.configure(text="▶ 전체 재개" if snap["paused"] else "⏸ 전체 일시정지")

    def _refresh_status(self, snap):
        caps = snap["caps"]
        cap_txt = " · ".join(k for k, v in (("Supabase", caps.get("supabase")), ("ERP", caps.get("erp")),
                                             ("MS계정", caps.get("ms_account")), ("그룹웨어", caps.get("gw_account")),
                                             ("퇴사처리", caps.get("offboard"))) if v) or "연결정보 없음"
        warn = ("⚠ 경고 %d건(연동 기준 탭)  ·  " % len(snap["warnings"])) if snap.get("warnings") else ""
        self.status.configure(text="%s스케줄 %s  ·  실행중 %d  ·  가능: %s  ·  루트 %s  ·  %s" % (
            warn, "일시정지" if snap["paused"] else "가동", snap["running"], cap_txt, self.paths.root,
            _dt.datetime.now().strftime("%H:%M:%S")))

    def _refresh_tray(self, snap):
        if not self.tray_ok:
            return
        if snap["running"]:
            c = "run"
        elif snap["paused"]:
            c = "pause"
        elif any(r["result"] == core.STATUS_FAIL for r in snap["jobs"]):
            c = "fail"
        else:
            c = "idle"
        if c != self._last_state_color:
            self._last_state_color = c
            try:
                self.tray.icon = _tray_image(COLOR[c])
                self.tray.title = "%s — %s%s" % (APP_TITLE, "일시정지" if snap["paused"] else "가동",
                                                  (" · 실행중 %d" % snap["running"]) if snap["running"] else "")
            except Exception:
                pass

    def refresh_log(self, force=False):
        row = self._row_for(self._selected) if self._selected else None
        if not row:
            return
        raw = row.get("log")
        path = core.safe_log_path(self.paths, raw)
        label = "%s — %s%s" % (row["name"], row["result"], (" · " + os.path.basename(path)) if path else "")
        self.lbl_log.configure(text=label)
        if not path:
            self._set_text("(로그 없음)" if raw else "(아직 실행 기록이 없습니다)")
            self._log_shown_for = None
            return
        try:
            size = os.path.getsize(path)
        except OSError:
            size = -1
        if not force and path == self._log_shown_for and size == self._log_len:
            return
        self._log_shown_for, self._log_len = path, size
        self._set_text(core.tail_text(path))

    def _set_text(self, s):
        self.txt.configure(state="normal")
        self.txt.delete("1.0", "end")
        self.txt.insert("end", s)
        self.txt.configure(state="disabled")
        if self.autoscroll.get():
            self.txt.see("end")

    def refresh_hist(self, force=False):
        key = (self.engine.history_stamp(), self.hide_idle.get())
        if not force and key == self._hist_key:
            return                               # 파일이 그대로면 다시 읽지 않는다
        self._hist_key = key
        rows = self.engine.history(300, include_idle=not self.hide_idle.get())
        self._hist_rows = rows
        self.hist.delete(*self.hist.get_children())
        for i, r in enumerate(rows):
            tag = "fail" if r.get("status") == core.STATUS_FAIL else ("stopped" if r.get("status") == core.STATUS_STOPPED else "")
            self.hist.insert("", "end", iid=str(i), tags=(tag,) if tag else (),
                             values=((str(r.get("start") or "")).replace("T", " "), r.get("name") or r.get("job"),
                                     r.get("status"), r.get("secs"), r.get("summary") or ""))


# ─────────────────────────────── 설정 패널 ───────────────────────────────
class SettingsPanel:
    """「연동 기준」 탭 — 설정 파일(runner_config.json)을 창에서 고친다. 저장 시 엔진에 반영."""

    def __init__(self, parent, win):
        self.win = win
        self.engine = win.engine
        self.parent = parent
        self.rows = []
        bar = ttk.Frame(parent)
        bar.pack(fill="x", pady=(0, 4))
        ttk.Button(bar, text="💾 저장(적용)", command=self.save).pack(side="left")
        ttk.Button(bar, text="되돌리기", command=self.reload).pack(side="left", padx=4)
        ttk.Button(bar, text="+ 배치 작업 추가", command=self.add_batch).pack(side="left", padx=4)
        ttk.Button(bar, text="기본 작업 복원", command=self.restore_defaults).pack(side="left", padx=4)
        ttk.Label(bar, text="로그 보관(일)").pack(side="right")
        self.keep_days = tk.StringVar()
        ttk.Spinbox(bar, from_=1, to=365, width=5, textvariable=self.keep_days).pack(side="right", padx=(0, 8))
        self.msg = ttk.Label(parent, foreground="#8a6d00", wraplength=int(1100 * win.s), justify="left")
        self.msg.pack(fill="x")

        canvas = tk.Canvas(parent, highlightthickness=0)
        vs = ttk.Scrollbar(parent, orient="vertical", command=canvas.yview)
        self.inner = ttk.Frame(canvas)
        self.inner.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.create_window((0, 0), window=self.inner, anchor="nw")
        canvas.configure(yscrollcommand=vs.set)
        canvas.pack(side="left", fill="both", expand=True)
        vs.pack(side="right", fill="y")
        self.canvas = canvas
        # 마우스 휠 — 포인터가 설정 영역 위에 있을 때만 캔버스를 스크롤(다른 표와 충돌 방지)
        canvas.bind("<Enter>", lambda e: canvas.bind_all("<MouseWheel>", self._on_wheel))
        canvas.bind("<Leave>", lambda e: canvas.unbind_all("<MouseWheel>"))
        self._etl_jobs = self._load_etl_job_names()
        self.reload()

    def _on_wheel(self, e):
        try:
            self.canvas.yview_scroll(int(-e.delta / 120), "units")
        except Exception:
            pass

    @staticmethod
    def _load_etl_job_names():
        try:
            import etl_run
            return list(etl_run.JOBS.keys())
        except Exception:
            return []

    def reload(self):
        for w in self.inner.winfo_children():
            w.destroy()
        self.rows = []
        cfg = self.engine.cfg
        self.keep_days.set(str(cfg.get("log_keep_days", 30)))
        for j in cfg["jobs"]:
            self._add_row(core._deep_copy(j))
        self.msg.configure(text="\n".join("⚠ " + w for w in self.engine.warnings))

    def add_batch(self):
        n = 1
        ids = {r["id_var"].get() for r in self.rows}
        while "etl_batch_%d" % n in ids:
            n += 1
        self._add_row({"id": "etl_batch_%d" % n, "kind": "etl_batch", "name": "ERP→중간DB 배치 %d" % n,
                       "enabled": False, "schedule": {"type": "daily", "time": "03:00"},
                       "params": {"jobs": [], "include_sensitive": False, "full": False, "dry_run": False}, "keep_log": True,
                       "timeout_min": core.JOB_KINDS["etl_batch"]["timeout_min"]})

    def restore_defaults(self):
        have = {r["id_var"].get() for r in self.rows}
        added = core.missing_default_jobs({"jobs": [{"id": i} for i in have]})
        for j in added:
            self._add_row(j)
        self.msg.configure(text=("기본 작업 %d개를 꺼진 상태로 추가했습니다 — 확인 후 「사용」 체크 → [저장(적용)]" % len(added))
                           if added else "기본 작업이 모두 있습니다")

    def _add_row(self, j):
        kind = j["kind"]
        meta = core.JOB_KINDS[kind]
        caps = self.engine.caps
        box = ttk.LabelFrame(self.inner, text=" %s — %s " % (j["id"], meta["label"]), padding=6)
        box.pack(fill="x", padx=4, pady=4)
        r = {"id_var": tk.StringVar(value=j["id"]), "kind": kind, "frame": box}
        g = ttk.Frame(box)
        g.pack(fill="x")
        r["enabled"] = tk.BooleanVar(value=bool(j.get("enabled", True)))
        ttk.Checkbutton(g, text="사용", variable=r["enabled"]).grid(row=0, column=0, sticky="w")
        ttk.Label(g, text="이름").grid(row=0, column=1, sticky="e", padx=(12, 2))
        r["name"] = tk.StringVar(value=j.get("name", meta["label"]))
        ttk.Entry(g, textvariable=r["name"], width=28).grid(row=0, column=2, sticky="w")
        ttk.Label(g, text="유형").grid(row=0, column=3, sticky="e", padx=(12, 2))
        sch = j.get("schedule") or {}
        r["stype"] = tk.StringVar(value="매일 정시" if sch.get("type") == "daily" else "반복(초)")
        ttk.Combobox(g, textvariable=r["stype"], values=("반복(초)", "매일 정시"), width=9, state="readonly").grid(row=0, column=4)
        r["seconds"] = tk.StringVar(value=str(sch.get("seconds", 60)))
        r["time"] = tk.StringVar(value=str(sch.get("time", "02:00")))
        ttk.Label(g, text="주기(초)").grid(row=0, column=5, sticky="e", padx=(12, 2))
        ttk.Spinbox(g, from_=10, to=86400, increment=10, width=7, textvariable=r["seconds"]).grid(row=0, column=6)
        ttk.Label(g, text="시각(HH:MM)").grid(row=0, column=7, sticky="e", padx=(12, 2))
        ttk.Entry(g, textvariable=r["time"], width=7).grid(row=0, column=8)
        r["keep_log"] = tk.BooleanVar(value=bool(j.get("keep_log", True)))
        ttk.Checkbutton(g, text="로그 저장", variable=r["keep_log"]).grid(row=0, column=9, padx=(12, 0))
        ttk.Label(g, text="시간 상한(분)").grid(row=0, column=10, sticky="e", padx=(12, 2))
        r["timeout"] = tk.StringVar(value=str(j.get("timeout_min") or meta["timeout_min"]))
        ttk.Spinbox(g, from_=1, to=1440, increment=10, width=5, textvariable=r["timeout"]).grid(row=0, column=11)
        ttk.Button(g, text="삭제", width=5, command=lambda: self._remove(r)).grid(row=0, column=12, padx=(12, 0))

        p = ttk.Frame(box)
        p.pack(fill="x", pady=(6, 0))
        params = j.get("params") or {}
        ttk.Label(p, text=meta["desc"], foreground="#5b6470").grid(row=0, column=0, columnspan=8, sticky="w", pady=(0, 4))
        if kind == "relay_queue":
            ttk.Label(p, text="1회 처리 상한(건)").grid(row=1, column=0, sticky="w")
            r["max"] = tk.StringVar(value=str(params.get("max", 5)))
            ttk.Spinbox(p, from_=1, to=50, width=5, textvariable=r["max"]).grid(row=1, column=1, sticky="w", padx=(4, 12))
        elif kind == "etl_sync":
            # 「포함」은 없다 — 호스트 능력이 상한이라 「자동」과 같기 때문. 사람은 「제외」로 끄기만 한다.
            ttk.Label(p, text="계정 수집(MS·그룹웨어)").grid(row=1, column=0, sticky="w")
            r["collectors"] = tk.StringVar(value="제외" if params.get("collectors") in (False, "off") else "자동")
            ttk.Combobox(p, textvariable=r["collectors"], values=("자동", "제외"), width=6, state="readonly").grid(row=1, column=1, padx=(4, 12))
            ttk.Label(p, text="퇴사 처리(브라우저)").grid(row=1, column=2, sticky="w")
            r["offboard"] = tk.StringVar(value="제외" if params.get("offboard") in (False, "off") else "자동")
            ttk.Combobox(p, textvariable=r["offboard"], values=("자동", "제외"), width=6, state="readonly").grid(row=1, column=3, padx=(4, 12))
            r["full"] = tk.BooleanVar(value=bool(params.get("full", False)))
            ttk.Checkbutton(p, text="전량 재적재(증분 무시)", variable=r["full"]).grid(row=1, column=4, sticky="w")
            r["allow_sensitive"] = tk.BooleanVar(value=bool(params.get("allow_sensitive", False)))
            ttk.Checkbutton(p, text="급여(민감) 포함 요청도 처리", variable=r["allow_sensitive"]).grid(row=1, column=5, sticky="w", padx=(12, 0))
            can = "이 호스트: 계정수집 %s · 퇴사처리 %s" % (
                "·".join(n for n in core.COLLECTOR_NAMES if caps.get(n)) or "불가",
                "가능" if caps.get("offboard") else "불가(브라우저·그룹웨어 접속정보 없음 — 퇴사 큐를 보지 않음)")
            ttk.Label(p, text=can, foreground="#5b6470").grid(row=2, column=0, columnspan=8, sticky="w", pady=(4, 0))
        elif kind == "proposal_ledger":
            # 대장 경로는 보통 .env(PROPOSAL_LEDGER_XLSX)에 둔다. 여기 칸은 그 호스트에서만
            # 다른 파일을 쓸 때의 예외용 — 비워 두면 .env 값을 쓴다.
            ttk.Label(p, text="대장 파일(비우면 .env)").grid(row=1, column=0, sticky="w")
            r["file"] = tk.StringVar(value=str(params.get("file") or ""))
            ttk.Entry(p, textvariable=r["file"], width=52).grid(row=1, column=1, columnspan=3, sticky="w", padx=(4, 12))
            ttk.Label(p, text="스캔 대사 CSV(선택)").grid(row=2, column=0, sticky="w")
            r["scan"] = tk.StringVar(value=str(params.get("scan") or ""))
            ttk.Entry(p, textvariable=r["scan"], width=52).grid(row=2, column=1, columnspan=3, sticky="w", padx=(4, 12))
            r["dry_run"] = tk.BooleanVar(value=bool(params.get("dry_run", False)))
            ttk.Checkbutton(p, text="리허설(dry-run · 읽기만, 적재 안 함)", variable=r["dry_run"]).grid(row=3, column=1, sticky="w", padx=(4, 0))
            r["append"] = tk.BooleanVar(value=bool(params.get("append", False)))
            ttk.Checkbutton(p, text="전량 교체하지 않음(덮어쓰기만)", variable=r["append"]).grid(row=3, column=2, sticky="w")
            seen = "보임" if caps.get("proposal_ledger") else "안 보임 — .env 의 PROPOSAL_LEDGER_XLSX 를 확인하세요"
            ttk.Label(p, text="이 호스트에서 대장 파일: " + seen, foreground="#5b6470").grid(
                row=4, column=0, columnspan=8, sticky="w", pady=(4, 0))
        elif kind == "etl_batch":
            ttk.Label(p, text="대상 job (선택 없음 = 전체)").grid(row=1, column=0, sticky="nw")
            lb = tk.Listbox(p, selectmode="multiple", height=6, width=24, exportselection=False)
            for name in self._etl_jobs:
                lb.insert("end", name)
            chosen = set(params.get("jobs") or [])
            for i, name in enumerate(self._etl_jobs):
                if name in chosen:
                    lb.selection_set(i)
            lb.grid(row=1, column=1, rowspan=3, sticky="w", padx=(4, 12))
            r["jobs_lb"] = lb
            r["include_sensitive"] = tk.BooleanVar(value=bool(params.get("include_sensitive", False)))
            ttk.Checkbutton(p, text="급여(민감 스키마) 포함", variable=r["include_sensitive"]).grid(row=1, column=2, sticky="w")
            r["full"] = tk.BooleanVar(value=bool(params.get("full", False)))
            ttk.Checkbutton(p, text="전량 재적재(증분 무시)", variable=r["full"]).grid(row=2, column=2, sticky="w")
            r["dry_run"] = tk.BooleanVar(value=bool(params.get("dry_run", False)))
            ttk.Checkbutton(p, text="리허설(dry-run · 추출 건수만, 적재 안 함)", variable=r["dry_run"]).grid(row=2, column=3, sticky="w", padx=(12, 0))
            ttk.Label(p, text="같은 종류(etl) 작업은 동시에 돌지 않습니다 — 배치가 도는 동안 요청 처리는 쉬었다가 끝나면 이어갑니다",
                      foreground="#8a6d00").grid(row=3, column=2, columnspan=4, sticky="w")
        for i, note in enumerate(core.param_warnings(j, caps)):
            ttk.Label(box, text="⚠ " + note, foreground="#b54708").pack(fill="x", anchor="w", pady=(2 if i else 6, 0))
        self.rows.append(r)

    def _remove(self, r):
        st = self.engine.jobs.get(r["id_var"].get())
        if st and st.running:
            messagebox.showinfo(APP_TITLE, "실행 중인 작업은 삭제할 수 없습니다.")
            return
        r["frame"].destroy()
        self.rows.remove(r)

    def collect(self):
        jobs = []
        for r in self.rows:
            sch = {"type": "daily", "time": r["time"].get().strip()} if r["stype"].get() == "매일 정시" \
                else {"type": "interval", "seconds": r["seconds"].get().strip()}
            params = {}
            if r["kind"] == "relay_queue":
                params["max"] = r["max"].get()
            elif r["kind"] == "etl_sync":
                params = {"collectors": "off" if r["collectors"].get() == "제외" else "auto",
                          "offboard": "off" if r["offboard"].get() == "제외" else "auto",
                          "full": r["full"].get(), "allow_sensitive": r["allow_sensitive"].get()}
            elif r["kind"] == "etl_batch":
                lb = r["jobs_lb"]
                params = {"jobs": [lb.get(i) for i in lb.curselection()],
                          "include_sensitive": r["include_sensitive"].get(), "full": r["full"].get(),
                          "dry_run": r["dry_run"].get()}
            elif r["kind"] == "proposal_ledger":
                params = {"file": r["file"].get().strip(), "scan": r["scan"].get().strip(),
                          "dry_run": r["dry_run"].get(), "append": r["append"].get()}
            elif r["kind"] == "noop":
                st = self.engine.jobs.get(r["id_var"].get())
                params = dict((st.cfg.get("params") if st else {}) or {})
            jobs.append({"id": r["id_var"].get(), "kind": r["kind"], "name": r["name"].get().strip(),
                         "enabled": r["enabled"].get(), "schedule": sch, "params": params, "keep_log": r["keep_log"].get(),
                         "timeout_min": r["timeout"].get().strip()})
        return {"version": 1, "paused": bool(self.engine.cfg["paused"]),
                "log_keep_days": self.keep_days.get(),
                "history_keep": self.engine.cfg.get("history_keep", core.DEFAULT_CONFIG["history_keep"]), "jobs": jobs}

    def save(self):
        cfg = self.collect()
        warns = self.engine.update_config(cfg)
        self.reload()
        self.msg.configure(text=("저장됨 — 다음 실행부터 적용\n" + "\n".join("⚠ " + w for w in warns)) if warns
                           else "저장됨 — 다음 실행부터 적용")
        self.win.refresh_hist(force=True)


def _open_folder(path):
    try:
        os.makedirs(path, exist_ok=True)
        subprocess.Popen(["explorer.exe", os.path.realpath(path)])
    except Exception as e:
        messagebox.showinfo(APP_TITLE, "열 수 없습니다: %s" % str(e)[:120])
