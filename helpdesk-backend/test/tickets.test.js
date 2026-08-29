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
