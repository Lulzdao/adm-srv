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
