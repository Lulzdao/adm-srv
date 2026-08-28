'use strict';

const test = require("node:test");
const assert = require("node:assert/strict");

const { freshDb } = require("./helpers/tempDb");

// ============================================================================
//  Локальные аварийные учётные записи
//
//  Их смысл — работать, когда домен недоступен. Значит и всё, что у доменных
//  учёток приезжает из LDAP, у этих должно браться откуда-то ещё. Почта —
//  ровно такой случай: без неё кнопка «Проверить и отправить себе» в разделе
//  «Оповещения» упиралась в «не заполнен адрес в домене», хотя искать в домене
//  тут нечего.
// ============================================================================

/** Поднять базу с заданными переменными окружения для локальных учёток. */
function withLocalAccounts(t, env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const { db, cleanup } = freshDb();   // сбрасывает кэш модулей — переменные подхватятся
  t.after(cleanup);
  const { ensureLocalAccounts } = require("../db/init");
  return { db, ensureLocalAccounts };
}

const emailOf = (db, login) =>
  (db.prepare("SELECT email FROM users WHERE ad_login = ?").get(login) || {}).email;

test("администратору проставляется адрес по умолчанию", (t) => {
  const { db, ensureLocalAccounts } = withLocalAccounts(t, {
    LOCAL_ADMIN_PASSWORD_HASH: "$2b$10$нехэшнотестусойдёт",
    LOCAL_ADMIN_EMAIL: undefined,
  });
  ensureLocalAccounts(db);
  assert.equal(emailOf(db, "!admin"), "48.11@rosstat.gov.ru");
});

test("адрес переопределяется переменной окружения", (t) => {
  const { db, ensureLocalAccounts } = withLocalAccounts(t, {
    LOCAL_ADMIN_PASSWORD_HASH: "$2b$10$нехэшнотестусойдёт",
    LOCAL_ADMIN_EMAIL: "drugoy@example.test",
  });
  ensureLocalAccounts(db);
  assert.equal(emailOf(db, "!admin"), "drugoy@example.test");
});

test("адрес досыпается в УЖЕ СУЩЕСТВУЮЩУЮ запись без него", (t) => {
  // Ровно то, что происходит на работающем сервере: учётка заведена давно,
  // когда адреса у неё не было, и пересоздавать её никто не станет.
  const { db, ensureLocalAccounts } = withLocalAccounts(t, {
    LOCAL_ADMIN_PASSWORD_HASH: "$2b$10$нехэшнотестусойдёт",
    LOCAL_ADMIN_EMAIL: undefined,
  });
  db.prepare(
    "INSERT INTO users (ad_login, full_name, role, auth_type, local_password_hash) VALUES ('!admin','Локальный администратор','it','local','x')"
  ).run();
  assert.equal(emailOf(db, "!admin"), null, "исходно адреса нет");

  ensureLocalAccounts(db);
  assert.equal(emailOf(db, "!admin"), "48.11@rosstat.gov.ru");
});

test("повторный запуск ничего не ломает и не плодит учёток", (t) => {
  const { db, ensureLocalAccounts } = withLocalAccounts(t, {
    LOCAL_ADMIN_PASSWORD_HASH: "$2b$10$нехэшнотестусойдёт",
    LOCAL_ADMIN_EMAIL: undefined,
  });
  ensureLocalAccounts(db);
  ensureLocalAccounts(db);
  ensureLocalAccounts(db);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE ad_login = '!admin'").get().c, 1);
  assert.equal(emailOf(db, "!admin"), "48.11@rosstat.gov.ru");
});

test("изменение переменной догоняет уже заведённую учётку", (t) => {
  // Источник истины для локальной учётки — настройки сервера, а не база:
  // менять адрес из интерфейса нельзя, значит и затирать нечего.
  const { db, ensureLocalAccounts } = withLocalAccounts(t, {
    LOCAL_ADMIN_PASSWORD_HASH: "$2b$10$нехэшнотестусойдёт",
    LOCAL_ADMIN_EMAIL: "pervyy@example.test",
  });
  ensureLocalAccounts(db);
  assert.equal(emailOf(db, "!admin"), "pervyy@example.test");

  // Меняем переменную и перечитываем конфиг — как при перезапуске сервера.
  process.env.LOCAL_ADMIN_EMAIL = "vtoroy@example.test";
  delete require.cache[require.resolve("../config/config")];
  delete require.cache[require.resolve("../db/init")];
  require("../db/init").ensureLocalAccounts(db);
  assert.equal(emailOf(db, "!admin"), "vtoroy@example.test");
});

test("общая аварийная учётка по умолчанию остаётся без адреса", (t) => {
  // Письма о её заявках никуда не уходят, и это осознанно: учётка общая,
  // отправлять оповещения по ней в ящик ИТ никто не просил.
  const { db, ensureLocalAccounts } = withLocalAccounts(t, {
    LOCAL_USER_PASSWORD_HASH: "$2b$10$нехэшнотестусойдёт",
    LOCAL_USER_EMAIL: undefined,
  });
  ensureLocalAccounts(db);
  assert.equal(emailOf(db, "!user"), null);
});

test("без пароля учётка не создаётся вовсе", (t) => {
  const { db, ensureLocalAccounts } = withLocalAccounts(t, {
    LOCAL_ADMIN_PASSWORD_HASH: "",
    LOCAL_USER_PASSWORD_HASH: "",
  });
  ensureLocalAccounts(db);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users").get().c, 0);
});
