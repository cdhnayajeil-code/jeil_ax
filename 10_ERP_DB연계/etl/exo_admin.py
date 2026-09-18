# -*- coding: utf-8 -*-
"""exo_admin.py — Exchange Online 관리 호출 (사서함 공유 전환 전용)

퇴사 처리 MS 축에서 **사서함을 공유 사서함(shared mailbox)으로 바꾸는** 한 가지 일만 한다.

왜 Graph 가 아니라 이 경로인가 — **Graph 에는 사서함 유형을 바꾸는 API 가 없다**(2026-09-17 확인).
Exchange Online 의 `Set-Mailbox -Type Shared` 가 유일한 경로다. 다만 그 cmdlet 을 부르려고
러너 호스트에 PowerShell 모듈(ExchangeOnlineManagement)을 깔 필요는 없다 —
EXO PowerShell 자신이 쓰는 REST 엔드포인트를 그대로 부르면 된다:

    POST https://outlook.office365.com/adminapi/beta/{tenant}/InvokeCommand
    {"CmdletInput": {"CmdletName": "Set-Mailbox", "Parameters": {"Identity": "...", "Type": "Shared"}}}

덕분에 이 파일도 표준 라이브러리만 쓴다(이 저장소 ETL 의 의존성 0 원칙).

전제 — Graph 와 **같은 앱**을 쓰지만 권한은 따로다. 부여 전이면 토큰 발급이나 호출이 막힌다:
  · 응용 권한 `Office 365 Exchange Online > Exchange.ManageAsApp` + 관리자 동의
  · 그 앱(서비스 주체)에 **Exchange 관리자** 역할(최소권한을 원하면 Recipient Management RBAC)

권한이 없을 때를 **실패로 몰지 않는다.** `available=False` 로 돌려주고 호출측이 판단하게 한다 —
공유로 바꾸지 못한 사서함에서 라이선스를 떼면 **30일 뒤 사서함이 삭제**되기 때문에,
전환이 불가능하면 라이선스 회수도 멈추는 것이 맞다(offboard_axes.ms_offboard 가 그렇게 쓴다).

시크릿은 `.env` 에서만 읽고 값을 출력하지 않는다(CLAUDE.md §1.8).
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _env import load_env  # noqa: E402

EXO = "https://outlook.office365.com"
SCOPE = EXO + "/.default"          # 앱 전용 토큰의 리소스 — Graph 토큰으로는 이 API 를 못 부른다
SHARED = "SharedMailbox"           # Get-Mailbox 의 RecipientTypeDetails 값

# 권한 안내는 한 곳에서만 만든다 — 화면·로그·CLI 가 같은 문장을 보게.
GRANT_HELP = ("응용 권한 `Office 365 Exchange Online > Exchange.ManageAsApp`(관리자 동의) + "
              "해당 앱에 `Exchange 관리자` 역할 필요")

NOT_FOUND_HINTS = ("couldn't be found", "wasn't found", "objectnotfound")


def _conf():
    """((tenant, client_id, secret), "") 또는 (None, 사유). 값은 돌려주기만 하고 출력하지 않는다."""
    load_env()
    keys = ("ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET")
    missing = [k for k in keys if not os.environ.get(k)]
    if missing:
        # need() 를 쓰면 SystemExit 이라 축 하나가 러너 전체를 흔든다 — 여기서는 값으로 돌려준다.
        return None, "접속정보 없음 — .env 에 %s 가 없습니다" % ", ".join(missing)
    return tuple(os.environ[k] for k in keys), ""


def token():
    """(access_token, err_msg). 예외를 던지지 않는다 — 권한 미구성이 흔한 상태이기 때문."""
    conf, err = _conf()
    if not conf:
        return None, err
    tenant, cid, secret = conf
    body = urllib.parse.urlencode({
        "client_id": cid,
        "client_secret": secret,
        "scope": SCOPE,
        "grant_type": "client_credentials",
    }).encode()
    req = urllib.request.Request(
        "https://login.microsoftonline.com/%s/oauth2/v2.0/token" % tenant,
        data=body, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())["access_token"], ""
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            j = json.loads(e.read().decode("utf-8", "replace"))
            detail = (j.get("error_description") or j.get("error") or "")
        except Exception:
            pass
        # 응답에 시크릿이 되돌아올 일은 없지만 방어적으로 지운다(§1.8)
        detail = detail.replace(secret, "***").split("\r\n")[0][:200]
        return None, "Exchange 토큰 발급 실패(HTTP %s) — %s / %s" % (e.code, detail, GRANT_HELP)
    except Exception as e:
        return None, "Exchange 토큰 발급 실패 — %s" % str(e)[:160]


def invoke(tok, tenant, cmdlet, params, anchor):
    """(status, payload|메시지). EXO PowerShell 이 내부에서 쓰는 것과 같은 호출이다.

    `X-AnchorMailbox` 는 요청을 어느 백엔드로 보낼지 정하는 값이다 — 빼면 엉뚱한 404 를 만난다."""
    body = {"CmdletInput": {"CmdletName": cmdlet, "Parameters": params}}
    req = urllib.request.Request(
        "%s/adminapi/beta/%s/InvokeCommand" % (EXO, tenant),
        data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": "Bearer " + tok,
                 "Content-Type": "application/json",
                 "X-ResponseFormat": "json",
                 "X-AnchorMailbox": "UPN:" + anchor})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode("utf-8", "replace") or ""
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            j = json.loads(e.read().decode("utf-8", "replace"))
            err = j.get("error") or {}
            if isinstance(err, dict):
                detail = err.get("message") or ""
                if not detail:
                    inner = err.get("details") or err.get("innererror") or ""
                    detail = str(inner)
            else:
                detail = str(err)
        except Exception:
            pass
        return e.code, detail[:220]
    except Exception as e:
        return 0, str(e)[:180]


def _rows(payload):
    """InvokeCommand 응답은 결과를 value 배열에 담아 준다."""
    if isinstance(payload, dict):
        v = payload.get("value")
        if isinstance(v, list):
            return v
    return []


def _missing(res):
    """사서함이 없는 경우의 오류 문구(EXO 는 404 대신 400 에 사유를 실어 보내기도 한다)."""
    low = str(res).lower()
    return any(h in low for h in NOT_FOUND_HINTS)


def to_shared(email, apply=False, tok=None, tenant=None):
    """사서함을 공유 사서함으로 전환. {"ok","available","changed","state","msg"} 를 돌려준다.

    · available=False — 권한·구성이 아직 없다(**오류가 아니다**). 호출측은 이때 라이선스 회수를
      보류해야 한다. 공유로 못 바꾼 사서함에서 라이선스를 떼면 30일 뒤 사라진다.
    · state — "shared"(이미/전환됨) · "user"(개인 사서함) · "none"(사서함 없음) · "unknown"
    · 사서함이 아예 없는 계정(Exchange 라이선스 없음)은 전환할 것이 없으니 ok=True 로 통과시킨다.
    """
    out = {"ok": False, "available": True, "changed": False, "state": "unknown", "msg": ""}
    if not email:
        out.update(available=False, msg="이메일이 없습니다")
        return out

    if not tenant:
        conf, err = _conf()
        if not conf:
            out.update(available=False, msg=err)
            return out
        tenant = conf[0]
    if not tok:
        tok, err = token()
        if not tok:
            out.update(available=False, msg=err)
            return out

    st, res = invoke(tok, tenant, "Get-Mailbox", {"Identity": email}, email)
    if st in (401, 403):
        out.update(available=False, msg="Exchange 권한 없음(HTTP %s) — %s" % (st, GRANT_HELP))
        return out
    if st == 404 or (st >= 400 and _missing(res)):
        out.update(ok=True, state="none", msg="사서함 없음 — 전환할 것이 없습니다")
        return out
    if st not in (200, 201):
        out.update(msg="사서함 조회 실패(HTTP %s) — %s" % (st, res))
        return out

    rows = _rows(res)
    kind = (rows[0].get("RecipientTypeDetails") if rows else "") or ""
    if kind == SHARED:
        out.update(ok=True, state="shared", msg="이미 공유 사서함")
        return out
    out["state"] = "user"

    if not apply:
        out.update(ok=True, msg="점검 — 사서함 %s → 공유 사서함으로 전환 예정" % (kind or "개인"))
        return out

    st, res = invoke(tok, tenant, "Set-Mailbox", {"Identity": email, "Type": "Shared"}, email)
    if st in (401, 403):
        # 조회는 됐는데 쓰기가 막힌 경우 — 읽기 전용 RBAC 일 때 이렇게 된다
        out.update(available=False, msg="Exchange 쓰기 권한 없음(HTTP %s) — %s" % (st, GRANT_HELP))
        return out
    if st not in (200, 201, 204):
        out.update(msg="사서함 공유 전환 실패(HTTP %s) — %s" % (st, res))
        return out
    out.update(ok=True, changed=True, state="shared", msg="사서함 공유 전환 완료")
    return out


def main():
    """점검용 CLI — 권한이 있는지, 사서함이 어떤 상태인지 변경 없이 확인한다.
    통합 러너에서는 `jeil_runner.exe mailbox ...` 로 같은 것을 부른다."""
    import argparse
    ap = argparse.ArgumentParser(description="Exchange 사서함 공유 전환(기본 dry-run)")
    ap.add_argument("-e", "--email", required=True)
    ap.add_argument("--apply", action="store_true", help="실제 전환(Set-Mailbox -Type Shared)")
    a = ap.parse_args()
    for _s in (sys.stdout, sys.stderr):
        if hasattr(_s, "reconfigure"):
            _s.reconfigure(encoding="utf-8", errors="replace")
    r = to_shared(a.email, apply=a.apply)
    head = "OK" if r["ok"] else ("권한·구성 없음" if not r["available"] else "실패")
    print("[exo] %s — %s (state=%s%s)"
          % (head, r["msg"], r["state"], ", 변경됨" if r["changed"] else ""))
    return 0 if r["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
