'use strict';

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { freshDb, makeTicket } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");

// ============================================================================
//  Задачи администраторов
//
//  Всё — через настоящий HTTP с входом по паролю, как в остальных тестах
//  платформы: права на разделе проверяются на стыке маршрута и сессии, и
//  подкладывать сессию в обход входа значило бы этот стык не проверить.
//
//  Все ФИО и задачи ВЫДУМАНЫ.
// ============================================================================

async function стенд(t, { env = {} } = {}) {
  const old = {};
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; process.env[k] = v; }
  const { db, cleanup } = freshDb();
  const ids = {
    a: await makeLocalUser(db, { login: "adm1", name: "Стендов Стенд Стендович", isAdmin: true, email: "adm1@example.invalid" }),
    b: await makeLocalUser(db, { login: "adm2", name: "Тестов Тест Тестович", isAdmin: true, email: "adm2@example.invalid" }),
    exec: await makeLocalUser(db, { login: "it1", name: "Пробников Пробник Пробникович", role: "it" }),
    user: await makeLocalUser(db, { login: "u1", name: "Макетов Макет Макетович" }),
  };
  const app = await startApp(db);
  const A = client(app.url); await A.login("adm1");
  const B = client(app.url); await B.login("adm2");
  t.after(async () => {
    await app.close(); cleanup();
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  return { db, app, ids, A, B };
}

const создать = async (C, ids, extra = {}) => {
  const r = await C.post("/api/tasks", { title: "Заменить ИБП в серверной", assignees: [ids.a, ids.b], due_date: "2026-10-02", ...extra });
  assert.strictEqual(r.status, 201, r.text);
  return r.json.id;
};

// ---------------------------------------------------------------------------
//  Доступ
// ---------------------------------------------------------------------------

test("раздел закрыт для всех, кроме администраторов, — на каждом маршруте, а не только в меню", async (t) => {
  const { app, ids, A } = await стенд(t);
  const id = await создать(A, ids);
  const гость = client(app.url);
  for (const login of [null, "it1", "u1"]) {
    const c = login ? client(app.url) : гость;
    if (login) await c.login(login);
    const ждём = login ? 403 : 401;
    for (const [m, p, b] of [
      ["get", "/api/tasks"], ["get", `/api/tasks/${id}`], ["get", "/api/tasks/summary"], ["get", "/api/tasks/people"],
      ["post", "/api/tasks", { title: "x", assignees: [ids.a] }], ["patch", `/api/tasks/${id}`, { status: "done" }],
      ["post", `/api/tasks/${id}/comments`, { text: "x" }], ["delete", `/api/tasks/${id}`],
    ]) {
      const r = await c[m](p, b);
      assert.strictEqual(r.status, ждём, `${login || "без входа"}: ${m.toUpperCase()} ${p}`);
    }
  }
});

test("ответственным можно назначить только администратора, и хотя бы одного", async (t) => {
  const { ids, A } = await стенд(t);
  for (const who of [ids.exec, ids.user]) {
    const r = await A.post("/api/tasks", { title: "x", assignees: [ids.a, who] });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /только администратора/);
  }
  assert.strictEqual((await A.post("/api/tasks", { title: "x", assignees: [] })).status, 400);
  assert.strictEqual((await A.post("/api/tasks", { title: "x" })).status, 400);
  const люди = (await A.get("/api/tasks/people")).json.people.map((p) => p.id).sort();
  assert.deepStrictEqual(люди, [ids.a, ids.b].sort(), "в выборе ответственных — только администраторы");
});

test("проверка полей: пустая тема, кривой срок, время без даты, чужая заявка", async (t) => {
  const { ids, A } = await стенд(t);
  const bad = [
    { title: "   " }, { due_date: "2026-02-31" }, { due_date: "02.10.2026" },
    { due_time: "18:00" }, { due_date: "2026-10-02", due_time: "25:00" },
    { priority: "срочно" }, { ticket: "ИТ-9999" }, { tags: ["a", "b", "c", "d", "e", "f"] },
  ];
  for (const extra of bad) {
    const r = await A.post("/api/tasks", { title: "Задача", assignees: [ids.a], ...extra });
    assert.strictEqual(r.status, 400, JSON.stringify(extra));
  }
});

// ---------------------------------------------------------------------------
//  История и правка
// ---------------------------------------------------------------------------

test("каждая правка — строка в истории с автором: срок, статус, ответственные", async (t) => {
  const { db, ids, A } = await стенд(t);
  const { makeUser } = require("./helpers/tempDb");
  const автор = makeUser(db, { login: "zayav", name: "Заявитель Проба Тестович" });
  const ticket = makeTicket(db, { createdBy: автор, displayId: "ИТ-0057", title: "Пищит ИБП" });
  const id = await создать(A, ids, { ticket: "ИТ-0057" });
  await A.patch(`/api/tasks/${id}`, { due_date: "2026-10-05", due_time: "18:00" });
  await A.patch(`/api/tasks/${id}`, { status: "done" });
  await A.patch(`/api/tasks/${id}`, { assignees: [ids.a] });
  const task = (await A.get(`/api/tasks/${id}`)).json.task;
  const тексты = task.events.map((e) => e.text).reverse();
  assert.deepStrictEqual(тексты, [
    "создал задачу",
    "сдвинул срок: 2 окт, пт → 5 окт, пн, 18:00",
    "отметил задачу выполненной",
    "снял: Тестов Тест Тестович",
  ]);
  assert.ok(task.events.every((e) => e.user_name === "Стендов Стенд Стендович"));
  assert.ok(task.done_at, "у выполненной задачи стоит время выполнения");
  assert.strictEqual(task.ticket.id, ticket);
  // Пустая правка истории не засоряет.
  const r = await A.patch(`/api/tasks/${id}`, { status: "done", title: "Заменить ИБП в серверной" });
  assert.strictEqual(r.json.changed, false);
});

test("удалить задачу может только её автор", async (t) => {
  const { ids, A, B } = await стенд(t);
  const id = await создать(A, ids);
  assert.strictEqual((await B.delete(`/api/tasks/${id}`)).status, 403);
  assert.strictEqual((await A.delete(`/api/tasks/${id}`)).status, 200);
  assert.strictEqual((await A.get(`/api/tasks/${id}`)).status, 404);
});

test("чек-лист: пункты, отметки и счётчик в списке", async (t) => {
  const { ids, A } = await стенд(t);
  const id = await создать(A, ids, { checklist: ["Согласовать с ХОЗ", "Получить со склада"] });
  const item = (await A.post(`/api/tasks/${id}/checklist`, { text: "Замена после 18:00" })).json.id;
  const first = (await A.get(`/api/tasks/${id}`)).json.task.checklist[0].id;
  await A.patch(`/api/tasks/${id}/checklist/${first}`, { done: true });
  await A.delete(`/api/tasks/${id}/checklist/${item}`);
  const row = (await A.get("/api/tasks")).json.tasks.find((x) => x.id === id);
  assert.deepStrictEqual(row.checklist, { done: 1, total: 2 });
  const hist = (await A.get(`/api/tasks/${id}`)).json.task.events.map((e) => e.text);
  assert.ok(hist.includes("выполнил пункт: «Согласовать с ХОЗ»"));
  assert.ok(hist.includes("убрал пункт: «Замена после 18:00»"));
});

test("календарь: выборка по диапазону дат — с выполненными, без задач без срока", async (t) => {
  const { ids, A } = await стенд(t);
  const внутри = await создать(A, ids, { title: "Внутри", due_date: "2026-10-02" });
  const готова = await создать(A, ids, { title: "Готова", due_date: "2026-10-05" });
  await A.patch(`/api/tasks/${готова}`, { status: "done" });
  await создать(A, ids, { title: "После", due_date: "2026-11-02" });
  await создать(A, ids, { title: "Без срока", due_date: null });
  const r = await A.get("/api/tasks?status=all&from=2026-09-28&to=2026-11-01");
  assert.deepStrictEqual(r.json.tasks.map((x) => x.id), [внутри, готова]);
  assert.strictEqual((await A.get("/api/tasks?status=all&from=2026-13-01&to=2026-11-01")).status, 400);
});

// ---------------------------------------------------------------------------
//  Новое для меня: назначения и комментарии других
// ---------------------------------------------------------------------------

test("назначили и написали — у второго задача «новая», открыл — прочитал; своё действие новым не считается", async (t) => {
  const { ids, A, B } = await стенд(t);
  const id = await создать(A, ids);
  assert.deepStrictEqual((await A.get("/api/tasks/summary")).json.unread, 0, "автор своё создание новым не видит");
  assert.strictEqual((await B.get("/api/tasks/summary")).json.unread, 1);
  await B.post(`/api/tasks/${id}/seen`);
  assert.strictEqual((await B.get("/api/tasks/summary")).json.unread, 0);
  await A.post(`/api/tasks/${id}/comments`, { text: "ИБП привезут в среду" });
  assert.strictEqual((await B.get("/api/tasks/summary")).json.unread, 1, "комментарий другого — снова новое");
  assert.strictEqual((await A.get("/api/tasks/summary")).json.unread, 0);
});

test("оповещение о назначении уходит только добавленным, не тому, кто назначил", async (t) => {
  const { db, ids, A } = await стенд(t);
  const id = await создать(A, ids, { assignees: [ids.a] });
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM notification_events WHERE kind = 'task_assigned'").get().n, 0,
    "назначил сам себя — оповещать некого");
  await A.patch(`/api/tasks/${id}`, { assignees: [ids.a, ids.b] });
  const доставки = db.prepare(`
    SELECT d.channel, d.user_id, d.address FROM notification_deliveries d
    JOIN notification_events e ON e.id = d.event_id WHERE e.kind = 'task_assigned' ORDER BY d.channel
  `).all();
  assert.deepStrictEqual(доставки.map((d) => [d.channel, d.user_id || d.address]), [
    ["email", "adm2@example.invalid"],
    ["inapp", ids.b],
  ], "«Искра» не настроена — её доставок нет вовсе, а не строки с ошибкой на каждое событие");
});

test("отметки задач не попадают в счётчик заявок", async (t) => {
  const { ids, A, B } = await стенд(t);
  await создать(A, ids);
  const заявки = (await B.get("/api/notifications")).json.notifications;
  assert.strictEqual(заявки.length, 0);
});

// ---------------------------------------------------------------------------
//  Ежедневный обход
// ---------------------------------------------------------------------------

const day = (s, h = 10) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d, h); };

test("напоминания по порогам 3, 1, 0 — по одному разу, даже если обход идёт снова", async (t) => {
  const { db, ids, A } = await стенд(t);
  const id = await создать(A, ids, { due_date: "2026-10-05" }); // понедельник
  const src = require("../services/sources/tasks");
  const kinds = () => db.prepare("SELECT dedup_key FROM notification_events WHERE kind = 'task_due' ORDER BY id").all().map((r) => r.dedup_key);

  src.run(db, day("2026-10-01")); // за 4 дня — рано
  assert.deepStrictEqual(kinds(), []);
  src.run(db, day("2026-10-02")); src.run(db, day("2026-10-02")); // за 3 дня, дважды
  src.run(db, day("2026-10-04")); // за 1 день
  src.run(db, day("2026-10-05")); // в день срока
  assert.deepStrictEqual(kinds(), [
    `task_due:${id}:2026-10-05:3`, `task_due:${id}:2026-10-05:1`, `task_due:${id}:2026-10-05:0`,
  ]);
  const hist = (await A.get(`/api/tasks/${id}`)).json.task.events.filter((e) => e.kind === "reminder");
  assert.strictEqual(hist.length, 3, "каждое напоминание видно в истории задачи");
  assert.ok(hist.every((e) => e.user_id === null), "от имени платформы, а не человека");
});

test("сдвинули срок — пороги отсчитываются заново", async (t) => {
  const { db, ids, A } = await стенд(t);
  const id = await создать(A, ids, { due_date: "2026-10-05" });
  const src = require("../services/sources/tasks");
  src.run(db, day("2026-10-04"));
  await A.patch(`/api/tasks/${id}`, { due_date: "2026-10-07" });
  src.run(db, day("2026-10-06"));
  const n = db.prepare("SELECT COUNT(*) n FROM notification_events WHERE kind = 'task_due'").get().n;
  assert.strictEqual(n, 2);
});

test("просрочка: раз в день ответственным и автору, в истории — только первый день", async (t) => {
  const { db, ids, A } = await стенд(t);
  const id = await создать(A, ids, { due_date: "2026-10-02", assignees: [ids.b] });
  const src = require("../services/sources/tasks");
  src.run(db, day("2026-10-03")); src.run(db, day("2026-10-03"));
  src.run(db, day("2026-10-05"));
  const events = db.prepare("SELECT id, payload FROM notification_events WHERE kind = 'task_overdue' ORDER BY id").all();
  assert.strictEqual(events.length, 2, "одно в день, повторный обход того же дня — без дубля");
  assert.strictEqual(JSON.parse(events[1].payload).просрочено, "3 дня");
  const кому = db.prepare("SELECT DISTINCT user_id FROM notification_deliveries WHERE channel = 'inapp' AND event_id = ?")
    .all(events[0].id).map((r) => r.user_id).sort();
  assert.deepStrictEqual(кому, [ids.a, ids.b].sort(), "автор (a) тоже узнаёт, что задача встала");
  const hist = (await A.get(`/api/tasks/${id}`)).json.task.events.filter((e) => e.kind === "reminder");
  assert.strictEqual(hist.length, 1);
  await A.patch(`/api/tasks/${id}`, { status: "done" });
  src.run(db, day("2026-10-06"));
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM notification_events WHERE kind = 'task_overdue'").get().n, 2,
    "выполненная задача больше не напоминает");
});

test("утренняя сводка: по будням, каждому своя, без задач — не приходит", async (t) => {
  const { db, ids, A } = await стенд(t);
  await создать(A, ids, { title: "Просроченная", due_date: "2026-10-01", assignees: [ids.a] });
  await создать(A, ids, { title: "На сегодня", due_date: "2026-10-02", assignees: [ids.a] });
  await создать(A, ids, { title: "Через месяц", due_date: "2026-11-02", assignees: [ids.b] });
  const src = require("../services/sources/tasks");
  src.run(db, day("2026-10-03")); // суббота
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM notification_events WHERE kind = 'task_digest'").get().n, 0);
  src.run(db, day("2026-10-02")); // пятница
  const digests = db.prepare("SELECT subject_ref, payload FROM notification_events WHERE kind = 'task_digest'").all();
  assert.deepStrictEqual(digests.map((d) => d.subject_ref), [`digest:${ids.a}`], "у второго на ближайшие дни ничего — сводки нет");
  const p = JSON.parse(digests[0].payload);
  assert.match(p.сводка, /Срок прошёл:\n {2}• Просроченная/);
  assert.match(p.сводка, /Сегодня:\n {2}• На сегодня/);
  assert.strictEqual(p.просрочено_шт, "1");
});

// ---------------------------------------------------------------------------
//  Каналы и «Искра»
// ---------------------------------------------------------------------------

/** Поддельная «Искра»: запоминает запросы и отвечает по ФИО получателя. */
async function fakeIskra(answers = {}) {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const json = JSON.parse(body || "{}");
      got.push({ auth: req.headers.authorization, ...json });
      const [status, reply] = answers[json.to] || [200, { ok: true }];
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/api/system/notify`, got, close: () => new Promise((r) => server.close(r)) };
}

async function дождаться(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
}

test("«Искра»: сообщение уходит с секретом и по ФИО, исход каждой доставки записан", async (t) => {
  const iskra = await fakeIskra({ "Тестов Тест Тестович": [404, { error: "нет пользователя «Тестов Тест Тестович»" }] });
  t.after(() => iskra.close());
  const TOKEN = "test-platform-secret-0123456789abcdef";
  const { db, ids, A } = await стенд(t, { env: { ISKRA_NOTIFY_URL: iskra.url, ISKRA_NOTIFY_TOKEN: TOKEN } });
  await создать(A, ids, { assignees: [ids.a, ids.b] });

  const rows = await дождаться(() => {
    const r = db.prepare("SELECT address, status, error FROM notification_deliveries WHERE channel = 'iskra' ORDER BY address").all();
    return r.length === 1 && r.every((x) => x.status !== "pending") ? r : null;
  });
  assert.ok(rows, "доставка в «Искру» завершилась");
  assert.deepStrictEqual(rows.map((r) => [r.address, r.status]), [["Тестов Тест Тестович", "failed"]],
    "назначивший себе не пишет, второму — пишет, а отказ «Искры» лежит в журнале");
  assert.match(rows[0].error, /нет пользователя/);
  assert.strictEqual(iskra.got[0].auth, `Bearer ${TOKEN}`);
  assert.match(iskra.got[0].text, /^Вам назначена задача: Заменить ИБП в серверной\n\n/, "тема идёт первой строкой сообщения");
});

test("«Искра» лежит — доставка остаётся в очереди на повтор, а не теряется", async (t) => {
  const iskra = await fakeIskra({ "Тестов Тест Тестович": [503, { error: "перезапуск" }] });
  t.after(() => iskra.close());
  const { db, ids, A } = await стенд(t, { env: { ISKRA_NOTIFY_URL: iskra.url, ISKRA_NOTIFY_TOKEN: "test-platform-secret-0123456789abcdef" } });
  await создать(A, ids);
  const row = await дождаться(() => {
    const r = db.prepare("SELECT status, error FROM notification_deliveries WHERE channel = 'iskra'").get();
    return r && r.error ? r : null;
  });
  assert.strictEqual(row.status, "pending");
  assert.match(row.error, /перезапуск/);
});

test("каналы категории: выключили почту — писем нет, лишний канал отвергается", async (t) => {
  const { db, ids, A } = await стенд(t);
  const kinds = (await A.get("/api/notifications/kinds")).json;
  const assigned = kinds.kinds.find((k) => k.kind === "task_assigned");
  assert.deepStrictEqual(assigned.channels, ["email", "inapp", "iskra"]);
  assert.strictEqual(kinds.iskra.available, false);
  assert.match(kinds.iskra.why, /ISKRA_NOTIFY_TOKEN/);
  assert.strictEqual(kinds.kinds.find((k) => k.kind === "expiry").channels, null, "у сертификатов каналы не выбираются");

  assert.strictEqual((await A.put("/api/notifications/kinds/task_assigned", { channels: ["email", "telegram"] })).status, 400);
  assert.strictEqual((await A.put("/api/notifications/kinds/expiry", { channels: ["email"] })).status, 400);
  const r = await A.put("/api/notifications/kinds/task_assigned", { channels: ["inapp"] });
  assert.deepStrictEqual(r.json.settings.channels, ["inapp"]);

  await создать(A, ids);
  const каналы = db.prepare("SELECT DISTINCT channel FROM notification_deliveries").all().map((x) => x.channel);
  assert.deepStrictEqual(каналы, ["inapp"]);
});

test("кириллица в секрете «Искры» — канал выключен с объяснением, а не «недоступна» навечно", async (t) => {
  const { A } = await стенд(t, { env: { ISKRA_NOTIFY_URL: "http://127.0.0.1:9/x", ISKRA_NOTIFY_TOKEN: "секрет-кириллицей-длинный-0000000" } });
  const kinds = (await A.get("/api/notifications/kinds")).json;
  assert.strictEqual(kinds.iskra.available, false);
  assert.match(kinds.iskra.why, /латиниц/);
});

// ---------------------------------------------------------------------------
//  Миграция существующей базы
// ---------------------------------------------------------------------------

test("старая база: таблица доставок пересобирается под «Искру», строки и индексы на месте", () => {
  const { tempDir, resetModuleCache } = require("./helpers/tempDb");
  const { DatabaseSync } = require("node:sqlite");
  const dir = tempDir();
  try {
    const file = path.join(dir, "old.db");
    // Схема ДО этой правки: канал только inapp и email, у настроек нет channels.
    const old = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8")
      .replace("CHECK (channel IN ('inapp', 'email', 'iskra'))", "CHECK (channel IN ('inapp', 'email'))")
      .replace(/\n {2}channels TEXT,/, "");
    const raw = new DatabaseSync(file);
    raw.exec(old);
    raw.prepare("INSERT INTO notification_events (kind, source, dedup_key) VALUES ('expiry', 'certs', 'k1')").run();
    for (const c of ["email", "inapp"]) {
      raw.prepare("INSERT INTO notification_deliveries (event_id, channel, address, status) VALUES (1, ?, 'x@example.invalid', 'sent')").run(c);
    }
    assert.throws(() => raw.prepare("INSERT INTO notification_deliveries (event_id, channel) VALUES (1, 'iskra')").run());
    raw.close();

    process.env.DB_PATH = file;
    resetModuleCache();
    const { initDb } = require("../db/init");
    const db = initDb();
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM notification_deliveries").get().n, 2);
    db.prepare("INSERT INTO notification_deliveries (event_id, channel, status) VALUES (1, 'iskra', 'pending')").run();
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notification_deliveries' AND name LIKE 'idx%'").all();
    assert.strictEqual(idx.length, 4, "индексы пропадают вместе со старой таблицей и должны вернуться");
    assert.ok(db.prepare("PRAGMA table_info(notification_settings)").all().some((c) => c.name === "channels"));
    db.close();
    initDb().close(); // повторный запуск — без ошибок и без второй пересборки
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("срок периодом: «с … по …», без времени; календарь видит задачу во все дни периода; просрочка — после последнего дня", async (t) => {
  const { db, ids, A } = await стенд(t);
  const r = await A.post("/api/tasks", { title: "Обновить антивирус на всех ПК", assignees: [ids.a], due_from: "2030-03-02", due_date: "2030-03-08", due_time: "10:00" });
  assert.strictEqual(r.status, 201, r.text);
  const row = db.prepare("SELECT due_from, due_date, due_time FROM tasks WHERE id = ?").get(r.json.id);
  assert.deepStrictEqual({ ...row }, { due_from: "2030-03-02", due_date: "2030-03-08", due_time: null }, "у периода нет времени");

  // Календарь: неделя, которая только задевает период, задачу показывает.
  const кал = async (from, to) => (await A.get(`/api/tasks?status=all&from=${from}&to=${to}`)).json.tasks.map((x) => x.id);
  assert.deepStrictEqual(await кал("2030-03-06", "2030-03-12"), [r.json.id]);
  assert.deepStrictEqual(await кал("2030-02-24", "2030-03-02"), [r.json.id]);
  assert.deepStrictEqual(await кал("2030-03-09", "2030-03-15"), []);

  const card = (await A.get(`/api/tasks/${r.json.id}`)).json.task;
  assert.strictEqual(card.due_from, "2030-03-02");
  // История: перенос периода подписан периодом.
  await A.patch(`/api/tasks/${r.json.id}`, { due_from: "2030-03-30", due_date: "2030-04-05" });
  const ev = db.prepare("SELECT text FROM task_events WHERE task_id = ? AND kind = 'due'").get(r.json.id).text;
  assert.match(ev, /2–8 мар → 30 мар – 5 апр/);

  assert.strictEqual((await A.post("/api/tasks", { title: "x", assignees: [ids.a], due_from: "2030-03-09", due_date: "2030-03-08" })).status, 400, "начало позже конца");
  assert.strictEqual((await A.post("/api/tasks", { title: "x", assignees: [ids.a], due_from: "2030-03-09" })).status, 400, "без последнего дня");
  // Период в один день — обычный день.
  const one = await A.post("/api/tasks", { title: "y", assignees: [ids.a], due_from: "2030-03-08", due_date: "2030-03-08", due_time: "09:30" });
  assert.deepStrictEqual({ ...db.prepare("SELECT due_from, due_time FROM tasks WHERE id = ?").get(one.json.id) }, { due_from: null, due_time: "09:30" });
  // Снять период — остаётся последний день.
  await A.patch(`/api/tasks/${r.json.id}`, { due_from: null });
  assert.strictEqual(db.prepare("SELECT due_from FROM tasks WHERE id = ?").get(r.json.id).due_from, null);

  const T = require("../services/tasks");
  const now = new Date(2030, 2, 5, 12, 0);
  assert.strictEqual(T.isOverdue({ status: "todo", due_from: "2030-03-02", due_date: "2030-03-08" }, now), false, "внутри периода — не просрочено");
  assert.strictEqual(T.isOverdue({ status: "todo", due_from: "2030-02-01", due_date: "2030-02-28" }, now), true);
});

test("доска заметок: общий лист администраторов, чистка HTML, чужое сохранение не затирается молча", async (t) => {
  const { app, A, B } = await стенд(t);
  const пусто = (await A.get("/api/tasks/board")).json;
  assert.deepStrictEqual({ html: пусто.html, version: пусто.version }, { html: "", version: 0 });

  const r1 = await A.put("/api/tasks/board", { html: `<p><b>План</b> на неделю<script>alert(1)</script></p><img src=x onerror=alert(1)>`, version: 0 });
  assert.strictEqual(r1.status, 200, r1.text);
  assert.strictEqual(r1.json.html, "<p><b>План</b> на неделю</p>", "опасное вырезано");
  assert.strictEqual(r1.json.version, 1);
  assert.strictEqual(r1.json.updated_by, "Стендов Стенд Стендович");

  // Второй администратор видит то же; сохраняет поверх своей версии.
  assert.strictEqual((await B.get("/api/tasks/board")).json.html, "<p><b>План</b> на неделю</p>");
  assert.strictEqual((await B.put("/api/tasks/board", { html: "<p>B</p>", version: 1 })).status, 200);
  // Первый сохраняет по устаревшей версии — 409 и свежий текст, ничего не затёрто.
  const stale = await A.put("/api/tasks/board", { html: "<p>A</p>", version: 1 });
  assert.strictEqual(stale.status, 409);
  assert.deepStrictEqual({ html: stale.json.html, version: stale.json.version, by: stale.json.updated_by }, { html: "<p>B</p>", version: 2, by: "Тестов Тест Тестович" });

  // Лист побольше 100 КБ проходит (у доски свой предел тела запроса).
  const big = "<p>" + "заметка ".repeat(20000) + "</p>";
  assert.strictEqual((await A.put("/api/tasks/board", { html: big, version: 2 })).status, 200);

  // Не администраторам доска закрыта, как и весь раздел.
  const { client } = require("./helpers/httpApp");
  const U = client(app.url); await U.login("u1");
  assert.strictEqual((await U.get("/api/tasks/board")).status, 403);
  assert.strictEqual((await U.put("/api/tasks/board", { html: "x", version: 3 })).status, 403);
});
