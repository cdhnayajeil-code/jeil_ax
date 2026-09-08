# -*- coding: utf-8 -*-
"""gw_offboard.py — 그룹웨어(ONUL Ware) 퇴사 처리 화면 자동화 (Playwright)

그룹웨어는 DB 쓰기 권한도 벤더 API 도 없다(실측: DB 사용자 `onul_member` 는 뷰 SELECT 만).
남은 길은 **관리자 화면을 사람처럼 조작**하는 것이고, 이 스크립트가 그 일을 한다.

절차는 추측이 아니다 — 2026-09-07 퇴사자 8명을 사람이 직접 이 순서로 처리해 전건 성공했고,
퇴사자 명부로 재검증까지 마쳤다. 그 13단계를 그대로 코드로 옮겼다(기획 `21_퇴사처리_일괄적용_기획 §5`).

이 화면의 함정 세 가지 — 하나라도 빠지면 조용히 틀린다:
  1. **기준일자를 퇴사일 이전으로 바꿔야 검색된다.** 퇴사자는 오늘 기준 조직도에 없다.
  2. `사용중지`를 누르면 **퇴사일이 오늘 날짜로 자동 덮어쓰기**된다. 저장 전에 되돌려야 실제 퇴사일이 남는다.
  3. 그때 같이 나타나는 **`메일 삭제여부` 체크박스**를 켜면 메일계정·메일정보가 일괄 삭제된다.

사용:
  python gw_offboard.py --login-id wc.kim --name 김우철 --retire-date 2023-12-22            # dry-run(기본)
  python gw_offboard.py --login-id wc.kim --name 김우철 --retire-date 2023-12-22 --apply    # 실제 저장
  python gw_offboard.py ... --headed            # 브라우저를 눈으로 보며 실행(디버깅)

안전장치:
  · **dry-run 이 기본**이다. `--apply` 를 줘야 저장한다.
  · 로그인ID·이름·퇴사일 **3중 대조**가 모두 맞아야 진행한다. 하나라도 어긋나면 중단(동명이인 오처리 방지).
  · 삭제 버튼·메일 삭제 체크박스는 **코드에서 아예 다루지 않는다**. 체크 상태만 확인하고 켜져 있으면 중단.
  · 단계마다 스크린샷을 남긴다(감사 증적, `CLAUDE.md §6`).
  · 선택자를 못 찾으면 즉시 중단한다 — 벤더 UI 가 바뀐 것이므로 조용히 잘못 누르는 것보다 멈추는 게 낫다.

자격증명은 저장소 루트 `.env.local` 에만 둔다. 값을 출력하지 않는다(`CLAUDE.md §1.8`).
"""
import argparse
import datetime
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gw_collect import load_local  # noqa: E402  (.env.local 파서 재사용)

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

SHOT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_gw_shots")
STEP_TIMEOUT = 30000


def log(msg):
    print("[gw-off] %s" % msg, flush=True)


def shot(page, name):
    """단계별 증적. 파일명에 시각을 넣어 덮어쓰지 않는다."""
    os.makedirs(SHOT_DIR, exist_ok=True)
    path = os.path.join(SHOT_DIR, "%s_%s.png" % (datetime.datetime.now().strftime("%H%M%S"), name))
    try:
        page.screenshot(path=path, full_page=False)
        log("  증적 저장 → %s" % os.path.basename(path))
    except Exception as e:
        log("  증적 저장 실패(무시): %s" % str(e)[:80])


def field_value_by_label(page, label):
    """편집 폼에서 '라벨' 칸 옆의 입력값을 읽는다. 폼이 표 구조라 라벨→행→input 으로 찾는다."""
    return page.evaluate(
        """(lab) => {
            const cells = [...document.querySelectorAll('td,th,div,span,label')]
              .filter(e => e.children.length === 0 && e.textContent.trim() === lab);
            for (const c of cells) {
              const row = c.closest('tr') || c.parentElement?.parentElement;
              if (!row) continue;
              const inp = row.querySelector('input[type=text], input:not([type])');
              if (inp) return inp.value;
            }
            return null;
        }""", label)


def open_member(page, name, base_date):
    """기준일자를 바꾸고 이름으로 검색해 대상 카드를 연다. 카드가 정확히 1건일 때만 진행."""
    # 화면 갱신은 앱 자신의 함수로 한다. 값만 바꾸면 반영되지 않는다(실측).
    page.evaluate(
        """([d, q]) => {
            document.getElementById('selectDate').value = d;
            document.getElementById('searchString').value = q;
            getReferenceCompany();
            UpdateMemberCountView();
        }""", [base_date, name])
    page.wait_for_timeout(3500)

    cards = page.evaluate(
        """() => [...document.querySelectorAll('div.each_file')]
              .map(e => ({ txt: e.textContent.trim().replace(/\\s+/g,' '),
                           oc: (e.getAttribute('onclick')||'') }))""")
    if len(cards) != 1:
        raise RuntimeError("검색 결과가 %d건입니다(1건이어야 진행) — 기준일자(%s)·이름(%s) 확인 필요. %s"
                           % (len(cards), base_date, name, [c["txt"] for c in cards][:5]))
    log("  대상 카드: %s" % cards[0]["txt"])
    page.evaluate("(oc) => eval(oc.replace(/^\\s*javascript:\\s*/, ''))", cards[0]["oc"])
    page.wait_for_timeout(3000)


def main():
    ap = argparse.ArgumentParser(description="그룹웨어 퇴사 처리 화면 자동화")
    # 짧은 플래그를 함께 둔다 — 명령이 길면 터미널에서 줄바꿈되며 두 줄로 쪼개져 실행된다(실제 발생).
    ap.add_argument("-i", "--login-id", required=True, help="그룹웨어 로그인ID (신원 확정 키)")
    ap.add_argument("-n", "--name", required=True, help="사원명 (화면 검색어)")
    ap.add_argument("-d", "--retire-date", required=True, help="실제 퇴사일 YYYY-MM-DD (자동 덮어쓰기를 되돌릴 값)")
    ap.add_argument("-b", "--base-date", default=None,
                    help="검색 기준일자 YYYY-MM-DD (생략 시 자동: 퇴사일 30일 전 → 안 잡히면 오늘로 재시도)")
    ap.add_argument("--apply", action="store_true", help="실제 저장(주지 않으면 dry-run)")
    ap.add_argument("--headed", action="store_true", help="브라우저 창을 띄워 눈으로 확인")
    return _exit_code(run(ap.parse_args()))


def _exit_code(res):
    """CLI 종료코드. 러너는 dict 를 그대로 쓰고, 사람은 0/1 만 보면 된다."""
    if not res.get("ok"):
        log("실패: %s" % str(res.get("msg"))[:400])
        return 1
    return 0


class _Args(object):
    """러너가 CLI 없이 호출할 때 쓰는 인자 묶음."""
    def __init__(self, **kw):
        self.__dict__.update(kw)


def offboard(login_id, name, retire_date, base_date=None, apply=False, headed=False):
    """퇴사 처리 1건 실행 진입점 — CLI(main)와 러너(etl_watch)가 **같은 경로**를 탄다.

    화면에서 누른 요청과 사람이 손으로 돌린 명령이 다른 코드를 타면, 한쪽에서만 나는 결함이
    생긴다. 그래서 인자만 다르게 만들고 본문은 하나로 둔다.
    반환: {"ok": bool, "msg": str, ...} — 예외를 밖으로 던지지 않는다(러너가 다음 대상을 계속 처리한다)."""
    return run(_Args(login_id=login_id, name=name, retire_date=retire_date,
                     base_date=base_date, apply=bool(apply), headed=bool(headed)))


def run(args):
    # 터미널에서 명령이 줄바꿈되며 붙여넣기되면 인자 안에 개행·연속 공백이 섞여 들어온다
    # (실제로 `테스트 계정` 이 `테스트\n  계정` 으로 들어와 검색 0건이 됐다 — 2026-09-07).
    # 화면 검색어는 공백에 민감하므로 여기서 한 칸으로 정규화한다.
    args.name = re.sub(r"\s+", " ", args.name).strip()
    args.login_id = args.login_id.strip()
    args.retire_date = args.retire_date.strip()
    if args.base_date:
        args.base_date = args.base_date.strip()

    if not re.match(r"^\d{4}-\d{2}-\d{2}$", args.retire_date):
        return {"ok": False, "msg": "퇴사일 형식은 YYYY-MM-DD 입니다: %s" % args.retire_date}
    base_date = args.base_date
    if not base_date:
        d = datetime.date.fromisoformat(args.retire_date) - datetime.timedelta(days=30)
        base_date = d.isoformat()

    cfg = load_local()
    url, uid, pw = cfg.get("GW_URL"), cfg.get("GW_ID"), cfg.get("GW_PW")
    secret = cfg.get("GW_SECRET")   # 중복 로그인 시 강제 로그인용(있을 때만 사용)
    missing = [k for k, v in (("gw url", url), ("gw id", uid), ("gw pw", pw)) if not v]
    if missing:
        return {"ok": False, "msg": ".env.local 키 누락: " + ", ".join(missing)}

    from playwright.sync_api import sync_playwright

    log("대상 %s(%s) · 퇴사일 %s · 기준일자 %s · %s"
        % (args.name, args.login_id, args.retire_date, base_date,
           "실제 저장" if args.apply else "dry-run(저장 안 함)"))

    dialogs = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        page = browser.new_page(viewport={"width": 1500, "height": 950})
        page.set_default_timeout(STEP_TIMEOUT)

        # 이 화면은 사용중지 클릭 시 confirm·alert 를 띄운다. Playwright 는 정식으로 받아 처리한다
        # (Chrome 확장으로 할 때 쓰던 window.alert 덮어쓰기 우회는 무인 운영에 부적합했다).
        def on_dialog(d):
            dialogs.append((d.type, d.message))
            log("  [모달-%s] %s" % (d.type, d.message.replace("\n", " ")))
            d.accept()
        page.on("dialog", on_dialog)

        try:
            # ── 1. 관리자 로그인 ──────────────────────────────────────────
            log("1) 관리자 로그인")
            page.goto(url, wait_until="domcontentloaded")
            page.wait_for_timeout(2000)
            # 클래스명(`__a`/`__b`)은 난독화된 값이라 바뀔 수 있다 — 자리표시자로 잡는다.
            page.get_by_placeholder("ID 입력").fill(uid)
            page.get_by_placeholder("암호 입력").fill(pw)   # 값은 로그·화면에 남기지 않는다
            # **입력이 실제로 들어갔는지 눌러보기 전에 확인한다.** 빈 값으로 제출하면
            # 로그인 실패가 계정에 쌓이고, 반복되면 잠긴다.
            if page.get_by_placeholder("ID 입력").input_value().strip() != uid:
                raise RuntimeError("ID 칸에 값이 들어가지 않았습니다 — 로그인 시도 없이 중단(계정 잠금 방지)")
            page.click("button.login")
            page.wait_for_timeout(6000)
            shot(page, "01_login")

            body = page.inner_text("body")[:2000]
            if "잘못되었습니다" in body or "일치하지" in body:
                raise RuntimeError("로그인 실패(자격증명 불일치) — 재시도하지 않습니다(계정 잠금 방지). "
                                   ".env.local 의 gw id/pw 를 확인하세요")

            # 같은 계정이 다른 곳에서 이미 로그인돼 있으면 **첫 시도 뒤에** 「시크릿키」 칸이 나타난다
            # (중복 로그인 차단 → 강제 로그인). 자격증명 오류가 아니므로 잠금 위험이 아니다.
            sk = page.get_by_placeholder("시크릿키")
            if sk.count() and sk.first.is_visible():
                if not secret:
                    raise RuntimeError(
                        "이미 로그인된 세션이 있어 「시크릿키」가 필요한데 .env.local 에 `gw secret` 이 없습니다")
                log("   이미 로그인된 세션 감지 → 시크릿키로 강제 로그인(기존 세션은 끊긴다)")
                sk.first.fill(secret)
                page.click("button.login")
                page.wait_for_timeout(7000)
                shot(page, "01b_login_forced")
                if page.get_by_placeholder("시크릿키").count() and \
                   page.get_by_placeholder("시크릿키").first.is_visible():
                    raise RuntimeError("시크릿키 강제 로그인에 실패했습니다 — .env.local 의 `gw secret` 값을 확인하세요")

            # ── 2. 관리자 > 기본정보관리 > 직원관리 ────────────────────────
            log("2) 직원관리 이동 — 로그인 계정: %s" % (page.evaluate(
                "() => (document.querySelector('.HeaderMenu_myprofile')||{}).innerText || ''"
            ).strip().replace("\n", " ") or "(확인 불가)"))
            if page.locator("#selectDate").count() == 0:
                # 사용자 포털로 떨어진 경우 좌측 아이콘바의 '관리자' 로 진입
                page.evaluate(
                    """() => {
                        const el = [...document.querySelectorAll('*')]
                          .filter(e => e.children.length === 0 && e.textContent.trim() === '관리자'
                                       && e.offsetParent)[0];
                        if (!el) throw new Error('관리자 메뉴를 찾지 못했습니다 — 권한이 없는 계정일 수 있습니다');
                        (el.closest('a,li,div') || el).click();
                    }""")
                page.wait_for_timeout(5000)
                shot(page, "02a_admin_home")
            # 좌측 하위 메뉴는 jstree(`div.SubTab`)다. **관리자 진입 직후 이미 Expanded 상태**이므로
            # 상위(기본정보관리)를 누르면 오히려 접힌다 — 누르지 않는다(2026-09-07 실측으로 확인).
            # 메뉴 항목은 `<a>` 안에 아이콘 등 자식이 있어 '텍스트 리프'로 찾으면 안 걸린다.
            sub = page.evaluate(
                """() => [...document.querySelectorAll('div.SubTab')]
                     .map(d => ({ folded: /Folded/.test(d.className), txt: d.innerText }))""")
            basic = next((s for s in sub if "직원관리" in (s["txt"] or "")), None)
            if basic and basic["folded"]:
                log("   기본정보관리 접힘 → 펼치기")
                page.evaluate(
                    """() => { const li = [...document.querySelectorAll('div.SubMenuLI')]
                                 .filter(e => e.innerText.trim().startsWith('기본정보관리'))[0];
                               li && li.click(); }""")
                page.wait_for_timeout(2500)
            if not basic:
                shown = page.evaluate(
                    """() => [...document.querySelectorAll('div.SubMenuLI')]
                         .map(e => e.innerText.trim().split('\\n')[0]).filter(Boolean).slice(0, 25)""")
                raise RuntimeError(
                    "이 계정에는 「기본정보관리 > 직원관리」 권한이 없습니다 — 퇴사 처리를 할 수 없습니다.\n"
                    "   보이는 관리자 메뉴: %s\n"
                    "   → 자동화 전용 계정에 직원관리 권한을 부여하거나, 권한 있는 계정으로 .env.local 을 바꾸세요."
                    % ", ".join(shown))
            page.get_by_text("직원관리", exact=True).first.click()
            page.wait_for_timeout(4000)
            page.wait_for_selector("#selectDate", timeout=STEP_TIMEOUT)
            shot(page, "02_member_admin")

            # ── 3~4. 기준일자 변경 + 검색 + 카드 열기 ──────────────────────
            # 기준일자는 **퇴사일 이전**이어야 퇴사자가 조직도에 잡힌다. 다만 아직 재직 중인
            # 사람(무기한 센티넬)은 오늘 기준으로 찾는 게 맞다. 둘 중 어느 쪽인지 미리 알 수 없으므로
            # 관리자가 지정하지 않았으면 두 후보를 차례로 시도한다.
            candidates = [base_date] if args.base_date else \
                         [base_date, datetime.date.today().isoformat()]
            last_err = None
            for i, bd in enumerate(candidates):
                log("3) 기준일자 %s 로 검색 — '%s'%s"
                    % (bd, args.name, "" if i == 0 else " (재시도)"))
                try:
                    open_member(page, args.name, bd)
                    base_date = bd
                    break
                except RuntimeError as e:
                    last_err = e
                    if i == len(candidates) - 1:
                        raise
                    log("   %s → 다음 기준일자로 재시도" % str(e)[:90])
            shot(page, "03_detail")

            # ── 5. 편집 폼 열기 ───────────────────────────────────────────
            log("4) 수정 버튼 → 편집 폼")
            page.evaluate(
                """() => {
                    const b = [...document.querySelectorAll('a,input,button')]
                      .filter(e => e.offsetParent && /^\\s*수정\\s*$/.test(e.value || e.textContent || ''))[0];
                    if (!b) throw new Error('수정 버튼을 찾지 못했습니다');
                    b.click();
                }""")
            # 라디오 자체는 CSS 로 숨기고 라벨만 보이는 구조라 visible 을 기다리면 안 된다.
            page.wait_for_selector("#useState2", state="attached", timeout=STEP_TIMEOUT)
            page.wait_for_selector('label[for="useState2"]', timeout=STEP_TIMEOUT)
            page.wait_for_timeout(1500)

            # ── 6. 3중 대조 (로그인ID·이름·퇴사일) ─────────────────────────
            log("5) 신원 대조")
            got_id = field_value_by_label(page, "로그인ID")
            got_nm = field_value_by_label(page, "사원명")
            got_start = page.input_value("#memberDetail_startDate")
            got_end = page.input_value("#memberDetail_endDate")
            log("   로그인ID=%s · 사원명=%s · 입사일=%s · 퇴사일=%s"
                % (got_id, got_nm, got_start, got_end))
            if (got_id or "").strip() != args.login_id:
                raise RuntimeError("로그인ID 불일치 — 기대 %s / 화면 %s (동명이인 가능성)"
                                   % (args.login_id, got_id))
            if re.sub(r"\s+", " ", got_nm or "").strip() != args.name:
                raise RuntimeError("사원명 불일치 — 기대 %s / 화면 %s" % (args.name, got_nm))
            # 퇴사일 판정.
            #   · 비어 있거나 **미래 날짜**면 재직 중이라는 뜻이다. 그룹웨어는 무기한을 미래 센티넬로
            #     표현하는데 값이 하나가 아니다(실측: 2200-12-31 · 2555-07-01). 그래서 특정 값을
            #     나열하지 않고 "오늘보다 뒤면 센티넬"로 본다 — 실제 퇴사일은 과거일 수밖에 없다.
            #   · 과거 날짜가 이미 들어 있으면 인자와 **정확히 같아야** 한다(다른 사람을 잡았을 수 있다).
            cur_end = (got_end or "").strip()
            today = datetime.date.today().isoformat()
            if not cur_end:
                log("   (퇴사일 비어 있음 — 신규 퇴사 처리로 진행)")
            elif cur_end > today:
                log("   (퇴사일 %s = 무기한 센티넬 — 재직 중으로 보고 신규 퇴사 처리로 진행)" % cur_end)
            elif cur_end != args.retire_date:
                raise RuntimeError("퇴사일 불일치 — 기대 %s / 화면 %s. 화면 값을 확인하고 인자를 맞추세요."
                                   % (args.retire_date, cur_end))
            if page.is_checked("#useState2"):
                log("   이미 사용중지 상태입니다 — 변경할 것이 없습니다.")
                browser.close()
                return {"ok": True, "msg": "이미 사용중지 상태", "changed": False,
                        "login_id": args.login_id, "name": args.name}

            # ── 7~9. 사용중지 클릭 (confirm·alert 발생) ────────────────────
            log("6) 사용여부 → 사용중지")
            page.click('label[for="useState2"]')
            page.wait_for_timeout(2500)
            if not page.is_checked("#useState2"):
                raise RuntimeError("사용중지로 전환되지 않았습니다(모달 처리 실패 가능)")

            # ── 10. 자동 덮어쓰인 퇴사일 되돌리기 ──────────────────────────
            auto = page.input_value("#memberDetail_endDate")
            if auto != args.retire_date:
                log("7) 퇴사일 자동 덮어쓰기 감지: %s → %s 로 복원" % (auto, args.retire_date))
                page.fill("#memberDetail_endDate", args.retire_date)
            else:
                log("7) 퇴사일 변동 없음(%s)" % auto)

            # ── 11. 파괴적 옵션이 켜지지 않았는지 확인 ─────────────────────
            checked = page.evaluate(
                "() => [...document.querySelectorAll('input[type=checkbox]')]"
                ".filter(c => c.offsetParent && c.checked).length")
            if checked:
                raise RuntimeError("체크된 체크박스가 %d개 있습니다 — 메일 삭제 등 위험 옵션일 수 있어 중단합니다"
                                   % checked)
            log("8) 위험 옵션 미체크 확인(메일 삭제여부 포함)")
            shot(page, "04_before_save")

            # ── 12. 저장 ─────────────────────────────────────────────────
            state = page.evaluate(
                """() => ({ stop: document.getElementById('useState2').checked,
                            end: document.getElementById('memberDetail_endDate').value })""")
            if not args.apply:
                log("9) (dry-run) 저장하지 않고 종료 — 저장 직전 상태: 사용중지=%s · 퇴사일=%s"
                    % (state["stop"], state["end"]))
                browser.close()
                return {"ok": True, "msg": "점검 완료(저장 안 함)", "changed": False, "dry_run": True,
                        "login_id": args.login_id, "name": args.name,
                        "would_set": {"사용중지": state["stop"], "퇴사일": state["end"]}}

            log("9) 저장(수정)")
            page.click('input.btn01[value="수정"]')
            page.wait_for_timeout(6000)
            shot(page, "05_saved")

            # ── 13. 저장 결과 재검증 (퇴사자 조회) ─────────────────────────
            log("10) 퇴사자 조회로 재검증")
            page.get_by_text("퇴사자 조회", exact=True).first.click()
            page.wait_for_timeout(4000)
            page.fill("#searchString", args.name)
            page.click("#memberSearchButton")
            page.wait_for_timeout(4000)
            rows = page.evaluate(
                """() => [...document.querySelectorAll('table tr')]
                      .map(tr => [...tr.cells].map(td => td.textContent.trim()))
                      .filter(r => r.length >= 7 && r[0] !== '이름')""")
            hit = [r for r in rows if len(r) > 3 and r[3] == args.login_id]
            shot(page, "06_verify")
            if not hit:
                raise RuntimeError("퇴사자 조회에서 %s 를 찾지 못했습니다 — 저장 결과를 직접 확인하세요"
                                   % args.login_id)
            row = hit[0]
            log("   결과: 이름=%s · 부서=%s · 사용여부=%s · 퇴사일=%s" % (row[0], row[2], row[4], row[6]))
            if row[4] != "사용중지":
                raise RuntimeError("저장은 됐으나 사용여부가 '%s' 입니다 — 확인 필요" % row[4])
            log("완료 — %s(%s) 사용중지 처리됨" % (args.name, args.login_id))
            browser.close()
            return {"ok": True, "msg": "사용중지 처리 완료", "changed": True,
                    "login_id": args.login_id, "name": args.name,
                    "verified": {"사용여부": row[4], "퇴사일": row[6], "부서": row[2]}}

        except Exception as e:
            log("실패: %s" % str(e)[:400])
            try:
                shot(page, "99_error")
                browser.close()
            except Exception:
                pass
            if dialogs:
                log("발생한 모달: %s" % dialogs)
            return {"ok": False, "msg": str(e)[:400], "changed": False,
                    "login_id": args.login_id, "name": args.name, "dialogs": dialogs}


if __name__ == "__main__":
    sys.exit(main())
