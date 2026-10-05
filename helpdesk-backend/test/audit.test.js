'use strict';

require("./helpers/isolateEnv");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { freshDb } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");

// ============================================================================
//  Журнал действий администраторов (services/audit.js)
//
//  Проверяется: изменение настроек попадает в журнал с тем, кто его сделал;
//  пароль в журнал не попадает ни в каком виде; отказ и проверка («Проверить
//  папку») действием не считаются; читать журнал может только администратор;
//  у каждого изменяющего маршрута административных разделов есть человеческая
//  подпись. Имена и адреса выдуманы.
// ============================================================================

async function stand(t) {
  const { db, cleanup } = freshDb();
  await makeLocalUser(db, { login: "adm1", name: "Стендов Стенд Стендович", isAdmin: true });
  await makeLocalUser(db, { login: "u1", name: "Макетов Макет" });
  const app = await startApp(db);
  t.after(async () => { await app.close(); cleanup(); });
  const Adm = client(app.url); await Adm.login("adm1");
  const U = client(app.url); await U.login("u1");
  const rows = async (q = "") => (await Adm.get(`/api/admin/audit${q}`)).json.rows;
  return { db, app, Adm, U, rows };
}

test("изменение настроек записывается: кто, что, подробности", async (t) => {
  const { Adm, rows } = await stand(t);
  assert.strictEqual((await Adm.put("/api/admin/settings", { departments: [{ role: "it", groupA: "Исполнители-ИТ", groupB: "" }] })).status, 200);
  assert.strictEqual((await Adm.put("/api/notifications/schedule", { hour: 8 })).status, 200);

  const list = await rows();
  const [hour, groups, login] = list;
  assert.strictEqual(hour.summary, "Оповещения: час ежедневных заданий — 8:00");
  assert.strictEqual(groups.summary, "Группы домена для отделов изменены");
  assert.deepStrictEqual(groups.details, { отделы: [{ отдел: "it", "группа в домене A": "Исполнители-ИТ", "группа в домене B": "" }] });
  assert.strictEqual(groups.login, "adm1");
  assert.strictEqual(groups.full_name, "Стендов Стенд Стендович");
  assert.match(groups.at, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.strictEqual(login.summary, "Вход администратора", "вход администратора — тоже запись");
});

test("пароль в журнал не попадает; про него — только «изменён»", async (t) => {
  const { db, Adm, rows } = await stand(t);
  const SECRET = "пароль-приложения-ящика";
  const box = await Adm.post("/api/mailings/settings/mailboxes", { address: "otdel@example.invalid", password: SECRET, ad_group: "Рассылка-Цены" });
  assert.strictEqual(box.status, 201, box.text);
  await Adm.put(`/api/mailings/settings/mailboxes/${box.json.id}`, { password: "другой-" + SECRET });
  await Adm.put("/api/notifications/smtp", { host: "mail.example.invalid", port: 465, secure: true, user: "otdel@example.invalid", password: SECRET, from: "otdel@example.invalid" });
  await Adm.delete(`/api/mailings/settings/mailboxes/${box.json.id}`);

  const list = await rows();
  assert.deepStrictEqual(list.slice(0, 4).map((r) => r.summary), [
    "Рассылки: удалён общий ящик otdel@example.invalid",       // адрес снят до удаления
    "Почта оповещений: настройки изменены",
    "Рассылки: изменён общий ящик otdel@example.invalid",
    "Рассылки: добавлен общий ящик otdel@example.invalid",
  ]);
  assert.strictEqual(list[1].details.пароль, "изменён");
  assert.strictEqual(list[3].details.пароль, "задан");
  const dump = JSON.stringify(db.prepare("SELECT * FROM admin_audit").all());
  assert.ok(!dump.includes(SECRET), "пароль попал в журнал");
});

test("отказ, ошибка и проверка действием не считаются", async (t) => {
  const { Adm, U, rows } = await stand(t);
  const before = (await rows()).length;
  assert.strictEqual((await U.put("/api/admin/settings", { departments: [] })).status, 403, "не администратор");
  assert.strictEqual((await Adm.put("/api/notifications/schedule", { hour: 99 })).status, 400, "неверное значение");
  assert.strictEqual((await Adm.post("/api/admin/backup/check", { dir: require("node:os").tmpdir() })).status, 200, "проверка папки");
  assert.strictEqual((await rows()).length, before, "ни одной новой записи");
});

test("обычные действия сотрудников в журнал не пишутся", async (t) => {
  const { U, rows } = await stand(t);
  const before = (await rows()).length;
  assert.strictEqual((await U.post("/api/tickets", { title: "Не печатает принтер", description: "", category: "ИТ", priority: "low", room: "1" })).status, 201);
  assert.strictEqual((await rows()).length, before);
});

test("читать журнал может только администратор; поиск без учёта регистра и страницы", async (t) => {
  const { Adm, U, rows } = await stand(t);
  assert.strictEqual((await U.get("/api/admin/audit")).status, 403);
  for (let h = 1; h <= 5; h++) await Adm.put("/api/notifications/schedule", { hour: h });
  assert.strictEqual((await rows("?q=" + encodeURIComponent("ОПОВЕЩЕНИЯ: ЧАС"))).length, 5, "кириллица ищется без учёта регистра");
  assert.strictEqual((await rows("?q=стендов")).length, 6, "поиск по имени — вместе со входом");

  const first = (await Adm.get("/api/admin/audit?limit=2")).json;
  assert.strictEqual(first.rows.length, 2);
  assert.strictEqual(first.more, true);
  const next = (await Adm.get(`/api/admin/audit?limit=2&before=${first.rows[1].id}`)).json;
  assert.ok(next.rows[0].id < first.rows[1].id, "следующая страница — более старые записи");
});

test("записей журнала нельзя ни изменить, ни удалить через API", async (t) => {
  const { Adm } = await stand(t);
  for (const m of ["post", "put", "delete", "patch"]) {
    const r = await Adm[m]("/api/admin/audit", {});
    assert.ok(r.status === 404 || r.status === 405, `${m}: ${r.status}`);
  }
});

test("у каждого изменяющего маршрута административных разделов — своя подпись", () => {
  const { findRule, AREAS } = require("../services/audit");
  const routes = path.join(__dirname, "..", "routes");
  const mounts = [
    ["admin.js", "/api/admin", /router\.(post|put|patch|delete)\("([^"]+)"/g],
    ["certificates.js", "/api/certificates", /router\.(post|put|patch|delete)\("([^"]+)"/g],
    ["notifications.js", "/api/notifications", /router\.(post|put|patch|delete)\("([^"]+)"/g],
    ["mailings.js", "/api/mailings", /router\.(post|put|patch|delete)\("([^"]+)"/g],
    ["assistant.js", "/api/assistant/settings", /admin\.(post|put|patch|delete)\("([^"]+)"/g],
  ];
  const missing = [];
  let checked = 0;
  for (const [file, prefix, re] of mounts) {
    const src = fs.readFileSync(path.join(routes, file), "utf8");
    for (const m of src.matchAll(re)) {
      const url = (prefix + m[2]).replace(/:id\b/g, "7").replace(/:[a-zA-Z]+/g, "x").replace(/\/$/, "");
      // Оповещения: маршрут под охраной администратора (`it`) обязан входить в разделы журнала —
      // иначе раздел, появившийся позже, молча в журнал не попадёт (так было с expiry-task, PR #48).
      const guarded = file === "notifications.js" && src.includes(`router.${m[1]}("${m[2]}", it`);
      if (guarded && !AREAS.some((a) => a.test(url))) missing.push(`${m[1].toUpperCase()} ${url} — не входит в разделы журнала`);
      if (!AREAS.some((a) => a.test(url))) continue;          // не административный раздел
      checked++;
      if (!findRule(m[1].toUpperCase(), url)) missing.push(`${m[1].toUpperCase()} ${url}`);
    }
  }
  assert.ok(checked >= 20, `проверено маршрутов: ${checked} — тест перестал их находить`);
  assert.deepStrictEqual(missing, [], "добавьте правило в RULES (services/audit.js): без него запись будет вида «PUT /api/…»");
});

test("настройка задачи на перевыпуск записывается; личная отметка «прочитано» — нет", async (t) => {
  const { Adm, U, rows } = await stand(t);
  const r = await Adm.put("/api/notifications/expiry-task", { days: 14 });
  assert.strictEqual(r.status, 200, r.text);
  const [last] = await rows();
  assert.strictEqual(last.summary, "Сроки документов: задача на перевыпуск — настройки изменены");
  assert.deepStrictEqual(last.details, { "за сколько дней заводить": 14 });

  const before = (await rows()).length;
  await U.patch("/api/notifications/1/read", {});
  await U.patch("/api/notifications/ticket/1/read", {});
  await Adm.patch("/api/notifications/1/read", {});
  assert.strictEqual((await rows()).length, before, "отметки «прочитано» — не действие администратора");
});
