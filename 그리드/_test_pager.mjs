// 그리드/_test_pager.mjs — 표준 그리드 페이지 넘김 회귀 (§5.5 · REQ-0083)
// 실행:  npm i jsdom   후  node 그리드/_test_pager.mjs
//        (jsdom 은 저장소에 커밋하지 않는다 — 필요할 때 임시로 설치해 돌린다)
// 확인 범위: 페이저 렌더·페이지 이동·마지막 페이지·전량 합집합·버튼 잠금·표시행수 변경
//            ·검색 후 1페이지 복귀·CSV 전량 기준·전체선택 페이지 한정
//            ·회귀(pageSize 0 화면에 페이저 없음 / pager:false 옛 동작)
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// 저장소 루트(이 파일 기준 한 단계 위) — 어느 PC에서 클론해도 경로를 적을 필요가 없다
const ROOT = new URL("..", import.meta.url).pathname.replace(/^[/]([A-Za-z]:)/, "$1").replace(/[/]$/, "");
const dom = new JSDOM(`<!doctype html><html><body><div id="g"></div><div id="g2"></div></body></html>`, {
  url: "http://localhost/", pretendToBeVisual: true,
});
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
dom.window.ResizeObserver = globalThis.ResizeObserver;
for (const k of ["document", "Node", "Element", "HTMLElement", "CSS", "getComputedStyle", "requestAnimationFrame", "Event"]) {
  Object.defineProperty(globalThis, k, { value: dom.window[k], writable: true, configurable: true });
}
Object.defineProperty(globalThis, "window", { value: dom.window, writable: true, configurable: true });

const { createGrid } = await import(pathToFileURL(ROOT + "/app/lib/grid.js").href);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ✔ " + msg); } else { fail++; console.log("  ✘ " + msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} (얻음 ${JSON.stringify(a)} / 기대 ${JSON.stringify(b)})`);

const N = 5609;
const rows = Array.from({ length: N }, (_, i) => ({ id: i + 1, nm: "행" + (i + 1), grp: i % 4 === 0 ? "외주" : "원자재" }));
const columns = [{ key: "id", label: "NO." }, { key: "nm", label: "이름" }, { key: "grp", label: "구분" }];

console.log("\n[1] pageSize:300 — 페이저가 그려지고 페이지가 나뉜다");
const g = createGrid("#g", {
  columns, rows, keyField: "id", search: true, columnFilter: true, selectable: true,
  pageSize: 300, pageSizeOptions: [300, 1000, 0], exportCsv: true,
});
const el = document.getElementById("g");
const pager = el.querySelector(".grid__pager");
ok(!!pager && !pager.hidden, "페이저 DOM 이 있고 보인다");
eq(g.getPageCount(), Math.ceil(N / 300), "페이지 수 = ceil(5609/300)");
eq(el.querySelectorAll("tbody tr").length, 300, "1페이지 렌더 행수");
eq(el.querySelector("tbody tr").getAttribute("data-key"), "1", "1페이지 첫 행");

console.log("\n[2] 다음 페이지로 넘어간다 — 301행부터");
g.setPage(2);
eq(g.getPage(), 2, "현재 페이지");
eq(el.querySelector("tbody tr").getAttribute("data-key"), "301", "2페이지 첫 행 = 301");
eq(el.querySelectorAll("tbody tr").length, 300, "2페이지 렌더 행수");

console.log("\n[3] 마지막 페이지 — 나머지만 그린다");
g.setPage(999);
eq(g.getPage(), 19, "clamp 된 마지막 페이지");
eq(el.querySelectorAll("tbody tr").length, N - 18 * 300, "마지막 페이지 행수");
eq(el.querySelector("tbody tr").getAttribute("data-key"), String(18 * 300 + 1), "마지막 페이지 첫 행");

console.log("\n[4] 페이지를 끝까지 넘긴 합집합 = 전량(누락·중복 없음)");
const seen = new Set();
for (let p = 1; p <= g.getPageCount(); p++) { g.setPage(p); g.getPageRows().forEach((r) => seen.add(r.id)); }
eq(seen.size, N, "합집합 건수");

console.log("\n[5] 「처음/이전/다음/끝」 버튼이 실제로 동작한다");
g.setPage(1);
const btns = () => [...el.querySelectorAll('.grid__pager-btn[data-act="page-go"]')];
eq(btns().filter((b) => b.disabled).length, 2, "1페이지에서 처음·이전이 잠긴다");
btns().find((b) => b.getAttribute("title") === "다음 페이지").click();
eq(g.getPage(), 2, "「다음」 클릭 → 2페이지");
btns().find((b) => b.getAttribute("title") === "마지막 페이지").click();
eq(g.getPage(), 19, "「끝」 클릭 → 마지막");
eq(btns().filter((b) => b.disabled).length, 2, "마지막에서 다음·끝이 잠긴다");
btns().find((b) => b.getAttribute("title") === "첫 페이지").click();
eq(g.getPage(), 1, "「처음」 클릭 → 1페이지");

console.log("\n[6] 표시 행수 셀렉트 — 바꾸면 1페이지로 돌아간다");
g.setPage(5);
/* 셀렉트는 렌더마다 새로 만들어진다 — 참조를 들고 있으면 떨어져 나간 노드에 이벤트를 쏘게 된다 */
const pickShow = (v) => {
  const s = el.querySelector('[data-act="page-size"]');
  s.value = String(v); s.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
};
const sel0 = el.querySelector('[data-act="page-size"]');
ok(!!sel0, "「표시」 셀렉트가 있다");
eq(sel0.options.length, 3, "옵션 3개(300·1,000·전체)");
pickShow(1000);
eq(g.getPageSize(), 1000, "행수 변경 반영");
eq(g.getPage(), 1, "1페이지로 복귀");
eq(el.querySelectorAll("tbody tr").length, 1000, "1,000행 렌더");
pickShow(0);
eq(el.querySelectorAll("tbody tr").length, N, "「전체」는 전량 렌더");
eq(el.querySelector(".grid__pager-nav"), null, "「전체」에서는 페이지 버튼이 사라진다");
ok(!!el.querySelector('[data-act="page-size"]'), "「표시」 셀렉트는 남는다(다시 나눌 수 있게)");
g.setPageSize(300);

console.log("\n[7] 검색하면 1페이지로 가고 걸러진 건수로 다시 센다");
g.setPage(7);
const q = el.querySelector('[data-act="search"]');
q.value = "외주"; q.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
await new Promise((r) => setTimeout(r, 200));           // 검색 디바운스 120ms
const hit = rows.filter((r) => r.grp === "외주").length;
eq(g.getPage(), 1, "검색 후 1페이지");
eq(g.getPageCount(), Math.ceil(hit / 300), "걸러진 건수 기준 페이지 수");
ok(el.querySelector(".grid__pager-range").textContent.includes(hit.toLocaleString("ko-KR")), "페이저가 걸러진 총건수를 적는다");

console.log("\n[8] CSV·복사는 전량(걸러진 전량) 기준 — 페이지에 갇히지 않는다");
let csvText = "";
const RealBlob = globalThis.Blob;
globalThis.Blob = class { constructor(parts) { csvText = parts.join(""); this.size = csvText.length; } };
const realCreate = globalThis.URL.createObjectURL, realRevoke = globalThis.URL.revokeObjectURL;
globalThis.URL.createObjectURL = () => "blob:x";
globalThis.URL.revokeObjectURL = () => {};
dom.window.HTMLAnchorElement.prototype.click = function () {};
g.setPage(3);                                   // 3페이지를 보고 있어도 CSV 는 전량이어야 한다
g.exportCsv("t");
globalThis.Blob = RealBlob; globalThis.URL.createObjectURL = realCreate; globalThis.URL.revokeObjectURL = realRevoke;
const csvLines = csvText.replace(/\uFEFF/g, '').trim().split(/\r?\n/);
eq(csvLines.length, hit + 1, "CSV 줄수 = 걸러진 전량 + 헤더(페이지 300행이 아니다)");
eq(g.getPage(), 3, "CSV 내보내기가 페이지를 건드리지 않는다");
eq(g.getSelectedKeys().length, 0, "선택 없음(초기)");

console.log("\n[9] 전체선택은 현재 페이지 대상");
q.value = ""; q.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
await new Promise((r) => setTimeout(r, 200));
const selAll = el.querySelector('[data-act="sel-all"]');
selAll.checked = true; selAll.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
eq(g.getSelectedKeys().length, 300, "현재 페이지 300건만 선택");

console.log("\n[10] 회귀 — pageSize 0(기존 3화면) 에는 페이저가 없다");
const g2 = createGrid("#g2", { columns, rows: rows.slice(0, 50), keyField: "id", selectable: true, search: true });
const el2 = document.getElementById("g2");
ok(el2.querySelector(".grid__pager").hidden, "페이저가 숨겨져 있다");
eq(el2.querySelector(".grid__pager").innerHTML, "", "페이저 내용 없음");
eq(el2.querySelectorAll("tbody tr").length, 50, "전량 렌더");
eq(g2.getPage(), 1, "getPage() = 1");
eq(g2.getPageCount(), 1, "getPageCount() = 1");
const sa2 = el2.querySelector('[data-act="sel-all"]');
sa2.checked = true; sa2.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
eq(g2.getSelectedKeys().length, 50, "전체선택은 종전처럼 전량");

console.log("\n[11] 회귀 — pager:false 는 옛 동작(앞 N행, 페이저 없음)");
const el3 = document.createElement("div"); document.body.appendChild(el3);
const g3 = createGrid(el3, { columns, rows, keyField: "id", pageSize: 100, pager: false });
eq(el3.querySelectorAll("tbody tr").length, 100, "앞 100행만");
ok(el3.querySelector(".grid__pager").hidden, "페이저 없음");
eq(g3.getPageCount(), 1, "페이지 개념 없음");

console.log(`\n결과: 통과 ${pass} · 실패 ${fail}`);
process.exit(fail ? 1 : 0);
