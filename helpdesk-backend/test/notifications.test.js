'use strict';

const test = require("node:test");
const assert = require("node:assert/strict");

const { freshDb, makeUser, makeTicket } = require("./helpers/tempDb");
const { startFakeSmtp } = require("./helpers/fakeSmtp");

// ============================================================================
//  Оповещения: событие, доставка, шаблон
//
//  Проверяется то, ради чего модель переделывали: ОДИН факт и СКОЛЬКО УГОДНО
//  доставок. Прежняя таблица хранила по строке на получателя, поэтому событие
//  размножалось по списку; регресс сюда вернуться не должен.
//
//  Все адреса и ФИО выдуманы.
// ============================================================================

function load() {
  // Модули тянут config, а он читает DB_PATH при первой загрузке. freshDb()
  // уже сбросил кэш, поэтому require делаем ПОСЛЕ него.
  return {
    notifications: require("../services/notifications"),
    mailer: require("../services/mailer"),
  };
}

test("emit: одно событие и по строке доставки на каждый адрес", (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { notifications } = load();

  db.prepare("INSERT INTO notification_settings (kind, enabled, emails) VALUES ('ticket_new:it', 1, ?)")
    .run("a@example.test\nb@example.test\nc@example.test");

  const author = makeUser(db, { login: "probnikov", name: "Пробников П.", email: "p@example.test" });
  const ticketId = makeTicket(db, { displayId: "ИТ-0001", title: "Тест", createdBy: author });

  const eventId = notifications.emit(db, {
    kind: "ticket_new:it",
    subject: "ИТ-0001 — Тест",
    ticketId,
    dedupKey: `ticket_new:${ticketId}`,
    payload: { "номер": "ИТ-0001", "тема": "Тест" },
    department: "it",
  });

  assert.ok(eventId, "событие должно создаться");
  const events = db.prepare("SELECT * FROM notification_events").all();
  assert.equal(events.length, 1, "факт один, сколько бы ни было получателей");

  const mails = db.prepare("SELECT * FROM notification_deliveries WHERE channel='email'").all();
  assert.equal(mails.length, 3, "по строке доставки на каждый адрес");
});

test("emit: повторный ключ не создаёт второе событие", (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { notifications } = load();

  const args = { kind: "expiry", subject: "тест", dedupKey: "expiry:x:30", payload: {} };
  assert.ok(notifications.emit(db, args));
  assert.equal(notifications.emit(db, args), null, "второй раз — null, а не дубль");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notification_events").get().c, 1);
});

test("emit: выключенная категория молчит", (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { notifications } = load();

  db.prepare("INSERT INTO notification_settings (kind, enabled, emails) VALUES ('expiry', 0, ?)")
    .run("a@example.test");
  assert.equal(notifications.emit(db, { kind: "expiry", dedupKey: "k1", payload: {} }), null);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notification_events").get().c, 0);
});

test("emit: неизвестная категория не создаёт события", (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { notifications } = load();
  assert.equal(notifications.emit(db, { kind: "такой-категории-нет", dedupKey: "k", payload: {} }), null);
});

test("resolveEmails: категория «автору» берёт адрес из домена, а не из списков", (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { notifications } = load();

  const author = makeUser(db, { login: "z", name: "Заявителев З.", email: "zayavitel@example.test" });
  const got = notifications.resolveEmails(db, "ticket_status", { authorUserId: author });
  assert.deepEqual(got, ["zayavitel@example.test"]);
});

test("resolveEmails: у автора без почты в домене — пусто, а не падение", (t) => {
  // Учётная запись AD без атрибута mail. Письмо отправить не из чего, но это
  // не повод ронять создание заявки.
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { notifications } = load();

  const author = makeUser(db, { login: "nomail", name: "Безпочтов Б.", email: null });
  assert.deepEqual(notifications.resolveEmails(db, "ticket_status", { authorUserId: author }), []);
});

test("resolveEmails: заимствующая категория берёт список у соседней", (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { notifications } = load();

  db.prepare("INSERT INTO notification_settings (kind, enabled, emails) VALUES ('expiry', 1, ?)")
    .run("bezopasnik@example.test");
  // expired объявлен как borrow -> expiry, своего списка у него нет
  assert.deepEqual(notifications.resolveEmails(db, "expired", {}), ["bezopasnik@example.test"]);
});

test("resolveEmails: комментарий заявителя уходит списку ЕГО отдела", (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { notifications } = load();

  db.prepare("INSERT INTO notification_settings (kind, enabled, emails) VALUES ('ticket_new:it', 1, ?)")
    .run("it@example.test");
  db.prepare("INSERT INTO notification_settings (kind, enabled, emails) VALUES ('ticket_new:hoz', 1, ?)")
    .run("hoz@example.test");

  assert.deepEqual(notifications.resolveEmails(db, "ticket_comment_in", { department: "it" }), ["it@example.test"]);
  assert.deepEqual(notifications.resolveEmails(db, "ticket_comment_in", { department: "hoz" }), ["hoz@example.test"]);
});

test("emit: одинаковые адреса в списке не дают двух писем", (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { notifications } = load();

  db.prepare("INSERT INTO notification_settings (kind, enabled, emails) VALUES ('expiry', 1, ?)")
    .run("dubl@example.test\ndubl@example.test");
  notifications.emit(db, { kind: "expiry", dedupKey: "k", payload: {} });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notification_deliveries WHERE channel='email'").get().c, 1);
});

test("render: подставляет кириллические имена и не спотыкается о пропуски", (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { notifications } = load();

  assert.equal(
    notifications.render("Заявка {{номер}}: {{тема}}", { "номер": "ИТ-0148", "тема": "Принтер" }),
    "Заявка ИТ-0148: Принтер"
  );
  assert.equal(notifications.render("{{ номер }}", { "номер": "X" }), "X", "пробелы внутри скобок допустимы");
  assert.equal(notifications.render("а {{неттакого}} б", {}), "а  б", "неизвестная подстановка — пусто");
  assert.equal(notifications.render("{{номер}}", { "номер": 0 }), "0", "ноль — это значение, а не пустота");
  assert.equal(notifications.render(null, {}), "");
});

test("почта: письмо реально уходит, тема и текст собраны по шаблону", async (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { notifications, mailer } = load();
  const smtp = await startFakeSmtp();
  t.after(() => smtp.close());

  mailer.writeSettings(db, { host: "127.0.0.1", port: smtp.port, secure: false, from: "it@example.test" });
  db.prepare("INSERT INTO notification_settings (kind, enabled, emails, subject_tpl, body_tpl) VALUES ('expiry', 1, ?, ?, ?)")
    .run("bezopasnik@example.test", "Истекает: {{фио}}", "Срок до {{срок}}, осталось {{осталось_дней}}");

  notifications.emit(db, {
    kind: "expiry",
    dedupKey: "expiry:test:30",
    payload: { "фио": "Образцов Образец", "срок": "22.09.2026", "осталось_дней": "30" },
  });

  // emit специально не ждёт отправку: недоступный SMTP не должен подвешивать
  // запрос, ради которого всё затевалось. Поэтому здесь ждём результата явно.
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(smtp.messages.length, 1);
  assert.deepEqual(smtp.messages[0].to, ["bezopasnik@example.test"]);
  assert.equal(smtp.messages[0].subject, "Истекает: Образцов Образец");
  assert.match(smtp.messages[0].body, /Срок до 22\.09\.2026, осталось 30/);

  const d = db.prepare("SELECT * FROM notification_deliveries WHERE channel='email'").get();
  assert.equal(d.status, "sent");
  assert.equal(d.error, null);
  assert.ok(d.sent_at, "время отправки должно проставиться");
});

test("почта не настроена: письмо ждёт в очереди с причиной, а не теряется", async (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { notifications } = load();

  db.prepare("INSERT INTO notification_settings (kind, enabled, emails) VALUES ('expiry', 1, ?)")
    .run("bezopasnik@example.test");
  notifications.emit(db, { kind: "expiry", dedupKey: "k", payload: {} });
  await new Promise((r) => setTimeout(r, 200));

  const d = db.prepare("SELECT * FROM notification_deliveries WHERE channel='email'").get();
  assert.equal(d.status, "pending", "ненастроенный SMTP — это «пока некуда», а не провал");
  assert.match(d.error, /SMTP не настроен/, "причина обязана быть записана");
});

test("сервер отверг адрес: помечается неудачей, повторять бессмысленно", async (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { notifications, mailer } = load();
  const smtp = await startFakeSmtp({ rejectRecipient: "netakogo@example.test" });
  t.after(() => smtp.close());

  mailer.writeSettings(db, { host: "127.0.0.1", port: smtp.port, secure: false, from: "it@example.test" });
  db.prepare("INSERT INTO notification_settings (kind, enabled, emails) VALUES ('expiry', 1, ?)")
    .run("netakogo@example.test");

  notifications.emit(db, { kind: "expiry", dedupKey: "k", payload: {} });
  await new Promise((r) => setTimeout(r, 400));

  const d = db.prepare("SELECT * FROM notification_deliveries WHERE channel='email'").get();
  assert.equal(d.status, "failed", "отвергнутый адрес повторять незачем");
  assert.ok(d.error && d.error.length > 0);
});

test("retryPending: досылает то, что легло в очередь до настройки почты", async (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { notifications, mailer } = load();

  db.prepare("INSERT INTO notification_settings (kind, enabled, emails) VALUES ('expiry', 1, ?)")
    .run("bezopasnik@example.test");
  notifications.emit(db, { kind: "expiry", dedupKey: "k", payload: { "фио": "Тестова" } });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(db.prepare("SELECT status FROM notification_deliveries").get().status, "pending");

  const smtp = await startFakeSmtp();
  t.after(() => smtp.close());
  mailer.writeSettings(db, { host: "127.0.0.1", port: smtp.port, secure: false, from: "it@example.test" });

  const n = await notifications.retryPending(db);
  assert.equal(n, 1);
  assert.equal(db.prepare("SELECT status FROM notification_deliveries").get().status, "sent");
  assert.equal(smtp.messages.length, 1);
});

test("backfillDeliveries: события без адресатов дорассылаются после настройки списка", async (t) => {
  // Ловушка первой настройки: планировщик проходит при старте платформы, то есть
  // раньше, чем администратор вписал получателей. События созданы, писем ноль,
  // и dedup_key больше не даст их создать.
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { notifications, mailer } = load();

  notifications.emit(db, { kind: "expiry", dedupKey: "expiry:a:30", payload: { "фио": "Первый" } });
  notifications.emit(db, { kind: "expiry", dedupKey: "expiry:b:20", payload: { "фио": "Второй" } });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notification_deliveries").get().c, 0);

  const smtp = await startFakeSmtp();
  t.after(() => smtp.close());
  mailer.writeSettings(db, { host: "127.0.0.1", port: smtp.port, secure: false, from: "it@example.test" });
  db.prepare("INSERT INTO notification_settings (kind, enabled, emails) VALUES ('expiry', 1, ?)")
    .run("bezopasnik@example.test");

  const n = await notifications.backfillDeliveries(db, "expiry");
  assert.equal(n, 2, "оба события должны быть дорассланы");
  assert.equal(smtp.messages.length, 2);
});

test("backfillDeliveries: события, у которых доставки уже были, не дублируются", async (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { notifications, mailer } = load();
  const smtp = await startFakeSmtp();
  t.after(() => smtp.close());

  mailer.writeSettings(db, { host: "127.0.0.1", port: smtp.port, secure: false, from: "it@example.test" });
  db.prepare("INSERT INTO notification_settings (kind, enabled, emails) VALUES ('expiry', 1, ?)")
    .run("bezopasnik@example.test");

  notifications.emit(db, { kind: "expiry", dedupKey: "k", payload: {} });
  await new Promise((r) => setTimeout(r, 300));
  smtp.reset();

  assert.equal(await notifications.backfillDeliveries(db, "expiry"), 0);
  assert.equal(smtp.messages.length, 0, "второго письма быть не должно");
});

test("рассылка и повтор не отправляют одно письмо дважды", async (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { notifications, mailer } = load();
  const smtp = await startFakeSmtp();
  t.after(() => smtp.close());

  mailer.writeSettings(db, { host: "127.0.0.1", port: smtp.port, secure: false, from: "it@example.test" });
  db.prepare("INSERT INTO notification_settings (kind, enabled, emails) VALUES ('expiry', 1, ?)")
    .run("bezopasnik@example.test");

  // emit намеренно не ждёт отправку. Ровно в этот момент планировщик делает
  // свой ежечасный повтор — и выбирает ту же самую ожидающую строку.
  notifications.emit(db, { kind: "expiry", dedupKey: "гонка", payload: { "фио": "Образцов О." } });
  await notifications.retryPending(db);
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(smtp.messages.length, 1,
    `получателю ушло ${smtp.messages.length} писем вместо одного — рассылка и повтор разобрали одну строку одновременно`);
  const d = db.prepare("SELECT * FROM notification_deliveries WHERE channel='email'").get();
  assert.equal(d.status, "sent");
});
