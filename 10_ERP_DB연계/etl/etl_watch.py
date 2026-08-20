# etl_watch.py — 웹 「데이터 업데이트」 요청 감시·실행 러너
#
# 왜 필요한가: ERP(UNIERP) MSSQL은 사외 IDC라 브라우저·Supabase에서 직접 붙을 수 없다(CLAUDE.md §4).
#   그래서 화면(app/erp-status.html)의 「🔄 데이터 업데이트」 버튼은 Supabase 큐
#   (etl_meta.sync_request)에 "요청"만 남기고, ERP 접속이 되는 이 호스트에서 이 러너가
#   요청을 집어가 etl_run.run_job 을 돌리고 진행률·결과를 되쓴다. 화면은 그 상태를 폴링한다.
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
    include_sensitive 는 관리자 요청에서만 참 — 이때만 급여(erp_secure) job 이 목록에 붙는다."""
    allowed = list(SAFE_JOBS) + (list(SENSITIVE_JOBS) if include_sensitive else [])
    asked = [j for j in (req_jobs or []) if j in allowed]
    return asked or allowed


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


def tick(url, key, runner, dry, full):
    """하트비트 1회 + 대기 요청 있으면 1건 처리. 처리했으면 True."""
    rpc(url, key, "erp_sync_runner_ping", {"p_runner": runner, "p_note": f"jobs={len(SAFE_JOBS)}"})
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
