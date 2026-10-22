// Место нового окна чата (window-place.js): не ровно поверх уже открытого.
//
// Запуск:  node --test  (из папки desktop-client)

const test = require('node:test');
const assert = require('node:assert');
const { cascadePosition, centerIn, STEP } = require('./window-place');

const area = { x: 0, y: 0, width: 1920, height: 1040 };
const size = { width: 574, height: 423 };

test('место свободно — окно открывается там, где просили', () => {
  assert.deepStrictEqual(cascadePosition({ x: 100, y: 100 }, size, [], area), { x: 100, y: 100 });
  assert.deepStrictEqual(cascadePosition({ x: 100, y: 100 }, size, [{ x: 600, y: 300 }], area), { x: 100, y: 100 },
    'первый чат передвинули — он места не занимает');
});

test('на месте уже стоит чат — новое окно лесенкой вниз-вправо', () => {
  const p1 = { x: 100, y: 100 };
  const p2 = cascadePosition(p1, size, [p1], area);
  assert.deepStrictEqual(p2, { x: 100 + STEP, y: 100 + STEP });
  const p3 = cascadePosition(p1, size, [p1, p2], area);
  assert.deepStrictEqual(p3, { x: 100 + 2 * STEP, y: 100 + 2 * STEP });
  assert.deepStrictEqual(cascadePosition(p1, size, [{ x: 103, y: 98 }], area), p2, 'сдвиг на пару пикселей — то же место');
});

test('лесенка упёрлась в край экрана — новая начинается сверху слева, а не за экраном', () => {
  const low = { x: 1300, y: 600 };
  const p = cascadePosition(low, size, [low], area);
  assert.deepStrictEqual(p, { x: STEP, y: 0 });
  assert.ok(p.x + size.width <= area.width && p.y + size.height <= area.height);
});

test('второй монитор со сдвинутыми координатами — лесенка остаётся на нём', () => {
  const right = { x: 1920, y: 0, width: 1280, height: 984 };
  const p1 = centerIn(right, size);
  const p2 = cascadePosition(p1, size, [p1], right);
  assert.ok(p2.x >= right.x && p2.x + size.width <= right.x + right.width);
});

test('центр рабочей области — как ставит окно сама Windows', () => {
  assert.deepStrictEqual(centerIn(area, size), { x: 673, y: 309 });
  assert.deepStrictEqual(centerIn({ x: 0, y: 0, width: 400, height: 300 }, size), { x: 0, y: 0 }, 'окно больше экрана — от угла');
});
