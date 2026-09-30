'use strict';

require("./helpers/isolateEnv");
const test = require("node:test");
const assert = require("node:assert");
const { freshDb } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");

// ============================================================================
//  Сеансы входа переживают перезапуск платформы
//
//  Раньше express-session держал их в памяти процесса: обновление, перезапуск
//  службы, переход на https кнопкой из панели — и из системы выходили все
//  сразу. Теперь сеансы в базе (services/sessionStore.js). Здесь «перезапуск» —
//  новое приложение на той же базе, как после рестарта службы.
// ============================================================================

test("после перезапуска сотрудник остаётся в системе", async (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  await makeLocalUser(db, { login: "!сотрудник", name: "Сотрудник Проверочный" });

  const first = await startApp(db);
  const browser = client(first.url);
  await browser.login("!сотрудник");
  const cookie = browser.cookie;
  assert.strictEqual((await browser.get("/api/auth/me")).status, 200);
  await first.close();

  const second = await startApp(db);
  t.after(() => second.close());
  const same = client(second.url);
  const r = await same.get("/api/auth/me", { headers: { Cookie: cookie } });
  assert.strictEqual(r.status, 200, `сеанс потерян после перезапуска: ${r.text}`);
});

test("выход удаляет сеанс из базы, просроченные вычищаются", async (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  await makeLocalUser(db, { login: "!уходящий", name: "Уходящий Проверочный" });
  const app = await startApp(db);
  t.after(() => app.close());
  const browser = client(app.url);
  await browser.login("!уходящий");
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 1);

  const cookie = browser.cookie;
  await browser.post("/api/auth/logout", {});
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0, "после выхода строки нет");
  assert.strictEqual((await client(app.url).get("/api/auth/me", { headers: { Cookie: cookie } })).status, 401,
    "старая кука после выхода не пускает");

  const { SqliteSessionStore } = require("../services/sessionStore");
  db.prepare("INSERT INTO sessions (sid, sess, expires) VALUES ('старый', '{}', ?)").run(Date.now() - 1000);
  const store = new SqliteSessionStore(db);
  t.after(() => store.close());
  assert.strictEqual(store.cleanup(), 1, "просроченный сеанс удалён");
});
