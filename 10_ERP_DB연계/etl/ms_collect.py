# -*- coding: utf-8 -*-
"""ms_collect.py — Microsoft Entra 계정 수집 (읽기전용) → public.acct_ms

계정 대사(REQ-0018)의 MS 축을 채운다. Graph `/users` 를 **앱 전용 토큰**으로 읽는다.

전제 — Entra 앱에 **응용 권한 `User.Read.All` + 테넌트 관리자 동의**가 있어야 한다
(2026-09-07 동의 완료). 없으면 Graph 가 403 을 준다.

전량 스냅샷이다 — 매 실행마다 디렉터리 전체를 읽어 **원천에 없는 계정은 삭제**한다.
증분으로 두면 Entra 에서 지워진 계정이 미러에 영영 남는다(usr_master 에서 실제로
겪은 결함 — 미러 101 vs 원천 94, REQ-0018).

시크릿(`ENTRA_CLIENT_SECRET`)은 `.env` 에만 있고 이 스크립트는 **값을 출력하지 않는다**
(CLAUDE.md §1.8). 오류 메시지에도 섞이지 않도록 마스킹한다.
⚠ 시크릿 만료 2026-12-09 — 갱신하지 않으면 이 수집과 포털 로그인이 함께 멈춘다.

사용:
  python ms_collect.py --dry-run   # 조회·집계만
  python ms_collect.py             # 실적재

웹 「데이터 업데이트」(app/erp-status.html) 로도 함께 돈다 — 러너(etl_watch.py)가 `collect()` 를
직접 호출한다. 그래서 이 파일의 실패는 **RuntimeError 로만** 올린다. SystemExit 를 던지면
상주 러너가 통째로 죽어 다른 job 까지 멈춘다(BaseException 이라 `except Exception` 에 안 걸린다).
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _env import load_env, need  # noqa: E402
from etl_run import rpc  # noqa: E402

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

GRAPH = "https://graph.microsoft.com/v1.0"
SELECT = "id,userPrincipalName,mail,displayName,department,jobTitle,accountEnabled,userType"


def get_token(tenant, client_id, secret):
    """client_credentials(앱 전용) 토큰. 사용자 위임이 아니라 앱 자신의 권한으로 읽는다."""
    body = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": secret,
        "scope": "https://graph.microsoft.com/.default",
        "grant_type": "client_credentials",
    }).encode()
    req = urllib.request.Request(
        "https://login.microsoftonline.com/%s/oauth2/v2.0/token" % tenant,
        data=body, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())["access_token"]
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        # 응답에 시크릿이 되돌아오는 일은 없지만 방어적으로 지운다
        raise RuntimeError("토큰 발급 실패 HTTP %s: %s" % (e.code, detail.replace(secret, "***")[:400]))


def fetch_users(token):
    """/users 전량. 페이지당 999건씩 @odata.nextLink 를 따라간다."""
    url = "%s/users?$select=%s&$top=999" % (GRAPH, SELECT)
    out = []
    while url:
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")
            except Exception:
                pass
            if e.code == 403:
                raise RuntimeError(
                    "Graph 403 — 앱에 응용 권한 User.Read.All 이 없거나 관리자 동의가 안 됐습니다. "
                    + detail[:300])
            raise RuntimeError("Graph 조회 실패 HTTP %s: %s" % (e.code, detail[:400]))
        out.extend(d.get("value") or [])
        url = d.get("@odata.nextLink")
    return out


def collect(url=None, key=None, dry=False, include_all=False):
    """Entra 계정 전량 스냅샷 수집 → public.acct_ms. `(추출건수, 적재건수)` 를 돌려준다.

    CLI(main)와 웹 러너(etl_watch.py)가 함께 쓰는 단일 진입점이다. url/key 를 주지 않으면
    `.env` 에서 읽는다. 실패는 RuntimeError — 러너가 부분 실패로 처리하고 다음 job 을 이어간다."""
    load_env()
    tenant = need("ENTRA_TENANT_ID")
    client_id = need("ENTRA_CLIENT_ID")
    secret = need("ENTRA_CLIENT_SECRET")

    print("[ms] 토큰 발급")
    token = get_token(tenant, client_id, secret)
    print("[ms] Graph /users 조회")
    users = fetch_users(token)
    print("[ms] 디렉터리 전체 %d건" % len(users))

    rows, skipped = [], {"이메일없음": 0, "사외도메인": 0}
    for u in users:
        # 게스트는 userPrincipalName 이 #EXT# 형태라 실제 주소는 mail 에 있다
        email = (u.get("mail") or u.get("userPrincipalName") or "").strip().lower()
        if "@" not in email:
            skipped["이메일없음"] += 1
            continue
        if not include_all and not email.endswith("@jeilm.co.kr"):
            skipped["사외도메인"] += 1
            continue
        rows.append({
            "email": email,
            "display_name": u.get("displayName") or None,
            "dept_nm": u.get("department") or None,
            "job_title": u.get("jobTitle") or None,
            "account_enabled": bool(u.get("accountEnabled")),
            "user_type": u.get("userType") or None,
            "object_id": u.get("id") or None,
        })

    dedup = {}
    for r in rows:
        dedup[r["email"]] = r
    rows = list(dedup.values())

    on = sum(1 for r in rows if r["account_enabled"])
    types = {}
    for r in rows:
        types[r["user_type"] or "(없음)"] = types.get(r["user_type"] or "(없음)", 0) + 1
    print("[ms] 대상 %d건 (사용 %d · 차단 %d) — 유형 %s"
          % (len(rows), on, len(rows) - on,
             " · ".join("%s %d" % kv for kv in sorted(types.items()))))
    print("[ms] 제외 — %s" % " · ".join("%s %d" % kv for kv in skipped.items()))

    if dry:
        print("[ms] (dry-run) 적재 생략")
        return len(rows), 0
    if not rows:
        # 0건 적재는 acct_source_upsert 가 거부하지만, 여기서 먼저 멈춰 원인을 분명히 남긴다
        raise RuntimeError("대상 0건 — 전건 삭제를 막기 위해 적재를 중단합니다")

    url = url or need("SUPABASE_URL").rstrip("/")
    key = key or need("SUPABASE_SERVICE_ROLE_KEY")
    res = rpc(url, key, "acct_source_upsert", {"p_source": "ms", "p_rows": rows})
    print("[ms] 적재 완료 — %s" % res)
    up = int((res or {}).get("upserted") or 0) if isinstance(res, dict) else len(rows)
    return len(rows), up


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="조회·집계만(적재 안 함)")
    ap.add_argument("--all", action="store_true",
                    help="게스트·비사내 도메인까지 포함(기본은 @jeilm.co.kr 만)")
    args = ap.parse_args()
    try:
        collect(dry=args.dry_run, include_all=args.all)
    except RuntimeError as e:
        print("[ms] 실패: %s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
