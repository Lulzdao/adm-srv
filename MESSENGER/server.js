// Мини-мессенджер для организации — сервер на Node.js
// Стек: Express (HTTP+статика) + ws (реалтайм) + better-sqlite3 (хранилище) + JWT (авторизация)
//
// ВАЖНО: это единственный рабочий сервер проекта. Раньше в desktop-client/ лежала ещё одна копия
// этого файла (более новая, с поддержкой файлов) — именно поэтому загрузка файлов не работала:
// `npm start` всегда запускал ЭТОТ файл, а фича была только в неиспользуемой копии. Больше так не
// делайте — правьте только этот файл, копии в desktop-client/ не существует.

const express = require('express');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const PORT = process.env.PORT || 3000;
const IDLE_AFTER_MS = 30 * 60 * 1000; // 30 минут бездействия = AFK (страховка на стороне сервера)

// ---------- Логирование ----------
// Простой файловый логгер без внешних зависимостей — для 20-200 человек в локальной сети выделенный
// пакет (winston/pino) избыточен. Ротация "по дню" через имя файла: logs/server-YYYY-MM-DD.log —
// входы/выходы, срабатывания rate-limit, ошибки сервера; logs/client-YYYY-MM-DD.log — ошибки с
// рабочих мест сотрудников (см. POST /api/client-log ниже), чтобы разбирать инциденты по логам на
// сервере, а не просить каждого прислать скриншот или лезть к нему на ПК за файлом. Обе записи
// дублируются в консоль, как и раньше (console.log/warn при старте никуда не делись).
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);
function dayStamp(d = new Date()) { return d.toISOString().slice(0, 10); }
function writeLogLine(file, line) {
  // Запись лога не должна блокировать ответ на реальный запрос и не должна валить процесс, если
  // диск временно недоступен — поэтому асинхронно и без ожидания/обработки результата.
  fs.appendFile(path.join(logsDir, file), line + '\n', () => {});
}
function logServer(level, event, meta = {}) {
  const line = `${new Date().toISOString()} [${level}] ${event} ${JSON.stringify(meta)}`;
  writeLogLine(`server-${dayStamp()}.log`, line);
  (level === 'ERROR' ? console.error : console.log)(line);
}
function logClient(entry) {
  const line = `${new Date().toISOString()} [CLIENT] ${JSON.stringify(entry)}`;
  writeLogLine(`client-${dayStamp()}.log`, line);
  console.error(line); // ошибка на чьём-то рабочем месте — сразу видно и в консоли сервера, не только в файле
}
// Иначе процесс просто молча падает без единой строки в наших логах — эти два обработчика есть
// почти в любом node-сервисе, который планируют эксплуатировать всерьёз, а не только на своей машине.
process.on('uncaughtException', (err) => {
  logServer('ERROR', 'uncaught_exception', { message: err.message, stack: err.stack });
  process.exit(1); // состояние после неперехваченного исключения не гарантированно консистентно
});
process.on('unhandledRejection', (reason) => {
  logServer('ERROR', 'unhandled_rejection', { reason: reason instanceof Error ? reason.stack : String(reason) });
});

// ---------- База данных ----------
const db = new Database(path.join(__dirname, 'messenger.db'));
db.pragma('journal_mode = WAL');
// SQLite lower() по умолчанию не понимает кириллицу (только ASCII) — регистронезависимый поиск
// по-русски без этой функции не работал бы ("Отчёт" не совпадёт с "отчёт"). JS-овский toLowerCase()
// работает с юникодом корректно.
db.function('lower_ru', (s) => String(s).toLowerCase());
db.exec(`
  CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'employee',
    department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL,
    room TEXT,          -- заполнено для групповых сообщений (например 'general')
    to_id INTEGER,       -- заполнено для личных сообщений
    text TEXT NOT NULL,
    file_url TEXT,
    file_name TEXT,
    file_size INTEGER,
    files_json TEXT,     -- несколько файлов в одном сообщении: JSON-массив [{url,name,size}, ...]
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    files_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  -- Реакции — по одной эмодзи на пользователя на сообщение (как в Telegram): повторный клик по
  -- той же эмодзи снимает реакцию, по другой — заменяет (см. ON CONFLICT в upsertReaction ниже).
  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );
  -- Именованные группы поверх личных сообщений и одной общей комнаты — переписка группы хранится
  -- в messages.room тем же способом, что и общая комната (см. комментарий у колонки room выше),
  -- просто под значением 'group:<id>' вместо 'general' — это даром переиспользует ВСЮ существующую
  -- SQL-инфраструктуру комнатной истории (поиск/пагинация/дни), не заводя отдельных таблиц под неё.
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );
`);

// Миграция на случай, если у кого-то уже есть база без колонок для файлов
{
  const cols = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
  if (!cols.includes('file_url')) db.exec('ALTER TABLE messages ADD COLUMN file_url TEXT');
  if (!cols.includes('file_name')) db.exec('ALTER TABLE messages ADD COLUMN file_name TEXT');
  if (!cols.includes('file_size')) db.exec('ALTER TABLE messages ADD COLUMN file_size INTEGER');
  if (!cols.includes('files_json')) db.exec('ALTER TABLE messages ADD COLUMN files_json TEXT');
  // Отметка о прочтении — только для личных сообщений (to_id заполнен); для сообщений в общей
  // комнате остаётся NULL и не используется (галочки прочтения там неоднозначны — читателей много).
  if (!cols.includes('read_at')) db.exec('ALTER TABLE messages ADD COLUMN read_at INTEGER');
  // Ответ на сообщение (reply) — reply_snapshot хранит ИМЯ И ТЕКСТ оригинала на момент ответа
  // отдельно от reply_to_id (сам id, для клика "перейти к сообщению"), а не только id: то, на что
  // ответили, могло быть очень старым и не попасть в текущую загруженную страницу истории (см.
  // пагинацию выше) — цитата не должна ломаться из-за этого и требовать отдельного похода за
  // оригиналом. Снимок делает сервер (не клиент) при отправке — источник истины один.
  if (!cols.includes('reply_to_id')) db.exec('ALTER TABLE messages ADD COLUMN reply_to_id INTEGER');
  if (!cols.includes('reply_snapshot')) db.exec('ALTER TABLE messages ADD COLUMN reply_snapshot TEXT');
}
{
  const cols = db.prepare("PRAGMA table_info(broadcasts)").all().map((c) => c.name);
  if (!cols.includes('files_json')) db.exec('ALTER TABLE broadcasts ADD COLUMN files_json TEXT');
}

// Права — два независимых флага прямо на пользователе: can_broadcast (может рассылать всем) и
// can_admin (доступ к веб-панели). Раздаются только персонально, не на отдел — так исключений и
// путаницы "откуда у меня это право" меньше, чем при наследовании от отдела. Раньше тут была
// отдельная таблица "ролей" с ключами — отказались от неё в пользу более прямой модели.
{
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!cols.includes('can_broadcast')) db.exec('ALTER TABLE users ADD COLUMN can_broadcast INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('can_admin')) db.exec('ALTER TABLE users ADD COLUMN can_admin INTEGER NOT NULL DEFAULT 0');
  // Счётчик версии строки — для оптимистичной блокировки при редактировании в админ-панели (см.
  // PATCH /api/admin/users/:id): если два администратора одновременно открыли карточку одного и
  // того же человека, второй сохранённый PATCH не должен молча затирать правки первого.
  if (!cols.includes('version')) db.exec('ALTER TABLE users ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
}
{
  // can_broadcast/can_admin у отделов больше не используются (раньше отдел мог выдавать права всем
  // своим сотрудникам разом) — колонки оставлены в схеме только чтобы не ломать базы, где они уже
  // есть с прошлой версии; заполнять их через API больше нельзя.
  const cols = db.prepare("PRAGMA table_info(departments)").all().map((c) => c.name);
  if (!cols.includes('can_broadcast')) db.exec('ALTER TABLE departments ADD COLUMN can_broadcast INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('can_admin')) db.exec('ALTER TABLE departments ADD COLUMN can_admin INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('sort_order')) db.exec('ALTER TABLE departments ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
}


// Однократный перенос прав из старой системы "ролей" (если она у кого-то ещё есть в базе с
// прошлой версии сервера) в новые прямые флаги — чтобы при обновлении никто не потерял доступ
// к админке или рассылкам. После переноса таблица ролей больше не нужна и удаляется.
{
  const migrated = getSettingRaw('migrated_caps_from_roles');
  if (!migrated) {
    const rolesTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='roles'").get();
    if (rolesTableExists) {
      const roles = new Map(db.prepare('SELECT * FROM roles').all().map((r) => [r.key, r]));
      const users = db.prepare('SELECT id, role FROM users').all();
      const migrateCaps = db.prepare('UPDATE users SET can_broadcast=?, can_admin=? WHERE id=?');
      for (const u of users) {
        const r = roles.get(u.role);
        if (r) migrateCaps.run(r.can_broadcast, r.can_admin, u.id);
      }
      db.exec('DROP TABLE IF EXISTS roles');
    }
    setSettingRaw('migrated_caps_from_roles', '1');
  }
}
function getSettingRaw(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSettingRaw(key, value) {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// Старые сообщения хранили один файл в отдельных колонках (file_url/file_name/file_size), новые —
// произвольное количество файлов в files_json. Приводим и то, и другое к единому виду files[].
// Админ может удалить файл с диска через веб-панель, не трогая саму историю переписки (см.
// DELETE /api/admin/files/:diskName ниже) — сообщение остаётся, но ссылка в нём мертва. exists
// помечает такие файлы, чтобы клиент показал "файл удалён", а не сломанную/вечно грузящуюся карточку.
function normalizeRow(row) {
  if (!row) return row;
  const { file_url, file_name, file_size, files_json, reply_to_id, reply_snapshot, ...rest } = row;
  let files = [];
  if (files_json) {
    try { files = JSON.parse(files_json); } catch { files = []; }
  } else if (file_url) {
    files = [{ url: file_url, name: file_name, size: file_size }];
  }
  files = files.map((f) => ({ ...f, exists: fileExistsForUrl(f.url) }));
  // reply_to_id/reply_snapshot есть только у messages (не у broadcasts, для них оба всегда undefined
  // и reply останется null) — снимок текста/автора сделан сервером в момент ответа (см. миграцию
  // выше), поэтому цитата не зависит от того, загружена ли сейчас страница с самим оригиналом.
  let reply = null;
  if (reply_snapshot) {
    try { reply = { id: reply_to_id, ...JSON.parse(reply_snapshot) }; } catch { reply = null; }
  }
  return { ...rest, files, reply };
}
function fileExistsForUrl(url) {
  const diskName = String(url || '').split('/').pop();
  return !!diskName && fs.existsSync(path.join(uploadsDir, diskName));
}

// Реакции — отдельным батч-запросом по набору id (а не JOIN в каждый history-запрос: их SQL и
// так довольно длинный, а групповая агрегация через GROUP_CONCAT усложнила бы normalizeRow).
// json_each — встроенная в SQLite (JSON1, включён в бинарник better-sqlite3) функция "развернуть
// JSON-массив в строки", позволяет передать произвольный список id одним параметром.
const reactionsForMessages = db.prepare(`
  SELECT message_id, emoji, user_id FROM message_reactions WHERE message_id IN (SELECT value FROM json_each(?))
`);
function attachReactions(rows) {
  if (!rows.length) return rows;
  const byMsg = new Map();
  for (const r of reactionsForMessages.all(JSON.stringify(rows.map((r) => r.id)))) {
    if (!byMsg.has(r.message_id)) byMsg.set(r.message_id, new Map());
    const byEmoji = byMsg.get(r.message_id);
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
    byEmoji.get(r.emoji).push(r.user_id);
  }
  return rows.map((row) => ({
    ...row,
    reactions: byMsg.has(row.id) ? [...byMsg.get(row.id)].map(([emoji, userIds]) => ({ emoji, userIds })) : [],
  }));
}

const insertUser = db.prepare('INSERT INTO users (username, password_hash, display_name, can_broadcast, can_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)');
const getUserByName = db.prepare('SELECT * FROM users WHERE username = ?');
// Права регулируются только персонально — на пользователе, без наследования от отдела (раньше можно
// было выдать право сразу всему отделу; отказались от этого в пользу простоты — только "Пользователи").
const getUserById = db.prepare('SELECT id, username, display_name, department_id, can_broadcast, can_admin FROM users WHERE id = ?');
const countUsers = db.prepare('SELECT COUNT(*) AS c FROM users');
const listUsersFull = db.prepare(`
  SELECT u.id, u.username, u.display_name, u.department_id, u.can_broadcast, u.can_admin, u.version, d.name AS department
  FROM users u LEFT JOIN departments d ON d.id = u.department_id
  ORDER BY u.display_name
`);
const listUsersBasic = db.prepare(`
  SELECT u.id, u.username, u.display_name, d.name AS department
  FROM users u LEFT JOIN departments d ON d.id = u.department_id
  ORDER BY u.display_name
`);
const updateUserCaps = db.prepare('UPDATE users SET can_broadcast = ?, can_admin = ? WHERE id = ?');
const updateUserDept = db.prepare('UPDATE users SET department_id = ? WHERE id = ?');
const updateUserPassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
const updateDisplayName = db.prepare('UPDATE users SET display_name = ? WHERE id = ?');
const bumpUserVersion = db.prepare('UPDATE users SET version = version + 1 WHERE id = ?');
const deleteUserStmt = db.prepare('DELETE FROM users WHERE id = ?');

const listDepartments = db.prepare('SELECT * FROM departments ORDER BY sort_order, id');
const insertDepartment = db.prepare('INSERT INTO departments (name, sort_order) VALUES (?, ?)');
const updateDepartmentStmt = db.prepare('UPDATE departments SET name = ? WHERE id = ?');
const setDepartmentOrder = db.prepare('UPDATE departments SET sort_order = ? WHERE id = ?');
const deleteDepartmentStmt = db.prepare('DELETE FROM departments WHERE id = ?');

// ---------- Группы ----------
// room = 'group:<id>' (см. схему выше) — эти две функции — единственное место, где нужно знать
// формат строки, всё остальное работает с числовым groupId.
function isGroupRoom(room) { return typeof room === 'string' && room.startsWith('group:'); }
function groupIdFromRoom(room) { return Number(room.slice('group:'.length)); }

const insertGroup = db.prepare('INSERT INTO groups (name, created_by, created_at) VALUES (?, ?, ?)');
const getGroup = db.prepare('SELECT * FROM groups WHERE id = ?');
const renameGroupStmt = db.prepare('UPDATE groups SET name = ? WHERE id = ?');
const deleteGroupStmt = db.prepare('DELETE FROM groups WHERE id = ?');
const listGroupsForUser = db.prepare(`
  SELECT g.id, g.name, g.created_by, g.created_at
  FROM groups g JOIN group_members gm ON gm.group_id = g.id
  WHERE gm.user_id = ?
  ORDER BY g.name
`);
const listGroupMembers = db.prepare(`
  SELECT u.id, u.username, u.display_name
  FROM group_members gm JOIN users u ON u.id = gm.user_id
  WHERE gm.group_id = ? ORDER BY u.display_name
`);
const listGroupMemberIds = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?');
const isGroupMemberStmt = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?');
const addGroupMember = db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, added_at) VALUES (?, ?, ?)');
const removeGroupMember = db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?');
const deleteGroupMembersStmt = db.prepare('DELETE FROM group_members WHERE group_id = ?');
const countGroupMembers = db.prepare('SELECT COUNT(*) c FROM group_members WHERE group_id = ?');

function groupMemberIds(groupId) { return listGroupMemberIds.all(groupId).map((r) => r.user_id); }
// Управлять группой (переименовать, добавить/убрать участников, удалить) может тот, кто её создал,
// или любой администратор сайта — так группа не "осиротеет" безвозвратно, если создатель уйдёт из
// неё или уволится. Обычный участник может только написать в группу и сам из неё выйти.
function canManageGroup(user, group) { return group.created_by === user.id || !!user.can_admin; }

// Право проверяется по уже эффективному значению req.user, которое auth() перечитывает из базы
// на каждый запрос — смена права действует сразу, без перелогина.
function requireCapability(cap) {
  return (req, res, next) => {
    if (!req.user[cap]) return res.status(403).json({ error: 'Недостаточно прав' });
    next();
  };
}

const insertMessage = db.prepare('INSERT INTO messages (from_id, room, to_id, text, files_json, created_at, reply_to_id, reply_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const getMessageForReply = db.prepare('SELECT id, from_id, text FROM messages WHERE id = ?');
// Реакции — WS-обработчик 'react' ниже: чей маршрут (комната/личка) у сообщения, узнаём отдельным
// запросом, чтобы разослать обновление тем же адресатам, что и само сообщение.
const getMessageRoute = db.prepare('SELECT id, from_id, to_id, room FROM messages WHERE id = ?');
const getUserReactionOnMessage = db.prepare('SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?');
const deleteReaction = db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?');
const upsertReaction = db.prepare(`
  INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at
`);

// История комнаты: по умолчанию (без фильтров) — последние 200; с since/until — диапазон дат; с q — поиск по тексту
// before — курсор постраничной подгрузки (id сообщения, "строго раньше которого" искать): при первой
// загрузке клиент шлёт BEFORE_ID_MAX (см. ниже), дальше — id самого старого уже полученного сообщения.
// Если вернулась полная страница (HISTORY_PAGE_SIZE строк) — клиент считает, что дальше может быть
// ещё, и предлагает "Показать ещё"/подгружает при прокрутке вверх; иначе это был последний кусок.
const HISTORY_PAGE_SIZE = 200;
const roomHistoryAll = db.prepare(`
  SELECT m.id, m.text, m.created_at, m.from_id, m.file_url, m.file_name, m.file_size, m.files_json, m.reply_to_id, m.reply_snapshot, u.display_name AS from_user
  FROM messages m JOIN users u ON u.id = m.from_id
  WHERE m.room = ? AND m.id < ? ORDER BY m.id DESC LIMIT ${HISTORY_PAGE_SIZE}
`);
const roomHistoryRange = db.prepare(`
  SELECT m.id, m.text, m.created_at, m.from_id, m.file_url, m.file_name, m.file_size, m.files_json, m.reply_to_id, m.reply_snapshot, u.display_name AS from_user
  FROM messages m JOIN users u ON u.id = m.from_id
  WHERE m.room = ? AND m.created_at >= ? AND m.created_at < ? ORDER BY m.id ASC
`);
const roomHistorySearch = db.prepare(`
  SELECT m.id, m.text, m.created_at, m.from_id, m.file_url, m.file_name, m.file_size, m.files_json, m.reply_to_id, m.reply_snapshot, u.display_name AS from_user
  FROM messages m JOIN users u ON u.id = m.from_id
  WHERE m.room = ? AND m.id < ? AND lower_ru(m.text) LIKE '%' || lower_ru(?) || '%' ORDER BY m.id DESC LIMIT ${HISTORY_PAGE_SIZE}
`);
const roomHistoryDays = db.prepare(`
  SELECT strftime('%Y-%m-%d', datetime(m.created_at/1000, 'unixepoch', ?)) AS day, COUNT(*) AS count
  FROM messages m WHERE m.room = ? GROUP BY day ORDER BY day DESC
`);

const dmHistoryAll = db.prepare(`
  SELECT m.id, m.text, m.created_at, m.from_id, m.to_id, m.read_at, m.file_url, m.file_name, m.file_size, m.files_json, m.reply_to_id, m.reply_snapshot, u.display_name AS from_user
  FROM messages m JOIN users u ON u.id = m.from_id
  WHERE ((m.from_id = ? AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = ?)) AND m.id < ?
  ORDER BY m.id DESC LIMIT ${HISTORY_PAGE_SIZE}
`);
const dmHistoryRange = db.prepare(`
  SELECT m.id, m.text, m.created_at, m.from_id, m.to_id, m.read_at, m.file_url, m.file_name, m.file_size, m.files_json, m.reply_to_id, m.reply_snapshot, u.display_name AS from_user
  FROM messages m JOIN users u ON u.id = m.from_id
  WHERE ((m.from_id = ? AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = ?)) AND m.created_at >= ? AND m.created_at < ?
  ORDER BY m.id ASC
`);
const dmHistorySearch = db.prepare(`
  SELECT m.id, m.text, m.created_at, m.from_id, m.to_id, m.read_at, m.file_url, m.file_name, m.file_size, m.files_json, m.reply_to_id, m.reply_snapshot, u.display_name AS from_user
  FROM messages m JOIN users u ON u.id = m.from_id
  WHERE ((m.from_id = ? AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = ?)) AND m.id < ? AND lower_ru(m.text) LIKE '%' || lower_ru(?) || '%'
  ORDER BY m.id DESC LIMIT ${HISTORY_PAGE_SIZE}
`);
// Отмечаем прочитанными сообщения ОТ peer КО мне (to_id = я), полученные не позже upTo — тем же
// сигналом, что и разделитель "Новые сообщения" в чате (клик/скролл), а не просто открытием окна.
const markDmRead = db.prepare(`
  UPDATE messages SET read_at = ?
  WHERE from_id = ? AND to_id = ? AND read_at IS NULL AND created_at <= ?
`);
const unreadDmCounts = db.prepare(`
  SELECT from_id, COUNT(*) AS c FROM messages WHERE to_id = ? AND read_at IS NULL GROUP BY from_id
`);
const dmHistoryDays = db.prepare(`
  SELECT strftime('%Y-%m-%d', datetime(m.created_at/1000, 'unixepoch', ?)) AS day, COUNT(*) AS count
  FROM messages m WHERE (m.from_id = ? AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = ?) GROUP BY day ORDER BY day DESC
`);

const insertBroadcast = db.prepare('INSERT INTO broadcasts (from_id, text, files_json, created_at) VALUES (?, ?, ?, ?)');
const recentBroadcasts = db.prepare(`
  SELECT b.id, b.text, b.created_at, b.files_json, u.display_name AS from_user
  FROM broadcasts b JOIN users u ON u.id = b.from_id
  ORDER BY b.id DESC LIMIT 50
`);
// LIMIT 300 + вложенный DESC/ASC: без ограничения тяжёлый день (например, стресс-тест рассылок)
// отдавал бы клиенту весь день целиком — сотни DOM-узлов с карточками файлов в ленте окна рассылок
// ощутимо замедляют рендер на слабых машинах. Берём последние 300 (внутренний DESC), но отдаём в
// привычном хронологическом порядке (внешний ASC), чтобы клиент, как и раньше, не пересортировывал.
const broadcastsRange = db.prepare(`
  SELECT * FROM (
    SELECT b.id, b.text, b.created_at, b.files_json, u.display_name AS from_user
    FROM broadcasts b JOIN users u ON u.id = b.from_id
    WHERE b.created_at >= ? AND b.created_at < ? ORDER BY b.id DESC LIMIT 300
  ) ORDER BY id ASC
`);
const broadcastsSearch = db.prepare(`
  SELECT b.id, b.text, b.created_at, b.files_json, u.display_name AS from_user
  FROM broadcasts b JOIN users u ON u.id = b.from_id
  WHERE lower_ru(b.text) LIKE '%' || lower_ru(?) || '%' ORDER BY b.id DESC LIMIT 200
`);
const broadcastsDays = db.prepare(`
  SELECT strftime('%Y-%m-%d', datetime(b.created_at/1000, 'unixepoch', ?)) AS day, COUNT(*) AS count
  FROM broadcasts b GROUP BY day ORDER BY day DESC
`);
const messagesCount = db.prepare('SELECT COUNT(*) AS c FROM messages');
const departmentsCount = db.prepare('SELECT COUNT(*) AS c FROM departments');

// ---------- HTTP API ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Разрешаем запросы от десктоп-клиента (Electron грузит страницы с file://)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  // If-None-Match — для условных GET /api/users и /api/departments (см. ниже); без явного
  // разрешения браузер блокирует сам заголовок в запросе (не safelisted), а ETag в ответе —
  // без Expose-Headers JS не может прочитать его через response.headers.get('ETag'), даже
  // если заголовок реально пришёл по сети.
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-None-Match');
  res.header('Access-Control-Expose-Headers', 'ETag');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    const payload = jwt.verify(token, SECRET);
    const fresh = getUserById.get(payload.id); // роль всегда берём свежую из БД
    if (!fresh) return res.status(401).json({ error: 'Пользователь не найден' });
    req.user = fresh;
    next();
  } catch {
    res.status(401).json({ error: 'Не авторизован' });
  }
}

// ---------- Файлы ----------
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// Жёсткий потолок на express.raw() ниже — не то, что видит администратор в настройках, а абсолютная
// граница, которую body-parser никогда не превысит, даже если кто-то подделает Content-Length или
// настройка "макс. размер" из app_settings ещё не подгружена. Сам действующий лимит — динамический,
// хранится в app_settings (см. getUploadSettings) и меняется из веб-панели без перезапуска сервера.
const UPLOAD_HARD_CEILING_MB = 1024;
const DEFAULT_MAX_UPLOAD_MB = 50;
// Расширения, которые Windows исполняет одним двойным кликом (или через известный интерпретатор,
// как .ps1/.vbs/.js) — список по умолчанию для режима "запрещённые": для организационного
// мессенджера риск, что кто-то по ошибке (или обманом) запустит присланный "документ.exe",
// перевешивает удобство прислать исполняемый файл напрямую в переписке. Администратор может
// заменить и список, и режим (запрещённые/разрешённые) из веб-панели — см. /api/admin/upload-settings.
const DEFAULT_BLOCKED_EXTENSIONS = [
  'exe', 'bat', 'cmd', 'com', 'scr', 'msi', 'msp', 'msc',
  'ps1', 'ps1xml', 'psc1', 'psd1', 'psm1',
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'cpl', 'reg', 'lnk', 'inf', 'gadget', 'application', 'jar',
];
function getUploadSettings() {
  const mode = getSettingRaw('upload_ext_mode') === 'allow' ? 'allow' : 'block';
  const extRaw = getSettingRaw('upload_ext_list');
  const extensions = extRaw !== null
    ? extRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_BLOCKED_EXTENSIONS.slice();
  const maxMb = Math.min(Number(getSettingRaw('upload_max_mb')) || DEFAULT_MAX_UPLOAD_MB, UPLOAD_HARD_CEILING_MB);
  return { mode, extensions, maxMb };
}
function isUploadAllowed(name, settings) {
  const ext = String(name).split('.').pop().toLowerCase();
  const inList = settings.extensions.includes(ext);
  return settings.mode === 'allow' ? inList : !inList;
}

app.post('/api/upload', auth, (req, res, next) => {
  // Проверяем тип и объявленный размер ДО чтения тела запроса (имя файла и Content-Length уже
  // известны на этом этапе) — так запрещённый или слишком большой файл не занимает лишний трафик
  // и не оседает в памяти сервера зря. req._uploadMaxBytes прокидываем дальше на случай, если
  // Content-Length отсутствовал и финальную проверку придётся делать уже по факту принятого тела.
  const settings = getUploadSettings();
  req._uploadMaxBytes = settings.maxMb * 1024 * 1024;
  if (!isUploadAllowed(String(req.query.name || ''), settings)) {
    logServer('WARN', 'upload_blocked', { name: req.query.name, userId: req.user.id, ip: req.ip });
    return res.status(415).json({ error: 'Такой тип файла запрещён к отправке администратором' });
  }
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength && declaredLength > req._uploadMaxBytes) {
    return res.status(413).json({ error: `Файл больше ${settings.maxMb} МБ` });
  }
  next();
}, express.raw({ limit: `${UPLOAD_HARD_CEILING_MB}mb`, type: () => true }), (req, res) => {
  const originalName = String(req.query.name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'Пустой файл' });
  if (req.body.length > req._uploadMaxBytes) {
    return res.status(413).json({ error: `Файл больше ${Math.round(req._uploadMaxBytes / 1024 / 1024)} МБ` });
  }
  const safeName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${originalName}`;
  fs.writeFileSync(path.join(uploadsDir, safeName), req.body);
  res.json({ url: `/uploads/${safeName}`, name: originalName, size: req.body.length });
});
// Файл больше жёсткого потолка (см. UPLOAD_HARD_CEILING_MB) — express.raw() бросает ошибку мимо
// обработчика выше; ловим её здесь, иначе клиент получит HTML-страницу вместо JSON.
app.use('/api/upload', (err, req, res, next) => {
  if (err) return res.status(413).json({ error: `Файл больше ${UPLOAD_HARD_CEILING_MB} МБ` });
  next();
});

// Настройки загрузки — какие расширения разрешать/запрещать и максимальный размер файла,
// администратор меняет из веб-панели (раздел "Файлы") без правки кода и перезапуска сервера.
app.get('/api/admin/upload-settings', auth, requireCapability('can_admin'), (req, res) => {
  const s = getUploadSettings();
  res.json({ ...s, hardCeilingMb: UPLOAD_HARD_CEILING_MB });
});
app.patch('/api/admin/upload-settings', auth, requireCapability('can_admin'), (req, res) => {
  const { mode, extensions, maxMb } = req.body || {};
  if (mode !== undefined) {
    if (mode !== 'block' && mode !== 'allow') return res.status(400).json({ error: 'Некорректный режим' });
    setSettingRaw('upload_ext_mode', mode);
  }
  if (extensions !== undefined) {
    const clean = String(extensions).split(/[,\s]+/).map((s) => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
    setSettingRaw('upload_ext_list', clean.join(','));
  }
  if (maxMb !== undefined) {
    const n = Number(maxMb);
    if (!Number.isFinite(n) || n < 1 || n > UPLOAD_HARD_CEILING_MB) {
      return res.status(400).json({ error: `Размер должен быть от 1 до ${UPLOAD_HARD_CEILING_MB} МБ` });
    }
    setSettingRaw('upload_max_mb', String(Math.round(n)));
  }
  logServer('INFO', 'upload_settings_changed', { adminId: req.user.id, mode, extensions, maxMb });
  res.json({ ...getUploadSettings(), hardCeilingMb: UPLOAD_HARD_CEILING_MB });
});

// Короткоживущий токен на скачивание ОДНОГО конкретного файла — раньше в ?token= подставляли
// основной 30-дневный сессионный JWT, потому что обычная ссылка не может передать заголовок
// Authorization. Проблема: URL с этим токеном оседает в логах сервера/прокси (по умолчанию логируют
// query string), и утечка такого лога на весь этот срок равносильна утечке пароля. Токен здесь
// привязан к конкретному diskName (purpose:'download') и живёт минуту — этого достаточно, чтобы
// начать скачивание, а сама передача байтов уже не зависит от валидности токена.
app.get('/api/download-token', auth, (req, res) => {
  const diskName = String(req.query.path || '').split('/').pop();
  if (!diskName) return res.status(400).json({ error: 'Не указан файл' });
  const token = jwt.sign({ purpose: 'download', diskName }, SECRET, { expiresIn: '60s' });
  res.json({ token });
});

// На диске файл лежит под "грязным" именем (метка времени + случайный хеш — нужно для исключения
// коллизий и path traversal), поэтому явно задаём оригинальное имя через Content-Disposition —
// иначе при сохранении подставлялось бы страшное техническое имя файла. Клиент передаёт оригинальное
// имя параметром ?name=, зная его из истории переписки.
app.get('/uploads/:diskName', (req, res) => {
  let payload;
  try { payload = jwt.verify(req.query.token, SECRET); } catch { return res.sendStatus(401); }
  if (payload.purpose !== 'download' || payload.diskName !== req.params.diskName) return res.sendStatus(401);
  const filePath = path.join(uploadsDir, req.params.diskName);
  if (!filePath.startsWith(uploadsDir) || !fs.existsSync(filePath)) return res.sendStatus(404);
  const displayName = req.query.name ? String(req.query.name).slice(0, 260) : req.params.diskName;
  res.download(filePath, displayName);
});

// ---------- Rate-limiting против перебора паролей ----------
// Два независимых счётчика, оба — простые in-memory Map с ленивым протуханием (для 20-200 человек
// в локальной сети выделенный npm-пакет вроде express-rate-limit избыточен):
//  1) ipAttempts — общий поток запросов с одного IP на /api/login и /api/register (защита от
//     заливки запросами вообще, не только подбора пароля к конкретному логину);
//  2) loginFails — счётчик подряд неверных паролей для КОНКРЕТНОГО логина: после нескольких
//     промахов аккаунт временно блокируется, независимо от того, с какого IP или через сколько
//     разных IP идёт перебор.
const ipAttempts = new Map(); // ip -> { count, resetAt }
function ipRateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const now = Date.now();
    let entry = ipAttempts.get(req.ip);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + windowMs };
      ipAttempts.set(req.ip, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      logServer('WARN', 'rate_limited', { ip: req.ip, path: req.path });
      return res.status(429).json({ error: 'Слишком много попыток с этого адреса, попробуйте позже' });
    }
    next();
  };
}

const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const loginFails = new Map(); // username (lower) -> { count, windowStart, lockedUntil }
function checkLoginLock(username) {
  const entry = loginFails.get(String(username || '').toLowerCase());
  if (entry && entry.lockedUntil > Date.now()) return Math.ceil((entry.lockedUntil - Date.now()) / 1000);
  return 0;
}
function registerLoginFail(username) {
  const key = String(username || '').toLowerCase();
  const now = Date.now();
  let entry = loginFails.get(key);
  if (!entry || now - entry.windowStart > LOGIN_FAIL_WINDOW_MS) entry = { count: 0, windowStart: now, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_FAILS) entry.lockedUntil = now + LOGIN_LOCK_MS;
  loginFails.set(key, entry);
}
function clearLoginFails(username) {
  loginFails.delete(String(username || '').toLowerCase());
}
// Периодическая уборка протухших записей, чтобы обе Map не росли бесконечно.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ipAttempts) if (v.resetAt < now) ipAttempts.delete(k);
  for (const [k, v] of loginFails) {
    const stale = v.lockedUntil ? v.lockedUntil < now : now - v.windowStart > LOGIN_FAIL_WINDOW_MS;
    if (stale) loginFails.delete(k);
  }
}, 10 * 60 * 1000).unref();

app.post('/api/register', ipRateLimit({ windowMs: 60 * 60 * 1000, max: 10 }), (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 4) {
    return res.status(400).json({ error: 'Логин и пароль (мин. 4 символа) обязательны' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    // Самостоятельная регистрация никогда не даёт прав — ни рассылок, ни админки. Их выдаёт
    // вручную администратор (сотруднику лично или всему его отделу), либо стартовый администратор
    // из bootstrap-admin.js создаётся отдельно, не через эту форму.
    const info = insertUser.run(username, hash, username, 0, 0, Date.now());
    invalidateUserIdsCache();
    logServer('INFO', 'register', { username, id: info.lastInsertRowid, ip: req.ip });
    const token = jwt.sign({ id: info.lastInsertRowid }, SECRET, { expiresIn: '30d' });
    res.json({ token, user: getUserById.get(info.lastInsertRowid) });
  } catch {
    res.status(409).json({ error: 'Такой логин уже занят' });
  }
});

app.post('/api/login', ipRateLimit({ windowMs: 10 * 60 * 1000, max: 30 }), (req, res) => {
  const { username, password } = req.body || {};
  const lockedSec = checkLoginLock(username);
  if (lockedSec) {
    logServer('WARN', 'login_locked', { username, ip: req.ip, lockedSec });
    return res.status(429).json({ error: `Слишком много неверных попыток входа, повторите через ${lockedSec} сек.` });
  }
  const user = getUserByName.get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    registerLoginFail(username);
    logServer('WARN', 'login_failed', { username, ip: req.ip });
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  clearLoginFails(username);
  logServer('INFO', 'login', { username, id: user.id, ip: req.ip });
  const token = jwt.sign({ id: user.id }, SECRET, { expiresIn: '30d' });
  res.json({ token, user: getUserById.get(user.id) });
});

// Ошибки с рабочих мест сотрудников — рендереры десктоп-клиента сами шлют их сюда при window.onerror/
// unhandledrejection (см. installErrorReporting в ui-kit.js). Пишем в отдельный файл лога (не мешаем
// с серверными событиями), с указанием, кто прислал и с какого хоста — так инцидент на чьём-то ПК
// можно разобрать по логам на сервере, не прося сотрудника прислать скриншот или не выезжая к нему.
app.post('/api/client-log', auth, (req, res) => {
  const { kind, message, extra, source, hostname } = req.body || {};
  logClient({
    userId: req.user.id,
    username: req.user.username,
    hostname: String(hostname || '?').slice(0, 100),
    source: String(source || '?').slice(0, 30),
    kind: String(kind || '?').slice(0, 60),
    message: String(message || '').slice(0, 2000),
    extra: extra !== undefined ? JSON.stringify(extra).slice(0, 2000) : null,
  });
  res.json({ ok: true });
});

// ---------- Профиль (свой аккаунт) ----------
app.get('/api/me', auth, (req, res) => res.json(req.user));
app.patch('/api/me', auth, (req, res) => {
  const displayName = String((req.body || {}).display_name || '').trim();
  if (!displayName) return res.status(400).json({ error: 'Введите отображаемое имя' });
  updateDisplayName.run(displayName.slice(0, 60), req.user.id);
  broadcastUsersChanged();
  res.json({ ok: true });
});

app.get('/api/users', auth, (req, res) => {
  const etag = `"users-v${usersVersion}"`;
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.set('ETag', etag);
  res.json(listUsersBasic.all());
});
app.get('/api/departments', auth, (req, res) => {
  const etag = `"users-v${usersVersion}"`;
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.set('ETag', etag);
  res.json(listDepartments.all());
});

// ---------- Группы ----------
// Управлять группой (переименовать/добавить-убрать участников/удалить) может только создатель или
// администратор сайта (canManageGroup выше) — обычный участник может написать в группу и сам из неё
// выйти. Права не наследуются от отдела: группу может собрать кто угодно под свою временную задачу,
// не только руководитель отдела.
app.get('/api/groups', auth, (req, res) => res.json(listGroupsForUser.all(req.user.id)));

app.post('/api/groups', auth, (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите название группы' });
  const memberIds = Array.isArray((req.body || {}).memberIds) ? req.body.memberIds.map(Number).filter((n) => Number.isFinite(n)) : [];
  const now = Date.now();
  const info = insertGroup.run(name.slice(0, 80), req.user.id, now);
  const groupId = info.lastInsertRowid;
  addGroupMember.run(groupId, req.user.id, now); // создатель — всегда участник, даже если забыли отметить себя в списке
  for (const uid of memberIds) if (uid !== req.user.id) addGroupMember.run(groupId, uid, now);
  broadcastGroupsChanged();
  res.json({ ok: true, id: groupId });
});

app.get('/api/groups/:id/members', auth, (req, res) => {
  const groupId = Number(req.params.id);
  if (!isGroupMemberStmt.get(groupId, req.user.id) && !req.user.can_admin) return res.status(403).json({ error: 'Вы не участник этой группы' });
  res.json(listGroupMembers.all(groupId));
});

app.patch('/api/groups/:id', auth, (req, res) => {
  const group = getGroup.get(Number(req.params.id));
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });
  if (!canManageGroup(req.user, group)) return res.status(403).json({ error: 'Недостаточно прав' });
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'Название не может быть пустым' });
  renameGroupStmt.run(name.slice(0, 80), group.id);
  broadcastGroupsChanged();
  res.json({ ok: true });
});

app.post('/api/groups/:id/members', auth, (req, res) => {
  const group = getGroup.get(Number(req.params.id));
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });
  if (!canManageGroup(req.user, group)) return res.status(403).json({ error: 'Недостаточно прав' });
  const userIds = Array.isArray((req.body || {}).userIds) ? req.body.userIds.map(Number).filter((n) => Number.isFinite(n)) : [];
  const now = Date.now();
  for (const uid of userIds) addGroupMember.run(group.id, uid, now);
  broadcastGroupsChanged();
  res.json({ ok: true });
});

app.delete('/api/groups/:id/members/:userId', auth, (req, res) => {
  const group = getGroup.get(Number(req.params.id));
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });
  const targetId = Number(req.params.userId);
  // Убрать ЧУЖОГО участника — только владелец/админ; выйти самому — можно всегда, без разрешения.
  if (targetId !== req.user.id && !canManageGroup(req.user, group)) return res.status(403).json({ error: 'Недостаточно прав' });
  removeGroupMember.run(group.id, targetId);
  // Группа осталась без единого участника — писать/читать в неё уже некому, и даже администратор не
  // увидит её в своём списке (listGroupsForUser требует членства) — удаляем саму запись о группе.
  // Историю переписки НЕ трогаем — так же, как удаление пользователя не стирает его сообщения.
  if (countGroupMembers.get(group.id).c === 0) { deleteGroupMembersStmt.run(group.id); deleteGroupStmt.run(group.id); }
  broadcastGroupsChanged();
  res.json({ ok: true });
});

app.delete('/api/groups/:id', auth, (req, res) => {
  const group = getGroup.get(Number(req.params.id));
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });
  if (!canManageGroup(req.user, group)) return res.status(403).json({ error: 'Недостаточно прав' });
  deleteGroupMembersStmt.run(group.id);
  deleteGroupStmt.run(group.id); // историю переписки не трогаем — та же логика, что у удаления пользователя/отдела
  broadcastGroupsChanged();
  res.json({ ok: true });
});

// 'general' — общая комната, видна всем (как и раньше, без проверки членства). Для 'group:<id>' —
// историю может смотреть только участник группы (или админ) — раньше проверки не было вовсе, но
// пока комната была ровно одна и открыта всем, это было не багом, а особенностью.
function canReadRoom(user, room) {
  if (!isGroupRoom(room)) return true;
  return !!isGroupMemberStmt.get(groupIdFromRoom(room), user.id) || !!user.can_admin;
}

// История: без параметров — последние 200 сообщений (как раньше); ?since=&until= — диапазон
// (используется для "сегодняшнего" окна чата и просмотра конкретного дня); ?q= — поиск по тексту
// во всей истории переписки (диапазон дат при этом игнорируется).
app.get('/api/history/room/:room', auth, (req, res) => {
  if (!canReadRoom(req.user, req.params.room)) return res.status(403).json({ error: 'Вы не участник этой группы' });
  const { since, until, q } = req.query;
  const before = beforeId(req);
  if (q) return res.json(attachReactions(roomHistorySearch.all(req.params.room, before, q).reverse().map(normalizeRow)));
  if (since && until) return res.json(attachReactions(roomHistoryRange.all(req.params.room, Number(since), Number(until)).map(normalizeRow))); // уже ASC из SQL
  res.json(attachReactions(roomHistoryAll.all(req.params.room, before).reverse().map(normalizeRow)));
});
// Группировка по дням учитывает часовой пояс КЛИЕНТА (?offsetMinutes= — минуты впереди UTC,
// т.е. для UTC+3 это 180), а не сервера — так деление на дни всегда совпадает с тем, что человек
// видит на часах, даже если сервер физически стоит в другом часовом поясе.
function tzModifier(req) {
  const minutes = Number(req.query.offsetMinutes) || 0;
  const sign = minutes >= 0 ? '+' : '-';
  return `${sign}${Math.abs(minutes)} minutes`;
}

// Курсор постраничной подгрузки для ?before= (см. HISTORY_PAGE_SIZE выше) — без параметра (первая
// страница) берём заведомо больше любого реального id сообщения.
const BEFORE_ID_MAX = Number.MAX_SAFE_INTEGER;
function beforeId(req) {
  const b = Number(req.query.before);
  return Number.isFinite(b) && b > 0 ? b : BEFORE_ID_MAX;
}

app.get('/api/history/room/:room/days', auth, (req, res) => {
  if (!canReadRoom(req.user, req.params.room)) return res.status(403).json({ error: 'Вы не участник этой группы' });
  res.json(roomHistoryDays.all(tzModifier(req), req.params.room));
});

app.get('/api/history/dm/:userId', auth, (req, res) => {
  const other = Number(req.params.userId);
  const { since, until, q } = req.query;
  const before = beforeId(req);
  if (q) return res.json(attachReactions(dmHistorySearch.all(req.user.id, other, other, req.user.id, before, q).reverse().map(normalizeRow)));
  if (since && until) return res.json(attachReactions(dmHistoryRange.all(req.user.id, other, other, req.user.id, Number(since), Number(until)).map(normalizeRow))); // уже ASC из SQL
  res.json(attachReactions(dmHistoryAll.all(req.user.id, other, other, req.user.id, before).reverse().map(normalizeRow)));
});
app.get('/api/history/dm/:userId/days', auth, (req, res) => {
  const other = Number(req.params.userId);
  res.json(dmHistoryDays.all(tzModifier(req), req.user.id, other, other, req.user.id));
});

// Непрочитанные личные сообщения по каждому собеседнику — read_at авторитетен и хранится на
// сервере (в отличие от localStorage-меток в клиенте), поэтому не зависит от того, открывал ли
// клиент этот диалог раньше. Нужно для "досчитывания" значков непрочитанного при старте десктоп-
// клиента (см. main.js/roster.html) — раньше они жили только в памяти главного процесса и
// пополнялись исключительно живыми WS-событиями, поэтому пропущенное, пока клиент был закрыт,
// никак не отражалось на значках до открытия диалога вручную.
app.get('/api/unread-dms', auth, (req, res) => {
  const rows = unreadDmCounts.all(req.user.id);
  const result = {};
  rows.forEach((r) => { result[r.from_id] = r.c; });
  res.json(result);
});

// ---------- Рассылки ----------
app.get('/api/broadcasts', auth, (req, res) => {
  const { since, until, q } = req.query;
  if (q) return res.json(broadcastsSearch.all(q).reverse().map(normalizeRow));
  if (since && until) return res.json(broadcastsRange.all(Number(since), Number(until)).map(normalizeRow)); // уже ASC из SQL
  res.json(recentBroadcasts.all().reverse().map(normalizeRow));
});
app.get('/api/broadcasts/days', auth, (req, res) => res.json(broadcastsDays.all(tzModifier(req))));
app.post('/api/broadcast', auth, requireCapability('can_broadcast'), (req, res) => {
  const text = String((req.body || {}).text || '').slice(0, 4000).trim();
  const rawFiles = Array.isArray((req.body || {}).files) ? req.body.files : [];
  const files = rawFiles.slice(0, 20).filter((f) => f && f.url).map((f) => ({
    url: String(f.url).slice(0, 300),
    name: String(f.name || 'файл').slice(0, 200),
    size: Number(f.size) || 0,
  }));
  if (!text && !files.length) return res.status(400).json({ error: 'Пустая рассылка' });
  const now = Date.now();
  const filesJson = files.length ? JSON.stringify(files) : null;
  insertBroadcast.run(req.user.id, text, filesJson, now);
  const payload = JSON.stringify({ type: 'broadcast', from_user: req.user.display_name, text, files, created_at: now });
  for (const ws of connMeta.keys()) ws.send(payload);
  res.json({ ok: true });
});

// ---------- Админка ----------
app.get('/api/admin/users', auth, requireCapability('can_admin'), (req, res) => res.json(listUsersFull.all()));

app.post('/api/admin/users', auth, requireCapability('can_admin'), (req, res) => {
  const { username, password, department_id, can_broadcast, can_admin } = req.body || {};
  if (!username || !password || password.length < 4) return res.status(400).json({ error: 'Логин и пароль (мин. 4 символа) обязательны' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = insertUser.run(username, hash, username, can_broadcast ? 1 : 0, can_admin ? 1 : 0, Date.now());
    invalidateUserIdsCache();
    if (department_id) updateUserDept.run(department_id, info.lastInsertRowid);
    broadcastUsersChanged();
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch {
    res.status(409).json({ error: 'Такой логин уже занят' });
  }
});

app.patch('/api/admin/users/:id', auth, requireCapability('can_admin'), (req, res) => {
  const id = Number(req.params.id);
  const { department_id, password, display_name, can_broadcast, can_admin, version } = req.body || {};
  const current = db.prepare('SELECT can_broadcast, can_admin, version FROM users WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ error: 'Пользователь не найден' });
  // Оптимистичная блокировка: панель присылает версию строки, которую видела при загрузке. Если она
  // разошлась с текущей — правки внёс кто-то другой (второй администратор) уже после этого, и молча
  // затирать их нельзя. При 20-200 сотрудниках такая гонка редкая, но раз возможна — проверяем.
  if (version !== undefined && Number(version) !== current.version) {
    return res.status(409).json({ error: 'Пользователя уже изменил другой администратор — обновите страницу и повторите' });
  }
  if (can_broadcast !== undefined || can_admin !== undefined) {
    updateUserCaps.run(
      can_broadcast !== undefined ? (can_broadcast ? 1 : 0) : current.can_broadcast,
      can_admin !== undefined ? (can_admin ? 1 : 0) : current.can_admin,
      id,
    );
  }
  if (department_id !== undefined) updateUserDept.run(department_id || null, id);
  if (password) {
    if (password.length < 4) return res.status(400).json({ error: 'Пароль слишком короткий' });
    updateUserPassword.run(bcrypt.hashSync(password, 10), id);
  }
  if (display_name !== undefined) {
    const clean = String(display_name).trim();
    if (!clean) return res.status(400).json({ error: 'Имя не может быть пустым' });
    updateDisplayName.run(clean.slice(0, 60), id);
  }
  bumpUserVersion.run(id);
  broadcastUsersChanged();
  res.json({ ok: true, version: current.version + 1 });
});

app.delete('/api/admin/users/:id', auth, requireCapability('can_admin'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Нельзя удалить свою же учётку' });
  deleteUserStmt.run(id);
  invalidateUserIdsCache();
  broadcastUsersChanged();
  res.json({ ok: true });
});

app.post('/api/admin/departments', auth, requireCapability('can_admin'), (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите название отдела' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),-1) m FROM departments').get().m;
  try {
    const info = insertDepartment.run(name, maxOrder + 1);
    broadcastUsersChanged();
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch {
    res.status(409).json({ error: 'Такой отдел уже есть' });
  }
});

app.delete('/api/admin/departments/:id', auth, requireCapability('can_admin'), (req, res) => {
  deleteDepartmentStmt.run(Number(req.params.id));
  broadcastUsersChanged();
  res.json({ ok: true });
});
app.patch('/api/admin/departments/:id', auth, requireCapability('can_admin'), (req, res) => {
  const id = Number(req.params.id);
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите название отдела' });
  try {
    updateDepartmentStmt.run(name, id);
    broadcastUsersChanged();
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: 'Такой отдел уже есть' });
  }
});
// Порядок отображения отделов — целиком пересчитывается за один запрос: клиент присылает id-шники
// в желаемом порядке (например, после перетаскивания строк местами), сервер проставляет sort_order
// по позиции в массиве.
app.post('/api/admin/departments/reorder', auth, requireCapability('can_admin'), (req, res) => {
  const order = Array.isArray((req.body || {}).order) ? req.body.order : [];
  if (!order.length) return res.status(400).json({ error: 'Пустой список порядка' });
  const tx = db.transaction((ids) => { ids.forEach((id, i) => setDepartmentOrder.run(i, Number(id))); });
  tx(order);
  broadcastUsersChanged();
  res.json({ ok: true });
});

// ---------- Управление загруженными файлами ----------
// Сопоставляем файлы на диске с сообщениями/рассылками, в которых они упоминаются — чтобы в
// админке было видно не только "какой-то файл весом 3 МБ", а кто его отправил и куда.
function buildFileIndex() {
  const index = new Map(); // diskName -> { from, context, created_at, originalName }
  const userName = (id) => (getUserById.get(id) || {}).display_name || `#${id}`;

  const msgs = db.prepare('SELECT from_id, room, to_id, files_json, created_at FROM messages WHERE files_json IS NOT NULL').all();
  for (const m of msgs) {
    let files = [];
    try { files = JSON.parse(m.files_json); } catch { continue; }
    const context = m.room ? `общая комната` : 'личная переписка';
    for (const f of files) {
      const diskName = String(f.url || '').split('/').pop();
      if (diskName) index.set(diskName, { from: userName(m.from_id), context, created_at: m.created_at, originalName: f.name });
    }
  }
  const bcs = db.prepare('SELECT from_id, files_json, created_at FROM broadcasts WHERE files_json IS NOT NULL').all();
  for (const b of bcs) {
    let files = [];
    try { files = JSON.parse(b.files_json); } catch { continue; }
    for (const f of files) {
      const diskName = String(f.url || '').split('/').pop();
      if (diskName) index.set(diskName, { from: userName(b.from_id), context: 'рассылка', created_at: b.created_at, originalName: f.name });
    }
  }
  return index;
}

app.get('/api/admin/files', auth, requireCapability('can_admin'), (req, res) => {
  const index = buildFileIndex();
  let entries;
  try {
    entries = fs.readdirSync(uploadsDir).map((diskName) => {
      const stat = fs.statSync(path.join(uploadsDir, diskName));
      const meta = index.get(diskName);
      return {
        diskName,
        size: stat.size,
        created_at: meta?.created_at || stat.mtimeMs,
        originalName: meta?.originalName || diskName,
        from: meta?.from || null,
        context: meta?.context || null,
        // Файл есть на диске, но ни в одном сообщении/рассылке на него нет ссылки — например,
        // загрузку начали, а сообщение так и не отправили. Такие можно чистить не глядя.
        orphaned: !meta,
      };
    });
  } catch {
    entries = [];
  }
  entries.sort((a, b) => b.created_at - a.created_at);
  res.json(entries);
});

app.delete('/api/admin/files/:diskName', auth, requireCapability('can_admin'), (req, res) => {
  const diskName = req.params.diskName;
  const filePath = path.join(uploadsDir, diskName);
  // Двойная защита от выхода за пределы папки uploads (path traversal через имя файла)
  if (path.dirname(filePath) !== uploadsDir) return res.status(400).json({ error: 'Некорректное имя файла' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Файл не найден' });
  fs.unlinkSync(filePath);
  // Сообщение/рассылка, где был этот файл, никуда не денется — просто ссылка в ней перестанет
  // скачиваться. Это осознанное решение: удаляем файл с диска, а не переписываем историю.
  res.json({ ok: true });
});

// Админ может открыть историю любого чата
app.get('/api/admin/history/room/:room', auth, requireCapability('can_admin'), (req, res) => {
  res.json(roomHistoryAll.all(req.params.room, beforeId(req)).reverse().map(normalizeRow));
});
app.get('/api/admin/history/dm/:u1/:u2', auth, requireCapability('can_admin'), (req, res) => {
  const a = Number(req.params.u1), b = Number(req.params.u2);
  res.json(dmHistoryAll.all(a, b, b, a, beforeId(req)).reverse().map(normalizeRow));
});

app.get('/api/admin/stats', auth, requireCapability('can_admin'), (req, res) => {
  const onlineUserIds = new Set();
  for (const meta of connMeta.values()) onlineUserIds.add(meta.userId);
  res.json({
    usersTotal: countUsers.get().c,
    onlineNow: onlineUserIds.size,
    departmentsTotal: departmentsCount.get().c,
    messagesTotal: messagesCount.get().c,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

const LOG_VIEW_LIMIT = 2000;
// Разбирает одну строку лог-файла обратно в структуру — формат задан в logServer/logClient выше:
// "<ISO-время> [LEVEL] событие {...meta}" для серверных записей, "<ISO-время> [CLIENT] {...}" для
// присланных клиентом. Строки, не подошедшие под формат (например, обрезанные при аварийном
// завершении записи), тихо пропускаются, а не ломают всю выдачу.
function parseLogLine(line, source) {
  const spaceIdx = line.indexOf(' ');
  if (spaceIdx < 0) return null;
  const ts = line.slice(0, spaceIdx);
  const rest = line.slice(spaceIdx + 1);
  if (source === 'server') {
    const m = rest.match(/^\[(\w+)\] (\S+) (\{[\s\S]*\})$/);
    if (!m) return null;
    let meta = {};
    try { meta = JSON.parse(m[3]); } catch { /* строка повреждена — оставляем meta пустым */ }
    return { ts, level: m[1], source: 'server', event: m[2], meta };
  }
  const m = rest.match(/^\[CLIENT\] (\{[\s\S]*\})$/);
  if (!m) return null;
  let meta = {};
  try { meta = JSON.parse(m[1]); } catch { /* строка повреждена — оставляем meta пустым */ }
  // Клиентские записи всегда об ошибке (см. installErrorReporting в ui-kit.js — шлёт только сбои),
  // отдельного уровня в самой строке нет, поэтому фиксируем ERROR для единообразия с серверными.
  return { ts, level: 'ERROR', source: 'client', event: meta.kind || 'client_error', meta };
}
// Логи читаются прямо из дневных файлов (см. logsDir выше), без отдельной БД-таблицы под них —
// для 20-200 человек файл за день весит от силы сотни КБ, гонять его целиком в память при каждом
// открытии панели не проблема, а второе хранилище логов ради этого не оправдано.
app.get('/api/admin/logs', auth, requireCapability('can_admin'), (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day) ? req.query.day : dayStamp();
  const typeFilter = ['server', 'client'].includes(req.query.type) ? req.query.type : 'all';
  const levelFilter = ['INFO', 'WARN', 'ERROR'].includes(req.query.level) ? req.query.level : 'all';
  let entries = [];
  for (const source of ['server', 'client']) {
    if (typeFilter !== 'all' && typeFilter !== source) continue;
    const filePath = path.join(logsDir, `${source}-${day}.log`);
    if (!fs.existsSync(filePath)) continue;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      const parsed = parseLogLine(line, source);
      if (parsed) entries.push(parsed);
    }
  }
  // Фильтр по уровню — "от" (WARN означает WARN и выше), а не точное совпадение: так выбор
  // "Предупреждения и ошибки" в панели действительно скрывает только шумные INFO-записи.
  const LEVEL_RANK = { INFO: 0, WARN: 1, ERROR: 2 };
  if (levelFilter !== 'all') entries = entries.filter((e) => (LEVEL_RANK[e.level] ?? 0) >= LEVEL_RANK[levelFilter]);
  entries.sort((a, b) => (a.ts < b.ts ? 1 : -1)); // новые сверху
  res.json({ entries: entries.slice(0, LOG_VIEW_LIMIT), truncated: entries.length > LOG_VIEW_LIMIT, total: entries.length });
});

// ---------- WebSocket (реалтайм + presence) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const online = new Map();   // userId -> Set(ws)              — для маршрутизации сообщений
const connMeta = new Map(); // ws -> { userId, hostname, state } — для presence (может быть несколько ПК на юзера)

// Кэш id всех пользователей — чтобы presenceSnapshot() не делал SELECT по таблице users на каждый
// вызов (а вызывается он на каждое presence-событие: подключение/отключение/каждый статус-тик от
// клиентов, т.е. часто). Сбрасывается при создании/удалении пользователя.
let allUserIdsCache = null;
function getAllUserIds() {
  if (!allUserIdsCache) allUserIdsCache = db.prepare('SELECT id FROM users').all().map((r) => r.id);
  return allUserIdsCache;
}
function invalidateUserIdsCache() { allUserIdsCache = null; }

// userId -> { state, since } — момент последней смены АГРЕГИРОВАННОГО (по всем подключениям
// пользователя) статуса. Живёт в памяти процесса (не в БД), поэтому переживает переподключения
// конкретных WS, но не перезапуск сервера — после рестарта отсчёт для всех начнётся заново.
const statusSince = new Map();

function presenceSnapshot() {
  const onlineByUser = new Map(); // не путать с внешней online (userId -> Set(ws) для маршрутизации)
  for (const meta of connMeta.values()) {
    if (!onlineByUser.has(meta.userId)) onlineByUser.set(meta.userId, { state: 'offline', hosts: new Set(), idleSince: null });
    const entry = onlineByUser.get(meta.userId);
    entry.hosts.add(meta.hostname || 'неизвестный ПК');
    if (meta.state === 'active') { entry.state = 'active'; entry.idleSince = null; }
    else if (meta.state === 'idle' && entry.state !== 'active') {
      entry.state = 'idle';
      // Если у пользователя несколько ПК и оба "отошли" — берём более раннее время, т.е. самый
      // давний по времени переход в AFK (человек отошёл ото всех, начиная с этого момента).
      if (meta.idleSince && (!entry.idleSince || meta.idleSince < entry.idleSince)) entry.idleSince = meta.idleSince;
    }
  }

  const now = Date.now();
  const result = {};
  for (const uid of getAllUserIds()) {
    const entry = onlineByUser.get(uid);
    const state = entry ? entry.state : 'offline';
    const prev = statusSince.get(uid);
    if (!prev || prev.state !== state) statusSince.set(uid, { state, since: now });
    result[uid] = {
      state,
      hosts: entry ? [...entry.hosts] : [],
      idleSince: entry ? entry.idleSince : null,
      since: statusSince.get(uid).since, // с какого момента текущий статус действует — для тултипа в клиенте
    };
  }
  return result;
}

function broadcastPresence() {
  const payload = JSON.stringify({ type: 'presence', users: presenceSnapshot() });
  for (const ws of connMeta.keys()) ws.send(payload);
}

// Оповещаем всех подключённых клиентов, что список пользователей/отделов/ролей изменился —
// клиент сам решает, что переспросить (роль/имя/список), без необходимости перезаходить в аккаунт.
// Счётчик версии списка пользователей/отделов — растёт на каждое изменение (см. вызовы ниже) и
// используется как ETag для GET /api/users и /api/departments (см. эти маршруты выше). Ростер
// опрашивает оба раз в 20 секунд на каждого клиента — при 20-200 сотрудниках это не проблема, но
// с ростом штата отдавать одинаковый JSON заново на каждый пустой тик бессмысленно: с ETag сервер
// в подавляющем большинстве тиков просто отвечает 304 без сборки списка и передачи тела.
let usersVersion = 0;
function broadcastUsersChanged() {
  usersVersion++;
  const payload = JSON.stringify({ type: 'users-changed' });
  for (const ws of connMeta.keys()) ws.send(payload);
}

// Группа создана/переименована/у неё поменялись участники/её удалили — оповещаем ВСЕХ подключённых
// (не только текущих/бывших участников — проще и надёжнее целевой рассылки, а список групп у
// каждого клиента крошечный, перезапросить его не накладно), клиент сам решает, актуально ли это
// для него, и просто перезапрашивает /api/groups.
function broadcastGroupsChanged() {
  const payload = JSON.stringify({ type: 'groups-changed' });
  for (const ws of connMeta.keys()) ws.send(payload);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  const hostname = url.searchParams.get('host') || 'неизвестный ПК';
  let payload;
  try { payload = jwt.verify(token, SECRET); } catch { logServer('WARN', 'ws_auth_failed', { ip: req.socket.remoteAddress }); return ws.close(); }
  const user = getUserById.get(payload.id);
  if (!user) return ws.close();

  if (!online.has(user.id)) online.set(user.id, new Set());
  online.get(user.id).add(ws);
  connMeta.set(ws, { userId: user.id, hostname, state: 'active', lastSeen: Date.now(), idleSince: null });
  broadcastPresence();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'status') {
      const meta = connMeta.get(ws);
      if (meta) {
        const newState = msg.state === 'idle' ? 'idle' : 'active';
        if (newState === 'idle' && meta.state !== 'idle') meta.idleSince = Date.now(); // момент перехода в AFK
        if (newState === 'active') meta.idleSince = null;
        meta.state = newState;
        meta.lastSeen = Date.now();
      }
      broadcastPresence();
      return;
    }

    // "Печатает..." — ничего не сохраняем, чистый ретранслятор с throttle на СТОРОНЕ КЛИЕНТА
    // (см. sendTyping в chat.html); индикатор у получателя гаснет сам по таймауту без нового
    // события, так что явного "закончил печатать" сигнала не нужно.
    if (msg.type === 'typing') {
      const out = JSON.stringify({ type: 'typing', room: msg.room || null, from_id: user.id, from_user: user.display_name });
      if (isGroupRoom(msg.room)) {
        // Только участникам группы, а не буквально всем (как для 'general') — иначе кто угодно
        // подключённый увидел бы, что кто-то печатает в группе, где его самого нет.
        for (const uid of groupMemberIds(groupIdFromRoom(msg.room))) {
          if (uid === user.id) continue;
          (online.get(uid) || new Set()).forEach((c) => c.send(out));
        }
      } else if (msg.room) {
        for (const [c, meta] of connMeta) { if (meta.userId !== user.id) c.send(out); }
      } else if (msg.to) {
        (online.get(Number(msg.to)) || new Set()).forEach((c) => c.send(out));
      }
      return;
    }

    if (msg.type === 'read') {
      const peer = Number(msg.peer);
      const upTo = Number(msg.upTo);
      if (!peer || !upTo) return;
      const info = markDmRead.run(Date.now(), peer, user.id, upTo);
      if (info.changes > 0) {
        // Сообщаем автору (peer), что я прочитал его сообщения по upTo включительно — если он сейчас
        // онлайн, его открытое окно переписки со мной сразу перекрасит галочки в синий.
        const out = JSON.stringify({ type: 'read-receipt', peer: user.id, upTo });
        (online.get(peer) || new Set()).forEach((c) => c.send(out));
      }
      return;
    }

    // Реакции — по одной эмодзи на пользователя на сообщение: повторный клик той же эмодзи снимает
    // реакцию, другой — заменяет. Рассылаем ПОЛНЫЙ актуальный набор реакций сообщения (а не дельту) —
    // проще и надёжнее инкрементального патча, а реакций на одном сообщении обычно немного.
    if (msg.type === 'react') {
      const messageId = Number(msg.messageId);
      const emoji = String(msg.emoji || '').slice(0, 8);
      if (!messageId || !emoji) return;
      const target = getMessageRoute.get(messageId);
      if (!target) return;
      const existing = getUserReactionOnMessage.get(messageId, user.id);
      if (existing && existing.emoji === emoji) deleteReaction.run(messageId, user.id);
      else upsertReaction.run(messageId, user.id, emoji, Date.now());
      const byEmoji = new Map();
      for (const r of reactionsForMessages.all(JSON.stringify([messageId]))) {
        if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
        byEmoji.get(r.emoji).push(r.user_id);
      }
      const reactions = [...byEmoji].map(([e, userIds]) => ({ emoji: e, userIds }));
      const out = JSON.stringify({ type: 'reaction', messageId, reactions });
      if (target.room) {
        for (const c of connMeta.keys()) c.send(out);
      } else {
        const targets = new Set([...(online.get(target.to_id) || []), ...(online.get(target.from_id) || [])]);
        targets.forEach((c) => c.send(out));
      }
      return;
    }

    if (msg.type !== 'send') return;
    // Писать в группу может только её участник — молча игнорируем чужую попытку (не подсказываем
    // подбором id группы, что именно там за люди/переписка).
    if (isGroupRoom(msg.room) && !isGroupMemberStmt.get(groupIdFromRoom(msg.room), user.id)) return;
    const now = Date.now();
    const text = String(msg.text || '').slice(0, 4000).trim();
    // Несколько файлов в одном сообщении: msg.files — массив; msg.file (в ед. числе) — старый формат,
    // поддерживаем на случай, если где-то остался не обновлённый клиент.
    const rawFiles = Array.isArray(msg.files) ? msg.files : (msg.file ? [msg.file] : []);
    const files = rawFiles.slice(0, 20).filter((f) => f && f.url).map((f) => ({
      url: String(f.url).slice(0, 300),
      name: String(f.name || 'файл').slice(0, 200),
      size: Number(f.size) || 0,
    }));
    if (!text && !files.length) return;
    const filesJson = files.length ? JSON.stringify(files) : null;

    // Ответ на сообщение (reply) — снимок автора/текста делаем ЗДЕСЬ, на сервере (источник истины),
    // а не доверяем тому, что прислал клиент: то, на что отвечают, могло не быть у него в DOM
    // (старая страница пагинации), а после отправки должно остаться верным, даже если оригинал
    // потом станет недоступен клиенту.
    let replyToId = null, replySnapshot = null, replyOut = null;
    if (msg.replyTo) {
      const target = getMessageForReply.get(Number(msg.replyTo));
      if (target) {
        const targetUser = getUserById.get(target.from_id);
        replyToId = target.id;
        replyOut = { id: target.id, from_user: targetUser ? targetUser.display_name : '?', text: (target.text || '').slice(0, 300) };
        replySnapshot = JSON.stringify({ from_user: replyOut.from_user, text: replyOut.text });
      }
    }

    if (msg.room) {
      const info = insertMessage.run(user.id, msg.room, null, text, filesJson, now, replyToId, replySnapshot);
      const out = JSON.stringify({ type: 'message', id: info.lastInsertRowid, room: msg.room, from_id: user.id, from_user: user.display_name, text, files, created_at: now, reply: replyOut });
      if (isGroupRoom(msg.room)) {
        for (const uid of groupMemberIds(groupIdFromRoom(msg.room))) (online.get(uid) || new Set()).forEach((c) => c.send(out));
      } else {
        for (const c of connMeta.keys()) c.send(out); // общая комната — всем
      }
    } else if (msg.to) {
      const info = insertMessage.run(user.id, null, msg.to, text, filesJson, now, replyToId, replySnapshot);
      const out = JSON.stringify({ type: 'message', id: info.lastInsertRowid, to_id: msg.to, from_id: user.id, from_user: user.display_name, text, files, created_at: now, reply: replyOut });
      const targets = new Set([...(online.get(msg.to) || []), ...(online.get(user.id) || [])]);
      targets.forEach((c) => c.send(out));
    }
  });

  ws.on('close', () => {
    online.get(user.id)?.delete(ws);
    if (online.get(user.id)?.size === 0) online.delete(user.id);
    connMeta.delete(ws);
    broadcastPresence();
  });
});

// Подстраховка: если клиент отвалился без close-события, считаем его оффлайн через таймаут
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [ws, meta] of connMeta) {
    if (now - meta.lastSeen > IDLE_AFTER_MS * 3) { ws.terminate(); changed = true; }
  }
  if (changed) broadcastPresence();
}, 60000);

// ---------- Стартовый администратор ----------
// Создаётся один раз при запуске сервера, если в системе ещё нет НИ ОДНОГО пользователя с правом
// can_admin — читает логин/пароль из bootstrap-admin.js (см. bootstrap-admin.example.js — скопируйте
// его и заполните перед первым запуском). После того как через этот аккаунт создали настоящих
// админов — саму стартовую учётку можно и нужно удалить через веб-панель, файл при этом можно не
// трогать: повторно он ничего не создаст, пока в системе есть хотя бы один админ.
function ensureBootstrapAdmin() {
  const adminUsers = db.prepare('SELECT COUNT(*) c FROM users WHERE can_admin = 1').get().c;
  if (adminUsers > 0) return; // администратор уже есть — стартовый файл не нужен

  let seed = null;
  try { seed = require('./bootstrap-admin.js'); } catch { /* файла нет — см. предупреждение ниже */ }

  if (!seed || !seed.username || !seed.password) {
    console.warn(
      '\n⚠️  В системе нет ни одного администратора, а bootstrap-admin.js не найден (или заполнен неверно).\n' +
      '   Скопируйте bootstrap-admin.example.js в bootstrap-admin.js, укажите логин/пароль и перезапустите сервер.\n'
    );
    return;
  }
  if (seed.password.length < 4) {
    console.warn('\n⚠️  Пароль в bootstrap-admin.js короче 4 символов — стартовый админ не создан.\n');
    return;
  }

  const existing = getUserByName.get(seed.username);
  if (existing) {
    // Логин уже кем-то занят (не админом, иначе adminUsers было бы > 0) — не трогаем чужой аккаунт
    // автоматически, просто предупреждаем, чтобы разобрались вручную.
    console.warn(`\n⚠️  В bootstrap-admin.js указан логин "${seed.username}", но он уже занят пользователем без прав администратора. Автосоздание пропущено.\n`);
    return;
  }

  const hash = bcrypt.hashSync(seed.password, 10);
  insertUser.run(seed.username, hash, seed.username, 1, 1, Date.now());
  console.log(`\n✅ Создан стартовый администратор "${seed.username}" из bootstrap-admin.js.`);
  console.log('   Войдите под этой учёткой, создайте реальных администраторов и удалите стартовую через веб-панель.\n');
}

// Обработчик ошибок Express — САМЫЙ ПОСЛЕДНИЙ app.use, после всех маршрутов: без него Express уже
// логирует необработанные исключения из синхронных обработчиков в stderr сам по себе (через
// finalhandler), но только в консоль — в файл ничего не попадает. Пишем оба места.
app.use((err, req, res, next) => {
  logServer('ERROR', 'request_error', { path: req.path, method: req.method, message: err.message, stack: err.stack });
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

server.listen(PORT, () => {
  ensureBootstrapAdmin();
  console.log(`Мини-мессенджер запущен: http://localhost:${PORT}`);
});
