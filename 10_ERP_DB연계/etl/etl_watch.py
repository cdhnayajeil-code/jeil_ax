# etl_watch.py — 웹 「데이터 업데이트」 요청 감시·실행 러너
#
# 왜 필요한가: ERP(UNIERP) MSSQL은 사외 IDC라 브라우저·Supabase에서 직접 붙을 수 없다(CLAUDE.md §4).
#   그래서 화면(app/erp-status.html)의 「🔄 데이터 업데이트」 버튼은 Supabase 큐
#   (etl_meta.sync_request)에 "요청"만 남기고, ERP 접속이 되는 이 호스트에서 이 러너가
#   요청을 집어가 etl_run.run_job 을 돌리고 진행률·결과를 되쓴다. 화면은 그 상태를 폴링한다.
#   ERP job 을 다 돌린 뒤 **MS(Entra)·그룹웨어 계정 수집기**도 이어서 돌린다(COLLECTORS) —
#   계정 대사 화면이 ERP 만 새 데이터, 계정은 옛 데이터인 상태로 어긋나지 않게 하기 위해서다.
#
# 실행:
#   python etl_watch.py                 # 상주(기본 20초 주기 폴링) — 콘솔 켜두면 됨
#   python etl_watch.py --once          # 1회 확인 후 종료 — Windows 작업 스케줄러 1분 주기용
#   python etl_watch.py --interval 30   # 폴링 주기 변경
#   python etl_watch.py --once --dry-run  # 적재 없이 흐름만 검증(추출 건수만)
#   python etl_watch.py --full          # 요청 처리 시 증분 무시하고 전량 재적재
#
# 보안(CLAUDE.md §1·§4):
#   · SUPABASE_SERVICE_ROLE_KEY / ERP_DB_CONN 은 프로젝트 루트 .env 에서만 읽는다(출력 금지).
#   · 민감 job(erp_secure — 급여 hr_payroll)은 요청에 include_sensitive=true 가 있을 때만 돈다.
#     그 플래그는 DB RPC(`erp_sync_request_create`)가 전체관리자(portal_admin)에게만 허용하고,
#     허용·거부 모두 erp_secure.hr_access_log 에 감사 기록한다. 일반 사내 사용자 요청엔 붙지 않는다.
import argparse
import datetime
import importlib
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request

from _env import env_root, load_env, need
from etl_run import JOBS, run_job

# 웹 요청으로 항상 허용하는 job = 민감 스키마(erp_secure)로 가지 않는 것 전부.
SAFE_JOBS = [n for n, s in JOBS.items() if s.get("rpc") != "erp_secure_upsert"]
# 민감 job(급여 hr_payroll → erp_secure). 요청에 include_sensitive=true 가 있을 때만 돈다 —
# 그 플래그는 DB RPC 가 전체관리자(portal_admin)에게만 허용하고 hr_access_log 에 감사 기록한다.
SENSITIVE_JOBS = [n for n, s in JOBS.items() if s.get("rpc") == "erp_secure_upsert"]

# 계정 대사(REQ-0018)의 ERP 밖 두 축 — 웹 「데이터 업데이트」로 ERP job 과 함께 돈다.
#   ms_account : Microsoft Graph /users        → public.acct_ms
#   gw_account : 그룹웨어(ONUL Ware) MSSQL 뷰   → public.acct_groupware
# 원천도 접속 방식도 ERP 와 달라 etl_run.JOBS 에 넣지 않고 여기서 별도 단계로 돌린다.
# 둘 다 **전량 스냅샷**이라 증분(--full) 개념이 없고, 한 쪽이 실패해도 나머지는 계속 간다.
# (계정 정보만 늦게 갱신되면 대사 화면이 조용히 틀린 값을 보여준다 — 2026-09-07 관리자 지시로 편입)
COLLECTORS = {
    "ms_account": ("ms_collect", "MS(Entra) 계정"),
    "gw_account": ("gw_collect", "그룹웨어 계정"),
}

POLL_SEC = 20          # 기본 폴링 주기
HTTP_TIMEOUT = 60

# 접속 오류 원문에서 계정·서버 정보를 가린다 — 요청 결과(sync_request.result/error_msg)는 사내 로그인 사용자가
# 조회할 수 있어 ODBC 원문(「Login failed for user '...'」·연결 문자열 조각·IP)이 그대로 가면 안 된다(재검증 반영).
_REDACT_RULES = [
    (re.compile(r"(?i)(user\s+')[^']*(')"), r"\1***\2"),
    (re.compile(r"(?i)\b(UID|PWD|PASSWORD|USER ID|SERVER|DATA SOURCE|ADDRESS|DATABASE)\s*=\s*[^;'\"\]\)]*"), r"\1=***"),
    (re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}(?:[,:]\d+)?\b"), "***"),
]


def _redact(msg):
    s = str(msg)
    for rx, rep in _REDACT_RULES:
        s = rx.sub(rep, s)
    return s


def log(msg):
    print(f"[{datetime.datetime.now():%H:%M:%S}] {msg}", flush=True)


def notify(title, lines, bad=False):
    """퇴사 처리 결과를 Teams 로 알린다(REQ-0029). 웹훅이 없으면 조용히 건너뛴다(반환 False).

    예약 자동 적용은 사람이 화면을 보고 있지 않을 때 돈다 — 결과가 콘솔에만 남으면 아무도 모른다
    (운영전환 게이트 G8: 알림 없이 무인 실행 금지). 설정은 루트 `.env` 의 `TEAMS_WEBHOOK_URL` 한 줄.
    URL 형식으로 페이로드를 가른다(jeil-portal-request 와 같은 규칙):
      · logic.azure.com  = Teams 「워크플로」 웹훅 → Adaptive Card (구 커넥터는 신규 발급이 막혀 이쪽이 기본)
      · webhook.office.com = 구 O365 Incoming Webhook → MessageCard
    URL 자체가 비밀값이라 로그·문서에 남기지 않는다 — 형식이 틀려도 값을 찍지 않고 종류만 적는다(§1.8).
    알림 실패가 본작업을 막지 않는다 — 예외를 삼키고 진행한다."""
    hook = os.environ.get("TEAMS_WEBHOOK_URL", "").strip()
    if not hook:
        return False
    if not hook.startswith("https://"):
        log("  · Teams 알림 건너뜀: TEAMS_WEBHOOK_URL 형식 오류(https:// 필요)")
        return False
    text = "  \n".join(str(x) for x in lines) + f"  \n  \n_러너 {socket.gethostname()} · {datetime.datetime.now():%Y-%m-%d %H:%M}_"
    head = ("🚨 " if bad else "✅ ") + title
    if "webhook.office.com" in hook:
        body = {"@type": "MessageCard", "@context": "https://schema.org/extensions",
                "themeColor": "b3402f" if bad else "2e7d52", "summary": title, "title": head, "text": text}
    else:
        body = {"type": "message", "attachments": [{
            "contentType": "application/vnd.microsoft.card.adaptive",
            "content": {"type": "AdaptiveCard", "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                        "version": "1.4", "body": [
                            {"type": "TextBlock", "text": head, "weight": "Bolder", "size": "Medium", "wrap": True,
                             "color": "Attention" if bad else "Good"},
                            {"type": "TextBlock", "text": text, "wrap": True}]}}]}
    try:
        req = urllib.request.Request(hook, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                     method="POST", headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15):
            return True
    except urllib.error.HTTPError as e:            # 알림 실패가 본작업을 막지 않는다 — URL 은 찍지 않는다
        log(f"  · Teams 알림 실패(무시): HTTP {e.code}")
        return False
    except Exception as e:
        log(f"  · Teams 알림 실패(무시): {type(e).__name__}")
        return False


_DUE_NOTIFIED_AT = 0.0


def _due_stamp_path():
    return os.path.join(env_root(), "logs", "due_notified.at")


def _due_stamp_read():
    try:
        with open(_due_stamp_path(), encoding="utf-8") as f:
            return float(f.read().strip() or 0)
    except (OSError, ValueError):
        return 0.0


def _due_stamp_write(ts):
    try:
        p = _due_stamp_path()
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(str(ts))
    except OSError:
        pass


def notify_due_schedules(url, key):
    """도래했는데 사람 확인을 기다리는 예약·자동 보류(강등) 건을 하루 한 번 Teams 로 묶어 알린다(리뷰 반영).
    러너가 도는 동안만 동작한다(러너는 수동 기동) — 그래도 화면을 열지 않은 관리자에게 닿는 유일한 경로다."""
    global _DUE_NOTIFIED_AT
    now = time.time()
    # 억제 시각을 파일에도 남긴다 — 연동 러너는 회차마다 새 프로세스라 전역 변수만으로는 매분 알림이 나간다(리뷰 반영)
    if now - max(_DUE_NOTIFIED_AT, _due_stamp_read()) < 6 * 3600:
        return
    _DUE_NOTIFIED_AT = now
    _due_stamp_write(now)
    try:
        lst = rpc(url, key, "offboard_schedule_list", {"p_days_back": 7}) or {}
    except Exception as e:
        log(f"  · 예약 목록 조회 실패(알림 생략): {type(e).__name__}")
        return
    rows = lst.get("rows") or []
    due = [r for r in rows if r.get("state") == "due"]
    if not due:
        return
    def line(r):
        who = ", ".join((t.get("emp_nm") or t.get("email") or "") for t in ((r.get("preview") or {}).get("targets") or [])) or ", ".join(r.get("emails") or [])
        hist = r.get("history") or []
        why = "자동 보류(재직·유예)" if any(h.get("act") == "downgrade" for h in hist) else "도래 시 확인"
        return f"• {str(r.get('scheduled_at'))[:16].replace('T', ' ')}Z — {who} [{why}]"
    notify(f"퇴사 예약 도래 — 확인 필요 {len(due)}건", ["/admin/offboarding 에서 「지금 적용」 또는 「취소」를 눌러 주세요."] + [line(r) for r in due[:15]], bad=False)


def rpc(url, key, fn, payload):
    """Supabase RPC 호출 → 파싱된 JSON(없으면 None). 오류 본문은 예외에 실어 진단 가능하게."""
    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    req = urllib.request.Request(
        f"{url}/rest/v1/rpc/{fn}", data=body, method="POST",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            raw = r.read().decode("utf-8").strip()
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace").strip()
        except Exception:
            pass
        raise RuntimeError(f"HTTP {e.code} rpc/{fn}: {detail[:500]}") from e
    if not raw or raw == "null":
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def _allowed_collectors(collectors):
    """collectors 인자 → 이 러너가 돌릴 수집기 이름 목록. True=전부 · 거짓=없음 · 목록=그중 아는 것만."""
    if collectors is True:
        return list(COLLECTORS)
    if not collectors:
        return []
    want = set(collectors)
    return [n for n in COLLECTORS if n in want]


def plan_targets(req_jobs, include_sensitive=False, collectors=True, allow_sensitive=True):
    """요청 → (이 러너가 돌릴 job 목록, 생략 목록[(job, 사유)]).

    · 요청 job 이 비었으면 기본 세트 = ERP 안전 job + 허용 수집기(+ 관리자 요청 시 급여).
      계정 수집기는 **ERP job 뒤**에 붙인다 — ERP 사용자마스터가 먼저 갱신돼야 계정 대사가 같은 시점으로 맞는다.
    · 이 호스트가 못 하는 수집기(접속정보 없음)·급여(러너 설정) 는 조용히 빼지 않고 **생략으로 돌려준다**
      — 요청 결과에 남겨 「완료」 오해를 막는다(REQ-0046 리뷰).
    · 지정 job 이 전부 이 러너 밖이면 빈 목록 — 요청과 무관한 전체 세트로 바꿔 돌리지 않는다.
      (모르는 job 이름만 온 요청은 종전처럼 기본 세트)"""
    acc = _allowed_collectors(collectors)
    sens_ok = bool(include_sensitive) and bool(allow_sensitive)
    allowed = list(SAFE_JOBS) + (list(SENSITIVE_JOBS) if sens_ok else []) + acc
    host_skip = {n: "이 러너에 접속정보 없음" for n in COLLECTORS if n not in acc}
    if include_sensitive and not allow_sensitive:
        host_skip.update({n: "이 러너는 급여(민감) job 을 처리하지 않도록 설정됨" for n in SENSITIVE_JOBS})
    req = [j for j in (req_jobs or []) if isinstance(j, str)]
    if req:
        asked = [j for j in req if j in allowed]
        skipped = [(j, host_skip[j]) for j in req if j in host_skip]
        if not asked and not skipped:
            asked = allowed
        return asked, skipped
    return allowed, list(host_skip.items())


def targets_for(req_jobs, include_sensitive=False, collectors=True):
    """(호환용) plan_targets 의 실행 목록만."""
    return plan_targets(req_jobs, include_sensitive, collectors)[0]


def run_collector(name, url, key, dry):
    """계정 수집기 1종 실행 → (추출건수, 적재건수).

    ERP job 과 똑같이 etl_meta.batch_run 에 start/finish 를 남긴다 — 그래야 연동현황 화면의
    「최신 연동」(v_erp_sync_overview) 에 MS·그룹웨어 행이 뜬다."""
    mod_name, label = COLLECTORS[name]
    # 매번 **다시 읽는다**. import_module 은 sys.modules 캐시를 돌려주므로, 상주 러너에서는
    # 수집기 파일을 고쳐도 재시작 전까지 옛 코드가 돈다 — 실제로 18일 동안 옛 코드로
    # 동작한 적이 있다(2026-09-07). reload 실패는 무시하고 캐시본으로 이어간다.
    mod = importlib.import_module(mod_name)
    try:
        mod = importlib.reload(mod)
    except Exception as e:
        log(f"  · {label} 모듈 재적재 실패(캐시본 사용): {str(e)[:120]}")
    log(f"  · {label} 수집")
    batch_id = None if dry else rpc(url, key, "erp_etl_batch",
                                    {"p_action": "start", "p_payload": {"job_name": name}})
    try:
        read, up = mod.collect(url, key, dry)
    except (Exception, SystemExit) as e:
        # need() 는 SystemExit — 러너 전체가 멈추지 않게 일반 예외로 바꿔 올린다(원문의 계정·서버 정보는 가림)
        msg = _redact(str(e.code) if isinstance(e, SystemExit) else str(e))
        if batch_id:
            rpc(url, key, "erp_etl_batch", {"p_action": "finish", "p_payload": {
                "batch_id": batch_id, "status": "failed", "rows_read": 0,
                "error_msg": msg[:500]}})
        if isinstance(e, SystemExit):
            raise RuntimeError(msg) from None
        raise
    if batch_id:
        rpc(url, key, "erp_etl_batch", {"p_action": "finish", "p_payload": {
            "batch_id": batch_id, "status": "success",
            "rows_read": read, "rows_upserted": up}})
    return read, up


def handle(url, key, runner, req, dry, full, collectors=True, allow_sensitive=True):
    """「데이터 업데이트」 요청 1건. 반환 "done"/"failed".

    실패로 닫는 경우: job 실패가 있거나, 이 러너가 못 해 **생략한 job 이 하나라도** 있을 때(계정 수집·급여).
    생략을 「완료」로 닫으면 화면이 초록 「업데이트 완료」만 띄워 계정·급여가 옛 값인 것을 아무도 모른다(재검증 반영).
    데이터 업데이트 화면의 실패 문구는 「일부/전체 실패 — 사유 (아래 표는 최신 상태로 갱신)」이라,
    ERP 는 갱신됐고 무엇이 빠졌는지가 그대로 보인다."""
    rid = req["request_id"]
    sens = bool(req.get("include_sensitive"))
    names, skipped = plan_targets(req.get("jobs"), sens, collectors, allow_sensitive)
    total = len(names)
    log(f"요청 수락 {rid[:8]}… (요청자 {req.get('requested_by') or '-'}) — job {total}종"
        + (" · 급여 포함(관리자 요청)" if sens else "")
        + (f" · 생략 {len(skipped)}종" if skipped else ""))

    skip_detail = [{"job": n, "status": "skipped", "reason": why} for n, why in skipped]
    skip_msg = ("생략 %d종(러너 %s 에서 불가): %s" % (len(skipped), runner, ", ".join(n for n, _ in skipped))) if skipped else None
    if not names:
        err = f"이 러너({runner})가 처리할 수 있는 job 이 없습니다 — " + (skip_msg or "요청 job 확인")
        rpc(url, key, "erp_sync_request_finish",
            {"p_request_id": rid, "p_status": "failed", "p_result": {"jobs": skip_detail, "dry_run": bool(dry)},
             "p_rows_read": 0, "p_rows_upserted": 0, "p_error": err[:500]})
        log(f"요청 종료 {rid[:8]}… — failed · {err[:160]}")
        return "failed"

    rpc(url, key, "erp_sync_request_progress",
        {"p_request_id": rid, "p_done": 0, "p_total": total, "p_job": names[0]})

    detail, read_sum, up_sum, fails = [], 0, 0, []
    for i, name in enumerate(names):
        # done = i+1 → 화면에 "3/19 · 품목"(= 19종 중 3번째 진행 중)으로 보인다
        rpc(url, key, "erp_sync_request_progress",
            {"p_request_id": rid, "p_done": i + 1, "p_total": total, "p_job": name,
             "p_rows_read": read_sum, "p_rows_upserted": up_sum})
        try:
            if name in COLLECTORS:
                got = run_collector(name, url, key, dry)
            else:
                got = run_job(name, JOBS[name], url, key, dry, full)
            rd, up = got if got else (0, 0)
            read_sum += rd
            up_sum += up
            detail.append({"job": name, "status": "success", "read": rd, "upserted": up})
        except (Exception, SystemExit) as e:
            # 한 job이 실패해도 나머지는 계속 — 부분 성공도 데이터는 갱신된다.
            # need() 는 SystemExit 을 던진다 — 잡지 않으면 요청이 running 에 2시간 갇힌다
            msg = _redact(str(e.code) if isinstance(e, SystemExit) else str(e))
            fails.append(name)
            detail.append({"job": name, "status": "failed", "error": msg[:300]})
            log(f"  ! {name} 실패: {msg[:200]}")

    status = "failed" if (fails or skipped) else "done"
    parts = []
    if fails:
        parts.append(f"{len(fails)}개 job 실패: {', '.join(fails)}")
    if skip_msg:
        parts.append(skip_msg)
    err = " · ".join(parts) or None
    rpc(url, key, "erp_sync_request_finish",
        {"p_request_id": rid, "p_status": status,
         "p_result": {"jobs": detail + skip_detail, "dry_run": bool(dry)},
         "p_rows_read": read_sum, "p_rows_upserted": up_sum, "p_error": err[:500] if err else None})
    log(f"요청 종료 {rid[:8]}… — {status} · 추출 {read_sum} / 적재 {up_sum}"
        + (f" · 실패 {len(fails)}" if fails else "") + (f" · 생략 {len(skipped)}" if skipped else ""))
    return status


def handle_offboard(url, key, runner, req):
    """퇴사 처리 요청 1건 — 대상별로 요청된 축(ERP·그룹웨어·MS)을 실행한다. 반환 "done"/"failed".

    브라우저는 그룹웨어 관리자 화면에 붙을 수 없어서(사외 호스트 + 화면 조작 필요) 화면은
    요청만 남기고 여기서 실행한다. 「데이터 업데이트」와 같은 구조다.
    한 사람·한 축이 실패해도 나머지는 계속한다 — 부분 성공이라도 처리된 건 처리된 것이다.
    대상별로 담을 축은 **서버가 정해서** 보낸다(이미 정리된 축은 아예 안 온다)."""
    import offboard_axes  # 지연 import — playwright 미설치 호스트에서도 러너 자체는 뜬다
    # 수집기와 같은 이유로 매번 다시 읽는다 — 상주 러너는 sys.modules 캐시를 들고 있어서
    # 퇴사 처리 로직을 고쳐도 재시작 전까지 옛 코드가 돈다.
    try:
        offboard_axes = importlib.reload(offboard_axes)
    except Exception as e:
        log(f"  · 퇴사 처리 모듈 재적재 실패(캐시본 사용): {str(e)[:120]}")

    rid = req["request_id"]
    mode = req.get("mode") or "check"
    targets = req.get("targets") or []
    total = len(targets)
    apply = (mode == "apply")
    scheduled = (req.get("origin") == "schedule")   # 예약 승격 건(REQ-0029) — 사람이 보고 있지 않을 수 있어 결과를 알린다
    log(f"퇴사 처리 요청 {rid[:8]}… (요청자 {req.get('requested_by') or '-'}"
        + (" · 예약 승격" if scheduled else "") + f") — 대상 {total}명 · "
        + ("실제 처리" if apply else "점검(변경 없음)"))

    # Graph 토큰은 한 번만 받아 모든 대상·축이 함께 쓴다(대상마다 받으면 토큰 요청이 대상 수만큼 난다).
    tok, tok_err = None, None
    if any("erp" in (t.get("axes") or []) or "ms" in (t.get("axes") or []) for t in targets):
        try:
            tok = offboard_axes._token()
        except SystemExit as e:
            # need() — 접속정보 자체가 없다(설정 누락, 다시 받아도 같다). 축 함수가 토큰을 또 받으려다
            # SystemExit 으로 러너째 죽지 않게, 토큰이 꼭 필요한 축(MS 전부 · ERP 실제 적용)은 실행하지 않는다
            tok_err = _redact(str(e.code))[:160]
            log(f"  ! Graph 접속정보 없음(MS 축·ERP 실제 적용은 실행하지 않음): {tok_err}")
        except Exception as e:
            # 일시 오류(네트워크·503 등) — 종전처럼 축마다 토큰을 다시 받게 둔다(재검증 반영)
            log(f"  ! Graph 토큰 1차 발급 실패(축별로 다시 받음): {_redact(str(e))[:160]}")

    detail, fails = [], []
    for i, t in enumerate(targets):
        who = f"{t.get('emp_nm')}({t.get('email')})"
        axes = t.get("axes") or []
        rpc(url, key, "offboard_request_progress",
            {"p_request_id": rid, "p_done": i, "p_total": total,
             "p_target": f"{who} [{'·'.join(axes)}]"})
        # 점검(check) 모드의 ERP 축은 토큰 없이 판정한다 — 실제 적용일 때만 막는다
        blocked = [a for a in axes if a == "ms" or (a == "erp" and apply)] if tok_err else []
        run = [a for a in axes if a not in blocked]
        axr = [{"ok": False, "axis": a, "msg": "Graph 접속정보 없음 — 실행하지 않음: " + tok_err} for a in blocked]
        if run:
            try:
                axr += offboard_axes.run_axes(t, run, apply=apply, tok=tok)
            except (Exception, SystemExit) as e:     # 예상 못 한 오류도 한 사람으로 가둔다
                msg = str(e.code) if isinstance(e, SystemExit) else str(e)
                axr += [{"ok": False, "axis": a, "msg": msg[:300]} for a in run]
        order = {a: k for k, a in enumerate(axes)}
        axr.sort(key=lambda x: order.get(x.get("axis"), 99))

        ok_all = all(x.get("ok") for x in axr) if axr else False
        detail.append({"email": t.get("email"), "name": t.get("emp_nm"),
                       "ok": ok_all, "axes": axr,
                       "msg": " / ".join("%s: %s" % (x.get("axis"), x.get("msg")) for x in axr)})
        if not ok_all:
            fails.append(who)
        for x in axr:
            log(("  · " if x.get("ok") else "  ! ") + f"{who} [{x.get('axis')}] {str(x.get('msg'))[:150]}")

    rpc(url, key, "offboard_request_progress",
        {"p_request_id": rid, "p_done": total, "p_total": total, "p_target": None})
    status = "failed" if fails else "done"
    err = f"{len(fails)}명 일부 축 실패: {', '.join(fails)}" if fails else None
    rpc(url, key, "offboard_request_finish",
        {"p_request_id": rid, "p_status": status,
         "p_result": {"mode": mode, "targets": detail}, "p_error": err})
    log(f"퇴사 처리 종료 {rid[:8]}… — {status} · 전축성공 {total - len(fails)} / {total}")
    # 알림 — 예약 승격 건은 결과와 무관하게, 수동 건은 실패했을 때만(관리자 결정 2026-09-11: 웹훅은 있으면 쓰고 없으면 건너뜀).
    if apply and (scheduled or fails):
        notify(("퇴사 예약 자동 처리 " if scheduled else "퇴사 처리 ") + ("실패 있음" if fails else "완료"),
               [f"요청 {rid[:8]}… · 요청자 {req.get('requested_by') or '-'} · 대상 {total}명 · 전축성공 {total - len(fails)}"]
               + [("✖ " if not d.get("ok") else "✔ ") + f"{d.get('name') or d.get('email')} — {str(d.get('msg'))[:160]}" for d in detail[:20]],
               bad=bool(fails))
    return status


def _ping_note(offboard, collectors, allow_sensitive=True):
    """러너 심박 메모 — 이 러너가 할 수 있는 일(`jobs=N+acctK[+offboard][+nosens]`). SQL 49 의 선점·가동 판정이 이 표식을 본다.
    `+nosens` 는 급여(민감) 요청을 처리하지 않는 러너 표식 — 표식이 없는 옛 러너는 종전처럼 처리 가능으로 본다."""
    return (f"jobs={len(SAFE_JOBS)}+acct{len(_allowed_collectors(collectors))}"
            + ("+offboard" if offboard else "") + ("" if allow_sensitive else "+nosens"))


def tick(url, key, runner, dry, full, offboard=True, collectors=True, allow_sensitive=True):
    """하트비트 1회 + 대기 요청 있으면 1건 처리. 반환 False(할 일 없음) · "done" · "failed".
    (참/거짓 판정은 종전과 같다 — 처리했으면 참)

    ETL 요청과 퇴사 처리 요청 **둘 다** 본다 — 한 번에 하나만 처리해 브라우저·ERP 부하가 겹치지 않는다.
    offboard=False 면 퇴사 처리 큐를 **선점조차 하지 않고** 예약 도래 알림도 보내지 않는다 — 브라우저(Playwright)가
    없는 호스트(ERP 서버 러너, REQ-0046)가 실제 적용 건을 집어 실패로 만들지 않기 위해서다.
    collectors 는 True(전부)·False(없음)·이름 목록 — 접속정보 없는 수집기는 생략으로 기록된다."""
    rpc(url, key, "erp_sync_runner_ping",
        {"p_runner": runner, "p_note": _ping_note(offboard, collectors, allow_sensitive)})

    if offboard:
        notify_due_schedules(url, key)   # 도래·보류 예약을 6시간에 한 번 묶어 알린다(웹훅 있을 때만)

    off = rpc(url, key, "offboard_request_claim", {"p_runner": runner}) if offboard else None
    if off:
        try:
            return handle_offboard(url, key, runner, off)
        except (Exception, SystemExit) as e:
            msg = str(e.code) if isinstance(e, SystemExit) else str(e)
            log(f"퇴사 처리 중 오류: {msg[:300]}")
            try:
                rpc(url, key, "offboard_request_finish",
                    {"p_request_id": off["request_id"], "p_status": "failed", "p_error": msg[:500]})
            except Exception:
                pass
            # 예약 자동 건은 handle_offboard 안의 알림에 못 미쳤어도 실패를 알린다(리뷰 반영 — 무인 실행의 실패가 묻히지 않게)
            if off.get("origin") == "schedule" and (off.get("mode") == "apply"):
                notify("퇴사 예약 자동 처리 실패(러너 오류)",
                       [f"요청 {str(off.get('request_id'))[:8]}… · 대상 {len(off.get('targets') or [])}명", f"{type(e).__name__}: {msg[:200]}"], bad=True)
            return "failed"

    req = rpc(url, key, "erp_sync_request_claim", {"p_runner": runner})
    if not req:
        return False
    try:
        return handle(url, key, runner, req, dry, full, collectors, allow_sensitive)
    except (Exception, SystemExit) as e:
        # handle 자체가 깨진 경우(네트워크 등) — 요청을 running 으로 방치하지 않는다
        msg = _redact(str(e.code) if isinstance(e, SystemExit) else str(e))
        log(f"요청 처리 중 오류: {msg[:300]}")
        try:
            rpc(url, key, "erp_sync_request_finish",
                {"p_request_id": req["request_id"], "p_status": "failed", "p_error": msg[:500]})
        except Exception:
            pass
        return "failed"


def main():
    ap = argparse.ArgumentParser(description="웹 「데이터 업데이트」 요청 감시·실행 러너")
    ap.add_argument("--once", action="store_true", help="1회만 확인하고 종료(작업 스케줄러용) — 요청 실패 시 exit 1")
    ap.add_argument("--interval", type=int, default=POLL_SEC, help=f"폴링 주기(초, 기본 {POLL_SEC})")
    ap.add_argument("--dry-run", action="store_true", help="적재 없이 추출 건수만(흐름 검증)")
    ap.add_argument("--full", action="store_true", help="증분 무시하고 전량 재적재")
    ap.add_argument("--no-offboard", action="store_true",
                    help="퇴사 처리 큐를 보지 않는다(브라우저 없는 호스트 — ERP 서버 러너)")
    ap.add_argument("--no-collectors", action="store_true",
                    help="계정 수집기(MS·그룹웨어)를 대상에서 뺀다(접속정보 없는 호스트 — 요청 결과에 생략으로 기록)")
    args = ap.parse_args()

    load_env()
    url = need("SUPABASE_URL").rstrip("/")
    key = need("SUPABASE_SERVICE_ROLE_KEY")
    runner = socket.gethostname()

    log(f"러너 시작 — host={runner} · 기본 job {len(SAFE_JOBS)}종"
        f" + 계정수집 {len(COLLECTORS)}종({'·'.join(COLLECTORS)})"
        f"(+관리자 요청 시 민감 {len(SENSITIVE_JOBS)}종)"
        + (" · dry-run" if args.dry_run else "") + (" · full" if args.full else ""))
    if args.no_offboard or args.no_collectors:
        log("옵션: " + " · ".join(x for x, on in (("퇴사 처리 제외", args.no_offboard), ("계정 수집 제외", args.no_collectors)) if on))
    opts = dict(offboard=not args.no_offboard, collectors=not args.no_collectors)
    if args.once:
        return 1 if tick(url, key, runner, args.dry_run, args.full, **opts) == "failed" else 0

    try:
        while True:
            try:
                if not tick(url, key, runner, args.dry_run, args.full, **opts):
                    time.sleep(max(5, args.interval))
            except Exception as e:
                log(f"폴링 오류(계속 재시도): {str(e)[:200]}")
                time.sleep(max(5, args.interval))
    except KeyboardInterrupt:
        log("러너 종료(Ctrl+C)")


if __name__ == "__main__":
    sys.exit(main())
