'use strict';

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const { freshDb } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");

// ============================================================================
//  Прокси модулей
//
//  Модули слушают только 127.0.0.1 и про вход ничего не знают: и проверка
//  сессии, и проверка роли живут здесь. Проверяем ровно это, а заодно — что
//  тело запроса доезжает до модуля целым.
// ============================================================================

/** Поддельный модуль: записывает всё, что до него дошло. */
async function fakeModule() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      received.push({
        method: req.method,
        url: req.url,
        contentType: req.headers["content-type"] || "",
        contentLength: req.headers["content-length"],
        body,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    received,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function stand(t) {
  const mod = await fakeModule();
  process.env.MODULE_SMDR_URL = `http://127.0.0.1:${mod.port}`;

  const { db, cleanup } = freshDb(); // сбрасывает кэш модулей — адрес подхватится
  const app = await startApp(db);
  t.after(async () => { await app.close(); await mod.close(); cleanup(); delete process.env.MODULE_SMDR_URL; });

  await makeLocalUser(db, { login: "!ит", name: "Админ Тестовый", role: "it", isAdmin: true });
  await makeLocalUser(db, { login: "!сотрудник", name: "Сотрудник Тестовый", role: "user" });
  return { app, mod };
}

test("без входа модуль недоступен", async (t) => {
  const { app, mod } = await stand(t);
  const аноним = client(app.url);
  const r = await аноним.get("/modules/smdr/");
  assert.strictEqual(r.status, 401);
  assert.strictEqual(mod.received.length, 0, "запрос не должен был дойти до модуля вовсе");
});

test("роль без права доступа не пускают, и запрос до модуля не доходит", async (t) => {
  const { app, mod } = await stand(t);
  const сотрудник = client(app.url);
  await сотрудник.login("!сотрудник");
  const r = await сотрудник.get("/modules/smdr/");
  assert.strictEqual(r.status, 403);
  assert.strictEqual(mod.received.length, 0);
});

test("вошедший администратор доходит до модуля", async (t) => {
  const { app, mod } = await stand(t);
  const админ = client(app.url);
  await админ.login("!ит");
  const r = await админ.get("/modules/smdr/directory");
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(mod.received.length, 1);
  assert.strictEqual(mod.received[0].url, "/directory", "префикс модуля должен срезаться");
});

test("тело формы доезжает до модуля целым", async (t) => {
  const { app, mod } = await stand(t);
  const админ = client(app.url);
  await админ.login("!ит");

  // Справочник журнала звонков сохраняется обычной HTML-формой,
  // то есть application/x-www-form-urlencoded.
  const тело = "ext=305&name=" + encodeURIComponent("Кабинет 305");
  const r = await fetch(`${app.url}/modules/smdr/directory`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: админ.cookie,
    },
    body: тело,
  });
  assert.strictEqual(r.status, 200, `прокси ответил ${r.status}`);
  assert.strictEqual(mod.received.length, 1, "запрос должен был дойти до модуля");
  assert.strictEqual(mod.received[0].body, тело,
    "модуль получил не то тело, что отправил браузер — сохранение в справочнике не работает");
});

test("тело JSON доезжает до модуля целым", async (t) => {
  const { app, mod } = await stand(t);
  const админ = client(app.url);
  await админ.login("!ит");
  const r = await админ.post("/modules/smdr/api/x", { ext: "305", name: "Кабинет 305" });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(JSON.parse(mod.received[0].body), { ext: "305", name: "Кабинет 305" });
});
