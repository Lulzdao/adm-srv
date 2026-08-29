'use strict';

const test = require("node:test");
const assert = require("node:assert");

const { freshDb } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");

// ============================================================================
//  Заявки по HTTP: права доступа и видимость
//
//  Всё здесь идёт через настоящий сервер — вход, кука, маршрут. Данные
//  выдуманы: настоящих ФИО и заявок в тестах быть не должно.
// ============================================================================

/** Общая обстановка: заявитель, исполнитель хозотдела, админ и заявка в ИТ. */
async function stand(t) {
  const { db, cleanup } = freshDb();
  const app = await startApp(db);
  t.after(async () => { await app.close(); cleanup(); });

  const ids = {
    заявитель: await makeLocalUser(db, { login: "!сотрудник", name: "Сотрудник Тестовый", role: "user" }),
    админ: await makeLocalUser(db, { login: "!ит", name: "Админ Тестовый", role: "it" }),
    хозяйственник: await makeLocalUser(db, { login: "!хоз", name: "Хозяйственник Тестовый", role: "hoz" }),
    посторонний: await makeLocalUser(db, { login: "!чужой", name: "Посторонний Тестовый", role: "user" }),
  };

  const заявитель = client(app.url);
  await заявитель.login("!сотрудник");
  const создано = await заявитель.post("/api/tickets", {
    title: "Не печатает принтер", description: "Мигает лампочка", room: "212", priority: "medium",
  });
  assert.strictEqual(создано.status, 201, `заявка не создалась: ${создано.text}`);

  return { db, app, ids, заявитель, ticketId: создано.json.id };
}

test("внутренняя заметка не видна заявителю", async (t) => {
  const { app, заявитель, ticketId } = await stand(t);

  const админ = client(app.url);
  await админ.login("!ит");
  const r = await админ.post(`/api/tickets/${ticketId}/comments`, {
    text: "Списываем принтер, пользователю не сообщаем", is_internal: true,
  });
  assert.strictEqual(r.status, 201, r.text);

  const глазамиЗаявителя = await заявитель.get(`/api/tickets/${ticketId}`);
  assert.strictEqual(глазамиЗаявителя.status, 200);
  const тексты = глазамиЗаявителя.json.ticket.comments.map((c) => c.text);
  assert.deepStrictEqual(тексты, [], "заявитель не должен видеть ни одной внутренней заметки");
});

test("внутренняя заметка видна тому, кто ведёт заявку", async (t) => {
  const { app, ticketId } = await stand(t);

  const админ = client(app.url);
  await админ.login("!ит");
  await админ.post(`/api/tickets/${ticketId}/comments`, { text: "Служебная пометка", is_internal: true });

  const глазамиАдмина = await админ.get(`/api/tickets/${ticketId}`);
  const заметки = глазамиАдмина.json.ticket.comments.filter((c) => c.is_internal);
  assert.strictEqual(заметки.length, 1, "исполнитель обязан видеть свои заметки");
  assert.strictEqual(заметки[0].text, "Служебная пометка");
});

test("обычный комментарий виден обеим сторонам", async (t) => {
  const { app, заявитель, ticketId } = await stand(t);

  const админ = client(app.url);
  await админ.login("!ит");
  await админ.post(`/api/tickets/${ticketId}/comments`, { text: "Выезжаем сегодня", is_internal: false });

  for (const [кто, кл] of [["заявитель", заявитель], ["админ", админ]]) {
    const r = await кл.get(`/api/tickets/${ticketId}`);
    assert.ok(r.json.ticket.comments.some((c) => c.text === "Выезжаем сегодня"),
      `${кто} должен видеть открытый комментарий`);
  }
});

test("исполнитель чужого отдела не может пометить заметку внутренней", async (t) => {
  const { app, заявитель, ticketId } = await stand(t);

  // Хозяйственник видит заявку в ИТ, только если сам её создал или назначен.
  // Возьмём его собственную заявку в ИТ — там он заявитель, а не исполнитель.
  const хоз = client(app.url);
  await хоз.login("!хоз");
  const своя = await хоз.post("/api/tickets", {
    title: "Нужен новый монитор", description: "Мерцает", room: "301", priority: "low",
  });
  assert.strictEqual(своя.status, 201, своя.text);

  const r = await хоз.post(`/api/tickets/${своя.json.id}/comments`, {
    text: "Пометка, которую я сам бы не увидел", is_internal: true,
  });
  assert.strictEqual(r.status, 201);

  // Заметка должна была стать открытой: иначе автор создал бы запись,
  // невидимую ему самому.
  const свояКарточка = await хоз.get(`/api/tickets/${своя.json.id}`);
  const c = свояКарточка.json.ticket.comments.find((x) => x.text.startsWith("Пометка"));
  assert.ok(c, "комментарий обязан остаться виден автору");
  assert.strictEqual(c.is_internal, 0, "внутренней её делать нельзя — автор её не увидит");
  assert.strictEqual(заявитель.cookie === "", false); // сессии не перепутались
});

test("посторонний не открывает чужую заявку", async (t) => {
  const { app, ticketId } = await stand(t);
  const чужой = client(app.url);
  await чужой.login("!чужой");
  const r = await чужой.get(`/api/tickets/${ticketId}`);
  assert.strictEqual(r.status, 403, "чужая заявка должна закрываться 403, а не отдаваться");
});

test("без входа карточка не отдаётся", async (t) => {
  const { app, ticketId } = await stand(t);
  const аноним = client(app.url);
  const r = await аноним.get(`/api/tickets/${ticketId}`);
  assert.strictEqual(r.status, 401);
});

test("заявитель не может менять статус своей заявки", async (t) => {
  const { заявитель, ticketId } = await stand(t);
  const r = await заявитель.patch(`/api/tickets/${ticketId}`, { status: "closed" });
  assert.strictEqual(r.status, 403, "право видеть заявку не даёт права ею управлять");
});

test("некорректный идентификатор — 400, а не 500", async (t) => {
  const { заявитель } = await stand(t);
  for (const плохой of ["0", "abc", "-1", "1.5", "..%2f..%2fetc"]) {
    const r = await заявитель.get(`/api/tickets/${плохой}`);
    assert.ok(r.status === 400 || r.status === 404,
      `для "${плохой}" ожидался 400/404, получен ${r.status}`);
  }
});

test("номер заявки не переиспользуется после удаления строки из базы", async (t) => {
  const { db, app, заявитель, ticketId } = await stand(t);

  const первый = db.prepare("SELECT display_id FROM tickets WHERE id = ?").get(ticketId);
  assert.strictEqual(первый.display_id, "ИТ-0001");

  const второй = await заявитель.post("/api/tickets", {
    title: "Вторая заявка", description: "проверка нумерации", room: "212", priority: "low",
  });
  assert.strictEqual(второй.status, 201, второй.text);
  assert.strictEqual(
    db.prepare("SELECT display_id FROM tickets WHERE id = ?").get(второй.json.id).display_id,
    "ИТ-0002"
  );

  // Чистка тестовых заявок прямо в базе — обычное дело у администратора.
  db.prepare("DELETE FROM tickets WHERE id = ?").run(ticketId);

  const третий = await заявитель.post("/api/tickets", {
    title: "Третья заявка", description: "после удаления первой", room: "212", priority: "low",
  });
  assert.strictEqual(третий.status, 201,
    `создание упало после удаления заявки — счётчик откатился: ${третий.text}`);
  assert.strictEqual(
    db.prepare("SELECT display_id FROM tickets WHERE id = ?").get(третий.json.id).display_id,
    "ИТ-0003",
    "номер должен продолжаться от наибольшего, а не от количества"
  );
  assert.ok(app);
});

test("отвергнутое вложение не отменяет уже созданную заявку", async (t) => {
  const { db, app, заявитель, ticketId } = await stand(t);

  // Тип не из белого списка — multer отвергнет его на входе.
  const форма = new FormData();
  форма.append("file", new Blob(["MZ выдуманное содержимое"], { type: "application/x-msdownload" }), "вирус.exe");
  const r = await fetch(`${app.url}/api/tickets/${ticketId}/attachments`, {
    method: "POST", headers: { Cookie: заявитель.cookie }, body: форма,
  });

  assert.strictEqual(r.status, 400, "недопустимый тип должен отвергаться с 400, а не 500");
  const карточка = await заявитель.get(`/api/tickets/${ticketId}`);
  assert.strictEqual(карточка.status, 200, "заявка обязана остаться на месте");
  assert.strictEqual(карточка.json.ticket.attachments.length, 0);
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM tickets").get().c, 1,
    "второй заявки появиться не должно");
});

test("допустимое вложение прикрепляется и видно в карточке", async (t) => {
  const { app, заявитель, ticketId } = await stand(t);

  const форма = new FormData();
  форма.append("file", new Blob(["выдуманный текст"], { type: "text/plain" }), "записка.txt");
  const r = await fetch(`${app.url}/api/tickets/${ticketId}/attachments`, {
    method: "POST", headers: { Cookie: заявитель.cookie }, body: форма,
  });
  assert.strictEqual(r.status, 201, await r.text());

  const карточка = await заявитель.get(`/api/tickets/${ticketId}`);
  assert.strictEqual(карточка.json.ticket.attachments.length, 1);
  assert.strictEqual(карточка.json.ticket.attachments[0].filename, "записка.txt");
});

test("имя вложения сохраняется как есть — экранирование лежит на фронтенде", async (t) => {
  const { app, заявитель, ticketId } = await stand(t);

  // Имя с кавычкой: раньше оно разрывало атрибут download в разметке.
  const враждебное = 'отчёт" onmouseover="1" x=".txt';
  const форма = new FormData();
  форма.append("file", new Blob(["выдуманный текст"], { type: "text/plain" }), враждебное);
  const r = await fetch(`${app.url}/api/tickets/${ticketId}/attachments`, {
    method: "POST", headers: { Cookie: заявитель.cookie }, body: форма,
  });
  assert.strictEqual(r.status, 201, await r.text());

  const карточка = await заявитель.get(`/api/tickets/${ticketId}`);
  const имя = карточка.json.ticket.attachments[0].filename;
  // Кавычку и переводы строк отправитель экранирует сам, ещё в заголовке
  // Content-Disposition (%22) — так делают и браузеры, и fetch. Поэтому через
  // обычную форму кавычка до базы не доходит. Но сервер имя НЕ чистит, и
  // клиент, который отправит запрос не через форму, положит в базу что угодно:
  // экранирование при выводе остаётся обязанностью фронтенда (test/frontend.test.js).
  assert.ok(имя.includes("%22"), `ожидалось экранированное имя, получено: ${имя}`);
  assert.ok(имя.startsWith("отчёт"), `кириллица должна доехать целой, получено: ${имя}`);
});

test("список заявок ограничен и сообщает полное число", async (t) => {
  const { db, app, заявитель, ticketId } = await stand(t);

  // Заявок больше предела делать незачем — проверяем сам договор ответа.
  const r = await заявитель.get("/api/tickets");
  assert.strictEqual(r.status, 200, r.text);
  assert.ok(Array.isArray(r.json.tickets));
  assert.strictEqual(typeof r.json.total, "number", "клиент подписывает счётчик по total");
  assert.strictEqual(typeof r.json.limit, "number", "и должен знать, сколько строк ему отдали");
  assert.strictEqual(r.json.total, 1);
  assert.ok(r.json.tickets.length <= r.json.limit);
  assert.ok(db && ticketId);
});

test("счётчик списка считается по тем же условиям, что и выдача", async (t) => {
  const { app, заявитель, ticketId } = await stand(t);

  // Вторая заявка в другом статусе: фильтр обязан влиять и на выдачу, и на total,
  // иначе на экране «5 заявок» при одной строке.
  const вторая = await заявитель.post("/api/tickets", {
    title: "Вторая заявка", description: "для фильтра", room: "212", priority: "low",
  });
  assert.strictEqual(вторая.status, 201, вторая.text);

  const админ = client(app.url);
  await админ.login("!ит");
  await админ.patch(`/api/tickets/${вторая.json.id}`, { status: "closed" });

  const открытые = await заявитель.get("/api/tickets");
  assert.strictEqual(открытые.json.total, 1, "закрытая заявка не должна попадать в счётчик открытых");
  assert.strictEqual(открытые.json.tickets.length, 1);

  const все = await заявитель.get("/api/tickets?status=all");
  assert.strictEqual(все.json.total, 2);
  assert.ok(ticketId);
});

test("сводка для дашборда считается на сервере, а не в браузере", async (t) => {
  const { app, заявитель, ticketId } = await stand(t);
  const админ = client(app.url);
  await админ.login("!ит");

  const r = await админ.get("/api/admin/stats");
  assert.strictEqual(r.status, 200, r.text);
  for (const поле of ["total", "open", "critical", "closedTotal", "byCategory"]) {
    assert.ok(поле in r.json, `в сводке нет поля ${поле}`);
  }
  assert.strictEqual(r.json.total, 1);
  assert.strictEqual(r.json.open, 1);
  assert.strictEqual(r.json.critical, 0);
  assert.strictEqual(r.json.closedTotal, 0);
  assert.strictEqual(typeof r.json.byCategory, "object");

  await админ.patch(`/api/tickets/${ticketId}`, { status: "closed" });
  const после = await админ.get("/api/admin/stats");
  assert.strictEqual(после.json.open, 0);
  assert.strictEqual(после.json.closedTotal, 1);

  // Сводка — только для ИТ: заявитель её не получает.
  const чужой = await заявитель.get("/api/admin/stats");
  assert.strictEqual(чужой.status, 403);
});
