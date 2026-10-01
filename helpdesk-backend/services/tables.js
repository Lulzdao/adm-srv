const { readFirstSheet } = require("./xlsx");

// ============================================================================
//  Табличный файл от человека: CSV или XLSX -> строки
//
//  Списки приходят откуда угодно: выгрузка из системы в CSV в кодировке
//  Windows, тот же список, пересохранённый в Excel, таблица, собранная руками.
//  Разбираем всё это в одно — массив строк из текстовых ячеек, — а смысл
//  колонок определяет уже вызывающий по заголовку.
// ============================================================================

/**
 * Текст из байтов. Если это корректный UTF-8 — он, иначе — Windows-1251: так
 * сохраняет CSV русский Excel. Проверка честная (fatal), а не «похоже ли»:
 * байты 1251 почти никогда не складываются в допустимый UTF-8.
 */
function decodeText(buf) {
  let b = buf;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return new TextDecoder("windows-1251").decode(b);
  }
}

/** Разделитель — тот, что чаще встречается в первых строках вне кавычек. */
function guessDelimiter(text) {
  const head = text.split(/\r?\n/).slice(0, 10).join("\n").replace(/"[^"]*"/g, "");
  const counts = [";", ",", "\t"].map((d) => [d, head.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ";";
}

/** CSV по RFC 4180: кавычки, удвоенные кавычки, переводы строк внутри кавычек. */
function parseCsv(text, delimiter = guessDelimiter(text)) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * Файл -> строки. Формат определяется по содержимому, а не по расширению:
 * xlsx — это zip, он начинается с «PK». Старый .xls (двоичный формат Excel
 * 97) не разбираем — просим пересохранить, это честнее, чем гадать.
 */
function readTable(buf, filename = "") {
  if (!buf || !buf.length) throw new Error("Файл пустой");
  if (buf[0] === 0x50 && buf[1] === 0x4b) return clean(readFirstSheet(buf));
  if (buf[0] === 0xd0 && buf[1] === 0xcf) {
    throw new Error("Это файл старого формата Excel (.xls) — пересохраните его как .xlsx или CSV");
  }
  if (/\.(docx?|pdf|zip|rar)$/i.test(filename)) throw new Error("Нужен список в формате CSV или XLSX");
  return clean(parseCsv(decodeText(buf)));
}

function clean(rows) {
  return rows
    .map((r) => (r || []).map((c) => String(c ?? "").replace(/ /g, " ").trim()))
    .filter((r) => r.some((c) => c !== ""));
}

module.exports = { readTable, parseCsv };
