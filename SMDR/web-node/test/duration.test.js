'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { durationToSeconds, inputToSeconds } = require('../duration');

// ============================================================================
//  Разбор длительности
//
//  АТС отдаёт её строкой в двух разных формах, и обе встречаются в одной
//  таблице: duration — `ЧЧ:ММ'СС`, ring — `М'СС` (см. README модуля).
//  На этом разборе держится фильтр «дольше стольких-то», а ошибка в нём не
//  падает — просто показывает не те звонки.
// ============================================================================

test('форма duration: ЧЧ:ММ\'СС', () => {
  assert.strictEqual(durationToSeconds("00:03'41"), 221);
  assert.strictEqual(durationToSeconds("01:00'00"), 3600);
  assert.strictEqual(durationToSeconds("00:00'00"), 0);
});

test("форма ring: М'СС — её прежний разбор молча превращал в ноль", () => {
  assert.strictEqual(durationToSeconds("0'04"), 4);
  assert.strictEqual(durationToSeconds("12'30"), 750);
});

test('мусор и пустое — ноль, а не исключение', () => {
  for (const v of ['', '   ', 'нет', null, undefined, 42, {}]) {
    assert.strictEqual(durationToSeconds(v), 0, `на значении ${JSON.stringify(v)}`);
  }
});

test('ввод человека: секунды, мм:сс и чч:мм:сс', () => {
  assert.strictEqual(inputToSeconds('30'), 30);
  assert.strictEqual(inputToSeconds('05:00'), 300);
  assert.strictEqual(inputToSeconds('1:05:30'), 3930);
});

test('ввод человека: принимаем и форму из таблицы — значение могли скопировать', () => {
  assert.strictEqual(inputToSeconds("00:03'41"), 221);
  assert.strictEqual(inputToSeconds("0'04"), 4);
});

test('пустое поле — null, а не ноль', () => {
  // Ноль как порог означал бы «показать вообще всё», и фильтр молча
  // перестал бы фильтровать, оставаясь на вид включённым.
  assert.strictEqual(inputToSeconds(''), null);
  assert.strictEqual(inputToSeconds('   '), null);
  assert.strictEqual(inputToSeconds('абв'), null);
  assert.strictEqual(inputToSeconds(undefined), null);
  assert.strictEqual(inputToSeconds('0'), 0, 'а вот явный ноль — это ноль');
});
