// pages/_access-gate.js — 부서 운영 페이지 접근 게이트 (서버 판정 jeil-me 강제, CLAUDE.md §5.4)
// 사용: 각 페이지 <head>에 아래 두 줄을 넣는다.
//   <script>window.PAGE_KEY='sales_2026';</script>
//   <script src="_access-gate.js"></script>
// 동작: PAGE_KEY의 접근 권한을 jeil-me(Entra 토큰 Graph 재검증)로 확인 → 미허가면 화면 차단.
//   · iframe/임베드(통합본 srcdoc) 안에서는 skip — 상위 포털이 이미 판정, 오프라인 데모 보호.
//   · 최상위 문서(직접 URL 접근 포함)에서만 강제 → URL만 알아도 접근 불가.
(function () {
  // 임베드(통합본 오버레이·미리보기) 안에서는 게이트 미적용
  try { if (window.self !== window.top) return; } catch (e) { /* cross-origin 임베드 → 계속(차단측 안전) */ }
  var key = window.PAGE_KEY;
  if (!key) return; // 게이트 키 미선언 페이지는 통과(설정 누락 오차단 방지)

  var ME_GATEWAY = "https://dvzohdqtjzocgcclgwro.supabase.co/functions/v1/jeil-me";
  var PORTAL = "../04_챗봇_포털_데모UI.html";

  function auth() {
    try { var a = JSON.parse(localStorage.getItem("jeilax_auth") || "null"); return (a && a.at && a.exp > Date.now()) ? a : null; }
    catch (e) { return null; }
  }
  function block(title, msg) {
    document.documentElement.innerHTML =
      '<head><meta charset="utf-8"><title>접근 권한 없음</title></head>' +
      '<body style="margin:0;font-family:\'Malgun Gothic\',\'Apple SD Gothic Neo\',sans-serif;background:#f4f6f9;display:flex;align-items:center;justify-content:center;min-height:100vh;">' +
      '<div style="max-width:460px;background:#fff;border:1px solid #e0e4ea;border-radius:14px;padding:40px 34px;text-align:center;box-shadow:0 4px 18px rgba(0,0,0,.08);">' +
      '<div style="font-size:48px;line-height:1;">🔒</div>' +
      '<h1 style="font-size:20px;color:#1a2f4e;margin:14px 0 8px;">' + title + '</h1>' +
      '<p style="color:#5a6675;font-size:14px;line-height:1.7;margin:0 0 22px;">' + msg + '</p>' +
      '<a href="' + PORTAL + '" style="display:inline-block;background:#1a2f4e;color:#fff;text-decoration:none;padding:11px 22px;border-radius:9px;font-size:14px;">← 포털로 돌아가기</a>' +
      '</div></body>';
  }

  function gate() {
    var a = auth();
    if (!a) { location.replace(PORTAL); return; } // 미로그인 → 포털(로그인)로
    // 판정 전까지 본문 숨김(권한 없는 내용의 순간 노출 방지)
    var hide = document.createElement("style");
    hide.id = "__gate_hide"; hide.textContent = "body{visibility:hidden !important;}";
    (document.head || document.documentElement).appendChild(hide);
    fetch(ME_GATEWAY, { method: "POST", headers: { Authorization: "Bearer " + a.at } })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.j && res.j.error) || "권한 조회 실패");
        var pg = ((res.j.pages) || []).filter(function (p) { return p.page_key === key; })[0];
        if (pg && pg.allowed) {
          var s = document.getElementById("__gate_hide"); if (s) s.remove(); // 통과 → 표시
        } else {
          block("접근 권한이 없습니다", "이 페이지(<b>" + key + "</b>)는 회원님의 소속 부서·권한 범위 밖입니다.<br>열람이 필요하면 해당 부서 관리자 또는 시스템 관리자에게 요청하세요.");
        }
      })
      .catch(function (e) {
        block("권한 확인 실패", "접근 권한을 확인하지 못했습니다.<br><span style=\"color:#99a2ad;font-size:12px;\">" + (e && e.message || "") + "</span>");
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", gate);
  else gate();
})();
