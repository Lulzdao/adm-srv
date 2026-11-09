'use strict';

// ============================================================================
//  Выгрузка реестров в Excel (.xlsx)
//
//  Кнопка «Выгрузить в Excel» на обеих страницах — сертификаты и МЧД. В файл
//  попадает ровно то, что видно в таблице: тот же поиск, та же сортировка, те
//  же колонки. Поэтому фильтр и порядок здесь повторяют страницы
//  (public/index.html, public/mchd.html) — правите там, поправьте и здесь.
//
//  Книга собирается своими руками, как выгрузка журнала звонков
//  (SMDR/web-node/xlsx.js): .xlsx — это zip с XML, а пакет с npm на закрытый
//  контур не поставить. Разметка zip — общий файл zip.js (см. его шапку).
//  Реестры маленькие — сотни строк, — поэтому книга собирается целиком в
//  памяти, без потоковой записи.
//
//  Даты — настоящие даты Excel (их можно сортировать и фильтровать), дни —
//  числом; ФИО и номера — текстом: номер доверенности из 18 цифр числом Excel
//  округлил бы, а ведущие нули съел.
// ============================================================================

const { ZipBuilder } = require('./zip');

const DAY_MS = 86400000;
// Порог «истекает скоро» — как на страницах: у сертификатов «меньше 30 дней», у МЧД «30 и меньше».
const SOON_DAYS = 30;

// ---- Ячейки и лист ---------------------------------------------------------

// Управляющие символы XML 1.0 не допускает: Excel назвал бы файл повреждённым.
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
function xmlEscape(value) {
  return String(value === null || value === undefined ? '' : value).replace(CONTROL, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = (n - r - 1) / 26;
  }
  return s;
}

// Дата Excel — число дней от 30.12.1899. Берём календарный день, без часов.
function excelDate(y, m, d) {
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / DAY_MS;
}

// Стили (см. STYLES): 0 — обычный, 1 — шапка полужирным, 2 — дата ДД.ММ.ГГГГ.
function cell(ref, value, type, style) {
  if (value === null || value === undefined || value === '') return `<c r="${ref}"${style ? ` s="${style}"` : ''}/>`;
  if (type === 'date') return `<c r="${ref}" s="2"><v>${value}</v></c>`;
  if (type === 'number') return `<c r="${ref}"><v>${Number(value)}</v></c>`;
  return `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function sheetXml(columns, rows) {
  const cols = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('');
  const head = `<row r="1">${columns.map((c, i) => cell(colLetter(i + 1) + 1, c.title, 'text', 1)).join('')}</row>`;
  const body = rows.map((r, n) =>
    `<row r="${n + 2}">${columns.map((c, i) => cell(colLetter(i + 1) + (n + 2), r[i], c.type, 0)).join('')}</row>`).join('');
  const last = `${colLetter(columns.length)}${rows.length + 1}`;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    // Шапка закреплена, на ней автофильтр — как у выгрузки журнала звонков.
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + `<cols>${cols}</cols><sheetData>${head}${body}</sheetData>`
    + `<autoFilter ref="A1:${last}"/></worksheet>`;
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

const WORKBOOK_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '</Relationships>';

// Две заливки — не прихоть: с одной Excel считает файл повреждённым.
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/></numFmts>'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

/** Книга с одним листом: columns — [{ title, width, type: 'text'|'date'|'number' }], rows — массивы значений. */
function buildXlsx(sheetName, columns, rows, now = new Date()) {
  const zip = new ZipBuilder(now);
  zip.add('[Content_Types].xml', CONTENT_TYPES);
  zip.add('_rels/.rels', ROOT_RELS);
  zip.add('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.add('xl/_rels/workbook.xml.rels', WORKBOOK_RELS);
  zip.add('xl/styles.xml', STYLES);
  zip.add('xl/worksheets/sheet1.xml', sheetXml(columns, rows));
  return zip.finish();
}

// ---- Реестры ---------------------------------------------------------------

const sortDir = (dir) => (dir === 'desc' ? -1 : 1);

// Сертификаты: срок — момент времени (validTo из сертификата), дни — как на странице:
// округление вверх от «сейчас». Дата в ячейке — календарный день по часам сервера.
function certificateSheet(list, { q = '', sort = 'full_name', dir = 'asc' } = {}, now = new Date()) {
  const query = String(q).trim().toLowerCase();
  const key = ['full_name', 'identifier', 'valid_from', 'valid_to'].includes(sort) ? sort : 'full_name';
  const rows = list.filter((c) => !query
    || String(c.full_name || '').toLowerCase().includes(query) || String(c.identifier || '').toLowerCase().includes(query));
  rows.sort((a, b) => sortDir(dir) * (key === 'full_name' || key === 'identifier'
    ? String(a[key] || '').localeCompare(String(b[key] || ''), 'ru')
    : new Date(a[key]) - new Date(b[key])));
  const day = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? null : excelDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  };
  return {
    columns: [
      { title: 'ФИО', width: 40, type: 'text' },
      { title: 'Идентификатор', width: 26, type: 'text' },
      { title: 'Действителен с', width: 16, type: 'date' },
      { title: 'Действителен до', width: 16, type: 'date' },
      { title: 'Осталось дней', width: 14, type: 'number' },
      { title: 'Состояние', width: 14, type: 'text' },
    ],
    rows: rows.map((c) => {
      const to = new Date(c.valid_to);
      const left = isNaN(to) ? null : Math.ceil((to - now) / DAY_MS);
      const state = left === null ? '' : left < 0 ? 'истёк' : left < SOON_DAYS ? 'истекает' : 'действует';
      return [c.full_name, c.identifier, day(c.valid_from), day(c.valid_to), left, state];
    }),
  };
}

// МЧД: срок — календарная дата (ГГГГ-ММ-ДД), действует весь последний день.
function isoDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}
function attorneyDaysLeft(iso, now) {
  const d = isoDay(iso);
  if (!d) return null;
  return Math.round((Date.UTC(d.y, d.m - 1, d.d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / DAY_MS);
}

function attorneySheet(list, { q = '', sort = 'valid_to', dir = 'asc' } = {}, now = new Date()) {
  const query = String(q).trim().toLowerCase();
  const key = ['full_name', 'reg_number', 'valid_from', 'valid_to', 'days'].includes(sort) ? sort : 'valid_to';
  const rows = list.filter((r) => !query
    || String(r.full_name || '').toLowerCase().includes(query) || String(r.reg_number || '').toLowerCase().includes(query));
  // Как на странице: строки сравниваются как есть, пустой срок — в конец.
  rows.sort((a, b) => {
    let va = key === 'days' ? attorneyDaysLeft(a.valid_to, now) : a[key] || '';
    let vb = key === 'days' ? attorneyDaysLeft(b.valid_to, now) : b[key] || '';
    if (va === null) va = Infinity;
    if (vb === null) vb = Infinity;
    return sortDir(dir) * (va < vb ? -1 : va > vb ? 1 : 0);
  });
  const day = (iso) => { const d = isoDay(iso); return d ? excelDate(d.y, d.m, d.d) : null; };
  return {
    columns: [
      { title: 'ФИО представителя', width: 40, type: 'text' },
      { title: 'Номер доверенности', width: 24, type: 'text' },
      { title: 'Действует с', width: 14, type: 'date' },
      { title: 'Действует до', width: 14, type: 'date' },
      { title: 'Осталось дней', width: 14, type: 'number' },
      { title: 'Состояние', width: 14, type: 'text' },
    ],
    rows: rows.map((r) => {
      const left = attorneyDaysLeft(r.valid_to, now);
      const state = left === null ? '' : left < 0 ? 'истекла' : left <= SOON_DAYS ? 'истекает' : 'действует';
      return [r.full_name, r.reg_number, day(r.valid_from), day(r.valid_to), left, state];
    }),
  };
}

/** «сертификаты-2026-11-09.xlsx» */
function fileName(prefix, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.xlsx`;
}

/** Кириллическое имя — в filename*, ASCII-запасное — для старых браузеров. */
function sendXlsx(res, buf, asciiName, name) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
}

module.exports = { buildXlsx, certificateSheet, attorneySheet, attorneyDaysLeft, excelDate, colLetter, fileName, sendXlsx };
