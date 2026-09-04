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

// ============================================================================
//  ZIP
// ============================================================================

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

/** CRC32 по кускам: crc32(кусок, crc32(предыдущий)). Начинать с нуля. */
function crc32(buf, seed = 0) {
  let c = ~seed;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Время в формате MS-DOS, как его хранит zip. */
function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function localHeader(entry) {
  const имя = Buffer.from(entry.name, 'utf8');
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4);            // нужна версия 2.0
  b.writeUInt16LE(0, 6);             // флагов нет: размеры известны заранее
  b.writeUInt16LE(8, 8);             // deflate
  b.writeUInt16LE(entry.time, 10);
  b.writeUInt16LE(entry.date, 12);
  b.writeUInt32LE(entry.crc, 14);
  b.writeUInt32LE(entry.csize, 18);
  b.writeUInt32LE(entry.usize, 22);
  b.writeUInt16LE(имя.length, 26);
  b.writeUInt16LE(0, 28);
  return Buffer.concat([b, имя]);
}

function centralHeader(entry) {
  const имя = Buffer.from(entry.name, 'utf8');
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(20, 4);            // чем создан
  b.writeUInt16LE(20, 6);            // чем распаковывать
  b.writeUInt16LE(0, 8);
  b.writeUInt16LE(8, 10);
  b.writeUInt16LE(entry.time, 12);
  b.writeUInt16LE(entry.date, 14);
  b.writeUInt32LE(entry.crc, 16);
  b.writeUInt32LE(entry.csize, 20);
  b.writeUInt32LE(entry.usize, 24);
  b.writeUInt16LE(имя.length, 28);
  b.writeUInt16LE(0, 30);            // extra
  b.writeUInt16LE(0, 32);            // комментарий
  b.writeUInt16LE(0, 34);            // диск
  b.writeUInt16LE(0, 36);
  b.writeUInt32LE(0, 38);
  b.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([b, имя]);
}

function endOfCentralDirectory(count, size, offset) {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(0, 4);
  b.writeUInt16LE(0, 6);
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(size, 12);
  b.writeUInt32LE(offset, 16);
  b.writeUInt16LE(0, 20);
  return b;
}

/**
 * Сборщик zip.
 *
 * Заголовок записи несёт CRC и размеры, то есть его нельзя записать раньше,
 * чем сжаты данные. Поэтому куски копятся здесь, а наружу всё уходит одним
 * куском в конце. В памяти при этом лежит только СЖАТОЕ: лист с полусотней
 * тысяч звонков — это единицы мегабайт. Кому нужен по-настоящему потоковый
 * файл на весь журнал, у того есть CSV — он пишется строка за строкой.
 */
class ZipBuilder {
  constructor(now = new Date()) {
    this.parts = [];
    this.entries = [];
    this.offset = 0;
    this.stamp = dosTime(now);
  }

  /** Запись из уже сжатых кусков. */
  addCompressed(name, chunks, crc, usize) {
    const данные = Buffer.concat(chunks);
    const entry = {
      name, crc, usize, csize: данные.length, offset: this.offset,
      time: this.stamp.time, date: this.stamp.date,
    };
    const шапка = localHeader(entry);
    this.parts.push(шапка, данные);
    this.offset += шапка.length + данные.length;
    this.entries.push(entry);
  }

  /** Запись из готовой строки — для мелких XML. */
  add(name, text) {
    const сырое = Buffer.from(text, 'utf8');
    this.addCompressed(name, [zlib.deflateRawSync(сырое)], crc32(сырое), сырое.length);
  }

  finish() {
    const каталог = this.entries.map(centralHeader);
    const размер = каталог.reduce((s, b) => s + b.length, 0);
    return Buffer.concat([
      ...this.parts, ...каталог,
      endOfCentralDirectory(this.entries.length, размер, this.offset),
    ]);
  }
}

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
  xmlEscape, colLetter, cell, row, sheetHead, sheetFoot,
  crc32, ZipBuilder, build, fileName, contentDisposition,
};
