'use strict';

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ============================================================================
//  Временная база под один тест
//
//  node:sqlite синхронный и работает с файлом, поэтому «база в памяти» тут не
//  выйдет: db/init.js читает путь из конфига и создаёт каталог. Заводим файл во
//  временной папке и сносим её после теста — так тесты не мешают друг другу и
//  не трогают рабочую data/helpdesk.db.
//
//  Важно: config/config.js читает process.env ОДИН раз при первом require, а
//  db/init.js берёт путь оттуда же. Поэтому переменную выставляем ДО загрузки
//  модулей — этим занимается freshDb().
// ============================================================================

function tempDir(prefix = "adm-srv-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Свежая инициализированная база платформы.
 * Возвращает { db, dir, cleanup } — cleanup обязательно звать в t.after().
 */
function freshDb() {
  const dir = tempDir();
  const dbPath = path.join(dir, "test.db");
  process.env.DB_PATH = dbPath;

  resetModuleCache();

  const { initDb } = require("../../db/init");
  const db = initDb();

  return {
    db,
    dir,
    cleanup() {
      try { db.close(); } catch { /* уже закрыта — не повод падать в t.after */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Пользователь с выдуманными данными. Настоящих в тестах быть не должно. */
function makeUser(db, { login, name, role = "user", email = null }) {
  const info = db.prepare(
    "INSERT INTO users (ad_login, full_name, role, email, auth_type) VALUES (?, ?, ?, ?, 'ad')"
  ).run(login, name, role, email);
  return Number(info.lastInsertRowid);
}

/** Заявка в указанном отделе. Возвращает id. */
function makeTicket(db, { displayId, title, department = "ИТ", createdBy, room = "212", priority = "medium" }) {
  const cat = db.prepare("SELECT id FROM categories WHERE name = ?").get(department);
  const info = db.prepare(`
    INSERT INTO tickets (display_id, title, category_id, priority, room, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(displayId, title, cat.id, priority, room, createdBy);
  return Number(info.lastInsertRowid);
}

/**
 * Сбросить загруженные модули проекта.
 *
 * config/config.js и config/modules.js читают process.env ОДИН раз, при первой
 * загрузке. Без сброса второй тест в том же процессе получил бы базу и адреса
 * модулей от первого — и падал бы через раз, в зависимости от порядка файлов.
 * Чужие модули (node_modules) не трогаем: перезагружать nodemailer незачем,
 * а некоторые пакеты этого и не переживут.
 */
function resetModuleCache() {
  const root = path.resolve(__dirname, "..", "..");
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(root) && !key.includes("node_modules")) delete require.cache[key];
  }
}

module.exports = { freshDb, tempDir, makeUser, makeTicket, resetModuleCache };
