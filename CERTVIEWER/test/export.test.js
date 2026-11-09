'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readZip } = require('../zip');
const X = require('../export');

// ============================================================================
//  Выгрузка реестров в Excel. ВСЕ ДАННЫЕ ВЫДУМАНЫ.
// ============================================================================

const NOW = new Date(2026, 10, 9, 12, 0, 0); // 9 ноября 2026, полдень

const CERTS = [
  { id: 1, full_name: 'Пробников Пробник', identifier: '0000111', valid_from: '2025-11-10T08:00:00.000Z', valid_to: '2026-11-20T08:00:00.000Z' },
  { id: 2, full_name: 'Аркадьев Тест', identifier: 'ABC-2', valid_from: '2024-01-01T08:00:00.000Z', valid_to: '2026-10-01T08:00:00.000Z' },
  { id: 3, full_name: 'Вымыслов Вымысел', identifier: '777', valid_from: '2026-01-01T08:00:00.000Z', valid_to: '2028-01-01T08:00:00.000Z' },
];

const MCHD = [
  { id: 1, full_name: 'Пробников Пробник', reg_number: '000000000000000001', valid_from: '2025-01-10', valid_to: '2026-11-09' },
  { id: 2, full_name: 'Аркадьев Тест', reg_number: '000000000000000002', valid_from: '2025-01-10', valid_to: '2027-01-09' },
  { id: 3, full_name: 'Вымыслов Вымысел', reg_number: '000000000000000003', valid_from: '', valid_to: '' },
];

const sheetOf = (buf) => readZip(buf).get('xl/worksheets/sheet1.xml').toString('utf8');

test('сертификаты: колонки как на странице, сортировка по ФИО, дни и состояние', () => {
  const { columns, rows } = X.certificateSheet(CERTS, {}, NOW);
  assert.deepEqual(columns.map((c) => c.title), ['ФИО', 'Идентификатор', 'Действителен с', 'Действителен до', 'Осталось дней', 'Состояние']);
  assert.deepEqual(rows.map((r) => r[0]), ['Аркадьев Тест', 'Вымыслов Вымысел', 'Пробников Пробник']);
  const byName = Object.fromEntries(rows.map((r) => [r[0], r]));
  assert.deepEqual(byName['Аркадьев Тест'].slice(4), [-39, 'истёк']);
  assert.deepEqual(byName['Пробников Пробник'].slice(4), [11, 'истекает']);
  assert.equal(byName['Вымыслов Вымысел'][5], 'действует');
  assert.equal(byName['Пробников Пробник'][1], '0000111', 'идентификатор — текстом, ведущие нули на месте');
});

test('сертификаты: поиск по ФИО и идентификатору, сортировка по сроку в обе стороны', () => {
  assert.deepEqual(X.certificateSheet(CERTS, { q: '  abc ' }, NOW).rows.map((r) => r[0]), ['Аркадьев Тест']);
  assert.deepEqual(X.certificateSheet(CERTS, { q: 'вымыс' }, NOW).rows.map((r) => r[0]), ['Вымыслов Вымысел']);
  assert.deepEqual(X.certificateSheet(CERTS, { sort: 'valid_to', dir: 'desc' }, NOW).rows.map((r) => r[0]),
    ['Вымыслов Вымысел', 'Пробников Пробник', 'Аркадьев Тест']);
  // Чужой ключ сортировки — как по умолчанию, а не падение.
  assert.equal(X.certificateSheet(CERTS, { sort: 'issuer; drop' }, NOW).rows[0][0], 'Аркадьев Тест');
});

test('МЧД: по умолчанию — по сроку, как на странице; по дням — пустой срок в конце', () => {
  const { columns, rows } = X.attorneySheet(MCHD, {}, NOW);
  assert.equal(columns[1].title, 'Номер доверенности');
  // Как на странице: '' < '2026…', поэтому пустая строка при сортировке по строке идёт первой.
  assert.deepEqual(rows.map((r) => r[0]), ['Вымыслов Вымысел', 'Пробников Пробник', 'Аркадьев Тест']);
  const [, today, later] = rows;
  assert.deepEqual(today.slice(4), [0, 'истекает'], 'последний день — ещё действует, 0 дней');
  assert.equal(later[5], 'действует');
  assert.deepEqual(rows[0].slice(2), [null, null, null, ''], 'без дат — пустые ячейки');
  assert.deepEqual(X.attorneySheet(MCHD, { sort: 'days' }, NOW).rows.map((r) => r[0]),
    ['Пробников Пробник', 'Аркадьев Тест', 'Вымыслов Вымысел'], 'по дням — пустой срок в конце');
  assert.deepEqual(X.attorneySheet(MCHD, { q: '0002' }, NOW).rows.map((r) => r[1]), ['000000000000000002']);
});

test('книга открывается: лист с датами Excel, числами и текстом; номер из 18 цифр — текстом', () => {
  const { columns, rows } = X.attorneySheet(MCHD, { sort: 'days' }, NOW);
  const buf = X.buildXlsx('Доверенности', columns, rows, NOW);
  const files = readZip(buf);
  for (const f of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(files.has(f), f);
  }
  assert.match(files.get('xl/workbook.xml').toString('utf8'), /<sheet name="Доверенности"/);
  const sheet = sheetOf(buf);
  assert.match(sheet, /<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">ФИО представителя<\/t>/);
  assert.match(sheet, /<c r="B2" t="inlineStr"><is><t xml:space="preserve">000000000000000001<\/t>/);
  // 09.11.2026 — день 46335 от 30.12.1899.
  assert.equal(X.excelDate(2026, 11, 9), 46335);
  assert.match(sheet, /<c r="D2" s="2"><v>46335<\/v><\/c>/);
  assert.match(sheet, /<c r="E2"><v>0<\/v><\/c>/);
  assert.match(sheet, /<autoFilter ref="A1:F4"\/>/);
});

test('враждебный текст не ломает XML: угловые скобки экранируются, управляющие символы выбрасываются', () => {
  const buf = X.buildXlsx('Лист', [{ title: 'ФИО', width: 10, type: 'text' }], [['<script>&\u0001"x"']], NOW);
  assert.match(sheetOf(buf), /&lt;script&gt;&amp;&quot;x&quot;/);
  assert.doesNotMatch(sheetOf(buf), /\u0001/);
});

test('имя файла — с датой; в заголовке — кириллица в filename* и ASCII-запасное', () => {
  assert.equal(X.fileName('сертификаты', NOW), 'сертификаты-2026-11-09.xlsx');
  const headers = {};
  X.sendXlsx({ setHeader: (k, v) => { headers[k] = v; }, send: () => {} }, Buffer.alloc(0), 'certificates.xlsx', 'сертификаты-2026-11-09.xlsx');
  assert.match(headers['Content-Disposition'], /^attachment; filename="certificates\.xlsx"; filename\*=UTF-8''%D1%81/);
  assert.equal(headers['Content-Type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});
