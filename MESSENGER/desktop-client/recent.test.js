// Лента окна чата и объявлений — последние три дня (renderer/recent.js).
// Запуск:  node --test  (из папки desktop-client)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Recent = require('./renderer/recent');

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

test('границы — с начала позавчера до конца сегодня, по часам этого компьютера', () => {
  const { since, until } = Recent.range(at(2026, 10, 13, 15, 30));
  assert.strictEqual(since, at(2026, 10, 11).getTime());
  assert.strictEqual(until, at(2026, 10, 14).getTime());
  assert.strictEqual(Recent.DAYS, 3);

  // Через границу месяца и года.
  assert.strictEqual(Recent.range(at(2026, 3, 1, 9)).since, at(2026, 2, 27).getTime());
  assert.strictEqual(Recent.range(at(2027, 1, 1, 0, 5)).since, at(2026, 12, 30).getTime());
  // Сразу после полуночи «сегодня» — уже новый день.
  assert.strictEqual(Recent.range(at(2026, 10, 14, 0, 1)).since, at(2026, 10, 12).getTime());
  // Другое число дней — на случай, если три окажется мало.
  assert.strictEqual(Recent.range(at(2026, 10, 13, 15), 1).since, at(2026, 10, 13).getTime());
});

test('разделитель дня: ключ меняется только со сменой дня', () => {
  assert.strictEqual(Recent.dayKey(at(2026, 10, 13, 0, 0).getTime()), Recent.dayKey(at(2026, 10, 13, 23, 59).getTime()));
  assert.notStrictEqual(Recent.dayKey(at(2026, 10, 13, 23, 59).getTime()), Recent.dayKey(at(2026, 10, 14, 0, 0).getTime()));
  assert.notStrictEqual(Recent.dayKey(at(2026, 1, 12).getTime()), Recent.dayKey(at(2026, 11, 2).getTime()), '1-12 и 11-2 не слипаются');
});

test('подпись разделителя: сегодня, вчера, дальше — дата', () => {
  const now = at(2026, 10, 13, 15, 30);
  assert.strictEqual(Recent.dayLabel(at(2026, 10, 13, 9).getTime(), now), 'Сегодня, 13 октября');
  assert.strictEqual(Recent.dayLabel(at(2026, 10, 12, 23, 59).getTime(), now), 'Вчера, 12 октября');
  assert.strictEqual(Recent.dayLabel(at(2026, 10, 11, 8).getTime(), now), '11 октября');
  assert.match(Recent.dayLabel(at(2025, 12, 31, 8).getTime(), at(2026, 1, 1, 10)), /^Вчера, 31 декабря 2025/);
});

test('подсказка называет срок и кнопку «История»', () => {
  assert.match(Recent.HINT, /последние 3 дня/);
  assert.match(Recent.HINT, /«История»/);
});
