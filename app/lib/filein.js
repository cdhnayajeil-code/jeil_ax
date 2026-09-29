// app/lib/filein.js — 에이전트 첨부 파일 읽기(바닐라 ESM, 의존성 0 · 외부 라이브러리/CDN 없음) · REQ-0089
//   readAttachment(file) → { ok, part, label } | { ok:false, error }
//     part = { kind:"text", name, text }                 — CSV·TSV·TXT·MD·JSON·SQL·HTML·엑셀(xlsx)·워드(docx)를 **브라우저에서 글자로** 푼다
//          | { kind:"image", name, media, data(base64) }  — PNG·JPG·GIF·WEBP
//          | { kind:"pdf",   name, data(base64) }         — PDF 원본(Claude 가 직접 읽는다)
//   원칙: 파일은 서버에 저장하지 않는다. 질문과 함께 모델에 보내고, 기록에는 이름·크기만 남는다(서버 agent_turn.attachments).
//   xlsx·docx 는 ZIP 이다 — 브라우저 내장 DecompressionStream('deflate-raw') 로 푼다(라이브러리 불필요).

export const ACCEPT = ".csv,.tsv,.txt,.md,.json,.sql,.log,.xml,.html,.htm,.xlsx,.xlsm,.docx,.pdf,.png,.jpg,.jpeg,.gif,.webp";
const LIMIT = { text: 20 * 1024 * 1024, image: 5 * 1024 * 1024, pdf: 8 * 1024 * 1024 };
const MAX_CHARS = 60000;          // 서버 상한과 같다 — 넘으면 서버가 자른다
const MAX_ROWS = 3000, MAX_SHEETS = 5;

const ext = (n) => (String(n).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || "";
const kb = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(n / 1024)) + "KB";

export async function readAttachment(file) {
  const e = ext(file.name);
  try {
    if (["png", "jpg", "jpeg", "gif", "webp"].includes(e)) {
      if (file.size > LIMIT.image) return { ok: false, error: `${file.name}: 이미지는 5MB 이하만 됩니다.` };
      const media = e === "jpg" ? "image/jpeg" : "image/" + e;
      return { ok: true, part: { kind: "image", name: file.name, media, data: await b64(file) }, label: `이미지 ${kb(file.size)}` };
    }
    if (e === "pdf") {
      if (file.size > LIMIT.pdf) return { ok: false, error: `${file.name}: PDF 는 8MB 이하만 됩니다.` };
      return { ok: true, part: { kind: "pdf", name: file.name, data: await b64(file) }, label: `PDF ${kb(file.size)}` };
    }
    if (file.size > LIMIT.text) return { ok: false, error: `${file.name}: 20MB 이하 파일만 됩니다.` };
    if (e === "xlsx" || e === "xlsm") { const r = await readXlsx(await file.arrayBuffer()); return textPart(file.name, r.text, r.label); }
    if (e === "docx") { const t = await readDocx(await file.arrayBuffer()); return textPart(file.name, t, `워드 ${t.length.toLocaleString()}자`); }
    if (["csv", "tsv", "txt", "md", "json", "sql", "log", "xml", "html", "htm"].includes(e)) {
      const t = decodeText(await file.arrayBuffer());
      const rows = t.split("\n").length;
      return textPart(file.name, t, (e === "csv" || e === "tsv") ? `표 ${rows.toLocaleString()}행` : `${t.length.toLocaleString()}자`);
    }
    if (e === "xls") return { ok: false, error: `${file.name}: 옛 엑셀(.xls)은 읽지 못합니다. 엑셀에서 「다른 이름으로 저장 → .xlsx」 후 올려 주세요.` };
    if (e === "hwp" || e === "hwpx") return { ok: false, error: `${file.name}: 한글 파일은 PDF 로 저장해 올려 주세요.` };
    if (e === "pptx" || e === "ppt" || e === "doc") return { ok: false, error: `${file.name}: 이 형식은 아직 못 읽습니다. PDF 로 저장해 올려 주세요.` };
    return { ok: false, error: `${file.name}: 지원하지 않는 형식입니다(엑셀·CSV·워드·PDF·이미지·텍스트).` };
  } catch (err) {
    return { ok: false, error: `${file.name}: 읽기 실패 — ${err && err.message ? err.message : err}` };
  }
}
function textPart(name, text, label) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, error: `${name}: 읽을 내용이 없습니다.` };
  const cut = t.length > MAX_CHARS;
  return { ok: true, part: { kind: "text", name, text: t }, label: label + (cut ? ` · 앞 ${MAX_CHARS.toLocaleString()}자만 전달` : "") };
}

/** UTF-8(BOM 포함) 우선, 깨지면 EUC-KR(엑셀이 저장한 한글 CSV). */
export function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(u8).replace(/^﻿/, ""); }
  catch (e) { return new TextDecoder("euc-kr").decode(u8); }
}
function b64(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).replace(/^data:[^,]*,/, ""));
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(file);
  });
}

/* ───── ZIP(읽기 전용 · stored/deflate) ───── */
export async function unzip(buf) {
  const dv = new DataView(buf); const u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error("ZIP 형식이 아닙니다");
  const count = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
  const files = new Map(); const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    const dstart = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    files.set(name, { method, data: u8.subarray(dstart, dstart + csize) });
    p += 46 + nlen + elen + clen;
  }
  return {
    has: (n) => files.has(n),
    async text(n) {
      const f = files.get(n); if (!f) return null;
      if (f.method === 0) return dec.decode(f.data);
      if (f.method !== 8) throw new Error("지원하지 않는 압축 방식");
      const out = await new Response(new Blob([f.data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
      return dec.decode(out);
    },
  };
}
const xml = (s) => new DOMParser().parseFromString(s, "application/xml");
const kids = (el, local) => Array.from(el.children || []).filter((c) => c.localName === local);
const all = (el, local) => Array.from(el.getElementsByTagNameNS("*", local));

/* ───── 엑셀(xlsx) → 시트별 TSV ───── */
export async function readXlsx(buf) {
  const z = await unzip(buf);
  const wb = xml(await z.text("xl/workbook.xml") || "<x/>");
  const rels = xml(await z.text("xl/_rels/workbook.xml.rels") || "<x/>");
  const target = {}; all(rels, "Relationship").forEach((r) => { target[r.getAttribute("Id")] = r.getAttribute("Target"); });
  const ss = [];
  const sst = await z.text("xl/sharedStrings.xml");
  if (sst) all(xml(sst), "si").forEach((si) => ss.push(all(si, "t").map((t) => t.textContent).join("")));
  // 날짜 서식 판별(셀 스타일 → numFmtId) — 엑셀 날짜는 일련번호라 그대로 두면 "46023" 처럼 보인다
  const dateStyle = new Set();
  const st = await z.text("xl/styles.xml");
  if (st) {
    const sd = xml(st); const custom = {};
    all(sd, "numFmt").forEach((f) => { custom[f.getAttribute("numFmtId")] = f.getAttribute("formatCode") || ""; });
    const xfs = all(sd, "cellXfs")[0];
    if (xfs) kids(xfs, "xf").forEach((xf, i) => {
      const id = +xf.getAttribute("numFmtId");
      const code = (custom[id] || "").replace(/"[^"]*"|\[[^\]]*\]/g, "");
      if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[yd]/i.test(code) || (/m/i.test(code) && /[yd]/i.test(code))) dateStyle.add(i);
    });
  }
  const serialToDate = (n) => { const d = new Date(Math.round((n - 25569) * 86400000)); return isNaN(d) ? String(n) : d.toISOString().slice(0, n % 1 ? 16 : 10).replace("T", " "); };
  const colIx = (ref) => { let n = 0; for (const ch of String(ref).replace(/\d+/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  const sheets = all(wb, "sheet").slice(0, MAX_SHEETS);
  let text = "", rowsTotal = 0, cut = false;
  for (const sh of sheets) {
    const rid = sh.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || sh.getAttribute("r:id");
    let path = target[rid] || ""; path = path.startsWith("/") ? path.slice(1) : "xl/" + path.replace(/^\.\//, "");
    const sx = await z.text(path); if (!sx) continue;
    const doc = xml(sx); const rows = all(doc, "row");
    const lines = [];
    for (const row of rows.slice(0, MAX_ROWS)) {
      const cells = [];
      kids(row, "c").forEach((c) => {
        const t = c.getAttribute("t"); const s = +c.getAttribute("s"); const v = kids(c, "v")[0];
        let val = "";
        if (t === "s") val = ss[+(v ? v.textContent : -1)] ?? "";
        else if (t === "inlineStr") val = all(c, "t").map((x) => x.textContent).join("");
        else if (t === "b") val = v && v.textContent === "1" ? "TRUE" : "FALSE";
        else if (v) val = (!t || t === "n") && dateStyle.has(s) && !isNaN(+v.textContent) ? serialToDate(+v.textContent) : v.textContent;
        cells[colIx(c.getAttribute("r"))] = String(val).replace(/[\t\r\n]+/g, " ");
      });
      if (cells.some((x) => x !== undefined && x !== "")) lines.push(Array.from(cells, (x) => x ?? "").join("\t"));
    }
    if (rows.length > MAX_ROWS) cut = true;
    rowsTotal += lines.length;
    text += `### 시트: ${sh.getAttribute("name")} (${lines.length.toLocaleString()}행${rows.length > MAX_ROWS ? ` · 전체 ${rows.length.toLocaleString()}행 중 앞부분` : ""})\n` + lines.join("\n") + "\n\n";
  }
  const more = all(wb, "sheet").length - sheets.length;
  return { text: text.trim() + (more > 0 ? `\n(시트 ${more}개 더 있음 — 앞 ${MAX_SHEETS}개만 읽음)` : ""),
    label: `엑셀 ${sheets.length}시트 ${rowsTotal.toLocaleString()}행${cut ? "(일부)" : ""}` };
}

/* ───── 워드(docx) → 문단·표 텍스트 ───── */
export async function readDocx(buf) {
  const z = await unzip(buf);
  const doc = xml(await z.text("word/document.xml") || "<x/>");
  const body = all(doc, "body")[0]; if (!body) return "";
  const para = (p) => Array.from(p.getElementsByTagNameNS("*", "*")).map((n) =>
    n.localName === "t" ? n.textContent : n.localName === "tab" ? "\t" : (n.localName === "br" ? "\n" : "")).join("");
  const out = [];
  for (const el of Array.from(body.children)) {
    if (el.localName === "p") out.push(para(el));
    else if (el.localName === "tbl") {
      kids(el, "tr").forEach((tr) => out.push(kids(tr, "tc").map((tc) => kids(tc, "p").map(para).join(" ").replace(/\t/g, " ")).join("\t")));
      out.push("");
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
