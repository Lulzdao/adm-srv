'use strict';

// Выгрузка журнала в .xlsx.
//
// Файл .xlsx — это zip с несколькими XML внутри, и собирается он здесь
// вручную: сеть изолирована, новые пакеты на сервер не поставить, а zip и
// deflate в Node уже есть (node:zlib). Кода вышло около двухсот строк, зато
// у модуля по-прежнему нет ни одной зависимости.
//
// Зачем он нужен рядом с CSV. В CSV ячейку, начинающуюся с «=», «+» или «-»,
// Excel считает формулой, поэтому номера вида +74951234567 приходится
// обезвреживать апострофом — и апостроф этот в файле видно. В .xlsx строка
// остаётся строкой при любом первом знаке, и номера выглядят как в журнале.
// Плюс шапка сразу закреплена и с автофильтром.
//
// ВСЕ значения пишутся текстом, включая даты и добавочные. Так и задумано:
// добавочный может начинаться с нуля («0104»), а числом Excel этот ноль
// съест; даты в виде 2026-09-04 сортируются как надо и не зависят от того,
// какая локаль стоит на машине.

const zlib = require('node:zlib');
const { ZipBuilder, crc32 } = require('./zip');

const COLUMNS = ['Дата', 'Время', 'Внутренний', 'Направление', 'Детали', 'Длительность', 'Ожидание', 'Сотрудник'];
// Ширины колонок в «символах» — как их понимает Excel.
const WIDTHS = [12, 8, 12, 14, 30, 14, 11, 32];

// Лист в Excel вмещает 1 048 576 строк, одну занимает шапка.
const MAX_ROWS = 1048575;

// ============================================================================
//  XML
// ============================================================================

// Управляющие символы, которых XML 1.0 не допускает вовсе. Excel на таком
// файле говорит, что он повреждён, и не уточняет где. В журнал они попадают
// из сырых строк АТС.
const УПРАВЛЯЮЩИЕ = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

/**
 * Экранирование для XML.
 *
 * Апостроф НЕ трогаем: в тексте элемента он не имеет особого смысла, а
 * длительность в журнале записана как 00:03'41 — то есть апостроф стоит
 * почти в каждой строке, и &apos; раздул бы файл на ровном месте.
 * Кавычка заменяется на всякий случай: в атрибут наши значения не попадают,
 * но если кто-то возьмёт эту функцию для атрибута, она не подведёт.
 */
function xmlEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return s.replace(УПРАВЛЯЮЩИЕ, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Номер колонки → буква: 1 → A, 26 → Z, 27 → AA. */
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const о = (n - 1) % 26;
    s = String.fromCharCode(65 + о) + s;
    n = (n - о - 1) / 26;
  }
  return s;
}

/**
 * Ячейка с текстом. t="inlineStr" — строка лежит прямо в ячейке.
 *
 * Общая таблица строк (sharedStrings) вышла бы компактнее, но её нельзя
 * писать потоком: пока не пройдёшь все записи, не знаешь их полного набора,
 * а значит держишь весь журнал в памяти. Повторов же в файле всё равно почти
 * не остаётся — их съедает deflate.
 */
function cell(ref, value, style) {
  const s = value === null || value === undefined ? '' : String(value);
  if (s === '') return `<c r="${ref}"${style ? ` s="${style}"` : ''}/>`;
  // xml:space="preserve" — иначе Excel обрежет краевые пробелы.
  return `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr">`
    + `<is><t xml:space="preserve">${xmlEscape(s)}</t></is></c>`;
}

function row(values, index, style) {
  const ячейки = values.map((v, i) => cell(colLetter(i + 1) + index, v, style)).join('');
  return `<row r="${index}">${ячейки}</row>`;
}

function sheetHead() {
  const cols = WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    // Шапка закреплена: журнал листают вниз, и без этого через экран уже
    // непонятно, какая колонка какая.
    + '<sheetViews><sheetView workbookViewId="0">'
    + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    + '</sheetView></sheetViews>'
    + `<cols>${cols}</cols><sheetData>`
    + row(COLUMNS, 1, 1);
}

/** Хвост листа. Автофильтр стоит после sheetData — так требует схема. */
function sheetFoot(rowCount) {
  const последняя = Math.max(1, rowCount + 1);
  return `</sheetData><autoFilter ref="A1:${colLetter(COLUMNS.length)}${последняя}"/></worksheet>`;
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
  + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
  + '</Types>';

const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '</Relationships>';

const WORKBOOK = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
  + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
  + '<sheets><sheet name="Журнал звонков" sheetId="1" r:id="rId1"/></sheets></workbook>';

const WORKBOOK_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '</Relationships>';

// Стилей ровно два: обычный и полужирный для шапки. Две заливки — не
// прихоть: Excel считает файл повреждённым, если их меньше.
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

// Разметка zip (заголовки, каталог, CRC32) — в zip.js: общий с платформой файл, см. его шапку.
// Раньше она была написана здесь второй раз.

// ============================================================================
//  Сборка книги
// ============================================================================

/**
 * Собирает .xlsx из потока записей.
 *
 * `rows` — любой итератор (в бою это stmt.iterate()), `format` превращает
 * запись базы в массив значений. Лист сжимается на лету, поэтому несжатого
 * XML целиком в памяти не оказывается.
 */
async function build(rows, format, now = new Date()) {
  const zip = new ZipBuilder(now);
  zip.add('[Content_Types].xml', CONTENT_TYPES);
  zip.add('_rels/.rels', ROOT_RELS);
  zip.add('xl/workbook.xml', WORKBOOK);
  zip.add('xl/_rels/workbook.xml.rels', WORKBOOK_RELS);
  zip.add('xl/styles.xml', STYLES);

  const deflate = zlib.createDeflateRaw();
  const куски = [];
  deflate.on('data', (c) => куски.push(c));
  const готово = new Promise((resolve, reject) => {
    deflate.on('end', resolve);
    deflate.on('error', reject);
  });

  let crc = 0;
  let usize = 0;
  let обрезано = false;
  /** Возвращает промис, только когда буфер записи переполнен. */
  const пишем = (text) => {
    const b = Buffer.from(text, 'utf8');
    crc = crc32(b, crc);
    usize += b.length;
    // Ждать на каждой строке — значит отдавать управление сотни тысяч раз и
    // растянуть выгрузку на пустом месте.
    if (!deflate.write(b)) return new Promise((r) => deflate.once('drain', r));
    return null;
  };
  const пишемЖдя = async (text) => { const ж = пишем(text); if (ж) await ж; };

  await пишемЖдя(sheetHead());
  let n = 0;
  for (const запись of rows) {
    if (n >= MAX_ROWS) { обрезано = true; break; }
    n += 1;
    await пишемЖдя(row(format(запись), n + 1, 0));
  }
  await пишемЖдя(sheetFoot(n));
  deflate.end();
  await готово;

  zip.addCompressed('xl/worksheets/sheet1.xml', куски, crc, usize);
  return { file: zip.finish(), rows: n, truncated: обрезано };
}

/** Имя файла: журнал-звонков-2026-09-04.xlsx */
function fileName(now = new Date()) {
  const п = (n) => String(n).padStart(2, '0');
  return `журнал-звонков-${now.getFullYear()}-${п(now.getMonth() + 1)}-${п(now.getDate())}.xlsx`;
}

/** ASCII-запасной вариант обязателен — см. тот же разбор в csv.js. */
function contentDisposition(name) {
  return `attachment; filename="calls.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Средний вес строки в готовом (сжатом) файле — для оценки в окне выгрузки.
// XML многословнее CSV, но однообразнее, и deflate его сжимает сильнее, чем
// текст с кириллическими ФИО. Значение померено на выдуманном журнале.
const BYTES_PER_ROW = 60;

module.exports = {
  COLUMNS, MAX_ROWS, BYTES_PER_ROW, CONTENT_TYPE,
  xmlEscape, colLetter, cell, row,
  crc32, ZipBuilder, build, fileName, contentDisposition,
};
