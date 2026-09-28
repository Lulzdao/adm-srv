'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');

const { buildWhereClause, countExtraFilters, parseList, parseDirections } = require('../filters');
const { durationToSeconds } = require('../duration');

// ============================================================================
//  Фильтры журнала
//
//  Собранный SQL проверяется НЕ сравнением строк, а на настоящей базе:
//  сравнение строк зеленело бы и после того, как условие перестало выбирать
//  то, что нужно. Ошибка в фильтре ничего не роняет — она молча показывает
//  не те звонки, и заметить это некому.
//
//  База здесь временная, в памяти, со схемой из Collector.Py и ВЫДУМАННЫМИ
//  записями. Настоящая SMDR/smdr.db не открывается.
//
//  node:sqlite вместо better-sqlite3 — тот же SQLite и тот же SQL, но без
//  нативной сборки: тесты должны запускаться на голой машине.
// ============================================================================

function стенд() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_dt TEXT, call_date TEXT, call_time TEXT, ext TEXT, co TEXT, number TEXT,
    ring TEXT, duration TEXT, direction TEXT, status TEXT,
    did TEXT, caller TEXT, internal_to TEXT, raw_line TEXT, received_at TEXT)`);
  db.exec('CREATE TABLE employees (ext TEXT PRIMARY KEY, fio TEXT)');
  // Те же две функции, что регистрирует db.js на боевой базе.
  db.function('lower_ru', { deterministic: true }, (s) => (s === null || s === undefined ? null : String(s).toLowerCase()));
  db.function('dur_sec', { deterministic: true }, (s) => durationToSeconds(s));

  const ins = db.prepare(`INSERT INTO calls
    (call_dt, call_date, call_time, ext, number, ring, duration, direction, status, did, caller, internal_to)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  // 1  исходящий с 214, длинный
  ins.run('2026-09-04 09:12:00', '2026-09-04', '09:12', '214', '84742000000', null, "00:07'18", 'outgoing', '', null, null, null);
  // 2  исходящий с 301, короткий
  ins.run('2026-09-04 10:44:00', '2026-09-04', '10:44', '301', '84742000000', null, "00:01'07", 'outgoing', '', null, null, null);
  // 3  входящий отвеченный на 214
  ins.run('2026-09-03 11:00:00', '2026-09-03', '11:00', '214', null, "0'04", "00:02'00", 'incoming', '', '214', '89000000000', null);
  // 4  входящий ПРОПУЩЕННЫЙ на 301, долго звонил
  ins.run('2026-09-03 16:20:00', '2026-09-03', '16:20', '301', null, "1'05", null, 'incoming', 'NA', '301', '89000000000', null);
  // 5  внутренний 108 → 214
  ins.run('2026-08-01 15:08:00', '2026-08-01', '15:08', '108', null, null, "00:00'30", 'internal', '', null, null, '214');
  db.prepare('INSERT INTO employees (ext, fio) VALUES (?, ?)').run('214', 'Тестов Тест Тестович');
  db.prepare('INSERT INTO employees (ext, fio) VALUES (?, ?)').run('301', 'Пробников Пробник Пробникович');
  return db;
}

/** Какие записи (по id) остаются после фильтра. */
function выбрать(db, query) {
  const { where, params } = buildWhereClause(query);
  return db.prepare(`SELECT calls.id FROM calls LEFT JOIN employees ON calls.ext = employees.ext${where} ORDER BY calls.id`)
    .all(...params).map((r) => r.id);
}

test('без фильтров — все записи', (t) => {
  const db = стенд(); t.after(() => db.close());
  assert.deepStrictEqual(выбрать(db, {}), [1, 2, 3, 4, 5]);
});

test('несколько значений в колонке через запятую', (t) => {
  const db = стенд(); t.after(() => db.close());
  // Запись 5 сюда НЕ попадает: у неё добавочный 108, а 214 стоит в
  // «переведено на» — это другая колонка.
  assert.deepStrictEqual(выбрать(db, { col: 'ext', colq: '214' }), [1, 3]);
  assert.deepStrictEqual(выбрать(db, { col: 'ext', colq: '214, 301' }), [1, 2, 3, 4]);
});

test('пустые куски в списке не превращают фильтр в «показать всё»', (t) => {
  const db = стенд(); t.after(() => db.close());
  // «301,» без отбрасывания пустого куска давало LIKE '%%' — совпадение со
  // всем, и фильтр молча переставал фильтровать, оставаясь на вид включённым.
  assert.deepStrictEqual(выбрать(db, { col: 'ext', colq: '301,' }), [2, 4]);
  assert.deepStrictEqual(выбрать(db, { col: 'ext', colq: ' , ' }), [1, 2, 3, 4, 5]);
});

test('неизвестное имя колонки просто игнорируется', (t) => {
  const db = стенд(); t.after(() => db.close());
  // Подставлять имя колонки из запроса в SQL нельзя, поэтому список закрытый.
  assert.deepStrictEqual(выбрать(db, { col: 'calls.raw_line; DROP TABLE calls', colq: '214' }), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(db.prepare('SELECT COUNT(*) c FROM calls').get().c, 5, 'таблица на месте');
});

test('поиск по колонке «Сотрудник» идёт по справочнику ФИО', (t) => {
  const db = стенд(); t.after(() => db.close());
  assert.deepStrictEqual(выбрать(db, { col: 'fio', colq: 'пробников' }), [2, 4], 'и регистр кириллицы не мешает');
});

test('поиск везде находит и по номеру, и по ФИО, и по добавочному', (t) => {
  const db = стенд(); t.after(() => db.close());
  assert.deepStrictEqual(выбрать(db, { search: '89000000000' }), [3, 4]);
  // У добавочного 108 в справочнике ФИО нет, поэтому запись 5 по фамилии
  // не находится — и это правильно.
  assert.deepStrictEqual(выбрать(db, { search: 'Тестов' }), [1, 3]);
});

test('общий и колоночный поиск работают ВМЕСТЕ, а не вместо', (t) => {
  const db = стенд(); t.after(() => db.close());
  assert.deepStrictEqual(выбрать(db, { search: '89000000000', col: 'ext', colq: '301' }), [4]);
});

test('несколько направлений сразу — то, чего не умел выпадающий список', (t) => {
  const db = стенд(); t.after(() => db.close());
  assert.deepStrictEqual(выбрать(db, { direction: 'outgoing' }), [1, 2]);
  assert.deepStrictEqual(выбрать(db, { direction: 'outgoing,internal' }), [1, 2, 5]);
  assert.deepStrictEqual(выбрать(db, { direction: ['outgoing', 'internal'] }), [1, 2, 5], 'и повторяющимся параметром тоже');
});

test('«Пропущенные» — это входящий со статусом NA, а не отдельное направление', (t) => {
  const db = стенд(); t.after(() => db.close());
  assert.deepStrictEqual(выбрать(db, { direction: 'missed' }), [4]);
  assert.deepStrictEqual(выбрать(db, { direction: 'incoming' }), [3, 4], 'входящие включают и пропущенные');
  assert.deepStrictEqual(выбрать(db, { direction: 'incoming,missed' }), [3, 4], 'вместе — то же самое, не меньше');
});

test('выдуманное направление игнорируется, а не роняет запрос', (t) => {
  const db = стенд(); t.after(() => db.close());
  assert.deepStrictEqual(выбрать(db, { direction: 'нет такого' }), [1, 2, 3, 4, 5]);
});

test('фильтр по длительности сравнивает секунды, а не строки', (t) => {
  const db = стенд(); t.after(() => db.close());
  // Строкой "00:07'18" > "00:02'00" тоже сравнилось бы, но "01:00'00" < "00:59'59"
  // уже нет — поэтому и понадобилась своя функция dur_sec.
  assert.deepStrictEqual(выбрать(db, { dur_min: '05:00' }), [1]);
  assert.deepStrictEqual(выбрать(db, { dur_min: '30' }), [1, 2, 3, 5]);
});

test('фильтр по ожиданию понимает форму ring', (t) => {
  const db = стенд(); t.after(() => db.close());
  assert.deepStrictEqual(выбрать(db, { ring_min: '60' }), [4], "у записи 4 ожидание 1'05");
  assert.deepStrictEqual(выбрать(db, { ring_min: '4' }), [3, 4]);
});

test('даты и время сужают выборку', (t) => {
  const db = стенд(); t.after(() => db.close());
  assert.deepStrictEqual(выбрать(db, { date_from: '2026-09-03' }), [1, 2, 3, 4]);
  assert.deepStrictEqual(выбрать(db, { date_from: '2026-09-03', date_to: '2026-09-03' }), [3, 4]);
  assert.deepStrictEqual(выбрать(db, { time_from: '15:00' }), [4, 5]);
});

test('все значения уходят параметрами — в SQL не подставляется ничего', (t) => {
  const db = стенд(); t.after(() => db.close());
  const { where, params } = buildWhereClause({ search: "'; DROP TABLE calls; --", col: 'ext', colq: '214' });
  assert.ok(!where.includes('DROP'), 'запрос не должен содержать пришедшее значение');
  assert.ok(params.some((p) => String(p).includes('DROP')), 'оно должно быть в параметрах');
  assert.deepStrictEqual(выбрать(db, { search: "'; DROP TABLE calls; --" }), []);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM calls').get().c, 5, 'таблица на месте');
});

test('счётчик «Ещё фильтры» считает только включённое', () => {
  assert.strictEqual(countExtraFilters({}), 0);
  assert.strictEqual(countExtraFilters({ direction: 'missed' }), 1);
  assert.strictEqual(countExtraFilters({ direction: 'missed', col: 'ext', colq: '214', dur_min: '05:00' }), 3);
  assert.strictEqual(countExtraFilters({ col: 'ext', colq: '' }), 0, 'выбранная колонка без значения — не фильтр');
  assert.strictEqual(countExtraFilters({ dur_min: 'абв' }), 0, 'неразборчивое значение — не фильтр');
});

test('длинный список значений обрезается, а не уходит сотней условий в SQL', () => {
  const много = Array.from({ length: 50 }, (_, i) => 100 + i).join(',');
  assert.strictEqual(parseList(много).length, 20);
});

test('направления из запроса разбираются в обеих формах', () => {
  assert.deepStrictEqual(parseDirections({ direction: 'outgoing, missed' }), ['outgoing', 'missed']);
  assert.deepStrictEqual(parseDirections({ direction: ['incoming'] }), ['incoming']);
  assert.deepStrictEqual(parseDirections({}), []);
});
