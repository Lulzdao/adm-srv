'use strict';

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// ============================================================================
//  Раздел «Игры» (public/app-games.js)
//
//  Игры целиком в браузере, сервер про них не знает — проверять можно только
//  правила. Они отделены от отрисовки и к странице не обращаются, поэтому файл
//  исполняется здесь ЖИВЫМ, как в браузере: копия правил в тесте разошлась бы
//  с оригиналом при первой же правке. Заодно это сторож: если на верхнем
//  уровне файла появится обращение к странице, загрузка упадёт.
// ============================================================================

const PUB = path.join(__dirname, "..", "public");

function loadGames() {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(PUB, "app-games.js"), "utf8"), ctx);
  // Объявления const в общий объект не попадают — достаём их отдельным выражением в том же контексте.
  const pick = (name) => vm.runInContext(name, ctx);
  return { g: ctx, pick };
}

/** Предсказуемый генератор случайных чисел: партии в тестах одни и те же. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

test("змейка: шаг, еда, стена, свой хвост", () => {
  const { g } = loadGames();
  const s = g.gamesSnakeNew(10, 10, seeded(1));
  assert.deepStrictEqual([...s.body], [55, 54, 53], "старт — по центру, головой вправо");
  assert.ok(s.food >= 0 && !s.body.includes(s.food), "еда не лежит на змейке");

  s.food = 56;
  g.gamesSnakeStep(s, seeded(2));
  assert.deepStrictEqual([...s.body], [56, 55, 54, 53], "съела — выросла на клетку");
  assert.strictEqual(s.score, 1);
  assert.ok(s.food !== 56 && !s.body.includes(s.food), "новая еда — на свободной клетке");

  s.food = 0;
  g.gamesSnakeStep(s);
  assert.deepStrictEqual([...s.body], [57, 56, 55, 54], "без еды длина не меняется");

  g.gamesSnakeStep(s); g.gamesSnakeStep(s);
  assert.strictEqual(s.body[0], 59);
  assert.strictEqual(s.over, false, "у самой стены — ещё жива");
  g.gamesSnakeStep(s);
  assert.strictEqual(s.over, true, "шаг за край поля — конец");
  assert.strictEqual(s.body[0], 59, "после конца игры змейка не двигается");

  // Свой хвост: квадрат 2×2 из четырёх клеток — голова идёт на клетку хвоста, и это можно
  // (хвост в тот же шаг уходит); в середину тела — нельзя.
  const loop = { w: 10, h: 10, body: [11, 12, 2, 1], dir: "left", queue: ["up"], food: 99, score: 0, over: false, won: false };
  g.gamesSnakeStep(loop);
  assert.strictEqual(loop.over, false, "на клетку уходящего хвоста зайти можно");
  assert.deepStrictEqual([...loop.body], [1, 11, 12, 2]);
  const bite = { w: 10, h: 10, body: [11, 12, 2, 1, 0], dir: "left", queue: ["up"], food: 99, score: 0, over: false, won: false };
  g.gamesSnakeStep(bite);
  assert.strictEqual(bite.over, true, "в собственное тело — конец");
});

test("змейка: повороты копятся, разворот на месте отбрасывается", () => {
  const { g } = loadGames();
  const s = g.gamesSnakeNew(10, 10, seeded(3));
  assert.strictEqual(g.gamesSnakeTurn(s, "left"), false, "назад на ходу нельзя");
  assert.strictEqual(g.gamesSnakeTurn(s, "right"), false, "то же направление — не поворот");
  assert.strictEqual(g.gamesSnakeTurn(s, "up"), true);
  // «Вверх, вниз» за один шаг: сверяем с последним запрошенным, иначе змейка развернулась бы в себя.
  assert.strictEqual(g.gamesSnakeTurn(s, "down"), false);
  assert.strictEqual(g.gamesSnakeTurn(s, "left"), true, "второй поворот до шага — в очередь");
  assert.strictEqual(g.gamesSnakeTurn(s, "down"), false, "третий — уже лишний");
  s.food = 99;
  g.gamesSnakeStep(s);
  assert.strictEqual(s.body[0], 45, "первый шаг — вверх");
  g.gamesSnakeStep(s);
  assert.strictEqual(s.body[0], 44, "второй — влево");
});

test("змейка: поле заполнено — победа, а не зависание на поиске места для еды", () => {
  const { g } = loadGames();
  const s = { w: 2, h: 2, body: [1, 0, 2], dir: "down", queue: [], food: 3, score: 0, over: false, won: false };
  g.gamesSnakeStep(s);
  assert.strictEqual(s.body.length, 4);
  assert.strictEqual(s.food, -1);
  assert.ok(s.over && s.won);
});

// Собирается ли раскладка 4×4: число беспорядков + номер ряда пустой клетки (с единицы, сверху) — чётное.
// Формула здесь своя, от кода игры не зависит.
function solvable(t) {
  const flat = t.filter((v) => v);
  let inv = 0;
  for (let i = 0; i < flat.length; i++) for (let j = i + 1; j < flat.length; j++) if (flat[i] > flat[j]) inv++;
  return (inv + Math.floor(t.indexOf(0) / 4) + 1) % 2 === 0;
}

test("пятнашки: перемешанное поле всегда собирается и не собрано заранее", () => {
  const { g } = loadGames();
  const solved = Array.from({ length: 16 }, (_, i) => (i + 1) % 16);
  assert.ok(solvable(solved) && g.gamesFifteenSolved(solved));
  const swapped = solved.slice(); [swapped[13], swapped[14]] = [swapped[14], swapped[13]];
  assert.ok(!solvable(swapped), "проверочная формула отличает несобираемую раскладку (14 и 15 переставлены)");

  for (let seed = 1; seed <= 40; seed++) {
    const t = g.gamesFifteenShuffle(seeded(seed));
    assert.deepStrictEqual([...t].sort((a, b) => a - b), solved.slice().sort((a, b) => a - b), "все фишки на месте, без повторов");
    assert.ok(!g.gamesFifteenSolved(t), `раскладка ${seed} выдана уже собранной`);
    assert.ok(solvable(t), `раскладка ${seed} не собирается`);
  }
});

test("пятнашки: сдвиг ряда и столбца целиком, чужие клетки не двигаются", () => {
  const { g } = loadGames();
  const t = Array.from({ length: 16 }, (_, i) => (i + 1) % 16);      // пустая — последняя (15)
  assert.strictEqual(g.gamesFifteenMove(t, 15), 0, "сама пустая клетка");
  assert.strictEqual(g.gamesFifteenMove(t, 10), 0, "не тот ряд и не тот столбец");
  assert.strictEqual(g.gamesFifteenMove(t, 16), 0);
  assert.strictEqual(g.gamesFifteenMove(t, -1), 0);
  assert.strictEqual(g.gamesFifteenMove(t, 1.5), 0);

  assert.strictEqual(g.gamesFifteenMove(t, 12), 3, "щелчок по дальней фишке ряда двигает три");
  assert.deepStrictEqual([...t.slice(12)], [0, 13, 14, 15]);
  assert.strictEqual(g.gamesFifteenMove(t, 0), 3, "и столбца — тоже");
  assert.deepStrictEqual([t[0], t[4], t[8], t[12]], [0, 1, 5, 9]);
  assert.strictEqual(g.gamesFifteenMove(t, 1), 1);
  assert.deepStrictEqual([...t.slice(0, 4)], [2, 0, 3, 4]);
  assert.ok(!g.gamesFifteenSolved(t));
  // Край ряда — не сосед через строку: клетка 3 и клетка 4 стоят рядом по номеру, но не на поле.
  const edge = [1, 2, 3, 0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 4];
  assert.strictEqual(g.gamesFifteenMove(edge, 4), 0);
});

test("битые секторы: первый щелчок и его соседи безопасны, числа — по соседям", () => {
  const { g, pick } = loadGames();
  for (const size of pick("GAMES_SECTOR_SIZES")) {
    for (const safe of [0, size.w - 1, Math.floor(size.w * size.h / 2), size.w * size.h - 1]) {
      const f = g.gamesSectorsField(size.w, size.h, size.bad, safe, seeded(safe + 7));
      assert.strictEqual(f.length, size.w * size.h);
      assert.strictEqual(f.filter((v) => v === -1).length, size.bad, `${size.label}: битых ровно столько, сколько заявлено`);
      assert.strictEqual(f[safe], 0, `${size.label}: первый сектор — «ноль», открывает кусок поля`);
      f.forEach((v, i) => {
        if (v === -1) return;
        assert.strictEqual(v, g.gamesNeighbors(size.w, size.h, i).filter((n) => f[n] === -1).length, `число в секторе ${i}`);
      });
    }
  }
  // Тесное поле: вокруг первого сектора места нет — бережём хотя бы его самого.
  const tight = g.gamesSectorsField(3, 3, 8, 4, seeded(5));
  assert.strictEqual(tight[4], 8);
  assert.strictEqual(tight.filter((v) => v === -1).length, 8);
});

test("битые секторы: соседи на краю поля, растекание от нуля, флажки и битый сектор", () => {
  const { g } = loadGames();
  assert.deepStrictEqual([...g.gamesNeighbors(3, 3, 0)].sort(), [1, 3, 4], "угол — три соседа, без перехода через край");
  assert.strictEqual(g.gamesNeighbors(3, 3, 4).length, 8);
  assert.deepStrictEqual([...g.gamesNeighbors(4, 2, 3)].sort(), [2, 6, 7]);

  // 4×3, один битый в правом нижнем углу:
  //   0 0 0 0
  //   0 0 1 1
  //   0 0 1 *
  const field = [0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, -1];
  let opened = new Array(12).fill(false);
  const got = g.gamesSectorsOpen(field, opened, 4, 3, 0);
  assert.strictEqual(got.length, 11, "от нуля открылось всё, кроме битого");
  assert.strictEqual(opened[11], false);

  opened = new Array(12).fill(false);
  assert.deepStrictEqual([...g.gamesSectorsOpen(field, opened, 4, 3, 6)], [6], "число открывается одно");
  assert.deepStrictEqual([...g.gamesSectorsOpen(field, opened, 4, 3, 6)], [], "повторно — ничего");
  assert.deepStrictEqual([...g.gamesSectorsOpen(field, opened, 4, 3, 11)], [11], "битый открывается сам и соседей не тянет");

  opened = new Array(12).fill(false);
  const flags = new Array(12).fill(false);
  flags[5] = true;
  g.gamesSectorsOpen(field, opened, 4, 3, 0, flags);
  assert.strictEqual(opened[5], false, "помеченный флажком при растекании не открывается");
  assert.strictEqual(opened[6], true);
});

test("пары: каждый значок ровно дважды, и все значки есть в общем наборе", () => {
  const { g, pick } = loadGames();
  const icons = pick("GAMES_PAIR_ICONS");
  assert.strictEqual(new Set(icons).size, icons.length, "в наборе нет повторов — иначе пар одного значка было бы четыре");
  const deck = g.gamesPairsDeck(icons, 10, seeded(11));
  assert.strictEqual(deck.length, 20);
  const count = {};
  for (const name of deck) count[name] = (count[name] || 0) + 1;
  assert.strictEqual(Object.keys(count).length, 10);
  assert.ok(Object.values(count).every((n) => n === 2));

  // Значки рисует icon() из app.js: имени, которого там нет, соответствовала бы пустая карточка.
  const app = fs.readFileSync(path.join(PUB, "app.js"), "utf8");
  const has = (name) => new RegExp(`^  '?${name}'?: '<`, "m").test(app);
  for (const name of icons) assert.ok(has(name), `значка «${name}» нет в ICON_PATHS`);
  for (const game of pick("GAMES")) assert.ok(has(game.icon), `значка игры «${game.icon}» нет в ICON_PATHS`);
  for (const name of ["gamepad", "flag", "refresh", "x", "chevron"]) assert.ok(has(name), `значка «${name}» нет в ICON_PATHS`);
});

test("перемешивание ничего не теряет, подписи согласованы с числом", () => {
  const { g } = loadGames();
  const src = [1, 2, 3, 4, 5, 6, 7];
  const out = g.gamesShuffle(src, seeded(4));
  assert.deepStrictEqual(src, [1, 2, 3, 4, 5, 6, 7], "исходный массив не тронут");
  assert.deepStrictEqual([...out].sort(), src);

  const forms = ["ход", "хода", "ходов"];
  const say = (n) => g.gamesPlural(n, forms);
  assert.deepStrictEqual([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, 112].map(say),
    ["ход", "хода", "хода", "ходов", "ходов", "ходов", "ходов", "ход", "хода", "ходов", "ход", "ходов", "ходов"]);
  assert.strictEqual(g.gamesTime(0), "0:00");
  assert.strictEqual(g.gamesTime(65), "1:05");
  assert.strictEqual(g.gamesTime(600), "10:00");
});

test("раздел подключён: скрипт в index.html до настроек, экран есть у каждой игры, адреса разделов узнаются", () => {
  const { g, pick } = loadGames();
  const index = fs.readFileSync(path.join(PUB, "index.html"), "utf8");
  const at = index.indexOf('src="/app-games.js"');
  assert.ok(at > index.indexOf('src="/app.js"'), "app-games.js подключён после основы");
  assert.ok(at < index.indexOf('src="/app-settings.js"'), "настройки — последними");

  const games = pick("GAMES"), screens = pick("GAMES_SCREENS");
  assert.deepStrictEqual(Object.keys(screens).sort(), Array.from(games, (x) => x.id).sort());
  assert.ok(g.gamesViewExists("games"));
  for (const game of games) {
    assert.ok(g.gamesViewExists(`games:${game.id}`));
    assert.strictEqual(typeof game.record({}), "string", "без рекордов подпись пустая, а не undefined");
  }
  assert.ok(!g.gamesViewExists("games:нет-такой"), "чужой адрес из якоря не открывается");
  assert.ok(!g.gamesViewExists("games:"));
  // Цвета плиток заданы классами gm-tone-* — у каждого тона игры должен быть свой класс в стилях.
  const css = fs.readFileSync(path.join(PUB, "styles.css"), "utf8");
  for (const game of games) assert.ok(css.includes(`.gm-tone-${game.tone} {`), `нет стиля для тона «${game.tone}»`);
});
