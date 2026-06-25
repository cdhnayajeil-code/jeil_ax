# -*- coding: utf-8 -*-
"""04 포털 데모 + 부서 운영 페이지 8종 + AI 니즈조사 설문폼을 단일 HTML로 통합 (공유용)
   - 각 페이지를 base64(UTF-8)로 내장, 버튼 클릭 시 전체화면 iframe(srcdoc) 오버레이로 표시
   - 설문폼은 외부 assets(css/js)를 인라인 처리 후 내장
   - 사내 운영 페이지 상단에 설문 참여 강조 배너 삽입 (통합본 한정 — 원본 04는 미변경)
   재생성: python _build_bundle.py
"""
import base64, re, sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent
PORTAL = ROOT / "04_챗봇_포털_데모UI.html"
OUT = ROOT / "JEIL_AX_포털데모_통합본.html"

PAGES = {  # key: (상대경로, 오버레이 제목)
    "cost1": ("pages/2025-095-SUL-EC_원가현황_20260514.html", "프로젝트 원가관리 시스템 — 2025-095-SUL-EC"),
    "cost2": ("pages/프로젝트원가_요약_2025-095-SUL-EC.html", "프로젝트 원가 요약 (ERP DB 추출) — 2025-095-SUL-EC"),
    "sales": ("pages/영업_수주현황_2026.html", "영업팀 — 2026년 수주현황 대시보드"),
    "pur":   ("pages/구매_거래처별매입집계_2026.html", "구매팀 — 2026년 거래처별 매입금액 집계"),
    "hr":    ("pages/인사_인원급여추이_2026.html", "인사팀 — 2026년 인원 및 급여 추이"),
    "fin":   ("pages/자금_자금일보_대시보드_2026.html", "자금팀 — 자금일보 대시보드"),
    "wh":    ("pages/자재물류_재고입출고_2026.html", "자재물류팀 — 2026년 재고 입·출고 현황"),
    "item":  ("pages/품목중복_조회_2026.html", "품목 존재/중복 조회 (검색형)"),
    "subc":  ("pages/외주발주_검사진행현황_2026.html", "외주 발주·검사 진행현황 — 구매·품질·생산·사업관리 공유"),
    "mob":   ("pages/협력사_모바일_포털.html", "협력사 모바일 발주·사진등록 포털 (사내 연계)"),
}

html = PORTAL.read_text(encoding="utf-8")

# 1) 카드 앵커 → 오버레이 버튼 치환
replaced = 0
for key, (rel, _t) in PAGES.items():
    pat = re.compile(r'<a class="open-btn"([^>]*?)href="' + re.escape(rel) + r'"[^>]*>(.*?)</a>', re.S)
    def sub(m, k=key):
        global replaced
        replaced += 1
        return f'<button class="open-btn"{m.group(1)}onclick="openEmbed(\'{k}\')">{m.group(2)}</button>'
    html = pat.sub(sub, html)

# 2) 니즈조사 설문폼 — assets 인라인 후 내장
sv_dir = ROOT / "05_니즈조사"
sv = (sv_dir / "01_니즈조사_설문폼.html").read_text(encoding="utf-8")
css = (sv_dir / "assets/survey-style.css").read_text(encoding="utf-8")
js = (sv_dir / "assets/datastore.js").read_text(encoding="utf-8")
sv = sv.replace('<link rel="stylesheet" href="assets/survey-style.css">', "<style>\n" + css + "\n</style>")
sv = sv.replace('<script src="assets/datastore.js"></script>', "<script>\n" + js + "\n</script>")
sv = sv.replace('<a class="backlink" href="../04_챗봇_포털_데모UI.html">← 사내 AI 포털</a>', "")  # iframe 내 무효 링크 제거

def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")

entries = []
total = 0
for key, (rel, title) in PAGES.items():
    raw = (ROOT / rel).read_bytes()
    total += len(raw)
    entries.append(f'"{key}":{{"t":{title!r},"b":"{b64(raw)}"}}')
raw = sv.encode("utf-8"); total += len(raw)
entries.append('"survey":{"t":"AI 업무 활용 니즈조사 — 설문 작성","b":"' + b64(raw) + '"}')

# 3) 사이드바 설문 링크 → 통합본에서는 내장 오버레이로 전환 (단일 파일 동작)
ANCHOR = '<a id="surveyLink" href="05_니즈조사/01_니즈조사_설문폼.html" target="_blank"'
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
""".replace("__ENTRIES__", "{" + ",".join(entries) + "}")

html = html.replace(
    "⚠ 화면 구성 데모 — 실제 API 미연결 상태이며, 모든 응답·수치는 예시 데이터입니다.",
    "⚠ 화면 구성 데모 (단일 파일 통합본 · 공유용) — 실제 API 미연결, 모든 응답·수치는 예시 데이터입니다. 부서 페이지 8종 + 니즈조사 설문 내장.")
html = html.replace("</body>", overlay + "\n</body>")
OUT.write_text(html, encoding="utf-8")
print(f"치환된 카드 버튼: {replaced}개 (10 기대)")
print(f"내장 콘텐츠 합계: {total/1024:.0f} KB (설문폼 포함 9종)")
print(f"통합본 크기: {OUT.stat().st_size/1024:.0f} KB -> {OUT.name}")
