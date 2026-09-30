'use strict';

const test = require("node:test");
const assert = require("node:assert");

// Подмена ldapts должна случиться раньше, чем кто-либо загрузит services/ldapAuth.
const ldap = require("./helpers/fakeLdap");
const { freshDb } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");
const { startFakeSmtp } = require("./helpers/fakeSmtp");

// ============================================================================
//  Общий ящик рассылок и группа домена — проверка в момент отправки
//
//  Группы запоминаются при входе, а вход живёт до 30 дней. Поэтому перед
//  рассылкой с ящика (и перед её продолжением или повтором) группа уточняется
//  в домене: исключённого из группы ящик больше не пускает, не дожидаясь его
//  повторного входа. Контроллер недоступен — решают запомненные группы.
//  Контроллер и почтовый сервер поддельные, имена и адреса выдуманы.
// ============================================================================

const DOMAIN_ENV = {
  DOMAIN_A_LABEL: "Тестовый домен",
  DOMAIN_A_LDAP_URL: "ldaps://dc.test.local:636",
  DOMAIN_A_BASE_DN: "DC=test,DC=local",
  DOMAIN_A_SVC_DN: "CN=svc-helpdesk,OU=Служебные,DC=test,DC=local",
  DOMAIN_A_SVC_PASSWORD: "пароль-сервисной-учётки",
  DOMAIN_A_ADMIN_GROUP: "Админы-Платформы",
  NETWORK_DOMAIN_A_CIDR: "127.0.0.0/8",
};
const GROUP = "Рассылка-Цены";

async function стенд(t) {
  const saved = {};
  for (const [k, v] of Object.entries(DOMAIN_ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  ldap.reset();
  ldap.directory.svc = { dn: DOMAIN_ENV.DOMAIN_A_SVC_DN, password: DOMAIN_ENV.DOMAIN_A_SVC_PASSWORD };
  ldap.addUser("cenova", { password: "п1", displayName: "Ценова Тест Тестовна", mail: "cenova@example.invalid", memberOf: [ldap.group(GROUP)] });

  const smtp = await startFakeSmtp();
  const { db, cleanup } = freshDb();
  await makeLocalUser(db, { login: "adm1", name: "Стендов Стенд", isAdmin: true });
  const app = await startApp(db);
  t.after(async () => { await app.close(); await smtp.close(); cleanup(); });

  const Adm = client(app.url); await Adm.login("adm1");
  await Adm.put("/api/mailings/settings", { host: "127.0.0.1", port: smtp.port, secure: false, delayMs: 0 });
  const box = (await Adm.post("/api/mailings/settings/mailboxes", { address: "ceny@example.invalid", ad_group: GROUP })).json.id;

  const U = client(app.url);
  const r = await U.post("/api/auth/login", { mode: "A", login: "cenova", password: "п1" });
  assert.strictEqual(r.status, 200, r.text);
  return { db, app, smtp, U, box };
}

async function разослать(app, C, payload) {
  const f = new FormData();
  f.append("payload", JSON.stringify({ subject: "Т", body: "Б", sender_mode: "shared", recipients: [{ row_no: 2, emails: ["one@example.invalid"] }], ...payload }));
  const res = await fetch(app.url + "/api/mailings", { method: "POST", headers: { Cookie: C.cookie }, body: f });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

const исключить = () => ldap.addUser("cenova", { password: "п1", displayName: "Ценова Тест Тестовна", memberOf: [] });

test("исключённый из группы теряет ящик сразу, без повторного входа", async (t) => {
  const { db, app, U, box } = await стенд(t);
  assert.strictEqual((await разослать(app, U, { mailbox_id: box })).status, 201, "в группе — можно");

  исключить();   // администратор домена убрал сотрудника из группы; сеанс в платформе жив
  const r = await разослать(app, U, { mailbox_id: box });
  assert.strictEqual(r.status, 400, r.text);
  assert.match(r.json.error, /только участникам его группы/);
  assert.strictEqual(db.prepare("SELECT ad_groups FROM users WHERE ad_login = 'cenova'").get().ad_groups, "",
    "группы в базе обновлены по домену");
  assert.deepStrictEqual((await U.get("/api/mailings/settings")).json.mailboxes, [], "и в списке ящиков его больше нет");
});

test("отключённая в домене учётка ящик не получает", async (t) => {
  const { app, U, box } = await стенд(t);
  // 514 = обычная учётка (512) + ACCOUNTDISABLE (2); группы при этом формально остаются.
  ldap.addUser("cenova", { password: "п1", displayName: "Ценова", memberOf: [ldap.group(GROUP)], userAccountControl: 514 });
  assert.strictEqual((await разослать(app, U, { mailbox_id: box })).status, 400);
});

test("домен недоступен — решают группы, запомненные при входе", async (t) => {
  const { app, U, box } = await стенд(t);
  ldap.directory.down = true;
  const r = await разослать(app, U, { mailbox_id: box });
  assert.strictEqual(r.status, 201, "рассылка не встаёт из-за контроллера: " + r.text);
});

test("продолжение и повтор рассылки тоже проверяют группу", async (t) => {
  const { app, U, box } = await стенд(t);
  const r = await разослать(app, U, { mailbox_id: box, recipients: Array.from({ length: 3 }, (_, i) => ({ row_no: i + 2, emails: [`r${i}@example.invalid`] })) });
  assert.strictEqual(r.status, 201, r.text);
  await U.post(`/api/mailings/${r.json.id}/pause`, {});

  исключить();
  const resume = await U.post(`/api/mailings/${r.json.id}/resume`, {});
  assert.strictEqual(resume.status, 400, resume.text);
  assert.match(resume.json.error, /вас в ней больше нет/);
  const retry = await U.post(`/api/mailings/${r.json.id}/retry`, {});
  assert.strictEqual(retry.status, 400, retry.text);
  assert.notStrictEqual((await U.get(`/api/mailings/${r.json.id}`)).json.campaign.status, "sending", "рассылка не пошла");
});

test("локальные учётки домен не спрашивают — у них групп нет", async (t) => {
  const { db, app, box } = await стенд(t);
  await makeLocalUser(db, { login: "mestny", name: "Местный Тест" });
  const L = client(app.url); await L.login("mestny");
  ldap.directory.filters.length = 0;
  assert.strictEqual((await разослать(app, L, { mailbox_id: box })).status, 400, "ящик группы локальной учётке недоступен");
  assert.deepStrictEqual(ldap.directory.filters, [], "в домен за её группами не ходили");
});
