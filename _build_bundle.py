# -*- coding: utf-8 -*-
"""04 포털 데모 + 부서 운영 페이지 8종 + AI 니즈조사 설문폼을 단일 HTML로 통합 (공유용)
   - 각 페이지를 base64(UTF-8)로 내장, 버튼 클릭 시 전체화면 iframe(srcdoc) 오버레이로 표시
   - 설문폼은 외부 assets(css/js)를 인라인 처리 후 내장
   - 부서 화면의 표준 조회 플랫폼(app/lib/querybar.*)도 인라인 처리 — 오프라인에서도 기간·새로고침이 동작
   - 사내 운영 페이지 상단에 설문 참여 강조 배너 삽입 (통합본 한정 — 원본 04는 미변경)
   재생성: python _build_bundle.py
"""
import base64, re, sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
from _routes import FILE_TO_ROUTE  # noqa: E402  (공개 URL 라우트 단일 출처)

PORTAL = ROOT / "04_챗봇_포털_데모UI.html"
OUT = ROOT / "JEIL_AX_포털데모_통합본.html"

PAGES = {  # key: (상대경로, 오버레이 제목)
    # 오프라인에서 실제로 내용을 보여줄 수 있는 화면만 남긴다.
    # 부서 대시보드 6종은 2026-09-09 실데이터 단일화(REQ-0022)로 목업이 사라져,
    # 오프라인에서는 "사내 로그인 필요" 안내만 뜨는 빈 껍데기가 된다 — 공유본에 넣을 이유가 없다.
    # 협력사 모바일 포털도 전부 라이브(Supabase) 구동이라 같은 이유로 제외.
    "cost1": ("pages/2025-095-SUL-EC_원가현황_20260514.html", "프로젝트 원가관리 시스템 — 2025-095-SUL-EC"),
    "cost2": ("pages/프로젝트원가_요약_2025-095-SUL-EC.html", "프로젝트 원가 요약 (ERP DB 추출) — 2025-095-SUL-EC"),
}

# 통합본에 싣지 않는 화면 — 포털 카드는 잠금 버튼으로 바꿔 이유를 알린다(죽은 링크로 두지 않는다).
LIVE_ONLY = {
    "pages/영업_수주현황_2026.html": "영업 매출현황",
    "pages/구매_거래처별매입집계_2026.html": "구매 매입현황",
    "pages/인사_인원급여추이_2026.html": "인원 및 급여 현황",
    "pages/자재물류_재고입출고_2026.html": "자재 출고현황",
    "pages/품목중복_조회_2026.html": "품목 존재/중복 조회",
    "pages/외주발주_검사진행현황_2026.html": "외주발주 진행현황",
    "pages/자금현황_대시보드.html": "자금·경영 현황",   # 2026-09-09 자금일보 통합본
    "pages/협력사_모바일_포털.html": "협력사 모바일 포털",
    "pages/자금_결의전표_입력_2026.html": "결의전표 입력",
    # 관리자·협력사 화면도 전부 라이브 구동이라 오프라인에선 열리지 않는다 — 죽은 링크로 두지 않는다.
    "app/admin-vendors.html": "협력사 계정관리",
    "app/admin-identity.html": "계정·조직 통합관리",
    "app/admin-accounts.html": "계정 대사",
    "app/admin-user-dept.html": "사용자·부서 매핑",
    "app/erp-status.html": "ERP 연동 현황",
    "app/vendor-login.html": "협력사 로그인",
}

html = PORTAL.read_text(encoding="utf-8")

# 0) 통합본 표식 — 포털 스크립트가 서버 권한판정(jeil-me)을 건너뛰도록(오프라인 데모: 정적 오버레이 유지)
html = html.replace("</head>", "<script>window.IS_BUNDLE=true;</script></head>", 1)

# 1) 카드 앵커 → 오버레이 버튼 치환
replaced = 0
for key, (rel, _t) in PAGES.items():
    # 화면의 링크는 클린 URL(_routes.py) — 파일경로가 아니라 라우트로 찾는다
    href = FILE_TO_ROUTE.get(rel, rel)
    pat = re.compile(r'<a class="open-btn"([^>]*?)href="' + re.escape(href) + r'"[^>]*>(.*?)</a>', re.S)
    def sub(m, k=key):
        global replaced
        replaced += 1
        return f'<button class="open-btn"{m.group(1)}onclick="openEmbed(\'{k}\')">{m.group(2)}</button>'
    html = pat.sub(sub, html)

# 1-b) 통합본에 싣지 않는 화면 — 죽은 링크 대신 잠금 버튼(이유를 화면에서 알린다)
locked = 0
for rel, label in LIVE_ONLY.items():
    href = FILE_TO_ROUTE.get(rel, rel)
    pat = re.compile(r'<a class="open-btn"([^>]*?)href="' + re.escape(href) + r'"[^>]*>(.*?)</a>', re.S)

    def sub_lock(m, lb=label):
        global locked
        locked += 1
        return ('<button class="open-btn lock" disabled '
                f'title="{lb} — ERP 실데이터 화면입니다. 사내 계정으로 로그인해 ai.jeilm.co.kr 에서 보세요.">'
                '🔒 사내 전용</button>')

    html = pat.sub(sub_lock, html)

# 2) 니즈조사 설문폼 — assets 인라인 후 내장
sv_dir = ROOT / "05_니즈조사"
sv = (sv_dir / "01_니즈조사_설문폼.html").read_text(encoding="utf-8")
css = (sv_dir / "assets/survey-style.css").read_text(encoding="utf-8")
js = (sv_dir / "assets/datastore.js").read_text(encoding="utf-8")
sv = sv.replace('<link rel="stylesheet" href="assets/survey-style.css">', "<style>\n" + css + "\n</style>")
sv = sv.replace('<script src="assets/datastore.js"></script>', "<script>\n" + js + "\n</script>")
sv = sv.replace('<a class="backlink" href="/main">← 사내 AI 포털</a>', "")  # iframe 내 무효 링크 제거

# ---------------------------------------------------------------------------
# 오프라인 인라인 — 부서 화면이 참조하는 표준 조회 플랫폼(app/lib/querybar.*)을 페이지 안에 넣는다.
# 통합본은 srcdoc iframe 이라 "/app/lib/…" 루트 절대경로를 못 따라간다(파일 하나로 공유되는 게 목적).
# 원본(app/lib/querybar.js·css)은 읽기만 하고 수정하지 않는다 — 조회플랫폼/_build_html.py 와 같은 방식.
# ---------------------------------------------------------------------------
QBAR_CSS_SRC = (ROOT / "app/lib/querybar.css").read_text(encoding="utf-8")

# ESM export → 비모듈 전역. 패턴을 못 찾으면 빌드를 중단해 드리프트를 즉시 드러낸다.
_QBAR_EXPORTS = [
    ("export function createQueryBar", "function createQueryBar"),
    ("export function readMonthSeries", "function readMonthSeries"),
    ("export function numOf", "function numOf"),
    ("export default createQueryBar;", "/* (통합본) export default 제거 */"),
]


def _qbar_js() -> str:
    src = (ROOT / "app/lib/querybar.js").read_text(encoding="utf-8")
    if "</" + "script>" in src:
        sys.exit('[중단] querybar.js 안에 스크립트 종료 태그가 있습니다 — 인라인 주입 시 <script>가 조기 종료됩니다.')
    for pat, rep in _QBAR_EXPORTS:
        if pat not in src:
            sys.exit("[중단] querybar.js에서 예상 패턴을 찾지 못했습니다: %r\n"
                     "        export 형태가 바뀌었다면 _build_bundle.py의 _QBAR_EXPORTS도 함께 갱신하세요." % pat)
        src = src.replace(pat, rep, 1)
    return src


QBAR_JS_SRC = _qbar_js()

QBAR_LINK = '<link rel="stylesheet" href="/app/lib/querybar.css">'
QBAR_IMPORT_RE = re.compile(r'^[ \t]*import\s*\{[^}]*\}\s*from\s*"/app/lib/querybar\.js";[ \t]*\r?\n', re.M)
API_IMPORT_RE = re.compile(r'^[ \t]*import\s*\{([^}]*)\}\s*from\s*"/app/lib/api\.js";[ \t]*\r?\n', re.M)

# 오프라인에서는 ERP 실데이터를 부를 수 없다. import 를 없애면 모듈 전체가 죽어 조회바까지 사라지므로,
# "부르면 거절하는" 스텁으로 바꿔 페이지의 기존 catch 가 안내 문구를 띄우게 한다(목업은 그대로 보인다).
API_STUB = ('  const __offline = () => Promise.reject(new Error("통합본(오프라인)에서는 ERP 실데이터를 조회할 수 없습니다."));\n'
            '  const %s = new Proxy({}, { get: () => __offline });\n')


def offline_ready(src: str) -> str:
    """부서 화면 1개를 통합본(오프라인 srcdoc)에서도 동작하도록 손본다."""
    if QBAR_LINK in src:
        inline = "<style>\n" + QBAR_CSS_SRC + "\n</style>\n<" + "script>\n" + QBAR_JS_SRC + "\n</" + "script>"
        src = src.replace(QBAR_LINK, inline, 1)
        src = QBAR_IMPORT_RE.sub("", src)   # 위 전역 함수를 그대로 쓴다

    def _stub(m):
        names = [n.strip() for n in m.group(1).split(",") if n.strip()]
        return "".join(API_STUB % n for n in names)

    return API_IMPORT_RE.sub(_stub, src)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")

entries = []
total = 0
for key, (rel, title) in PAGES.items():
    raw = offline_ready((ROOT / rel).read_text(encoding="utf-8")).encode("utf-8")
    total += len(raw)
    entries.append(f'"{key}":{{"t":{title!r},"b":"{b64(raw)}"}}')
raw = sv.encode("utf-8"); total += len(raw)
entries.append('"survey":{"t":"AI 업무 활용 니즈조사 — 설문 작성","b":"' + b64(raw) + '"}')

# 3) 사이드바 설문 링크 → 통합본에서는 내장 오버레이로 전환 (단일 파일 동작)
ANCHOR = '<a id="surveyLink" href="/survey/form" target="_blank"'
assert ANCHOR in html, "사이드바 설문 링크 앵커를 찾지 못했습니다"
html = html.replace(ANCHOR, '<a id="surveyLink" href="javascript:openEmbed(\'survey\')"')

# 4) 오버레이 UI + 데이터
overlay = """
<!-- ===== 통합본: 내장 페이지 오버레이 ===== -->
<div id="embedOv" style="display:none; position:fixed; inset:0; z-index:200; background:rgba(15,25,40,.55); padding:2vh 2vw;">
  <div style="display:flex; flex-direction:column; width:100%; height:100%; background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 8px 40px rgba(0,0,0,.4);">
    <div style="flex:none; display:flex; align-items:center; justify-content:space-between; gap:10px; background:#1a2f4e; color:#fff; padding:10px 18px;">
      <b id="embedTitle" style="font-size:14px;">페이지</b>
      <button onclick="closeEmbed()" style="background:rgba(255,255,255,.15); color:#fff; border:none; border-radius:7px; padding:6px 16px; font-size:13px; cursor:pointer; font-family:inherit;">✕ 닫기 (포털로)</button>
    </div>
    <iframe id="embedFrame" style="flex:1; width:100%; border:none; background:#f4f6f9;"></iframe>
  </div>
</div>
<script>
var EMBED_PAGES = {__ENTRIES__};
function b64utf8(b){var bin=atob(b);var u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return new TextDecoder('utf-8').decode(u);}
function openEmbed(k){
  var p=EMBED_PAGES[k]; if(!p) return;
  document.getElementById('embedTitle').textContent=p.t;
  document.getElementById('embedFrame').srcdoc=b64utf8(p.b);
  document.getElementById('embedOv').style.display='block';
}
function closeEmbed(){
  document.getElementById('embedOv').style.display='none';
  document.getElementById('embedFrame').srcdoc='';
}
document.addEventListener('keydown',function(e){ if(e.key==='Escape') closeEmbed(); });
</script>
""".replace("__ENTRIES__", ",".join(entries))   # 템플릿이 이미 {…} 를 감싸고 있다(이중 중괄호 방지)

html = html.replace(
    "⚠ 화면 구성 데모 — 실제 API 미연결 상태이며, 모든 응답·수치는 예시 데이터입니다.",
    "⚠ 화면 구성 데모 (단일 파일 통합본 · 공유용) — 실제 API 미연결, 모든 응답·수치는 예시 데이터입니다. 부서 페이지 8종 + 니즈조사 설문 내장.")
# 재발 방지 — 오버레이 데이터가 이중 중괄호로 생성되면 스크립트가 통째로 죽어 "열기"가 무반응이 된다(2026-09-08 실제 발생)
assert "var EMBED_PAGES = " + "{{" not in overlay, "EMBED_PAGES 이중 중괄호 — 오버레이 스크립트가 죽습니다"
html = html.replace("</body>", overlay + "\n</body>")
OUT.write_text(html, encoding="utf-8")
print(f"치환된 카드 버튼: {replaced}개 ({len(PAGES)} 기대) · 잠금 처리: {locked}개")
assert replaced == len(PAGES), f"오버레이 카드 치환 누락 — {replaced}/{len(PAGES)}"
print(f"내장 콘텐츠 합계: {total/1024:.0f} KB (설문폼 포함 {len(PAGES)+1}종)")
print(f"통합본 크기: {OUT.stat().st_size/1024:.0f} KB -> {OUT.name}")
