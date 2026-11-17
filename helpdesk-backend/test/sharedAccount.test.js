'use strict';

const test = require("node:test");
const assert = require("node:assert/strict");

const { freshDb } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");

// ============================================================================
//  Общая аварийная учётка (!user) — на время аварии домена
//
//  Под ней подают заявки разные сотрудники, поэтому: ФИО заявителя вписывается
//  в заявку и обязательно; чужие (да и свои прошлые) заявки, списки и
//  колокольчик ей не видны; исполнители видят заявителя по вписанному ФИО.
//  ВСЕ ДАННЫЕ ВЫДУМАНЫ.
// ============================================================================

async function стенд(t) {
  const { db, cleanup } = freshDb();
  await makeLocalUser(db, { login: "adm1", name: "Админов Админ", isAdmin: true });
  await makeLocalUser(db, { login: "!user", name: "Общая аварийная учётка" });
  await makeLocalUser(db, { login: "emp1", name: "Сотрудникова Сотрудница" });
  const app = await startApp(db);
  t.after(async () => { await app.close(); cleanup(); });
  const login = async (name) => { const c = client(app.url); await c.login(name); return c; };
  return { db, Adm: await login("adm1"), Shared: await login("!user"), Emp: await login("emp1") };
}

const заявка = (extra = {}) => ({ title: "Не печатает принтер", description: "Замятие", category: "ИТ", room: "101", extension: "101", ...extra });

test("общая учётка: флаг shared только у неё; ФИО заявителя обязательно", async (t) => {
  const { Shared, Emp } = await стенд(t);
  assert.equal((await Shared.get("/api/auth/me")).json.user.shared, true);
  assert.equal((await Emp.get("/api/auth/me")).json.user.shared, false, "прочие локальные учётки — обычные");

  const без = await Shared.post("/api/tickets", заявка());
  assert.equal(без.status, 400);
  assert.match(без.json.error, /ФИО/);
  assert.equal((await Shared.post("/api/tickets", заявка({ requester_name: "   " }))).status, 400);
  assert.equal((await Shared.post("/api/tickets", заявка({ requester_name: "Я".repeat(121) }))).status, 400);

  // У обычного сотрудника поле не нужно и не сохраняется.
  const обычная = await Emp.post("/api/tickets", заявка({ requester_name: "Кто-то Другой" }));
  assert.equal(обычная.status, 201);
  assert.equal(обычная.json.created_by_name, "Сотрудникова Сотрудница");
});

test("заявка под общей учёткой: исполнитель видит вписанное ФИО, сама учётка — ни заявки, ни списков", async (t) => {
  const { db, Adm, Shared } = await стенд(t);
  const r = await Shared.post("/api/tickets", заявка({ requester_name: "  Пробников   Пробник Пробникович " }));
  assert.equal(r.status, 201, r.text);
  const id = r.json.id;
  assert.equal(db.prepare("SELECT requester_name FROM tickets WHERE id = ?").get(id).requester_name, "Пробников Пробник Пробникович");

  // Исполнитель (здесь — администратор): в карточке и в списке — ФИО с пометкой.
  const карточка = (await Adm.get(`/api/tickets/${id}`)).json.ticket;
  assert.equal(карточка.created_by_name, "Пробников Пробник Пробникович (общая учётка)");
  const список = (await Adm.get("/api/tickets")).json.tickets;
  assert.equal(список.find((x) => x.id === id).created_by, "Пробников Пробник Пробникович (общая учётка)");

  // Сама общая учётка — ничего: ни списка, ни карточки, ни комментариев, ни колокольчика.
  assert.deepEqual((await Shared.get("/api/tickets")).json.tickets, []);
  assert.deepEqual((await Shared.get("/api/tickets?mine=1")).json.tickets, []);
  assert.equal((await Shared.get(`/api/tickets/${id}`)).status, 403);
  assert.equal((await Shared.post(`/api/tickets/${id}/comments`, { text: "ну что там?" })).status, 403);
  assert.deepEqual((await Shared.get("/api/notifications")).json.notifications, []);
});

test("только что поданную заявку общей учётки можно дополнить (файлы, служебная записка) — 30 минут", () => {
  const { sharedJustCreated } = require("../routes/tickets");
  const shared = { id: 7, ad_login: "!user", auth_type: "local", is_admin: false };
  const сейчас = new Date(Date.now() - 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const давно = new Date(Date.now() - 31 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  assert.equal(sharedJustCreated(shared, { created_by: 7, created_at: сейчас }), true);
  assert.equal(sharedJustCreated(shared, { created_by: 7, created_at: давно }), false, "старая — уже нет");
  assert.equal(sharedJustCreated(shared, { created_by: 8, created_at: сейчас }), false, "чужая — нет");
  assert.equal(sharedJustCreated({ ...shared, ad_login: "emp1" }, { created_by: 7, created_at: сейчас }), false, "не общая учётка");
});
