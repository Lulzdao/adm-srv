'use strict';

const test = require("node:test");
const assert = require("node:assert");

const { freshDb } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");
const { startFakeSmtp } = require("./helpers/fakeSmtp");

// ============================================================================
//  Маршруты оповещений по HTTP
//
//  Логику рассылки проверяет notifications.test.js на уровне сервиса. Здесь — то,
//  что видит человек в браузере: бейдж «Входящих» и отметка «прочитано», закрытость
//  раздела «Оповещения» для всех, кроме администратора, проверка адресов и порогов
//  при сохранении, досылка после первой настройки списка, предпросмотр шаблона,
//  настройки почты (пароль наружу не отдаётся), пробное письмо, повтор, расписание.
//
//  Адреса и имена выдуманы.
// ============================================================================

async function stand(t) {
  const { db, cleanup } = freshDb();
  const app = await startApp(db);
  t.after(async () => { await app.close(); cleanup(); });

  await makeLocalUser(db, { login: "!админ", name: "Админ Тестовый", role: "it", isAdmin: true, email: "admin@example.test" });
  await makeLocalUser(db, { login: "!итшник", name: "Исполнитель Тестовый", role: "it" });
  await makeLocalUser(db, { login: "!сотрудник", name: "Сотрудник Тестовый", role: "user" });

  const as = async (login) => { const c = client(app.url); await c.login(login); return c; };
  return { db, app, админ: await as("!админ"), исполнитель: await as("!итшник"), сотрудник: await as("!сотрудник") };
}

/** Дождаться условия: рассылка идёт вне запроса, её результат появляется чуть позже. */
async function until(check, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("не дождались");
}

const новаяЗаявка = (кто, тема = "Не печатает принтер") =>
  кто.post("/api/tickets", { title: тема, category: "ИТ", room: "212" });

test("раздел «Оповещения» открыт только администратору", async (t) => {
  const { app, исполнитель, сотрудник } = await stand(t);
  const адреса = [
    ["get", "/api/notifications/feed"], ["get", "/api/notifications/kinds"],
    ["put", "/api/notifications/kinds/expiry", { emails: "x@example.test" }],
    ["get", "/api/notifications/smtp"], ["put", "/api/notifications/smtp", { host: "evil" }],
    ["get", "/api/notifications/schedule"], ["get", "/api/notifications/deliveries"],
    ["post", "/api/notifications/deliveries/retry", {}],
  ];
  for (const кто of [исполнитель, сотрудник]) {
    for (const [метод, адрес, тело] of адреса) {
      const r = await кто[метод](адрес, тело);
      assert.strictEqual(r.status, 403, `${метод.toUpperCase()} ${адрес} для не-админа: ${r.status}`);
    }
  }
  assert.strictEqual((await client(app.url).get("/api/notifications/feed")).status, 401);
});

test("бейдж «Входящих»: новая заявка видна исполнителю отдела, открыл — прочитано", async (t) => {
  const { исполнитель, сотрудник } = await stand(t);
  const заявка = await новаяЗаявка(сотрудник);
  assert.strictEqual(заявка.status, 201, заявка.text);

  const список = await исполнитель.get("/api/notifications");
  assert.strictEqual(список.json.notifications.length, 1);
  const n = список.json.notifications[0];
  assert.strictEqual(n.ticket_id, заявка.json.id);
  assert.strictEqual(n.is_read, 0);
  assert.strictEqual((await сотрудник.get("/api/notifications")).json.notifications.length, 0,
    "автор о своей же заявке отметку не получает");

  // Чужую отметку пометить прочитанной нельзя — запрос проходит, но не трогает её.
  await сотрудник.patch(`/api/notifications/${n.id}/read`);
  assert.strictEqual((await исполнитель.get("/api/notifications")).json.notifications[0].is_read, 0);

  await исполнитель.patch(`/api/notifications/ticket/${заявка.json.id}/read`);
  assert.strictEqual((await исполнитель.get("/api/notifications")).json.notifications[0].is_read, 1);
});

test("адреса и пороги проверяются при сохранении, а не при отправке", async (t) => {
  const { админ } = await stand(t);
  const сохранить = (kind, body) => админ.put(`/api/notifications/kinds/${encodeURIComponent(kind)}`, body);

  let r = await сохранить("expiry", { emails: "ok@example.test\nivanov@\nivanov.ru" });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /ivanov@/, "в ошибке названо, что именно не так");

  r = await сохранить("expiry", { thresholds: "30, abc" });
  assert.strictEqual(r.status, 400);
  r = await сохранить("expiry", { thresholds: "400" });
  assert.strictEqual(r.status, 400, "порог больше года — ошибка");

  r = await сохранить("expiry", { emails: "b@example.test, a@example.test", thresholds: "5, 30,10,30", enabled: false });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.settings.thresholds, "30,10,5", "пороги — без повторов и по убыванию");
  assert.strictEqual(r.json.settings.emails, "b@example.test\na@example.test");
  assert.strictEqual(r.json.settings.enabled, false);

  r = await сохранить("ticket_status", { emails: "x@example.test" });
  assert.strictEqual(r.status, 400, "у категории «автору» своего списка нет");
  r = await сохранить("нет-такой", { emails: "x@example.test" });
  assert.strictEqual(r.status, 404);

  const kinds = (await админ.get("/api/notifications/kinds")).json.kinds;
  const expiry = kinds.find((k) => k.kind === "expiry");
  assert.strictEqual(expiry.thresholds, "30,10,5");
  assert.strictEqual(expiry.enabled, false);
  assert.ok(kinds.some((k) => k.kind === "ticket_new:it"), "категории строятся из справочника отделов");
});

test("список заполнили впервые — письма досылаются по уже случившимся событиям", async (t) => {
  const { db, админ, сотрудник } = await stand(t);
  const smtp = await startFakeSmtp();
  t.after(() => smtp.close());
  await админ.put("/api/notifications/smtp", { host: "127.0.0.1", port: smtp.port, secure: false, from: "it@example.test" });

  await новаяЗаявка(сотрудник, "Заявка до настройки списка");
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM notification_deliveries WHERE channel='email'").get().c, 0);

  const r = await админ.put(`/api/notifications/kinds/${encodeURIComponent("ticket_new:it")}`, { emails: "dezhurny@example.test" });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.backfilled, 1);
  await until(() => smtp.messages.length === 1);
  assert.deepStrictEqual(smtp.messages[0].to, ["dezhurny@example.test"]);
  assert.match(smtp.messages[0].subject, /Заявка до настройки списка/);
});

test("кому уйдёт письмо — видно заранее, в том числе по отделам", async (t) => {
  const { админ } = await stand(t);
  await админ.put(`/api/notifications/kinds/${encodeURIComponent("ticket_new:hoz")}`, { emails: "hoz@example.test" });

  const автору = await админ.get("/api/notifications/kinds/ticket_status/recipients");
  assert.strictEqual(автору.json.mode, "author");

  const заимствует = await админ.get("/api/notifications/kinds/ticket_comment_in/recipients");
  assert.strictEqual(заимствует.json.mode, "borrow");
  const хоз = заимствует.json.byDepartment.find((d) => d.name === "ХОЗ");
  assert.deepStrictEqual(хоз.emails, ["hoz@example.test"], "комментарий заявителя уходит списку его отдела");

  assert.strictEqual((await админ.get("/api/notifications/kinds/нет/recipients")).status, 404);
});

test("предпросмотр шаблона — на выдуманных данных, без сохранения", async (t) => {
  const { админ } = await stand(t);
  const r = await админ.post("/api/notifications/kinds/expiry/preview", { subjectTpl: "Срок: {{фио}} ({{осталось_дней}} дн.)" });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.subject, "Срок: Образцов Образец Образцович (20 дн.)");
  const kinds = (await админ.get("/api/notifications/kinds")).json.kinds;
  assert.notStrictEqual(kinds.find((k) => k.kind === "expiry").subjectTpl, "Срок: {{фио}} ({{осталось_дней}} дн.)",
    "предпросмотр не должен сохранять шаблон");
});

test("пароль почты наружу не отдаётся, пустое поле его не стирает", async (t) => {
  const { админ } = await stand(t);
  let r = await админ.put("/api/notifications/smtp", { host: "smtp.example.test", port: 465, user: "robot", password: "секрет-почты", from: "ИТ <it@example.test>" });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.smtp.hasPassword, true);

  r = await админ.put("/api/notifications/smtp", { host: "smtp.example.test", port: 587, password: "" });
  const got = await админ.get("/api/notifications/smtp");
  assert.strictEqual(got.json.smtp.hasPassword, true, "правка порта не должна молча стирать пароль");
  assert.strictEqual(got.json.smtp.port, 587);
  assert.doesNotMatch(got.text, /секрет-почты/);

  r = await админ.put("/api/notifications/smtp", { from: "не-адрес" });
  assert.strictEqual(r.status, 400);
});

test("пробное письмо уходит на адрес администратора", async (t) => {
  const { админ } = await stand(t);
  const smtp = await startFakeSmtp();
  t.after(() => smtp.close());
  await админ.put("/api/notifications/smtp", { host: "127.0.0.1", port: smtp.port, secure: false, from: "it@example.test" });

  const r = await админ.post("/api/notifications/smtp/test", {});
  assert.strictEqual(r.json.ok, true, r.text);
  assert.strictEqual(smtp.messages.length, 1);
  assert.deepStrictEqual(smtp.messages[0].to, ["admin@example.test"]);
});

test("не ушедшее до настройки почты досылается кнопкой «Повторить»", async (t) => {
  const { админ, сотрудник } = await stand(t);
  await админ.put(`/api/notifications/kinds/${encodeURIComponent("ticket_new:it")}`, { emails: "dezhurny@example.test" });
  await новаяЗаявка(сотрудник, "Пока почты нет");

  await until(async () => {
    const d = (await админ.get("/api/notifications/deliveries")).json.deliveries;
    return d.length === 1 && d[0].status === "pending";
  });

  const smtp = await startFakeSmtp();
  t.after(() => smtp.close());
  await админ.put("/api/notifications/smtp", { host: "127.0.0.1", port: smtp.port, secure: false, from: "it@example.test" });
  const r = await админ.post("/api/notifications/deliveries/retry", {});
  assert.strictEqual(r.json.retried, 1);
  await until(() => smtp.messages.length === 1);

  const ленты = (await админ.get("/api/notifications/feed")).json.events;
  const событие = ленты.find((e) => e.kind === "ticket_new:it");
  assert.strictEqual(событие.label, "Новая заявка — ИТ");
  const доставки = (await админ.get(`/api/notifications/feed/${событие.id}/deliveries`)).json.deliveries;
  assert.ok(доставки.some((d) => d.channel === "email" && d.status === "sent" && d.address === "dezhurny@example.test"));
  assert.strictEqual((await админ.get("/api/notifications/feed?kind=expiry")).json.events.length, 0, "фильтр ленты работает");
});

test("расписание: час от 0 до 23, неизвестное задание — 404", async (t) => {
  const { админ } = await stand(t);
  assert.strictEqual((await админ.put("/api/notifications/schedule", { hour: 24 })).status, 400);
  assert.strictEqual((await админ.put("/api/notifications/schedule", { hour: "утро" })).status, 400);
  const r = await админ.put("/api/notifications/schedule", { hour: 7 });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual((await админ.get("/api/notifications/schedule")).json.hour, 7);
  assert.strictEqual((await админ.post("/api/notifications/schedule/нет/run", {})).status, 404);
});

test("папка резервных копий (раздел «Администрирование»): сохраняется только проверенная, копии видны списком", async (t) => {
  const { db, админ, исполнитель } = await stand(t);
  const fs = require("node:fs");
  const path = require("node:path");
  const { tempDir } = require("./helpers/tempDb");
  const dir = tempDir("adm-srv-backup-panel-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.strictEqual((await исполнитель.get("/api/admin/backup")).status, 403);
  assert.strictEqual((await исполнитель.put("/api/admin/backup", { dir })).status, 403);
  // Раньше папка задавалась в «Оповещения → Отправка»; раздел переехал в «Администрирование».
  assert.strictEqual((await админ.get("/api/notifications/backup")).status, 404);

  const проверка = await админ.post("/api/admin/backup/check", { dir });
  assert.deepStrictEqual(проверка.json, { ok: true });

  const free = "QRSTUVWXYZ".split("").find((l) => !fs.existsSync(`${l}:/`));
  if (free) {
    const плохая = await админ.put("/api/admin/backup", { dir: `${free}:/backups` });
    assert.strictEqual(плохая.status, 400, "недоступную папку не сохраняем");
    assert.match(плохая.json.hint, /\\сервер/);
  }

  fs.writeFileSync(path.join(dir, "smdr-2026-09.db"), "копия");
  const сохранить = await админ.put("/api/admin/backup", { dir });
  assert.strictEqual(сохранить.status, 200, сохранить.text);
  const info = await админ.get("/api/admin/backup");
  assert.strictEqual(info.json.dir, dir);
  assert.strictEqual(info.json.source, "panel");
  assert.deepStrictEqual(info.json.copies.map((c) => c.name), ["smdr-2026-09.db"]);

  const сброс = await админ.put("/api/admin/backup", { dir: "" });
  assert.strictEqual(сброс.status, 200);
  assert.notStrictEqual((await админ.get("/api/admin/backup")).json.source, "panel");
  assert.ok(db);
});

test("сроки сертификатов и МЧД: настройка задачи на перевыпуск — только администратору, ответственные — только администраторы", async (t) => {
  const { db, админ, исполнитель } = await stand(t);
  const g = await админ.get("/api/notifications/expiry-task");
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.json.days, 10, "по умолчанию — за 10 дней");
  assert.deepStrictEqual(g.json.chosen, []);
  assert.strictEqual(g.json.thresholds, "30,20", "письма — за 30 и 20 дней");
  assert.strictEqual((await исполнитель.get("/api/notifications/expiry-task")).status, 403);

  const adminId = db.prepare("SELECT id FROM users WHERE ad_login = '!админ'").get().id;
  const execId = db.prepare("SELECT id FROM users WHERE ad_login = '!итшник'").get().id;
  const ok = await админ.put("/api/notifications/expiry-task", { days: 7, assignees: [adminId] });
  assert.deepStrictEqual(ok.json, { days: 7, chosen: [adminId] });
  assert.strictEqual((await админ.put("/api/notifications/expiry-task", { assignees: [execId] })).status, 400, "не администратор");
  assert.strictEqual((await админ.put("/api/notifications/expiry-task", { days: 99 })).status, 400);
});
