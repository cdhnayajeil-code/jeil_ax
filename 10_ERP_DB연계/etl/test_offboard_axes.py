# -*- coding: utf-8 -*-
"""test_offboard_axes.py — 퇴사 처리 MS 축 단위 테스트(네트워크 접속 없음).

    python -m unittest test_offboard_axes -v

Graph 호출(`_graph`)과 Exchange 호출(`_exo`)을 전부 가짜로 바꿔 끼운다.
실제 계정을 건드리는 일은 **절대** 없다.

여기서 지키려는 것은 두 가지다.
  ① 표기가 displayName 뿐 아니라 **givenName 에도** 붙는가(Teams·연락처 카드용, 2026-09-17).
  ② 사서함을 공유로 못 바꿨을 때 **라이선스를 떼지 않는가**(떼면 30일 뒤 사서함이 사라진다).
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import offboard_axes as oa  # noqa: E402


class FakeExo(object):
    """exo_admin 대역 — to_shared 가 돌려줄 결과를 고정해 둔다."""

    def __init__(self, result):
        self.result = result
        self.calls = []

    def to_shared(self, email, apply=False):
        self.calls.append((email, apply))
        return dict(self.result)


def shared_result(**kw):
    base = {"ok": True, "available": True, "changed": False, "state": "user", "msg": "점검"}
    base.update(kw)
    return base


class MsAxisTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.user = {"id": "u-1", "displayName": "정우영", "givenName": "정우영",
                     "surname": "", "accountEnabled": True}
        self.direct = ["sku-1"]
        self.by_group = []
        self.lic_names = ["O365_BUSINESS_PREMIUM"]
        self.patch_status = 200
        self.assign_status = 200
        self._orig = (oa._graph, oa._exo)
        oa._graph = self._graph
        self.exo = FakeExo(shared_result())
        oa._exo = lambda: self.exo
        self.addCleanup(self._restore)

    def _restore(self):
        oa._graph, oa._exo = self._orig

    def _graph(self, tok, method, path, body=None):
        self.calls.append((method, path, body))
        if method == "GET" and "licenseAssignmentStates" in path:
            states = [{"skuId": s} for s in self.direct]
            states += [{"skuId": s, "assignedByGroup": "g-1"} for s in self.by_group]
            return 200, {"licenseAssignmentStates": states}
        if method == "GET" and path.endswith("/licenseDetails"):
            return 200, {"value": [{"skuPartNumber": n} for n in self.lic_names]}
        if method == "GET":
            return 200, dict(self.user)
        if method == "PATCH":
            return self.patch_status, None
        if method == "POST" and path.endswith("/assignLicense"):
            return self.assign_status, None
        return 400, "예상 못 한 호출"

    # ── 도우미 ────────────────────────────────────────────────────────
    def patched(self):
        """실제로 PATCH 로 보낸 본문(없으면 None)."""
        for m, _p, body in self.calls:
            if m == "PATCH":
                return body
        return None

    def assigned(self):
        return [c for c in self.calls if c[0] == "POST" and c[1].endswith("/assignLicense")]

    # ── ① 이름 표기 ───────────────────────────────────────────────────
    def test_prefix_goes_on_display_name_and_given_name(self):
        """Teams·연락처 카드에 보이게 하려면 givenName 에도 붙어야 한다(관리자 요구 2026-09-17)."""
        r = oa.ms_offboard("a@x", apply=True, tok="t", shared_mailbox=False)
        self.assertTrue(r["ok"], r["msg"])
        self.assertEqual(self.patched(),
                         {"displayName": "[퇴사]정우영", "givenName": "[퇴사]정우영",
                          "accountEnabled": False})

    def test_prefix_is_not_applied_twice(self):
        self.user.update(displayName="[퇴사]정우영", givenName="[퇴사]정우영", accountEnabled=False)
        self.direct = []
        r = oa.ms_offboard("a@x", apply=True, tok="t", shared_mailbox=False)
        self.assertTrue(r["ok"])
        self.assertFalse(r["changed"])
        self.assertIn("이미 처리됨", r["msg"])
        self.assertIsNone(self.patched())

    def test_empty_given_name_is_left_alone(self):
        """이름 칸이 비어 있으면 `[퇴사]` 만 남는 이상한 값을 만들지 않는다."""
        self.user["givenName"] = ""
        oa.ms_offboard("a@x", apply=True, tok="t", shared_mailbox=False)
        self.assertEqual(self.patched(), {"displayName": "[퇴사]정우영", "accountEnabled": False})

    def test_surname_is_not_touched(self):
        self.user["surname"] = "정"
        oa.ms_offboard("a@x", apply=True, tok="t", shared_mailbox=False)
        self.assertNotIn("surname", self.patched())

    # ── ② 사서함 공유 전환 ────────────────────────────────────────────
    def test_shared_conversion_runs_before_license_revoke(self):
        """공유로 바꾼 뒤에 라이선스를 떼야 메일이 남는다 — 순서가 뒤집히면 안 된다."""
        self.exo = FakeExo(shared_result(changed=True, state="shared", msg="사서함 공유 전환 완료"))
        oa._exo = lambda: self.exo
        r = oa.ms_offboard("a@x", apply=True, tok="t", shared_mailbox=True)
        self.assertTrue(r["ok"], r["msg"])
        self.assertEqual(self.exo.calls, [("a@x", True)])
        self.assertEqual(len(self.assigned()), 1)
        self.assertIn("사서함 공유 전환 완료", r["msg"])
        self.assertIn("라이선스 회수", r["msg"])
        self.assertEqual(r["mailbox"], "shared")

    def test_license_is_held_when_exchange_permission_missing(self):
        """권한 미구성은 실패가 아니지만, 사서함을 지킬 수 없으니 라이선스는 떼지 않는다."""
        self.exo = FakeExo(shared_result(ok=False, available=False, state="unknown",
                                         msg="Exchange 권한 없음(HTTP 403)"))
        oa._exo = lambda: self.exo
        r = oa.ms_offboard("a@x", apply=True, tok="t", shared_mailbox=True)
        self.assertTrue(r["ok"], r["msg"])
        self.assertEqual(self.assigned(), [], "전환 못 했으면 라이선스를 떼면 안 된다")
        self.assertIn("보류", r["msg"])
        self.assertIsNotNone(self.patched(), "차단·표기는 그대로 한다")

    def test_conversion_failure_stops_everything(self):
        """권한은 있는데 전환이 실패 — 진짜 오류. 차단·라이선스까지 건드리지 않는다."""
        self.exo = FakeExo(shared_result(ok=False, available=True, msg="HTTP 500"))
        oa._exo = lambda: self.exo
        r = oa.ms_offboard("a@x", apply=True, tok="t", shared_mailbox=True)
        self.assertFalse(r["ok"])
        self.assertIsNone(self.patched())
        self.assertEqual(self.assigned(), [])

    def test_already_shared_still_revokes_license(self):
        self.exo = FakeExo(shared_result(state="shared", msg="이미 공유 사서함"))
        oa._exo = lambda: self.exo
        r = oa.ms_offboard("a@x", apply=True, tok="t", shared_mailbox=True)
        self.assertTrue(r["ok"], r["msg"])
        self.assertEqual(len(self.assigned()), 1)

    def test_no_mailbox_account_is_not_an_error(self):
        """Exchange 라이선스가 없어 사서함 자체가 없는 계정 — 전환할 것이 없다."""
        self.exo = FakeExo(shared_result(state="none", msg="사서함 없음 — 전환할 것이 없습니다"))
        oa._exo = lambda: self.exo
        r = oa.ms_offboard("a@x", apply=True, tok="t", shared_mailbox=True)
        self.assertTrue(r["ok"], r["msg"])
        self.assertEqual(len(self.assigned()), 1)

    # ── 점검(dry-run) ────────────────────────────────────────────────
    def test_dry_run_changes_nothing_and_lists_all_steps(self):
        self.exo = FakeExo(shared_result(msg="점검 — 사서함 개인 → 공유 사서함으로 전환 예정"))
        oa._exo = lambda: self.exo
        r = oa.ms_offboard("a@x", apply=False, tok="t", shared_mailbox=True)
        self.assertTrue(r["ok"])
        self.assertTrue(r["dry_run"])
        self.assertIsNone(self.patched())
        self.assertEqual(self.assigned(), [])
        self.assertEqual(self.exo.calls, [("a@x", False)])
        for piece in ("공유 사서함", "차단·표기", "라이선스 회수"):
            self.assertIn(piece, r["msg"])

    def test_group_license_is_reported_not_revoked(self):
        self.by_group = ["sku-g"]
        self.direct = []
        self.exo = FakeExo(shared_result(state="shared", msg="이미 공유 사서함"))
        oa._exo = lambda: self.exo
        r = oa.ms_offboard("a@x", apply=True, tok="t", shared_mailbox=True)
        self.assertTrue(r["ok"])
        self.assertEqual(self.assigned(), [])
        self.assertIn("그룹 상속 라이선스 1건", r["msg"])

    # ── 스위치 ───────────────────────────────────────────────────────
    def test_env_switch_can_turn_conversion_off(self):
        old = os.environ.get("MS_SHARED_MAILBOX")
        os.environ["MS_SHARED_MAILBOX"] = "off"
        self.addCleanup(lambda: os.environ.pop("MS_SHARED_MAILBOX", None) if old is None
                        else os.environ.__setitem__("MS_SHARED_MAILBOX", old))
        r = oa.ms_offboard("a@x", apply=True, tok="t")
        self.assertTrue(r["ok"], r["msg"])
        self.assertEqual(self.exo.calls, [], "off 면 Exchange 를 아예 부르지 않는다")
        self.assertEqual(len(self.assigned()), 1)

    def test_patch_failure_is_reported_without_touching_license(self):
        self.patch_status = 403
        self.exo = FakeExo(shared_result(state="shared", msg="이미 공유 사서함"))
        oa._exo = lambda: self.exo
        r = oa.ms_offboard("a@x", apply=True, tok="t", shared_mailbox=True)
        self.assertFalse(r["ok"])
        self.assertEqual(self.assigned(), [])
        self.assertIn("권한 없음", r["msg"])


class NamePatchTest(unittest.TestCase):
    def test_fields_are_display_name_and_given_name_only(self):
        self.assertEqual(oa.MS_NAME_FIELDS, ("displayName", "givenName"))

    def test_prefix_value(self):
        self.assertEqual(oa.MS_PREFIX, "[퇴사]")

    def test_name_patch_skips_marked_fields(self):
        out = oa._name_patch({"displayName": "(퇴사)홍길동", "givenName": "홍길동"})
        self.assertEqual(out, {"givenName": "[퇴사]홍길동"},
                         "(퇴사) 표기도 이미 표기된 것으로 본다 — 중복 접두 금지")


if __name__ == "__main__":
    for _s in (sys.stdout, sys.stderr):
        if hasattr(_s, "reconfigure"):
            _s.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
