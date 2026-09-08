// app/lib/querybar.js — JEIL_AX 표준 조회 플랫폼 (바닐라 ESM, 의존성 0)
// 단일 출처: 조회플랫폼/조회플랫폼_가이드.md · 데모: 조회플랫폼/index.html
// 규칙: UI·기간 상태만 담당한다. 데이터 조회/집계는 onQuery 콜백에서 호출측이 처리한다.
//       (그리드 표준 app/lib/grid.js 와 같은 역할 분리 — CLAUDE.md §13.3 / §16)
//
// 사용:
//   import { createQueryBar } from "/app/lib/querybar.js";
//   const bar = createQueryBar("#qbar", {
//     years:[2026,2025], year:2026, months:[1,2,3,4,5,6], monthLabels:{6:"6월(진행)"},
//     asOf:"2026-06-12", basis:"매출/수금 확정(S_BILL)", mode:"mock",
//     onQuery: async (q, ctx) => { /* q.year, q.month, q.ym, q.from, q.to, q.extras */ }
//   });

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad2 = (n) => String(n).padStart(2, "0");
const lastDay = (y, m) => new Date(y, m, 0).getDate();

export function createQueryBar(container, options = {}) {
  const root = typeof container === "string" ? document.querySelector(container) : container;
  if (!root) throw new Error("createQueryBar: container를 찾을 수 없습니다 — " + container);

  const now = new Date();
  const o = Object.assign({
    // 기간 축
    years: null,                 // [2026,2025] · null 이면 year 한 개만
    year: now.getFullYear(),
    months: null,                // [1..12] · false 면 기간 축 자체를 감춤(검색형 화면)
    month: null,                 // null = 연간(전체)
    monthLabels: {},             // {6:"6월(진행)"}
    allowAll: true,              // "연간(전체)" 옵션
    quick: true,                 // 당월·전월·연간 칩
    // 기준 표시
    asOf: null,                  // 기준일 "2026-06-12"
    basis: null,                 // "확정 전표 기준(A_GL · CONF_FG=1)"
    mode: null,                  // "live" | "mock" | null
    modeLabel: null,             // 배지 문구 재정의
    // 추가 조회조건 슬롯
    extras: [],                  // [{id,label,type:'text'|'select'|'date'|'checkbox',options,value,placeholder,width}]
    reset: false,                // "조건 초기화" 링크
    // 동작
    refreshLabel: "새로고침",
    autoRefreshSec: 0,           // 0 = 사용 안 함
    urlSync: true,
    persist: (typeof window !== "undefined" && window.PAGE_KEY) || null,
    scope: null,                 // data-m 자동 강조 대상 루트(기본 document)
    autoApply: true,             // data-m / data-qbar-period 자동 반영
    runOnInit: true,
    onQuery: null,
  }, options);

  const hasPeriod = o.months !== false;
  const years = (o.years && o.years.length) ? o.years.slice() : [o.year];
  let months = (o.months && o.months.length) ? o.months.slice() : (hasPeriod ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : []);

  const state = {
    year: Number(o.year), month: (o.month == null ? null : Number(o.month)),
    extras: {}, loading: false, stampAt: null, err: null,
  };
  o.extras.forEach((x) => { state.extras[x.id] = x.value != null ? x.value : (x.type === "checkbox" ? false : ""); });

  /* ---------- 상태 복원: URL > localStorage > options ---------- */
  const LS_KEY = o.persist ? "qbar:" + o.persist : null;
  function restore() {
    let src = null;
    if (LS_KEY) { try { src = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch (e) { src = null; } }
    if (src) {
      if (years.includes(Number(src.year))) state.year = Number(src.year);
      if (src.month == null || months.includes(Number(src.month))) state.month = src.month == null ? null : Number(src.month);
      if (src.extras) for (const k of Object.keys(state.extras)) if (k in src.extras) state.extras[k] = src.extras[k];
    }
    if (!o.urlSync) return;
    const p = new URLSearchParams(location.search);
    if (p.has("y") && years.includes(Number(p.get("y")))) state.year = Number(p.get("y"));
    if (p.has("m")) {
      const v = p.get("m");
      if (v === "" || v === "all") state.month = null;
      else if (months.includes(Number(v))) state.month = Number(v);
    }
    for (const x of o.extras) {
      if (!p.has(x.id)) continue;
      state.extras[x.id] = x.type === "checkbox" ? p.get(x.id) === "1" : p.get(x.id);
    }
  }
  function persist() {
    if (LS_KEY) { try { localStorage.setItem(LS_KEY, JSON.stringify({ year: state.year, month: state.month, extras: state.extras })); } catch (e) {} }
    if (!o.urlSync) return;
    const u = new URL(location.href);
    if (hasPeriod) {
      u.searchParams.set("y", state.year);
      if (state.month == null) u.searchParams.delete("m"); else u.searchParams.set("m", state.month);
    }
    for (const x of o.extras) {
      const v = state.extras[x.id];
      const empty = x.type === "checkbox" ? !v : !String(v || "").length;
      if (empty) u.searchParams.delete(x.id);
      else u.searchParams.set(x.id, x.type === "checkbox" ? "1" : v);
    }
    try { history.replaceState(null, "", u.pathname + (u.search ? u.search : "") + u.hash); } catch (e) {}
  }
  restore();

  /* ---------- 조회 조건 값 ---------- */
  function periodLabel() {
    if (!hasPeriod) return "";
    return state.month == null ? state.year + "년 연간" : state.year + "년 " + state.month + "월";
  }
  function value() {
    const y = state.year, m = state.month;
    const from = !hasPeriod ? null : (m == null ? y + "-01-01" : y + "-" + pad2(m) + "-01");
    const to = !hasPeriod ? null : (m == null ? y + "-12-31" : y + "-" + pad2(m) + "-" + pad2(lastDay(y, m)));
    return {
      year: y, month: m,
      ym: (!hasPeriod || m == null) ? null : y + "-" + pad2(m),
      from, to, label: periodLabel(),
      extras: Object.assign({}, state.extras),
    };
  }

  /* ---------- 마크업 ---------- */
  const monthOptions = () => {
    const head = o.allowAll ? '<option value="">연간(전체)</option>' : "";
    return head + months.map((m) => '<option value="' + m + '">' + esc(o.monthLabels[m] || (m + "월")) + "</option>").join("");
  };
  const extraField = (x) => {
    const w = x.width ? ' style="min-width:' + esc(x.width) + '"' : "";
    if (x.type === "checkbox") {
      return '<label class="qbar__grp" style="cursor:pointer" title="' + esc(x.title || "") + '">'
        + '<input type="checkbox" class="qbar__x" data-x="' + esc(x.id) + '">'
        + '<span class="qbar__lb" style="font-weight:600">' + esc(x.label) + "</span></label>";
    }
    let field;
    if (x.type === "select") {
      field = '<select class="qbar__sel qbar__x" data-x="' + esc(x.id) + '"' + w + ">"
        + (x.options || []).map((op) => {
          const v = (op && typeof op === "object") ? op.value : op;
          const l = (op && typeof op === "object") ? op.label : op;
          return '<option value="' + esc(v) + '">' + esc(l) + "</option>";
        }).join("") + "</select>";
    } else {
      field = '<input type="' + (x.type === "date" ? "date" : "text") + '" class="qbar__inp qbar__x" data-x="' + esc(x.id) + '"'
        + (x.placeholder ? ' placeholder="' + esc(x.placeholder) + '"' : "") + w + ">";
    }
    return '<div class="qbar__grp"><span class="qbar__lb">' + esc(x.label) + "</span>" + field + "</div>";
  };

  const badge = (() => {
    if (!o.mode) return "";
    const cls = o.mode === "live" ? "live" : "mock";
    const txt = o.modeLabel || (o.mode === "live" ? "ERP 실데이터" : "목업 데이터");
    return '<span class="qbar__badge qbar__badge--' + cls + '">' + esc(txt) + "</span>";
  })();

  root.classList.add("qbar");
  root.setAttribute("role", "search");
  root.innerHTML =
    (hasPeriod
      ? '<div class="qbar__grp"><span class="qbar__lb">기간</span>'
      + '<select class="qbar__sel" id="qbY" aria-label="조회 연도">'
      + years.map((y) => '<option value="' + y + '">' + y + "년</option>").join("")
      + "</select>"
      + '<select class="qbar__sel" id="qbM" aria-label="조회 월">' + monthOptions() + "</select></div>"
      : "")
    + (hasPeriod && o.quick
      ? '<div class="qbar__chips" id="qbQuick">'
      + '<button type="button" class="qbar__chip" data-q="cur">당월</button>'
      + '<button type="button" class="qbar__chip" data-q="prev">전월</button>'
      + '<button type="button" class="qbar__chip" data-q="all">연간</button></div>'
      : "")
    + o.extras.map(extraField).join("")
    + (o.reset ? '<button type="button" class="qbar__reset" id="qbReset">조건 초기화</button>' : "")
    + '<span class="qbar__sp"></span>'
    + '<span class="qbar__meta" id="qbMeta"></span>'
    + '<button type="button" class="qbar__btn" id="qbRefresh" title="현재 조건으로 다시 조회합니다">'
    + '<span class="qbar__ic">🔄</span><span>' + esc(o.refreshLabel) + "</span></button>"
    + '<span class="qbar__stamp" id="qbStamp"></span>'
    + '<div class="qbar__err" id="qbErr" hidden></div>';

  const $ = (id) => root.querySelector("#" + id);
  const elY = $("qbY"), elM = $("qbM"), elMeta = $("qbMeta"), elStamp = $("qbStamp"),
    elBtn = $("qbRefresh"), elErr = $("qbErr");

  /* ---------- 표시 갱신 ---------- */
  function relTime(d) {
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 10) return "방금 전";
    if (s < 60) return s + "초 전";
    if (s < 3600) return Math.floor(s / 60) + "분 전";
    return Math.floor(s / 3600) + "시간 전";
  }
  function paintMeta() {
    const bits = [];
    if (o.asOf) bits.push("기준일 <b>" + esc(o.asOf) + "</b>");
    if (o.basis) bits.push(esc(o.basis));
    elMeta.innerHTML = bits.join(" · ") + badge;
  }
  function paintStamp() {
    if (!state.stampAt) { elStamp.textContent = ""; return; }
    const t = state.stampAt;
    elStamp.innerHTML = "최종 조회 <b>" + pad2(t.getHours()) + ":" + pad2(t.getMinutes()) + ":" + pad2(t.getSeconds())
      + "</b> (" + relTime(t) + ")";
  }
  // "당월" = 기준일(asOf)의 월. 기준일이 없으면 오늘. 데이터에 없는 월이면 가장 늦은 월.
  function curMonth() {
    if (!months.length) return null;
    const base = o.asOf ? new Date(o.asOf + "T00:00:00") : new Date();
    let m = (base.getFullYear() === state.year) ? base.getMonth() + 1 : months[months.length - 1];
    if (!months.includes(m)) m = months[months.length - 1];
    return m;
  }
  function paintControls() {
    if (elY) elY.value = String(state.year);
    if (elM) elM.value = state.month == null ? "" : String(state.month);
    root.querySelectorAll(".qbar__x").forEach((el) => {
      const k = el.dataset.x;
      if (el.type === "checkbox") el.checked = !!state.extras[k]; else el.value = state.extras[k] ?? "";
    });
    const quick = root.querySelector("#qbQuick");
    if (quick) {
      const cur = curMonth(), prev = (cur && cur > 1) ? cur - 1 : null;
      quick.querySelectorAll(".qbar__chip").forEach((c) => {
        const q = c.dataset.q;
        const on = (q === "all" && state.month == null)
          || (q === "cur" && state.month === cur)
          || (q === "prev" && prev != null && state.month === prev);
        c.setAttribute("aria-pressed", on ? "true" : "false");
        if (q === "prev") c.disabled = (prev == null);
      });
    }
  }

  /* ---------- data-m 자동 강조 ---------- */
  function applyPeriod() {
    if (!o.autoApply) return;
    const sc = (typeof o.scope === "string" ? document.querySelector(o.scope) : o.scope) || document;
    sc.querySelectorAll("[data-qbar-period]").forEach((el) => { el.textContent = periodLabel(); });
    if (o.asOf) sc.querySelectorAll("[data-qbar-asof]").forEach((el) => { el.textContent = o.asOf; });
    sc.querySelectorAll("[data-m]").forEach((el) => {
      el.classList.remove("qbar-on", "qbar-dim", "qbar-hide");
      if (state.month == null) return;
      const list = String(el.dataset.m).split(",").map((v) => Number(v.trim()));
      if (list.includes(state.month)) { el.classList.add("qbar-on"); return; }
      const holder = el.closest("[data-m-off]");
      el.classList.add((holder && holder.dataset.mOff) === "hide" ? "qbar-hide" : "qbar-dim");
    });
    // 행을 숨기는 그룹에서 남는 행이 없으면 [data-m-empty] 안내를 대신 보여준다(빈 표 방지)
    sc.querySelectorAll('[data-m-off="hide"]').forEach((g) => {
      const empty = g.querySelector("[data-m-empty]");
      if (!empty) return;
      const gone = state.month != null
        && [...g.querySelectorAll("[data-m]")].every((el) => el.classList.contains("qbar-hide"));
      empty.classList.toggle("qbar-hide", !gone);
    });
  }

  /* ---------- 조회 실행 ---------- */
  let seq = 0;
  async function run(reason) {
    persist(); paintControls(); applyPeriod();
    if (typeof o.onQuery !== "function") { state.stampAt = new Date(); paintStamp(); return; }
    const my = ++seq;
    setLoading(true); setError(null);
    try {
      await o.onQuery(value(), { reason, bar: api });
      if (my !== seq) return;                 // 더 늦은 조회가 이미 시작됨 → 결과 버림
      state.stampAt = new Date(); paintStamp();
    } catch (e) {
      if (my !== seq) return;
      setError((e && e.message) || "조회 중 오류가 발생했습니다.");
    } finally {
      if (my === seq) setLoading(false);
    }
  }
  function setLoading(on) {
    state.loading = !!on;
    elBtn.disabled = !!on;
    root.querySelectorAll(".qbar__sel, .qbar__inp").forEach((el) => { el.disabled = !!on; });
  }
  function setError(msg) {
    state.err = msg || null;
    elErr.hidden = !msg;
    elErr.textContent = msg || "";
  }

  /* ---------- 이벤트 ---------- */
  if (elY) elY.onchange = () => { state.year = Number(elY.value); state.month = null; run("change"); };
  if (elM) elM.onchange = () => { state.month = elM.value === "" ? null : Number(elM.value); run("change"); };
  const quickEl = root.querySelector("#qbQuick");
  if (quickEl) quickEl.onclick = (e) => {
    const b = e.target.closest(".qbar__chip"); if (!b || b.disabled) return;
    const cur = curMonth();
    state.month = b.dataset.q === "all" ? null : (b.dataset.q === "cur" ? cur : (cur > 1 ? cur - 1 : null));
    run("quick");
  };
  root.querySelectorAll(".qbar__x").forEach((el) => {
    const k = el.dataset.x;
    const spec = o.extras.find((x) => x.id === k) || {};
    const fire = () => { state.extras[k] = (el.type === "checkbox") ? el.checked : el.value; run("change"); };
    if (el.tagName === "INPUT" && el.type === "text") {
      let t = null;
      el.oninput = () => { clearTimeout(t); t = setTimeout(fire, spec.debounce != null ? spec.debounce : 300); };
      el.onchange = fire;
    } else el.onchange = fire;
  });
  const elReset = root.querySelector("#qbReset");
  if (elReset) elReset.onclick = () => {
    state.month = null;
    o.extras.forEach((x) => { state.extras[x.id] = x.value != null ? x.value : (x.type === "checkbox" ? false : ""); });
    run("change");
  };
  elBtn.onclick = () => run("refresh");

  const tick = setInterval(paintStamp, 30000);
  let autoT = null;
  if (o.autoRefreshSec > 0) autoT = setInterval(() => { if (!document.hidden && !state.loading) run("auto"); }, o.autoRefreshSec * 1000);

  /* ---------- 공개 API ---------- */
  const api = {
    el: root,
    value, get loading() { return state.loading; },
    refresh: () => run("refresh"),
    setLoading, setError,
    setMonths(list, labels) {
      months = (list || []).slice();
      if (labels) Object.assign(o.monthLabels, labels);
      if (state.month != null && !months.includes(state.month)) state.month = null;
      if (elM) elM.innerHTML = monthOptions();
      paintControls();
    },
    // 조회 가능한 연도가 서버 응답으로 정해지는 화면(실연계)에서 첫 조회 뒤에 목록을 채운다.
    setYears(list) {
      const arr = (list || []).map(Number).filter((n) => Number.isFinite(n));
      if (!arr.length) return;
      years.length = 0; years.push(...arr);
      if (o.urlSync) {                       // 이제 유효해진 URL 연도를 뒤늦게 받아준다
        const p = new URLSearchParams(location.search);
        if (p.has("y") && years.includes(Number(p.get("y")))) state.year = Number(p.get("y"));
      }
      if (!years.includes(state.year)) state.year = years[0];
      if (elY) elY.innerHTML = years.map((y) => '<option value="' + y + '">' + y + "년</option>").join("");
      paintControls();
    },
    setMeta(m = {}) {
      if ("asOf" in m) o.asOf = m.asOf;
      if ("basis" in m) o.basis = m.basis;
      paintMeta(); applyPeriod();
    },
    setPeriod(year, month, silent) {
      if (year != null) state.year = Number(year);
      state.month = (month == null) ? null : Number(month);
      if (silent) { persist(); paintControls(); applyPeriod(); } else run("change");
    },
    applyPeriod,
    destroy() { clearInterval(tick); if (autoT) clearInterval(autoT); root.innerHTML = ""; root.classList.remove("qbar"); },
  };

  paintMeta(); paintControls(); applyPeriod(); paintStamp();
  if (o.runOnInit) run("init");
  return api;
}

/**
 * data-m 으로 표시해 둔 월별 요소에서 화면에 이미 그려진 수치를 읽어 { 월: "문자열" } 로 돌려준다.
 * 목업 화면이 "화면에 있는 값"만으로 기간별 KPI 를 다시 계산하게 해서, 숫자를 스크립트에 중복 기입하지 않게 한다.
 * ERP 실연계로 바뀌면 이 함수 대신 API 응답을 쓰면 된다.
 *   const S = readMonthSeries("#mChart");   // {1:"2.2", 2:"24.1", …}
 */
export function readMonthSeries(container, valueSelector = ".val") {
  const root = typeof container === "string" ? document.querySelector(container) : container;
  const out = {};
  if (!root) return out;
  root.querySelectorAll("[data-m]").forEach((el) => {
    const v = valueSelector ? el.querySelector(valueSelector) : el;
    if (!v) return;
    String(el.dataset.m).split(",").forEach((m) => { out[Number(m.trim())] = v.textContent.trim(); });
  });
  return out;
}

/** "1,284" · "+430" · "−118" 같은 표시 문자열에서 첫 숫자를 뽑는다. 숫자가 없으면 0.
 *  화면에는 유니코드 마이너스(−)·en dash 가 쓰이므로 ASCII 하이픈으로 정규화한 뒤 읽는다. */
export function numOf(s) {
  const m = String(s ?? "").replace(/,/g, "").replace(/[−–—]/g, "-").match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

export default createQueryBar;
