'use strict';

const test = require('node:test');
const assert = require('node:assert');
const csv = require('../csv');

// ============================================================================
//  Выгрузка в CSV
//
//  Данные в примерах ВЫДУМАНЫ.
//
//  Здесь проверяется ровно то, из-за чего файл открывается неправильно, а
//  человек этого не понимает: разделитель, BOM и экранирование. Всё это
//  видно не в коде, а только в Excel через день после выгрузки.
// ============================================================================

test('разделитель — точка с запятой, иначе русский Excel свалит всё в одну колонку', () => {
  assert.strictEqual(csv.SEP, ';');
  assert.ok(csv.headerRow().includes('Дата;Время;Внутренний'));
});

test('файл начинается с BOM, иначе кириллица превращается в кракозябры', () => {
  assert.strictEqual(csv.headerRow().charCodeAt(0), 0xFEFF);
});

test('ячейка с разделителем, кавычкой или переводом строки берётся в кавычки', () => {
  assert.strictEqual(csv.cell('Иванов'), 'Иванов');
  assert.strictEqual(csv.cell('Иванов; Пётр'), '"Иванов; Пётр"');
  assert.strictEqual(csv.cell('он сказал "да"'), '"он сказал ""да"""');
  assert.strictEqual(csv.cell('две\nстроки'), '"две\nстроки"');
});

test('ведущий +, =, - и @ обезвреживаются: Excel считает такую ячейку формулой', () => {
  // Номера вида +74951234567 в журнале звонков — обычное дело, и без защиты
  // Excel показал бы на их месте ошибку. А поле ФИО заполняет человек, и
  // через него в файл попадает что угодно.
  assert.strictEqual(csv.cell('+74950000000'), "'+74950000000");
  assert.strictEqual(csv.cell('=1+1'), "'=1+1");
  assert.strictEqual(csv.cell('-5'), "'-5");
  assert.strictEqual(csv.cell('@имя'), "'@имя");
  assert.strictEqual(csv.cell('84742000000'), '84742000000', 'обычный номер не трогаем');
});

test('пустое значение — пустая ячейка, а не «null»', () => {
  assert.strictEqual(csv.cell(null), '');
  assert.strictEqual(csv.cell(undefined), '');
});

test('строка собирается из тех же колонок, что видны в таблице', () => {
  const строка = csv.formatRow({
    call_date: '2026-09-04', call_time: '09:12', ext: '214',
    direction: 'outgoing', number: '84742000000',
    duration: "00:03'41", ring: null, fio: 'Тестов Тест Тестович',
  });
  assert.strictEqual(строка,
    "2026-09-04;09:12;214;Исходящий;84742000000;00:03'41;;Тестов Тест Тестович\r\n");
  assert.strictEqual(строка.split(';').length, csv.COLUMNS.length);
});

test('пропущенный отличается от просто входящего', () => {
  const общий = { call_date: '2026-09-04', call_time: '09:31', ext: '301', direction: 'incoming', caller: '84742000000', did: '301' };
  assert.ok(csv.formatRow({ ...общий, status: 'NA' }).includes('Пропущенный'));
  assert.ok(csv.formatRow({ ...общий, status: '' }).includes('Входящий'));
});

test('нераспознанное направление подписано, а не пусто', () => {
  const строка = csv.formatRow({ direction: 'unknown' });
  assert.ok(строка.includes('не распознано'));
});

test('имя файла кириллическое, но заголовок несёт и ASCII-запасной вариант', () => {
  const имя = csv.fileName(new Date('2026-09-04T10:00:00Z'));
  assert.strictEqual(имя, 'журнал-звонков-2026-09-04.csv');
  const заголовок = csv.contentDisposition(имя);
  // Без ASCII-варианта браузер, не понимающий filename*, сохранит файл под
  // именем маршрута и без расширения.
  assert.ok(заголовок.includes('filename="calls.csv"'));
  assert.ok(заголовок.includes("filename*=UTF-8''"));
});
