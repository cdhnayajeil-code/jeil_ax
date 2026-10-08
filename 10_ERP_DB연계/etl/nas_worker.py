# nas_worker.py — 사내 NAS 적재 요청 감시·실행 워커 (REQ-0097)
#
# 왜 필요한가: 사내 NAS 는 **사내 내부망·내부 방화벽 안**이라 Supabase Edge·브라우저가 NAS 로 들어갈 수 없다.
#   터널을 뚫으면 「외부 세션이 내부존에서 종단」되어 보안 승인·세그먼트 검토·네임서버 이관이 따라온다.
#   그래서 방향을 뒤집는다 — 이 워커가 **밖으로만** 연결해 큐(etl_meta.nas_request)를 집어가고,
#   내보낼 데이터도 RPC 로 페이지 단위로 받아 NAS 파일(JSONL)로 쓴다. 인바운드 0 · 방화벽 룰 추가 0건.
#   ERP 서버의 etl_watch.py 와 같은 구조이고, 이 파일은 그 모양을 의도적으로 베꼈다(테스트 틀도 같다).
#   기획 13_NAS_고도화/01(안 D) · ADR-110 · 정본 SQL 이관/sql/82_nas_export_queue.sql
#
# 무엇을 내보내는가는 **코드가 아니라 DB 허용 목록**(etl_meta.nas_export_source)이 정한다.
#   이 파일에 테이블 이름·SQL 을 심지 않는다 — 백업 등 새 용도는 허용 목록에 행을 더해 늘린다.
#
# 실행:
#   python nas_worker.py                      # 상주(기본 20초 주기 폴링)
#   python nas_worker.py --once               # 1회 확인 후 종료 — 요청 실패 시 exit 1
#   python nas_worker.py --self-check         # .env·RPC·허용목록·NAS 루트 점검(큐를 건드리지 않는다)
#   python nas_worker.py --source agent_turn  # 큐 없이 지정 소스만 즉시 내보내기(점검용)
#   python nas_worker.py --once --dry-run     # 파일을 쓰지 않고 첫 페이지만 받아 흐름 검증
#   python nas_worker.py --root <경로>         # NAS 루트를 직접 지정(검증용)
#
# NAS 루트(무엇 하나도 저장소에 적지 않는다 — CLAUDE.md §1.1):
#   ① --root  ② 환경변수 NAS_DATA_ROOT  ③ 저장소 .claude/nas.path (절대경로 1줄)
#   셋 다 없으면 **요청을 선점하지 않는다**. 못 하는 일을 조용히 성공으로 닫지 않는다(§17.6).
#
# 보안(CLAUDE.md §1·§4·§5):
#   · SUPABASE_SERVICE_ROLE_KEY 는 루트 .env 에서만 읽는다(출력 금지 — 키 이름·존재 여부만 찍는다).
#   · 급여(erp_secure)는 허용 목록에 등재 자체가 불가능하다(82번 CHECK: rel_schema = 'public').
#   · 대화기록에는 질문·답변 원문이 들어간다 → NAS 폴더 권한은 시스템·관리자 전용이어야 한다(§1.7).
#   · 원천은 읽기만 한다. 이 워커는 어떤 업무 데이터도 고치거나 지우지 않는다.
import argparse
import datetime
import gzip
import hashlib
import io
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from _env import env_root, load_env, need
import nas_index
import threading

WORKER_VERSION = "n1.11"   # n1.11(2026-10-08): 조회 병렬 처리(최대 4건 동시)·대기 오류 뒤 곧바로 다시 물기 — 동시 조회 지연(SQL 99) / n1.10(2026-10-08): 파일 목록에 문서 번호·읽기 여부를 붙임(목록 → 읽기 연결) · 문서 검색이 파일 이름도 봄 · zip 꼴 문서 압축 해제 크기 상한 / n1.9(2026-10-08): 표 구조 판독(doc_table)·판독 상태(index_status) 조회 + 색인 i1.1(읽는 형식 추가) — SQL 97 · REQ-0117 S1 / n1.8(2026-10-07): 부서 폴더의 이미지·PDF 를 화면으로 가져오기(SQL 93 · DRI D1) / n1.7(2026-10-06): 보관함 관리 — 사용자 폴더·내려받기(NAS→임시 버킷)·삭제 즉시 처리(SQL 90 · 일감은 nas_work_claim 하나로) / n1.6(2026-10-06): 과거 대화의 일시·기간 조건을 한국시간으로(적재 파일은 UTC 로 쌓인다 — N-2) · 저장 직후 색인 갱신 / n1.5(2026-10-06): 첨부 원본·생성 자료를 부서 폴더 「AI저장」에 저장·보존 만료 정리(SQL 89 · REQ-0108) / n1.4(2026-10-02): 문서 내용 색인·검색(nas_index.py — SQL 87) / n1.3:실시간 조회 응답(파일 목록·본인 과거 대화 — SQL 86) / n1.2:브리지 전송(좁은 키)·--serve(컨테이너 상주)·KST 고정 / n1.1: --nightly·--log·루트 검증

POLL_SEC = 20          # 기본 폴링 주기
HTTP_TIMEOUT = 120     # 페이지 응답이 수 MB 가 될 수 있어 etl_watch(60초)보다 넉넉히 잡는다

# 한 번에 받는 행 수. 전량 스냅샷은 열이 많은 뷰(발주통합 LIST 57열)가 있어 더 작게 잡는다.
PAGE_ROWS = {"incremental": 1000, "full": 2000}
MAX_PAGES = 2000       # 커서가 전진하지 않는 상황에서 영원히 도는 것을 막는 상한

KIND_DIR = {"turns": "대화기록", "erp_snapshot": "ERP스냅샷"}

# 접속 오류 원문에서 계정·서버 정보를 가린다 — 요청 결과(nas_request.result/error_msg)는 사내 로그인
# 사용자가 조회할 수 있어 원문(계정·연결 문자열 조각·IP)이 그대로 가면 안 된다. etl_watch.py 와 같은 규칙.
_REDACT_RULES = [
    (re.compile(r"(?i)(user\s+')[^']*(')"), r"\1***\2"),
    (re.compile(r"(?i)\b(UID|PWD|PASSWORD|USER ID|SERVER|DATA SOURCE|ADDRESS|DATABASE)\s*=\s*[^;'\"\]\)]*"), r"\1=***"),
    (re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}(?:[,:]\d+)?\b"), "***"),
    # NAS 공유 경로(\\host\share\...)도 가린다 — 경로 자체를 저장소·DB 에 남기지 않는다(§1.1)
    (re.compile(r"\\\\[^\s'\"]+"), r"\\\\***"),
    # 컨테이너·NAS 의 마운트 경로(/volume1/…, /data/…)도 같은 이유로 가린다
    (re.compile(r"(?<![\w.])/(?:volume\d+|data|mnt|state)(?:/[^\s'\"]*)?"), "/***"),
]

_NAME_RE = re.compile(r"^[a-z_][a-z0-9_]*$")

# 「오늘」은 한국 시각으로 고정한다 — NAS 컨테이너(slim 이미지)는 시간대 자료가 없어 UTC 로 돌 수 있고,
# 그러면 날짜 폴더·하루 1회 판정이 9시간 어긋난다.
_KST = datetime.timezone(datetime.timedelta(hours=9))


def _now():
    return datetime.datetime.now(_KST).replace(tzinfo=None)


# 전송 방식. "direct" = service_role 키로 PostgREST 직결(사내 PC·테스트),
# "bridge" = 전용 토큰으로 Edge Function(jeil-nas-bridge) 경유 — NAS 컨테이너에는 service_role 을 두지 않는다.
_TRANSPORT = "direct"

# 브리지가 중계해 주는 RPC. 서버(브리지)도 같은 목록으로 막지만, 워커가 먼저 걸러 실수를 일찍 드러낸다.
BRIDGE_FNS = (
    "nas_runner_ping", "nas_request_claim", "nas_request_progress", "nas_request_finish",
    "nas_export_sources", "nas_export_count", "nas_export_page", "nas_export_commit",
    "nas_query_claim", "nas_query_finish",   # 실시간 조회(정본 SQL 86 · REQ-0103)
    "nas_index_folders",                     # 문서 색인 대상 폴더(정본 SQL 87 · REQ-0104)
    "nas_save_claim", "nas_save_finish", "nas_save_purge_list", "nas_save_purged",   # 부서 폴더 저장(정본 SQL 89 · REQ-0108)
    "nas_save_fetch",                        # RPC 가 아니다 — 브리지가 저장할 파일의 1회용 내려받기 주소를 준다
    "nas_work_claim", "nas_fetch_finish",    # 일감 하나(저장·내려받기·삭제 신호) · 내려받기 결과(정본 SQL 90 · REQ-0108)
    "nas_fetch_put",                         # RPC 가 아니다 — 브리지가 내려받을 파일을 올릴 1회용 주소를 준다
)

# 실시간 조회 — 브리지에 한 번 물으면 이만큼 기다렸다 답이 온다(브리지 상한 20초와 같다)
QUERY_WAIT_SEC = 20
QUERY_SCAN_MAX = 20000     # 한 요청이 훑는 파일 수 상한 — 큰 폴더에서 응답이 늘어지는 것을 막는다
QUERY_DEPTH_MAX = 6
# 목록에서 빼는 이름: NAS 가 만드는 휴지통·색인 폴더, 숨김, 임시 파일
_SKIP_NAME = re.compile(r"^(?:[.#@~]|Thumbs\.db$|desktop\.ini$)|\.tmp$", re.I)


def _redact(msg):
    s = str(msg)
    for rx, rep in _REDACT_RULES:
        s = rx.sub(rep, s)
    return s


_LOG_FILE = None       # --log 로 받은 파일. 예약작업(pythonw)은 화면이 없어 여기에만 남는다


def log(msg):
    line = f"[{_now():%H:%M:%S}] {msg}"
    try:
        print(line, flush=True)
    except Exception:
        pass               # pythonw 는 stdout 이 없다
    if _LOG_FILE:
        try:
            with open(_LOG_FILE, "a", encoding="utf-8") as fh:
                fh.write(f"{_now().date():%Y-%m-%d} {line}\n")
        except Exception:
            pass


def rpc(url, key, fn, payload, wait_sec=0):
    """Supabase RPC 호출 → 파싱된 JSON(없으면 None). 오류 본문은 예외에 실어 진단 가능하게.

    wait_sec 은 브리지 전송에서만 뜻이 있다 — 결과가 없으면 브리지가 그만큼 기다렸다가 답한다(길게 대기).
    """
    timeout = HTTP_TIMEOUT
    if _TRANSPORT == "bridge":
        if fn not in BRIDGE_FNS:
            raise RuntimeError(f"브리지로 보낼 수 없는 RPC 입니다: {fn}")
        env = {"fn": fn, "payload": payload}
        if wait_sec:
            env["wait_ms"] = int(wait_sec * 1000)
            timeout = wait_sec + 30
        body = json.dumps(env, ensure_ascii=False, default=str).encode("utf-8")
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"x-nas-worker-token": key, "Content-Type": "application/json"},
        )
    else:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        req = urllib.request.Request(
            f"{url}/rest/v1/rpc/{fn}", data=body, method="POST",
            headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
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


# ── NAS 루트 ──────────────────────────────────────────────────────────────────
def nas_path_file():
    """`.claude/nas.path` 의 자리. 저장소 루트 기준 — EXE 로 돌 때는 없을 수 있다(그때는 NAS_DATA_ROOT)."""
    return os.path.join(env_root(), ".claude", "nas.path")


def nas_root(override=None):
    """NAS 루트 절대경로. 못 찾으면 RuntimeError(경로 값은 메시지에 넣지 않는다)."""
    cand = (override or "").strip()
    src = "--root"
    if not cand:
        cand = (os.environ.get("NAS_DATA_ROOT") or "").strip()
        src = "NAS_DATA_ROOT"
    if not cand:
        pf = nas_path_file()
        if os.path.exists(pf):
            try:
                cand = open(pf, encoding="utf-8").read().strip()
            except Exception as e:
                raise RuntimeError(f".claude/nas.path 를 읽을 수 없습니다: {type(e).__name__}")
            src = ".claude/nas.path"
    if not cand:
        raise RuntimeError(
            "NAS 루트를 모릅니다 — 다음 중 하나를 채우세요.\n"
            "  ① --root <경로>  ② 환경변수 NAS_DATA_ROOT\n"
            "  ③ .claude/nas.path 에 NAS 공유 폴더 절대경로를 한 줄로 적기\n"
            "  (저장소에는 경로를 적지 않습니다 — CLAUDE.md §1.1)")
    cand = cand.strip().strip('"')
    if not os.path.isdir(cand):
        raise RuntimeError(f"NAS 루트 폴더가 없거나 접근할 수 없습니다(출처 {src}) — 공유·권한을 확인하세요")
    return os.path.abspath(cand)


def _inside(root, path):
    """경로가 루트 밖으로 나가지 않는지 — 허용 목록이 이름을 제한하지만 2차 방어."""
    # 공유의 최상위(\\호스트\공유)는 abspath 가 끝에 구분자를 붙여 돌려준다 — 떼지 않으면 그 아래가 전부 「밖」으로 판정된다
    r = os.path.abspath(root).rstrip("\\/")
    p = os.path.abspath(path).rstrip("\\/")
    return p == r or p.startswith(r + os.sep)


def crypto_state():
    """암호화 가능 여부. 못 하면 **사유를 결과에 남긴다** — 조용히 건너뛰지 않는다(§17.6)."""
    try:
        import importlib.util
        if importlib.util.find_spec("cryptography") is not None:
            return True, None
    except Exception:
        pass
    return False, ("cryptography 모듈 없음 — 평문 JSONL 로 저장한다. "
                   "보완: NAS 폴더 권한(시스템·관리자 전용) + Hyper Backup 암호화")


# ── 내보내기 ──────────────────────────────────────────────────────────────────
def out_path(root, src, run_stamp):
    """소스별 출력 파일. 전량 스냅샷은 날짜 폴더에 하루 한 장(덮어씀), 증분은 회차마다 새 장."""
    key = src["source_key"]
    if not _NAME_RE.match(key or ""):
        raise RuntimeError(f"소스 이름 형식이 아닙니다: {str(key)[:40]}")
    kind_dir = KIND_DIR.get(src.get("kind"), "기타")
    if src["mode"] == "full":
        rel = os.path.join(kind_dir, run_stamp[:10], f"{key}.jsonl.gz")
    else:
        rel = os.path.join(kind_dir, key, run_stamp[:4], f"{key}_{run_stamp[:10]}_{run_stamp[11:]}.jsonl")
    p = os.path.join(root, rel)
    if not _inside(root, p):
        raise RuntimeError("출력 경로가 NAS 루트를 벗어납니다")
    return p, rel.replace("\\", "/")


def _open_out(path, gz):
    if gz:
        return gzip.open(path, "wt", encoding="utf-8", newline="\n")
    return io.open(path, "w", encoding="utf-8", newline="\n")


def export_source(url, key, root, src, run_stamp, dry=False):
    """소스 하나를 JSONL 로 내보낸다. 반환 dict(status·rows·sha256·file·커서 범위·error).

    성공(파일 기록 완료) 뒤에만 커서를 전진시킨다 — 중단되면 같은 지점부터 다시 한다.
    """
    sk = src["source_key"]
    mode = src["mode"]
    page = PAGE_ROWS.get(mode, 1000)
    from_cursor, from_pk = (src.get("last_cursor"), src.get("last_pk")) if mode == "incremental" else (None, None)
    res = {"source": sk, "label": src.get("label_ko"), "mode": mode, "rows": 0, "bytes": 0,
           "sha256": None, "file": None, "from_cursor": from_cursor, "to_cursor": None,
           "status": "success", "error": None}

    # 전량 스냅샷은 시작 전 건수를 받아 **다 받았는지 대조**한다(페이지 경계에서 행이 빠지면 여기서 걸린다).
    expect = None
    if mode == "full":
        c = rpc(url, key, "nas_export_count", {"p_source": sk})
        expect = int((c or {}).get("count") or 0)
        res["expected"] = expect

    if dry:
        got = rpc(url, key, "nas_export_page",
                  {"p_source": sk, "p_after_cursor": from_cursor, "p_after_pk": from_pk, "p_limit": min(page, 200)})
        got = got or {}
        res["rows"] = int(got.get("count") or 0)
        res["to_cursor"] = got.get("next_cursor")
        res["status"] = "dry"
        res["note"] = "dry-run — 첫 페이지만 받고 파일·커서는 건드리지 않았다"
        return res

    path, rel = out_path(root, src, run_stamp)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    sha = hashlib.sha256()
    total = 0
    pages = 0
    cur, pk = from_cursor, from_pk
    gz = path.endswith(".gz")
    try:
        with _open_out(tmp, gz) as f:
            while True:
                got = rpc(url, key, "nas_export_page",
                          {"p_source": sk, "p_after_cursor": cur, "p_after_pk": pk, "p_limit": page})
                got = got or {}
                rows = got.get("rows") or []
                for row in rows:
                    line = json.dumps(row, ensure_ascii=False, default=str, sort_keys=True) + "\n"
                    f.write(line)
                    sha.update(line.encode("utf-8"))
                total += len(rows)
                cur, pk = got.get("next_cursor"), got.get("next_pk")
                if not got.get("has_more"):
                    break
                # 커서가 전진하지 않으면 같은 페이지를 영원히 받는다 — 드러내고 멈춘다
                if mode == "incremental" and (cur is None or pk is None):
                    raise RuntimeError("커서를 이어받지 못했다(cursor_col·pk_col 값이 null) — 소스 정의를 확인하라")
                pages += 1
                if pages > MAX_PAGES:
                    raise RuntimeError(f"페이지 상한 {MAX_PAGES}회 초과 — 커서가 전진하지 않는지 확인하라")
        if expect is not None and total != expect:
            raise RuntimeError(f"건수 불일치 — 기대 {expect}행, 받은 {total}행(페이지 경계에서 행이 빠졌을 수 있다)")
        if total == 0 and mode == "incremental":
            # 새 행이 없으면 빈 파일을 남기지 않는다 — 야간에 매일 돌면 빈 장이 쌓여 폴더가 읽기 어려워진다.
            # 전량 스냅샷은 반대다: 0행이어도 「그날 비어 있었다」가 정보이므로 그대로 쓴다.
            os.remove(tmp)
            res.update(rows=0, file=None, to_cursor=cur, note="새 행 없음 — 파일을 만들지 않았다")
            rpc(url, key, "nas_export_commit",
                {"p_source": sk, "p_last_cursor": cur, "p_last_pk": pk, "p_rows": 0})
            return res
        os.replace(tmp, path)                       # 여기까지 와야 파일이 제자리에 놓인다
    except BaseException:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass
        raise

    res.update(rows=total, bytes=os.path.getsize(path), sha256=sha.hexdigest(), file=rel, to_cursor=cur)
    # 커서 전진 — 파일이 제자리에 놓인 뒤에만
    rpc(url, key, "nas_export_commit",
        {"p_source": sk, "p_last_cursor": cur, "p_last_pk": pk, "p_rows": total})
    return res


def pick_sources(url, key, kind, wanted):
    """이 요청이 내보낼 소스 목록. 비었으면 그 kind 의 활성 소스 전체."""
    all_src = rpc(url, key, "nas_export_sources", {"p_kind": kind}) or []
    by_key = {s["source_key"]: s for s in all_src}
    if not wanted:
        return all_src, []
    picked, missing = [], []
    for w in wanted:
        if w in by_key:
            picked.append(by_key[w])
        else:
            missing.append(w)
    return picked, missing


def write_manifest(root, run_stamp, body):
    """이 회차에 무엇을 얼마나 어떤 해시로 썼는지. 복원·대조의 근거다."""
    p = os.path.join(root, "_manifest", run_stamp[:10], f"{body['run_id']}.json")
    if not _inside(root, p):
        raise RuntimeError("manifest 경로가 NAS 루트를 벗어납니다")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with io.open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(body, f, ensure_ascii=False, indent=2, default=str)
    os.replace(tmp, p)
    return p


def run_export(url, key, root, kind, wanted, dry=False, run_id=None, on_progress=None):
    """소스 여러 개를 내보낸다. 한 소스가 실패해도 나머지는 계속 — 다만 하나라도 어긋나면 전체는 실패다."""
    started = _now()
    run_stamp = started.strftime("%Y-%m-%d %H%M%S")
    enc_ok, enc_why = crypto_state()
    srcs, missing = pick_sources(url, key, kind, wanted)
    detail = [{"source": m, "status": "failed", "error": "허용 목록에 없다"} for m in missing]
    rows_sum, files = 0, 0

    total = len(srcs)
    for i, s in enumerate(srcs):
        if on_progress:
            on_progress(i + 1, total, s["source_key"], rows_sum, files)
        try:
            r = export_source(url, key, root, s, run_stamp, dry=dry)
            rows_sum += int(r.get("rows") or 0)
            if r.get("file"):
                files += 1
            detail.append(r)
            log(f"  · {s['source_key']} — {r.get('rows')}행"
                + (f" · {r.get('file')}" if r.get("file") else f" · ({r.get('note') or 'dry'})"))
        except (Exception, SystemExit) as e:
            # need() 는 SystemExit(BaseException)을 던진다 — except Exception 만으로는 새어나간다
            msg = _redact(str(e.code) if isinstance(e, SystemExit) else str(e))
            detail.append({"source": s["source_key"], "status": "failed", "error": msg[:300]})
            log(f"  ! {s['source_key']} 실패: {msg[:200]}")

    fails = [d["source"] for d in detail if d.get("status") == "failed"]
    body = {
        "run_id": run_id or ("direct-" + started.strftime("%Y%m%d-%H%M%S")),
        "worker": socket.gethostname(), "worker_version": WORKER_VERSION,
        "kind": kind, "dry_run": bool(dry),
        "started_at": started.isoformat(timespec="seconds"),
        "finished_at": _now().isoformat(timespec="seconds"),
        "encrypted": enc_ok, "encrypt_note": enc_why,
        "sha256_note": "압축 전 JSONL 본문 기준(.gz 파일 바이트가 아니다)",
        "rows": rows_sum, "files": files, "failed": fails, "sources": detail,
    }
    if not dry:
        try:
            write_manifest(root, run_stamp, body)
        except Exception as e:
            log(f"  ! manifest 기록 실패: {_redact(e)[:200]}")
            body["manifest_error"] = _redact(str(e))[:300]
    return body


# ── 큐 처리 ───────────────────────────────────────────────────────────────────
def handle(url, key, worker, req, root, dry=False):
    rid = req["request_id"]
    kind = req.get("kind") or "turns"
    wanted = list(req.get("sources") or [])
    log(f"요청 수락 {rid[:8]}… (요청자 {req.get('requested_by') or '-'}) — {kind}"
        + (f" · 소스 {len(wanted)}종" if wanted else " · 활성 소스 전체")
        + (" · dry-run" if dry else ""))

    def prog(done, total, source, rows, files):
        try:
            rpc(url, key, "nas_request_progress",
                {"p_request_id": rid, "p_done": done, "p_total": total, "p_source": source,
                 "p_rows_read": rows, "p_files": files})
        except Exception:
            pass

    body = run_export(url, key, root, kind, wanted, dry=dry, run_id=rid[:8], on_progress=prog)
    status = "failed" if body["failed"] else "done"
    err = None
    if body["failed"]:
        err = "실패 " + ", ".join(body["failed"][:6]) + (" 등" if len(body["failed"]) > 6 else "")
    rpc(url, key, "nas_request_finish",
        {"p_request_id": rid, "p_status": status, "p_result": body,
         "p_rows_read": body["rows"], "p_files": body["files"], "p_error": err})
    log(f"요청 종료 {rid[:8]}… — {status} · {body['rows']}행 / 파일 {body['files']}개")
    return status


def _ping_note(root_ok):
    return f"+nas {WORKER_VERSION} root={'ok' if root_ok else 'none'}"


def tick(url, key, worker, root=None, dry=False):
    """심박 1회 + 대기 요청 있으면 1건 처리. 반환 False(할 일 없음) · "done" · "failed"."""
    root_err = None
    # 직접 받은 루트도 검증한다 — 검증 없이 쓰면 없는 폴더로도 요청을 집어 「새 행 없음 · done」으로 닫는다
    try:
        root = nas_root(root)
    except Exception as e:
        root, root_err = None, str(e)

    try:
        rpc(url, key, "nas_runner_ping", {"p_worker": worker, "p_note": _ping_note(bool(root))})
    except Exception as e:
        log(f"심박 실패(계속): {_redact(e)[:200]}")

    if not root:
        # 못 하는 일이면 **선점조차 하지 않는다** — 요청을 집어놓고 실패시키면 사람이 다시 눌러야 한다
        log("NAS 루트를 몰라 요청을 보지 않습니다 — " + (root_err or "").splitlines()[0])
        return False

    req = rpc(url, key, "nas_request_claim", {"p_worker": worker})
    if not req:
        log("대기 요청 없음")          # runner_core.IDLE_MARKERS 와 문자열이 같아야 idle 로그 정리가 된다
        return False
    try:
        return handle(url, key, worker, req, root, dry)
    except (Exception, SystemExit) as e:
        msg = _redact(str(e.code) if isinstance(e, SystemExit) else str(e))
        log(f"요청 처리 중 오류: {msg[:300]}")
        try:
            rpc(url, key, "nas_request_finish",
                {"p_request_id": req["request_id"], "p_status": "failed", "p_error": msg[:500]})
        except Exception:
            pass
        return "failed"


# ── 하루 한 번(예약작업용) ────────────────────────────────────────────────────
def _stamp_file():
    """그날 내보내기를 마쳤다는 표시. 이 PC 에 둔다 — NAS 가 안 보이는 날에도 읽을 수 있어야 한다."""
    return os.path.join(env_root(), "logs", "nas_nightly.json")


def nightly(url, key, worker, root_arg=None, dry=False, today=None):
    """기록 증분 + ERP 스냅샷을 **하루 한 번** 내보낸다. 예약작업이 자주 불러도 그날 성공했으면 큐만 본다.

    실패하거나 NAS 가 안 보이면 표시를 남기지 않는다 → 다음 회차에 다시 한다(PC 가 꺼져 있던 날은 켜진 뒤 첫 회차).
    """
    today = today or f"{_now().date():%Y-%m-%d}"
    stamp = _stamp_file()
    done = None
    try:
        with open(stamp, encoding="utf-8") as fh:
            done = json.load(fh).get("date")
    except Exception:
        pass

    if done == today:
        res = tick(url, key, worker, root_arg, dry)      # 심박 + 화면 요청만 처리
        return 1 if res == "failed" else 0

    try:
        root = nas_root(root_arg)
    except Exception as e:
        try:
            rpc(url, key, "nas_runner_ping", {"p_worker": worker, "p_note": _ping_note(False)})
        except Exception:
            pass
        log("오늘 적재를 미룹니다 — " + str(e).splitlines()[0])
        return 0
    try:
        rpc(url, key, "nas_runner_ping", {"p_worker": worker, "p_note": _ping_note(True)})
    except Exception as e:
        log(f"심박 실패(계속): {_redact(e)[:200]}")

    log(f"하루 1회 적재 시작 — {today} · 워커 {WORKER_VERSION}" + (" · dry-run" if dry else ""))
    bad, summary = 0, {}
    for k in ("turns", "erp_snapshot"):
        try:
            body = run_export(url, key, root, k, [], dry=dry)
        except (Exception, SystemExit) as e:
            log(f"  = {k}: 오류 — {_redact(e)[:300]}")
            bad += 1
            continue
        log(f"  = {k}: {body['rows']}행 / 파일 {body['files']}개"
            + (f" · 실패 {len(body['failed'])}종" if body["failed"] else ""))
        bad += len(body["failed"])
        summary[k] = {"rows": body["rows"], "files": body["files"]}
    if bad:
        log("실패가 있어 완료 표시를 남기지 않습니다 — 다음 회차에 다시 합니다")
        return 1
    if not dry:
        try:
            os.makedirs(os.path.dirname(stamp), exist_ok=True)
            with open(stamp, "w", encoding="utf-8") as fh:
                json.dump({"date": today, "at": f"{_now():%Y-%m-%d %H:%M:%S}",
                           "worker": WORKER_VERSION, "result": summary}, fh, ensure_ascii=False)
        except Exception as e:
            log(f"완료 표시를 못 남겼습니다(다음 회차에 한 번 더 내보냅니다): {type(e).__name__}")
    return 0


# ── 실시간 조회(에이전트 → NAS) ───────────────────────────────────────────────
# 무엇을 볼 수 있는지는 **요청 행의 scope 가 정한다**(서버가 계산해 적는다 — 정본 SQL 86).
# 워커는 그 범위를 넓히지 않는다: scope 밖 폴더·상위 이동·링크 따라가기를 모두 거부한다.
def nas_docs_root():
    """문서 루트(부서·전사공유 폴더가 있는 곳). 없으면 None — 파일 목록 조회만 못 한다.

    ① 환경변수 NAS_DOCS_ROOT ② 저장소 .claude/nas_docs.path (절대경로 1줄). 저장소에 경로를 적지 않는다(§1.1).
    """
    cand = (os.environ.get("NAS_DOCS_ROOT") or "").strip()
    if not cand:
        pf = os.path.join(env_root(), ".claude", "nas_docs.path")
        if os.path.exists(pf):
            try:
                with open(pf, encoding="utf-8") as fh:
                    cand = fh.read().strip()
            except Exception:
                cand = ""
    cand = cand.strip().strip('"')
    return os.path.abspath(cand) if cand and os.path.isdir(cand) else None


def _int(v, default, lo, hi):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def query_file_list(params, scope, docs_root):
    """허용 폴더 안의 파일 이름·수정일·크기. 내용은 읽지 않는다."""
    if not docs_root:
        raise RuntimeError("문서 폴더가 이 워커에 연결돼 있지 않습니다")
    folders = [f for f in (scope.get("folders") or []) if isinstance(f, dict)]
    if not folders:
        raise RuntimeError("볼 수 있는 폴더가 없습니다")
    needle = str(params.get("q") or "").strip().casefold()
    days = _int(params.get("days"), 0, 0, 3650)
    limit = _int(params.get("limit"), 20, 1, 50)
    since = time.time() - days * 86400 if days else None

    found, scanned, capped, used = [], 0, False, []
    for f in folders:
        rel = str(f.get("rel_path") or "").replace("\\", "/").strip("/")
        if not rel or any(p in ("", ".", "..") for p in rel.split("/")):
            continue                                    # DB CHECK 가 막지만 2차 방어
        base = os.path.join(docs_root, *rel.split("/"))
        if not _inside(docs_root, base) or not os.path.isdir(base) or os.path.islink(base):
            continue
        label = str(f.get("label") or f.get("key") or "")
        fkey = str(f.get("key") or "")
        used.append(label)
        stack = [(base, 0)]
        while stack and not capped:
            cur, depth = stack.pop()
            try:
                entries = list(os.scandir(cur))
            except OSError:
                continue
            for e in entries:
                if _SKIP_NAME.search(e.name):
                    continue
                try:
                    if e.is_symlink():
                        continue
                    if e.is_dir(follow_symlinks=False):
                        if depth < QUERY_DEPTH_MAX:
                            stack.append((e.path, depth + 1))
                        continue
                    if not e.is_file(follow_symlinks=False):
                        continue
                    scanned += 1
                    if scanned > QUERY_SCAN_MAX:
                        capped = True
                        break
                    if needle and needle not in e.name.casefold():
                        continue
                    st = e.stat(follow_symlinks=False)
                    if since and st.st_mtime < since:
                        continue
                    sub = os.path.relpath(cur, base).replace("\\", "/")
                    found.append((st.st_mtime, {
                        "_key": fkey,
                        "폴더": label,
                        "경로": "" if sub == "." else sub,       # 허용 폴더 안에서의 하위 경로만(절대경로를 내보내지 않는다)
                        "이름": e.name,
                        "수정일": datetime.datetime.fromtimestamp(st.st_mtime, _KST).strftime("%Y-%m-%d %H:%M"),
                        "크기_KB": max(1, round(st.st_size / 1024)),
                    }))
                except OSError:
                    continue
    found.sort(key=lambda x: x[0], reverse=True)
    top = [row for _, row in found[:limit]]
    _attach_doc_ids(top)
    return {
        "폴더": used, "해당": len(found), "반환수": len(top),
        "잘림": len(found) > limit, "훑기상한도달": capped,
        "목록": top,
    }, len(top)


def _attach_doc_ids(rows):
    """목록의 각 파일에 색인의 문서 번호·읽기 여부를 붙인다 — 이 번호로 문서 읽기·표 읽기를 부른다.
    색인이 없거나 아직 안 들어간 파일은 「준비 중」. 내용은 싣지 않는다. 색인 조회가 실패해도 목록은 그대로 나간다."""
    by_key = {}
    for r in rows:
        key = r.pop("_key", "")
        rel = (r["경로"] + "/" if r["경로"] else "") + r["이름"]
        by_key.setdefault(key, []).append((rel, r))
    con = None
    try:
        if os.path.exists(index_db_path()):
            con = nas_index.connect(index_db_path())
        for key, items in by_key.items():
            info = nas_index.lookup(con, key, [rel for rel, _ in items]) if con is not None and key else {}
            for rel, r in items:
                doc, ok, why, table = info.get(rel, (None, False, "아직 색인되지 않음(저장 직후에는 잠시 걸립니다)", False))
                r["문서"] = doc if ok else None
                r["읽기"] = "가능" if ok else ("준비 중" if doc is None else "불가")
                if not ok:
                    r["사유"] = why
                if ok and table:
                    r["표"] = True
    except Exception as e:                                  # 색인 문제로 목록까지 막지 않는다
        log(f"목록에 문서 번호 붙이기 실패(목록은 그대로 보냄): {_redact(e)[:160]}")
        for _, items in by_key.items():
            for _, r in items:
                r.setdefault("문서", None)
                r.setdefault("읽기", "확인 불가")
    finally:
        if con is not None:
            con.close()


def _excerpt(text, needle, width=260):
    s = " ".join(str(text or "").split())
    if not s:
        return ""
    i = s.casefold().find(needle) if needle else -1
    if i < 0:
        return s[:width] + ("…" if len(s) > width else "")
    a = max(0, i - width // 3)
    return ("…" if a else "") + s[a:a + width] + ("…" if a + width < len(s) else "")


def _kst_minute(ts):
    """적재 파일의 시각(UTC ISO 문자열) → 한국시간 'YYYY-MM-DD HH:MM'. 못 읽으면 앞 16자를 그대로 둔다."""
    raw = str(ts or "")
    try:
        d = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=datetime.timezone.utc)
        return d.astimezone(_KST).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return raw[:16].replace("T", " ")


def query_turn_history(params, scope, data_root):
    """NAS 에 쌓인 대화기록에서 **본인 것만** 찾는다. upn 은 요청 행(scope)이 정한다."""
    me = str(scope.get("upn") or "").strip().casefold()
    if not me:
        raise RuntimeError("조회 범위(본인 계정)가 비었습니다")
    needle = str(params.get("q") or "").strip().casefold()
    agent = str(params.get("agent_key") or "").strip()
    d_from = str(params.get("date_from") or "")[:10]
    d_to = str(params.get("date_to") or "")[:10]
    limit = _int(params.get("limit"), 10, 1, 20)

    base = os.path.join(data_root, KIND_DIR["turns"], "agent_turn")
    seen, hits = set(), []
    if os.path.isdir(base):
        for year in sorted(os.listdir(base), reverse=True):
            ydir = os.path.join(base, year)
            if not os.path.isdir(ydir) or not _inside(base, ydir):
                continue
            for name in sorted(os.listdir(ydir), reverse=True):
                if not name.endswith(".jsonl"):
                    continue
                try:
                    with io.open(os.path.join(ydir, name), encoding="utf-8") as fh:
                        lines = fh.read().splitlines()
                except OSError:
                    continue
                for ln in lines:
                    try:
                        r = json.loads(ln)
                    except ValueError:
                        continue
                    if str(r.get("upn") or "").casefold() != me or r.get("id") in seen:
                        continue
                    seen.add(r.get("id"))
                    if r.get("golden_run_id") is not None:
                        continue                                # 자동 회귀가 물어본 것은 본인의 대화가 아니다
                    when = _kst_minute(r.get("created_at"))     # 사용자가 말하는 날짜·시각은 한국시간이다
                    day = when[:10]
                    if (agent and r.get("agent_key") != agent) or (d_from and day < d_from) or (d_to and day > d_to):
                        continue
                    q, a = str(r.get("question") or ""), str(r.get("answer") or "")
                    if needle and needle not in q.casefold() and needle not in a.casefold():
                        continue
                    hits.append({"일시": when,
                                 "에이전트": r.get("agent_key"), "질문": _excerpt(q, needle, 200),
                                 "답변발췌": _excerpt(a, needle, 300), "턴번호": r.get("id")})
    hits.sort(key=lambda x: x["일시"], reverse=True)
    return {"해당": len(hits), "반환수": min(len(hits), limit), "잘림": len(hits) > limit,
            "목록": hits[:limit]}, min(len(hits), limit)


# ── 문서 내용 검색(P3 · nas_index.py) ─────────────────────────────────────────
def index_db_path():
    """색인 파일 자리. 사내에만 둔다 — 컨테이너는 /state, PC 는 저장소 logs/(git 제외)."""
    return (os.environ.get("NAS_INDEX_DB") or "").strip() or os.path.join(env_root(), "logs", "nas_index.sqlite")


def _scope_keys(scope):
    fs = [f for f in (scope.get("folders") or []) if isinstance(f, dict) and f.get("key")]
    return [str(f["key"]) for f in fs], {str(f["key"]): str(f.get("label") or f["key"]) for f in fs}


def query_doc_search(params, scope):
    keys, labels = _scope_keys(scope)
    if not os.path.exists(index_db_path()):
        raise RuntimeError("문서 색인이 아직 만들어지지 않았습니다")
    con = nas_index.connect(index_db_path())
    try:
        try:
            res, n = nas_index.search(con, params.get("q"), keys, _int(params.get("limit"), 8, 1, 15))
        except ValueError as e:
            return {"해당문서수": 0, "반환수": 0, "목록": [], "사유": str(e)}, 0
        for h in res["목록"]:
            h["폴더"] = labels.get(h.pop("폴더키"), "")
        return res, n
    finally:
        con.close()


def query_doc_read(params, scope):
    keys, _ = _scope_keys(scope)
    if not os.path.exists(index_db_path()):
        raise RuntimeError("문서 색인이 아직 만들어지지 않았습니다")
    con = nas_index.connect(index_db_path())
    try:
        try:
            return nas_index.read(con, params.get("doc"), keys, _int(params.get("seq"), 0, 0, 100000))
        except ValueError as e:
            return {"내용": "", "사유": str(e)}, 0
    finally:
        con.close()


def query_index_status(params, scope):
    """허용 폴더 안 파일의 판독 상태(읽힘 / 못 읽음·사유). 내용은 싣지 않는다 — 보관함 화면이 쓴다."""
    keys, labels = _scope_keys(scope)
    if not os.path.exists(index_db_path()):
        raise RuntimeError("문서 색인이 아직 만들어지지 않았습니다")
    con = nas_index.connect(index_db_path())
    try:
        try:
            res, n = nas_index.file_status(con, keys, params.get("under"), _int(params.get("limit"), 300, 1, 500))
        except ValueError as e:
            return {"목록": [], "반환수": 0, "사유": str(e)}, 0
        for h in res["목록"]:
            h["폴더"] = labels.get(h["폴더키"], "")
        return res, n
    finally:
        con.close()


def query_doc_table(params, scope, docs_root):
    """엑셀·CSV 한 건을 표 구조(시트·머리글·열·행 번호·날짜)로. 범위(scope) 밖 문서는 번호를 알아도 못 읽는다."""
    if not docs_root:
        raise RuntimeError("문서 폴더가 이 워커에 연결돼 있지 않습니다")
    keys, _ = _scope_keys(scope)
    if not os.path.exists(index_db_path()):
        raise RuntimeError("문서 색인이 아직 만들어지지 않았습니다")
    con = nas_index.connect(index_db_path())
    try:
        try:
            key, rel, name, mtime, size = nas_index.locate(con, params.get("doc"), keys)
        except ValueError as e:
            return {"행": [], "사유": str(e)}, 0
    finally:
        con.close()
    folder = next((f for f in (scope.get("folders") or []) if isinstance(f, dict) and str(f.get("key")) == key), None)
    base_rel = str((folder or {}).get("rel_path") or "").replace("\\", "/").strip("/")
    parts = base_rel.split("/") + str(rel).replace("\\", "/").strip("/").split("/")
    if not base_rel or any(p in ("", ".", "..") for p in parts):
        return {"행": [], "사유": "문서 경로가 올바르지 않습니다"}, 0
    path = os.path.join(docs_root, *parts)
    if not _inside(docs_root, path) or os.path.islink(path) or not os.path.isfile(path):
        return {"행": [], "사유": "문서를 찾을 수 없습니다(옮겨졌거나 지워졌습니다)"}, 0
    # 색인이 본 그 파일이어야 한다 — 색인 뒤에 바뀐 파일은 민감 정보 검사를 다시 거칠 때까지 내주지 않는다
    st = os.stat(path)
    if st.st_size != size or abs(st.st_mtime - (mtime or 0)) >= 1:
        _INDEX_WAKE.set()
        return {"행": [], "사유": "파일이 바뀌어 다시 확인하는 중입니다 — 잠시 뒤 다시 시도하세요"}, 0
    try:
        res, n = nas_index.read_table(path, params.get("sheet"), params.get("start") or None,
                                      _int(params.get("rows"), 60, 1, nas_index.TABLE_MAX_ROWS))
    except ValueError as e:
        return {"행": [], "사유": str(e)}, 0
    head = {"문서": f"{key}:{str(params.get('doc')).split(':', 1)[1]}", "이름": name,
            "경로": rel.rsplit("/", 1)[0] if "/" in rel else "",
            "수정일": datetime.datetime.fromtimestamp(mtime or 0, _KST).strftime("%Y-%m-%d")}
    head.update(res)
    return head, n


# 저장이 끝나면 켠다 — 색인 루프가 10분을 다 기다리지 않고 곧 한 번 돈다(방금 저장한 문서가 바로 검색되게)
_INDEX_WAKE = threading.Event()
INDEX_WAKE_DELAY = 5          # 연달아 저장할 때 한 번에 묶으려고 잠깐 기다린다


def index_loop(url, key, interval=600, rounds=None):
    """허용 폴더 목록을 받아 색인을 갱신한다(바뀐 파일만). 조회·적재와 따로 돈다."""
    n = 0
    while rounds is None or n < rounds:
        n += 1
        try:
            docs = nas_docs_root()
            if docs:
                folders = rpc(url, key, "nas_index_folders", {}) or []
                con = nas_index.connect(index_db_path())
                try:
                    nas_index.refresh(con, docs, folders, log=log, budget_sec=300)
                finally:
                    con.close()
                purge_saved(url, key, docs)        # 삭제 요청·보존 만료분 정리(색인 주기에 얹는다 — 10분마다)
        except (Exception, SystemExit) as e:
            log(f"문서 색인 오류(계속): {_redact(e)[:200]}")
        if rounds is None or n < rounds:
            if _INDEX_WAKE.wait(max(30, interval)):
                time.sleep(INDEX_WAKE_DELAY)
            _INDEX_WAKE.clear()


def handle_query(url, key, q, data_root, docs_root):
    """조회 1건 처리 → 결과 되쓰기. 어떤 오류가 나도 요청을 running 에 방치하지 않는다."""
    qid, kind = q.get("query_id"), q.get("kind")
    t0 = time.time()
    try:
        params = q.get("params") if isinstance(q.get("params"), dict) else {}
        scope = q.get("scope") if isinstance(q.get("scope"), dict) else {}
        if kind == "file_list":
            result, n = query_file_list(params, scope, docs_root)
        elif kind == "turn_history":
            result, n = query_turn_history(params, scope, data_root)
        elif kind == "doc_search":
            result, n = query_doc_search(params, scope)
        elif kind == "doc_read":
            result, n = query_doc_read(params, scope)
        elif kind == "doc_table":
            result, n = query_doc_table(params, scope, docs_root)
        elif kind == "index_status":
            result, n = query_index_status(params, scope)
        else:
            raise RuntimeError(f"이 워커가 모르는 조회 종류입니다: {kind}")
        rpc(url, key, "nas_query_finish", {"p_query_id": qid, "p_status": "done", "p_result": result, "p_rows": n})
        log(f"조회 {str(qid)[:8]}… {kind} — {n}건 · {int((time.time() - t0) * 1000)}ms")
        return "done"
    except (Exception, SystemExit) as e:
        msg = _redact(e)[:300]
        log(f"조회 {str(qid)[:8]}… {kind} 실패 — {msg}")
        try:
            rpc(url, key, "nas_query_finish", {"p_query_id": qid, "p_status": "failed", "p_error": msg})
        except Exception:
            pass
        return "failed"


QUERY_PARALLEL = 4         # 동시에 처리하는 조회 수 — 한 줄로 처리하면 여럿이 같이 물을 때 뒤 사람이 앞 사람을 기다린다(실측: 5건 동시에 3.5초)
QUERY_RETRY_MAX_SEC = 5    # 대기 오류가 이어질 때 쉬는 시간 상한(첫 오류는 0.5초만 쉰다)


def _answer_query(url, key, q, root_arg):
    """조회 한 건을 끝까지 처리한다(병렬 일꾼). 어떤 오류도 밖으로 내보내지 않는다 — 다른 조회에 번지지 않게."""
    try:
        try:
            data_root = nas_root(root_arg)
        except Exception as e:
            rpc(url, key, "nas_query_finish", {"p_query_id": q.get("query_id"), "p_status": "failed",
                                               "p_error": str(e).splitlines()[0][:200]})
            return
        handle_query(url, key, q, data_root, nas_docs_root())
    except (Exception, SystemExit) as e:
        log(f"조회 처리 오류(계속): {_redact(e)[:200]}")


def query_loop(url, key, worker, root_arg=None, rounds=None):
    """조회 요청을 물고 기다리다 처리한다. 적재와 따로 돈다 — 밤 적재 1분 동안에도 조회가 막히지 않게.

    일감을 받는 것은 이 루프 하나지만, 받은 일감은 일꾼 스레드에 넘기고 곧바로 다음 일감을 문다(최대 QUERY_PARALLEL 건 동시).
    그래야 여러 사람이 같이 물어도 뒤 사람이 앞 사람의 조회가 끝나기를 기다리지 않는다.
    """
    n, errs = 0, 0
    slots = threading.BoundedSemaphore(QUERY_PARALLEL)
    busy = []

    def run(q):
        try:
            _answer_query(url, key, q, root_arg)
        finally:
            slots.release()

    while rounds is None or n < rounds:
        n += 1
        slots.acquire()                            # 일꾼이 다 찼으면 자리가 날 때까지 새 일감을 받지 않는다
        handed = False
        try:
            if _TRANSPORT == "bridge":
                q = rpc(url, key, "nas_query_claim", {"p_worker": worker}, wait_sec=QUERY_WAIT_SEC)
            else:
                q = rpc(url, key, "nas_query_claim", {"p_worker": worker})
            errs = 0
            if q:
                t = threading.Thread(target=run, args=(q,), name="nas-query", daemon=True)
                t.start()
                handed = True
                busy = [x for x in busy if x.is_alive()] + [t]
            elif _TRANSPORT != "bridge" and (rounds is None or n < rounds):
                time.sleep(1)                      # 직결에는 길게 대기가 없다 — 1초 폴링
        except (Exception, SystemExit) as e:
            errs += 1
            log(f"조회 대기 오류(계속): {_redact(e)[:200]}")
            if rounds is None or n < rounds:
                # 길게 대기 중 연결이 끊기는 일은 흔하다(중계 함수 교체·네트워크). 그때 5초를 쉬면 그 사이 들어온 조회가 통째로 늦는다 —
                # 첫 오류는 곧바로 다시 물고, 오류가 이어질 때만 간격을 늘린다.
                time.sleep(min(QUERY_RETRY_MAX_SEC, 0.5 * errs))
        finally:
            if not handed:
                slots.release()
    for t in busy:                                 # 횟수를 정해 돌린 경우(시험·점검)에는 넘긴 일감이 끝나기를 기다린다
        t.join(timeout=60)


# ── 부서 폴더 저장(REQ-0108 · 정본 SQL 89) ───────────────────────────────────
# 사용자가 화면에서 [NAS 저장]을 누른 첨부 원본·생성 자료를 부서 폴더의 「AI저장/연도/」에 쓴다.
# 어느 폴더인지는 DB 가 정해서 준다(folder_rel) — 워커는 그 폴더 밖으로 쓰지 않는다.
SAVE_DIR = "AI저장"
SAVE_MAX_BYTES = 10 * 1024 * 1024          # 정책(max_mb ≤ 10)과 버킷 한도의 상한 — 넘으면 받다가 끊는다
SAVE_WAIT_SEC = 20
_BAD_NAME_CH = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def _safe_file_name(name):
    """파일 이름만 남긴다(경로·금지 글자 제거). 비면 None."""
    n = _BAD_NAME_CH.sub(" ", str(name or ""))
    n = re.sub(r"\s+", " ", n).strip().lstrip(". ").strip()
    return n[:150] or None


def _safe_subdir(name):
    """사용자 폴더 이름 — 「AI저장」 바로 아래 한 단계만. DB(nas_subdir_ok)가 이미 걸렀지만 여기서 한 번 더 본다."""
    n = str(name or "")
    if (not n or n != n.strip() or len(n) > 40 or _BAD_NAME_CH.search(n) or n.startswith(".") or n.endswith(".")
            or re.fullmatch(r"\d{4}", n) or nas_index._SENSITIVE_NAME.search(n)):
        raise RuntimeError("폴더 이름이 올바르지 않습니다")
    return n


def save_target(docs_root, folder_rel, file_name, saved_on, subdir=None):
    """저장할 절대 경로와 폴더 기준 상대 경로. 같은 이름이 있으면 _2, _3 … 을 붙인다. 폴더 밖이면 예외.

    subdir(사용자 폴더)가 있으면 「AI저장/<폴더>/」, 없으면 「AI저장/<연도>/」."""
    rel = str(folder_rel or "").replace("\\", "/").strip("/")
    if not rel or any(p in ("", ".", "..") for p in rel.split("/")):
        raise RuntimeError("대상 폴더 경로가 올바르지 않습니다")
    base = os.path.join(docs_root, *rel.split("/"))
    if not _inside(docs_root, base) or not os.path.isdir(base) or os.path.islink(base):
        raise RuntimeError("대상 부서 폴더가 없습니다")
    name = _safe_file_name(file_name)
    if not name:
        raise RuntimeError("파일 이름이 올바르지 않습니다")
    if nas_index._SENSITIVE_NAME.search(name):
        raise RuntimeError("민감 자료로 보이는 이름이라 저장하지 않습니다")
    year = str(saved_on or "")[:4]
    if not re.fullmatch(r"\d{4}", year):
        year = _now().strftime("%Y")
    if subdir:
        year = _safe_subdir(subdir)              # 아래에서 폴더 이름 자리로 쓴다
    folder = os.path.join(base, SAVE_DIR, year)
    stem, ext = os.path.splitext(name)
    cand, n = name, 1
    while os.path.exists(os.path.join(folder, cand)):
        n += 1
        if n > 500:
            raise RuntimeError("같은 이름의 파일이 너무 많습니다")
        cand = f"{stem}_{n}{ext}"
    path = os.path.join(folder, cand)
    if not _inside(base, path):
        raise RuntimeError("저장 경로가 폴더 밖입니다")
    return path, f"{SAVE_DIR}/{year}/{cand}"


def _download(file_url, limit=SAVE_MAX_BYTES):
    """1회용 주소에서 파일을 받는다. 한도를 넘으면 중단. (주소는 로그에 남기지 않는다)"""
    req = urllib.request.Request(file_url, method="GET")
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
        data = r.read(limit + 1)
    if len(data) > limit:
        raise RuntimeError("파일이 한도보다 큽니다")
    return data


def fetch_save_bytes(url, key, save_id, worker):
    """저장할 파일 내용. 브리지: 1회용 주소를 받아 내려받는다 / 직결(사내 PC·테스트): Storage 에 서명 주소를 직접 청한다."""
    if _TRANSPORT == "bridge":
        got = rpc(url, key, "nas_save_fetch", {"p_save_id": save_id})
        file_url = (got or {}).get("url") if isinstance(got, dict) else None
    else:
        direct_only = "nas_save_source"          # 직결 전용 — 브리지는 이 RPC 를 중계하지 않고 주소만 준다(BRIDGE_FNS 밖)
        src = rpc(url, key, direct_only, {"p_save_id": save_id, "p_worker": worker}) or {}
        if not src.get("bucket") or not src.get("path"):
            raise RuntimeError("원본 위치를 받지 못했습니다")
        body = json.dumps({"expiresIn": 120}).encode("utf-8")
        req = urllib.request.Request(
            f"{url}/storage/v1/object/sign/{src['bucket']}/{urllib.parse.quote(src['path'])}", data=body, method="POST",
            headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            signed = json.loads(r.read().decode("utf-8"))
        part = signed.get("signedURL") or signed.get("signedUrl") or ""
        file_url = f"{url}/storage/v1{part}" if part.startswith("/") else part
    if not file_url:
        raise RuntimeError("내려받기 주소를 받지 못했습니다")
    return _download(file_url)


def handle_save(url, key, job, docs_root, worker, fetch=None):
    """저장 1건 처리 → 결과 되쓰기. 어떤 오류가 나도 요청을 running 에 방치하지 않는다. fetch 는 테스트용 주입."""
    sid = job.get("save_id")
    t0 = time.time()
    tmp = None
    try:
        if not docs_root:
            raise RuntimeError("문서 폴더가 연결돼 있지 않습니다")
        path, rel = save_target(docs_root, job.get("folder_rel"), job.get("file_name"), job.get("saved_on"), job.get("subdir"))
        data = (fetch or fetch_save_bytes)(url, key, sid, worker)
        if not data:
            raise RuntimeError("빈 파일입니다")
        want = job.get("size_bytes")
        if want and int(want) != len(data):
            raise RuntimeError("받은 크기가 요청과 다릅니다")
        sha = job.get("sha256")
        if sha and hashlib.sha256(data).hexdigest() != str(sha).lower():
            raise RuntimeError("받은 내용이 요청과 다릅니다(해시 불일치)")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"                      # .tmp 는 목록·색인에서 빠진다 — 다 쓴 뒤 이름을 바꾼다
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
        tmp = None
        rpc(url, key, "nas_save_finish", {"p_save_id": sid, "p_status": "done", "p_rel_path": rel})
        _INDEX_WAKE.set()
        log(f"저장 {str(sid)[:8]}… {job.get('folder_key')} — {len(data):,}바이트 · {int((time.time() - t0) * 1000)}ms")
        return True
    except (Exception, SystemExit) as e:
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass
        msg = _redact(e).splitlines()[0][:200] if str(e) else type(e).__name__
        try:
            rpc(url, key, "nas_save_finish", {"p_save_id": sid, "p_status": "failed", "p_error": msg})
        except (Exception, SystemExit) as e2:
            log(f"저장 {str(sid)[:8]}… 실패 기록도 실패: {_redact(e2)[:160]}")
        log(f"저장 {str(sid)[:8]}… 실패: {msg}")
        return False


def saved_file_path(docs_root, folder_rel, rel_path):
    """저장 대장의 (부서 폴더, 상대 경로) → 절대 경로. 「AI저장」 아래가 아니면 예외 — 내려받기·삭제가 함께 쓴다."""
    frel = str(folder_rel or "").replace("\\", "/").strip("/")
    rel = str(rel_path or "").replace("\\", "/").strip("/")
    parts = rel.split("/")
    if not frel or not rel or parts[0] != SAVE_DIR or any(p in ("", ".", "..") for p in parts + frel.split("/")):
        raise RuntimeError("경로가 올바르지 않습니다")
    base = os.path.join(docs_root, *frel.split("/"))
    path = os.path.join(base, *parts)
    if not _inside(os.path.join(base, SAVE_DIR), path):
        raise RuntimeError("경로가 저장 폴더 밖입니다")
    return path


VIEW_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"}     # 화면으로 가져올 수 있는 형식(SQL 93 과 같은 목록)


def folder_file_path(docs_root, folder_rel, src_rel):
    """부서 폴더 안의 파일(대장 밖 — 부서원이 직접 넣은 자료) → 절대 경로. 폴더 밖·숨김·민감 이름·형식 밖이면 예외."""
    frel = str(folder_rel or "").replace("\\", "/").strip("/")
    rel = str(src_rel or "").replace("\\", "/").strip("/")
    parts = rel.split("/")
    if not frel or not rel or any(p in ("", ".", "..") for p in parts + frel.split("/")):
        raise RuntimeError("경로가 올바르지 않습니다")
    if any(_SKIP_NAME.search(p) or _BAD_NAME_CH.search(p) for p in parts):
        raise RuntimeError("가져올 수 없는 이름입니다")
    if os.path.splitext(parts[-1])[1].lower() not in VIEW_EXT:
        raise RuntimeError("이미지·PDF 만 가져올 수 있습니다")
    if nas_index._SENSITIVE_NAME.search(rel):
        raise RuntimeError("민감 자료로 보이는 이름이라 가져오지 않습니다")
    base = os.path.join(docs_root, *frel.split("/"))
    path = os.path.join(base, *parts)
    if not _inside(base, path) or not _inside(docs_root, base):
        raise RuntimeError("경로가 폴더 밖입니다")
    # 중간 폴더가 바로가기(링크)면 폴더 밖을 가리킬 수 있다 — 실제 위치로 한 번 더 본다
    if not _inside(os.path.realpath(base), os.path.realpath(path)):
        raise RuntimeError("경로가 폴더 밖입니다")
    return path


def put_fetch_bytes(url, key, fetch_id, worker, data):
    """내려받을 파일을 임시 버킷에 올린다. 브리지: 1회용 올리기 주소 / 직결(사내 PC·테스트): Storage 에 직접."""
    if _TRANSPORT == "bridge":
        got = rpc(url, key, "nas_fetch_put", {"p_fetch_id": fetch_id})
        put_url = (got or {}).get("url") if isinstance(got, dict) else None
        if not put_url:
            raise RuntimeError("올리기 주소를 받지 못했습니다")
        req = urllib.request.Request(put_url, data=data, method="PUT", headers={"Content-Type": "application/octet-stream"})
    else:
        direct_only = "nas_fetch_source"         # 직결 전용 — 브리지는 주소만 준다(BRIDGE_FNS 밖)
        src = rpc(url, key, direct_only, {"p_fetch_id": fetch_id, "p_worker": worker}) or {}
        if not src.get("bucket") or not src.get("path"):
            raise RuntimeError("올릴 위치를 받지 못했습니다")
        req = urllib.request.Request(
            f"{url}/storage/v1/object/{src['bucket']}/{urllib.parse.quote(src['path'])}", data=data, method="POST",
            headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/octet-stream", "x-upsert": "true"})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
        r.read()


def handle_fetch(url, key, job, docs_root, worker, put=None):
    """내려받기 1건 — NAS 의 보관 파일을 임시 버킷에 올리고 결과를 되쓴다. put 은 테스트용 주입."""
    fid = job.get("fetch_id")
    t0 = time.time()
    try:
        if not docs_root:
            raise RuntimeError("문서 폴더가 연결돼 있지 않습니다")
        if job.get("src_rel"):                   # 부서 폴더의 파일(대장 밖) — 이미지·PDF 만
            path = folder_file_path(docs_root, job.get("folder_rel"), job.get("src_rel"))
        else:
            path = saved_file_path(docs_root, job.get("folder_rel"), job.get("rel_path"))
        if not os.path.isfile(path) or os.path.islink(path):
            raise RuntimeError("NAS 에 파일이 없습니다(지워졌거나 옮겨졌습니다)")
        if os.path.getsize(path) > SAVE_MAX_BYTES:
            raise RuntimeError("파일이 한도보다 큽니다")
        with open(path, "rb") as fh:
            data = fh.read()
        (put or put_fetch_bytes)(url, key, fid, worker, data)
        rpc(url, key, "nas_fetch_finish", {"p_fetch_id": fid, "p_status": "done"})
        log(f"내려받기 {str(fid)[:8]}… {job.get('folder_key')} — {len(data):,}바이트 · {int((time.time() - t0) * 1000)}ms")
        return True
    except (Exception, SystemExit) as e:
        msg = _redact(e).splitlines()[0][:200] if str(e) else type(e).__name__
        try:
            rpc(url, key, "nas_fetch_finish", {"p_fetch_id": fid, "p_status": "failed", "p_error": msg})
        except (Exception, SystemExit) as e2:
            log(f"내려받기 {str(fid)[:8]}… 실패 기록도 실패: {_redact(e2)[:160]}")
        log(f"내려받기 {str(fid)[:8]}… 실패: {msg}")
        return False


def save_loop(url, key, worker, rounds=None):
    """일감(저장·내려받기·삭제 신호)을 물고 기다리다 처리한다. 조회·적재와 따로 돈다."""
    n = 0
    while rounds is None or n < rounds:
        n += 1
        try:
            if _TRANSPORT == "bridge":
                job = rpc(url, key, "nas_work_claim", {"p_worker": worker}, wait_sec=SAVE_WAIT_SEC)
            else:
                job = rpc(url, key, "nas_work_claim", {"p_worker": worker})
            kind = (job or {}).get("job") if isinstance(job, dict) else None
            if kind == "fetch":
                handle_fetch(url, key, job, nas_docs_root(), worker)
            elif kind == "purge":
                # 삭제 요청이 있다는 신호 — 바로 지운다. 하나도 못 지웠으면 신호가 그대로라 헛돌 수 있어 잠깐 쉰다
                if not purge_saved(url, key, nas_docs_root()) and (rounds is None or n < rounds):
                    time.sleep(15)
            elif job:
                handle_save(url, key, job, nas_docs_root(), worker)
            elif _TRANSPORT != "bridge" and (rounds is None or n < rounds):
                time.sleep(3)
        except (Exception, SystemExit) as e:
            log(f"저장 대기 오류(계속): {_redact(e)[:200]}")
            if rounds is None or n < rounds:
                time.sleep(5)


def purge_saved(url, key, docs_root):
    """삭제 요청된 것·(정책이 삭제일 때) 보존 기간이 지난 것을 지운다. 「AI저장」 아래의 파일만 지운다."""
    if not docs_root:
        return 0
    try:
        rows = rpc(url, key, "nas_save_purge_list", {"p_limit": 20}) or []
    except (Exception, SystemExit) as e:
        log(f"저장 정리 목록 오류(계속): {_redact(e)[:160]}")
        return 0
    done = 0
    for r in rows if isinstance(rows, list) else []:
        sid = r.get("save_id")
        try:
            path = saved_file_path(docs_root, r.get("folder_rel"), r.get("rel_path"))
            if os.path.isfile(path) and not os.path.islink(path):
                os.remove(path)
                try:
                    os.rmdir(os.path.dirname(path))      # 비었을 때만 지워진다(연도·사용자 폴더). 다시 저장하면 새로 생긴다
                except OSError:
                    pass
            rpc(url, key, "nas_save_purged", {"p_save_id": sid, "p_ok": True})   # 이미 없어도 지운 것으로 맺는다
            done += 1
        except (Exception, SystemExit) as e:
            try:
                rpc(url, key, "nas_save_purged", {"p_save_id": sid, "p_ok": False, "p_error": _redact(e).splitlines()[0][:200]})
            except (Exception, SystemExit):
                pass
    if done:
        log(f"저장 정리 — {done}건 삭제")
        _INDEX_WAKE.set()                        # 지운 문서가 검색에 남지 않게 색인도 곧 갱신한다
    return done


# ── 상주(컨테이너 진입점) ─────────────────────────────────────────────────────
def serve(url, key, worker, root_arg=None, dry=False, interval=POLL_SEC, rounds=None, query=True):
    """계속 돌면서 하루 1회 적재 + 화면 요청 처리 + 실시간 조회 응답. nightly() 가 「그날 했으면 큐만 본다」를 이미 안다.

    rounds 는 테스트용(몇 바퀴만 돌고 끝). 어떤 오류가 나도 루프는 죽지 않는다 — 다음 바퀴에 다시 한다.
    """
    log(f"NAS 워커 상주 시작 — {WORKER_VERSION} · host={worker} · 전송 {_TRANSPORT}" + (" · dry-run" if dry else "")
        + (" · 조회 응답 켬" if query and not dry else ""))
    if query and not dry and rounds is None:
        threading.Thread(target=query_loop, args=(url, key, worker, root_arg), daemon=True, name="nas-query").start()
        threading.Thread(target=index_loop, args=(url, key), daemon=True, name="nas-index").start()
        threading.Thread(target=save_loop, args=(url, key, worker), daemon=True, name="nas-save").start()
    n = 0
    while rounds is None or n < rounds:
        n += 1
        try:
            nightly(url, key, worker, root_arg, dry)
        except (Exception, SystemExit) as e:
            log(f"회차 오류(계속): {_redact(e)[:200]}")
        if rounds is None or n < rounds:
            time.sleep(max(5, interval))
    return 0


# ── 자체 점검 ─────────────────────────────────────────────────────────────────
def self_check(url, key, root_arg=None):
    """큐를 건드리지 않고 준비 상태만 본다. 비밀값은 **이름·길이**만 찍는다(§1.8)."""
    ok = True
    log(f"자체 점검 — 워커 {WORKER_VERSION} · host={socket.gethostname()}")
    log(f"  · .env 위치: {os.path.join(env_root(), '.env')} ({'있음' if os.path.exists(os.path.join(env_root(), '.env')) else '없음'})")
    if _TRANSPORT == "bridge":
        log(f"  · 전송: 브리지(전용 토큰) · NAS_BRIDGE_URL: {'있음' if url else '없음'} · NAS_WORKER_TOKEN: "
            f"{'있음(길이 %d)' % len(key) if key else '없음'}")
    else:
        log(f"  · 전송: 직결 · SUPABASE_URL: {'있음' if url else '없음'} · SUPABASE_SERVICE_ROLE_KEY: "
            f"{'있음(길이 %d)' % len(key) if key else '없음'}")

    try:
        root = nas_root(root_arg)
        log(f"  · NAS 루트: 접근 가능(쓰기 시험 중)")
        probe = os.path.join(root, "_manifest", ".write_probe")
        os.makedirs(os.path.dirname(probe), exist_ok=True)
        with io.open(probe, "w", encoding="utf-8") as f:
            f.write("ok\n")
        os.remove(probe)
        log("  · NAS 쓰기: 가능")
    except Exception as e:
        ok = False
        log(f"  ! NAS 루트: {str(e).splitlines()[0]}")

    try:
        srcs = rpc(url, key, "nas_export_sources", {"p_kind": None}) or []
        by_kind = {}
        for s in srcs:
            by_kind.setdefault(s["kind"], []).append(s)
        if not srcs:
            ok = False
            log("  ! 허용 목록이 비어 있습니다 — 정본 SQL 82 를 적용했는지 확인하세요")
        for k, v in sorted(by_kind.items()):
            log(f"  · 허용 목록 {k}: {len(v)}종 — " + ", ".join(x["source_key"] for x in v))
        for s in srcs:
            if s["mode"] == "incremental":
                log(f"    - {s['source_key']}: 커서 {s.get('last_cursor') or '(처음)'}"
                    f" · 누적 {s.get('rows_total')}행 · 마지막 {s.get('last_run_at') or '-'}")
    except Exception as e:
        ok = False
        log(f"  ! RPC 도달 실패: {_redact(e)[:300]}")

    enc_ok, enc_why = crypto_state()
    log(f"  · 암호화: {'가능' if enc_ok else '불가 — ' + (enc_why or '')}")
    log("점검 결과: " + ("이상 없음" if ok else "준비 안 된 항목 있음(위 ! 줄)"))
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description="사내 NAS 적재 요청 감시·실행 워커")
    ap.add_argument("--once", action="store_true", help="1회만 확인하고 종료 — 요청 실패 시 exit 1")
    ap.add_argument("--interval", type=int, default=POLL_SEC, help=f"폴링 주기(초, 기본 {POLL_SEC})")
    ap.add_argument("--dry-run", action="store_true", help="파일을 쓰지 않고 첫 페이지만 받아 흐름 검증")
    ap.add_argument("--root", default=None, help="NAS 루트를 직접 지정(없으면 NAS_DATA_ROOT → .claude/nas.path)")
    ap.add_argument("--source", action="append", default=None,
                    help="큐 없이 이 소스만 즉시 내보낸다(여러 번 지정 가능) — 점검용")
    ap.add_argument("--kind", default=None, choices=["turns", "erp_snapshot"],
                    help="--source 없이 즉시 내보낼 때의 종류(기본 둘 다)")
    ap.add_argument("--self-check", action="store_true", help=".env·RPC·허용목록·NAS 루트 점검(큐 미접촉)")
    ap.add_argument("--nightly", action="store_true",
                    help="하루 한 번 전체 적재(기록 증분 + ERP 스냅샷) — 그날 이미 했으면 화면 요청만 처리. 예약작업용")
    ap.add_argument("--serve", action="store_true",
                    help="상주 — 하루 1회 적재 + 화면 요청 처리를 계속 반복(NAS 컨테이너 진입점)")
    ap.add_argument("--bridge-token-file", default=None,
                    help="전용 토큰이 한 줄 들어 있는 파일 — 주면 브리지 전송으로 돈다(예약작업은 환경변수를 넘기기 어렵다)")
    ap.add_argument("--log", default=None, help="로그를 이 파일에도 덧붙인다(예약작업은 화면이 없다)")
    args = ap.parse_args()

    if args.log:
        global _LOG_FILE
        _LOG_FILE = args.log
        try:
            os.makedirs(os.path.dirname(os.path.abspath(args.log)), exist_ok=True)
        except Exception:
            pass

    load_env()
    # 전용 토큰이 있으면 브리지로만 간다 — 이때는 service_role 키가 없어도 된다(있어도 쓰지 않는다)
    global _TRANSPORT
    b_url = (os.environ.get("NAS_BRIDGE_URL") or "").strip()
    b_tok = (os.environ.get("NAS_WORKER_TOKEN") or "").strip()
    if args.bridge_token_file:
        try:
            with open(args.bridge_token_file, encoding="utf-8") as fh:
                b_tok = fh.read().strip()
        except Exception as e:
            raise SystemExit(f"전용 토큰 파일을 읽을 수 없습니다: {type(e).__name__}")
        if not b_tok:
            raise SystemExit("전용 토큰 파일이 비어 있습니다")
        if not b_url:
            b_url = need("SUPABASE_URL").rstrip("/") + "/functions/v1/jeil-nas-bridge"
    if b_url and b_tok:
        _TRANSPORT = "bridge"
        url, key = b_url.rstrip("/"), b_tok
    else:
        url = need("SUPABASE_URL").rstrip("/")
        key = need("SUPABASE_SERVICE_ROLE_KEY")
    worker = socket.gethostname()

    if args.self_check:
        return self_check(url, key, args.root)

    if args.serve:
        return serve(url, key, worker, args.root, args.dry_run, args.interval)

    if args.nightly:
        return nightly(url, key, worker, args.root, args.dry_run)

    # 큐 없이 직접 내보내기(점검용) — 요청 이력이 남지 않고 커서만 전진한다
    if args.source or args.kind:
        root = nas_root(args.root)
        kinds = [args.kind] if args.kind else ["turns", "erp_snapshot"]
        bad = 0
        for k in kinds:
            log(f"직접 내보내기 — {k}" + (f" · 소스 {', '.join(args.source)}" if args.source else " · 활성 소스 전체")
                + (" · dry-run" if args.dry_run else ""))
            body = run_export(url, key, root, k, args.source or [], dry=args.dry_run)
            log(f"  = {k}: {body['rows']}행 / 파일 {body['files']}개"
                + (f" · 실패 {len(body['failed'])}종" if body["failed"] else ""))
            bad += len(body["failed"])
        return 1 if bad else 0

    log(f"NAS 워커 시작 — {WORKER_VERSION} · host={worker}" + (" · dry-run" if args.dry_run else ""))
    if args.once:
        return 1 if tick(url, key, worker, args.root, args.dry_run) == "failed" else 0

    try:
        while True:
            try:
                if not tick(url, key, worker, args.root, args.dry_run):
                    time.sleep(max(5, args.interval))
            except Exception as e:
                log(f"폴링 오류(계속 재시도): {str(e)[:200]}")
                time.sleep(max(5, args.interval))
    except KeyboardInterrupt:
        log("워커 종료(Ctrl+C)")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
