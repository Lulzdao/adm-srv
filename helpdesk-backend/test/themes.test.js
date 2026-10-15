'use strict';

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// ============================================================================
//  Цветовые темы (public/theme.js, themes.css)
//
//  Тема — набор переменных. Она работает, только пока правила стилей берут
//  цвета из переменных: один цвет, вписанный в правило напрямую, — и в тёмной
//  теме посреди страницы белое пятно. Поэтому тесты стерегут две вещи: в
//  стилях нет цветов в обход переменных, и у каждой темы из списка есть свой
//  набор. Плюс логика выбора: тема своя у каждого логина, без хранилища — не
//  падает. theme.js проверяется живой — исполняется как в браузере.
// ============================================================================

const PUB = path.join(__dirname, "..", "public");
const read = (f) => fs.readFileSync(path.join(PUB, f), "utf8");

/** Исполнить theme.js в поддельной странице. store — содержимое localStorage. */
function loadTheme(store = {}, { broken = false } = {}) {
  const attrs = {};
  const listeners = {};
  const sandbox = {
    document: { documentElement: {
      setAttribute: (k, v) => { attrs[k] = v; },
      removeAttribute: (k) => { delete attrs[k]; },
    } },
    localStorage: {
      getItem: (k) => { if (broken) throw new Error("хранилище недоступно"); return k in store ? store[k] : null; },
      setItem: (k, v) => { if (broken) throw new Error("хранилище недоступно"); store[k] = String(v); },
    },
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
  };
  vm.runInNewContext(read("theme.js"), sandbox);
  return { theme: sandbox.window.CenterTheme, attrs, store, listeners };
}

test("у каждого акцента есть набор и для цветной/светлой, и для тёмной темы; лишних наборов нет", () => {
  const { theme } = loadTheme();
  // Array.from: список создан в другом контексте (vm) — его массив формально другого типа.
  assert.deepStrictEqual(Array.from(theme.modes, (m) => m.id), ["color", "light", "dark"]);
  const accents = Array.from(theme.accents, (a) => a.id);
  assert.deepStrictEqual(accents, ["ember", "garnet", "pink", "gold", "jade", "azure", "violet"], "порядок — как в клиенте «Искры», плюс розовый");
  const css = read("themes.css");
  const light = [...new Set([...css.matchAll(/html\[data-accent="([a-z]+)"\]:not\(\[data-theme="dark"\]\) \{\r?\n/g)].map((m) => m[1]))].sort();
  const dark = [...new Set([...css.matchAll(/html\[data-theme="dark"\]\[data-accent="([a-z]+)"\] \{/g)].map((m) => m[1]))].sort();
  // Лазурь — акцент по умолчанию: светлый набор — сам :root в styles.css, тёмный — базовый блок тёмной темы.
  const others = accents.filter((a) => a !== "azure").sort();
  assert.deepStrictEqual(light, others, "светлые наборы акцентов");
  assert.deepStrictEqual(dark, others, "тёмные наборы акцентов");
  assert.ok(/html\[data-theme="dark"\] \{\r?\n\s*color-scheme: dark;/.test(css), "базовый набор тёмной темы");
  assert.ok(/html:root\[data-theme="light"\] \{/.test(css), "светлая тема: белая боковая панель");
  assert.ok(!/data-theme="(blue|lilac|emerald|pink)"/.test(css), "прежних тем в стилях не осталось");
});

test("в правилах styles.css нет цветов в обход переменных", () => {
  const lines = read("styles.css").split("\n");
  const start = lines.findIndex((l) => l.startsWith("/* --- Полоса прокрутки"));
  assert.ok(start > 0, "не найден конец блока переменных — тест устарел");
  // Что разрешено вписывать прямо: сигнальные цвета приоритета (одни во всех темах) и тени.
  const allowed = [/border-left-color: #(E7004B|FF8B3A|BFBFBF)/, /\.td-feed > div\.sys::before \{ background: #FF8B3A/, /box-shadow:[^;]*rgba\(/];
  const bad = [];
  lines.slice(start).forEach((l, i) => {
    const code = l.replace(/\/\*.*?\*\//g, "");
    if (!/#[0-9A-Fa-f]{3,8}\b|rgba?\(/.test(code)) return;
    if (allowed.some((re) => re.test(code))) return;
    bad.push(`${start + i + 1}: ${l.trim().slice(0, 100)}`);
  });
  assert.deepStrictEqual(bad, [], "цвет вписан в правило напрямую — тёмная тема его не перекрасит; заведите переменную в :root");
});

test("переменные, на которые ссылаются правила, объявлены в :root", () => {
  const css = read("styles.css");
  const declared = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)\s*[,)]/g)].map((m) => m[1]));
  // Часть переменных задаёт код страниц прямо на элементе (style="--c: …" — цвет плитки отдела).
  const js = fs.readdirSync(PUB).filter((f) => f.endsWith(".js")).map(read).join(" ");
  const inline = new Set([...js.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  assert.deepStrictEqual([...used].filter((v) => !declared.has(v) && !inline.has(v)), []);
  // И тема не задаёт переменных, которых в стилях нет: опечатка в имени молча не сработала бы.
  const themed = new Set([...read("themes.css").matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
  // --md-warn-edge есть только у модулей (Сертвивер), там она с запасным значением.
  assert.deepStrictEqual([...themed].filter((v) => !declared.has(v) && v !== "--md-warn-edge"), []);
});

test("выбор запоминается для вошедшего сотрудника; сменщик на том же компьютере видит своё оформление", () => {
  const store = {};
  let { theme, attrs } = loadTheme(store);
  assert.deepStrictEqual({ ...theme.get() }, { mode: "color", accent: "azure" });
  assert.strictEqual(attrs["data-theme"], undefined, "цветная — без атрибута");
  assert.strictEqual(attrs["data-accent"], undefined, "лазурь — без атрибута");

  theme.useUser("Ivanov");
  theme.setMode("dark");
  theme.setAccent("violet");
  assert.strictEqual(attrs["data-theme"], "dark");
  assert.strictEqual(attrs["data-accent"], "violet");
  assert.strictEqual(store["center.mode:ivanov"], "dark");
  assert.strictEqual(store["center.accent:ivanov"], "violet");
  assert.strictEqual(store["center.mode"], "dark", "модули внутри «Центра» читают общий ключ");

  // Вошёл другой человек, ничего не выбирал: остаётся действующее в браузере, пока не выберет своё.
  theme.useUser("petrov");
  assert.deepStrictEqual({ ...theme.get() }, { mode: "dark", accent: "violet" });
  theme.setMode("light");
  theme.setAccent("ember");
  assert.strictEqual(store["center.accent:petrov"], "ember");
  assert.strictEqual(store["center.mode:petrov"], "light");
  assert.strictEqual(store["center.accent:ivanov"], "violet", "чужой выбор не тронут");

  // Перезагрузка страницы и снова Иванов (регистр логина не важен).
  ({ theme, attrs } = loadTheme(store));
  assert.strictEqual(attrs["data-accent"], "ember", "до входа — последнее действовавшее");
  assert.strictEqual(attrs["data-theme"], "light", "светлая — белая боковая панель");
  theme.useUser("IVANOV");
  assert.strictEqual(attrs["data-theme"], "dark");
  assert.strictEqual(attrs["data-accent"], "violet");
});

test("выбор, сделанный до обновления (одна тема из списка), переносится", () => {
  const cases = { blue: [undefined, undefined], light: ["light", undefined], dark: ["dark", undefined],
    lilac: [undefined, "violet"], emerald: [undefined, "jade"], pink: [undefined, "pink"] };
  for (const [old, [mode, accent]] of Object.entries(cases)) {
    const { attrs } = loadTheme({ "center.theme": old });
    assert.strictEqual(attrs["data-theme"], mode, `${old}: тема`);
    assert.strictEqual(attrs["data-accent"], accent, `${old}: акцент`);
  }
  // У сотрудника своя прежняя тема — после входа применяется она.
  const store = { "center.theme": "blue", "center.theme:ivanov": "pink" };
  const { theme, attrs } = loadTheme(store);
  theme.useUser("ivanov");
  assert.strictEqual(attrs["data-accent"], "pink");
});

test("неизвестные значения и недоступное хранилище — оформление по умолчанию, без ошибок", () => {
  const a = loadTheme({ "center.mode": "фиолетовая", "center.accent": "красно-зелёный", "center.theme": "нет-такой" });
  assert.deepStrictEqual({ ...a.theme.get() }, { mode: "color", accent: "azure" });
  a.theme.setMode("нет-такой"); a.theme.setAccent("нет-такого");
  assert.strictEqual(a.attrs["data-theme"], undefined);
  assert.strictEqual(a.attrs["data-accent"], undefined);

  const b = loadTheme({}, { broken: true });
  assert.deepStrictEqual({ ...b.theme.get() }, { mode: "color", accent: "azure" });
  b.theme.setAccent("jade");
  b.theme.setMode("dark");
  assert.strictEqual(b.attrs["data-accent"], "jade", "на время сеанса выбор всё же применяется");
  assert.strictEqual(b.attrs["data-theme"], "dark");
});

test("оформление меняется в других вкладках и встроенных модулях сразу (событие storage)", () => {
  const store = {};
  const { attrs, listeners } = loadTheme(store);
  store["center.accent"] = "jade";            // выбрали в соседней вкладке
  store["center.mode"] = "dark";
  listeners.storage({ key: "center.accent" });
  assert.strictEqual(attrs["data-accent"], "jade");
  assert.strictEqual(attrs["data-theme"], "dark");
});

test("страницы платформы и модулей подключают темы", () => {
  const index = read("index.html");
  assert.ok(index.indexOf('src="/theme.js"') < index.indexOf('href="/styles.css"'), "theme.js — до стилей, иначе страница мигает голубой");
  assert.ok(index.includes('href="/themes.css"'));
  const root = path.join(__dirname, "..", "..");
  for (const f of ["CERTVIEWER/public/index.html", "CERTVIEWER/public/mchd.html", "SMDR/web-node/views/dashboard.ejs",
    "SMDR/web-node/views/directory.ejs", "SMDR/web-node/views/stats.ejs", "MESSENGER/public/index.html"]) {
    const file = path.join(root, f);
    if (!fs.existsSync(file)) continue;   // на сервере модуль может стоять отдельно
    const html = fs.readFileSync(file, "utf8");
    assert.ok(html.includes('src="/theme.js"') && html.includes('href="/themes.css"'), `${f}: тема не подключена`);
  }
});
