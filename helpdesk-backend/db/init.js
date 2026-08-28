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

  migrateNotifications(db);

  return db;
}

// Перенос из старой таблицы notifications в пару events/deliveries.
//
// Старая таблица хранила по строке на КАЖДОГО получателя и требовала
// ticket_id NOT NULL — из-за этого одно событие размножалось по списку, а
// оповещению про сертификат было нечего туда положить. Новая модель разносит
// факт и доставку, поэтому переносим со сборкой: одинаковые строки (та же
// заявка, тот же тип, то же время) складываются в одно событие с несколькими
// отметками.
//
// Выполняется один раз, отметка — в settings. Старую таблицу не удаляем: она
// маленькая, а спокойнее знать, что исходные строки на месте.
function migrateNotifications(db) {
  const { getSetting, setSetting } = require("../services/settings");
  const FLAG = "notifications_migrated_v2";
  if (getSetting(db, FLAG)) return;

  const old = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notifications'").get();
  if (!old) { setSetting(db, FLAG, new Date().toISOString()); return; }

  const rows = db.prepare(`
    SELECT n.user_id, n.ticket_id, n.type, n.is_read, n.created_at, c.name AS category
    FROM notifications n
    LEFT JOIN tickets t ON t.id = n.ticket_id
    LEFT JOIN categories c ON c.id = t.category_id
    ORDER BY n.id
  `).all();

  if (rows.length) {
    const roleOf = Object.fromEntries(departments.map((d) => [d.name, d.role]));
    // Направление комментария задним числом не восстановить — в старой таблице
    // его не было. Считаем ответом исполнителя: так выглядело большинство.
    const kindOf = (r) => ({
      new_ticket: `ticket_new:${roleOf[r.category] || "it"}`,
      status_changed: "ticket_status",
      new_comment: "ticket_comment_out",
    }[r.type] || "ticket_status");

    const insertEvent = db.prepare(`
      INSERT INTO notification_events (kind, source, subject, ticket_id, dedup_key, severity, payload, created_at)
      VALUES (?, 'helpdesk', ?, ?, ?, 'info', '{}', ?)
      ON CONFLICT(dedup_key) DO NOTHING
    `);
    const findEvent = db.prepare("SELECT id FROM notification_events WHERE dedup_key = ?");
    const insertDelivery = db.prepare(
      "INSERT INTO notification_deliveries (event_id, channel, user_id, status, is_read, created_at) VALUES (?, 'inapp', ?, 'sent', ?, ?)"
    );

    let events = 0;
    for (const r of rows) {
      const key = `legacy:${r.ticket_id}:${r.type}:${r.created_at}`;
      const info = insertEvent.run(kindOf(r), "", r.ticket_id, key, r.created_at);
      if (info.changes) events++;
      const ev = findEvent.get(key);
      if (ev) insertDelivery.run(ev.id, r.user_id, r.is_read ? 1 : 0, r.created_at);
    }
    console.log(`Перенесено уведомлений: ${rows.length} строк -> ${events} событий`);
  }

  setSetting(db, FLAG, new Date().toISOString());
}

// Посев локальных аварийных аккаунтов ("break glass"), на случай если оба
// домена недоступны. Пароли задаются заранее через
// scripts/set-local-admin-password.js и хранятся только как bcrypt-хэш.
function ensureLocalAccounts(db) {
  for (const acc of config.localAccounts) {
    if (!acc.passwordHash) continue;
    const existing = db.prepare("SELECT id, email FROM users WHERE ad_login = ?").get(acc.login);

    if (existing) {
      // Адрес держим в согласии с конфигом на каждом старте. У доменных учёток
      // источник истины — LDAP, у локальных его нет, поэтому источник истины
      // здесь один: config/config.js. Правит его только тот, кто и так правит
      // .env на сервере, а из интерфейса адрес локальной учётки не меняется —
      // значит затирать нечего.
      const want = acc.email || null;
      if ((existing.email || null) !== want) {
        db.prepare("UPDATE users SET email = ? WHERE id = ?").run(want, existing.id);
        console.log(`Локальному аккаунту ${acc.login} проставлен адрес: ${want || "(пусто)"}`);
      }
      continue;
    }

    db.prepare(
      `INSERT INTO users (ad_login, full_name, role, email, auth_type, local_password_hash)
       VALUES (?, ?, ?, ?, 'local', ?)`
    ).run(acc.login, acc.fullName, acc.role, acc.email || null, acc.passwordHash);

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
