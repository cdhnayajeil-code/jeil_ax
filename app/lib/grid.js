// app/lib/grid.js — JEIL_AX 표준 편집 그리드 (바닐라 ESM, 의존성 0)
// 단일 출처: 그리드/표준그리드_가이드.md · 데모: 그리드/index.html
// 규칙: UI만 담당한다. 데이터 조회/저장은 콜백(onSave/onBulkAction/onRowAction)으로 호출측이 처리.
//
// 사용:
//   import { createGrid } from "./lib/grid.js";
//   const grid = createGrid("#myGrid", { columns:[...], rows:[...], keyField:"id",
//     selectable:true, search:true, columnFilter:true, editable:true, editToggle:true,
//     paste:true, exportCsv:true, copy:true,
//     bulkActions:[{ id:"issue", label:"💾 일괄 발급", btnClass:"ok" }],
//     onBulkAction:(id, g)=>{...}, onRowAction:(act, row)=>{...}, onSave:(changes)=>{...} });

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || "").trim());
const norm = (s) => String(s ?? "").toLowerCase();

export function createGrid(container, options = {}) {
  const root = typeof container === "string" ? document.querySelector(container) : container;
  if (!root) throw new Error("createGrid: container를 찾을 수 없습니다 — " + container);

  const o = Object.assign({
    columns: [], rows: [], keyField: null,
    selectable: false, search: false, columnFilter: false, sortable: true,
    editable: false, editToggle: false,
    editToggleLabels: { off: "📋 일괄 편집", on: "✏️ 편집 중" },
    paste: false, exportCsv: false, copy: false, exportName: "grid",
    stickyHeader: true, keyboardNav: true, pageSize: 0,
    emptyText: "데이터가 없습니다.", loadingText: "불러오는 중…",
    rowClass: null, bulkActions: [],
    /* 넓은 목록용(전부 옵트인 — 켜지 않으면 동작이 종전과 같다) */
    resizable: false,        // 열 경계를 끌어 폭 조절 + 더블클릭 초기화
    fitWidth: false,         // setFit() 로 화면 폭에 맞추기(폭 지정 모드가 같이 켜진다)
    cellNav: false,          // 방향키 셀 커서 이동
    defaultColWidth: 120, minColWidth: 46,
    onSave: null, onSelectionChange: null, onBulkAction: null,
    onRowAction: null, onCellEdit: null, onPaste: null,
    onColResize: null,       // (key, px, allWidths) — 저장은 호출측이 한다(grid 는 저장소를 모른다)
    onCellActivate: null,    // (row, col) — 셀 커서에서 Enter
  }, options);

  const cols = o.columns;
  const keyOf = (row, i) => (o.keyField ? row[o.keyField] : (row.__k != null ? row.__k : i));

  const state = {
    rows: [], view: [], selected: new Set(), dirty: new Map(),
    sort: { key: null, dir: 1 }, filters: {}, query: "",
    editMode: o.editable && !o.editToggle, loading: false, errors: new Map(),
    colW: {},          // 지금 그리는 폭 — 화면맞춤이 덮어쓴다
    userW: {},         // 사람이 끌어서 정한 폭 — 맞춤을 끄면 이쪽으로 돌아온다
    fit: false,        // 화면맞춤 켜짐
    cur: null,         // 셀 커서 { key, col }
  };

  // 행에 안정적 내부 키 부여(keyField 없을 때)
  function ingest(rows) {
    state.rows = (rows || []).map((r, i) => { if (o.keyField == null && r.__k == null) r = Object.assign({ __k: i }, r); return r; });
    state.dirty.clear(); state.errors.clear();
    computeView();
  }
  ingest(o.rows);

  /* ---------- view: 검색 + 컬럼필터 + 정렬 ---------- */
  function computeView() {
    let v = state.rows.slice();
    const q = norm(state.query);
    if (q) v = v.filter((r) => cols.some((c) => norm(r[c.key]).includes(q)));
    for (const [k, val] of Object.entries(state.filters)) {
      if (!val) continue; const fv = norm(val);
      v = v.filter((r) => norm(r[k]).includes(fv));
    }
    if (state.sort.key) {
      const k = state.sort.key, d = state.sort.dir;
      v.sort((a, b) => {
        const x = a[k], y = b[k];
        const nx = parseFloat(x), ny = parseFloat(y);
        if (!isNaN(nx) && !isNaN(ny) && String(x).trim() !== "" && String(y).trim() !== "") return (nx - ny) * d;
        return String(x ?? "").localeCompare(String(y ?? ""), "ko") * d;
      });
    }
    state.view = v;
  }

  /* ---------- DOM 스켈레톤 ---------- */
  root.classList.add("grid");
  root.innerHTML = `
    <div class="grid__toolbar">
      <div class="grid__toolbar-left">
        ${o.search ? `<div class="grid__search"><input type="text" data-act="search" placeholder="검색…"></div>` : ""}
        <span class="grid__badge-count" data-el="count"></span>
      </div>
      <div class="grid__toolbar-right" data-el="actions"></div>
    </div>
    <div class="grid__scroll" data-el="scroll" ${o.cellNav ? 'tabindex="0"' : ""}><table class="grid__table"><colgroup data-el="colgroup"></colgroup><thead data-el="thead"></thead><tbody data-el="tbody"></tbody></table></div>
    <div class="grid__footer"><span data-el="foot"></span></div>`;
  const $ = (sel) => root.querySelector(sel);
  const elScroll = $('[data-el="scroll"]'), elThead = $('[data-el="thead"]'), elTbody = $('[data-el="tbody"]');
  const elCount = $('[data-el="count"]'), elActions = $('[data-el="actions"]'), elFoot = $('[data-el="foot"]');
  const elColgroup = $('[data-el="colgroup"]'), elTable = $(".grid__table");

  /* ---------- 열 폭 ----------
     `resizable` 이나 화면맞춤을 쓰면 표를 고정 레이아웃으로 바꾼다. 그래야 지정한 폭이
     그대로 먹는다(자동 레이아웃에서는 내용이 길면 열이 제멋대로 늘어난다).
     `fixedWidth` 컬럼은 맞춤·드래그 양쪽에서 제외한다 — 화면이 sticky left 오프셋을
     그 폭으로 계산하고 있으면 폭이 변하는 순간 고정열이 어긋난다. */
  const WIDTH_MODE = !!(o.resizable || o.fitWidth);
  const defW = (c) => parseInt(c.width, 10) || o.defaultColWidth;
  const minW = (c) => c.fitMin || o.minColWidth;
  if (WIDTH_MODE) elTable.classList.add("grid__table--fixed");

  function renderColgroup() {
    if (!WIDTH_MODE) return;
    let total = o.selectable ? 34 : 0;
    const h = (o.selectable ? `<col style="width:34px">` : "")
      + cols.map((c) => { const w = state.colW[c.key] ?? defW(c); total += w; return `<col style="width:${w}px">`; }).join("");
    elColgroup.innerHTML = h;
    /* 표에 **구체적인 폭**을 줘야 한다 — `table-layout:fixed` 는 폭이 auto 면 무시되고
       브라우저가 자동 레이아웃으로 되돌아간다(그러면 col 폭이 통째로 먹히지 않는다).
       2026-09-22 실측: col 에 600px 을 줘도 열 폭이 1px 도 안 변했다. */
    elTable.style.width = total + "px";
  }

  /* ---------- 툴바 액션 버튼 ---------- */
  function renderActions() {
    const btn = (act, label, cls, extra = "") => `<button class="grid__btn ${cls ? "grid__btn--" + cls : ""} btn sm ${cls || ""}" data-act="${act}" ${extra}>${label}</button>`;
    let h = "";
    if (o.editToggle) h += btn("toggle-edit", state.editMode ? o.editToggleLabels.on : o.editToggleLabels.off, state.editMode ? "ghost" : "ghost");
    (o.bulkActions || []).forEach((b) => { h += `<button class="grid__btn grid__btn--${b.btnClass || "ok"} btn sm ${b.btnClass || "ok"}" data-act="bulk:${b.id}">${esc(b.label)}</button>`; });
    if (o.copy) h += btn("copy", "📋 복사", "ghost");
    if (o.exportCsv) h += btn("export", "⬇ CSV", "ghost");
    elActions.innerHTML = h;
  }

  /* ---------- 헤더 ---------- */
  function renderHead() {
    const sortMark = (c) => o.sortable && c.sortable !== false
      ? `<span class="grid__sort">${state.sort.key === c.key ? (state.sort.dir === 1 ? "▲" : "▼") : "↕"}</span>` : "";
    let head = "<tr>";
    if (o.selectable) head += `<th class="grid__th grid__th--check"><input type="checkbox" class="grid__check" data-act="sel-all"></th>`;
    head += cols.map((c) => {
      const sortable = o.sortable && c.sortable !== false;
      // cssClass 는 td 뿐 아니라 헤더에도 붙인다 — 고정열(sticky left)은 헤더가 같이 고정되지 않으면
      // 가로 스크롤 때 본문만 남아 헤더를 뚫고 올라온다(2026-09-22 발주통합 LIST 실측)
      const cls = ["grid__th", sortable ? "grid__th--sortable" : "", state.sort.key === c.key ? (state.sort.dir === 1 ? "grid__th--sorted-asc" : "grid__th--sorted-desc") : "", c.cssClass || ""].join(" ");
      // 폭 지정 모드에서는 colgroup 이 폭을 맡는다 — min-width 를 남기면 그 아래로 줄지 않아 맞춤이 안 된다
      const style = WIDTH_MODE ? "" : (c.width ? ` style="min-width:${c.width}"` : "");
      const grip = o.resizable && !c.fixedWidth
        ? `<span class="grid__resizer" data-act="resize" data-col="${esc(c.key)}" title="끌어서 폭 조절 · 두 번 누르면 원래대로"></span>` : "";
      return `<th class="${cls}"${style} data-act="${sortable ? "sort" : ""}" data-col="${esc(c.key)}">${esc(c.label)}${sortMark(c)}${grip}</th>`;
    }).join("");
    head += "</tr>";
    if (o.columnFilter) {
      head += `<tr class="grid__filter-row">`;
      if (o.selectable) head += `<th></th>`;
      head += cols.map((c) => {
        const fcls = c.cssClass ? ` class="${esc(c.cssClass)}"` : "";
        if (c.filter === false) return `<th${fcls}></th>`;
        if (c.type === "select" && c.options) {
          const opts = c.options.map((op) => `<option value="${esc(op.value ?? op)}">${esc(op.label ?? op)}</option>`).join("");
          return `<th${fcls}><select data-act="filter" data-col="${esc(c.key)}"><option value="">전체</option>${opts}</select></th>`;
        }
        return `<th${fcls}><input type="text" data-act="filter" data-col="${esc(c.key)}" placeholder="필터" value="${esc(state.filters[c.key] || "")}"></th>`;
      }).join("");
      head += "</tr>";
    }
    elThead.innerHTML = head;
  }

  /* 필터행이 헤더 바로 밑에 붙도록 실제 헤더 높이를 CSS 변수로 넘긴다.
     고정값(31px)이면 글꼴·패딩이 조금만 달라도 틈이 생겨 그 사이로 본문이 비친다. */
  function syncHeadOffset() {
    if (!o.columnFilter) return;
    const tr = elThead.firstElementChild;
    if (tr && tr.offsetHeight) root.style.setProperty("--g-head-h", tr.offsetHeight + "px");
  }

  /* ---------- 화면맞춤 ----------
     남는 폭을 기본폭 비율대로 나눠 준다. 최소폭에 걸린 열은 더 줄지 않으므로, 모자란 만큼을
     아직 여유 있는 열에서 다시 걷는다(3회면 수렴한다). 그래도 안 들어가면 가로 스크롤이
     남는다 — 억지로 글자를 뭉개는 것보다 솔직하다. */
  /** 맞춤에서 건드리지 않는 열 — 고정열과 **사람이 직접 끌어 정한 열**.
      직접 정한 폭을 맞춤이 덮으면 조절한 의미가 없다. 나머지가 남는 자리를 나눠 갖는다. */
  const pinned = (c) => c.fixedWidth || state.userW[c.key] != null;
  const pinnedW = (c) => (c.fixedWidth ? defW(c) : state.userW[c.key]);

  function computeFit() {
    const avail = elScroll.clientWidth - (o.selectable ? 34 : 0) - 2;
    if (avail <= 0) return null;
    const flex = cols.filter((c) => !pinned(c));
    const fixed = cols.filter(pinned).reduce((s, c) => s + pinnedW(c), 0);
    let target = avail - fixed;
    if (!flex.length || target <= 0) return null;

    const w = {};
    cols.forEach((c) => { if (pinned(c)) w[c.key] = pinnedW(c); });
    let open = flex.slice(), budget = target;
    for (let pass = 0; pass < 3 && open.length; pass++) {
      const weight = open.reduce((s, c) => s + defW(c), 0) || 1;
      const scale = budget / weight;
      const stuck = [];
      open.forEach((c) => {
        const want = Math.round(defW(c) * scale);
        if (want < minW(c)) { w[c.key] = minW(c); stuck.push(c); }
        else w[c.key] = want;
      });
      if (!stuck.length) break;
      budget -= stuck.reduce((s, c) => s + minW(c), 0);
      open = open.filter((c) => !stuck.includes(c));
      if (budget <= 0) { open.forEach((c) => { w[c.key] = minW(c); }); break; }
    }
    // 반올림으로 남은 몇 px 은 가장 넓은 열이 흡수한다(오른쪽에 빈 틈이 생기지 않게)
    const sum = cols.reduce((s, c) => s + w[c.key], 0);
    const slack = avail - sum;
    if (slack > 0 && flex.length) {
      const widest = flex.reduce((a, b) => (w[a.key] >= w[b.key] ? a : b));
      w[widest.key] += slack;
    }
    return w;
  }

  function applyWidths() { renderColgroup(); syncHeadOffset(); }

  /* 계산만으로는 몇 px 이 남는다 — 테두리·여백을 전부 미리 셈할 수 없어서다. 그려 놓고 실제로
     재서 넘친 만큼을 줄일 수 있는 열에서 다시 걷는다. 이 한 번이면 가로 스크롤이 사라진다. */
  function trimOverflow() {
    const over = elScroll.scrollWidth - elScroll.clientWidth;
    state.fitOver = Math.max(0, over);
    if (over <= 0) return;
    const flex = cols.filter((c) => !pinned(c) && state.colW[c.key] > minW(c));
    if (!flex.length) return;             // 전부 최소폭 — 더 줄이면 값을 못 읽는다
    let left = over;
    const room = flex.reduce((s, c) => s + (state.colW[c.key] - minW(c)), 0);
    flex.forEach((c) => {
      if (left <= 0) return;
      const give = Math.min(state.colW[c.key] - minW(c), Math.ceil(over * (state.colW[c.key] - minW(c)) / room), left);
      state.colW[c.key] -= give; left -= give;
    });
    renderColgroup();
    state.fitOver = Math.max(0, elScroll.scrollWidth - elScroll.clientWidth);
  }

  function setFit(on) {
    state.fit = !!on;
    root.classList.toggle("grid--fit", state.fit);
    if (state.fit) {
      const w = computeFit();
      if (w) state.colW = w;
      applyWidths();
      trimOverflow();
    } else {
      state.colW = Object.assign({}, state.userW);
      applyWidths();
    }
    return state.fit;
  }

  /* ---------- 열 경계 드래그 ---------- */
  if (o.resizable) {
    let rz = null;
    elThead.addEventListener("pointerdown", (e) => {
      const g = e.target.closest('[data-act="resize"]'); if (!g) return;
      e.preventDefault(); e.stopPropagation();          // 정렬 클릭과 겹치지 않게
      const key = g.getAttribute("data-col");
      const c = cols.find((x) => x.key === key); if (!c) return;
      const th = g.closest("th");
      rz = { key, c, x0: e.clientX, w0: th.getBoundingClientRect().width };
      root.classList.add("grid--resizing");
      try { g.setPointerCapture(e.pointerId); } catch (err) {}
    });
    elThead.addEventListener("pointermove", (e) => {
      if (!rz) return;
      const w = Math.max(minW(rz.c), Math.round(rz.w0 + (e.clientX - rz.x0)));
      state.colW[rz.key] = w; state.userW[rz.key] = w;
      renderColgroup();
    });
    const endRz = () => {
      if (!rz) return;
      const key = rz.key; rz = null;
      root.classList.remove("grid--resizing");
      syncHeadOffset();
      if (o.onColResize) o.onColResize(key, state.colW[key], Object.assign({}, state.userW));
    };
    elThead.addEventListener("pointerup", endRz);
    elThead.addEventListener("pointercancel", endRz);
    // 두 번 누르면 그 열만 원래 폭으로
    elThead.addEventListener("dblclick", (e) => {
      const g = e.target.closest('[data-act="resize"]'); if (!g) return;
      e.preventDefault(); e.stopPropagation();
      const key = g.getAttribute("data-col");
      delete state.userW[key];
      // 맞춤 중이면 그 열만 되돌리는 게 아니라 전체를 다시 나눈다(합이 화면 폭에 맞아야 한다)
      if (state.fit) setFit(true);
      else { state.colW[key] = defW(cols.find((c) => c.key === key)); applyWidths(); }
      if (o.onColResize) o.onColResize(key, state.colW[key], Object.assign({}, state.userW));
    });
  }

  /* ---------- 본문 셀 ---------- */
  function cellHtml(c, row, key) {
    const editable = state.editMode && (typeof c.editable === "function" ? c.editable(row) : c.editable) && !c.readOnly;
    if (editable) {
      const errId = state.errors.get(key + "|" + c.key);
      if (c.type === "select" && c.options) {
        const opts = c.options.map((op) => { const v = op.value ?? op; return `<option value="${esc(v)}" ${String(row[c.key]) === String(v) ? "selected" : ""}>${esc(op.label ?? op)}</option>`; }).join("");
        return `<select class="grid__cell-input" data-act="edit" data-key="${esc(key)}" data-col="${esc(c.key)}">${opts}</select>${errId ? `<span class="grid__err-tip">${esc(errId)}</span>` : ""}`;
      }
      const t = c.type === "number" ? "number" : c.type === "date" ? "date" : c.type === "email" ? "email" : "text";
      return `<input type="${t}" class="grid__cell-input" data-act="edit" data-key="${esc(key)}" data-col="${esc(c.key)}" value="${esc(row[c.key] ?? "")}" placeholder="${esc(c.placeholder || "")}">${errId ? `<span class="grid__err-tip">${esc(errId)}</span>` : ""}`;
    }
    if (typeof c.formatter === "function") return c.formatter(row[c.key], row);
    return esc(row[c.key] ?? "");
  }

  function renderBody() {
    if (state.loading) { elTbody.innerHTML = `<tr><td colspan="${cols.length + (o.selectable ? 1 : 0)}"><div class="grid__loading">${esc(o.loadingText)}</div></td></tr>`; return; }
    const view = o.pageSize > 0 ? state.view.slice(0, o.pageSize) : state.view;
    if (!view.length) { elTbody.innerHTML = `<tr><td colspan="${cols.length + (o.selectable ? 1 : 0)}"><div class="grid__empty">${esc(o.emptyText)}</div></td></tr>`; return; }
    elTbody.innerHTML = view.map((row, i) => {
      const key = keyOf(row, state.rows.indexOf(row));
      const sel = state.selected.has(String(key)), dirty = state.dirty.has(String(key));
      const extra = o.rowClass ? (o.rowClass(row) || "") : "";
      let tds = "";
      if (o.selectable) tds += `<td class="grid__td grid__td--check"><input type="checkbox" class="grid__check" data-act="sel" data-key="${esc(key)}" ${sel ? "checked" : ""}></td>`;
      tds += cols.map((c) => {
        const editable = state.editMode && (typeof c.editable === "function" ? c.editable(row) : c.editable) && !c.readOnly;
        const err = state.errors.has(key + "|" + c.key);
        const cls = ["grid__td", editable ? "grid__td--editable" : "grid__td--readonly", c.align === "right" || c.type === "number" ? "grid__td--num" : "", c.align === "center" ? "grid__td--center" : "", err ? "grid__td--error" : "", c.cssClass || ""].join(" ");
        return `<td class="${cls}" data-col="${esc(c.key)}">${cellHtml(c, row, key)}</td>`;
      }).join("");
      return `<tr class="grid__row ${sel ? "grid__row--selected" : ""} ${dirty ? "grid__row--dirty" : ""} ${extra}" data-key="${esc(key)}">${tds}</tr>`;
    }).join("");
  }

  function renderFooter() {
    const total = state.rows.length, shown = state.view.length, seln = state.selected.size, dirtyn = state.dirty.size;
    elCount.innerHTML = `총 <b>${total}</b>건${shown !== total ? ` · 조회 <b>${shown}</b>` : ""}${seln ? ` · 선택 <b>${seln}</b>` : ""}${dirtyn ? ` · 수정 <b>${dirtyn}</b>` : ""}`;
    elFoot.textContent = state.editMode ? "편집 모드 — 셀을 클릭해 수정하거나 엑셀에서 붙여넣기(Ctrl+V)" : "";
    root.classList.toggle("grid--bulk-on", state.editMode);
  }

  function render() { renderActions(); renderColgroup(); renderHead(); renderBody(); renderFooter(); syncHeadOffset(); paintCursor(); }

  /* ---------- 셀 커서 (읽기 화면의 항목간 이동) ----------
     편집 모드의 keyboardNav 와 다르다 — 저쪽은 입력칸 사이를 옮기고, 이쪽은 **보기만 하는 표**에서
     어느 칸을 보고 있는지 표시하며 화면 밖 열로 가면 표를 따라 스크롤한다. */
  const cellAt = (key, colKey) =>
    elTbody.querySelector(`tr[data-key="${CSS.escape(String(key))}"] td[data-col="${CSS.escape(colKey)}"]`);

  function paintCursor() {
    if (!o.cellNav) return;
    elTbody.querySelectorAll(".grid__cell--focus").forEach((el) => el.classList.remove("grid__cell--focus"));
    if (!state.cur) return;
    const td = cellAt(state.cur.key, state.cur.col);
    if (td) td.classList.add("grid__cell--focus");
    else state.cur = null;                 // 필터·정렬로 그 행이 사라졌다
  }

  function setCursor(key, colKey, scroll = true) {
    if (!o.cellNav) return;
    state.cur = { key, col: colKey };
    paintCursor();
    if (scroll) {
      const td = cellAt(key, colKey);
      if (td) td.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  function moveCursor(dRow, dCol) {
    if (!o.cellNav) return false;
    const trs = [...elTbody.querySelectorAll("tr[data-key]")];
    if (!trs.length) return false;
    const colKeys = cols.map((c) => c.key);
    if (!state.cur) { setCursor(trs[0].getAttribute("data-key"), colKeys[0]); return true; }
    let ri = trs.findIndex((tr) => tr.getAttribute("data-key") === String(state.cur.key));
    let ci = colKeys.indexOf(state.cur.col);
    if (ri < 0) ri = 0;
    if (ci < 0) ci = 0;
    const nr = Math.min(trs.length - 1, Math.max(0, ri + dRow));
    const nc = Math.min(colKeys.length - 1, Math.max(0, ci + dCol));
    if (nr === ri && nc === ci) return false;
    setCursor(trs[nr].getAttribute("data-key"), colKeys[nc]);
    return true;
  }

  /** 그 열이 보이도록 표를 가로로 옮긴다(열 점프). */
  function scrollToColumn(colKey) {
    const th = elThead.querySelector(`tr:first-child th[data-col="${CSS.escape(colKey)}"]`);
    if (!th) return false;
    const sr = elScroll.getBoundingClientRect(), tr = th.getBoundingClientRect();
    const pad = 12;
    let dx = 0;
    if (tr.left < sr.left + pad) dx = tr.left - sr.left - pad;
    else if (tr.right > sr.right - pad) dx = tr.right - sr.right + pad;
    if (dx) elScroll.scrollBy({ left: dx, behavior: "smooth" });
    th.classList.add("grid__th--flash");
    setTimeout(() => th.classList.remove("grid__th--flash"), 900);
    return true;
  }

  if (o.cellNav) {
    elTbody.addEventListener("pointerdown", (e) => {
      const td = e.target.closest("td[data-col]"); const tr = e.target.closest("tr[data-key]");
      if (td && tr) setCursor(tr.getAttribute("data-key"), td.getAttribute("data-col"), false);
    });
    elScroll.addEventListener("keydown", (e) => {
      if (e.target.closest("input, select, textarea")) return;   // 필터칸 입력 중에는 건드리지 않는다
      const K = e.key;
      let handled = true;
      if (K === "ArrowLeft") handled = moveCursor(0, -1);
      else if (K === "ArrowRight") handled = moveCursor(0, 1);
      else if (K === "ArrowUp") handled = moveCursor(-1, 0);
      else if (K === "ArrowDown") handled = moveCursor(1, 0);
      else if (K === "Home") handled = moveCursor(0, -cols.length);
      else if (K === "End") handled = moveCursor(0, cols.length);
      else if (K === "PageUp") handled = moveCursor(-15, 0);
      else if (K === "PageDown") handled = moveCursor(15, 0);
      else if (K === "Enter" && state.cur && o.onCellActivate) {
        const row = state.rows.find((r, i) => String(keyOf(r, i)) === String(state.cur.key));
        if (row) o.onCellActivate(row, cols.find((c) => c.key === state.cur.col));
      } else handled = false;
      if (handled) e.preventDefault();
    });
  }

  /* ---------- dirty 기록 ---------- */
  function setCell(key, field, value) {
    const row = state.rows.find((r, i) => String(keyOf(r, i)) === String(key));
    if (!row) return;
    const col = cols.find((c) => c.key === field);
    const old = row[field];
    row[field] = value;
    // dirty 추적
    let d = state.dirty.get(String(key)) || { key, row, fields: {} };
    if (!(field in d.fields)) d.fields[field] = { old };
    d.fields[field].new = value;
    state.dirty.set(String(key), d);
    // 검증
    const ek = key + "|" + field;
    if (col && typeof col.validator === "function") {
      const res = col.validator(value, row);
      if (res !== true && res != null && res !== "") state.errors.set(ek, res === false ? "유효하지 않은 값" : res);
      else state.errors.delete(ek);
    } else state.errors.delete(ek);
    if (o.onCellEdit) o.onCellEdit(key, field, value, row);
  }

  /* ---------- 이벤트 위임 ---------- */
  root.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]"); if (!t) {
      const ra = e.target.closest("[data-row-act]");
      if (ra && o.onRowAction) { const row = rowFromEl(ra); o.onRowAction(ra.getAttribute("data-row-act"), row, e); }
      return;
    }
    const act = t.getAttribute("data-act");
    if (act === "sort") { const k = t.getAttribute("data-col"); state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 }; computeView(); render(); }
    else if (act === "sel-all") { toggleAll(t.checked); }
    else if (act === "sel") { toggleOne(t.getAttribute("data-key"), t.checked); }
    else if (act === "toggle-edit") { state.editMode = !state.editMode; render(); }
    else if (act === "copy") { copyToClipboard(); }
    else if (act === "export") { exportCsv(); }
    else if (act.startsWith("bulk:")) { if (o.onBulkAction) o.onBulkAction(act.slice(5), instance); }
    else if (act.startsWith("row-act:")) { if (o.onRowAction) o.onRowAction(act.slice(8), rowFromEl(t), e); }
  });
  // formatter 내부 버튼: data-row-act 도 지원 (위 click의 fallback)

  /* 검색·필터는 글자마다 본문을 다시 그린다. 수천 행 화면에서는 이게 그대로 입력 지연이 된다
     (5,609행 렌더 1.9초 실측) — 입력이 멎은 뒤 한 번만 그린다. 값은 즉시 반영하므로 결과는 같다. */
  let inputTimer = null;
  const deferView = () => {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => { computeView(); renderBody(); renderFooter(); }, 120);
  };
  root.addEventListener("input", (e) => {
    const t = e.target.closest("[data-act]"); if (!t) return;
    const act = t.getAttribute("data-act");
    if (act === "search") { state.query = t.value; deferView(); }
    else if (act === "filter") { state.filters[t.getAttribute("data-col")] = t.value; deferView(); }
    else if (act === "edit") { setCell(t.getAttribute("data-key"), t.getAttribute("data-col"), t.value); markRowDirty(t); }
  });
  root.addEventListener("change", (e) => {
    const t = e.target.closest('select[data-act="edit"]'); if (!t) return;
    setCell(t.getAttribute("data-key"), t.getAttribute("data-col"), t.value); markRowDirty(t);
  });

  // 편집 셀 즉시 dirty 표시(전체 리렌더 없이)
  function markRowDirty(inputEl) {
    const tr = inputEl.closest("tr"); if (tr) tr.classList.add("grid__row--dirty");
    const td = inputEl.closest("td"); const key = inputEl.getAttribute("data-key"), field = inputEl.getAttribute("data-col");
    if (td) td.classList.toggle("grid__td--error", state.errors.has(key + "|" + field));
    let tip = td && td.querySelector(".grid__err-tip");
    const msg = state.errors.get(key + "|" + field);
    if (td) { if (msg && !tip) { tip = document.createElement("span"); tip.className = "grid__err-tip"; td.appendChild(tip); } if (tip) tip.textContent = msg || ""; if (!msg && tip) tip.remove(); }
    renderFooter();
  }

  /* ---------- 키보드 네비 (편집 모드) ---------- */
  if (o.keyboardNav) root.addEventListener("keydown", (e) => {
    const inp = e.target.closest('[data-act="edit"]'); if (!inp) return;
    const key = inp.getAttribute("data-key"), col = inp.getAttribute("data-col");
    const move = (delta) => {
      const order = (o.pageSize > 0 ? state.view.slice(0, o.pageSize) : state.view);
      const idx = order.findIndex((r, i) => String(keyOf(r, state.rows.indexOf(r))) === String(key));
      const next = order[idx + delta]; if (!next) return;
      const nk = keyOf(next, state.rows.indexOf(next));
      const nel = root.querySelector(`[data-act="edit"][data-key="${CSS.escape(String(nk))}"][data-col="${CSS.escape(col)}"]`);
      if (nel) { e.preventDefault(); nel.focus(); if (nel.select) nel.select(); }
    };
    if (e.key === "Enter" || e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
  });

  /* ---------- 붙여넣기 (엑셀 탭/개행) ---------- */
  if (o.paste) root.addEventListener("paste", (e) => {
    const inp = e.target.closest('[data-act="edit"]'); if (!inp) return;
    const text = (e.clipboardData || window.clipboardData)?.getData("text") || "";
    if (!/[\t\n\r]/.test(text)) return; // 단일 값은 기본 붙여넣기
    e.preventDefault();
    const startKey = inp.getAttribute("data-key");
    const parsed = applyPaste(text, startKey);
    computeView(); render();
    if (o.onPaste) o.onPaste(parsed);
  });

  // 붙여넣기 파싱·반영: pasteKey(email/name/code) 자동 인식, code=keyField 정확매칭, 없으면 시작행부터 순서
  function applyPaste(text, startKey) {
    const editCols = cols.filter((c) => c.editable && c.pasteKey !== "none");
    const codeCol = cols.find((c) => c.pasteKey === "code");
    const emailCol = editCols.find((c) => c.pasteKey === "email") || editCols.find((c) => c.type === "email");
    const nameCol = editCols.find((c) => c.pasteKey === "name");
    const order = state.view.map((r) => String(keyOf(r, state.rows.indexOf(r))));
    const keySet = new Set(state.rows.map((r, i) => String(keyOf(r, i))));
    let seq = Math.max(0, order.indexOf(String(startKey)));
    const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter((l) => l.length);
    const touched = [];
    lines.forEach((line) => {
      const fields = line.split("\t").map((f) => f.trim());
      let key, rest = fields;
      const codeIdx = fields.findIndex((f) => keySet.has(f));
      if (codeIdx >= 0) { key = fields[codeIdx]; rest = fields.filter((_, j) => j !== codeIdx); }
      else { key = order[seq++]; }
      if (key == null) return;
      const email = rest.find((f) => isEmail(f)) || rest.find((f) => /@/.test(f)) || "";
      const name = rest.filter((f) => f && !/@/.test(f) && !keySet.has(f))[0] || "";
      if (emailCol && email) setCell(key, emailCol.key, email);
      if (nameCol && name) setCell(key, nameCol.key, name);
      // pasteKey 미지정 편집컬럼은 순서대로 채움(이메일/이름 이미 처리된 것 제외)
      if (!emailCol && !nameCol) { const generic = editCols[0]; if (generic && rest[0]) setCell(key, generic.key, rest[0]); }
      touched.push(key);
    });
    return touched;
  }

  /* ---------- 선택 ---------- */
  function toggleAll(on) {
    state.view.forEach((r) => { const k = String(keyOf(r, state.rows.indexOf(r))); if (on) state.selected.add(k); else state.selected.delete(k); });
    renderBody(); renderFooter(); if (o.onSelectionChange) o.onSelectionChange(getSelected());
  }
  function toggleOne(key, on) {
    if (on) state.selected.add(String(key)); else state.selected.delete(String(key));
    const tr = root.querySelector(`tr[data-key="${CSS.escape(String(key))}"]`); if (tr) tr.classList.toggle("grid__row--selected", on);
    renderFooter(); if (o.onSelectionChange) o.onSelectionChange(getSelected());
  }

  function rowFromEl(el) { const tr = el.closest("tr[data-key]"); if (!tr) return null; const k = tr.getAttribute("data-key"); return state.rows.find((r, i) => String(keyOf(r, i)) === String(k)) || null; }

  /* ---------- CSV / 클립보드 ---------- */
  function rowsToMatrix(rows) {
    const header = cols.map((c) => c.label);
    const body = rows.map((r) => cols.map((c) => {
      const v = r[c.key];
      return typeof c.exportValue === "function" ? c.exportValue(v, r) : (v ?? "");
    }));
    return [header, ...body];
  }
  function exportCsv(filename) {
    const rows = state.selected.size ? getSelected() : state.view;
    const m = rowsToMatrix(rows);
    const csv = m.map((row) => row.map((cell) => { const s = String(cell ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = (filename || o.exportName) + ".csv"; a.click(); URL.revokeObjectURL(a.href);
  }
  function copyToClipboard() {
    const rows = state.selected.size ? getSelected() : state.view;
    const tsv = rowsToMatrix(rows).map((row) => row.join("\t")).join("\n");
    navigator.clipboard?.writeText(tsv);
  }

  /* ---------- 공개 API ---------- */
  function getSelected() { return state.rows.filter((r, i) => state.selected.has(String(keyOf(r, i)))); }
  function getSelectedKeys() { return [...state.selected]; }
  function getDirty() { return [...state.dirty.values()].map((d) => ({ key: d.key, row: d.row, dirtyFields: d.fields })); }
  function getData() { return state.rows.map((r) => { const c = Object.assign({}, r); delete c.__k; return c; }); }

  const instance = {
    el: root,
    getData, getSelected, getSelectedKeys, getDirty,
    setRows(rows) { state.selected.clear(); ingest(rows); render(); },
    updateRow(key, patch) { const r = state.rows.find((row, i) => String(keyOf(row, i)) === String(key)); if (r) Object.assign(r, patch); computeView(); renderBody(); renderFooter(); },
    refresh() { computeView(); render(); },
    setLoading(b) { state.loading = !!b; renderBody(); },
    clearSelection() { state.selected.clear(); renderBody(); renderFooter(); },
    clearDirty() { state.dirty.clear(); state.errors.clear(); render(); },
    setEditMode(b) { state.editMode = !!b; render(); },
    isEditMode() { return state.editMode; },
    validateAll() {
      state.errors.clear();
      state.rows.forEach((row, i) => cols.forEach((c) => { if (typeof c.validator === "function") { const res = c.validator(row[c.key], row); if (res !== true && res != null && res !== "") state.errors.set(keyOf(row, i) + "|" + c.key, res === false ? "유효하지 않은 값" : res); } }));
      render(); return state.errors.size === 0;
    },
    hasErrors() { return state.errors.size > 0; },
    exportCsv, copyToClipboard,
    /* 넓은 목록용 */
    setFit, isFit() { return state.fit; }, refitWidths() { if (state.fit) setFit(true); },
    /** 맞춤을 켰는데도 화면 밖으로 남은 폭(px). 0 이면 전부 들어왔다. */
    getFitOverflow() { return state.fit ? (state.fitOver || 0) : 0; },
    getColWidths() { return Object.assign({}, state.userW); },
    setColWidths(w) { state.userW = Object.assign({}, w || {}); if (!state.fit) state.colW = Object.assign({}, state.userW); applyWidths(); },
    scrollToColumn, setCursor, getCursor() { return state.cur && Object.assign({}, state.cur); },
    focusTable() { elScroll.focus(); },
    destroy() { clearTimeout(inputTimer); root.innerHTML = ""; root.classList.remove("grid", "grid--bulk-on", "grid--fit"); },
  };

  render();
  return instance;
}

export { esc as gridEsc, isEmail as gridIsEmail };
