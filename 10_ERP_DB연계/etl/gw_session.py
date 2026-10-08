# -*- coding: utf-8 -*-
"""gw_session.py — 그룹웨어(ONUL Ware) 로그인·로그아웃 공용 (Playwright · gw_offboard · gw_board_collect 가 쓴다)

왜 뽑았나
  로그인 실패 처리(계정 잠금 방지·입력값 검증·시크릿키)는 안전 규칙이라 두 모듈에 갈라져 있으면 한쪽만 낡는다
  (§17.1 과 같은 원칙). 본문은 gw_offboard.py 의 로그인 블록(2026-09-07 실측 절차)을 그대로 옮긴 것이다.

규칙
  · 자리표시자(`ID 입력`·`암호 입력`)로 칸을 잡는다 — 클래스명은 난독화돼 바뀐다.
  · 제출 전에 입력값이 실제로 들어갔는지 확인한다. 빈 값 제출은 로그인 실패로 쌓여 계정이 잠긴다.
  · 자격증명 오류면 **재시도하지 않는다**.
  · 같은 계정이 다른 곳에 로그인돼 있으면 「시크릿키」 칸이 뜬다. `allow_force=False`(수집기 기본)면 입력하지 않고
    `session_busy` 로 돌려준다 — 사람이 쓰던 세션을 끊지 않는다. 퇴사 처리(gw_offboard)만 allow_force=True.
  · 계정·비밀값은 로그·화면·예외 메시지에 남기지 않는다(CLAUDE.md §1.8).

자격증명은 저장소 루트 `.env.local` 의 gw url / gw id / gw pw / gw secret (gw_collect.load_local 이 읽는다).
"""
import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gw_collect import load_local  # noqa: E402

SHOT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_gw_shots")   # git 제외(직원 정보가 찍힌다)
STEP_TIMEOUT = 30000


def load_gw_config():
    """{"url","id","pw","secret"} — 값은 절대 출력하지 않는다."""
    cfg = load_local()
    return {"url": cfg.get("GW_URL"), "id": cfg.get("GW_ID"), "pw": cfg.get("GW_PW"), "secret": cfg.get("GW_SECRET")}


def missing_keys(cfg):
    return [k for k, v in (("gw url", cfg.get("url")), ("gw id", cfg.get("id")), ("gw pw", cfg.get("pw"))) if not v]


def shot(page, name, shot_dir=SHOT_DIR, log=print):
    """단계별 증적. 파일명에 시각을 넣어 덮어쓰지 않는다."""
    try:
        os.makedirs(shot_dir, exist_ok=True)
        path = os.path.join(shot_dir, "%s_%s.png" % (datetime.datetime.now().strftime("%H%M%S"), name))
        page.screenshot(path=path, full_page=False)
        log("  증적 저장 → %s" % os.path.basename(path))
    except Exception as e:
        log("  증적 저장 실패(무시): %s" % str(e)[:80])


def new_page(p, headed=False, accept_downloads=False, viewport=(1500, 950)):
    """(browser, context, page). 다운로드가 필요한 호출자만 accept_downloads=True."""
    browser = p.chromium.launch(headless=not headed)
    context = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]},
                                  accept_downloads=bool(accept_downloads))
    page = context.new_page()
    page.set_default_timeout(STEP_TIMEOUT)
    return browser, context, page


def login(page, cfg, allow_force=False, shot_fn=None, log=print):
    """그룹웨어 로그인. 반환 {"ok", "forced", "reason", "msg"} — 예외를 던지지 않는다.

    reason: None | "missing_keys" | "input_failed" | "bad_credentials" | "session_busy" | "force_failed"
    """
    miss = missing_keys(cfg)
    if miss:
        return {"ok": False, "forced": False, "reason": "missing_keys", "msg": ".env.local 키 누락: " + ", ".join(miss)}
    url, uid, pw, secret = cfg["url"], cfg["id"], cfg["pw"], cfg.get("secret")
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_timeout(2000)
    page.get_by_placeholder("ID 입력").fill(uid)
    page.get_by_placeholder("암호 입력").fill(pw)            # 값은 로그·화면에 남기지 않는다
    if page.get_by_placeholder("ID 입력").input_value().strip() != uid:
        return {"ok": False, "forced": False, "reason": "input_failed",
                "msg": "ID 칸에 값이 들어가지 않았습니다 — 로그인 시도 없이 중단(계정 잠금 방지)"}
    page.click("button.login")
    page.wait_for_timeout(6000)
    if shot_fn:
        shot_fn(page, "01_login")
    body = page.inner_text("body")[:2000]
    if "잘못되었습니다" in body or "일치하지" in body:
        return {"ok": False, "forced": False, "reason": "bad_credentials",
                "msg": "로그인 실패(자격증명 불일치) — 재시도하지 않습니다(계정 잠금 방지). .env.local 의 gw id/pw 를 확인하세요"}
    sk = page.get_by_placeholder("시크릿키")
    if sk.count() and sk.first.is_visible():
        if not allow_force:
            return {"ok": False, "forced": False, "reason": "session_busy",
                    "msg": "같은 계정이 다른 곳에 로그인돼 있어(시크릿키 요구) 건너뜁니다 — 사람 세션을 끊지 않습니다"}
        if not secret:
            return {"ok": False, "forced": False, "reason": "force_failed",
                    "msg": "이미 로그인된 세션이 있어 「시크릿키」가 필요한데 .env.local 에 `gw secret` 이 없습니다"}
        log("   이미 로그인된 세션 감지 → 시크릿키로 강제 로그인(기존 세션은 끊긴다)")
        sk.first.fill(secret)
        page.click("button.login")
        page.wait_for_timeout(7000)
        if shot_fn:
            shot_fn(page, "01b_login_forced")
        sk2 = page.get_by_placeholder("시크릿키")
        if sk2.count() and sk2.first.is_visible():
            return {"ok": False, "forced": True, "reason": "force_failed",
                    "msg": "시크릿키 강제 로그인에 실패했습니다 — .env.local 의 `gw secret` 값을 확인하세요"}
        return {"ok": True, "forced": True, "reason": None, "msg": "강제 로그인"}
    return {"ok": True, "forced": False, "reason": None, "msg": "로그인"}


def logout(page, cfg, logout_path=None, log=print):
    """세션 정리 — 실패해도 예외 없이 로그만. 경로는 Step 0 실측값(프로필 login.logout_path)."""
    if not logout_path:
        return False
    try:
        base = (cfg.get("url") or "").rstrip("/")
        page.goto(base + "/" + str(logout_path).lstrip("/"), wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        log("  로그아웃")
        return True
    except Exception as e:
        log("  로그아웃 실패(무시): %s" % type(e).__name__)
        return False
