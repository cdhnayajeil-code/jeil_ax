// _test_regulation_page.mjs — 사내규정 조회 화면(pages/전사_사내규정_조회_2026.html) 렌더 회귀 (REQ-0124)
//
// 실행:  node _test_regulation_page.mjs
//
// 무엇을 지키려는 테스트인가 — jsdom 없이 최소 DOM 목, 검사 대상 JS 는 화면 파일에서 런타임에 꺼낸다(_test_model_tab.mjs 방식).
//   ① 본문·제목·파일명·사유에 <script>·따옴표가 있어도 esc 되어 그대로 나오지 않는다
//   ② 검색어 강조가 <mark> 로 감싸고, 정규식 특수문자를 넣어도 예외 없이·엔티티를 깨지 않는다
//   ③ ?reg=&art= 로 열면 regGet 이 불리고 #art-<n> 에 scroll/focus 가 간다
//   ④ 검색어 1글자면 regSearch 호출 0회·안내 문구
//   ⑤ regStatus forbidden → 게이트 문구 · regList 예외 → 오류 문구
//   ⑥ 지연 배너: as_of 가 48시간을 넘거나 last_fail_at > as_of 일 때만 .notice.warn
//   ⑦ is_admin 없으면 #adminBox 숨김, 있으면 #unreadGrid.setRows 호출
//   ⑧ 첨부 unreadable 행에 사유 title
//   ⑨ URL 동기화(history.replaceState 목)에 q/reg/art 반영
//   ⑩ 늦게 끝난 이전 검색 결과는 버려진다(reqSeq)
//   ⑪ CSV 내보내기는 표준 그리드가 맡는다 — 화면 자체 CSV 코드(Blob·download)가 없다
//   ⑫ 조회바는 months:false · 기준일은 setMeta 로만(머리에 기준일을 다시 쓰지 않는다)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const HTML = join(ROOT, "pages", "전사_사내규정_조회_2026.html");
let failed = 0;
const fail = (m) => { console.error("✘ " + m); failed++; };
const ok = (c, m) => { if (!c) fail(m); };
const src = readFileSync(HTML, "utf8");

/* ── 0. 정적 검사 ───────────────────────────────────────────────────── */
ok(src.includes("window.PAGE_KEY='regulation_lookup'"), "PAGE_KEY 가 regulation_lookup 이 아닙니다");
ok(src.includes('src="/pages/_access-gate.js"'), "접근 게이트 로더(루트 절대경로)가 없습니다");
ok(src.includes('href="/app/lib/querybar.css"') && src.includes('href="/app/lib/grid.css"'), "querybar.css·grid.css 루트 절대경로 링크가 없습니다");
ok(!/_local_links\.js/.test(src), "운영 화면에는 _local_links 로더를 넣지 않는다");
ok(!/new Blob\(|\.download\s*=/.test(src), "⑪ 화면 자체 CSV 코드가 있다 — 내보내기는 표준 그리드(exportCsv)가 맡는다");
ok(/months:\s*false/.test(src), "⑫ 조회바 months:false 가 아니다");
ok(!/<div class="head">[\s\S]*?기준일[\s\S]*?<\/div>\s*<\/div>/.test(src.split('id="qbar"')[0]), "⑫ 머리에 기준일을 다시 쓰지 않는다");
for (const id of ["qbar", "status", "fQ", "fCat", "btnSearch", "btnReset", "regGrid", "hitGrid", "hitNote", "viewer", "adminBox", "unreadGrid", "cntList", "cntHits", "tabs", "listCard", "toTop", "examples", "admSources", "admUnreadCnt"]) {
  if (!src.includes(`id="${id}"`)) fail(`화면에 id="${id}" 가 없습니다.`);
}

/* ── 1. 모듈 스크립트 추출 · import 를 스텁으로 ───────────────────────── */
const m = src.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) { console.error("✘ 모듈 스크립트를 찾지 못했습니다."); process.exit(1); }
const code = m[1].replace(/^\s*import .*?;\s*$/gm, "");

/* ── 2. 최소 DOM ───────────────────────────────────────────────────── */
const els = new Map();
class El {
  constructor(id, extra = {}) {
    this.id = id; this.innerHTML = ""; this.textContent = ""; this.value = ""; this.hidden = false; this.disabled = false;
    this.dataset = extra.dataset || {}; this.className = extra.className || ""; this.listeners = {}; this.focused = 0; this.scrolled = 0;
    const self = this;
    this.classList = {
      add: (c) => { if (!self.className.split(" ").includes(c)) self.className = (self.className + " " + c).trim(); },
      remove: (c) => { self.className = self.className.split(" ").filter((x) => x !== c).join(" "); },
      toggle: (c, on) => { if (on) self.classList.add(c); else self.classList.remove(c); },
      contains: (c) => self.className.split(" ").includes(c),
    };
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  fire(t, ev) { (this.listeners[t] || []).forEach((fn) => fn(ev)); if (t === "click" && this.onclick) this.onclick(ev); }
  focus() { this.focused++; }
  scrollIntoView() { this.scrolled++; }
  getAttribute(a) { return a === "href" ? this.href || null : null; }
  querySelectorAll(q) {
    if (q === "#tabs .tab" || q === ".tab") return TABS;
    return [];
  }
  querySelector(q) {
    // 뷰어 안 조문 찾기 — innerHTML 에 해당 id 가 있으면 가짜 article 을 돌려준다
    const mm = q.match(/^#(art-.+)$/);
    if (mm && this.innerHTML.includes('id="' + mm[1].replace(/\\(.)/g, "$1") + '"')) {
      const a = new El(mm[1]); ARTS.push(a); return a;
    }
    return null;
  }
}
const TABS = [new El("tabList", { dataset: { tab: "list" }, className: "tab on" }), new El("tabHits", { dataset: { tab: "hits" }, className: "tab" })];
const ARTS = [];
const document = {
  getElementById: (id) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); },
  querySelectorAll: (q) => (q === "#tabs .tab" ? TABS : []),
  querySelector: () => null,
};
const hist = { calls: [] };
const history = { replaceState: (a, b, url) => hist.calls.push(url) };
const location = { href: "https://ai.jeilm.co.kr/work/regulations", search: "", pathname: "/work/regulations", hash: "" };
const window = { innerWidth: 1400, PAGE_KEY: "regulation_lookup" };
const CSS = { escape: (s) => String(s).replace(/([^\w-])/g, "\\$1") };

/* ── 3. 라이브러리 스텁 ───────────────────────────────────────────── */
const GRIDS = {};
function createGrid(sel, opts) {
  const g = { sel, opts, rows: null, loading: null, setRows(r) { this.rows = r; }, setLoading(v) { this.loading = v; } };
  GRIDS[sel] = g; return g;
}
let BAR = null;
function createQueryBar(sel, opts) { BAR = { sel, opts, meta: null, setMeta(m) { this.meta = m; }, refresh() { return opts.onQuery({}, { reason: "refresh", bar: this }); } }; return BAR; }

const calls = { list: 0, status: 0, search: [], get: [] };
let FIX = null;
const erpApi = {
  async regList() { calls.list++; if (FIX.listThrow) throw new Error("boom <script>"); return FIX.list; },
  async regStatus() { calls.status++; return FIX.status; },
  async regSearch(q, limit) { calls.search.push(q); const r = FIX.search(q); return typeof r?.then === "function" ? r : r; },
  async regGet(key, o) { calls.get.push([key, o]); return FIX.get(key, o); },
};

/* ── 4. 화면 스크립트 실행 ────────────────────────────────────────── */
const run = new Function("erpApi", "createQueryBar", "createGrid", "document", "window", "location", "history", "CSS", code);
const ART5 = [
  { seq: 1, chapter: "제1장 총칙", section: null, article_no: "1", title: "목적", body: "이 규칙은 <b>직원</b> 복무를 정한다.", amended_tag: null, is_deleted: false },
  { seq: 2, chapter: "제1장 총칙", section: null, article_no: "2", title: "적용(범위)", body: "전 직원에게 적용한다. 연차(15일) 기준.", amended_tag: "<개정 2020.1.1>", is_deleted: false },
  { seq: 3, chapter: "부칙", section: null, article_no: "부칙-1", title: "시행일", body: "2024년 4월 1일부터 시행한다.", amended_tag: null, is_deleted: false },
];
const REG = { reg_key: "rules:취업규칙", name: "취업규칙 \"개정\"", category: "인사", enact_date: "2010-01-01", revise_date: "2024-03-01", effective_date: "2024-04-01",
  revision_no: 5, owner_dept: "인사팀", parse_status: "ok", text_source: "attachment:취업규칙.hwp", gw_url: "https://gw.example.invalid/view?id=1", board_key: "rules", board_label: "사내규정", post_no: "101", warnings: [] };
const baseFix = () => ({
  list: { allowed: true, as_of: "2026-10-08T06:40:00+09:00", count: 2, categories: ["인사", "총무"],
    rows: [Object.assign({ article_count: 3, attach_cnt: 2, unreadable_cnt: 1 }, REG), { reg_key: "rules:경조사", name: "경조사 지원 기준", category: "총무", effective_date: "2026-09-01", parse_status: "fallback", article_count: 1, attach_cnt: 0, unreadable_cnt: 0 }] },
  status: { ok: true, allowed: true, as_of: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), source_cnt: 1, post_cnt: 2, unreadable_cnt: 1, last_fail_at: null, is_admin: false },
  search: (q) => ({ allowed: true, terms: q.split(/\s+/), count: 1, rows: [{ reg_key: "rules:취업규칙", name: "취업규칙 \"개정\"", document_id: 1, seq: 2, article_no: "2", title: "적용(범위)", excerpt: "전 직원에게 적용한다. 연차(15일) 기준. <script>alert(1)</script>", effective_date: "2024-04-01", gw_url: REG.gw_url }] }),
  get: () => ({ allowed: true, found: true, reg: REG, toc: ART5.map((a) => ({ seq: a.seq, article_no: a.article_no, title: a.title, chapter: a.chapter, is_deleted: false })),
    attachments: [{ seq: 1, file_name: "취업규칙.hwp", ext: ".hwp", size_bytes: 123456, text_status: "readable", text_reason: null, is_article_source: true },
                  { seq: 2, file_name: "스캔\"본.pdf", ext: ".pdf", size_bytes: 9999, text_status: "unreadable", text_reason: "글자가 없음(스캔본·빈 문서)", is_article_source: false }],
    articles: ART5, total_articles: 3, next_seq: null }),
});

async function boot(fix, searchParams = "") {
  for (const k of [...els.keys()]) els.delete(k);
  ARTS.length = 0; hist.calls.length = 0; calls.list = calls.status = 0; calls.search.length = 0; calls.get.length = 0;
  FIX = fix; location.search = searchParams;
  run(erpApi, createQueryBar, createGrid, document, window, location, history, CSS);
  await BAR.opts.onQuery({}, { reason: "init", bar: BAR });
  await new Promise((r) => setTimeout(r, 0));
}
const $ = (id) => document.getElementById(id);

/* ── 테스트 ① ⑥ ⑦ ⑧ ⑫ 정상 로드 ───────────────────────────────── */
await boot(baseFix());
ok(GRIDS["#regGrid"] && Array.isArray(GRIDS["#regGrid"].rows) && GRIDS["#regGrid"].rows.length === 2, "규정 목록 그리드에 2행이 들어가지 않았습니다");
ok($("cntList").textContent === "2", "목록 건수 배지가 2 가 아닙니다: " + $("cntList").textContent);
ok(BAR.meta && BAR.meta.asOf && /^\d{4}-\d{2}-\d{2}$/.test(BAR.meta.asOf), "⑫ 기준일이 setMeta 로 들어가지 않았습니다");
ok($("fCat").innerHTML.includes("인사") && $("fCat").innerHTML.includes("총무"), "분류 선택지가 데이터에서 채워지지 않았습니다");
ok(!/notice warn/.test($("status").innerHTML), "⑥ 2시간 전 수집인데 지연 배너가 떴습니다");
ok(/첨부 <b>1건<\/b>/.test($("status").innerHTML), "판독 불가 안내가 없습니다");
ok($("adminBox").hidden === true, "⑦ 관리자가 아닌데 adminBox 가 보입니다");

/* ── ④ 1글자 검색 ───────────────────────────────────────────────── */
$("fQ").value = "연";
$("btnSearch").fire("click");
await new Promise((r) => setTimeout(r, 0));
ok(calls.search.length === 0, "④ 1글자인데 regSearch 가 불렸습니다");
ok($("hitNote").hidden === false && /두 글자 이상/.test($("hitNote").textContent), "④ 1글자 안내 문구가 없습니다");

/* ── ② ① 검색 강조·esc ─────────────────────────────────────────── */
$("fQ").value = "연차 (15";
$("btnSearch").fire("click");
await new Promise((r) => setTimeout(r, 5));
ok(calls.search.length === 1 && calls.search[0] === "연차 (15", "② 검색어가 그대로 전달되지 않았습니다");
const hit = GRIDS["#hitGrid"];
ok(hit && hit.rows && hit.rows.length === 1, "검색 결과 그리드에 1행이 없습니다");
const exCol = hit.opts.columns.find((c) => c.key === "excerpt");
const exHtml = exCol.formatter(hit.rows[0].excerpt, hit.rows[0]);
ok(exHtml.includes("<mark>연차</mark>") && exHtml.includes("<mark>(15</mark>"), "② 발췌 강조(정규식 특수문자 포함)가 없습니다: " + exHtml);
ok(!exHtml.includes("<script>") && exHtml.includes("&lt;script&gt;"), "① 발췌의 <script> 가 esc 되지 않았습니다");
ok($("cntHits").textContent === "1", "검색 건수 배지가 1 이 아닙니다");
ok(hist.calls.some((u) => /[?&]q=%EC%97%B0%EC%B0%A8/.test(u) || /q=연차/.test(decodeURIComponent(u))), "⑨ 주소에 q 가 반영되지 않았습니다: " + hist.calls.join(","));
ok(TABS[1].className.includes("on"), "검색 뒤 「검색 결과」 탭이 켜지지 않았습니다");

/* ── ③ ⑧ 규정 열기(조문 지정) ────────────────────────────────────── */
hit.opts.onRowAction("open", hit.rows[0]);
await new Promise((r) => setTimeout(r, 5));
ok(calls.get.length === 1 && calls.get[0][0] === "rules:취업규칙", "③ regGet 이 불리지 않았습니다");
const vh = $("viewer").innerHTML;
ok(vh.includes("취업규칙 &quot;개정&quot;") && !vh.includes('취업규칙 "개정"'), "① 규정명 따옴표가 esc 되지 않았습니다");
ok(vh.includes("&lt;b&gt;직원&lt;/b&gt;") && !vh.includes("<b>직원</b>"), "① 조문 본문의 태그가 esc 되지 않았습니다");
ok(vh.includes('id="art-2"') && vh.includes('id="art-부칙-1"'), "조문 article id 가 없습니다");
ok(vh.includes("<mark>연차</mark>"), "② 열린 규정 본문에도 검색어 강조가 없습니다");
ok(vh.includes('title="글자가 없음(스캔본·빈 문서)"') && vh.includes("판독 불가"), "⑧ unreadable 첨부에 사유 title 이 없습니다");
ok(vh.includes("스캔&quot;본.pdf"), "① 첨부 파일명 따옴표가 esc 되지 않았습니다");
ok(vh.includes('href="https://gw.example.invalid/view?id=1"') && vh.includes("그룹웨어 원본 보기"), "https 원본 링크가 없습니다");
ok(vh.includes("&lt;개정 2020.1.1&gt;"), "개정 꼬리표 배지가 esc 되어 보이지 않습니다");
ok(vh.includes("목차 (3개 조문)"), "목차가 없습니다");
ok(ARTS.length === 1 && ARTS[0].id === "art-2" && ARTS[0].scrolled === 1 && ARTS[0].focused === 1, "③ 지정 조문으로 scroll/focus 가 가지 않았습니다");
ok(hist.calls.some((u) => decodeURIComponent(u).includes("reg=rules:취업규칙") && decodeURIComponent(u).includes("art=2")), "⑨ 주소에 reg/art 가 반영되지 않았습니다");

/* ── 비-https 원본은 문자 표기 ───────────────────────────────────── */
{
  const fix = baseFix();
  const reg2 = Object.assign({}, REG, { gw_url: "http://intranet.local/view?id=1" });
  fix.get = () => Object.assign(baseFix().get(), { reg: reg2 });
  await boot(fix, "?reg=rules%3A%EC%B7%A8%EC%97%85%EA%B7%9C%EC%B9%99&art=1");
  ok(calls.get.length === 1, "③ ?reg= 딥링크로 regGet 이 불리지 않았습니다");
  const v2 = $("viewer").innerHTML;
  ok(!v2.includes('href="http://intranet.local'), "비-https 원본이 링크로 그려졌습니다");
  ok(v2.includes("게시물 #101"), "비-https 원본의 문자 표기가 없습니다");
  ok(ARTS.some((a) => a.id === "art-1" && a.focused === 1), "③ ?art=1 조문에 focus 가 가지 않았습니다");
}

/* ── ⑤ forbidden · 예외 ──────────────────────────────────────────── */
{
  const fix = baseFix(); fix.status = { ok: false, forbidden: true };
  await boot(fix);
  ok(/열람 권한이 필요합니다/.test($("viewer").innerHTML), "⑤ forbidden 게이트 문구가 없습니다");
  const fix2 = baseFix(); fix2.listThrow = true;
  await boot(fix2);
  ok(/조회하지 못했습니다/.test($("viewer").innerHTML) && $("viewer").innerHTML.includes("&lt;script&gt;"), "⑤ regList 예외 문구·esc 가 없습니다");
}

/* ── ⑥ 지연 배너 ─────────────────────────────────────────────────── */
{
  const fix = baseFix(); fix.status.as_of = new Date(Date.now() - 60 * 3600 * 1000).toISOString();
  await boot(fix);
  ok(/notice warn/.test($("status").innerHTML) && /48시간/.test($("status").innerHTML), "⑥ 60시간 전 수집인데 지연 배너가 없습니다");
  const fix2 = baseFix(); fix2.status.last_fail_at = new Date().toISOString();
  await boot(fix2);
  ok(/notice warn/.test($("status").innerHTML) && /수집 실패/.test($("status").innerHTML), "⑥ as_of 뒤 실패인데 배너가 없습니다");
  const fix3 = baseFix(); fix3.status.source_cnt = 0;
  await boot(fix3);
  ok(/게시판이 아직 등록되지/.test($("status").innerHTML), "⑥ 게시판 0건 안내가 없습니다");
}

/* ── ⑦ 관리자 ────────────────────────────────────────────────────── */
{
  const fix = baseFix();
  fix.status = Object.assign(fix.status, { is_admin: true,
    sources: [{ board_key: "rules", label_ko: "사내규정", active: true, post_cnt: 2, last_collected_at: fix.status.as_of, last_result: { mode: "nightly", new: 0, changed: 1, unchanged: 1, complete: true, errors: ["rules:9 <x>"] } }],
    unreadable: [{ reg_name: "취업규칙", board_key: "rules", post_no: "101", file_name: "스캔본.pdf", ext: ".pdf", size_bytes: 9999, text_status: "unreadable", text_reason: "글자가 없음" }] });
  await boot(fix);
  ok($("adminBox").hidden === false, "⑦ 관리자인데 adminBox 가 숨겨져 있습니다");
  ok(GRIDS["#unreadGrid"].rows && GRIDS["#unreadGrid"].rows.length === 1, "⑦ unreadGrid.setRows 가 불리지 않았습니다");
  ok($("admSources").innerHTML.includes("&lt;x&gt;") && !$("admSources").innerHTML.includes("<x>"), "① 관리자 오류 문구가 esc 되지 않았습니다");
}

/* ── ⑩ 늦게 끝난 이전 검색은 버린다 ────────────────────────────── */
{
  const fix = baseFix();
  let release;
  const slow = new Promise((r) => { release = r; });
  fix.search = (q) => (q === "느림" ? slow.then(() => ({ allowed: true, terms: ["느림"], count: 1, rows: [{ reg_key: "x", name: "느린결과", seq: 1, article_no: "1", title: "", excerpt: "느림", effective_date: null }] }))
                                  : { allowed: true, terms: ["빠름"], count: 1, rows: [{ reg_key: "y", name: "빠른결과", seq: 1, article_no: "1", title: "", excerpt: "빠름", effective_date: null }] });
  await boot(fix);
  $("fQ").value = "느림"; $("btnSearch").fire("click");
  $("fQ").value = "빠름"; $("btnSearch").fire("click");
  await new Promise((r) => setTimeout(r, 5));
  release();
  await new Promise((r) => setTimeout(r, 5));
  ok(GRIDS["#hitGrid"].rows.length === 1 && GRIDS["#hitGrid"].rows[0].name === "빠른결과", "⑩ 늦게 끝난 이전 검색 결과가 화면을 덮었습니다");
}

if (failed) { console.error(`\n${failed}건 실패`); process.exit(1); }
console.log("✔ 사내규정 조회 화면 회귀 통과 (① esc · ② 강조 · ③ 딥링크 · ④ 1글자 · ⑤ 게이트 · ⑥ 배너 · ⑦ 관리자 · ⑧ 사유 · ⑨ URL · ⑩ reqSeq · ⑪ CSV · ⑫ 조회바)");
