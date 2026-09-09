# -*- coding: utf-8 -*-
"""offboard_axes.py — 퇴사 처리 3축 실행기 (ERP · 그룹웨어 · MS)

한 사람의 퇴사 처리는 세 시스템에서 각각 일어난다. 축마다 붙는 방법이 다르다.

  · ERP       : SharePoint 목록 「ERP 퇴사처리 RPA」에 등재 → 기존 Power Automate 흐름이 처리
                (포털이 ERP MSSQL 을 직접 건드리지 않는다 — CLAUDE.md §1.2)
  · 그룹웨어   : 관리자 화면 자동화(Playwright) — gw_offboard.py
  · MS(Entra) : Graph — 로그인 차단 + 표시이름 `[퇴사]` 접두 + **라이선스 회수**

앱 권한은 2026-09-09 부여 완료(`Sites.ReadWrite.All` · `User.ReadWrite.All`).
실측으로 확인한 것:
  · 계정 차단(accountEnabled=false)에 **User Administrator 역할은 필요 없었다** — User.ReadWrite.All 로 충분.
  · 라이선스 회수는 `POST /users/{id}/assignLicense` 로 되고, 테넌트가 바쁘면 **409(동시 요청)**
    가 나므로 재시도가 필요하다(실측).
  · **그룹 기반 라이선스는 이 API 로 못 뗀다** — 그룹에서 사용자를 빼야 한다. 구분해서
    직접 할당분만 회수하고, 그룹 상속분은 결과에 남겨 사람이 처리하게 한다.
  · Graph 는 최종 일관성이라 방금 바꾼 값을 곧바로 읽으면 옛 값이 올 수 있다(실측).

반환은 모두 같은 모양이다 — {"ok": bool, "msg": str, ...}. 예외를 밖으로 던지지 않는다.
러너가 한 사람·한 축에서 실패해도 나머지를 계속 처리해야 하기 때문이다.
"""
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _env import load_env, need  # noqa: E402

GRAPH = "https://graph.microsoft.com/v1.0"

# SharePoint 「ERP 퇴사처리 RPA」 목록 — 사이트·목록 식별자(2026-09-07 Graph 조회로 확인).
# 목록 GUID 는 Power Automate 흐름의 트리거가 쓰는 것과 같은 값이다.
SP_SITE = ("jeilmns.sharepoint.com,3ea9a68c-c9ad-46a7-a1aa-1c920a47547f,"
           "cffda662-b71f-48db-ba43-af744dc3d655")
SP_LIST = "505ea3f8-1568-47b9-a194-3cdd46b71f74"

# 흐름 조건이 `진행구분 == '-'` 이다. 비워 두면 **조용히 지나간다**(실패로도 안 뜬다) —
# 2026-09-07 실측으로 확인한 함정이라 상수로 못 박는다.
SP_STATUS_PENDING = "-"


def _token():
    load_env()
    body = urllib.parse.urlencode({
        "client_id": need("ENTRA_CLIENT_ID"),
        "client_secret": need("ENTRA_CLIENT_SECRET"),
        "scope": "https://graph.microsoft.com/.default",
        "grant_type": "client_credentials",
    }).encode()
    req = urllib.request.Request(
        "https://login.microsoftonline.com/%s/oauth2/v2.0/token" % need("ENTRA_TENANT_ID"),
        data=body, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())["access_token"]


def _graph(tok, method, path, body=None):
    """(status, payload_or_error_message). 오류 본문에 시크릿이 실릴 일은 없다."""
    req = urllib.request.Request(
        GRAPH + path, method=method,
        data=(json.dumps(body).encode() if body is not None else None),
        headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            raw = r.read().decode() or ""
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            j = json.loads(e.read().decode("utf-8", "replace"))
            detail = (j.get("error") or {}).get("message", "")[:220]
        except Exception:
            pass
        return e.code, detail


def _perm_msg(axis, code, detail):
    """403 은 거의 항상 권한 문제다 — 무엇을 부여해야 하는지까지 말해 준다."""
    if code in (401, 403):
        what = ("Graph 응용 권한 `Sites.ReadWrite.All`(또는 Sites.Selected + 사이트 권한)"
                if axis == "erp" else "Graph 응용 권한 `User.ReadWrite.All`"
                                      "(계정 차단에는 User Administrator 역할이 더 필요할 수 있음)")
        return "권한 없음(HTTP %s) — %s 부여 후 재시도. %s" % (code, what, detail)
    return "HTTP %s — %s" % (code, detail)


# ─────────────────────────────────────────────────────────────────────────
# ERP — SharePoint 목록 등재 (실제 ERP 반영은 기존 Power Automate 흐름이 한다)
# ─────────────────────────────────────────────────────────────────────────
def erp_offboard(email, emp_nm, retire_dt, acct_nm=None, apply=False, tok=None):
    """목록에 한 줄 등재. 흐름이 1분 내 집어가 ERP 를 갱신한다.

    `사용자명` 은 ERP `usr_nm`(부서_이름) 을 그대로 넣는 것이 맞다 — 흐름이 처리내용에
    그 값을 적고, 사람이 나중에 목록만 보고도 누구인지 알 수 있어야 한다."""
    if not retire_dt:
        return {"ok": False, "axis": "erp", "msg": "퇴사일이 없어 등재할 수 없습니다"}
    fields = {
        "Title": email,                      # 사용자 ID (= ERP USR_ID)
        "field_1": acct_nm or emp_nm or "",   # 사용자명 — 실제 내부명은 아래에서 확인 후 보정
    }
    if not apply:
        return {"ok": True, "axis": "erp", "changed": False, "dry_run": True,
                "msg": "점검 — 등재할 값: %s / %s / 퇴사일 %s / 진행구분 %s"
                       % (email, acct_nm or emp_nm, retire_dt, SP_STATUS_PENDING)}

    tok = tok or _token()
    # 컬럼 내부명은 목록마다 다르다(한글 표시명 → OData 인코딩). 매번 조회해 맞춘다.
    st, cols = _graph(tok, "GET", "/sites/%s/lists/%s/columns?$select=name,displayName" % (SP_SITE, SP_LIST))
    if st != 200:
        return {"ok": False, "axis": "erp", "msg": _perm_msg("erp", st, str(cols)[:180])}
    by_label = {}
    for c in (cols.get("value") or []):
        by_label[(c.get("displayName") or "").strip()] = c.get("name")
    need_cols = {"사용자명": None, "퇴사일자": None, "진행구분": None, "비고": None}
    for k in list(need_cols):
        need_cols[k] = by_label.get(k)
    missing = [k for k, v in need_cols.items() if not v and k != "비고"]
    if missing:
        return {"ok": False, "axis": "erp",
                "msg": "목록 컬럼을 찾지 못했습니다: %s (표시명이 바뀌었는지 확인)" % ", ".join(missing)}

    fields = {"Title": email}
    fields[need_cols["사용자명"]] = acct_nm or emp_nm or ""
    fields[need_cols["퇴사일자"]] = retire_dt
    fields[need_cols["진행구분"]] = SP_STATUS_PENDING
    if need_cols["비고"]:
        fields[need_cols["비고"]] = "AX 포털 퇴사 처리"

    st, res = _graph(tok, "POST", "/sites/%s/lists/%s/items" % (SP_SITE, SP_LIST),
                     {"fields": fields})
    if st not in (200, 201):
        return {"ok": False, "axis": "erp", "msg": _perm_msg("erp", st, str(res)[:180])}
    return {"ok": True, "axis": "erp", "changed": True, "item_id": (res or {}).get("id"),
            "msg": "SharePoint 등재 완료 — 흐름이 1분 내 ERP 를 갱신합니다"}


# ─────────────────────────────────────────────────────────────────────────
# MS(Entra) — 로그인 차단 + 표시이름 [퇴사] 접두
# ─────────────────────────────────────────────────────────────────────────
MS_PREFIX = "[퇴사]"   # 실측 표기 분포 [퇴사] 320 / (퇴사) 26 → 많은 쪽으로 통일


def _ms_licenses(tok, uid):
    """(직접 할당 skuId 목록, 그룹 상속 skuId 목록, 표시용 이름).

    **그룹 기반 라이선스는 assignLicense 로 못 뗀다** — 그룹에서 사용자를 빼야 한다.
    구분하지 않고 지우려 들면 조용히 실패하거나 오류만 남으므로, 나눠서 다루고
    그룹 상속분은 사람이 처리하도록 결과에 적어 돌려준다."""
    direct, by_group, names = [], [], []
    st, a = _graph(tok, "GET", "/users/%s?$select=licenseAssignmentStates" % uid)
    if st == 200:
        for s in (a.get("licenseAssignmentStates") or []):
            sku = s.get("skuId")
            if not sku:
                continue
            (by_group if s.get("assignedByGroup") else direct).append(sku)
    st2, l = _graph(tok, "GET", "/users/%s/licenseDetails" % uid)
    if st2 == 200:
        names = [x.get("skuPartNumber") for x in (l.get("value") or [])]
    return direct, by_group, names


def _assign_license(tok, uid, add, remove, tries=4):
    """assignLicense 는 테넌트가 바쁘면 409(concurrent requests)를 돌려준다(실측).
    한 번 실패했다고 라이선스가 남은 채로 끝나면 안 되므로 잠깐 쉬었다 다시 건다."""
    import time
    last = (0, "")
    for i in range(tries):
        last = _graph(tok, "POST", "/users/%s/assignLicense" % uid,
                      {"addLicenses": add, "removeLicenses": remove})
        if last[0] in (200, 202):
            return last
        if last[0] != 409:
            return last
        time.sleep(6 * (i + 1))
    return last


def ms_offboard(email, apply=False, tok=None, revoke_license=True):
    """MS 퇴사 처리 — ①로그인 차단 ②표시이름 [퇴사] 접두 ③라이선스 회수.

    ⚠ 라이선스를 떼면 **사서함이 30일 보존 후 삭제**된다(Microsoft 정책). 되돌리려면
    그 기간 안에 같은 라이선스를 다시 할당해야 한다. 그래서 회수는 옵션으로 두고,
    화면이 그 사실을 알린 뒤 켜도록 한다."""
    tok = tok or _token()
    st, u = _graph(tok, "GET", "/users/%s?$select=id,displayName,accountEnabled,usageLocation" % email)
    if st != 200:
        return {"ok": False, "axis": "ms", "msg": _perm_msg("ms", st, str(u)[:180])}

    uid = u["id"]
    name = u.get("displayName") or ""
    already_marked = ("퇴사" in name)
    direct, by_group, lic_names = ([], [], [])
    if revoke_license:
        direct, by_group, lic_names = _ms_licenses(tok, uid)

    patch = {}
    if u.get("accountEnabled"):
        patch["accountEnabled"] = False
    if not already_marked:
        patch["displayName"] = MS_PREFIX + name

    todo = []
    if patch:
        todo.append("차단·표기 " + json.dumps(patch, ensure_ascii=False))
    if direct:
        todo.append("라이선스 회수 %s" % (", ".join(lic_names) or "%d건" % len(direct)))
    if by_group:
        todo.append("⚠ 그룹 상속 라이선스 %d건은 그룹에서 제외해야 함(자동 회수 불가)" % len(by_group))

    if not patch and not direct:
        return {"ok": True, "axis": "ms", "changed": False,
                "msg": "이미 처리됨" + (" · " + todo[-1] if by_group else ""),
                "license_by_group": by_group}
    if not apply:
        return {"ok": True, "axis": "ms", "changed": False, "dry_run": True,
                "msg": "점검 — " + " / ".join(todo)}

    done = []
    if patch:
        st, res = _graph(tok, "PATCH", "/users/" + uid, patch)
        if st not in (200, 204):
            return {"ok": False, "axis": "ms", "msg": _perm_msg("ms", st, str(res)[:180])}
        done.append("차단·표기 " + json.dumps(patch, ensure_ascii=False))
    if direct:
        st, res = _assign_license(tok, uid, [], direct)
        if st not in (200, 202):
            # 차단은 됐는데 라이선스만 남은 상태 — 절반만 됐다는 것을 분명히 말한다.
            return {"ok": False, "axis": "ms", "changed": bool(done),
                    "msg": "차단·표기는 됐으나 라이선스 회수 실패 — " + _perm_msg("ms", st, str(res)[:160])}
        done.append("라이선스 회수 %s" % (", ".join(lic_names) or "%d건" % len(direct)))

    msg = " / ".join(done)
    if by_group:
        msg += " / ⚠ 그룹 상속 라이선스 %d건 남음 — 그룹에서 제외 필요" % len(by_group)
    return {"ok": True, "axis": "ms", "changed": True, "msg": msg,
            "license_removed": lic_names, "license_by_group": by_group}


# ─────────────────────────────────────────────────────────────────────────
# 그룹웨어 — 화면 자동화(별도 모듈). 여기서는 같은 반환 모양으로 감싸기만 한다.
# ─────────────────────────────────────────────────────────────────────────
def gw_offboard_axis(login_id, emp_nm, retire_dt, apply=False):
    import gw_offboard
    if not login_id:
        return {"ok": False, "axis": "gw", "msg": "그룹웨어 로그인ID 가 없습니다(이메일 미등록 계정)"}
    res = dict(gw_offboard.offboard(login_id=login_id, name=emp_nm,
                                    retire_date=retire_dt, apply=apply) or {})
    res["axis"] = "gw"
    return res


AXES = ("erp", "gw", "ms")


def run_axes(target, axes, apply=False, tok=None):
    """대상 1명 × 요청 축들. 축 하나가 실패해도 나머지는 계속한다."""
    out = []
    for ax in axes:
        if ax not in AXES:
            continue
        try:
            if ax == "erp":
                r = erp_offboard(target.get("email"), target.get("emp_nm"), target.get("retire_dt"),
                                 acct_nm=target.get("acct_nm"), apply=apply, tok=tok)
            elif ax == "gw":
                r = gw_offboard_axis(target.get("gw_login_id"), target.get("emp_nm"),
                                     target.get("retire_dt"), apply=apply)
            else:
                r = ms_offboard(target.get("email"), apply=apply, tok=tok,
                                revoke_license=target.get("revoke_license", True))
        except Exception as e:                       # 예상 못 한 오류도 축 하나로 가둔다
            r = {"ok": False, "axis": ax, "msg": str(e)[:300]}
        out.append(r)
    return out


if __name__ == "__main__":
    # 점검용 CLI — 실제 변경 없이 각 축이 무엇을 하려는지, 권한이 있는지 확인한다.
    import argparse
    ap = argparse.ArgumentParser(description="퇴사 처리 3축 점검(기본 dry-run)")
    ap.add_argument("-e", "--email", required=True)
    ap.add_argument("-n", "--name", default="")
    ap.add_argument("-d", "--retire-date", default="")
    ap.add_argument("-g", "--gw-login-id", default="")
    ap.add_argument("-a", "--axes", default="erp,gw,ms")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    for _s in (sys.stdout, sys.stderr):
        if hasattr(_s, "reconfigure"):
            _s.reconfigure(encoding="utf-8", errors="replace")
    tgt = {"email": a.email, "emp_nm": a.name, "retire_dt": a.retire_date,
           "gw_login_id": a.gw_login_id}
    for r in run_axes(tgt, [x.strip() for x in a.axes.split(",")], apply=a.apply):
        print("[%s] %s — %s" % (r.get("axis"), "OK" if r.get("ok") else "실패", r.get("msg")))
