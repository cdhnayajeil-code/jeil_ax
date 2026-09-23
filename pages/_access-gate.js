// pages/_access-gate.js — 부서 운영 페이지 접근 게이트 (서버 판정 jeil-me 강제, CLAUDE.md §5.4)
// 사용: 각 페이지 <head>에 아래 두 줄을 넣는다.
//   <script>window.PAGE_KEY='sales_2026';</script>
//   <script src="/pages/_access-gate.js"></script>
// 동작: PAGE_KEY의 접근 권한을 jeil-me(Entra 토큰 Graph 재검증)로 확인 → 미허가면 화면 차단.
//   · iframe/임베드(통합본 srcdoc) 안에서는 skip — 상위 포털이 이미 판정, 오프라인 데모 보호.
//   · 최상위 문서(직접 URL 접근 포함)에서만 강제 → URL만 알아도 접근 불가.
//   · 미로그인이면 포털로 보내되 "돌아올 주소"를 함께 넘긴다(REQ-0062) — 포털이 로그인 직후 이 화면으로 되돌린다.
//
// ★ 로그인은 두 겹이다(2026-09-23). 이 게이트가 둘 다 책임진다.
//   ① Entra 토큰(localStorage `jeilax_auth`) — 이 화면을 **볼 수 있는가**
//   ② Supabase 세션(localStorage `jeilax_sb_auth`) — 데이터를 **읽을 수 있는가**
//   ②가 없으면 화면은 멀쩡히 뜨고 조회만 `anon` 으로 나간다. `erp_ro` 에는 anon 권한이 없어
//   「permission denied for table pur_order_s」로 떨어진다 — 구매팀 신규 사용자에게 실제로 발생했다.
//   권한 설정은 정상인데 화면만 깨져 보이므로 원인을 찾기 어렵다. 그래서 여기서 막는다.
//   Edge Function(jeil-me·jeil-hr·jeil-gl-draft)만 쓰는 화면은 Entra 토큰으로 충분하므로
//   `window.PAGE_NEEDS_DB = false` 로 ②를 건너뛴다. **기본값은 「필요하다」** — 빠뜨려서
//   깨지는 쪽(permission denied)보다 불필요한 SSO 왕복 한 번이 낫다.
(function () {
  // 임베드(통합본 오버레이·미리보기) 안에서는 게이트 미적용
  try { if (window.self !== window.top) return; } catch (e) { /* cross-origin 임베드 → 계속(차단측 안전) */ }
  var key = window.PAGE_KEY;
  if (!key) return; // 게이트 키 미선언 페이지는 통과(설정 누락 오차단 방지)

  var ME_GATEWAY = "https://dvzohdqtjzocgcclgwro.supabase.co/functions/v1/jeil-me";
  var PORTAL = "/main";   // 공개 URL 라우트(_routes.py)
  var NEEDS_DB = (window.PAGE_NEEDS_DB !== false);   // 명시적으로 false 일 때만 건너뛴다
  var SSO_GUARD = "jeilax_gate_sso";                 // 같은 탭에서 SSO 를 이미 시도했는가

  function auth() {
    try { var a = JSON.parse(localStorage.getItem("jeilax_auth") || "null"); return (a && a.at && a.exp > Date.now()) ? a : null; }
    catch (e) { return null; }
  }
  function ssoTried() { try { return sessionStorage.getItem(SSO_GUARD) === "1"; } catch (e) { return false; } }
  function markSso(on) { try { on ? sessionStorage.setItem(SSO_GUARD, "1") : sessionStorage.removeItem(SSO_GUARD); } catch (e) {} }

  /* 미로그인 → 포털(로그인)로 보내면서 돌아올 주소를 남긴다.
     Entra 왕복(/main → login.microsoftonline.com → / → /main?code=…)에서 쿼리는 사라지므로
     실제 운반은 같은 탭의 sessionStorage 가 한다(PKCE verifier·state 와 같은 방식).
     쿼리 next 는 이미 로그인된 탭에서 곧바로 되돌리기 위한 보조 경로 + 사람이 읽는 흔적. */
  function toPortalForLogin() {
    var here = location.pathname + location.search + location.hash;
    try {
      sessionStorage.setItem("jeilax_next", here);
      sessionStorage.setItem("jeilax_next_name", (document.title || "").slice(0, 120));
    } catch (e) { /* 저장 불가(사생활 보호 모드 등) → 포털에 머문다 */ }
    location.replace(PORTAL + "?next=" + encodeURIComponent(here));
  }

  /** 차단 화면. act 를 주면 포털 링크 대신 그 버튼을 세운다(재로그인 유도). */
  function block(title, msg, act) {
    document.documentElement.innerHTML =
      '<head><meta charset="utf-8"><title>접근 권한 없음</title></head>' +
      '<body style="margin:0;font-family:\'Malgun Gothic\',\'Apple SD Gothic Neo\',sans-serif;background:#f4f6f9;display:flex;align-items:center;justify-content:center;min-height:100vh;">' +
      '<div style="max-width:460px;background:#fff;border:1px solid #e0e4ea;border-radius:14px;padding:40px 34px;text-align:center;box-shadow:0 4px 18px rgba(0,0,0,.08);">' +
      '<div style="font-size:48px;line-height:1;">' + ((act && act.icon) || "🔒") + '</div>' +
      '<h1 style="font-size:20px;color:#1a2f4e;margin:14px 0 8px;">' + title + '</h1>' +
      '<p style="color:#5a6675;font-size:14px;line-height:1.7;margin:0 0 22px;">' + msg + '</p>' +
      (act
        ? '<button id="__gate_act" style="background:#1a2f4e;color:#fff;border:0;padding:11px 22px;border-radius:9px;font-size:14px;cursor:pointer;">' + act.label + '</button>'
          + '<div style="margin-top:14px;"><a href="' + PORTAL + '" style="color:#5a6675;font-size:12.5px;">← 포털로 돌아가기</a></div>'
        : '<a href="' + PORTAL + '" style="display:inline-block;background:#1a2f4e;color:#fff;text-decoration:none;padding:11px 22px;border-radius:9px;font-size:14px;">← 포털로 돌아가기</a>') +
      '</div></body>';
    if (act) {
      var b = document.getElementById("__gate_act");
      if (b) b.onclick = act.onClick;
    }
  }

  /** Supabase 세션의 app_metadata.role — 사내 세션인지 협력사 세션인지 가른다. */
  function sbRole(session) {
    if (!session || !session.access_token) return null;
    try {
      var p = session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      while (p.length % 4) p += "=";
      var json = decodeURIComponent(atob(p).split("").map(function (c) {
        return "%" + c.charCodeAt(0).toString(16).padStart(2, "0");
      }).join(""));
      return (JSON.parse(json).app_metadata || {}).role || null;
    } catch (e) { return null; }
  }

  /* ② 데이터 세션 확보. 통과하면 true, 차단했으면 false,
     SSO 로 떠나는 경우에는 **아무것도 반환하지 않는다**(영원히 pending — 이 문서는 곧 사라진다). */
  function ensureDbSession() {
    if (!NEEDS_DB) return Promise.resolve(true);
    return import("/app/lib/supabaseClient.js").then(function (m) {
      // getSession() 은 클라이언트 초기화를 기다린다 — OAuth 로 돌아온 `?code=` 교환도 여기서 끝난다
      return m.supabase.auth.getSession().then(function (r) {
        var session = r && r.data ? r.data.session : null;
        var role = sbRole(session);
        if (session && role === "internal") { markSso(false); return true; }

        if (session && role !== "internal") {
          block("사내 전용 화면",
            "현재 <b>협력사(또는 권한 없는)</b> 계정으로 로그인되어 있어 표시할 수 없습니다.<br>사내(@jeilm.co.kr) 계정으로 다시 로그인하세요.",
            { icon: "🔒", label: "사내 계정으로 다시 로그인", onClick: function () { reSso(m.supabase); } });
          return false;
        }
        // 세션 없음 — 한 번은 조용히 시도한다(이미 Entra 에 로그인돼 있으면 왕복이 안 보인다)
        if (!ssoTried()) { markSso(true); sso(m.supabase); return new Promise(function () {}); }
        block("사내 로그인이 필요합니다",
          "데이터를 읽으려면 사내(@jeilm.co.kr) 계정 로그인이 한 번 더 필요합니다.<br>버튼을 눌러 로그인하세요.",
          { icon: "🔐", label: "사내 계정으로 로그인", onClick: function () { markSso(true); sso(m.supabase); } });
        return false;
      });
    }).catch(function (e) {
      block("로그인 확인 실패",
        "데이터 로그인 상태를 확인하지 못했습니다.<br><span style=\"color:#99a2ad;font-size:12px;\">" + (e && e.message || "") + "</span>");
      return false;
    });
  }

  function sso(sb) {
    var u = new URL(location.href); u.searchParams.set("sso", "1");
    sb.auth.signInWithOAuth({ provider: "azure", options: { scopes: "openid email profile", redirectTo: u.toString() } });
  }
  function reSso(sb) {
    markSso(true);
    sb.auth.signOut().catch(function () {}).then(function () { sso(sb); });
  }

  /* ① 이 화면을 볼 권한이 있는가 — 서버(jeil-me)가 판정한다 */
  function checkPage(a) {
    return fetch(ME_GATEWAY, { method: "POST", headers: { Authorization: "Bearer " + a.at } })
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

  function gate() {
    var a = auth();
    if (!a) { toPortalForLogin(); return; } // 미로그인 → 포털(로그인)로, 로그인 후 이 화면으로 복귀
    // 판정 전까지 본문 숨김(권한 없는 내용의 순간 노출 방지)
    var hide = document.createElement("style");
    hide.id = "__gate_hide"; hide.textContent = "body{visibility:hidden !important;}";
    (document.head || document.documentElement).appendChild(hide);
    // 데이터 세션을 먼저 확보한다 — 없으면 화면을 그려 봐야 조회가 permission denied 로 떨어진다
    ensureDbSession().then(function (ok) { if (ok) return checkPage(a); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", gate);
  else gate();
})();
