# -*- coding: utf-8 -*-
r"""proposal_scan.py — 기안서 스캔본 목록(문서중앙화) → 중간DB(public.pur_proposal_scan) 야간 자동 갱신

**파일은 열지도 옮기지도 않는다.** 파일 이름·크기·수정일만 읽어 「권-번호」 기안서에 스캔본이 있는지 대사한다
(2026-09-29 관리자 결정: 스캔본 읽기 불필요 — 파일명·존재 여부만). 종전에는 사람이 탐색기로 뽑은 CSV 를
`proposal_ledger --scan` 으로 넣었고, 이 모듈이 그 수작업을 대신한다.

왜 탐색기 창인가(skill/destiny-ecm-file-automation 실측)
  문서중앙화(Destiny) 보호 드라이브는 explorer.exe 에만 열린다. os.listdir·Get-ChildItem·Shell.Namespace
  직접 접근은 전부 거부(Access denied / NULL)되고, **탐색기 창을 띄운 뒤 그 창의 Shell COM 폴더 객체**로만
  목록을 읽을 수 있다. 그래서 PowerShell 로 창을 열어 Items() 를 JSON 으로 받는다. 복사·삭제 동사는 쓰지 않는다.

어디서 도나 — 러너 능력(§17.6)
  · **로그인된(잠기지 않은) Windows 세션 + Destiny 설치 PC** 에서만 된다. 잠금화면·로그오프면 드라이브가
    풀려 목록이 비어 보인다 → 그때는 실패가 아니라 「이번 회차 건너뜀」으로 끝내고 다음 회차에 다시 본다.
  · ERP 서버(Destiny 없음)는 이 작업을 하지 않는다 — detect_capabilities() 의 proposal_scan 이 False.

「매일 밤 1회」 규칙(--nightly · 러너 기본)
  러너는 놓친 daily 회차를 따라잡지 않는다. 그래서 30분 간격으로 부르고, 모듈이 스스로 판단한다:
    마지막 갱신이 가장 최근 밤 기준시각(20:00 KST) 이전이면 이번에 한다 → 밤에 PC 가 잠겨 있었으면
    다음 날 아침 잠금이 풀린 첫 회차에 따라잡는다. 이미 했으면 「대기 요청 없음」(러너가 로그를 접는다).

안전장치
  · 파일 0개 또는 종전 일치 건수의 절반 미만이면 **적재하지 않는다**(부분 열람으로 전량 교체되는 사고 방지).
    정말 줄었으면 --force.
  · 경로는 .env 의 PROPOSAL_SCAN_DIR — 사내 경로라 저장소·로그에 적지 않는다(§1.3). 자식 PowerShell 에는
    환경변수로만 넘긴다(명령줄 인자 금지 §1.8).

사용:
  python proposal_scan.py --dry-run      # 목록만 읽고 대사 결과 출력(적재 안 함)
  python proposal_scan.py                # 목록 읽기 → 전량 교체 적재
  python proposal_scan.py --nightly      # 러너 모드 — 오늘 밤 이미 했으면 건너뜀
  jeil_runner scan --dry-run             # 러너 서브커맨드(§17.2)
"""
import argparse
import base64
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

from _env import load_env

JOB_NAME = "pur_proposal_scan"
NIGHT_HOUR = 20                    # 밤 기준시각(KST) — 이 시각 이후 첫 회차에 1회
KST = datetime.timezone(datetime.timedelta(hours=9))
LIST_TIMEOUT = 180                 # 탐색기 창 열기 + 목록 읽기 상한(초)
IDLE = "대기 요청 없음"            # runner_core.IDLE_MARKERS 와 같은 말 — 할 일이 없던 회차 표식

# 파일명 → (권, 번호). 예) 9-830.pdf · 9-830(2).pdf · 9 - 830 재스캔.pdf
NAME_RE = re.compile(r"^\s*(\d{1,3})\s*-\s*(\d{1,5})(?!\d)")

# 탐색기 창 경유 목록 읽기(PowerShell). 경로는 환경변수 PROPOSAL_SCAN_DIR 로만 받는다.
PS_LIST = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$path = $env:PROPOSAL_SCAN_DIR
if (-not $path) { throw 'PROPOSAL_SCAN_DIR 없음' }
$sh = New-Object -ComObject Shell.Application
function Find-Win($p) { $sh.Windows() | Where-Object { try { $_.Document.Folder.Self.Path -eq $p } catch { $false } } | Select-Object -First 1 }
$w = Find-Win $path; $opened = $false
if (-not $w) {
  Start-Process explorer.exe -ArgumentList ('"{0}"' -f $path)
  for ($i = 0; $i -lt 40 -and -not $w; $i++) { Start-Sleep -Milliseconds 500; $w = Find-Win $path }
  $opened = $true
}
if (-not $w) { throw 'WINDOW: 탐색기 창을 열지 못함(문서중앙화 미로그인·화면 잠금 가능)' }
$out = New-Object System.Collections.ArrayList
function Add-Items($folder, $depth) {
  foreach ($it in $folder.Items()) {
    if ($it.IsFolder) {
      if ($depth -lt 1) { try { Add-Items $it.GetFolder ($depth + 1) } catch { } }
      continue
    }
    $name = [IO.Path]::GetFileName([string]$it.Path)
    if (-not $name) { $name = [string]$it.Name }
    $md = $null; try { $md = ([datetime]$it.ModifyDate).ToString('yyyy-MM-ddTHH:mm:ss') } catch { }
    [void]$out.Add(@{ name = $name; size = [int64]$it.Size; mtime = $md })
  }
}
try { Add-Items $w.Document.Folder 0 } finally { if ($opened) { try { $w.Quit() } catch { } } }
ConvertTo-Json -InputObject @($out) -Compress -Depth 3
"""


class ScanUnavailable(RuntimeError):
    """드라이브가 안 보이는 회차(잠금·로그오프·Destiny 미실행) — 실패가 아니라 건너뜀."""


# ────────────────────────────────────────────────────────────── 목록 읽기
def list_scan_dir(scan_dir):
    """탐색기 창 경유로 파일 목록을 읽는다 → [{name,size,mtime}]."""
    if os.name != "nt":
        raise ScanUnavailable("Windows 가 아닌 호스트")
    enc = base64.b64encode(PS_LIST.encode("utf-16-le")).decode("ascii")
    env = dict(os.environ, PROPOSAL_SCAN_DIR=scan_dir)
    try:
        # 예약작업(pythonw)에서 불려도 콘솔 창이 번쩍이지 않게 — 탐색기 창만 잠깐 열렸다 닫힌다
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                            "-EncodedCommand", enc], env=env, capture_output=True, timeout=LIST_TIMEOUT,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired:
        raise ScanUnavailable("목록 읽기 시간 초과(%d초) — 탐색기 창이 응답하지 않음" % LIST_TIMEOUT)
    out = r.stdout.decode("utf-8", "replace").strip()
    err = r.stderr.decode("utf-8", "replace").strip()
    if r.returncode != 0:
        if "WINDOW:" in err or "WINDOW:" in out:
            raise ScanUnavailable("탐색기 창을 열지 못함 — 문서중앙화 미로그인 또는 화면 잠금")
        raise RuntimeError("목록 읽기 실패: %s" % (err.splitlines()[-1] if err else "rc=%d" % r.returncode)[:300])
    try:
        data = json.loads(out or "[]")
    except ValueError:
        raise RuntimeError("목록 결과를 읽지 못함(JSON 아님): %s" % out[:120])
    return data if isinstance(data, list) else [data]


def parse_name(name):
    """파일명 → (권, 번호) 또는 None."""
    m = NAME_RE.match(os.path.splitext(name or "")[0])
    return (int(m.group(1)), int(m.group(2))) if m else None


def build_rows(files, cases):
    """목록 + 대장 건(권,번호) → 적재 레코드. 대장 건마다 1행(없으면 matched=false), 대장에 없는 파일은 세기만 한다.

    같은 권-번호에 파일이 여럿이면(재스캔 등) **PDF 우선 → 최근 수정 → 큰 것** 하나를 대표로 쓴다.
    """
    best = {}
    dup = 0
    for f in files:
        key = parse_name(f.get("name"))
        if not key:
            continue
        cur = best.get(key)
        if cur:
            dup += 1
        cand = (str(f.get("name", "")).lower().endswith(".pdf"), f.get("mtime") or "", int(f.get("size") or 0))
        if not cur or cand > cur[0]:
            best[key] = (cand, f)
    rows = []
    for vol, no in sorted(cases):
        hit = best.get((vol, no))
        if hit:
            f = hit[1]
            rows.append({"vol": vol, "no": no, "file_name": f.get("name"),
                         "size_kb": int(round(int(f.get("size") or 0) / 1024)),
                         "file_mtime": (f.get("mtime") + "+09:00") if f.get("mtime") else None, "matched": True})
        else:
            rows.append({"vol": vol, "no": no, "file_name": None, "size_kb": None, "file_mtime": None, "matched": False})
    orphans = sorted(k for k in best if k not in cases)
    unnamed = sum(1 for f in files if not parse_name(f.get("name")))
    return rows, {"files": len(files), "named": len(best), "dup": dup, "orphans": len(orphans),
                  "orphan_sample": ["%d-%d" % k for k in orphans[:5]], "unnamed": unnamed}


# ────────────────────────────────────────────────────────────── 중간DB
def _req(url, key, path, method="GET", body=None):
    req = urllib.request.Request(url + path, method=method,
                                 data=(json.dumps(body, ensure_ascii=False, default=str).encode("utf-8") if body is not None else None),
                                 headers={"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode("utf-8")
            return json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as e:
        raise RuntimeError("HTTP %s %s: %s" % (e.code, path.split("?")[0], e.read().decode("utf-8", "replace")[:400])) from e


def ledger_cases(url, key):
    """대장 건(권,번호) 전부 — 1,000행 상한을 넘어도 끝까지 읽는다."""
    out, off = set(), 0
    while True:
        rows = _req(url, key, "/rest/v1/v_pur_proposal_case?select=vol,no&order=vol,no&limit=1000&offset=%d" % off) or []
        out.update((int(r["vol"]), int(r["no"])) for r in rows)
        if len(rows) < 1000:
            return out
        off += 1000


def current_state(url, key):
    """(현재 일치 건수, 마지막 갱신 시각 KST)"""
    rows = _req(url, key, "/rest/v1/pur_proposal_scan?select=matched,checked_at&limit=100000") or []
    matched = sum(1 for r in rows if r.get("matched"))
    last = max((r["checked_at"] for r in rows if r.get("checked_at")), default=None)
    last_dt = datetime.datetime.fromisoformat(last.replace("Z", "+00:00")).astimezone(KST) if last else None
    return matched, last_dt


def night_boundary(now=None):
    """가장 최근의 밤 기준시각(KST). 20시 이전이면 어제 20시."""
    now = now or datetime.datetime.now(KST)
    b = now.replace(hour=NIGHT_HOUR, minute=0, second=0, microsecond=0)
    return b if now >= b else b - datetime.timedelta(days=1)


def rpc(url, key, fn, payload):
    return _req(url, key, "/rest/v1/rpc/" + fn, "POST", payload)


# ────────────────────────────────────────────────────────────── 진입점
def collect(dry=False, nightly=False, force=False):
    """러너·CLI 공용. 반환: "done" · "skip"(할 일 없음/드라이브 안 보임) — 예외는 진짜 실패."""
    load_env()
    scan_dir = (os.environ.get("PROPOSAL_SCAN_DIR") or "").strip().strip('"')
    if not scan_dir:
        raise RuntimeError(".env 에 PROPOSAL_SCAN_DIR(기안서 스캔본 폴더)가 없습니다")
    url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
    if not url or not key:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 없습니다(.env 확인)")

    prev_matched, last = current_state(url, key)
    if nightly and not force:
        b = night_boundary()
        if last and last >= b:
            print("[%s] 이번 밤(%s 이후) 갱신 완료(%s) — %s" % (JOB_NAME, b.strftime("%m-%d %H:%M"), last.strftime("%m-%d %H:%M"), IDLE))
            return "skip"

    try:
        files = list_scan_dir(scan_dir)
    except ScanUnavailable as e:
        print("[%s] 이번 회차 건너뜀 — %s. 다음 회차에 다시 봅니다 · %s" % (JOB_NAME, e, IDLE))
        return "skip"
    cases = ledger_cases(url, key)
    rows, st = build_rows(files, cases)
    matched = sum(1 for r in rows if r["matched"])
    print("[%s] 파일 %d개(권-번호 인식 %d · 중복 %d · 이름 규칙 밖 %d) · 대장 %d건 중 스캔 있음 %d · 없음 %d · 대장에 없는 파일 %d%s"
          % (JOB_NAME, st["files"], st["named"], st["dup"], st["unnamed"], len(cases), matched, len(cases) - matched,
             st["orphans"], (" (예 %s)" % ", ".join(st["orphan_sample"])) if st["orphan_sample"] else ""))

    if not files:
        # 드라이브는 열렸는데 0개 — 잠금 직전·권한 변화 등. 전량 교체하면 전부 「없음」이 되므로 막는다.
        if nightly:
            print("[%s] 목록이 비어 있어 적재하지 않음(드라이브 상태 확인 필요) · %s" % (JOB_NAME, IDLE))
            return "skip"
        raise RuntimeError("목록이 비어 있습니다 — 적재하지 않았습니다(폴더 경로·문서중앙화 로그인 확인)")
    if prev_matched and matched < prev_matched * 0.5 and not force:
        raise RuntimeError("스캔 있음 %d건이 종전 %d건의 절반 미만 — 부분 열람일 수 있어 적재하지 않았습니다(정말 줄었으면 --force)"
                           % (matched, prev_matched))
    if dry:
        print("[%s] (dry-run) 적재 생략" % JOB_NAME)
        return "done"

    batch_id = rpc(url, key, "erp_etl_batch", {"p_action": "start", "p_payload": {"job_name": JOB_NAME}})
    try:
        n = rpc(url, key, "pur_proposal_scan_upsert", {"p_rows": rows, "p_replace": True})
        rpc(url, key, "erp_etl_batch", {"p_action": "finish", "p_payload": {
            "batch_id": batch_id, "status": "success", "rows_read": len(files), "rows_upserted": int(n or 0)}})
        print("[%s] 완료 — 대장 %d건 갱신(스캔 있음 %d · 종전 %d)" % (JOB_NAME, int(n or 0), matched, prev_matched))
        return "done"
    except Exception as e:
        rpc(url, key, "erp_etl_batch", {"p_action": "finish", "p_payload": {
            "batch_id": batch_id, "status": "failed", "rows_read": len(files), "error_msg": str(e)[:500]}})
        raise


def main():
    ap = argparse.ArgumentParser(description="기안서 스캔본 목록(문서중앙화) → 중간DB 갱신 — 파일명·존재 여부만")
    ap.add_argument("--dry-run", action="store_true", help="목록만 읽고 대사 결과 출력(적재 안 함)")
    ap.add_argument("--nightly", action="store_true", help="러너 모드 — 이번 밤(20시 이후) 이미 갱신했으면 건너뜀")
    ap.add_argument("--force", action="store_true", help="안전장치(절반 미만) 무시·밤 1회 규칙 무시")
    ap.add_argument("--log", help="출력을 이 파일에 덧붙인다(예약작업·pythonw 용 — 콘솔이 없을 때)")
    a = ap.parse_args()
    if a.log:
        os.makedirs(os.path.dirname(os.path.abspath(a.log)), exist_ok=True)
        f = open(a.log, "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = f
        print("── %s" % datetime.datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S"))
    try:
        collect(dry=a.dry_run, nightly=a.nightly, force=a.force)
    except Exception as e:                      # SystemExit 를 던지지 않는다(상주 러너 보호)
        print("[%s] 실패: %s" % (JOB_NAME, e), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
