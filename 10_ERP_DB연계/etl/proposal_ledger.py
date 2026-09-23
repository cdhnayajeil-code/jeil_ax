# -*- coding: utf-8 -*-
r"""proposal_ledger.py — 구매 기안서 목록대장(Teams 엑셀) → 중간DB(public.pur_proposal)

원천이 ERP(MSSQL)가 아니라 **구매팀이 손으로 관리하는 엑셀 1장**이다. 그래서 etl_run.py(ERP 배치)와
분리된 모듈이고, 적재 대상도 `erp_ro` 가 아니라 **포털 전용 테이블 `public`**(CLAUDE.md §4.3)이다.
정본 DDL: `실제구축준비 자료/이관/sql/68_pur_proposal_ledger.sql`

사용:
  python proposal_ledger.py --dry-run          # 읽기·집계만(적재 안 함)
  python proposal_ledger.py                    # 전량 교체 적재
  python proposal_ledger.py --file "D:\...\기안서 목록대장(2026).xlsx"
  python proposal_ledger.py --scan "…\기안서_스캔본_매핑_2026.csv"   # 스캔본 대사 결과도 함께

러너에서:
  jeil_runner proposal --dry-run               # 서브커맨드(§17.2)
  작업 종류 `proposal_ledger` 로 스케줄 등록    # runner_core.JOB_KINDS

설계 메모
  · **엑셀 행 그대로 넣는다**(1,102행). 건(830건) 집계는 뷰 `v_pur_proposal_case` 가 한다.
    한 기안(권-번호)이 업체·품목별로 여러 행이라, 행을 합쳐 넣으면 전표·금액 대사를 못 한다.
  · **전량 교체가 기본**이다. 대장은 행이 사라지기도 해서(병합·삭제) 증분만 하면 유령 행이 남는다.
  · 전표번호의 앞뒤 공백·탭을 **지우지 않는다.** 품질 뷰가 그 오염을 세는 근거이기 때문이다.
    ERP 대사 때 btrim 하는 것은 조회하는 쪽 몫이다.
  · 통화는 **추정하지 않는다.** 대장에 칸이 없다(원화·EUR·CNY 가 금액 한 칸에 섞여 있다).
  · 외부 라이브러리를 쓰지 않는다(openpyxl 없음) — zipfile + xml 로 직접 읽는다. EXE 크기도 아낀다.

실패 처리
  이 모듈은 상주 러너가 부르므로 **SystemExit 를 던지지 않는다**(BaseException 이라 러너가 통째로
  죽는다 — ms_collect.py 가 같은 이유로 RuntimeError 만 올린다).
"""
import argparse
import csv
import datetime
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from xml.etree import ElementTree as ET

from _env import load_env

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
SHEET_HINT = "기안서 목록대장"      # 시트 이름에 이 문구가 들어간 첫 시트를 쓴다
HEADER_ROWS = 2                     # 1행 병합 헤더 + 2행 컬럼명 → 데이터는 3행부터
CHUNK_ROWS = 300                    # RPC 한 번에 보낼 행 수
JOB_NAME = "pur_proposal"

# 엑셀 열 위치(0-based) — 대장 서식이 바뀌면 여기만 고친다
COL = {
    "memo": 0, "vol": 1, "no": 2, "draft_dt": 4, "drafter": 5, "job_no": 6,
    "project": 7, "content": 8, "vendor": 9, "amt": 10, "closed_yn": 11, "remark": 12,
    "dp_rate": 13, "dp_amt": 14, "dp_slip": 15, "dp_dt": 16,
    "mp_rate": 17, "mp_amt": 18, "mp_slip": 19, "mp_dt": 20,
    "bp_rate": 21, "bp_amt": 22, "bp_slip": 23, "bp_dt": 24,
}
DATE_COLS = {COL["draft_dt"], COL["dp_dt"], COL["mp_dt"], COL["bp_dt"]}


# ────────────────────────────────────────────────────────────── 엑셀 읽기
def _col_index(ref):
    m = re.match(r"([A-Z]+)", ref or "")
    n = 0
    for ch in (m.group(1) if m else ""):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _serial_to_date(v):
    """엑셀 날짜 시리얼 → date. 숫자가 아니면 None."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f <= 0:
        return None
    return (datetime.datetime(1899, 12, 30) + datetime.timedelta(days=f)).date()


def read_sheet(path):
    """xlsx 첫 번째 '기안서 목록대장' 시트를 [(행번호, {열: 값})] 로 읽는다.

    엑셀에서 파일을 열어 둔 상태면 직접 열기가 막히므로 **임시폴더로 복사한 뒤** 읽는다.
    """
    tmp = os.path.join(tempfile.gettempdir(), "jeil_proposal_%d.xlsx" % os.getpid())
    try:
        shutil.copy2(path, tmp)
        src = tmp
    except OSError:
        src = path      # 복사에 실패하면 원본을 직접 시도

    try:
        with zipfile.ZipFile(src) as z:
            shared = []
            if "xl/sharedStrings.xml" in z.namelist():
                root = ET.fromstring(z.read("xl/sharedStrings.xml"))
                shared = ["".join(t.text or "" for t in si.iter(NS + "t"))
                          for si in root.findall(NS + "si")]

            wb = ET.fromstring(z.read("xl/workbook.xml"))
            rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
            rns = "{http://schemas.openxmlformats.org/package/2006/relationships}"
            rid = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
            rmap = {r.get("Id"): r.get("Target") for r in rels.findall(rns + "Relationship")}

            target = None
            for sh in wb.find(NS + "sheets").findall(NS + "sheet"):
                if SHEET_HINT in (sh.get("name") or ""):
                    t = rmap[sh.get(rid)].lstrip("/")
                    target = t if t.startswith("xl/") else "xl/" + t
                    break
            if not target:
                raise RuntimeError("시트를 찾지 못했습니다 — 이름에 '%s' 가 들어간 시트가 없습니다" % SHEET_HINT)

            out = []
            sheet = ET.fromstring(z.read(target))
            for tr in sheet.iter(NS + "row"):
                ri = int(tr.get("r"))
                if ri <= HEADER_ROWS:
                    continue
                cells = {}
                for c in tr.findall(NS + "c"):
                    ci = _col_index(c.get("r"))
                    t, v = c.get("t"), c.find(NS + "v")
                    inline = c.find(NS + "is")
                    if t == "s" and v is not None:
                        val = shared[int(v.text)]
                    elif t == "inlineStr" and inline is not None:
                        val = "".join(x.text or "" for x in inline.iter(NS + "t"))
                    elif v is not None:
                        val = v.text
                    else:
                        continue
                    cells[ci] = val
                if cells:
                    out.append((ri, cells))
            return out
    finally:
        if src == tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass


# ────────────────────────────────────────────────────────────── 정규화
def norm_customer(project):
    """`프로젝트` 칸 앞부분(고객사) 표기 정규화.

    같은 고객이 표기만 달라 집계가 쪼개진다(원문 46종). **문자열로 같은 업체임이 분명한 것만**
    묶는다 — `LGESMI` 처럼 같은 그룹인지 단정할 수 없는 표기는 그대로 둔다(추측으로 합치면
    집계가 거짓이 된다).
    """
    s = str(project or "").split("_")[0].strip()
    if not s:
        return None
    k = s.upper().replace(" ", "")
    if "엔시스" in s or "NSYS" in k: return "엔시스"
    if "SDI" in k or "에스디아이" in s: return "삼성SDI 계열"
    if "STARPLUS" in k: return "StarPlus Energy"
    if "한화" in s: return "한화 계열"
    if "LIG" in k or "엘아이지넥스원" in s: return "LIG넥스원"
    if "동국제약" in s: return "동국제약"
    if "아이마켓" in s: return "아이마켓코리아"
    if "유니메드제약" in s: return "유니메드제약"
    if "풍산" in s: return "풍산"
    if "제뉴원" in s: return "제뉴원사이언스"
    if "서브원" in s: return "서브원"
    if "CMTECH" in k: return "CMTECH CHINA"
    return s


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _text(v):
    s = "" if v is None else str(v)
    return s if s.strip() else None


def build_rows(sheet_rows, src_updated):
    """엑셀 행 → 적재 레코드. (행 목록, 건수, 경고 목록)"""
    recs, warns = [], []
    seq_of = {}
    for ri, c in sheet_rows:
        vol, no = _num(c.get(COL["vol"])), _num(c.get(COL["no"]))
        if vol is None or no is None:
            continue                      # 합계·빈 행
        vol, no = int(vol), int(no)
        seq_of[(vol, no)] = seq_of.get((vol, no), 0) + 1

        raw_dt = c.get(COL["draft_dt"])
        d = _serial_to_date(raw_dt)
        if d is None and _text(raw_dt):
            warns.append("일자를 날짜로 못 읽음 %d-%d: %r" % (vol, no, raw_dt))

        amt_cell = c.get(COL["amt"])
        amt = _num(amt_cell)
        rec = {
            "vol": vol, "no": no, "seq": seq_of[(vol, no)],
            "draft_dt": d.isoformat() if d else None,
            "draft_dt_raw": None if d else _text(raw_dt),
            "drafter": _text(c.get(COL["drafter"])),
            "job_no": _text(c.get(COL["job_no"])),
            "project": _text(c.get(COL["project"])),
            "customer": norm_customer(c.get(COL["project"])),
            "content": _text(c.get(COL["content"])),
            "vendor": _text(c.get(COL["vendor"])),
            "amt": amt,
            "amt_raw": None if amt is not None else _text(amt_cell),
            "currency": None,                       # 대장에 칸이 없다 — 추정하지 않는다
            "closed_yn": (_text(c.get(COL["closed_yn"])) or "").strip().upper()[:1] or None,
            "remark": _text(c.get(COL["remark"])),
            "memo": _text(c.get(COL["memo"])),
            "src_row": ri,
            "src_updated": src_updated,
        }
        for pfx in ("dp", "mp", "bp"):
            rec[pfx + "_rate"] = _num(c.get(COL[pfx + "_rate"]))
            rec[pfx + "_amt"] = _num(c.get(COL[pfx + "_amt"]))
            # 전표번호는 **원문 그대로** 둔다(앞뒤 공백·탭이 품질 지표다)
            rec[pfx + "_slip"] = _text(c.get(COL[pfx + "_slip"]))
            sd = _serial_to_date(c.get(COL[pfx + "_dt"]))
            rec[pfx + "_dt"] = sd.isoformat() if sd else None
        recs.append(rec)
    return recs, len(seq_of), warns


def read_scan_csv(path):
    """스캔본 대사 CSV(사람이 탐색기 경유로 뽑은 목록) → 적재 레코드."""
    out = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            try:
                vol, no = int(r["권"]), int(r["번호"])
            except (KeyError, ValueError):
                continue
            mt = (r.get("파일수정일") or "").strip()
            out.append({
                "vol": vol, "no": no,
                "file_name": (r.get("파일명") or "").strip() or None,
                "size_kb": int(float(r["크기KB"])) if (r.get("크기KB") or "").strip() else None,
                "file_mtime": (mt.replace(" ", "T") if mt else None),
                "matched": (r.get("매칭") or "").strip().upper() == "OK",
            })
    return out


# ────────────────────────────────────────────────────────────── 적재
def rpc(url, key, fn, payload):
    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    req = urllib.request.Request(
        "%s/rest/v1/rpc/%s" % (url, fn), data=body, method="POST",
        headers={"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read().decode().strip().strip('"')
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace").strip()
        except Exception:
            pass
        raise RuntimeError("HTTP %s rpc/%s: %s" % (e.code, fn, detail[:800])) from e


def push(url, key, fn, rows, replace):
    """청크로 나눠 적재. 전량 교체는 **첫 청크에서 한 번만** 비운다."""
    done = 0
    for i in range(0, len(rows), CHUNK_ROWS):
        chunk = rows[i:i + CHUNK_ROWS]
        done += int(rpc(url, key, fn, {
            "p_rows": chunk, "p_replace": bool(replace and i == 0)}) or 0)
    return done


def ledger_path(cli_path=None):
    """대장 파일 경로 — 인자 > 환경변수 `PROPOSAL_LEDGER_XLSX`.

    경로는 호스트마다 다르고 사내 공유 경로라 **저장소에 적지 않는다**(CLAUDE.md §1.3).
    """
    p = (cli_path or os.environ.get("PROPOSAL_LEDGER_XLSX", "")).strip().strip('"')
    if not p:
        raise RuntimeError(
            "대장 파일 경로가 없습니다 — .env 에 PROPOSAL_LEDGER_XLSX 를 넣거나 --file 로 지정하세요")
    if not os.path.exists(p):
        raise RuntimeError("대장 파일을 찾을 수 없습니다: %s" % os.path.basename(p))
    return p


def collect(file=None, scan=None, dry=False, replace=True):
    """러너(etl_watch·jeil_runner)가 직접 부르는 진입점. (읽은 행, 적재 행, 건수) 반환."""
    load_env()
    path = ledger_path(file)
    src_updated = datetime.datetime.fromtimestamp(
        os.path.getmtime(path), datetime.timezone.utc).isoformat()

    rows, cases, warns = build_rows(read_sheet(path), src_updated)
    for w in warns[:10]:
        print("  [주의] " + w)
    print("[%s] 대장 %s — %d행 / %d건 (최종수정 %s)"
          % (JOB_NAME, os.path.basename(path), len(rows), cases, src_updated[:16]))
    if not rows:
        raise RuntimeError("대장에서 읽은 행이 0 입니다 — 시트 서식이 바뀌었는지 확인하세요")

    scan_rows = read_scan_csv(scan) if scan else []
    if scan:
        print("[%s] 스캔 대사 %d건 (일치 %d)"
              % (JOB_NAME, len(scan_rows), sum(1 for r in scan_rows if r["matched"])))

    if dry:
        print("[%s] (dry-run) 적재 생략" % JOB_NAME)
        return len(rows), 0, cases

    url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
    if not url or not key:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 없습니다(.env 확인)")

    batch_id = rpc(url, key, "erp_etl_batch", {"p_action": "start", "p_payload": {"job_name": JOB_NAME}})
    try:
        up = push(url, key, "pur_proposal_upsert", rows, replace)
        if scan_rows:
            push(url, key, "pur_proposal_scan_upsert", scan_rows, replace)
        rpc(url, key, "erp_etl_batch", {"p_action": "finish", "p_payload": {
            "batch_id": batch_id, "status": "success", "rows_read": len(rows), "rows_upserted": up}})
        print("[%s] 완료 — 읽음 %d / 적재 %d / 건 %d" % (JOB_NAME, len(rows), up, cases))
        return len(rows), up, cases
    except Exception as e:
        rpc(url, key, "erp_etl_batch", {"p_action": "finish", "p_payload": {
            "batch_id": batch_id, "status": "failed", "rows_read": len(rows), "error_msg": str(e)[:500]}})
        raise


def main():
    ap = argparse.ArgumentParser(description="구매 기안서 대장(엑셀) → 중간DB 적재")
    ap.add_argument("--file", help="대장 xlsx 경로(미지정 시 .env PROPOSAL_LEDGER_XLSX)")
    ap.add_argument("--scan", help="스캔본 대사 CSV 경로(선택)")
    ap.add_argument("--dry-run", action="store_true", help="읽기·집계만(적재 안 함)")
    ap.add_argument("--append", action="store_true",
                    help="전량 교체하지 않고 덮어쓰기만(기본은 전량 교체 — 삭제된 행을 지우기 위해)")
    a = ap.parse_args()
    try:
        collect(file=a.file, scan=a.scan, dry=a.dry_run, replace=not a.append)
    except Exception as e:                      # SystemExit 를 던지지 않는다(상주 러너 보호)
        print("[%s] 실패: %s" % (JOB_NAME, e), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
