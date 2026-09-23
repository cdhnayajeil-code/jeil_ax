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
    columnPicker: false,     // 「항목 고르기」 — 표에 넣을 열을 고르고 순서를 바꾼다(피벗식 두 칸)
    columnPickerLabel: "▦ 항목",
    groupHeader: false,      // 2단 헤더(열 그룹) — 켜지 않으면 기존 6종 화면과 DOM·CSS·스크롤이 한 픽셀도 같지 않다
    onSave: null, onSelectionChange: null, onBulkAction: null,
    onRowAction: null, onCellEdit: null, onPaste: null,
    onColResize: null,       // (key, px, allWidths) — 저장은 호출측이 한다(grid 는 저장소를 모른다)
    onCellActivate: null,    // (row, col) — 셀 커서에서 Enter
    onColumnsChange: null,   // ({order, hidden}) — 저장은 호출측이 한다(grid 는 저장소를 모른다)
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
    order: [],         // 열 순서(키 배열) — 항목 고르기에서 바꾼다
    hidden: new Set(), // 표에서 빼 둔 열
    pickOpen: false,   // 항목 고르기 패널 열림
  };

  /* ---------- 지금 표에 그릴 열 ----------
     `cols` 는 화면이 준 정의 그대로 두고, **실제로 그리는 열**은 여기서 만든다.
     순서가 적용되고 빼 둔 열이 빠진 목록이다 — 렌더·화면맞춤·내보내기·셀이동이 전부 이걸 본다.
     `cols` 를 그대로 도는 곳이 한 군데라도 남으면 뺀 열이 그 경로에서만 되살아난다
     (헤더에는 없는데 CSV 에는 있는 식). 열을 세는 모든 자리를 함께 옮겨야 하는 이유다. */
  const byKey = {};
  cols.forEach((c) => { byKey[c.key] = c; });
  state.order = cols.map((c) => c.key);
  cols.forEach((c) => { if (c.hidden) state.hidden.add(c.key); });
  const vcols = () => state.order.map((k) => byKey[k]).filter((c) => c && !state.hidden.has(c.key));
  /** 뺄 수 없는 열 — 화면이 `required:true` 로 지정한다(키·구분처럼 없으면 행을 못 읽는 열). */
  const canHide = (c) => !c.required;

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
    const q = norm(state.query), vc = vcols();
    // 검색·필터는 **보이는 열**에서만 건다 — 빼 둔 열에서 맞아 행이 나오면 왜 나왔는지 알 수 없다
    if (q) v = v.filter((r) => vc.some((c) => norm(r[c.key]).includes(q)));
    for (const [k, val] of Object.entries(state.filters)) {
      if (!val || state.hidden.has(k)) continue; const fv = norm(val);
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
    <div class="grid__footer"><span data-el="foot"></span></div>
    ${o.columnPicker ? `<div class="grid__picker" data-el="picker" hidden></div>` : ""}`;
  const $ = (sel) => root.querySelector(sel);
  const elScroll = $('[data-el="scroll"]'), elThead = $('[data-el="thead"]'), elTbody = $('[data-el="tbody"]');
  const elCount = $('[data-el="count"]'), elActions = $('[data-el="actions"]'), elFoot = $('[data-el="foot"]');
  const elColgroup = $('[data-el="colgroup"]'), elTable = $(".grid__table"), elPicker = $('[data-el="picker"]');

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
      + vcols().map((c) => { const w = state.colW[c.key] ?? defW(c); total += w; return `<col style="width:${w}px">`; }).join("");
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
    if (o.columnPicker) {
      // 「보이는 개수/전체」를 버튼에 그대로 적는다 — 열이 빠져 있다는 걸 패널을 열지 않고도 알게
      h += `<button class="grid__btn grid__btn--ghost btn sm ghost${state.pickOpen ? " grid__btn--on" : ""}" data-act="pick-toggle" title="표에 넣을 항목 고르기 · 순서 바꾸기">${esc(o.columnPickerLabel)} <b>${vcols().length}</b>/${cols.length}</button>`;
    }
    if (o.copy) h += btn("copy", "📋 복사", "ghost");
    if (o.exportCsv) h += btn("export", "⬇ CSV", "ghost");
    elActions.innerHTML = h;
  }

  /* ---------- 헤더 ---------- */
  /** 2단 헤더 그룹 칸. **표에 보이는 순서**(vc)를 훑어 group 값이 같은 것이 연달아 있으면
      colspan 으로 묶는다 — 순서는 항목 고르기로 바뀔 수 있으니 저장해 두지 않고 매번 다시 계산한다.
      group 이 없는 열은 빈 칸이고, 연달은 빈 칸도 하나로 묶는다(같은 group 이 떨어져 있으면 묶지 않는다 —
      루프가 vc 순서대로만 훑으므로 자연히 그렇게 된다). */
  function renderGroupCells(vc) {
    let h = "", i = 0;
    while (i < vc.length) {
      const g = vc[i].group || "";
      let j = i + 1;
      while (j < vc.length && (vc[j].group || "") === g) j++;
      const gc = vc.slice(i, j).map((c) => c.groupClass).find(Boolean) || "";
      h += `<th class="grid__th grid__gth${gc ? " " + gc : ""}" colspan="${j - i}">${g ? esc(g) : ""}</th>`;
      i = j;
    }
    return h;
  }

  function renderHead() {
    const sortMark = (c) => o.sortable && c.sortable !== false
      ? `<span class="grid__sort">${state.sort.key === c.key ? (state.sort.dir === 1 ? "▲" : "▼") : "↕"}</span>` : "";
    const vc = vcols();
    let head = "";
    if (o.groupHeader) {
      head += `<tr class="grid__group-row">`;
      if (o.selectable) head += `<th class="grid__th grid__gth grid__th--check"></th>`;
      head += renderGroupCells(vc);
      head += `</tr>`;
    }
    head += `<tr class="grid__head-row">`;
    if (o.selectable) head += `<th class="grid__th grid__th--check"><input type="checkbox" class="grid__check" data-act="sel-all"></th>`;
    head += vc.map((c) => {
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
      head += vc.map((c) => {
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
     고정값(31px)이면 글꼴·패딩이 조금만 달라도 틈이 생겨 그 사이로 본문이 비친다.
     groupHeader 가 꺼져 있으면 --g-group-h 를 아예 설정하지 않는다 — CSS 쪽 기본값(0px)이
     그대로 먹어 그룹 행이 없던 기존 화면과 동작이 한 픽셀도 다르지 않다. */
  function syncHeadOffset() {
    if (o.groupHeader) {
      const gtr = elThead.querySelector(".grid__group-row");
      if (gtr && gtr.offsetHeight) root.style.setProperty("--g-group-h", gtr.offsetHeight + "px");
    }
    if (!o.columnFilter) return;
    const tr = elThead.querySelector(".grid__head-row") || elThead.firstElementChild;
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
    const vc = vcols();
    const flex = vc.filter((c) => !pinned(c));
    const fixed = vc.filter(pinned).reduce((s, c) => s + pinnedW(c), 0);
    let target = avail - fixed;
    if (!flex.length || target <= 0) return null;

    const w = {};
    vc.forEach((c) => { if (pinned(c)) w[c.key] = pinnedW(c); });
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
    const sum = vc.reduce((s, c) => s + w[c.key], 0);
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
    const flex = vcols().filter((c) => !pinned(c) && state.colW[c.key] > minW(c));
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
    const vc = vcols(), span = vc.length + (o.selectable ? 1 : 0);
    if (state.loading) { elTbody.innerHTML = `<tr><td colspan="${span}"><div class="grid__loading">${esc(o.loadingText)}</div></td></tr>`; return; }
    const view = o.pageSize > 0 ? state.view.slice(0, o.pageSize) : state.view;
    if (!view.length) { elTbody.innerHTML = `<tr><td colspan="${span}"><div class="grid__empty">${esc(o.emptyText)}</div></td></tr>`; return; }
    elTbody.innerHTML = view.map((row, i) => {
      const key = keyOf(row, state.rows.indexOf(row));
      const sel = state.selected.has(String(key)), dirty = state.dirty.has(String(key));
      const extra = o.rowClass ? (o.rowClass(row) || "") : "";
      let tds = "";
      if (o.selectable) tds += `<td class="grid__td grid__td--check"><input type="checkbox" class="grid__check" data-act="sel" data-key="${esc(key)}" ${sel ? "checked" : ""}></td>`;
      tds += vc.map((c) => {
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
    const colKeys = vcols().map((c) => c.key);   // 빼 둔 열은 방향키로도 건너뛴다
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
    // groupHeader 가 켜져 있으면 첫 행이 그룹 행(data-col 없음)이라 .grid__head-row 로 콕 짚는다.
    const th = elThead.querySelector(`.grid__head-row th[data-col="${CSS.escape(colKey)}"]`);
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
        if (row) o.onCellActivate(row, byKey[state.cur.col]);
      } else handled = false;
      if (handled) e.preventDefault();
    });
  }


  /* ---------- 항목 고르기 (피벗식 두 칸) ----------
     왼쪽이 「표에 넣은 항목」(표의 순서 그대로), 오른쪽이 「뺀 항목」이다. 항목을 누르면 반대편으로
     건너가고, 끌어다 놓으면 순서까지 바뀐다. 체크박스 목록 대신 두 칸으로 나눈 이유는
     **무엇이 빠져 있는지**가 한눈에 보여야 하기 때문이다 — 체크가 풀린 줄은 눈에 띄지 않는다.
     저장은 하지 않는다(§13.3) — `onColumnsChange` 로 넘기고 보관은 화면이 한다. */
  const docOff = [];

  function getColumnState() { return { order: state.order.slice(), hidden: [...state.hidden] }; }

  /** 저장해 둔 구성을 되돌린다. 화면 쪽 저장·복원 담당(onColumnsChange 를 다시 부르지 않는다). */
  function setColumnState(s) {
    if (!s) return;
    if (Array.isArray(s.order)) {
      // 저장한 뒤에 열이 늘었을 수 있다 — 모르는 키는 버리고, 빠진 키는 원래 순서대로 뒤에 붙인다
      const known = s.order.filter((k) => byKey[k]);
      state.order = known.concat(cols.map((c) => c.key).filter((k) => known.indexOf(k) < 0));
    }
    if (Array.isArray(s.hidden)) state.hidden = new Set(s.hidden.filter((k) => byKey[k] && canHide(byKey[k])));
    computeView(); render(); renderPicker();
    if (state.fit) setFit(true);
  }

  function resetColumns() {
    state.order = cols.map((c) => c.key);
    state.hidden = new Set(cols.filter((c) => c.hidden).map((c) => c.key));
    applyColumns();
  }

  function toggleColumn(key) {
    const c = byKey[key]; if (!c || !canHide(c)) return;
    if (state.hidden.has(key)) state.hidden.delete(key); else state.hidden.add(key);
    applyColumns();
  }

  /** 열 구성이 바뀌면 한 번에 다시 그린다 — 맞춤 중이면 남는 폭을 다시 나눠야 한다. */
  function applyColumns() {
    computeView(); render(); renderPicker();
    if (state.fit) setFit(true);
    if (o.onColumnsChange) o.onColumnsChange(getColumnState());
  }

  /** key 를 zone("on"=표에 넣기 / "off"=빼기)으로 옮기고, refKey 앞(또는 뒤)에 끼운다. */
  function moveColumn(key, zone, refKey, after) {
    const c = byKey[key]; if (!c) return;
    if (zone === "off") { if (!canHide(c)) return; state.hidden.add(key); }
    else state.hidden.delete(key);
    if (refKey && refKey !== key) {
      const rest = state.order.filter((k) => k !== key);
      const at = rest.indexOf(refKey);
      if (at < 0) rest.push(key); else rest.splice(at + (after ? 1 : 0), 0, key);
      state.order = rest;
    }
    applyColumns();
  }

  function renderPicker() {
    if (!o.columnPicker || !elPicker) return;
    const on = vcols();
    const off = state.order.map((k) => byKey[k]).filter((c) => c && state.hidden.has(c.key));
    const item = (c, zone) => {
      const lock = !canHide(c);
      const tip = lock ? "항상 표시되는 항목입니다"
        : (zone === "on" ? "누르면 표에서 뺍니다 · 끌면 순서가 바뀝니다" : "누르면 표에 넣습니다");
      const nm = c.group ? `${c.group} · ${c.label}` : c.label;   // 2단 헤더 열은 그룹까지 보여야 구분된다
      return `<li class="grid__picker-item${lock ? " grid__picker-item--locked" : ""}"`
        + ` data-act="${lock ? "" : "pick-item"}" data-col="${esc(c.key)}" data-zone="${zone}"`
        + ` draggable="${lock ? "false" : "true"}" title="${esc(tip)}">`
        + `<span class="grid__picker-grip">${lock ? "🔒" : "⠿"}</span>`
        + `<span class="grid__picker-nm">${esc(nm)}</span>`
        + `<span class="grid__picker-act">${lock ? "" : (zone === "on" ? "−" : "+")}</span></li>`;
    };
    const list = (arr, zone, empty) => `<ul class="grid__picker-list" data-zone="${zone}">`
      + (arr.length ? arr.map((c) => item(c, zone)).join("") : `<li class="grid__picker-empty">${empty}</li>`)
      + `</ul>`;
    elPicker.innerHTML =
      `<div class="grid__picker-head"><b>항목 고르기</b>`
      + `<span class="grid__picker-hint">눌러서 넣고 빼기 · 끌어서 순서 바꾸기</span>`
      + `<button class="grid__picker-x" data-act="pick-close" title="닫기">✕</button></div>`
      + `<div class="grid__picker-cols">`
      + `<div class="grid__picker-box grid__picker-box--on"><div class="grid__picker-cap">표에 넣은 항목 <b>${on.length}</b></div>`
      + list(on, "on", "표가 비었습니다.<br>오른쪽 항목을 끌어다 놓으세요.") + `</div>`
      + `<div class="grid__picker-box grid__picker-box--off"><div class="grid__picker-cap">뺀 항목 <b>${off.length}</b></div>`
      + list(off, "off", "뺀 항목이 없습니다.<br>왼쪽 항목을 여기로 끌면 표에서 빠집니다.") + `</div>`
      + `</div>`
      + `<div class="grid__picker-foot"><button data-act="pick-all">전부 넣기</button>`
      + `<button data-act="pick-reset">처음 상태로</button></div>`;
  }

  function togglePicker(on) {
    if (!o.columnPicker || !elPicker) return;
    state.pickOpen = on == null ? !state.pickOpen : !!on;
    elPicker.hidden = !state.pickOpen;
    if (state.pickOpen) renderPicker();
    renderActions();
  }

  if (o.columnPicker) {
    let dragKey = null;
    const clearMark = () => {
      elPicker.querySelectorAll(".grid__picker-item--over-a,.grid__picker-item--over-b")
        .forEach((el) => el.classList.remove("grid__picker-item--over-a", "grid__picker-item--over-b"));
      elPicker.querySelectorAll(".grid__picker-list--over")
        .forEach((el) => el.classList.remove("grid__picker-list--over"));
    };
    /** 끌고 있는 항목이 이 항목의 위쪽 절반인지 아래쪽 절반인지 — 끼울 자리를 정한다. */
    const halfAfter = (el, y) => { const r = el.getBoundingClientRect(); return y > r.top + r.height / 2; };

    elPicker.addEventListener("dragstart", (e) => {
      const li = e.target.closest(".grid__picker-item");
      if (!li || li.classList.contains("grid__picker-item--locked")) { e.preventDefault(); return; }
      dragKey = li.getAttribute("data-col");
      li.classList.add("grid__picker-item--drag");
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", dragKey); } catch (err) {} }
    });
    elPicker.addEventListener("dragend", () => { dragKey = null; clearMark(); renderPicker(); });
    elPicker.addEventListener("dragover", (e) => {
      if (!dragKey) return;
      const ul = e.target.closest(".grid__picker-list"); if (!ul) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      clearMark(); ul.classList.add("grid__picker-list--over");
      const over = e.target.closest(".grid__picker-item");
      if (over && over.getAttribute("data-col") !== dragKey) {
        over.classList.add(halfAfter(over, e.clientY) ? "grid__picker-item--over-b" : "grid__picker-item--over-a");
      }
    });
    elPicker.addEventListener("drop", (e) => {
      if (!dragKey) return;
      const ul = e.target.closest(".grid__picker-list"); if (!ul) return;
      e.preventDefault();
      const over = e.target.closest(".grid__picker-item");
      let refKey = null, after = false;
      if (over && over.getAttribute("data-col") !== dragKey) {
        refKey = over.getAttribute("data-col"); after = halfAfter(over, e.clientY);
      }
      const key = dragKey; dragKey = null; clearMark();
      moveColumn(key, ul.getAttribute("data-zone"), refKey, after);
    });

    /* 바깥을 누르거나 Esc 를 누르면 닫는다. document 에 거는 만큼 destroy() 에서 반드시 뗀다
       — 한 페이지에 그리드를 여러 번 만들고 지우면 핸들러가 계속 쌓인다. */
    const onDocDown = (e) => {
      if (!state.pickOpen) return;
      if (e.target.closest(".grid__picker") || e.target.closest('[data-act="pick-toggle"]')) return;
      togglePicker(false);
    };
    const onDocKey = (e) => { if (e.key === "Escape" && state.pickOpen) togglePicker(false); };
    document.addEventListener("pointerdown", onDocDown, true);
    document.addEventListener("keydown", onDocKey);
    docOff.push(() => document.removeEventListener("pointerdown", onDocDown, true));
    docOff.push(() => document.removeEventListener("keydown", onDocKey));
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
    else if (act === "pick-toggle") { togglePicker(); }
    else if (act === "pick-close") { togglePicker(false); }
    else if (act === "pick-all") { cols.forEach((c) => state.hidden.delete(c.key)); applyColumns(); }
    else if (act === "pick-reset") { resetColumns(); }
    else if (act === "pick-item") { toggleColumn(t.getAttribute("data-col")); }
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
    const vc = vcols();                 // 안 보이는 열에는 붙지 않는다
    const editCols = vc.filter((c) => c.editable && c.pasteKey !== "none");
    const codeCol = vc.find((c) => c.pasteKey === "code");
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
    const vc = vcols();                 // 보이는 대로 내보낸다 — 화면과 파일이 다르면 그게 더 혼란스럽다
    // 헤더는 한 줄이다. 2단 헤더(groupHeader)에서 그룹이 있는 열은 "그룹 라벨"로 내야
    // 같은 하위열 이름(예: 「비율」)이 그룹마다 반복돼도 CSV 에서 구분된다. exportLabel 이 있으면 최우선.
    const header = vc.map((c) => c.exportLabel || (o.groupHeader && c.group ? `${c.group} ${c.label}` : c.label));
    const body = rows.map((r) => vc.map((c) => {
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
    /* 항목 고르기 — 구성 저장·복원은 화면이 한다(grid 는 저장소를 모른다) */
    getColumnState, setColumnState, resetColumns,
    showColumn(key, on) {
      const c = byKey[key]; if (!c) return;
      if (on === false) { if (canHide(c)) state.hidden.add(key); } else state.hidden.delete(key);
      applyColumns();
    },
    getVisibleColumns() { return vcols().map((c) => c.key); },
    openColumnPicker(on) { togglePicker(on == null ? true : on); },
    scrollToColumn, setCursor, getCursor() { return state.cur && Object.assign({}, state.cur); },
    focusTable() { elScroll.focus(); },
    destroy() { clearTimeout(inputTimer); docOff.forEach((f) => f()); root.innerHTML = ""; root.classList.remove("grid", "grid--bulk-on", "grid--fit"); },
  };

  render();
  return instance;
}

export { esc as gridEsc, isEmail as gridIsEmail };
