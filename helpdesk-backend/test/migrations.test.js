'use strict';

require("./helpers/isolateEnv");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { tempDir, resetModuleCache } = require("./helpers/tempDb");

// ============================================================================
//  Обновление структуры базы — всё или ничего
//
//  Схема и миграции выполняются одной транзакцией. Проверяем на базе «прежней
//  версии»: у users ещё нет is_admin и roles, а последний шаг обновления
//  срывается. После сбоя в базе не должно остаться ни одного изменения — ни
//  добавленных колонок, ни перенесённых данных, ни отметок, — а следующий
//  запуск без помехи должен пройти целиком.
// ============================================================================

function oldDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ad_login TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      department TEXT, email TEXT, phone TEXT,
      role TEXT NOT NULL DEFAULT 'user'
    );
    INSERT INTO users (ad_login, full_name, role) VALUES ('ispolnitel', 'Исполнитель Старый', 'it');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

function initWith(file) {
  process.env.DB_PATH = file;
  resetModuleCache();
  return require("../db/init").initDb();
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

test("сбой на последнем шаге обновления откатывает все шаги", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "old.db");

  // Помеха: последний шаг (перенос уведомлений) ставит отметку в settings — её и срываем.
  const prep = oldDatabase(file);
  prep.exec(`CREATE TRIGGER сорвать BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'помеха из теста'); END;`);
  prep.close();

  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    assert.throws(() => initWith(file), /помеха из теста/);
  } finally {
    console.error = origError;
  }

  const after = new DatabaseSync(file);
  try {
    assert.deepStrictEqual(columns(after, "users").filter((c) => c === "is_admin" || c === "roles"), [],
      "колонки, добавленные первыми шагами, должны откатиться");
    const tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    assert.ok(!tables.includes("tickets"), "таблицы из схемы тоже не должны остаться");
    assert.strictEqual(after.prepare("SELECT COUNT(*) AS n FROM settings").get().n, 0);

    assert.ok(errors.some((e) => /отменено целиком/.test(e)), "в журнале — что обновление отменено целиком");

    // Помеху убрали — следующий запуск проходит целиком и переносит данные.
    after.exec("DROP TRIGGER сорвать");
  } finally {
    after.close();
  }
  const db = initWith(file);
  try {
    assert.ok(columns(db, "users").includes("is_admin") && columns(db, "users").includes("roles"));
    assert.strictEqual(db.prepare("SELECT roles FROM users WHERE ad_login = 'ispolnitel'").get().roles, ",it,");
    assert.ok(db.prepare("SELECT value FROM settings WHERE key = 'notifications_migrated_v2'").get());
  } finally {
    db.close();
  }
});

test("свежая база по-прежнему создаётся, повторный запуск ничего не ломает", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "new.db");
  initWith(file).close();
  const db = initWith(file);
  try {
    assert.ok(columns(db, "tickets").length > 0);
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM categories").get().n > 0);
  } finally {
    db.close();
  }
});

test("общий ящик рассылок из прежних настроек переезжает в список ящиков вместе с паролем и группой", () => {
  const { freshDb, resetModuleCache } = require("./helpers/tempDb");
  const { db, cleanup } = freshDb();
  try {
    const set = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    set.run("mail_from", "rassylka@example.invalid");
    set.run("mail_password", "пароль-приложения");
    set.run("mail_shared_group", "Рассылка-Цены");
    set.run("mail_user", "rassylka");
    const uid = db.prepare("INSERT INTO users (ad_login, full_name) VALUES ('u', 'Тестов Т.Т.')").run().lastInsertRowid;
    db.prepare("INSERT INTO mail_campaigns (created_by, subject, body, sender_mode, sender_address, status) VALUES (?, 'Т', 'Б', 'shared', 'rassylka@example.invalid', 'paused')").run(uid);
    db.close();

    resetModuleCache();
    const db2 = require("../db/init").initDb();
    const box = db2.prepare("SELECT * FROM mail_boxes").get();
    assert.deepStrictEqual([box.address, box.password, box.ad_group], ["rassylka@example.invalid", "пароль-приложения", "Рассылка-Цены"]);
    assert.strictEqual(db2.prepare("SELECT mailbox_id FROM mail_campaigns").get().mailbox_id, box.id, "идущая рассылка знает свой ящик");
    assert.strictEqual(db2.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'mail_from' OR key LIKE 'mail_password' OR key LIKE 'mail_user' OR key LIKE 'mail_shared_group'").get().n, 0);
    db2.close();
    // Повторный запуск ничего не дублирует.
    resetModuleCache();
    const db3 = require("../db/init").initDb();
    assert.strictEqual(db3.prepare("SELECT COUNT(*) AS n FROM mail_boxes").get().n, 1);
    db3.close();
  } finally {
    cleanup();
  }
});

test("таблицы убранных разделов Ассистента удаляются при запуске, подписанты «заместитель» и «начальник ОИРиТ» — тоже", () => {
  const { freshDb, resetModuleCache } = require("./helpers/tempDb");
  const { db, cleanup } = freshDb();
  try {
    for (const t of ["asst_journal", "asst_transfers", "asst_links", "asst_equipment", "asst_parts"]) db.exec(`CREATE TABLE ${t} (id INTEGER)`);
    db.prepare("INSERT INTO settings (key, value) VALUES ('asst_equipment_imported_at', 'x'), ('asst_org_name', 'Липецкстат')").run();
    db.prepare("INSERT INTO asst_people (role, name) VALUES ('it_chief', 'Тестов Т.Т.'), ('deputy', 'Замов З.З.'), ('boss', 'Главный Г.Г.')").run();
    db.close();
    resetModuleCache();
    const db2 = require("../db/init").initDb();
    const tables = db2.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    for (const t of ["asst_journal", "asst_transfers", "asst_links", "asst_equipment", "asst_parts"]) assert.ok(!tables.includes(t), t);
    assert.deepStrictEqual(db2.prepare("SELECT key FROM settings WHERE key LIKE 'asst_%'").all().map((r) => r.key), ["asst_org_name"]);
    assert.deepStrictEqual(db2.prepare("SELECT role FROM asst_people").all().map((r) => r.role), ["boss"]);
    db2.close();
  } finally {
    cleanup();
  }
});
