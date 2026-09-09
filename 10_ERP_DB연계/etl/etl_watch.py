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
import socket
import sys
import time
import urllib.error
import urllib.request

from _env import load_env, need
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


def log(msg):
    print(f"[{datetime.datetime.now():%H:%M:%S}] {msg}", flush=True)


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


def targets_for(req_jobs, include_sensitive=False):
    """요청이 지정한 job ∩ 허용 목록. 비었으면 허용 목록 전체(기본 세트).
    include_sensitive 는 관리자 요청에서만 참 — 이때만 급여(erp_secure) job 이 목록에 붙는다.
    계정 수집기(COLLECTORS)는 항상 허용이며 **ERP job 뒤**에 붙인다 — ERP 사용자마스터가
    먼저 갱신돼야 계정 대사가 같은 시점의 데이터로 맞춰진다."""
    allowed = (list(SAFE_JOBS)
               + (list(SENSITIVE_JOBS) if include_sensitive else [])
               + list(COLLECTORS))
    asked = [j for j in (req_jobs or []) if j in allowed]
    return asked or allowed


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
    except Exception as e:
        if batch_id:
            rpc(url, key, "erp_etl_batch", {"p_action": "finish", "p_payload": {
                "batch_id": batch_id, "status": "failed", "rows_read": 0,
                "error_msg": str(e)[:500]}})
        raise
    if batch_id:
        rpc(url, key, "erp_etl_batch", {"p_action": "finish", "p_payload": {
            "batch_id": batch_id, "status": "success",
            "rows_read": read, "rows_upserted": up}})
    return read, up


def handle(url, key, runner, req, dry, full):
    rid = req["request_id"]
    sens = bool(req.get("include_sensitive"))
    names = targets_for(req.get("jobs"), sens)
    total = len(names)
    log(f"요청 수락 {rid[:8]}… (요청자 {req.get('requested_by') or '-'}) — job {total}종"
        + (" · 급여 포함(관리자 요청)" if sens else ""))

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
        except Exception as e:
            # 한 job이 실패해도 나머지는 계속 — 부분 성공도 데이터는 갱신된다
            fails.append(name)
            detail.append({"job": name, "status": "failed", "error": str(e)[:300]})
            log(f"  ! {name} 실패: {str(e)[:200]}")

    status = "failed" if fails else "done"
    err = f"{len(fails)}개 job 실패: {', '.join(fails)}" if fails else None
    rpc(url, key, "erp_sync_request_finish",
        {"p_request_id": rid, "p_status": status, "p_result": {"jobs": detail, "dry_run": bool(dry)},
         "p_rows_read": read_sum, "p_rows_upserted": up_sum, "p_error": err})
    log(f"요청 종료 {rid[:8]}… — {status} · 추출 {read_sum} / 적재 {up_sum}"
        + (f" · 실패 {len(fails)}" if fails else ""))


def handle_offboard(url, key, runner, req):
    """퇴사 처리 요청 1건 — 대상별로 요청된 축(ERP·그룹웨어·MS)을 실행한다.

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
    log(f"퇴사 처리 요청 {rid[:8]}… (요청자 {req.get('requested_by') or '-'}) — 대상 {total}명 · "
        + ("실제 처리" if apply else "점검(변경 없음)"))

    # Graph 토큰은 한 번만 받아 모든 대상·축이 함께 쓴다(대상마다 받으면 토큰 요청이 대상 수만큼 난다).
    tok = None
    if any("erp" in (t.get("axes") or []) or "ms" in (t.get("axes") or []) for t in targets):
        try:
            tok = offboard_axes._token()
        except Exception as e:
            log(f"  ! Graph 토큰 발급 실패(ERP·MS 축 건너뜀): {str(e)[:160]}")

    detail, fails = [], []
    for i, t in enumerate(targets):
        who = f"{t.get('emp_nm')}({t.get('email')})"
        axes = t.get("axes") or []
        rpc(url, key, "offboard_request_progress",
            {"p_request_id": rid, "p_done": i, "p_total": total,
             "p_target": f"{who} [{'·'.join(axes)}]"})
        try:
            axr = offboard_axes.run_axes(t, axes, apply=apply, tok=tok)
        except Exception as e:                       # 예상 못 한 오류도 한 사람으로 가둔다
            axr = [{"ok": False, "axis": a, "msg": str(e)[:300]} for a in axes]

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


def tick(url, key, runner, dry, full):
    """하트비트 1회 + 대기 요청 있으면 1건 처리. 처리했으면 True.
    ETL 요청과 퇴사 처리 요청 **둘 다** 본다 — 한 번에 하나만 처리해 브라우저·ERP 부하가 겹치지 않는다."""
    rpc(url, key, "erp_sync_runner_ping",
        {"p_runner": runner, "p_note": f"jobs={len(SAFE_JOBS)}+acct{len(COLLECTORS)}+offboard"})

    off = rpc(url, key, "offboard_request_claim", {"p_runner": runner})
    if off:
        try:
            handle_offboard(url, key, runner, off)
        except Exception as e:
            log(f"퇴사 처리 중 오류: {e}")
            try:
                rpc(url, key, "offboard_request_finish",
                    {"p_request_id": off["request_id"], "p_status": "failed", "p_error": str(e)[:500]})
            except Exception:
                pass
        return True

    req = rpc(url, key, "erp_sync_request_claim", {"p_runner": runner})
    if not req:
        return False
    try:
        handle(url, key, runner, req, dry, full)
    except Exception as e:
        # handle 자체가 깨진 경우(네트워크 등) — 요청을 running 으로 방치하지 않는다
        log(f"요청 처리 중 오류: {e}")
        try:
            rpc(url, key, "erp_sync_request_finish",
                {"p_request_id": req["request_id"], "p_status": "failed", "p_error": str(e)[:500]})
        except Exception:
            pass
    return True


def main():
    ap = argparse.ArgumentParser(description="웹 「데이터 업데이트」 요청 감시·실행 러너")
    ap.add_argument("--once", action="store_true", help="1회만 확인하고 종료(작업 스케줄러용)")
    ap.add_argument("--interval", type=int, default=POLL_SEC, help=f"폴링 주기(초, 기본 {POLL_SEC})")
    ap.add_argument("--dry-run", action="store_true", help="적재 없이 추출 건수만(흐름 검증)")
    ap.add_argument("--full", action="store_true", help="증분 무시하고 전량 재적재")
    args = ap.parse_args()

    load_env()
    url = need("SUPABASE_URL").rstrip("/")
    key = need("SUPABASE_SERVICE_ROLE_KEY")
    runner = socket.gethostname()

    log(f"러너 시작 — host={runner} · 기본 job {len(SAFE_JOBS)}종"
        f" + 계정수집 {len(COLLECTORS)}종({'·'.join(COLLECTORS)})"
        f"(+관리자 요청 시 민감 {len(SENSITIVE_JOBS)}종)"
        + (" · dry-run" if args.dry_run else "") + (" · full" if args.full else ""))
    if args.once:
        return 0 if tick(url, key, runner, args.dry_run, args.full) is not None else 1

    try:
        while True:
            try:
                if not tick(url, key, runner, args.dry_run, args.full):
                    time.sleep(max(5, args.interval))
            except Exception as e:
                log(f"폴링 오류(계속 재시도): {str(e)[:200]}")
                time.sleep(max(5, args.interval))
    except KeyboardInterrupt:
        log("러너 종료(Ctrl+C)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
