'use strict';

const test = require("node:test");
const assert = require("node:assert");

const { freshDb } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");

// ============================================================================
//  Администратор — не роль, а отдельный признак
//
//  Роль отвечает на вопрос «в каком отделе человек исполнитель». Права
//  администратора выдаются ТОЛЬКО группой из .env и через панель недостижимы.
//  Раньше это было одно поле: добавили в панели группу к отделу ИТ — и её
//  участники становились администраторами платформы.
//
//  Все имена и учётные данные выдуманы.
// ============================================================================

async function stand(t) {
  const { db, cleanup } = freshDb();
  const app = await startApp(db);
  t.after(async () => { await app.close(); cleanup(); });

  await makeLocalUser(db, { login: "!админ", name: "Админ Тестовый", role: "it", isAdmin: true });
  // Исполнитель отдела ИТ: та же роль, но БЕЗ прав администратора.
  await makeLocalUser(db, { login: "!итшник", name: "Исполнитель Тестовый", role: "it" });
  await makeLocalUser(db, { login: "!хоз", name: "Хозяйственник Тестовый", role: "hoz" });
  await makeLocalUser(db, { login: "!сотрудник", name: "Сотрудник Тестовый", role: "user" });
  return { db, app };
}

const войти = async (app, логин) => {
  const кл = client(app.url);
  await кл.login(логин);
  return кл;
};

test("исполнитель отдела ИТ не получает прав администратора", async (t) => {
  const { app } = await stand(t);
  const итшник = await войти(app, "!итшник");

  for (const адрес of ["/api/admin/settings", "/api/admin/stats", "/api/admin/admins",
                       "/api/notifications/feed", "/api/certificates/server"]) {
    const r = await итшник.get(адрес);
    assert.strictEqual(r.status, 403, `${адрес} должен закрываться 403, получено ${r.status}`);
  }
});

test("администратор в те же разделы проходит", async (t) => {
  const { app } = await stand(t);
  const админ = await войти(app, "!админ");

  for (const адрес of ["/api/admin/settings", "/api/admin/stats", "/api/notifications/feed"]) {
    const r = await админ.get(адрес);
    assert.strictEqual(r.status, 200, `${адрес}: ${r.status} ${r.text}`);
  }
});

test("признак администратора виден в сессии и отделён от роли", async (t) => {
  const { app } = await stand(t);

  const админ = await войти(app, "!админ");
  const я = await админ.get("/api/auth/me");
  assert.strictEqual(я.json.user.is_admin, true);
  assert.strictEqual(я.json.user.role, "it", "роль остаётся отделом исполнителя");

  const итшник = await войти(app, "!итшник");
  const он = await итшник.get("/api/auth/me");
  assert.strictEqual(он.json.user.is_admin, false);
  assert.strictEqual(он.json.user.role, "it", "та же роль, но без прав администратора");
});

test("исполнитель ИТ видит очередь своего отдела, но не чужие заявки", async (t) => {
  const { app } = await stand(t);

  const хоз = await войти(app, "!хоз");
  const хозЗаявка = await хоз.post("/api/tickets", {
    title: "Сломался стул", description: "качается", room: "301", priority: "low", category: "ХОЗ",
  });
  assert.strictEqual(хозЗаявка.status, 201, хозЗаявка.text);

  const сотрудник = await войти(app, "!сотрудник");
  const итЗаявка = await сотрудник.post("/api/tickets", {
    title: "Не печатает принтер", description: "мигает", room: "212", priority: "medium", category: "ИТ",
  });
  assert.strictEqual(итЗаявка.status, 201, итЗаявка.text);

  const итшник = await войти(app, "!итшник");
  const своя = await итшник.get(`/api/tickets/${итЗаявка.json.id}`);
  assert.strictEqual(своя.status, 200, "заявку своего отдела исполнитель обязан видеть");

  const чужая = await итшник.get(`/api/tickets/${хозЗаявка.json.id}`);
  assert.strictEqual(чужая.status, 403, "чужой отдел исполнителю ИТ не виден");

  const список = await итшник.get("/api/tickets");
  assert.strictEqual(список.json.total, 1, "во «Входящих» — только очередь своего отдела");
});

test("администратор видит заявки всех отделов", async (t) => {
  const { app } = await stand(t);

  const хоз = await войти(app, "!хоз");
  const хозЗаявка = await хоз.post("/api/tickets", {
    title: "Сломался стул", description: "качается", room: "301", priority: "low", category: "ХОЗ",
  });
  const сотрудник = await войти(app, "!сотрудник");
  await сотрудник.post("/api/tickets", {
    title: "Не печатает принтер", description: "мигает", room: "212", priority: "medium", category: "ИТ",
  });

  const админ = await войти(app, "!админ");
  assert.strictEqual((await админ.get(`/api/tickets/${хозЗаявка.json.id}`)).status, 200);
  assert.strictEqual((await админ.get("/api/tickets")).json.total, 2);
});

test("модули открыты администратору и закрыты исполнителю", async (t) => {
  const { app } = await stand(t);

  const админ = await войти(app, "!админ");
  const видноАдмину = (await админ.get("/api/modules")).json.modules.map((m) => m.id);
  assert.ok(видноАдмину.includes("certs"), "администратор должен видеть Сертвивер");

  const итшник = await войти(app, "!итшник");
  const видноИсполнителю = (await итшник.get("/api/modules")).json.modules;
  assert.deepStrictEqual(видноИсполнителю, [],
    "по умолчанию модули только у администраторов — список roles в config/modules.js пуст");

  // И не только пункт меню: сам прокси тоже должен отказать.
  const r = await итшник.get("/modules/certs/");
  assert.strictEqual(r.status, 403);
});

test("локальная аварийная учётка администратор по конфигу, а не по домену", async (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { ensureLocalAccounts } = require("../db/init");
  const config = require("../config/config");

  // Пароль в конфиге пустой, поэтому учётка не заводится — подкладываем хэш.
  db.prepare(`INSERT INTO users (ad_login, full_name, role, auth_type, local_password_hash)
              VALUES (?, ?, 'it', 'local', 'выдуманный-хэш')`)
    .run(config.localAccounts[0].login, "Локальный администратор");

  ensureLocalAccounts(db);
  const строка = db.prepare("SELECT is_admin FROM users WHERE ad_login = ?")
    .get(config.localAccounts[0].login);
  assert.strictEqual(строка.is_admin, 1,
    "иначе при пустой группе в .env администрировать платформу станет некому");
});

// ---------------------------------------------------------------------------
//  Несколько отделов у одного исполнителя
//
//  Человек состоит и в группе ИТ, и в группе ХОЗ — значит ведёт очереди обеих.
//  Раньше цикл в ldapAuth выходил по первому совпадению, и до него доходили
//  заявки только того отдела, что стоит раньше в config/departments.js.
// ---------------------------------------------------------------------------

async function двухотдельный(t) {
  const { db, cleanup } = freshDb();
  const app = await startApp(db);
  t.after(async () => { await app.close(); cleanup(); });

  await makeLocalUser(db, { login: "!оба", name: "Универсал Тестовый", roles: ["it", "hoz"] });
  await makeLocalUser(db, { login: "!толькоит", name: "Только ИТ Тестовый", role: "it" });
  await makeLocalUser(db, { login: "!егрпо", name: "Егрпо Тестовый", role: "egrpo" });
  await makeLocalUser(db, { login: "!админ", name: "Админ Тестовый", role: "it", isAdmin: true });
  await makeLocalUser(db, { login: "!сотрудник", name: "Сотрудник Тестовый", role: "user" });

  const сотрудник = await войти(app, "!сотрудник");
  const ит = await сотрудник.post("/api/tickets", {
    title: "Не печатает принтер", description: "мигает", room: "212", priority: "medium", category: "ИТ",
  });
  const хоз = await сотрудник.post("/api/tickets", {
    title: "Сломался стул", description: "качается", room: "301", priority: "low", category: "ХОЗ",
  });
  const егрпо = await сотрудник.post("/api/tickets", {
    title: "Вопрос по реестру", description: "уточнение", room: "115", priority: "low", category: "ЕГРПО",
  });
  for (const r of [ит, хоз, егрпо]) assert.strictEqual(r.status, 201, r.text);
  return { db, app, ит: ит.json.id, хоз: хоз.json.id, егрпо: егрпо.json.id };
}

test("исполнитель двух отделов видит очереди обоих", async (t) => {
  const { app, ит, хоз, егрпо } = await двухотдельный(t);
  const оба = await войти(app, "!оба");

  assert.strictEqual((await оба.get(`/api/tickets/${ит}`)).status, 200, "заявка ИТ");
  assert.strictEqual((await оба.get(`/api/tickets/${хоз}`)).status, 200, "заявка ХОЗ");
  assert.strictEqual((await оба.get(`/api/tickets/${егрпо}`)).status, 403, "чужой отдел закрыт");

  const список = await оба.get("/api/tickets");
  assert.strictEqual(список.json.total, 2, "во «Входящих» — очереди обоих отделов, но не третьего");
});

test("исполнитель одного отдела соседнюю очередь не видит", async (t) => {
  const { app, ит, хоз } = await двухотдельный(t);
  const толькоИТ = await войти(app, "!толькоит");

  assert.strictEqual((await толькоИТ.get(`/api/tickets/${ит}`)).status, 200);
  assert.strictEqual((await толькоИТ.get(`/api/tickets/${хоз}`)).status, 403);
  assert.strictEqual((await толькоИТ.get("/api/tickets")).json.total, 1);
});

test("исполнитель двух отделов управляет заявками обоих", async (t) => {
  const { app, ит, хоз } = await двухотдельный(t);
  const оба = await войти(app, "!оба");

  for (const [имя, id] of [["ИТ", ит], ["ХОЗ", хоз]]) {
    const r = await оба.patch(`/api/tickets/${id}`, { status: "progress" });
    assert.strictEqual(r.status, 200, `заявку ${имя} он обязан вести: ${r.text}`);
  }
});

test("его можно назначить исполнителем в обоих отделах", async (t) => {
  const { db, app, ит, хоз } = await двухотдельный(t);
  const оба = await войти(app, "!оба");
  const id = db.prepare("SELECT id FROM users WHERE ad_login = ?").get("!оба").id;

  for (const [имя, ticket] of [["ИТ", ит], ["ХОЗ", хоз]]) {
    const кандидаты = await оба.get(`/api/tickets/${ticket}/assignees`);
    assert.ok(кандидаты.json.users.some((u) => u.id === id),
      `в кандидатах отдела ${имя} его нет`);
    const r = await оба.patch(`/api/tickets/${ticket}`, { assigned_to: id });
    assert.strictEqual(r.status, 200, `назначение в отделе ${имя}: ${r.text}`);
  }
});

test("оповещения о новых заявках приходят по обоим отделам", async (t) => {
  const { db, app } = await двухотдельный(t);
  const id = db.prepare("SELECT id FROM users WHERE ad_login = ?").get("!оба").id;

  const отметки = db.prepare(`
    SELECT e.kind FROM notification_deliveries d
    JOIN notification_events e ON e.id = d.event_id
    WHERE d.channel = 'inapp' AND d.user_id = ?
  `).all(id).map((r) => r.kind).sort();

  assert.deepStrictEqual(отметки, ["ticket_new:hoz", "ticket_new:it"],
    "он должен получить отметки и по заявке ИТ, и по заявке ХОЗ");
});

// Список кандидатов в исполнители ограничен отделом заявки. Раньше запрос
// добирал ещё и всех, у кого is_admin = 1, и исполнитель ХОЗ видел в списке
// людей из чужих отделов.
test("в кандидаты по заявке ХОЗ не попадают ни админ, ни соседние отделы", async (t) => {
  const { db, app, хоз } = await двухотдельный(t);
  const исполнитель = await войти(app, "!оба");

  const ответ = await исполнитель.get(`/api/tickets/${хоз}/assignees`);
  assert.strictEqual(ответ.status, 200, ответ.text);
  const логин = (id) => db.prepare("SELECT ad_login FROM users WHERE id = ?").get(id).ad_login;
  const логины = ответ.json.users.map((u) => логин(u.id)).sort();

  assert.deepStrictEqual(логины, ["!оба"],
    "в отделе ХОЗ состоит ровно один исполнитель — только он и должен предлагаться");
});

test("назначить на заявку ХОЗ человека не из ХОЗ нельзя даже админа", async (t) => {
  const { db, app, хоз } = await двухотдельный(t);
  const исполнитель = await войти(app, "!оба");
  const админ = db.prepare("SELECT id FROM users WHERE ad_login = ?").get("!админ").id;
  const егрпо = db.prepare("SELECT id FROM users WHERE ad_login = ?").get("!егрпо").id;

  for (const [имя, id] of [["админ", админ], ["исполнитель ЕГРПО", егрпо]]) {
    const r = await исполнитель.patch(`/api/tickets/${хоз}`, { assigned_to: id });
    assert.strictEqual(r.status, 400, `${имя} не должен назначаться на заявку чужого отдела: ${r.text}`);
  }
  const после = db.prepare("SELECT assigned_to FROM tickets WHERE id = ?").get(хоз);
  assert.strictEqual(после.assigned_to, null, "исполнитель не должен был смениться");
});

// Человека вывели из отдела, а заявка за ним числится: выпадающий список
// обязан показать его как есть, иначе карточка соврёт про "не назначено".
test("уже назначенный исполнитель остаётся в списке после смены отделов", async (t) => {
  const { db, app, хоз } = await двухотдельный(t);
  const исполнитель = await войти(app, "!оба");
  const id = db.prepare("SELECT id FROM users WHERE ad_login = ?").get("!оба").id;

  assert.strictEqual((await исполнитель.patch(`/api/tickets/${хоз}`, { assigned_to: id })).status, 200);
  db.prepare("UPDATE users SET roles = ',it,' WHERE id = ?").run(id);

  const ответ = await исполнитель.get(`/api/tickets/${хоз}/assignees`);
  assert.ok(ответ.json.users.some((u) => u.id === id),
    "текущий исполнитель обязан остаться в списке, даже выйдя из отдела");
});
