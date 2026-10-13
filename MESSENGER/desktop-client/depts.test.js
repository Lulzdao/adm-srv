// Свёрнутые отделы в списке сотрудников (renderer/depts.js): обычный режим и «по одному».
// Запуск:  node --test  (из папки desktop-client)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Depts = require('./renderer/depts');

test('обычный режим: каждый отдел сам по себе, выбор копится', () => {
  const s = Depts.createState(['Бухгалтерия'], false);
  assert.strictEqual(Depts.isCollapsed(s, 'Бухгалтерия'), true);
  assert.strictEqual(Depts.isCollapsed(s, 'Отдел труда'), false);

  assert.deepStrictEqual(Depts.toggle(s, 'Отдел труда'), [{ key: 'Отдел труда', collapsed: true }]);
  assert.deepStrictEqual(Depts.toggle(s, 'Бухгалтерия'), [{ key: 'Бухгалтерия', collapsed: false }]);
  assert.deepStrictEqual([...s.collapsed], ['Отдел труда'], 'другие отделы щелчок не трогает');
});

test('«по одному»: при включении свёрнуты все, открыт бывает только один', () => {
  const s = Depts.createState([], true);
  for (const k of ['Бухгалтерия', 'Отдел труда', 'Без отдела']) assert.strictEqual(Depts.isCollapsed(s, k), true, k);

  assert.deepStrictEqual(Depts.toggle(s, 'Бухгалтерия'), [{ key: 'Бухгалтерия', collapsed: false }]);
  assert.strictEqual(Depts.isCollapsed(s, 'Бухгалтерия'), false);

  // Открыли второй — первый свернулся сам, и сообщается об обоих.
  assert.deepStrictEqual(Depts.toggle(s, 'Отдел труда'), [
    { key: 'Бухгалтерия', collapsed: true },
    { key: 'Отдел труда', collapsed: false },
  ]);
  assert.strictEqual(Depts.isCollapsed(s, 'Бухгалтерия'), true);
  assert.strictEqual(Depts.isCollapsed(s, 'Отдел труда'), false);

  // Щелчок по открытому сворачивает его — снова свёрнуты все.
  assert.deepStrictEqual(Depts.toggle(s, 'Отдел труда'), [{ key: 'Отдел труда', collapsed: true }]);
  assert.strictEqual(s.open, null);
});

test('настройку выключили — список такой же, каким был до неё', () => {
  const s = Depts.createState(['Бухгалтерия'], false);
  Depts.setSingle(s, true);
  assert.strictEqual(Depts.isCollapsed(s, 'Отдел труда'), true, 'включили — свёрнуты все');
  Depts.toggle(s, 'Отдел труда');
  assert.deepStrictEqual([...s.collapsed], ['Бухгалтерия'], 'обычный выбор в режиме «по одному» не меняется');

  Depts.setSingle(s, false);
  assert.strictEqual(Depts.isCollapsed(s, 'Бухгалтерия'), true);
  assert.strictEqual(Depts.isCollapsed(s, 'Отдел труда'), false);

  // Включили снова — открытый в прошлый раз отдел не вспоминается.
  Depts.setSingle(s, true);
  assert.strictEqual(Depts.isCollapsed(s, 'Отдел труда'), true);
});
