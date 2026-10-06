'use strict';

const test = require("node:test");
const assert = require("node:assert");
const { freshDb } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");

// ============================================================================
//  Группы исполнителей по логинам, скрытие из «Новой заявки» и деление
//  Заявки на доступ по программам
//
//  Кейс из жизни: программа СЭД — группе «АДМ» из одной учётки, которой нет
//  на плитках «Новой заявки». Все имена, логины и адреса ВЫДУМАНЫ.
// ============================================================================

async function стенд(t) {
  const { db, cleanup } = freshDb();
  const ids = {
    admin: await makeLocalUser(db, { login: "adm1", name: "Стендов Стенд Стендович", isAdmin: true }),
    it: await makeLocalUser(db, { login: "it1", name: "Пробников Пробник Пробникович", role: "it" }),
    user: await makeLocalUser(db, { login: "u1", name: "Макетов Макет Макетович" }),
    adm: await makeLocalUser(db, { login: "Sedov", name: "Седов Сед Седович", email: "sedov@example.invalid" }),
  };
  const app = await startApp(db);
  const Adm = client(app.url); await Adm.login("adm1");
  const It = client(app.url); await It.login("it1");
  const U = client(app.url); await U.login("u1");
  const Sed = client(app.url); await Sed.login("Sedov");
  t.after(async () => { await app.close(); cleanup(); });
  return { db, app, ids, Adm, It, U, Sed };
}

const группа = (r, name) => r.json.groups.find((g) => g.name === name);

test("группа из панели: сразу в справочнике и нумерации, состав — по логинам, без повторного входа", async (t) => {
  const { db, Adm, U, Sed, It } = await стенд(t);

  // Только администратор.
  assert.strictEqual((await U.post("/api/admin/groups", { name: "АДМ", prefix: "АДМ" })).status, 403);
  assert.strictEqual((await It.get("/api/admin/groups")).status, 403);

  const r = await Adm.post("/api/admin/groups", { name: "АДМ", prefix: "адм", logins: "OFFICE\\SEDOV\nsedov@example.invalid", hidden: false });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const g = группа(r, "АДМ");
  assert.strictEqual(g.prefix, "АДМ");
  assert.strictEqual(g.custom, true);
  assert.deepStrictEqual(g.logins, [{ login: "sedov", name: "Седов Сед Седович" }], "домен и регистр отброшены, повтор схлопнут");

  // Без перезапуска: в справочнике плиток, и заявка получает свой номер.
  const deps = (await U.get("/api/departments")).json.departments;
  assert.ok(deps.some((d) => d.name === "АДМ" && !d.hidden));
  const created = await U.post("/api/tickets", { title: "Нужен доступ к почте", category: "АДМ" });
  assert.strictEqual(created.status, 201, JSON.stringify(created.json));
  assert.strictEqual(created.json.display_id, "АДМ-0001");

  // Вписанный логином видит очередь сразу — сессия та же, что до создания группы.
  const queue = (await Sed.get("/api/tickets")).json.tickets;
  assert.ok(queue.some((x) => x.display_id === "АДМ-0001"), "исполнитель группы видит её заявку");
  assert.ok(!(await It.get("/api/tickets")).json.tickets.some((x) => x.display_id === "АДМ-0001"), "ИТ чужую очередь не видит");
  // Колокольчик и письмо — участнику по логину.
  const ev = db.prepare("SELECT id FROM notification_events WHERE kind = ? ").get(`ticket_new:${g.role}`);
  assert.ok(ev, "событие о новой заявке группы");
  const del = db.prepare("SELECT channel, user_id, address FROM notification_deliveries WHERE event_id = ?").all(ev.id);
  assert.ok(del.some((d) => d.channel === "inapp" && d.user_id !== null));
  assert.ok(del.some((d) => d.channel === "email" && d.address === "sedov@example.invalid"));

  // Повтор имени и префикса — понятный отказ.
  assert.match((await Adm.post("/api/admin/groups", { name: "адм", prefix: "Х1" })).json.error, /уже есть/);
  assert.match((await Adm.post("/api/admin/groups", { name: "Другая", prefix: "ИТ" })).json.error, /занят/);
  assert.strictEqual((await Adm.post("/api/admin/groups", { name: "Плохой", prefix: "А-Б" })).status, 400);

  // Убрали логин — очередь пропала тоже сразу.
  assert.strictEqual((await Adm.put(`/api/admin/groups/${g.role}`, { logins: "" })).status, 200);
  assert.ok(!(await Sed.get("/api/tickets")).json.tickets.some((x) => x.display_id === "АДМ-0001"));

  // С заявками группу не удалить; пустую — можно.
  assert.match((await Adm.delete(`/api/admin/groups/${g.role}`)).json.error, /есть заявки/);
  const empty = await Adm.post("/api/admin/groups", { name: "Пустая", prefix: "ПУС" });
  const role2 = группа(empty, "Пустая").role;
  const gone = await Adm.delete(`/api/admin/groups/${role2}`);
  assert.strictEqual(gone.status, 200);
  assert.ok(!группа(gone, "Пустая"));
  assert.ok(!(await U.get("/api/departments")).json.departments.some((d) => d.name === "Пустая"));
  // Встроенный отдел не удаляется.
  assert.match((await Adm.delete("/api/admin/groups/it")).json.error, /Встроенный/);
});

test("логин во встроенном отделе: отдел добавляется к домену и снимается, не задевая выданное доменом", async (t) => {
  const { db, ids, Adm, U, It } = await стенд(t);
  // u1 — обычный, it1 — исполнитель ИТ «из домена» (у локальной — из .env, здесь — строкой в базе).
  assert.strictEqual((await Adm.put("/api/admin/groups/hoz", { logins: "u1\nit1" })).status, 200);
  const roles = (id) => ({ ...db.prepare("SELECT roles, login_roles FROM users WHERE id = ?").get(id) });
  assert.deepStrictEqual(roles(ids.user), { roles: ",hoz,", login_roles: ",hoz," });
  assert.deepStrictEqual(roles(ids.it), { roles: ",it,hoz,", login_roles: ",hoz," });
  assert.deepStrictEqual((await U.get("/api/auth/me")).json.user.roles, ["hoz"]);

  // ИТ вписали логином туда, где он и так из «домена», — снятие из списка ИТ у него не отнимет.
  await Adm.put("/api/admin/groups/it", { logins: "it1" });
  await Adm.put("/api/admin/groups/it", { logins: "" });
  await Adm.put("/api/admin/groups/hoz", { logins: "" });
  assert.deepStrictEqual(roles(ids.it), { roles: ",it,", login_roles: "" });
  assert.deepStrictEqual(roles(ids.user), { roles: "", login_roles: "" });
  assert.deepStrictEqual((await It.get("/api/auth/me")).json.user.roles, ["it"]);
});

test("вход через домен: к отделам из групп добавляются отделы из списков логинов", async (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const { setSetting } = require("../services/settings");
  const { upsertFromLdap } = require("../services/userStore");
  setSetting(db, "egrpo_logins", "Domain\\Kotov");
  const u = upsertFromLdap(db, { login: "kotov", fullName: "Котов К.К.", roles: ["it"], role: "it", domain: "A", groups: [] });
  assert.strictEqual(u.roles, ",it,egrpo,");
  assert.strictEqual(u.login_roles, ",egrpo,");
  assert.strictEqual(u.role, "it");
  const v = upsertFromLdap(db, { login: "Kotov", fullName: "Котов К.К.", roles: [], role: "user", domain: "A", groups: [] });
  assert.strictEqual(v.roles, ",egrpo,", "из группы домена вышел — остался только отдел по логину");
  assert.strictEqual(v.role, "egrpo");
});

test("скрытая группа: нет плитки, напрямую заявку не завести (кроме своих и администратора)", async (t) => {
  const { Adm, U, Sed } = await стенд(t);
  const g = группа(await Adm.post("/api/admin/groups", { name: "АДМ", prefix: "АДМ", logins: "sedov", hidden: true }), "АДМ");
  assert.strictEqual(g.hidden, true);
  const d = (await U.get("/api/departments")).json.departments.find((x) => x.name === "АДМ");
  assert.strictEqual(d.hidden, true);
  assert.match((await U.post("/api/tickets", { title: "Обход", category: "АДМ" })).json.error, /не принимает заявки напрямую/);
  assert.strictEqual((await Sed.post("/api/tickets", { title: "Своя", category: "АДМ" })).status, 201);
  assert.strictEqual((await Adm.post("/api/tickets", { title: "Админ", category: "АДМ" })).status, 201);
});

test("заявка на доступ делится по исполнителям программ; записка одна, с полным списком", async (t) => {
  const { db, Adm, U, Sed, It } = await стенд(t);
  assert.strictEqual((await Adm.post("/api/assistant/settings/dict/depts", { name: "Отдел выдуманной статистики", chief_name: "Первов П.П." })).status, 201);
  const g = группа(await Adm.post("/api/admin/groups", { name: "АДМ", prefix: "АДМ", logins: "sedov", hidden: true }), "АДМ");

  // Соответствие: СЭД — группе АДМ; незнакомая программа и пустое значение не сохраняются, чужая роль — отказ.
  assert.strictEqual((await Adm.put("/api/assistant/settings/general", { programExecutors: { "СЭД": "nope" } })).status, 400);
  assert.strictEqual((await Adm.put("/api/assistant/settings/general", { programExecutors: { "СЭД": g.role, "Нет такой": g.role, "АРМ ГС": "" } })).status, 200);
  const general = (await Adm.get("/api/assistant/settings/general")).json;
  assert.deepStrictEqual(general.programExecutors, { "СЭД": g.role });
  assert.ok(general.executorGroups.some((e) => e.role === g.role), "скрытая группа есть в списке для сопоставления");

  const r = await U.post("/api/assistant/access", {
    type: "register", last_name: "Новиков", first_name: "Новик", post: "Экономист",
    department: "Отдел выдуманной статистики", programs: ["АРМ ГС", "СЭД"],
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const [itT, admT] = r.json.tickets;
  assert.strictEqual(r.json.tickets.length, 2);
  assert.match(itT.display_id, /^ИТ-\d{4}$/);
  assert.deepStrictEqual(itT.programs, ["АРМ ГС"]);
  assert.strictEqual(admT.display_id, "АДМ-0001");
  assert.deepStrictEqual(admT.programs, ["СЭД"]);
  assert.strictEqual(r.json.ticket.id, itT.id, "первая — общая очередь");

  // Каждый видит свою.
  assert.ok((await Sed.get("/api/tickets")).json.tickets.some((x) => x.id === admT.id));
  assert.ok(!(await Sed.get("/api/tickets")).json.tickets.some((x) => x.id === itT.id));
  assert.ok(!(await It.get("/api/tickets")).json.tickets.some((x) => x.id === admT.id));
  // В анкете — свои программы и соседняя заявка; полный список остаётся для записки.
  const form = (await Sed.get(`/api/tickets/${admT.id}`)).json.ticket.form.data;
  assert.deepStrictEqual(form.ticket_programs, ["СЭД"]);
  assert.deepStrictEqual(form.programs, ["АРМ ГС", "СЭД"]);
  assert.deepStrictEqual(form.related.map((x) => x.display_id), [itT.display_id]);

  // Все программы — группе: заявки в общую очередь нет. С формами ЦСОД — есть.
  const only = await U.post("/api/assistant/access", { type: "register", last_name: "Б", first_name: "Б", post: "Экономист", department: "Отдел выдуманной статистики", programs: ["СЭД"] });
  assert.deepStrictEqual(only.json.tickets.map((x) => x.display_id), ["АДМ-0002"]);
  assert.ok(!db.prepare("SELECT data FROM ticket_forms WHERE ticket_id = ?").get(only.json.ticket.id).data.includes("related"), "одна заявка — анкета как раньше");
  const csod = await U.post("/api/assistant/access", { type: "register", last_name: "В", first_name: "В", post: "Экономист", department: "Отдел выдуманной статистики", programs: ["СЭД"], csod_forms: "1-Т" });
  assert.deepStrictEqual(csod.json.tickets.map((x) => x.display_id.split("-")[0]), ["ИТ", "АДМ"]);

  // Группу удалили бы — программы вернулись бы в общую очередь; с заявками удалить нельзя, а пустую проверим отдельно.
  const tmp = группа(await Adm.post("/api/admin/groups", { name: "Врем", prefix: "ВРМ" }), "Врем");
  await Adm.put("/api/assistant/settings/general", { programExecutors: { "СЭД": g.role, "ЦСОД": tmp.role } });
  await Adm.delete(`/api/admin/groups/${tmp.role}`);
  assert.deepStrictEqual((await Adm.get("/api/assistant/settings/general")).json.programExecutors, { "СЭД": g.role });
});
