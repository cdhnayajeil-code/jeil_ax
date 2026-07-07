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
    onSave: null, onSelectionChange: null, onBulkAction: null,
    onRowAction: null, onCellEdit: null, onPaste: null,
  }, options);

  const cols = o.columns;
  const keyOf = (row, i) => (o.keyField ? row[o.keyField] : (row.__k != null ? row.__k : i));

  const state = {
    rows: [], view: [], selected: new Set(), dirty: new Map(),
    sort: { key: null, dir: 1 }, filters: {}, query: "",
    editMode: o.editable && !o.editToggle, loading: false, errors: new Map(),
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
    <div class="grid__scroll" data-el="scroll"><table class="grid__table"><thead data-el="thead"></thead><tbody data-el="tbody"></tbody></table></div>
    <div class="grid__footer"><span data-el="foot"></span></div>`;
  const $ = (sel) => root.querySelector(sel);
  const elScroll = $('[data-el="scroll"]'), elThead = $('[data-el="thead"]'), elTbody = $('[data-el="tbody"]');
  const elCount = $('[data-el="count"]'), elActions = $('[data-el="actions"]'), elFoot = $('[data-el="foot"]');

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
      const cls = ["grid__th", sortable ? "grid__th--sortable" : "", state.sort.key === c.key ? (state.sort.dir === 1 ? "grid__th--sorted-asc" : "grid__th--sorted-desc") : ""].join(" ");
      return `<th class="${cls}" data-act="${sortable ? "sort" : ""}" data-col="${esc(c.key)}" ${c.width ? `style="min-width:${c.width}"` : ""}>${esc(c.label)}${sortMark(c)}</th>`;
    }).join("");
    head += "</tr>";
    if (o.columnFilter) {
      head += `<tr class="grid__filter-row">`;
      if (o.selectable) head += `<th></th>`;
      head += cols.map((c) => {
        if (c.filter === false) return "<th></th>";
        if (c.type === "select" && c.options) {
          const opts = c.options.map((op) => `<option value="${esc(op.value ?? op)}">${esc(op.label ?? op)}</option>`).join("");
          return `<th><select data-act="filter" data-col="${esc(c.key)}"><option value="">전체</option>${opts}</select></th>`;
        }
        return `<th><input type="text" data-act="filter" data-col="${esc(c.key)}" placeholder="필터" value="${esc(state.filters[c.key] || "")}"></th>`;
      }).join("");
      head += "</tr>";
    }
    elThead.innerHTML = head;
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

  function render() { renderActions(); renderHead(); renderBody(); renderFooter(); }

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

  root.addEventListener("input", (e) => {
    const t = e.target.closest("[data-act]"); if (!t) return;
    const act = t.getAttribute("data-act");
    if (act === "search") { state.query = t.value; computeView(); renderBody(); renderFooter(); }
    else if (act === "filter") { state.filters[t.getAttribute("data-col")] = t.value; computeView(); renderBody(); renderFooter(); }
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
    exportCsv, copyToClipboard, destroy() { root.innerHTML = ""; root.classList.remove("grid", "grid--bulk-on"); },
  };

  render();
  return instance;
}

export { esc as gridEsc, isEmail as gridIsEmail };
