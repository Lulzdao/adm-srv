'use strict';

const test = require("node:test");
const assert = require("node:assert");

// Подмена ldapts должна случиться раньше, чем кто-либо загрузит services/ldapAuth.
const ldap = require("./helpers/fakeLdap");
const { freshDb } = require("./helpers/tempDb");
const { startApp, client } = require("./helpers/httpApp");

// ============================================================================
//  Вход через домен
//
//  Что проверяется: из групп AD выводятся признак администратора (только группа
//  из .env) и ВСЕ отделы исполнителя (группы из панели); при каждом входе это
//  пересчитывается; логин экранируется в фильтре поиска; недоступный контроллер
//  не приближает блокировку входа; доменный вход не въезжает в локальную
//  аварийную учётку. Контроллер домена поддельный (helpers/fakeLdap.js), всё
//  остальное — настоящее, через HTTP.
// ============================================================================

const ADMIN_GROUP = "Админы-Платформы";
const DOMAIN_ENV = {
  DOMAIN_A_LABEL: "Тестовый домен",
  DOMAIN_A_LDAP_URL: "ldaps://dc.test.local:636",
  DOMAIN_A_BASE_DN: "DC=test,DC=local",
  DOMAIN_A_SVC_DN: "CN=svc-helpdesk,OU=Служебные,DC=test,DC=local",
  DOMAIN_A_SVC_PASSWORD: "пароль-сервисной-учётки",
  DOMAIN_A_ADMIN_GROUP: ADMIN_GROUP,
  NETWORK_DOMAIN_A_CIDR: "127.0.0.0/8",
};

async function stand(t) {
  const saved = {};
  for (const [k, v] of Object.entries(DOMAIN_ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  ldap.reset();
  ldap.directory.svc = { dn: DOMAIN_ENV.DOMAIN_A_SVC_DN, password: DOMAIN_ENV.DOMAIN_A_SVC_PASSWORD };

  const { db, cleanup } = freshDb();   // конфиг перечитается с доменными переменными
  const app = await startApp(db);
  t.after(async () => { await app.close(); cleanup(); });

  // Группы отделов настраиваются в панели — здесь кладём их в настройки напрямую.
  const { setSetting } = require("../services/settings");
  setSetting(db, "it_group_A", "Исполнители-ИТ");
  setSetting(db, "hoz_group_A", "Исполнители-ХОЗ");
  return { db, app };
}

const войти = (app, login, password) =>
  client(app.url).post("/api/auth/login", { mode: "A", login, password });

test("группы домена дают признак администратора и все отделы исполнителя", async (t) => {
  const { db, app } = await stand(t);
  ldap.addUser("volkov", {
    password: "верный-пароль", displayName: "Волков Тест Тестович",
    mail: ["volkov@test.local"], department: "Отдел тестов", phone: "212",
    memberOf: [ldap.group(ADMIN_GROUP), ldap.group("Исполнители-ИТ"), ldap.group("Исполнители-ХОЗ")],
  });

  const r = await войти(app, "volkov", "верный-пароль");
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.user.is_admin, true);
  assert.deepStrictEqual(r.json.user.roles, ["it", "hoz"], "отделов может быть несколько — нужны оба");
  assert.strictEqual(r.json.user.role, "it", "основной — первый по порядку в config/departments.js");
  assert.strictEqual(r.json.user.full_name, "Волков Тест Тестович");
  assert.strictEqual(r.json.user.email, "volkov@test.local", "массив из ldapts приводится к строке");

  const row = db.prepare("SELECT auth_type, last_domain, phone FROM users WHERE ad_login = 'volkov'").get();
  assert.deepStrictEqual({ ...row }, { auth_type: "ad", last_domain: "A", phone: "212" });
});

test("группа отдела ИТ не делает администратором", async (t) => {
  const { app } = await stand(t);
  ldap.addUser("ispolnitel", { password: "п1", displayName: "Исполнитель", memberOf: [ldap.group("Исполнители-ИТ")] });
  const r = await войти(app, "ispolnitel", "п1");
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.user.is_admin, false);
  assert.deepStrictEqual(r.json.user.roles, ["it"]);
});

test("имя группы сравнивается целиком, а не как подстрока", async (t) => {
  const { app } = await stand(t);
  ldap.addUser("praktikant", {
    password: "п1", displayName: "Практикант",
    memberOf: [ldap.group(`${ADMIN_GROUP}-Практиканты`), `OU=Архив,CN=${ADMIN_GROUP}-Архив,DC=test,DC=local`],
  });
  const r = await войти(app, "praktikant", "п1");
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.user.is_admin, false, "похожее имя группы не должно давать права администратора");
});

test("права пересчитываются при каждом входе: вышел из группы — признак снят", async (t) => {
  const { db, app } = await stand(t);
  ldap.addUser("byvshiy", { password: "п1", displayName: "Бывший Админ", memberOf: [ldap.group(ADMIN_GROUP)] });
  assert.strictEqual((await войти(app, "byvshiy", "п1")).json.user.is_admin, true);

  ldap.addUser("byvshiy", { password: "п1", displayName: "Бывший Админ", memberOf: [] });
  const r = await войти(app, "byvshiy", "п1");
  assert.strictEqual(r.json.user.is_admin, false);
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM users WHERE ad_login = 'byvshiy'").get().c, 1, "та же строка, а не вторая учётка");
});

test("регистр логина не важен: «Volkov» и «volkov» — один пользователь, написание — как в домене", async (t) => {
  const { db, app } = await stand(t);
  ldap.addUser("Volkov.TT", { password: "верный-пароль", displayName: "Волков Тест Тестович" });
  const a = await войти(app, "volkov.tt", "верный-пароль");
  const b = await войти(app, "VOLKOV.TT", "верный-пароль");
  assert.strictEqual(a.status, 200, a.text);
  assert.strictEqual(b.status, 200, b.text);
  assert.strictEqual(a.json.user.id, b.json.user.id, "одна запись, а не две");
  assert.deepStrictEqual(db.prepare("SELECT ad_login FROM users WHERE auth_type = 'ad'").all().map((r) => r.ad_login), ["Volkov.TT"]);
});

test("неверный пароль и неизвестный логин — 401", async (t) => {
  const { app } = await stand(t);
  ldap.addUser("ivanov", { password: "верный", displayName: "Иванов" });
  const неверный = await войти(app, "ivanov", "не тот");
  assert.strictEqual(неверный.status, 401);
  assert.strictEqual(неверный.json.code, "BAD_CREDENTIALS");
  const нет = await войти(app, "nikto", "что угодно");
  assert.strictEqual(нет.status, 401);
  assert.strictEqual(нет.json.code, "USER_NOT_FOUND");
});

test("спецсимволы логина экранируются в фильтре поиска", async (t) => {
  const { app } = await stand(t);
  await войти(app, "*)(memberOf=*", "п");
  assert.deepStrictEqual(ldap.directory.filters, ["(sAMAccountName=\\2a\\29\\28memberOf=\\2a)"],
    "иначе логин расширял бы поисковый фильтр");
});

test("недоступный контроллер — 503 и попытка не засчитывается в блокировку", async (t) => {
  const { app } = await stand(t);
  ldap.addUser("terpelivy", { password: "верный", displayName: "Терпеливый" });
  ldap.directory.down = true;
  // Больше предела попыток (10): если бы они засчитывались, дальше был бы 429.
  for (let i = 0; i < 12; i++) {
    const r = await войти(app, "terpelivy", "верный");
    assert.strictEqual(r.status, 503, r.text);
    assert.strictEqual(r.json.code, "DC_UNAVAILABLE");
  }
  ldap.directory.down = false;
  assert.strictEqual((await войти(app, "terpelivy", "верный")).status, 200, "домен вернулся — вход должен работать");
});

test("сбой поиска в домене — 503 SEARCH_FAILED", async (t) => {
  const { app } = await stand(t);
  ldap.directory.searchFails = true;
  const r = await войти(app, "kto-to", "п");
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.json.code, "SEARCH_FAILED");
});

test("доменный вход не перезаписывает локальную учётку с тем же логином", async (t) => {
  const { db, app } = await stand(t);
  db.prepare(`INSERT INTO users (ad_login, full_name, role, auth_type, local_password_hash)
              VALUES ('dvoynik', 'Локальный Двойник', 'it', 'local', 'хэш')`).run();
  ldap.addUser("dvoynik", { password: "п1", displayName: "Доменный Двойник", memberOf: [ldap.group(ADMIN_GROUP)] });

  const r = await войти(app, "dvoynik", "п1");
  assert.notStrictEqual(r.status, 200, "вход не должен пройти в чужую строку");
  const row = db.prepare("SELECT full_name, auth_type, is_admin FROM users WHERE ad_login = 'dvoynik'").get();
  assert.deepStrictEqual({ ...row }, { full_name: "Локальный Двойник", auth_type: "local", is_admin: 0 });
});

test("домен на экране входа угадывается по подсети клиента", async (t) => {
  const { app } = await stand(t);
  const r = await client(app.url).get("/api/auth/detect");
  assert.strictEqual(r.json.mode, "A");
  assert.strictEqual(r.json.ip, "127.0.0.1", "IPv4 за IPv6 (::ffff:) приводится к обычному виду");
});

test("подсети и адреса разбираются правильно", () => {
  const { cidrContains, normalizeIp, detectDomain } = require("../services/network");
  assert.strictEqual(cidrContains("10.148.12.0/22", "10.148.15.255"), true);
  assert.strictEqual(cidrContains("10.148.12.0/22", "10.148.16.0"), false);
  assert.strictEqual(cidrContains("192.168.254.0/23", "192.168.255.7"), true);
  assert.strictEqual(cidrContains("0.0.0.0/0", "8.8.8.8"), true);
  assert.strictEqual(cidrContains("10.0.0.0/8", "не адрес"), false);
  assert.strictEqual(cidrContains("", "10.0.0.1"), false);
  assert.strictEqual(normalizeIp("::ffff:10.1.2.3"), "10.1.2.3");
  assert.strictEqual(normalizeIp("::1"), "127.0.0.1");
  const cfg = { network: { domainACidr: "10.148.12.0/22", domainBCidr: "192.168.254.0/23" } };
  assert.strictEqual(detectDomain("::ffff:192.168.254.10", cfg), "B");
  assert.strictEqual(detectDomain("172.16.0.1", cfg), null);
});

test("у домена может быть несколько подсетей и отдельные адреса — для клиентов за прокси", () => {
  const { parseCidrList, detectDomain } = require("../services/network");
  assert.deepStrictEqual(
    parseCidrList(" 192.168.254.0/23, 10.148.130.87;10.0.0.1 "),
    ["192.168.254.0/23", "10.148.130.87/32", "10.0.0.1/32"],
    "разделители — запятая, пробел, точка с запятой; адрес без маски — один адрес"
  );
  assert.deepStrictEqual(parseCidrList(""), []);
  assert.deepStrictEqual(parseCidrList(undefined), []);

  // Прокси выходит к платформе с адреса вне обеих подсетей.
  const cfg = { network: { domainACidr: "10.148.12.0/22", domainBCidr: "192.168.254.0/23, 10.148.130.87" } };
  assert.strictEqual(detectDomain("10.148.130.87", cfg), "B", "адрес прокси записан домену B");
  assert.strictEqual(detectDomain("10.148.130.88", cfg), null, "соседний адрес — не прокси");
  assert.strictEqual(detectDomain("10.148.13.5", cfg), "A");
  assert.strictEqual(detectDomain("192.168.255.102", cfg), "B");

  // Адрес прокси лежит внутри подсети другого домена: узкая запись важнее широкой.
  const wide = { network: { domainACidr: "10.148.0.0/16", domainBCidr: "192.168.254.0/23 10.148.130.87" } };
  assert.strictEqual(detectDomain("10.148.130.87", wide), "B");
  assert.strictEqual(detectDomain("10.148.130.210", wide), "A");

  // Одинаковая запись у обоих доменов — домен A, как и до списков.
  const same = { network: { domainACidr: "10.0.0.0/8", domainBCidr: "10.0.0.0/8" } };
  assert.strictEqual(detectDomain("10.1.2.3", same), "A");

  // Опечатка в одной записи не выключает остальные.
  const typo = { network: { domainACidr: "", domainBCidr: "192.168.254.0/23, 10.148.130/32, 10.148.130.87" } };
  assert.strictEqual(detectDomain("10.148.130.87", typo), "B");
});

test("все группы из домена запоминаются по имени и пересчитываются при входе — для общего ящика рассылок", async (t) => {
  const { db, app } = await stand(t);
  const { userInGroup } = require("../services/userStore");
  ldap.addUser("rassylkin", {
    password: "пароль-1", displayName: "Рассылкин Тест Тестович",
    memberOf: [ldap.group("Рассылка-Респондентам"), ldap.group("Иванов\\, Отдел цен")],
  });
  assert.strictEqual((await войти(app, "rassylkin", "пароль-1")).status, 200);
  const id = db.prepare("SELECT id FROM users WHERE ad_login = 'rassylkin'").get().id;
  assert.ok(userInGroup(db, id, "рассылка-респондентам"), "регистр не важен");
  assert.ok(userInGroup(db, id, "Иванов, Отдел цен"), "запятая в имени группы");
  assert.ok(!userInGroup(db, id, "Рассылка"), "подстрока — не членство");
  assert.ok(!userInGroup(db, id, ""));

  // Вышел из группы в домене — на следующем входе доступ пропал.
  ldap.addUser("rassylkin", { password: "пароль-1", displayName: "Рассылкин Тест Тестович", memberOf: [] });
  await войти(app, "rassylkin", "пароль-1");
  assert.ok(!userInGroup(db, id, "Рассылка-Респондентам"));
});
