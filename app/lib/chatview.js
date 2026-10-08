// app/lib/chatview.js — 챗봇 응답 렌더 공용 모듈(바닐라 ESM, 의존성 0) · REQ-0087
//   renderMd(텍스트)      : 마크다운(표·목록·굵게·링크·코드) → HTML. 보안 원칙: escHtml 먼저 → 문법 치환(raw HTML 미지원)
//   renderView(host, v)   : 서버가 보낸 구조화 뷰 5종(series·ranking·record·list·notice, ADR-008) → 카드. 값은 전부 textContent
//                           list 열: link(https 만)·linkLabel(기본 「열기 ↗」)·wrap(긴 글 줄바꿈) · record 칸: long(한 줄 전체 폭 · 줄바꿈 보존) — 2026-10-08 REQ-0124 2차
//   viewTable(v)          : 카드 → {title, head[], rows[][], num[]} — CSV·보고서가 **서버 데이터 그대로** 쓰게(모델 문장 아님)
//   toCsv(t) · reportHtml({...}) · downloadText(name, text, type)
// 원본: 04 포털 챗봇 renderMd/renderView → app/chat-lab.html 사본(REQ-0084). 새 화면은 이 모듈을 쓴다(13 기획 P1 후속 — 실험실도 옮길 예정).
// 스타일: app/lib/chatview.css (.cv- 스코프만)

export function escHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
const SENT = String.fromCharCode(0xE000);
function mdInline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, c) => { codes.push(c); return SENT + (codes.length - 1) + SENT; });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)"']+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s.replace(new RegExp(SENT + "(\\d+)" + SENT, "g"), (_m, i) => "<code>" + codes[+i] + "</code>");
}
export function renderMd(src) {
  const lines = escHtml(src).split("\n");
  const out = []; let para = []; let i = 0; const n = lines.length;
  const flush = () => { if (para.length) { out.push('<div class="cv-p">' + para.map(mdInline).join("<br>") + "</div>"); para = []; } };
  const isSep = (t) => /^[|\s:-]+$/.test(t) && t.includes("-") && t.includes("|");
  const cells = (t) => { if (t[0] === "|") t = t.slice(1); if (t[t.length - 1] === "|") t = t.slice(0, -1); return t.split("|").map((c) => c.trim()); };
  while (i < n) {
    const t = lines[i].trim();
    if (!t) { flush(); i++; continue; }
    if (/^```/.test(t)) {
      flush(); const code = []; const lang = (/^```\s*([A-Za-z0-9_+-]+)/.exec(t) || [])[1] || ""; i++;
      while (i < n && !/^```/.test(lines[i].trim())) { code.push(lines[i]); i++; }
      i++; out.push('<pre class="cv-pre" data-lang="' + lang.toLowerCase() + '"><code>' + code.join("\n") + "</code></pre>"); continue;
    }
    if (t.includes("|") && i + 1 < n && isSep(lines[i + 1].trim())) {
      flush(); const head = cells(t); i += 2; const body = [];
      while (i < n && lines[i].includes("|") && lines[i].trim()) { body.push(cells(lines[i])); i++; }
      const th = "<tr>" + head.map((c) => '<th scope="col">' + mdInline(c) + "</th>").join("") + "</tr>";
      const tb = body.map((r) => "<tr>" + r.map((c) => {
        const num = /\d/.test(c) && /^[\d,.\s%원명건억만개±+~-]*$/.test(c);
        return "<td" + (num ? ' class="r"' : "") + ">" + mdInline(c) + "</td>";
      }).join("") + "</tr>").join("");
      out.push('<div class="cv-tblwrap"><table>' + th + tb + "</table></div>"); continue;
    }
    const mh = /^#{1,4}\s+(.+)$/.exec(t);
    if (mh) { flush(); out.push("<h4>" + mdInline(mh[1]) + "</h4>"); i++; continue; }
    if (/^-{3,}$/.test(t)) { flush(); out.push('<hr class="cv-hr">'); i++; continue; }
    if (/^&gt;\s?/.test(t)) {
      flush(); const q = [];
      while (i < n && /^&gt;\s?/.test(lines[i].trim())) { q.push(lines[i].trim().replace(/^&gt;\s?/, "")); i++; }
      out.push('<div class="cv-quote">' + q.map(mdInline).join("<br>") + "</div>"); continue;
    }
    if (/^([-*]|\d+[.)])\s+/.test(t)) {
      flush(); const ordered = /^\d/.test(t); const items = [];
      while (i < n) {
        const lt = lines[i]; const mm = /^([-*]|\d+[.)])\s+(.+)$/.exec(lt.trim());
        if (!mm) break;
        const sub = /^\s{2,}/.test(lt);
        if (!sub && /^\d/.test(mm[1]) !== ordered) break;
        if (!sub || !items.length) items.push({ txt: mm[2], subs: [] }); else items[items.length - 1].subs.push(mm[2]);
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push("<" + tag + ">" + items.map((it) => "<li>" + mdInline(it.txt) +
        (it.subs.length ? "<ul>" + it.subs.map((s2) => "<li>" + mdInline(s2) + "</li>").join("") + "</ul>" : "") + "</li>").join("") + "</" + tag + ">");
      continue;
    }
    para.push(t); i++;
  }
  flush();
  return out.join("");
}

/* ===== AI 가 쓴 코드 블록 — 복사 · HTML 은 바로 열어 보기 =====
   보안: AI 가 만든 HTML 은 **믿지 않는다.** 이 화면과 같은 출처(origin)에서 그리면 그 안의 스크립트가 로그인 토큰
   (localStorage)을 읽을 수 있다. 그래서 미리보기·새 탭 모두 sandbox iframe(스크립트·같은 출처 권한 없음)의 srcdoc 로만 그린다. */
const isHtmlCode = (lang, text) => lang === "html" || lang === "htm" || /^\s*(<!doctype html|<html[\s>])/i.test(text);
/** 저장·내려받기용 — 스크립트·이벤트 속성·javascript: 링크·iframe 류를 걷어낸다(서버도 같은 기준으로 거부한다). */
export function stripActive(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "").replace(/<script[^>]*>/gi, "")
    .replace(/<(iframe|object|embed)[\s\S]*?(<\/\1\s*>|\/>|>)/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");
}
const sandboxFrame = (html) => {
  const f = document.createElement("iframe");
  f.setAttribute("sandbox", "");                 // 스크립트·폼·팝업·같은 출처 전부 차단
  f.setAttribute("referrerpolicy", "no-referrer");
  f.srcdoc = html;                               // 속성 대입 — 문자열 이어붙이기 없음
  return f;
};
/** 화면 안 미리보기 창 */
export function previewHtml(html, title) {
  const m = el("div", "cv-modal"); const box = el("div", "cv-modal-box"); const hd = el("div", "cv-modal-hd");
  hd.appendChild(el("span", null, "👁 " + (title || "HTML 미리보기")));
  hd.appendChild(el("small", null, "스크립트는 실행되지 않습니다"));
  hd.appendChild(el("span", "sp"));
  const mk = (label, fn) => { const b = el("button", "cv-act", label); b.type = "button"; b.onclick = fn; hd.appendChild(b); };
  mk("↗ 새 탭", () => openHtmlTab(html, title));
  mk("⬇ 내려받기", () => downloadText(safeName(title) + ".html", stripActive(html), "text/html;charset=utf-8"));
  mk("✕ 닫기", () => close());
  box.append(hd, sandboxFrame(html)); m.appendChild(box);
  const close = () => { m.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  m.onclick = (e) => { if (e.target === m) close(); };
  document.addEventListener("keydown", onKey);
  document.body.appendChild(m);
}
/** 새 탭 — 껍데기 페이지만 이 출처에서 만들고, AI HTML 은 그 안의 sandbox iframe 에 넣는다. */
export function openHtmlTab(html, title) {
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.open();
  w.document.write('<!doctype html><html lang="ko"><head><meta charset="utf-8"><title></title><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style></head><body></body></html>');
  w.document.close();
  w.document.title = title || "미리보기";
  w.document.body.appendChild(sandboxFrame(html));
  return true;
}
const safeName = (s) => String(s || "자료").replace(/[\\/:*?"<>|]/g, " ").trim().slice(0, 60) || "자료";

/** 렌더된 답변(root) 안의 코드 블록마다 도구줄을 단다. 스트리밍이 **끝난 뒤** 한 번 부른다(innerHTML 재렌더 때 사라지므로).
 *  opts.title — 파일·창 제목 · opts.onSave(html) — 자료함 저장(있을 때만 버튼 표시) */
export function attachCodeActions(root, opts = {}) {
  root.querySelectorAll("pre.cv-pre").forEach((pre, ix) => {
    if (pre.dataset.bar) return; pre.dataset.bar = "1";
    const text = pre.textContent;                  // 이스케이프 풀린 원문
    const lang = pre.dataset.lang || "";
    const html = isHtmlCode(lang, text);
    const bar = el("div", "cv-codebar");
    bar.appendChild(el("span", "lang", html ? "HTML" : (lang || "코드").toUpperCase()));
    const mk = (label, fn, sub) => { const b = el("button", sub ? "sub" : null, label); b.type = "button"; b.onclick = () => fn(b); bar.appendChild(b); };
    const title = (opts.title || "자료") + (ix ? `_${ix + 1}` : "");
    if (html) {
      mk("👁 바로 보기", () => previewHtml(text, title));
      mk("↗ 새 탭", () => { if (!openHtmlTab(text, title)) previewHtml(text, title); });
      mk("⬇ 내려받기", () => downloadText(safeName(title) + ".html", stripActive(text), "text/html;charset=utf-8"), true);
      if (opts.onSave) mk("📁 자료함 저장", async (b) => { b.disabled = true; try { await opts.onSave(stripActive(text), title); b.textContent = "✓ 저장됨"; } catch (e) { b.disabled = false; } }, true);
      // HTML 코드는 길어서 대화를 밀어낸다 — 접어 두고 필요하면 펼친다
      pre.classList.add("fold");
      mk("코드 펼치기", (b) => { const f = pre.classList.toggle("fold"); b.textContent = f ? "코드 펼치기" : "코드 접기"; }, true);
    }
    mk("⧉ 복사", async (b) => { try { await navigator.clipboard.writeText(text); b.textContent = "✓ 복사됨"; } catch (e) { b.textContent = "복사 실패"; } setTimeout(() => { b.textContent = "⧉ 복사"; }, 1500); }, true);
    pre.parentNode.insertBefore(bar, pre);
  });
}

const numFmt = (v) => (typeof v === "number" && isFinite(v)) ? v.toLocaleString("ko-KR") : String(v == null ? "-" : v);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
export function fmtKST(iso) { try { return new Date(iso).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch (e) { return iso || ""; } }

/** 카드 → 표 데이터. 서버 데이터만 쓴다(모델이 쓴 문장은 들어가지 않는다). */
export function viewTable(v) {
  if (!v || !v.view) return null;
  if (v.view === "series" && Array.isArray(v.rows)) return { title: v.title, head: ["구분", v.unit ? `값(${v.unit})` : "값"], num: [false, true], rows: v.rows.map((r) => [r.k, Number(r.v)]) };
  if (v.view === "ranking" && Array.isArray(v.rows)) return { title: v.title, head: ["순위", "항목", "비고", v.unit ? `값(${v.unit})` : "값"], num: [true, false, false, true], rows: v.rows.map((r) => [r.rank, r.label, r.sub || "", Number(r.v)]) };
  if (v.view === "record" && Array.isArray(v.fields)) return { title: v.title, head: ["항목", "값"], num: [false, false], rows: v.fields.map((f) => [f.k, f.v]) };
  if (v.view === "list" && Array.isArray(v.columns) && Array.isArray(v.rows)) return { title: v.title, head: v.columns.map((c) => c.label || c.key), num: v.columns.map((c) => !!c.num), rows: v.rows.map((r) => v.columns.map((c) => r ? r[c.key] : "")) };
  return null;
}
/** CSV(UTF-8 BOM — 엑셀 한글 깨짐 방지, CLAUDE.md §13.5) */
export function toCsv(t) {
  const q = (x) => { const s = x == null ? "" : String(x); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return "﻿" + [t.head, ...t.rows].map((r) => r.map(q).join(",")).join("\r\n");
}
export function downloadText(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: type || "text/plain;charset=utf-8" }));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/** 인쇄용 보고서 HTML — 스크립트 없음(서버가 script·on* 속성을 거부한다). 표 = 카드 데이터, 해설 = 모델 문장(renderMd). */
export function reportHtml({ title, author, asOf, narrative, tables, footnote }) {
  const tbl = (t) => '<h3>' + escHtml(t.title || "") + '</h3><table><tr>' + t.head.map((h) => "<th>" + escHtml(h) + "</th>").join("") + "</tr>" +
    t.rows.map((r) => "<tr>" + r.map((c, i) => '<td class="' + (t.num[i] ? "r" : "") + '">' + escHtml(typeof c === "number" ? c.toLocaleString("ko-KR") : (c == null ? "" : c)) + "</td>").join("") + "</tr>").join("") + "</table>";
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escHtml(title) + "</title>" +
    "<style>body{font-family:'Malgun Gothic','맑은 고딕',sans-serif;color:#222;max-width:960px;margin:24px auto;padding:0 16px;font-size:13.5px;line-height:1.65}" +
    "h1{font-size:20px;color:#1a2f4e;border-bottom:2px solid #1a2f4e;padding-bottom:8px}h3{font-size:14px;color:#1a2f4e;margin:18px 0 6px}h4{margin:10px 0 4px}" +
    "table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{border:1px solid #cfd6e0;padding:4px 8px;text-align:left}th{background:#eef2f8}td.r{text-align:right}" +
    ".meta{color:#666;font-size:12px}.foot{margin-top:22px;color:#777;font-size:11.5px;border-top:1px solid #ddd;padding-top:8px}.cv-p{margin:4px 0}" +
    "@media print{body{margin:0}}</style></head><body>" +
    "<h1>" + escHtml(title) + '</h1><div class="meta">작성: ' + escHtml(author || "") + " · 기준 " + escHtml(asOf || "") + " · 구매 에이전트 생성(초안)</div>" +
    (narrative ? "<h3>해설</h3>" + renderMd(narrative) : "") + tables.map(tbl).join("") +
    '<div class="foot">' + escHtml(footnote || "표의 수치는 ERP 중간DB 조회 결과 그대로이며, 해설 문단은 AI 가 작성한 초안입니다. 확정 전 원본을 확인하세요.") + "</div></body></html>";
}

/** 구조화 뷰 카드. opts.onAsk(prompt) — 「💬」 버튼, opts.extraActions(v) → [{label, onClick}] — 화면이 붙이는 버튼(CSV·자료함) */
export function renderView(host, v, opts = {}) {
  if (!v || !v.view) return null;
  const card = el("div", "cv-card cv-" + v.view);
  if (v.title) card.appendChild(el("div", "cv-title", String(v.title)));
  const table = () => { const w = el("div", "cv-tblwrap"); const t = document.createElement("table"); t.className = "cv-table"; w.appendChild(t); return { w, t }; };
  const th = (tr, label, right) => { const h = el("th", right ? "r" : null, label); h.setAttribute("scope", "col"); tr.appendChild(h); };
  if (v.view === "series" && Array.isArray(v.rows)) {
    let max = 0; v.rows.forEach((r) => { const x = Number(r.v); if (isFinite(x) && x > max) max = x; });
    const { w, t } = table(); const hr = document.createElement("tr");
    th(hr, "구분"); th(hr, v.unit ? "값(" + v.unit + ")" : "값", true); th(hr, ""); t.appendChild(hr);
    v.rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.appendChild(el("td", null, String(r.k))); tr.appendChild(el("td", "r", numFmt(Number(r.v))));
      const bc = el("td", "cv-barcell"); const b = el("div", "cv-bar");
      b.style.width = (max > 0 ? Math.max(2, Math.round(Number(r.v) / max * 100)) : 0) + "%"; bc.appendChild(b); tr.appendChild(bc); t.appendChild(tr);
    });
    card.appendChild(w);
  } else if (v.view === "ranking" && Array.isArray(v.rows)) {
    const { w, t } = table(); const hr = document.createElement("tr");
    th(hr, "순위"); th(hr, "항목"); th(hr, v.unit ? "값(" + v.unit + ")" : "값", true); t.appendChild(hr);
    v.rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.appendChild(el("td", "cv-rank", String(r.rank)));
      const td = el("td", null, String(r.label));
      if (r.sub) { td.appendChild(document.createElement("br")); td.appendChild(el("small", "cv-sub", String(r.sub))); }
      tr.appendChild(td); tr.appendChild(el("td", "r", numFmt(Number(r.v)))); t.appendChild(tr);
    });
    card.appendChild(w);
  } else if (v.view === "record" && Array.isArray(v.fields)) {
    const g = el("div", "cv-fields");
    v.fields.forEach((f) => {
      const row = el("div", "cv-field" + (f.long ? " long" : "")); row.appendChild(el("span", "cv-k", String(f.k)));
      const vw = el("span", "cv-v", String(f.v));
      if (f.gap) { const gb = el("span", "cv-gap", "⚠ " + String(f.gap)); if (f.gap_why) gb.title = String(f.gap_why); vw.appendChild(gb); }
      row.appendChild(vw); g.appendChild(row);
    });
    card.appendChild(g);
    if (v.steps && Array.isArray(v.steps.labels)) {
      const sp = el("div", "cv-steps");
      v.steps.labels.forEach((lb, ix) => {
        sp.appendChild(el("span", "cv-step" + (ix < v.steps.current ? " done" : ix === v.steps.current ? " cur" : ""), String(lb)));
        if (ix < v.steps.labels.length - 1) sp.appendChild(el("span", "cv-arrow", "→"));
      });
      card.appendChild(sp);
    }
  } else if (v.view === "list" && Array.isArray(v.columns) && Array.isArray(v.rows)) {
    const { w, t } = table(); const hr = document.createElement("tr");
    v.columns.forEach((c) => th(hr, String(c.label != null ? c.label : c.key), !!c.num)); t.appendChild(hr);
    v.rows.forEach((r) => {
      const tr = document.createElement("tr");
      v.columns.forEach((c) => {
        const val = r ? r[c.key] : null; const td = el("td", [c.num ? "r" : "", c.wrap ? "wrap" : ""].filter(Boolean).join(" ") || null);
        if (c.link && typeof val === "string" && /^https:\/\//.test(val)) { const a = document.createElement("a"); a.href = val; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = c.linkLabel ? String(c.linkLabel) : "열기 ↗"; td.appendChild(a); }
        else if (typeof val === "number") td.textContent = numFmt(val);
        else td.textContent = val == null ? "-" : String(val);
        tr.appendChild(td);
      });
      t.appendChild(tr);
    });
    card.appendChild(w);
  } else if (v.view === "notice") {
    const nb = el("div", "cv-notice-body");
    nb.appendChild(el("span", null, v.kind === "deny" ? "🔒" : "ℹ️")); nb.appendChild(el("span", null, String(v.text || "")));
    card.appendChild(nb);
  } else return null;
  const ab = el("div", "cv-actions");
  (Array.isArray(v.actions) ? v.actions : []).slice(0, 4).forEach((a) => {
    if (!a || !a.label) return;
    if (a.kind === "link" && typeof a.url === "string" && (/^https:\/\//.test(a.url) || /^\/[a-z]/.test(a.url))) {
      const l = document.createElement("a"); l.className = "cv-act"; l.href = a.url; l.target = "_blank"; l.rel = "noopener noreferrer"; l.textContent = "↗ " + String(a.label); ab.appendChild(l);
    } else if (a.kind === "ask" && typeof a.prompt === "string" && a.prompt.length > 0 && a.prompt.length <= 500 && opts.onAsk) {
      const b = el("button", "cv-act", "💬 " + String(a.label)); b.type = "button"; b.onclick = () => opts.onAsk(a.prompt); ab.appendChild(b);
    }
  });
  (opts.extraActions ? opts.extraActions(v) : []).forEach((x) => {
    const b = el("button", "cv-act sub", x.label); b.type = "button"; b.onclick = () => x.onClick(b); ab.appendChild(b);
  });
  if (ab.childNodes.length) card.appendChild(ab);
  const foot = [];
  if (v.asOf) foot.push("기준 " + fmtKST(v.asOf));
  if (v.note) foot.push(String(v.note));
  if (foot.length) card.appendChild(el("div", "cv-foot", foot.join(" · ")));
  host.appendChild(card);
  return card;
}
