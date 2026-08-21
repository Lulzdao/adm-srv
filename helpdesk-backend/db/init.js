const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcrypt");
const config = require("../config/config");
const departments = require("../config/departments");

// Используем встроенный node:sqlite (доступен без установки, начиная с Node 22.5+,
// стабилен в Node 24) вместо better-sqlite3 — это нативный C++-модуль, который
// требует либо готовый бинарник под конкретную версию Node/ОС, либо компиляцию
// на месте (node-gyp + инструменты сборки), что на закрытой сети без интернета
// не соберётся. node:sqlite — часть самого Node.js, дополнительно собирать нечего.
function initDb() {
  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(config.dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);

  // Отделы — из единого конфига, не из статичного SQL. Добавили новый
  // отдел в config/departments.js — при следующем старте сервера здесь
  // появится соответствующая строка, руками ничего создавать не нужно.
  for (const dept of departments) {
    db.prepare("INSERT OR IGNORE INTO categories (name) VALUES (?)").run(dept.name);
  }

  return db;
}

// Посев локальных аварийных аккаунтов ("break glass"), на случай если оба
// домена недоступны. Пароли задаются заранее через
// scripts/set-local-admin-password.js и хранятся только как bcrypt-хэш.
function ensureLocalAccounts(db) {
  for (const acc of config.localAccounts) {
    if (!acc.passwordHash) continue;
    const existing = db.prepare("SELECT id FROM users WHERE ad_login = ?").get(acc.login);
    if (existing) continue;

    db.prepare(
      `INSERT INTO users (ad_login, full_name, role, auth_type, local_password_hash)
       VALUES (?, ?, ?, 'local', ?)`
    ).run(acc.login, acc.fullName, acc.role, acc.passwordHash);

    console.log(`Создан локальный аккаунт: ${acc.login} (роль: ${acc.role})`);
  }
}

if (require.main === module) {
  const db = initDb();
  ensureLocalAccounts(db);
  console.log(`База данных готова: ${config.dbPath}`);
  db.close();
}

module.exports = { initDb, ensureLocalAccounts };
