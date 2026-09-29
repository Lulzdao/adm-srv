const { readZip, writeZip } = require("./zip");

// ============================================================================
//  Книги Excel: прочитать первый лист и собрать простую книгу
//
//  Читать нужно списки респондентов для рассылки — их выгружают из разных
//  систем, и приходят они чаще в .xlsx, чем в CSV. Собирать — ведомость
//  списания картриджей и выгрузку журнала техники.
//
//  Чтение нарочно простое: значения ячеек как текст, без формул и форматов.
//  ОКПО, записанный в ячейку числом, остаётся теми же цифрами, а не 1,2E+7.
// ============================================================================

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unxml(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return XML_ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Весь текст узла: у строки с разным оформлением частей текст разбит на
// несколько <t> внутри <r>, а фонетические подсказки (<rPh>) — не текст ячейки.
function textOf(xml) {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let s = "";
  for (const m of clean.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += m[1];
  return unxml(s);
}

/** «B12» -> 1 (номер колонки с нуля). */
function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref);
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[0]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Путь листа внутри архива из ссылки в workbook.xml.rels. */
function firstSheetPath(files) {
  const wb = files.get("xl/workbook.xml");
  const rels = files.get("xl/_rels/workbook.xml.rels");
  if (wb && rels) {
    const sheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb.toString("utf8"));
    if (sheet) {
      const rel = new RegExp(`<Relationship\\b[^>]*\\bId="${sheet[1]}"[^>]*>`).exec(rels.toString("utf8"));
      const target = rel && /Target="([^"]+)"/.exec(rel[0]);
      if (target) {
        const t = target[1].replace(/^\/?(xl\/)?/, "");
        const p = "xl/" + t;
        if (files.has(p)) return p;
      }
    }
  }
  return [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0] || null;
}

/**
 * Первый лист книги как массив строк, каждая строка — массив текстов.
 * Пустые ячейки внутри строки — пустые строки, чтобы колонки не съезжали.
 */
function readFirstSheet(buf) {
  let files;
  try { files = readZip(buf); } catch { throw new Error("Файл не открывается как книга Excel (.xlsx)"); }
  const sheetPath = firstSheetPath(files);
  if (!sheetPath) throw new Error("В книге нет ни одного листа");

  const shared = [];
  const ss = files.get("xl/sharedStrings.xml");
  if (ss) for (const m of ss.toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(m[1] ? textOf(m[1]) : "");

  const rows = [];
  const xml = files.get(sheetPath).toString("utf8");
  for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNum = /\br="(\d+)"/.exec(r[1]);
    const idx = rowNum ? Number(rowNum[1]) - 1 : rows.length;
    const cells = [];
    for (const c of (r[2] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs);
      const col = ref ? colIndex(ref[1]) : cells.length;
      const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1] || "n";
      const body = c[2] || "";
      let value = "";
      if (type === "inlineStr") value = textOf(body);
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        const raw = v ? unxml(v[1]) : "";
        if (type === "s") value = shared[Number(raw)] ?? "";
        else if (type === "b") value = raw === "1" ? "ИСТИНА" : raw === "0" ? "ЛОЖЬ" : raw;
        else if (type === "n" && /^-?\d+\.0+$/.test(raw)) value = raw.replace(/\.0+$/, "");
        else if (type === "n" && /^\d(\.\d+)?E\+\d+$/i.test(raw)) value = BigInt(Math.round(Number(raw))).toString();
        else value = raw;
      }
      while (cells.length < col) cells.push("");
      cells[col] = value;
    }
    while (rows.length < idx) rows.push([]);
    rows[idx] = cells;
  }
  return rows;
}

// ---------------------------------------------------------------------------
//  Сборка
// ---------------------------------------------------------------------------

const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
const xmlEscape = (v) => String(v ?? "").replace(CONTROL, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function colLetter(n) {
  let s = "";
  for (n = n + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Стили: 0 — обычный, 1 — шапка (полужирный, рамка, заливка), 2 — ячейка с
// рамкой и переносом, 3 — заголовок листа (крупный полужирный).
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="13"/><name val="Calibri"/></font></fonts>'
  + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFEDEFF3"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
  + '<border><left style="thin"><color rgb="FF9AA3AE"/></left><right style="thin"><color rgb="FF9AA3AE"/></right>'
  + '<top style="thin"><color rgb="FF9AA3AE"/></top><bottom style="thin"><color rgb="FF9AA3AE"/></bottom><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>'
  + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

function cellXml(ref, value, style) {
  const s = style ? ` s="${style}"` : "";
  if (value === null || value === undefined || value === "") return `<c r="${ref}"${s}/>`;
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function sheetXml({ title, subtitle, columns, rows, footer }) {
  const out = [];
  let r = 0;
  const line = (values, style) => {
    r++;
    out.push(`<row r="${r}">${values.map((v, i) => cellXml(colLetter(i) + r, v, style)).join("")}</row>`);
  };
  if (title) line([title], 3);
  if (subtitle) line([subtitle], 0);
  if (title || subtitle) line([], 0);
  const headRow = r + 1;
  line(columns.map((c) => c.title), 1);
  for (const row of rows) line(row, 2);
  for (const f of footer || []) line(f, 0);

  const cols = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join("");
  const pane = `<pane ySplit="${headRow}" topLeftCell="A${headRow + 1}" activePane="bottomLeft" state="frozen"/>`;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>`
    + `<cols>${cols}</cols><sheetData>${out.join("")}</sheetData>`
    + '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>'
    + '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>'
    + "</worksheet>";
}

/**
 * Книга из одного или нескольких листов.
 * sheets: [{ name, title?, subtitle?, columns: [{title, width}], rows: [[...]], footer?: [[...]] }]
 * Числа пишутся числами (их можно складывать в Excel), остальное — текстом.
 */
function buildXlsx(sheets, now = new Date()) {
  // Имя листа: не длиннее 31 знака и без []:*?/\ — иначе Excel откажется открыть.
  const names = sheets.map((s, i) => String(s.name || `Лист${i + 1}`).replace(/[[\]:*?/\\]/g, " ").slice(0, 31));
  const entries = [
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
      + "</Types>"],
    ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + "</Relationships>"],
    ["xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")
      + "</sheets></workbook>"],
    ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")
      + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + "</Relationships>"],
    ["xl/styles.xml", STYLES],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return writeZip(entries, now);
}

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

module.exports = { readFirstSheet, buildXlsx, XLSX_TYPE, colLetter, unxml };
