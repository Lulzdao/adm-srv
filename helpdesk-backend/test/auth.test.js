'use strict';

const test = require("node:test");
const assert = require("node:assert");

const { freshDb } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");

// ============================================================================
//  Вход: ограничение попыток подбора пароля
//
//  Учётные данные и имена здесь выдуманы.
// ============================================================================

const ПРЕДЕЛ = 10; // LOGIN_MAX_ATTEMPTS в routes/auth.js

async function stand(t) {
  const { db, cleanup } = freshDb();
  const app = await startApp(db);
  t.after(async () => { await app.close(); cleanup(); });
  await makeLocalUser(db, { login: "!жертва", name: "Жертва Тестовая", role: "user" });
  return { db, app };
}

test("подряд идущие попытки блокируются после предела", async (t) => {
  const { app } = await stand(t);
  const кл = client(app.url);

  let четыреста_один = 0;
  let четыреста_двадцать_девять = 0;
  for (let i = 0; i < ПРЕДЕЛ + 5; i++) {
    const r = await кл.post("/api/auth/login", { mode: "local", login: "!жертва", password: "неверный" });
    if (r.status === 401) четыреста_один++;
    if (r.status === 429) четыреста_двадцать_девять++;
  }
  assert.strictEqual(четыреста_один, ПРЕДЕЛ, "проверок пароля должно быть ровно столько, сколько разрешено");
  assert.strictEqual(четыреста_двадцать_девять, 5, "остальные обязаны получить 429");
});

test("одновременные попытки не обходят ограничение", async (t) => {
  const { app } = await stand(t);
  const кл = client(app.url);

  // Подбор пароля не идёт по одной попытке в очередь — он идёт пачкой.
  const ПАЧКА = 60;
  const ответы = await Promise.all(
    Array.from({ length: ПАЧКА }, () =>
      кл.post("/api/auth/login", { mode: "local", login: "!жертва", password: "неверный" })
    )
  );
  const проверено = ответы.filter((r) => r.status === 401).length;
  assert.ok(
    проверено <= ПРЕДЕЛ,
    `пароль проверили ${проверено} раз при пределе ${ПРЕДЕЛ} — ограничение обходится одной пачкой одновременных запросов`
  );
});

test("верный пароль сбрасывает счётчик неудач", async (t) => {
  const { app } = await stand(t);
  const кл = client(app.url);

  for (let i = 0; i < ПРЕДЕЛ - 1; i++) {
    await кл.post("/api/auth/login", { mode: "local", login: "!жертва", password: "неверный" });
  }
  const успех = await кл.post("/api/auth/login", {
    mode: "local", login: "!жертва", password: "пароль-для-теста-1",
  });
  assert.strictEqual(успех.status, 200, успех.text);

  // После удачного входа накопленные неудачи не должны мешать следующему разу.
  const снова = await кл.post("/api/auth/login", { mode: "local", login: "!жертва", password: "неверный" });
  assert.strictEqual(снова.status, 401, "счётчик обязан обнулиться после верного пароля");
});

test("вход требует всех трёх полей и отвечает 400, а не 500", async (t) => {
  const { app } = await stand(t);
  const кл = client(app.url);
  for (const тело of [{}, { mode: "local" }, { mode: "local", login: "!жертва" },
                      { mode: "local", login: { }, password: "x" },
                      { mode: "неизвестный", login: "!жертва", password: "x" }]) {
    const r = await кл.post("/api/auth/login", тело);
    assert.strictEqual(r.status, 400, `для ${JSON.stringify(тело)} ожидался 400, получен ${r.status}`);
  }
});
