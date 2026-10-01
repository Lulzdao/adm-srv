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

test("у каждой темы из списка есть набор переменных в themes.css, и наоборот", () => {
  const { theme } = loadTheme();
  // Array.from: список создан в другом контексте (vm) — его массив формально другого типа.
  const ids = Array.from(theme.list, (t) => t.id);
  assert.deepStrictEqual(ids, ["blue", "lilac", "emerald", "pink", "light", "dark"]);
  const css = read("themes.css");
  const inCss = [...new Set([...css.matchAll(/html\[data-theme="([a-z]+)"\]/g)].map((m) => m[1]))].sort();
  // Голубая — тема по умолчанию: её набор — сам :root в styles.css, отдельного блока нет.
  assert.deepStrictEqual(inCss, ids.filter((i) => i !== "blue").sort());
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

test("выбор запоминается для вошедшего сотрудника; сменщик на том же компьютере видит свою тему", () => {
  const store = {};
  let { theme, attrs } = loadTheme(store);
  assert.strictEqual(theme.get(), "blue");
  assert.strictEqual(attrs["data-theme"], undefined, "голубая — без атрибута");

  theme.useUser("Ivanov");
  theme.set("dark");
  assert.strictEqual(attrs["data-theme"], "dark");
  assert.deepStrictEqual(store, { "center.theme": "dark", "center.theme:ivanov": "dark" });

  // Вошёл другой человек, темы не выбирал: остаётся действующая в браузере, пока не выберет свою.
  theme.useUser("petrov");
  assert.strictEqual(theme.get(), "dark");
  theme.set("pink");
  assert.strictEqual(store["center.theme:petrov"], "pink");
  assert.strictEqual(store["center.theme:ivanov"], "dark", "чужой выбор не тронут");

  // Перезагрузка страницы и снова Иванов (регистр логина не важен).
  ({ theme, attrs } = loadTheme(store));
  assert.strictEqual(attrs["data-theme"], "pink", "до входа — последняя действовавшая");
  theme.useUser("IVANOV");
  assert.strictEqual(attrs["data-theme"], "dark");
  assert.strictEqual(store["center.theme"], "dark", "модули внутри «Центра» читают этот ключ");
});

test("неизвестная тема и недоступное хранилище — голубая, без ошибок", () => {
  const a = loadTheme({ "center.theme": "красно-зелёная" });
  assert.strictEqual(a.theme.get(), "blue");
  a.theme.set("нет-такой");
  assert.strictEqual(a.attrs["data-theme"], undefined);

  const b = loadTheme({}, { broken: true });
  assert.strictEqual(b.theme.get(), "blue");
  b.theme.set("lilac");
  assert.strictEqual(b.attrs["data-theme"], "lilac", "на время сеанса тема всё же применяется");
});

test("тема меняется в других вкладках и встроенных модулях сразу (событие storage)", () => {
  const store = {};
  const { attrs, listeners } = loadTheme(store);
  store["center.theme"] = "emerald";            // выбрали в соседней вкладке
  listeners.storage({ key: "center.theme" });
  assert.strictEqual(attrs["data-theme"], "emerald");
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
