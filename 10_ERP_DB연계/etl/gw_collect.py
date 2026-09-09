# -*- coding: utf-8 -*-
"""gw_collect.py — 그룹웨어(ONUL Ware) 계정 수집 (읽기전용) → public.acct_groupware

계정 대사(REQ-0018)의 그룹웨어 축을 채운다. 원천은 그룹웨어 DB의 인사정보 뷰이며
**SELECT 만** 한다. 쓰기는 우리 중간DB(Supabase)뿐이다.

전량 스냅샷 방식이다 — 매 실행마다 뷰 전체를 읽어 **원천에 없는 행은 삭제**한다.
증분 upsert 로 하면 그룹웨어에서 지워진 계정이 미러에 영영 남는다(`usr_master` 에서
실제로 겪은 결함 — 미러 101 vs 원천 94, REQ-0018 참조).

접속 정보는 저장소 루트 `.env.local` 에만 둔다. 이 스크립트는 값을 **출력하지 않는다**
(CLAUDE.md §1.8 — 값이 오류 메시지로 유출된 실사례가 있다).

개인 연락처(mobileNumber)는 **가져오지 않는다**(CLAUDE.md §1.7). 이름은 마스킹 예외.

사용:
  python gw_collect.py --dry-run   # 추출·집계만, 적재 안 함
  python gw_collect.py             # 실적재

웹 「데이터 업데이트」(app/erp-status.html) 로도 함께 돈다 — 러너(etl_watch.py)가 `collect()` 를
직접 호출한다. 그래서 이 파일의 실패는 **RuntimeError 로만** 올린다. SystemExit 를 던지면
상주 러너가 통째로 죽어 다른 job 까지 멈춘다(BaseException 이라 `except Exception` 에 안 걸린다).
"""
import argparse
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _env import load_env, need, env_root  # noqa: E402
from etl_run import rpc  # noqa: E402  (같은 RPC 호출기 재사용)

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")


def load_local():
    """`.env.local` 파서 — `KEY=value` 와 `KEY: value` 를 모두 받는다.
    관리자가 손으로 적는 파일이라 형식을 강제하지 않고 읽는 쪽이 맞춘다.
    키는 공백/점/하이픈을 밑줄로 바꾸고 대문자로 정규화한다(`gw url` -> `GW_URL`)."""
    path = os.path.join(env_root(), ".env.local")
    out = {}
    if not os.path.exists(path):
        return out
    for line in io.open(path, encoding="utf-8"):
        line = line.strip().lstrip("﻿")
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_ .-]*?)\s*[:=]\s*(.*)$", line)
        if not m:
            continue
        k = re.sub(r"[ .-]+", "_", m.group(1).strip()).upper()
        v = m.group(2).strip().strip('"').strip("'")
        if k and v:
            out[k] = v
    return out


# 뷰 컬럼 -> 포털 컬럼. 실측 구조(v_member_info, 517행) 기준.
#   memberLogID(로그인ID) · meberName(이름, 원천 철자 그대로) · useState(사용상태 int)
#   employeeNumber(사번) · email · companyName · partName(부서) · positionName(직위)
#   dutyName(직책) · endDate(종료일)
#   ※ mobileNumber 는 개인 연락처라 선택하지 않는다.
SELECT_SQL = """
    SELECT LTRIM(RTRIM(ISNULL(email, '')))          AS email,
           LTRIM(RTRIM(ISNULL(memberLogID, '')))    AS login_id,
           LTRIM(RTRIM(ISNULL(meberName, '')))      AS emp_nm,
           LTRIM(RTRIM(ISNULL(partName, '')))       AS dept_nm,
           LTRIM(RTRIM(ISNULL(positionName, '')))   AS position_nm,
           LTRIM(RTRIM(ISNULL(dutyName, '')))       AS duty_nm,
           LTRIM(RTRIM(ISNULL(employeeNumber, ''))) AS emp_no,
           useState                                 AS use_state,
           endDate                                  AS end_dt
    FROM [{view}]
"""
# ⚠ 예전에는 여기 `WHERE email LIKE '%@%'` 가 있었다. 그런데 그룹웨어는 이메일 칸이 빈 계정이
#   있어서(517행 중 46행), 그 필터가 **원천에 멀쩡히 있는 계정을 통째로 안 보이게** 만들었다.
#   대사는 "그룹웨어 없음"으로 오판했고 퇴사 처리 자동화는 대상을 못 찾았다(2026-09-09 실측).
#   이제 전량을 읽어 파이썬에서 판단한다 — 로그인ID가 이메일 형태면 보정하고, 그것도 없으면
#   **누가 빠졌는지 로그로 남긴다**(조용히 버리지 않는다).


def collect(url=None, key=None, dry=False):
    """그룹웨어 계정 전량 스냅샷 수집 → public.acct_groupware. `(추출건수, 적재건수)` 반환.

    CLI(main)와 웹 러너(etl_watch.py)가 함께 쓰는 단일 진입점이다. url/key 를 주지 않으면
    `.env` 에서 읽는다. 실패는 RuntimeError — 러너가 부분 실패로 처리하고 다음 job 을 이어간다."""
    cfg = load_local()
    need_keys = ["GW_DB_HOST", "GW_DB_NAME", "GW_TABLE_ID", "GW_TABLE_PW", "GW_TABLE_NAME"]
    missing = [k for k in need_keys if not cfg.get(k)]
    if missing:
        raise RuntimeError(".env.local 키 누락: " + ", ".join(missing))

    server, _, port = cfg["GW_DB_HOST"].partition(":")
    port = port or "1433"
    view = cfg["GW_TABLE_NAME"]
    if not re.match(r"^[A-Za-z0-9_]+$", view):
        raise RuntimeError("뷰 이름에 허용되지 않은 문자가 있습니다")

    import pyodbc
    drivers = [d for d in pyodbc.drivers() if "SQL Server" in d]
    if not drivers:
        raise RuntimeError("SQL Server ODBC 드라이버가 없습니다")
    drv = next((d for d in ("ODBC Driver 18 for SQL Server",
                            "ODBC Driver 17 for SQL Server") if d in drivers), drivers[0])
    cs = ("DRIVER={%s};SERVER=%s,%s;DATABASE=%s;UID=%s;PWD=%s;"
          % (drv, server, port, cfg["GW_DB_NAME"], cfg["GW_TABLE_ID"], cfg["GW_TABLE_PW"]))
    if "18" in drv:
        cs += "Encrypt=yes;TrustServerCertificate=yes;"

    print("[gw] 추출 시작 (드라이버: %s)" % drv)
    rows = []
    try:
        with pyodbc.connect(cs, timeout=30) as conn:
            cur = conn.cursor()
            cur.execute(SELECT_SQL.format(view=view))
            cols = [c[0] for c in cur.description]
            skipped_no_mail = []
            for rec in cur:
                r = dict(zip(cols, rec))
                email = (r.get("email") or "").strip().lower()
                login = (r.get("login_id") or "").strip().lower()
                # 그룹웨어는 이메일 칸이 비어 있는 계정이 있다(실측 517행 중 46행).
                # 우리 대사는 이메일이 키라, 그대로 두면 **그룹웨어에 멀쩡히 있는 계정을
                # "그룹웨어 없음"으로 오판**한다(생산팀 유계상 실사례). 게다가 퇴사 처리
                # 자동화가 대상을 못 찾아 그룹웨어 축이 통째로 빠진다(2026-09-09 실측).
                # 로그인ID 자체가 이메일 형태인 경우가 있어(test@jeilm.co.kr 등) 그것만 보정한다.
                # 로그인ID에 도메인을 갖다 붙이는 추측은 하지 않는다 — 공용 계정에 존재하지
                # 않는 주소를 만들어 대사를 더 어지럽힌다.
                if "@" not in email and "@" in login:
                    email = login
                if "@" not in email:
                    if r.get("use_state") == 0:
                        skipped_no_mail.append(login or (r.get("emp_nm") or "?"))
                    continue
                # 사용 여부는 useState 로만 본다. **0 = 사용중, 1 = 미사용**이다(정지 플래그로 읽힌다).
                # 이름과 반대라 헷갈리므로 실측 근거를 남긴다(2026-09-07):
                #   useState=0(117명) → ERP 활성계정 93 · 인사 재직 95 매치
                #   useState=1(357명) → ERP 활성계정 0 · 인사 재직 0 (전원 퇴사자이거나 인사에 없음)
                # ⚠ endDate 는 퇴사일이 아니다 — 전건 값이 있고 최대가 2555-07-01(무기한 센티넬)이라
                #   재직 판정에 쓸 수 없다.
                st = r.get("use_state")
                status = "사용" if st == 0 else ("미사용" if st == 1 else "상태%s" % st)
                rows.append({
                    "email": email,
                    "login_id": r.get("login_id") or None,
                    "emp_nm": r.get("emp_nm") or None,
                    "dept_nm": r.get("dept_nm") or None,
                    # 직위·직책이 따로 있어 붙여 보관(둘 다 비면 None)
                    "position_nm": " ".join(x for x in (r.get("position_nm"), r.get("duty_nm")) if x) or None,
                    "status": status,
                    "source": "onulware",
                })
    except Exception as e:
        msg = str(e).replace(cfg["GW_TABLE_PW"], "***").replace(cfg["GW_DB_HOST"], "***")
        raise RuntimeError("그룹웨어 DB 추출 실패: " + msg[:400])

    # 이메일 중복 제거(마지막 행 우선) — PK 충돌 방지
    dedup = {}
    for r in rows:
        dedup[r["email"]] = r
    rows = list(dedup.values())

    by_status = {}
    for r in rows:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
    print("[gw] 추출 %d행 (이메일 기준) — 상태별 %s"
          % (len(rows), " · ".join("%s %d" % kv for kv in sorted(by_status.items()))))
    if skipped_no_mail:
        # 조용히 버리면 대사가 "그룹웨어 없음"으로 거짓말을 한다 — 누가 빠졌는지 남긴다.
        print("[gw] ⚠ 이메일 없어 제외된 사용중 계정 %d건: %s"
              % (len(skipped_no_mail), ", ".join(skipped_no_mail[:12])))

    if dry:
        print("[gw] (dry-run) 적재 생략")
        return len(rows), 0
    if not rows:
        # 0건 적재는 acct_source_upsert 가 거부하지만, 여기서 먼저 멈춰 원인을 분명히 남긴다
        raise RuntimeError("추출 0행 — 전건 삭제를 막기 위해 적재를 중단합니다")

    load_env()
    url = url or need("SUPABASE_URL").rstrip("/")
    key = key or need("SUPABASE_SERVICE_ROLE_KEY")
    res = rpc(url, key, "acct_source_upsert", {"p_source": "gw", "p_rows": rows})
    print("[gw] 적재 완료 — %s" % res)
    up = int((res or {}).get("upserted") or 0) if isinstance(res, dict) else len(rows)
    return len(rows), up


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="추출·집계만 확인(적재 안 함)")
    args = ap.parse_args()
    try:
        collect(dry=args.dry_run)
    except RuntimeError as e:
        print("[gw] 실패: %s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
