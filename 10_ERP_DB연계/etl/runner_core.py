# -*- coding: utf-8 -*-
"""runner_core.py — JEIL AX 연동 러너 핵심(설정·스케줄·자식 실행·내역). UI 는 runner_ui.py.

왜 있는가(REQ-0046, 2026-09-11):
  ERP 서버에는 결의전표 릴레이(gl_relay.exe)만 있고 그것도 수동 실행이었다. ERP→중간DB ETL
  (etl_watch.py)은 관리자 PC 에서 사람이 띄울 때만 돌아 화면 [데이터 업데이트] 요청이 방치됐다.
  ERP 벤더의 Schedule Runner 처럼 **눈에 보이고 손으로 켜고 끄는** 상주 앱이 필요했다.

설계
  · 작업(job)은 이 러너 **자기 자신을 자식 프로세스로** 띄워 돌린다(`jeil_runner --job …`).
    한 작업이 죽어도 러너·다른 작업은 산다.
  · 자식은 Windows **작업 개체(Job Object)** 에 넣는다. [중지]·시간 초과·러너 종료는 작업 개체째 끝내므로
    PyInstaller onefile 의 [부트로더 → 실제 파이썬] 2단 구조에서도 **프로세스 트리 전체**가 멈춘다.
    러너가 강제 종료돼도 작업 개체 핸들이 닫히며 자식이 함께 끝난다(KILL_ON_JOB_CLOSE).
  · 자식의 출력은 파이프가 아니라 **로그 파일**로 남긴다(`logs\\runner\\runs\\<job>\\<시각>.log`).
  · 상태 파일: `runner_config.json`(연동 기준) · `runner_history.jsonl`(실행 내역, append) ·
    `runner_running.json`(지금 도는 실행 — 러너가 로그오프·강제 종료로 사라져도 다음 기동 때 「비정상 종료」로 기록).
  · 같은 group(etl) 작업은 동시에 돌지 않는다. 릴레이(relay)와 ETL(etl)은 독립.
  · 한 루트에는 러너 **하나만** — 루트 잠금 파일 + 전역 뮤텍스(다른 RDP 세션에서 두 번째가 뜨지 않게).
  · **비밀값을 다루지 않는다.** `.env` 는 키가 *있는지만* 본다. 이 프로세스의 환경변수에 넣지 않으며,
    자식이 매 실행마다 `.env` 를 새로 읽는다 — 키를 회전하면 다음 회차부터 반영된다.

이 모듈에는 DB/비즈니스 로직이 없다. 작업의 실체는 gl_apply_demo2 · etl_watch · etl_run 이다.
"""
import collections
import ctypes
import datetime as _dt
import io
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time

RUNNER_VERSION = "r1.3"
CONFIG_NAME = "runner_config.json"
HISTORY_NAME = "runner_history.jsonl"
RUNNING_NAME = "runner_running.json"
MUTEX_NAME = "Global\\JEIL_AX_Runner_SingleInstance"

CREATE_NO_WINDOW = 0x08000000
CREATE_SUSPENDED = 0x00000004
KILL_EXIT_CODE = 0x4A58                 # 러너가 끝낸 자식의 종료 코드 — 자연 종료(0·1)와 구분한다

HOUSEKEEP_EVERY_SEC = 6 * 3600          # 상주 러너도 주기적으로 내역·로그를 정리한다(부팅 때만 하면 무한 증가)
HISTORY_TAIL_BYTES = 1024 * 1024        # 창의 내역 조회는 파일 끝만 읽는다

# 작업 ID = 로그 폴더 이름. 경로 문자·예약어를 막는다(설정 파일 손편집으로 runs 밖에 쓰지 못하게).
ID_RE = re.compile(r"[A-Za-z0-9_\-]{1,40}")
_RESERVED_IDS = {"CON", "PRN", "AUX", "NUL"} | {"COM%d" % i for i in range(1, 10)} | {"LPT%d" % i for i in range(1, 10)}

# 「할 일이 없던 회차」 표식 — 자식 출력의 마지막 줄. 이런 회차는 로그를 작업별 마지막 1개만 남기고
# 창의 [실행 내역] 에서 기본으로 숨긴다(60초 주기 × 2작업 = 하루 2,880회차가 쌓이지 않게).
IDLE_MARKERS = ("전송 대기 건이 없습니다", "대기 요청 없음")

COLLECTOR_NAMES = ("ms_account", "gw_account")

# 작업 종류 — 자식 프로세스가 실제로 무엇을 부르는지는 jeil_runner.run_child() 가 안다.
# timeout_min: 실행 시간 상한(분). 넘으면 트리째 끝내고 「실패(시간 초과)」 — 자식이 멈추면 그 그룹이 영영 막히지 않게.
JOB_KINDS = {
    "relay_queue": {"label": "결의전표 ERP 전송(큐)", "group": "relay", "timeout_min": 30,
                    "desc": "화면 [ERP 전송] 대기 건을 ERP(DEMO2)에 투입 — gl_relay --queue 와 동일"},
    "etl_sync":    {"label": "데이터 업데이트 요청 처리", "group": "etl", "timeout_min": 120,
                    "desc": "화면 [데이터 업데이트] 요청을 집어 ERP→중간DB 적재 — etl_watch --once 와 동일(이 호스트가 할 수 있는 범위만)"},
    "etl_batch":   {"label": "ERP→중간DB 배치", "group": "etl", "timeout_min": 240,
                    "desc": "정해진 시각에 ERP job 전체(또는 선택) 적재 — etl_run"},
    "noop":        {"label": "점검용 더미", "group": "test", "timeout_min": 10,
                    "desc": "아무것도 하지 않고 몇 줄 출력 — 러너 자체 점검용"},
}

# 종류별로 받는 파라미터(화이트리스트). 모르는 키는 버린다 — 명령줄·로그에 흘러가지 않게.
PARAM_KEYS = {
    "relay_queue": ("max",),
    "etl_sync": ("collectors", "offboard", "full", "allow_sensitive"),
    "etl_batch": ("jobs", "include_sensitive", "full", "dry_run"),
    "noop": ("lines", "sleep", "rc"),
}

DEFAULT_JOBS = [
    {"id": "relay_queue", "kind": "relay_queue", "name": "결의전표 ERP 전송(큐)", "enabled": True,
     "schedule": {"type": "interval", "seconds": 60}, "params": {"max": 5}, "keep_log": True, "timeout_min": 30},
    {"id": "etl_sync", "kind": "etl_sync", "name": "데이터 업데이트 요청 처리", "enabled": True,
     "schedule": {"type": "interval", "seconds": 60},
     "params": {"collectors": "auto", "offboard": "auto", "full": False, "allow_sensitive": False},
     "keep_log": True, "timeout_min": 120},
    {"id": "etl_nightly", "kind": "etl_batch", "name": "ERP→중간DB 야간 전체 배치", "enabled": False,
     "schedule": {"type": "daily", "time": "02:00"},
     "params": {"jobs": [], "include_sensitive": False, "full": False, "dry_run": False},
     "keep_log": True, "timeout_min": 240},
]

DEFAULT_CONFIG = {
    "version": 1,
    "paused": False,
    "log_keep_days": 30,
    "history_keep": 20000,
    "jobs": DEFAULT_JOBS,
}

STATUS_OK, STATUS_FAIL, STATUS_STOPPED, STATUS_RUNNING = "성공", "실패", "중지됨", "실행중"


# ─────────────────────────────── 경로 ───────────────────────────────
class Paths:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.config = os.path.join(self.root, CONFIG_NAME)
        self.history = os.path.join(self.root, HISTORY_NAME)
        self.running = os.path.join(self.root, RUNNING_NAME)
        self.logs = os.path.join(self.root, "logs", "runner")
        self.runs = os.path.join(self.logs, "runs")
        self.lock = os.path.join(self.logs, "runner.lock")

    @property
    def runner_log(self):
        # 상주 중 달이 바뀌어도 새 달 파일에 쓴다
        return os.path.join(self.logs, "runner_%s.log" % _dt.datetime.now().strftime("%Y%m"))

    def ensure(self):
        os.makedirs(self.runs, exist_ok=True)


def default_root():
    """러너 데이터 루트 = `.env` 가 있는 자리. EXE 면 EXE 폴더, .py 면 저장소 루트(_env.env_root)."""
    try:
        from _env import env_root
        return env_root()
    except Exception:
        return os.path.dirname(os.path.abspath(sys.executable if getattr(sys, "frozen", False) else __file__))


def safe_log_path(paths, p):
    """창에서 열거나 읽거나 **지워도** 되는 실행 로그인지 — `runs` 아래의 `.log` 파일만 허용한다.

    내역 파일(runner_history.jsonl)의 `log` 값은 파일만 고치면 바뀐다. 검증 없이 열거나 지우면
    임의 파일을 (상승 권한으로) 실행·삭제하게 된다(리뷰). 통과하면 실제 경로, 아니면 None."""
    if not isinstance(p, str) or not p:
        return None
    try:
        rp = os.path.realpath(p)
        base = os.path.normcase(os.path.realpath(paths.runs))
        if os.path.commonpath([os.path.normcase(rp), base]) != base:
            return None
    except (ValueError, OSError, TypeError):
        return None
    if not rp.lower().endswith(".log") or not os.path.isfile(rp):
        return None
    return rp


# ─────────────────────────────── 설정 ───────────────────────────────
def _deep_copy(o):
    return json.loads(json.dumps(o, ensure_ascii=False))


def valid_job_id(jid):
    return bool(ID_RE.fullmatch(jid or "")) and jid.upper() not in _RESERVED_IDS


def missing_default_jobs(cfg):
    """[기본 작업 복원] 용 — 설정에 없는 기본 작업을 **꺼진 상태**로."""
    have = {j.get("id") for j in (cfg.get("jobs") or [])}
    out = []
    for j in DEFAULT_JOBS:
        if j["id"] not in have:
            jj = _deep_copy(j)
            jj["enabled"] = False
            out.append(jj)
    return out


def _normalize(cfg):
    """→ (설정, 경고 목록, {"dropped": 버린 작업 수, "forced_safe": 안전 측으로 강제했는지})."""
    warnings = []
    info = {"dropped": 0, "forced_safe": False}
    out = _deep_copy(DEFAULT_CONFIG)
    out["jobs"] = []
    if not isinstance(cfg, dict):
        warnings.append("설정 파일이 객체가 아닙니다")
        cfg = {}
        info["forced_safe"] = True
    out["paused"] = bool(cfg.get("paused", False))
    try:
        out["log_keep_days"] = max(1, int(cfg.get("log_keep_days", 30)))
    except (TypeError, ValueError):
        warnings.append("log_keep_days 가 숫자가 아닙니다 — 30 으로")
    try:
        out["history_keep"] = max(100, int(cfg.get("history_keep", DEFAULT_CONFIG["history_keep"])))
    except (TypeError, ValueError):
        pass
    raw_jobs = cfg.get("jobs")
    if not isinstance(raw_jobs, list):
        if raw_jobs is not None:
            warnings.append("jobs 가 목록이 아닙니다")
        info["forced_safe"] = True
        raw_jobs = []
    seen = set()
    for j in raw_jobs:
        if not isinstance(j, dict) or not j.get("id") or j.get("kind") not in JOB_KINDS:
            warnings.append("작업 정의가 잘못되어 건너뜀: %s" % json.dumps(j, ensure_ascii=False)[:80])
            info["dropped"] += 1
            continue
        jid = str(j["id"]).strip()
        if not valid_job_id(jid):
            warnings.append("작업 ID 형식 오류(영문·숫자·_·- 1~40자, 예약어 불가) 건너뜀: %s" % jid[:40])
            info["dropped"] += 1
            continue
        if jid in seen:
            warnings.append("작업 ID 중복 건너뜀: %s" % jid)
            info["dropped"] += 1
            continue
        seen.add(jid)
        kind = j["kind"]
        sch = j.get("schedule") or {}
        if sch.get("type") == "daily":
            t = str(sch.get("time", "02:00"))
            try:
                hh, mm = t.split(":")
                hh, mm = int(hh), int(mm)
                if not (0 <= hh < 24 and 0 <= mm < 60):
                    raise ValueError(t)
            except Exception:
                warnings.append("%s 시각 형식 오류(%s) — 02:00 으로" % (jid, t))
                hh, mm = 2, 0
            sch = {"type": "daily", "time": "%02d:%02d" % (hh, mm)}
        else:
            try:
                sec = max(10, int(sch.get("seconds", 60)))
            except (TypeError, ValueError):
                warnings.append("%s 주기가 숫자가 아닙니다 — 60초로" % jid)
                sec = 60
            sch = {"type": "interval", "seconds": sec}
        tmo_default = JOB_KINDS[kind]["timeout_min"]
        try:
            tmo = int(str(j.get("timeout_min", tmo_default)).strip())
        except (TypeError, ValueError):
            warnings.append("%s 시간 상한이 숫자가 아닙니다 — %d분으로" % (jid, tmo_default))
            tmo = tmo_default
        raw_params = j.get("params") if isinstance(j.get("params"), dict) else {}
        params = {k: v for k, v in raw_params.items() if k in PARAM_KEYS[kind]}
        dropped = sorted(set(raw_params) - set(params))
        if dropped:
            warnings.append("%s 에 모르는 파라미터를 버림: %s" % (jid, ", ".join(dropped)[:80]))
        out["jobs"].append({
            "id": jid,
            "kind": kind,
            "name": str(j.get("name") or JOB_KINDS[kind]["label"])[:80],
            "enabled": bool(j.get("enabled", True)),
            "schedule": sch,
            "params": params,
            "keep_log": bool(j.get("keep_log", True)),
            "timeout_min": max(1, min(1440, tmo)),
        })
    if info["forced_safe"] or (raw_jobs and not out["jobs"]):
        # 읽을 수는 있는데 쓸 작업이 없다 = 손편집 오류·업그레이드 불일치. 기본값을 **켜진 채** 되살리면
        # 사람이 멈추려던 릴레이가 2초 뒤 돈다(리뷰). 꺼진 상태 + 일시정지로 불러와 사람이 확인하게 한다.
        info["forced_safe"] = True
        out["paused"] = True
        out["jobs"] = [dict(_deep_copy(j), enabled=False) for j in DEFAULT_JOBS]
        warnings.append("유효한 작업이 없어 기본 작업을 꺼진 상태·일시정지로 불러왔습니다 — 확인 후 사용·재개")
    elif not out["jobs"]:
        warnings.append("작업이 없습니다 — [연동 기준] 의 「기본 작업 복원」으로 되살릴 수 있습니다")
    return out, warnings, info


def normalize_config(cfg):
    """빠진 키는 기본값으로 채우고 잘못된 값은 고친다. 모르는 kind·잘못된 ID 의 작업은 버린다(경고 목록 반환)."""
    out, warnings, _ = _normalize(cfg)
    return out, warnings


def load_config(paths):
    if not os.path.exists(paths.config):
        cfg = _deep_copy(DEFAULT_CONFIG)
        save_config(paths, cfg)
        return cfg, ["설정 파일이 없어 기본값으로 생성: %s" % paths.config]
    stamp = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    try:
        with io.open(paths.config, encoding="utf-8-sig") as f:
            raw = json.load(f)
    except Exception as e:
        # 읽기 실패는 **안전 측**으로: 원본을 보존하고 일시정지 상태로 시작한다.
        bad = paths.config + ".bad-" + stamp
        kept = None
        try:
            os.replace(paths.config, bad)
            kept = bad
        except OSError:
            try:
                shutil.copy2(paths.config, bad)
                kept = bad
            except OSError:
                pass
        cfg = _deep_copy(DEFAULT_CONFIG)
        cfg["paused"] = True
        cfg["jobs"] = [dict(j, enabled=False) for j in cfg["jobs"]]
        try:
            save_config(paths, cfg)
        except OSError:
            pass
        return cfg, ["설정 파일을 읽지 못해 기본 작업을 꺼진 상태·일시정지로 시작했습니다(%s)%s — 확인 후 사용·재개" % (
            str(e)[:80], (" · 원본 보존: " + os.path.basename(kept)) if kept else "")]
    cfg, warns, info = _normalize(raw)
    if info["dropped"] or info["forced_safe"]:
        # 첫 저장이 원본을 덮기 전에 보존한다
        bak = paths.config + ".bak-" + stamp
        try:
            shutil.copy2(paths.config, bak)
            warns.append("원본 보존: " + os.path.basename(bak))
        except OSError:
            pass
    return cfg, warns


def save_config(paths, cfg):
    """원자적 저장 — 임시 파일에 쓰고 교체. 저장 중 꺼져도 설정이 반쯤 깨지지 않는다."""
    os.makedirs(os.path.dirname(paths.config) or ".", exist_ok=True)
    tmp = paths.config + ".tmp"
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, paths.config)


def _write_json_atomic(path, obj):
    tmp = path + ".tmp"
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


def _read_json(path):
    try:
        with io.open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


# ─────────────────────────────── 스케줄 계산 ───────────────────────────────
def compute_next(schedule, after):
    """다음 실행 시각. interval 은 `after + 초`, daily 는 `after` 이후 첫 HH:MM."""
    if schedule.get("type") == "daily":
        hh, mm = (int(x) for x in schedule["time"].split(":"))
        cand = after.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if cand <= after:
            cand += _dt.timedelta(days=1)
        return cand
    return after + _dt.timedelta(seconds=int(schedule.get("seconds", 60)))


def schedule_label(schedule):
    if schedule.get("type") == "daily":
        return "매일 %s" % schedule["time"]
    s = int(schedule.get("seconds", 60))
    return "반복 %d분" % (s // 60) if s % 60 == 0 else "반복 %d초" % s


def is_idle_summary(summary):
    return bool(summary) and any(m in summary for m in IDLE_MARKERS)


# ─────────────────────────────── 내역 ───────────────────────────────
def append_history(paths, rec):
    with io.open(paths.history, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def read_history(paths, limit=None, max_bytes=HISTORY_TAIL_BYTES):
    """내역 읽기. limit 이 있으면 **파일 끝 max_bytes 만** 읽는다(창이 매초 전체 파일을 파싱하지 않게)."""
    if not os.path.exists(paths.history):
        return []
    try:
        if limit:
            with open(paths.history, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                start = max(0, size - max_bytes)
                f.seek(start)
                data = f.read().decode("utf-8", errors="replace")
            lines = data.splitlines()
            if start > 0 and lines:
                lines = lines[1:]          # 잘린 첫 줄
        else:
            with io.open(paths.history, encoding="utf-8", errors="replace") as f:
                lines = f.read().splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out[-limit:] if limit else out


def trim_history(paths, keep):
    """내역 파일이 keep 줄을 크게(1.5배) 넘으면 뒤쪽 keep 줄만 남긴다. 줄을 파싱하지 않고 스트리밍한다."""
    if not os.path.exists(paths.history):
        return 0
    n = 0
    tail = collections.deque(maxlen=keep)
    with io.open(paths.history, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.strip():
                n += 1
                tail.append(line if line.endswith("\n") else line + "\n")
    if n <= keep * 1.5:
        return 0
    tmp = paths.history + ".tmp"
    with io.open(tmp, "w", encoding="utf-8") as f:
        f.writelines(tail)
    os.replace(tmp, paths.history)
    return n - len(tail)


def aggregate_history(rows):
    """작업별 누계(실행 횟수·총 소요·마지막 실행)."""
    agg = {}
    for r in rows:
        a = agg.setdefault(r.get("job"), {"total_exec": 0, "total_secs": 0.0, "last": None})
        a["total_exec"] += 1
        try:
            a["total_secs"] += float(r.get("secs") or 0)
        except (TypeError, ValueError):
            pass
        a["last"] = r
    return agg


def prune_run_logs(paths, keep_days):
    """오래된 실행 로그 삭제. runs **바로 아래 실제 폴더**만 본다(정션·링크를 따라 밖을 지우지 않게)."""
    cutoff = time.time() - keep_days * 86400
    n = 0
    if not os.path.isdir(paths.runs):
        return 0
    runs_real = os.path.normcase(os.path.realpath(paths.runs))
    for job_dir in os.listdir(paths.runs):
        d = os.path.join(paths.runs, job_dir)
        try:
            if not os.path.isdir(d) or os.path.normcase(os.path.dirname(os.path.realpath(d))) != runs_real:
                continue
            names = os.listdir(d)
        except OSError:
            continue
        for name in names:
            p = os.path.join(d, name)
            try:
                if os.path.isfile(p) and not os.path.islink(p) and os.path.getmtime(p) < cutoff:
                    os.remove(p)
                    n += 1
            except OSError:
                pass
    return n


# ─────────────────────────────── 능력 감지 ───────────────────────────────
def env_file_state(path):
    """`.env` 상태 — ok · missing · denied(읽기 권한 없음 — 비상승 실행) · error. 내용은 읽지 않는다."""
    if not os.path.exists(path):
        return "missing"
    try:
        with open(path, "rb"):
            pass
        return "ok"
    except PermissionError:
        return "denied"
    except OSError:
        return "error"


def detect_capabilities(root):
    """이 호스트에서 어떤 작업이 가능한지. 비밀값은 **있는지만** 본다(값 출력·환경 주입 금지).

    · supabase  : SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY
    · erp       : ERP_DB_CONN 또는 %USERPROFILE%\\.erp 저장소
    · ms_account: ENTRA_TENANT_ID/CLIENT_ID/CLIENT_SECRET (MS Graph 계정 수집)
    · gw_account: .env.local 의 GW_DB_* (그룹웨어 DB 계정 수집)
    · offboard  : playwright 모듈 + .env.local 의 GW_URL/GW_ID/GW_PW (퇴사 처리 — 브라우저 자동화)
    """
    env_path = os.path.join(root, ".env")
    env = _read_env_file(env_path)
    local = _read_env_file(os.path.join(root, ".env.local"), normalize=True)

    def has(*ks):
        return all(env.get(k) or os.environ.get(k) for k in ks)

    erp_store = os.path.exists(os.path.join(os.environ.get("USERPROFILE", ""), ".erp", ".db"))
    try:
        import importlib.util
        playwright = importlib.util.find_spec("playwright") is not None
    except Exception:
        playwright = False
    return {
        "supabase": has("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"),
        "erp": has("ERP_DB_CONN") or erp_store,
        "ms_account": has("ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET"),
        "gw_account": all(local.get(k) for k in ("GW_DB_HOST", "GW_DB_NAME", "GW_TABLE_ID", "GW_TABLE_PW", "GW_TABLE_NAME")),
        "offboard": playwright and all(local.get(k) for k in ("GW_URL", "GW_ID", "GW_PW")),
        "teams_webhook": has("TEAMS_WEBHOOK_URL"),
        "env_state": env_file_state(env_path),
    }


def _read_env_file(path, normalize=False):
    """`.env`/`.env.local` 파서(_env.load_env · gw_collect.load_local 과 같은 규칙). 값을 절대 출력하지 않는다."""
    out = {}
    if not os.path.exists(path):
        return out
    try:
        with io.open(path, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if normalize:
                    m = re.match(r"^([A-Za-z_][A-Za-z0-9_ .-]*?)\s*[:=]\s*(.*)$", line)
                    if not m:
                        continue
                    k = re.sub(r"[ .-]+", "_", m.group(1).strip()).upper()
                    v = m.group(2).strip().strip('"').strip("'")
                else:
                    if "=" not in line:
                        continue
                    k, _, v = line.partition("=")
                    if " #" in v:
                        v = v.split(" #", 1)[0]
                    k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and v:
                    out[k] = v
    except OSError:
        pass
    return out


def _as_bool(v):
    return v is True or (isinstance(v, str) and v.strip().lower() in ("on", "true", "1", "yes"))


def resolve_params(job, caps):
    """설정값을 이 호스트 능력 **안에서** 확정한 실행 파라미터(자식에게 넘길 값). 종류별 화이트리스트.

    능력이 상한이다 — 「포함」으로 적어도 호스트가 못 하는 일은 켜지지 않는다."""
    raw = job.get("params") or {}
    kind = job["kind"]
    p = {}
    if kind == "relay_queue":
        try:
            p["max"] = max(1, min(50, int(raw.get("max", 5))))
        except (TypeError, ValueError):
            p["max"] = 5
    elif kind == "etl_sync":
        c = raw.get("collectors", "auto")
        o = raw.get("offboard", "auto")
        want = [] if (c is False or c == "off") else list(COLLECTOR_NAMES)
        p["collectors"] = [n for n in want if caps.get(n)]
        p["offboard"] = bool(caps.get("offboard")) and (o is True or o in ("on", "auto"))
        p["full"] = _as_bool(raw.get("full", False))
        p["allow_sensitive"] = _as_bool(raw.get("allow_sensitive", False))
    elif kind == "etl_batch":
        p["jobs"] = [str(x) for x in (raw.get("jobs") or []) if ID_RE.fullmatch(str(x))]
        p["include_sensitive"] = _as_bool(raw.get("include_sensitive", False))
        p["full"] = _as_bool(raw.get("full", False))
        p["dry_run"] = _as_bool(raw.get("dry_run", False))
    elif kind == "noop":
        try:
            p["lines"] = max(0, min(1000, int(raw.get("lines", 3))))
        except (TypeError, ValueError):
            p["lines"] = 3
        try:
            p["sleep"] = max(0.0, min(10.0, float(raw.get("sleep", 0.3))))
        except (TypeError, ValueError):
            p["sleep"] = 0.3
        try:
            p["rc"] = int(raw.get("rc", 0))
        except (TypeError, ValueError):
            p["rc"] = 0
    return p


def param_warnings(job, caps):
    """설정과 호스트 능력이 어긋나는 점 — 창의 [연동 기준]·실행 로그 머리에 보여준다."""
    raw = job.get("params") or {}
    out = []
    kind = job["kind"]
    if kind in ("relay_queue", "etl_sync", "etl_batch") and not caps.get("supabase"):
        out.append(".env 에 Supabase 접속정보가 없어(또는 읽을 수 없어) 실패합니다")
    if kind == "etl_sync":
        if raw.get("offboard") in (True, "on") and not caps.get("offboard"):
            out.append("퇴사 처리 「포함」이지만 이 호스트는 불가(브라우저·그룹웨어 접속정보 없음) — 큐를 보지 않습니다")
        if raw.get("collectors", "auto") not in (False, "off"):
            miss = [n for n in COLLECTOR_NAMES if not caps.get(n)]
            if miss:
                out.append("계정 수집 %s 은(는) 이 호스트에 접속정보가 없어 생략 — 이 러너가 처리한 요청은 「일부 실패(생략)」로 닫힙니다" % "·".join(miss))
    return out


# ─────────────────────────────── Windows 프로세스 제어 ───────────────────────────────
if os.name == "nt":
    from ctypes import wintypes

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _ntdll = ctypes.WinDLL("ntdll")

    class _BASIC_LIMIT(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class _IO_COUNTERS(ctypes.Structure):
        _fields_ = [(n, ctypes.c_uint64) for n in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                                                    "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class _EXT_LIMIT(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", _BASIC_LIMIT), ("IoInfo", _IO_COUNTERS),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    _k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    _k32.CreateJobObjectW.restype = wintypes.HANDLE
    _k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    _k32.SetInformationJobObject.restype = wintypes.BOOL
    _k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    _k32.AssignProcessToJobObject.restype = wintypes.BOOL
    _k32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    _k32.TerminateJobObject.restype = wintypes.BOOL
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]
    _k32.CloseHandle.restype = wintypes.BOOL
    _k32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    _k32.CreateMutexW.restype = wintypes.HANDLE
    _ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
    _ntdll.NtResumeProcess.restype = ctypes.c_long

_JOB_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
_JobObjectExtendedLimitInformation = 9


class _JobObject:
    """Windows 작업 개체 1개 = 자식 1회 실행의 프로세스 트리. 핸들이 닫히면 트리가 함께 끝난다."""

    def __init__(self, handle):
        self.handle = handle

    @classmethod
    def create(cls):
        if os.name != "nt":
            return None
        try:
            h = _k32.CreateJobObjectW(None, None)
            if not h:
                return None
            info = _EXT_LIMIT()
            info.BasicLimitInformation.LimitFlags = _JOB_LIMIT_KILL_ON_JOB_CLOSE
            if not _k32.SetInformationJobObject(h, _JobObjectExtendedLimitInformation,
                                                ctypes.byref(info), ctypes.sizeof(info)):
                _k32.CloseHandle(h)
                return None
            return cls(h)
        except Exception:
            return None

    def assign(self, proc):
        try:
            return bool(_k32.AssignProcessToJobObject(self.handle, int(proc._handle)))
        except Exception:
            return False

    def terminate(self, code=KILL_EXIT_CODE):
        try:
            return bool(self.handle) and bool(_k32.TerminateJobObject(self.handle, code))
        except Exception:
            return False

    def close(self):
        h, self.handle = self.handle, None
        if h:
            try:
                _k32.CloseHandle(h)
            except Exception:
                pass


def _resume(proc):
    try:
        return _ntdll.NtResumeProcess(int(proc._handle)) == 0
    except Exception:
        return False


def spawn_child(argv, cwd, out):
    """자식 실행 → (Popen, _JobObject|None).

    작업 개체에 넣기 **전에** 자식이 손자를 띄우면 손자가 빠져나가므로, 멈춘 채(CREATE_SUSPENDED)
    만들고 → 작업 개체에 넣고 → 재개한다. 작업 개체를 못 쓰면 일반 실행(중지는 taskkill /T 로 대체)."""
    job = _JobObject.create()
    flags = CREATE_NO_WINDOW if os.name == "nt" else 0
    if job is not None:
        flags |= CREATE_SUSPENDED
    try:
        proc = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=out,
                                stderr=subprocess.STDOUT, creationflags=flags)
    except Exception:
        if job is not None:
            job.close()
        raise
    if job is not None:
        assigned = job.assign(proc)
        if not _resume(proc):
            try:
                proc.kill()
            except Exception:
                pass
            job.close()
            raise RuntimeError("자식 프로세스를 재개하지 못했습니다(NtResumeProcess)")
        if not assigned:
            job.close()
            job = None
    return proc, job


# ─────────────────────────────── 단일 인스턴스 ───────────────────────────────
_mutex_handle = None
_lock_fd = None


def acquire_single_instance(root, name=MUTEX_NAME):
    """한 루트에 러너는 하나만. 이미 떠 있으면 False.

    ① 루트 잠금 파일(`logs\\runner\\runner.lock`)을 배타로 쥔다 — 세션·실행 경로가 달라도 같은 루트면 막힌다.
       프로세스가 죽으면 OS 가 잠금을 푼다(남는 잠금 없음).
    ② 전역 뮤텍스(`Global\\`) — 이 PC 의 다른 로그온 세션(RDP)에서 두 번째 러너가 뜨지 않게.
       상승 러너가 만든 뮤텍스를 비상승 프로세스가 열면 NULL + 접근 거부 → 그것도 「실행 중」.
    name=None 이면 뮤텍스는 쓰지 않는다(테스트용)."""
    global _mutex_handle, _lock_fd
    paths = Paths(root)
    try:
        os.makedirs(paths.logs, exist_ok=True)
        fd = os.open(paths.lock, os.O_RDWR | os.O_CREAT)
    except OSError:
        return False
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return False
    _lock_fd = fd
    if name and os.name == "nt":
        h = _k32.CreateMutexW(None, False, name)
        err = ctypes.get_last_error()
        if not h or err == 183:          # 183 = ERROR_ALREADY_EXISTS
            if h:
                _k32.CloseHandle(h)
            release_single_instance()
            return False
        _mutex_handle = h
    return True


def release_single_instance():
    global _mutex_handle, _lock_fd
    if _lock_fd is not None:
        try:
            if os.name == "nt":
                import msvcrt
                os.lseek(_lock_fd, 0, os.SEEK_SET)
                msvcrt.locking(_lock_fd, msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        try:
            os.close(_lock_fd)
        except OSError:
            pass
        _lock_fd = None
    if _mutex_handle:
        try:
            _k32.CloseHandle(_mutex_handle)
        except Exception:
            pass
        _mutex_handle = None


# ─────────────────────────────── 엔진 ───────────────────────────────
class JobState:
    __slots__ = ("cfg", "next_run", "proc", "job", "run_start", "log_path", "stop_requested", "stop_reason",
                 "timed_out", "last_start", "last_end", "last_rc", "last_status", "last_summary", "last_log",
                 "last_idle", "prev_idle_log", "total_exec", "total_secs", "message")

    def __init__(self, cfg):
        self.cfg = cfg
        self.next_run = None
        self.proc = None
        self.job = None
        self.run_start = None
        self.log_path = None
        self.stop_requested = False
        self.stop_reason = None
        self.timed_out = False
        self.last_start = self.last_end = None
        self.last_rc = None
        self.last_status = None
        self.last_summary = ""
        self.last_log = None
        self.last_idle = False
        self.prev_idle_log = None
        self.total_exec = 0
        self.total_secs = 0.0
        self.message = ""

    @property
    def id(self):
        return self.cfg["id"]

    @property
    def running(self):
        return self.proc is not None

    @property
    def group(self):
        return JOB_KINDS[self.cfg["kind"]]["group"]

    def avg_secs(self):
        return (self.total_secs / self.total_exec) if self.total_exec else 0.0

    def state_label(self, paused):
        if self.running:
            return STATUS_RUNNING
        if not self.cfg.get("enabled", True):
            return "사용안함"
        if paused:
            return "일시정지"
        return "대기"


class RunnerEngine:
    """스케줄러. start() 로 스레드를 띄우고 stop() 으로 내린다. 모든 공개 메서드는 스레드 안전."""

    def __init__(self, root, child_argv_builder, log=None):
        self.paths = Paths(root)
        self.paths.ensure()
        self._build_child_argv = child_argv_builder
        self._log = log or (lambda m: None)
        self.lock = threading.RLock()
        self.cfg, self.warnings = load_config(self.paths)
        self.caps = detect_capabilities(self.paths.root)
        state = self.caps.get("env_state")
        if state == "denied":
            self.warnings.append(".env 읽기 권한이 없습니다 — 관리자 권한으로 실행하거나 등록 작업(JEIL_AX_Runner)으로 띄우세요")
        elif state == "missing":
            self.warnings.append(".env 가 없습니다(%s) — 릴레이·ETL 작업이 실패합니다" % os.path.join(self.paths.root, ".env"))
        self.jobs = {}
        self._journal = {}
        self._thread = None
        self._stop = threading.Event()
        self.started_at = None
        self._housekeep_at = 0.0
        self._recover_journal()      # 지난 러너가 로그오프·강제 종료로 끊긴 실행을 먼저 기록
        self._housekeep()            # 부팅 때 정리해 집계를 가볍게
        self._load_states()

    # ── 초기화 ──
    def _load_states(self):
        agg = aggregate_history(read_history(self.paths))
        now = _dt.datetime.now()
        for j in self.cfg["jobs"]:
            st = JobState(j)
            a = agg.get(j["id"])
            if a:
                st.total_exec = a["total_exec"]
                st.total_secs = a["total_secs"]
                last = a["last"] or {}
                st.last_start = _parse(last.get("start"))
                st.last_end = _parse(last.get("end"))
                st.last_rc = last.get("rc")
                st.last_status = last.get("status")
                st.last_summary = last.get("summary") or ""
                st.last_log = last.get("log")
                st.last_idle = bool(last.get("idle"))
                if st.last_idle:
                    # 내역 파일 값은 믿지 않는다 — runs 아래 .log 일 때만 다음 idle 회차에 지울 후보로
                    st.prev_idle_log = safe_log_path(self.paths, st.last_log)
            self.jobs[j["id"]] = st
        self._reschedule(now)

    def _reschedule(self, now):
        """놓친 회차를 따라잡지 않는다 — daily 는 다음 정시, interval 은 3초 간격으로 순서대로 한 번씩."""
        stagger = 3
        for st in self.jobs.values():
            if st.running:
                continue
            if st.cfg["schedule"]["type"] == "daily":
                st.next_run = compute_next(st.cfg["schedule"], now)
            else:
                st.next_run = now + _dt.timedelta(seconds=stagger)
                stagger += 3

    def _housekeep(self):
        self._housekeep_at = time.time()
        try:
            n = trim_history(self.paths, int(self.cfg.get("history_keep", DEFAULT_CONFIG["history_keep"])))
            if n:
                self._log("내역 정리 %d줄" % n)
            n = prune_run_logs(self.paths, int(self.cfg.get("log_keep_days", 30)))
            if n:
                self._log("오래된 실행 로그 %d개 삭제" % n)
        except Exception as e:
            self._log("정리 중 오류(무시): %s" % str(e)[:120])

    def _save_journal(self):
        try:
            _write_json_atomic(self.paths.running, self._journal)
        except OSError as e:
            self._log("실행 기록(running) 저장 실패: %s" % str(e)[:120])

    def _recover_journal(self):
        """지난 러너가 끝내지 못한 실행(로그오프·재부팅·작업 관리자 종료) → 「중지됨(비정상 종료)」으로 내역에 남긴다.
        자식은 작업 개체와 함께 이미 끝났다(KILL_ON_JOB_CLOSE)."""
        data = _read_json(self.paths.running)
        if not isinstance(data, dict) or not data:
            if data not in (None, {}):
                self._journal = {}
                self._save_journal()
            return
        now = _dt.datetime.now()
        for jid, ent in data.items():
            if not isinstance(ent, dict):
                continue
            log_path = safe_log_path(self.paths, ent.get("log"))
            start = _parse(ent.get("start")) or now
            msg = "러너 비정상 종료(로그오프·재부팅·강제 종료) — 이 실행의 결과를 확인하지 못했습니다"
            if log_path:
                try:
                    with io.open(log_path, "a", encoding="utf-8") as f:
                        f.write("[runner] %s\n" % msg)
                except OSError:
                    pass
            try:
                append_history(self.paths, {
                    "job": str(jid)[:40], "name": str(ent.get("name") or jid)[:80],
                    "start": start.isoformat(timespec="seconds"), "end": now.isoformat(timespec="seconds"),
                    "secs": None, "rc": None, "status": STATUS_STOPPED, "summary": msg, "log": log_path, "idle": False})
            except OSError:
                pass
            self._log("비정상 종료로 끊긴 실행을 기록: %s" % str(jid)[:40])
        self._journal = {}
        self._save_journal()

    # ── 수명 ──
    def start(self):
        with self.lock:
            if self._thread:
                return
            self.started_at = _dt.datetime.now()
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="runner-scheduler", daemon=True)
            self._thread.start()
            self._log("스케줄러 시작 — 작업 %d종 · %s" % (len(self.jobs), "일시정지" if self.cfg["paused"] else "가동"))

    def stop(self, terminate_children=True, wait_sec=10):
        """스케줄러를 내리고, 돌던 작업은 트리째 끝낸 뒤 **내역에 「중지됨(러너 종료)」으로 남긴다**.
        이미 스스로 끝난 작업은 원래 결과(성공·실패)로 기록한다."""
        self._stop.set()
        t = self._thread
        if t:
            t.join(timeout=5)
        self._thread = None
        if not terminate_children:
            return
        with self.lock:
            running = [st for st in self.jobs.values() if st.running]
            for st in running:
                self._terminate(st, "러너 종료")
            deadline = time.time() + wait_sec
            for st in running:
                try:
                    st.proc.wait(timeout=max(0.1, deadline - time.time()))
                except Exception:
                    pass
                self._finish(st)

    # ── 조작 ──
    def set_paused(self, paused):
        with self.lock:
            self.cfg["paused"] = bool(paused)
            if not paused:
                self._reschedule(_dt.datetime.now())      # 일시정지 중 놓친 매일 작업을 재개 즉시 돌리지 않는다
            save_config(self.paths, self.cfg)
            self._log("스케줄 %s" % ("일시정지" if paused else "재개"))

    def set_enabled(self, job_id, enabled):
        with self.lock:
            st = self.jobs[job_id]
            st.cfg["enabled"] = bool(enabled)
            if enabled and not st.running:
                st.next_run = compute_next(st.cfg["schedule"], _dt.datetime.now()) \
                    if st.cfg["schedule"]["type"] == "daily" else _dt.datetime.now() + _dt.timedelta(seconds=2)
            save_config(self.paths, self.cfg)
            self._log("%s %s" % (job_id, "사용" if enabled else "사용안함"))

    def run_now(self, job_id):
        """즉시 1회 실행(사용안함·일시정지 상태여도 사람이 누르면 돈다). 같은 group 이 돌고 있으면 거부."""
        with self.lock:
            st = self.jobs[job_id]
            if st.running:
                return False, "이미 실행 중입니다"
            busy = self._busy_groups()
            if st.group in busy and st.group != "test":
                return False, "같은 종류(%s) 작업이 실행 중입니다" % st.group
            self._launch(st, manual=True)
            if not st.running:
                return False, st.last_summary or "실행하지 못했습니다"
            return True, "실행 시작"

    def stop_job(self, job_id):
        with self.lock:
            st = self.jobs[job_id]
            if not st.running:
                return False, "실행 중이 아닙니다"
            if not self._terminate(st, "사용자 중지"):
                return False, "이미 끝났습니다 — 곧 결과가 반영됩니다"
            return True, "중지 요청"

    def update_config(self, new_cfg):
        """창의 설정 저장. 실행 중인 작업은 끝날 때까지 그대로 두고 다음 실행부터 반영."""
        cfg, warns = normalize_config(new_cfg)
        with self.lock:
            by_id = {j["id"]: j for j in cfg["jobs"]}
            for st in self.jobs.values():
                if not st.running:
                    continue
                newj = by_id.get(st.id)
                if newj is None:
                    # 실행 중인 작업을 지우면 아무도 그 자식을 거두지 않는다(내역 누락·그룹 배타 붕괴) — 삭제 보류
                    cfg["jobs"].append(st.cfg)
                    warns.append("%s 은(는) 실행 중이라 삭제를 보류했습니다 — 끝난 뒤 다시 삭제하세요" % st.id)
                elif newj["kind"] != st.cfg["kind"]:
                    cfg["jobs"][cfg["jobs"].index(newj)] = st.cfg
                    warns.append("%s 은(는) 실행 중이라 종류 변경을 보류했습니다" % st.id)
            old = self.jobs
            self.cfg = cfg
            self.jobs = {}
            now = _dt.datetime.now()
            stagger = 2
            for j in cfg["jobs"]:
                st = old.get(j["id"]) or JobState(j)
                st.cfg = j
                if not st.running:
                    if j["schedule"]["type"] == "daily":
                        st.next_run = compute_next(j["schedule"], now)
                    else:
                        st.next_run = now + _dt.timedelta(seconds=min(stagger, j["schedule"]["seconds"]))
                        stagger += 3
                self.jobs[j["id"]] = st
            save_config(self.paths, cfg)
            self.caps = detect_capabilities(self.paths.root)
            for j in cfg["jobs"]:
                warns.extend("%s: %s" % (j["id"], w) for w in param_warnings(j, self.caps))
            self._log("설정 저장 — 작업 %d종" % len(self.jobs))
        return warns

    # ── 조회 ──
    def snapshot(self):
        with self.lock:
            paused = bool(self.cfg["paused"])
            rows = []
            for st in self.jobs.values():
                rows.append({
                    "id": st.id, "kind": st.cfg["kind"], "name": st.cfg["name"],
                    "enabled": st.cfg.get("enabled", True),
                    "state": st.state_label(paused),
                    "type": schedule_label(st.cfg["schedule"]),
                    "next": st.next_run if (st.cfg.get("enabled", True) and not paused and not st.running) else None,
                    "last_start": st.run_start if st.running else st.last_start,
                    "last_end": None if st.running else st.last_end,
                    "result": (STATUS_RUNNING if st.running else (st.last_status or "-")),
                    "rc": None if st.running else st.last_rc,
                    "summary": st.message if st.running else st.last_summary,
                    "idle": False if st.running else st.last_idle,
                    "total_exec": st.total_exec, "avg_secs": st.avg_secs(),
                    "log": st.log_path if st.running else st.last_log,
                    "running": st.running,
                    "timeout_min": st.cfg.get("timeout_min"),
                    "params": resolve_params(st.cfg, self.caps),
                    "notes": param_warnings(st.cfg, self.caps),
                })
            return {"paused": paused, "jobs": rows, "caps": dict(self.caps), "warnings": list(self.warnings),
                    "running": sum(1 for r in rows if r["running"]), "started_at": self.started_at}

    def history(self, limit=300, include_idle=True):
        if include_idle:
            rows = read_history(self.paths, limit)
        else:
            rows = [r for r in read_history(self.paths, limit * 50, max_bytes=HISTORY_TAIL_BYTES * 4)
                    if not r.get("idle")][-limit:]
        return list(reversed(rows))

    def history_stamp(self):
        try:
            s = os.stat(self.paths.history)
            return (s.st_size, s.st_mtime_ns)
        except OSError:
            return (0, 0)

    # ── 내부 ──
    def _busy_groups(self):
        return {st.group for st in self.jobs.values() if st.running}

    def _loop(self):
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception as e:
                self._log("스케줄러 오류(계속): %s" % str(e)[:200])
            self._stop.wait(1.0)

    def _tick(self):
        now = _dt.datetime.now()
        with self.lock:
            # 1) 끝난 자식 정리 · 시간 상한 넘은 자식 종료
            for st in list(self.jobs.values()):
                if not st.running:
                    continue
                if st.proc.poll() is not None:
                    self._finish(st)
                    continue
                limit = int(st.cfg.get("timeout_min") or 0)
                if limit and not st.stop_requested and st.run_start and now - st.run_start > _dt.timedelta(minutes=limit):
                    st.timed_out = True
                    if self._terminate(st, "시간 초과(%d분)" % limit):
                        self._log("%s 시간 상한 %d분 초과 — 트리 종료" % (st.id, limit))
            # 2) 주기 정리(내역·로그)
            if time.time() - self._housekeep_at > HOUSEKEEP_EVERY_SEC:
                self._housekeep()
            # 3) 예정 작업 기동
            if self.cfg["paused"]:
                return
            busy = self._busy_groups()
            for st in list(self.jobs.values()):
                if st.running or not st.cfg.get("enabled", True) or st.next_run is None or st.next_run > now:
                    continue
                if st.group in busy and st.group != "test":
                    continue          # 같은 종류가 도는 중 — 다음 초에 다시 본다
                self._launch(st, manual=False)          # 실패해도 예외를 올리지 않는다 — 뒤 작업이 굶지 않게
                if st.running:
                    busy.add(st.group)

    def _launch(self, st, manual):
        start = _dt.datetime.now()
        log_path = None
        try:
            runs = os.path.realpath(self.paths.runs)
            job_dir = os.path.join(runs, st.id)
            # ID 검증의 2차 방어 — runs 바로 아래 폴더만(설정 파일 손편집으로 다른 곳에 쓰지 못하게)
            if os.path.normcase(os.path.dirname(os.path.realpath(job_dir))) != os.path.normcase(runs):
                raise RuntimeError("작업 ID 경로 거부: %s" % st.id)
            os.makedirs(job_dir, exist_ok=True)
            log_path = os.path.join(job_dir, start.strftime("%Y%m%d_%H%M%S") + ".log")
            params = resolve_params(st.cfg, self.caps)
            argv = self._build_child_argv(st.cfg, params, log_path, self.paths.root)
            with io.open(log_path, "a", encoding="utf-8") as f:
                f.write("===== %s · %s(%s) · %s =====\n" % (
                    start.strftime("%Y-%m-%d %H:%M:%S"), st.cfg["name"], st.id, "수동" if manual else "예약"))
                f.write("[runner] params=%s · 시간 상한 %s분\n" % (json.dumps(params, ensure_ascii=False),
                                                              st.cfg.get("timeout_min")))
                for note in param_warnings(st.cfg, self.caps):
                    f.write("[runner] 참고: %s\n" % note)
                f.flush()
                # 자식의 fd1/fd2 도 이 파일에 묶는다 — 부트로더 단계 오류까지 남는다(자식은 따로 append 로 다시 연다)
                st.proc, st.job = spawn_child(argv, self.paths.root, f)
        except Exception as e:
            self._launch_failed(st, start, log_path, e)
            return
        st.run_start = start
        st.log_path = log_path
        st.stop_requested = False
        st.stop_reason = None
        st.timed_out = False
        st.message = "실행 중…"
        self._journal[st.id] = {"name": st.cfg["name"], "log": log_path,
                                "start": start.isoformat(timespec="seconds"), "pid": st.proc.pid}
        self._save_journal()
        self._log("%s 시작(%s) pid=%s%s" % (st.id, "수동" if manual else "예약", st.proc.pid,
                                          "" if st.job else " · 작업개체 없음(중지는 taskkill)"))

    def _launch_failed(self, st, start, log_path, err):
        end = _dt.datetime.now()
        msg = "실행 실패: %s" % str(err)[:160]
        if log_path:
            try:
                with io.open(log_path, "a", encoding="utf-8") as f:
                    f.write("[runner] %s\n" % msg)
            except OSError:
                log_path = None
        st.proc = None
        st.job = None
        st.last_start, st.last_end, st.last_rc, st.last_status = start, end, -1, STATUS_FAIL
        st.last_summary, st.last_log, st.last_idle = msg, log_path, False
        st.next_run = compute_next(st.cfg["schedule"], end)          # 매초 재시도하지 않게
        self._record(st, start, end)
        self._log("%s %s" % (st.id, msg))

    def _terminate(self, st, reason):
        """프로세스 **트리** 종료 — 작업 개체 → taskkill /T /F → terminate 순. 이미 끝났으면 아무것도 안 하고 False
        (다음 틱의 _finish 가 원래 결과로 기록한다 — 성공한 실행을 「중지됨」으로 적지 않게)."""
        if st.proc is None or st.proc.poll() is not None:
            return False
        st.stop_requested = True
        st.stop_reason = reason
        if st.job is not None and st.job.terminate(KILL_EXIT_CODE):
            return True
        if os.name == "nt":
            try:
                subprocess.run(["taskkill", "/PID", str(st.proc.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=CREATE_NO_WINDOW, timeout=15)
                return True
            except Exception as e:
                self._log("%s taskkill 실패: %s" % (st.id, str(e)[:120]))
        try:
            st.proc.terminate()
        except Exception as e:
            self._log("%s 종료 실패: %s" % (st.id, str(e)[:120]))
        return True

    def _finish(self, st):
        proc = st.proc
        rc = proc.returncode if proc is not None else None
        end = _dt.datetime.now()
        start = st.run_start or end
        st.proc = None
        if st.job is not None:
            st.job.close()            # KILL_ON_JOB_CLOSE — 혹시 남은 손자까지 정리
            st.job = None
        summary = _last_meaningful_line(st.log_path)
        killed = st.stop_requested and rc != 0          # 중지 요청 직후 스스로 성공(0)했으면 성공이다
        if killed:
            status = STATUS_FAIL if st.timed_out else STATUS_STOPPED
            if st.stop_reason:
                summary = ("%s — %s" % (st.stop_reason, summary)) if summary else st.stop_reason
        else:
            status = STATUS_OK if rc == 0 else STATUS_FAIL
        idle = status == STATUS_OK and is_idle_summary(summary)
        try:
            with io.open(st.log_path, "a", encoding="utf-8") as f:
                f.write("[runner] 종료 exit=%s · %s · %.1f초\n" % (rc, status, (end - start).total_seconds()))
        except OSError:
            pass
        prev_idle = st.prev_idle_log
        st.last_start, st.last_end, st.last_rc, st.last_status = start, end, rc, status
        st.last_summary, st.last_log, st.last_idle = summary, st.log_path, idle
        st.message = ""
        st.stop_requested = False
        st.timed_out = False
        st.next_run = compute_next(st.cfg["schedule"], end)
        self._record(st, start, end)
        if self._journal.pop(st.id, None) is not None:
            self._save_journal()
        if status == STATUS_OK and not st.cfg.get("keep_log", True):
            _remove_quiet(safe_log_path(self.paths, st.log_path))
            st.last_log = None
        elif idle:
            # 할 일이 없던 회차는 작업별 마지막 1개만 남긴다(매분 파일이 쌓이지 않게). 지울 대상은 runs 아래 .log 만.
            if prev_idle and os.path.normcase(prev_idle) != os.path.normcase(st.log_path or ""):
                _remove_quiet(safe_log_path(self.paths, prev_idle))
            st.prev_idle_log = st.log_path
        self._log("%s 종료 exit=%s %s — %s" % (st.id, rc, status, summary[:80]))

    def _record(self, st, start, end):
        secs = (end - start).total_seconds()
        st.total_exec += 1
        st.total_secs += secs
        try:
            append_history(self.paths, {
                "job": st.id, "name": st.cfg["name"], "start": start.isoformat(timespec="seconds"),
                "end": end.isoformat(timespec="seconds"), "secs": round(secs, 1), "rc": st.last_rc,
                "status": st.last_status, "summary": st.last_summary, "log": st.last_log,
                "idle": bool(st.last_idle),
            })
        except OSError as e:
            self._log("내역 기록 실패: %s" % str(e)[:120])


def _remove_quiet(path):
    try:
        if path:
            os.remove(path)
    except OSError:
        pass


def _parse(s):
    if not s:
        return None
    try:
        return _dt.datetime.fromisoformat(s)
    except Exception:
        return None


def _last_meaningful_line(path, max_bytes=65536):
    """로그 끝에서 러너 표식(`[runner]`)이 아닌 마지막 줄 — 내역의 '요약'."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            data = f.read().decode("utf-8", errors="replace")
    except (OSError, TypeError):
        return ""
    for line in reversed(data.splitlines()):
        s = line.strip()
        if s and not s.startswith("[runner]") and not s.startswith("====="):
            return s[:200]
    return ""


def tail_text(path, max_bytes=200000):
    """창의 「실행 내용」용 — 파일 끝 max_bytes 만 읽는다(큰 로그도 창이 멈추지 않게)."""
    if not path or not os.path.exists(path):
        return ""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            data = f.read().decode("utf-8", errors="replace")
        if size > max_bytes:
            data = "…(앞부분 생략)…\n" + data
        return data
    except OSError:
        return ""


def fmt_dt(d):
    return d.strftime("%Y-%m-%d %H:%M:%S") if d else ""
