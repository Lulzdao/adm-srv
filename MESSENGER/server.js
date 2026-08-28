// Искра — корпоративный мессенджер Липецкстата, сервер на Node.js
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
const https = require('https'); // используется, только если сервер настроен на TLS — см. createAppServer
const tls = require('tls');     // тем же: проверка того, что сервер реально отдаёт клиенту
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 3103, а не 3000: «Искра» стоит на одной машине с платформой, и 3000 занят
// платформой. Тот же порт вшит в сборку клиента (desktop-client/config.js) и
// прописан у модуля в helpdesk-backend/config/modules.js — менять надо во всех
// трёх местах сразу.
const PORT = process.env.PORT || 3103;
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
  -- Сотрудник может состоять сразу в нескольких отделах (совместители, а чаще — люди, которые
  -- фактически работают на два подразделения). Раньше отдел был один, колонкой users.department_id;
  -- она осталась ради совместимости и хранит ПЕРВЫЙ из отделов, но источник истины — эта таблица.
  CREATE TABLE IF NOT EXISTS user_departments (
    user_id INTEGER NOT NULL,
    department_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, department_id)
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
  // NULL — объявление всей организации (как было всегда), число — сообщение одному отделу.
  // Отдельной таблицы не заводим: это то же самое объявление, отличается только кругом адресатов,
  // и вся инфраструктура ленты/истории/поиска работает для него без единой правки.
  if (!cols.includes('department_id')) db.exec('ALTER TABLE broadcasts ADD COLUMN department_id INTEGER');
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
// Однократный перенос единственного отдела из users.department_id в user_departments — чтобы при
// обновлении сервера никто не остался без отдела в ростере.
{
  if (!getSettingRaw('migrated_user_departments')) {
    const rows = db.prepare('SELECT id, department_id FROM users WHERE department_id IS NOT NULL').all();
    const link = db.prepare('INSERT OR IGNORE INTO user_departments (user_id, department_id) VALUES (?, ?)');
    const run = db.transaction(() => { for (const r of rows) link.run(r.id, r.department_id); });
    run();
    setSettingRaw('migrated_user_departments', '1');
  }
}

function getSettingRaw(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSettingRaw(key, value) {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ---------- Ключ подписи токенов ----------
// Раньше здесь стояло `process.env.JWT_SECRET || 'change-me-in-production'`. Строка-заглушка лежала
// в открытом репозитории, а переменную окружения на практике почти никто не выставляет — значит,
// ключ подписи был публично известен. Зная его, любой человек в сети мог сам подписать токен с
// чужим id (в том числе администратора) и получить полный доступ, вообще не зная паролей.
// Теперь: если JWT_SECRET не задан, при первом запуске генерируем случайный ключ и сохраняем его в
// базу — дальше он постоянный, отдельной настройки при развёртывании не требуется, а угадать его
// нельзя. Явно заданный JWT_SECRET по-прежнему в приоритете (удобно, если ключ хранят централизованно).
// ВНИМАНИЕ при обновлении: у тех, кто работал на прежней строке-заглушке, ключ сменится, и всем
// один раз придётся заново войти в клиент. Это ожидаемо и происходит ровно один раз.
function resolveSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  let stored = getSettingRaw('jwt_secret');
  if (!stored) {
    stored = crypto.randomBytes(48).toString('hex');
    setSettingRaw('jwt_secret', stored);
    logServer('INFO', 'jwt_secret_generated', {});
  }
  return stored;
}
const SECRET = resolveSecret();

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
// Список файлов, лежащих сейчас в uploads. Раньше на каждый файл в каждом сообщении делался
// отдельный fs.existsSync — на странице истории в 200 сообщений это сотни синхронных обращений к
// диску, и все они блокируют единственный поток, в котором сервер обслуживает вообще всех. Одного
// чтения каталога хватает на все файлы запроса; короткий срок жизни кэша нужен только чтобы
// удаление файла из веб-панели отражалось практически сразу.
const UPLOADS_CACHE_MS = 2000;
let uploadsCache = { names: null, at: 0 };
function uploadedFileNames() {
  const now = Date.now();
  if (!uploadsCache.names || now - uploadsCache.at > UPLOADS_CACHE_MS) {
    try { uploadsCache = { names: new Set(fs.readdirSync(uploadsDir)), at: now }; }
    catch { uploadsCache = { names: new Set(), at: now }; }
  }
  return uploadsCache.names;
}
function invalidateUploadsCache() { uploadsCache = { names: null, at: 0 }; }
function fileExistsForUrl(url) {
  const diskName = String(url || '').split('/').pop();
  return !!diskName && uploadedFileNames().has(diskName);
}

// Список файлов, пришедший от клиента (в сообщении или в рассылке) — приводим к безопасному виду:
// только объекты с url, не больше 20 штук, все поля обрезаны по длине и приведены к нужному типу.
// Раньше это было продублировано в двух местах слово в слово.
function normalizeIncomingFiles(rawFiles) {
  if (!Array.isArray(rawFiles)) return [];
  return rawFiles.slice(0, 20)
    .filter((f) => f && typeof f === 'object' && typeof f.url === 'string' && f.url)
    .map((f) => ({
      url: f.url.slice(0, 300),
      name: (typeof f.name === 'string' && f.name ? f.name : 'файл').slice(0, 200),
      size: Number.isFinite(Number(f.size)) ? Number(f.size) : 0,
    }));
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
const listUsersFullStmt = db.prepare(`
  SELECT u.id, u.username, u.display_name, u.can_broadcast, u.can_admin, u.version
  FROM users u ORDER BY u.display_name
`);
const listUsersBasicStmt = db.prepare(`
  SELECT u.id, u.username, u.display_name FROM users u ORDER BY u.display_name
`);
// Отделы каждого сотрудника одним запросом на всех, а не подзапросом на строку: список людей
// отдаётся целиком и часто (ростер опрашивает его раз в 20 секунд), и N+1 запросов здесь ни к чему.
const listAllUserDepartments = db.prepare(`
  SELECT ud.user_id, d.id, d.name
  FROM user_departments ud JOIN departments d ON d.id = ud.department_id
  ORDER BY d.sort_order, d.id
`);
function departmentsByUser() {
  const map = new Map();
  for (const row of listAllUserDepartments.all()) {
    if (!map.has(row.user_id)) map.set(row.user_id, []);
    map.get(row.user_id).push({ id: row.id, name: row.name });
  }
  return map;
}
// departments — массив; поле department (первый отдел строкой) оставлено для совместимости со
// старыми сборками клиента, которые ещё не знают про несколько отделов.
function withDepartments(rows) {
  const map = departmentsByUser();
  return rows.map((u) => {
    const departments = map.get(u.id) || [];
    return { ...u, departments, department: departments.length ? departments[0].name : null };
  });
}
const listUsersFull = { all: () => withDepartments(listUsersFullStmt.all()) };
const listUsersBasic = { all: () => withDepartments(listUsersBasicStmt.all()) };
const listDepartmentsOfUser = db.prepare(`
  SELECT d.id, d.name FROM user_departments ud JOIN departments d ON d.id = ud.department_id
  WHERE ud.user_id = ? ORDER BY d.sort_order, d.id
`);
const listUserIdsInDepartment = db.prepare('SELECT user_id FROM user_departments WHERE department_id = ?');
const updateUserCaps = db.prepare('UPDATE users SET can_broadcast = ?, can_admin = ? WHERE id = ?');
const clearUserDepartments = db.prepare('DELETE FROM user_departments WHERE user_id = ?');
const linkUserDepartment = db.prepare('INSERT OR IGNORE INTO user_departments (user_id, department_id) VALUES (?, ?)');
const updateUserDept = db.prepare('UPDATE users SET department_id = ? WHERE id = ?');
// Единственное место, где меняется состав отделов сотрудника. Транзакция — чтобы человек ни на
// мгновение не оказался вообще без отделов, если запрос оборвётся на середине.
const setUserDepartments = db.transaction((userId, ids) => {
  const valid = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  clearUserDepartments.run(userId);
  for (const id of valid) linkUserDepartment.run(userId, id);
  // users.department_id больше ни на что не влияет, но пусть остаётся осмысленной: держим в ней
  // первый отдел, а не устаревшее значение с прошлого раза.
  updateUserDept.run(valid.length ? valid[0] : null, userId);
});
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

const insertBroadcast = db.prepare('INSERT INTO broadcasts (from_id, text, files_json, department_id, created_at) VALUES (?, ?, ?, ?, ?)');
// Какие объявления попадают в выборку. @department = NULL — обычная лента: объявления всей
// организации плюс сообщения отделов, в которых человек состоит. @department = число — лента
// одного отдела (окно "Сообщение отделу"); право её видеть проверяется в маршруте.
// Список отделов параметром не передаём — база и так его знает, а подставлять список переменной
// длины в IN (...) пришлось бы динамическим SQL.
// @all = 1 — вообще без ограничений: это веб-панель администратора, которая по своей задаче видит
// всю переписку организации (см. раздел "Чего здесь нет" в README сервера).
const BROADCAST_SCOPE = `(
  @all = 1
  OR (@department IS NULL AND (
    b.department_id IS NULL
    OR b.from_id = @viewer          -- своё написанное человек видит всегда, даже если писал в чужой отдел
    OR b.department_id IN (SELECT department_id FROM user_departments WHERE user_id = @viewer)
  ))
  OR (@department IS NOT NULL AND b.department_id = @department)
)`;
const BROADCAST_COLUMNS = `b.id, b.text, b.created_at, b.files_json, b.department_id, d.name AS department, u.display_name AS from_user`;
const BROADCAST_FROM = `FROM broadcasts b JOIN users u ON u.id = b.from_id LEFT JOIN departments d ON d.id = b.department_id`;

const recentBroadcasts = db.prepare(`
  SELECT ${BROADCAST_COLUMNS} ${BROADCAST_FROM}
  WHERE ${BROADCAST_SCOPE}
  ORDER BY b.id DESC LIMIT 50
`);
// LIMIT 300 + вложенный DESC/ASC: без ограничения тяжёлый день (например, стресс-тест рассылок)
// отдавал бы клиенту весь день целиком — сотни DOM-узлов с карточками файлов в ленте окна рассылок
// ощутимо замедляют рендер на слабых машинах. Берём последние 300 (внутренний DESC), но отдаём в
// привычном хронологическом порядке (внешний ASC), чтобы клиент, как и раньше, не пересортировывал.
const broadcastsRange = db.prepare(`
  SELECT * FROM (
    SELECT ${BROADCAST_COLUMNS} ${BROADCAST_FROM}
    WHERE b.created_at >= @since AND b.created_at < @until AND ${BROADCAST_SCOPE} ORDER BY b.id DESC LIMIT 300
  ) ORDER BY id ASC
`);
const broadcastsSearch = db.prepare(`
  SELECT ${BROADCAST_COLUMNS} ${BROADCAST_FROM}
  WHERE lower_ru(b.text) LIKE '%' || lower_ru(@q) || '%' AND ${BROADCAST_SCOPE} ORDER BY b.id DESC LIMIT 200
`);
const broadcastsDays = db.prepare(`
  SELECT strftime('%Y-%m-%d', datetime(b.created_at/1000, 'unixepoch', @tz)) AS day, COUNT(*) AS count
  ${BROADCAST_FROM} WHERE ${BROADCAST_SCOPE} GROUP BY day ORDER BY day DESC
`);
const isDepartmentMember = db.prepare('SELECT 1 FROM user_departments WHERE user_id = ? AND department_id = ?');
const getDepartment = db.prepare('SELECT id, name FROM departments WHERE id = ?');

const messagesCount = db.prepare('SELECT COUNT(*) AS c FROM messages');
const departmentsCount = db.prepare('SELECT COUNT(*) AS c FROM departments');

// ---------- HTTP API ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Файлы обновлений клиента ----------
// Клиент сам проверяет наличие новой версии и качает её отсюда (см. electron-updater в main.js
// десктоп-клиента). Отдельный сервер под это не нужен — у нас уже есть доступ ко всем машинам.
// Внутри — по папке на каждую сборку: updates/win7/ и updates/win10/. Раскладывать их обязательно
// раздельно: сборка для Windows 10 несёт Electron, который на Windows 7 просто не запускается,
// и клиент, скачавший чужое обновление, перестанет открываться.
// В каждой папке лежит то, что положил electron-builder: сам .exe и latest.yml с версией и
// контрольной суммой. Namespace без авторизации намеренно — это установочные файлы, не секрет,
// а клиенту на этапе обновления может быть уже нечем предъявить токен.
const updatesDir = path.join(__dirname, 'updates');
if (!fs.existsSync(updatesDir)) fs.mkdirSync(updatesDir, { recursive: true });
app.use('/updates', express.static(updatesDir));

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
  invalidateUploadsCache(); // иначе только что загруженный файл до 2 секунд считался бы удалённым
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
  // Сравниваем именно каталог файла с uploadsDir, а не начало строки пути: startsWith прошёл бы и
  // для соседнего каталога с похожим именем (uploads-old и т.п.). Тот же приём, что в DELETE ниже.
  if (path.dirname(filePath) !== uploadsDir || !fs.existsSync(filePath)) return res.sendStatus(404);
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

// Самостоятельная регистрация: кто угодно, дотянувшийся до порта сервера, заводит себе учётку и
// попадает в общую комнату и в список сотрудников. Для корпоративного мессенджера это обычно
// нежелательно — учётки должен раздавать администратор. Выключается в веб-панели (раздел
// «Сотрудники»). По умолчанию оставлена включённой, чтобы обновление не отрезало вход тем, у кого
// сейчас все так и регистрируются; рекомендация выключить — в README.
function registrationOpen() { return getSettingRaw('registration_open') !== '0'; }

app.post('/api/register', ipRateLimit({ windowMs: 60 * 60 * 1000, max: 10 }), (req, res) => {
  if (!registrationOpen()) {
    return res.status(403).json({ error: 'Самостоятельная регистрация отключена. Обратитесь к администратору за учётной записью.' });
  }
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

// Проверка "тот ли это адрес и отвечает ли сервер" — без входа, до всякого пароля. Нужна клиенту:
// служебное окно смены адреса (Ctrl+Shift+S в настройках) даёт нажать "Проверить" ДО сохранения,
// вместо того чтобы перезапускаться вслепую и выяснять это уже без связи. Ничего не раскрывает:
// по этому же адресу и так отдаётся страница входа в панель.
app.get('/api/ping', (req, res) => res.json({ ok: true, app: 'iskra', secure: Boolean(req.secure) }));

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
// Ограничение потока: рендерер шлёт сюда каждую свою ошибку, а ошибка внутри цикла отрисовки или
// переподключения повторяется десятки раз в секунду. Без потолка один сбойный клиент за ночь
// раздувает дневной лог до гигабайтов и забивает диск сервера. Разбирать инцидент хватает и
// нескольких десятков записей — остальные всё равно одинаковые.
const CLIENT_LOG_MAX_PER_MIN = 30;
const clientLogRate = new Map(); // userId -> { count, resetAt }
app.post('/api/client-log', auth, (req, res) => {
  const now = Date.now();
  let bucket = clientLogRate.get(req.user.id);
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + 60000 };
    clientLogRate.set(req.user.id, bucket);
  }
  bucket.count += 1;
  if (bucket.count > CLIENT_LOG_MAX_PER_MIN) {
    // Одна отметка на «пачку», чтобы в логе осталось видно сам факт шторма ошибок.
    if (bucket.count === CLIENT_LOG_MAX_PER_MIN + 1) {
      logServer('WARN', 'client_log_flood', { userId: req.user.id, username: req.user.username });
    }
    return res.json({ ok: true });
  }
  const { kind, message, extra, source, hostname, level } = req.body || {};
  logClient({
    // Клиент сам говорит, насколько это серьёзно. Раньше всё присланное считалось ошибкой, и
    // «на сервере ещё нет файлов обновления» — обычное состояние до первого выпуска — попадало в
    // журнал красным с каждой машины при каждом запуске. Чужому значению не доверяем: всё, кроме
    // явных WARN/INFO, остаётся ERROR.
    level: ['WARN', 'INFO'].includes(level) ? level : 'ERROR',
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

// ---------- Журнал с конкретной машины ----------
// Ошибки внутри окон рендереры шлют сюда сами по мере возникновения (см. /api/client-log выше). Но
// у клиента есть и второй журнал — локальный client.log главного процесса, куда попадает то, что
// рендерер отправить уже не может: падения самого окна и сбои обновления. Раньше он оставался на
// машине сотрудника, и добраться до него можно было, только придя к человеку за компьютер.
// Теперь администратор запрашивает его из веб-панели, клиент отвечает вот сюда.
const clientLogDumps = new Map(); // "userId:hostname" -> { at, username, hostname, text }
const CLIENT_LOG_DUMP_LIMIT = 400 * 1024;

app.post('/api/client-log-file', auth, express.text({ limit: '2mb', type: () => true }), (req, res) => {
  const hostname = String(req.query.host || '?').slice(0, 64);
  const text = String(req.body || '').slice(-CLIENT_LOG_DUMP_LIMIT); // хвост: интересен конец, а не начало
  clientLogDumps.set(`${req.user.id}:${hostname}`, {
    at: Date.now(), username: req.user.username, hostname, text,
  });
  logServer('INFO', 'client_log_received', { userId: req.user.id, hostname, bytes: text.length });
  res.json({ ok: true });
});

app.get('/api/admin/client-log', auth, requireCapability('can_admin'), (req, res) => {
  const key = `${Number(req.query.userId)}:${String(req.query.host || '')}`;
  const dump = clientLogDumps.get(key);
  if (!dump) return res.status(404).json({ error: 'Журнал с этой машины ещё не получен' });
  res.json(dump);
});

// ---------- Профиль (свой аккаунт) ----------
app.get('/api/me', auth, (req, res) => res.json({ ...req.user, departments: listDepartmentsOfUser.all(req.user.id) }));
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
// Лента отдела видна только его сотрудникам: отправитель, пишущий в "Бухгалтерию", рассчитывает,
// что читает это бухгалтерия, а не все подряд. Написать отделу может кто угодно (см. POST ниже) —
// а вот листать чужую переписку незачем.
function departmentScope(req, res) {
  const raw = req.query.departmentId;
  // Панель администратора просит всю ленту целиком — но только если права действительно есть.
  const all = req.query.all === '1' && !!req.user.can_admin ? 1 : 0;
  if (raw === undefined || raw === '') return { department: null, all };
  const department = Number(raw);
  if (!Number.isInteger(department) || department <= 0) {
    res.status(400).json({ error: 'Неверный отдел' });
    return null;
  }
  if (!isDepartmentMember.get(req.user.id, department) && !req.user.can_admin) {
    res.status(403).json({ error: 'Лента отдела видна только его сотрудникам' });
    return null;
  }
  return { department, all };
}

app.get('/api/broadcasts', auth, (req, res) => {
  const scope = departmentScope(req, res);
  if (!scope) return;
  const base = { viewer: req.user.id, department: scope.department, all: scope.all };
  const { since, until, q } = req.query;
  if (q) return res.json(broadcastsSearch.all({ ...base, q: String(q) }).reverse().map(normalizeRow));
  if (since && until) return res.json(broadcastsRange.all({ ...base, since: Number(since), until: Number(until) }).map(normalizeRow)); // уже ASC из SQL
  res.json(recentBroadcasts.all(base).reverse().map(normalizeRow));
});
app.get('/api/broadcasts/days', auth, (req, res) => {
  const scope = departmentScope(req, res);
  if (!scope) return;
  res.json(broadcastsDays.all({ viewer: req.user.id, department: scope.department, all: scope.all, tz: tzModifier(req) }));
});

// Объявление всей организации — по-прежнему право can_broadcast. Сообщение отделу — доступно всем:
// новой досягаемости оно не даёт (написать каждому сотруднику отдела по одному человек и так может,
// список людей открыт), а экономит десяток одинаковых сообщений. Отправитель везде подписан именем.
app.post('/api/broadcast', auth, (req, res) => {
  const text = String((req.body || {}).text || '').slice(0, 4000).trim();
  const files = normalizeIncomingFiles((req.body || {}).files);
  const rawDepartment = (req.body || {}).departmentId;
  if (!text && !files.length) return res.status(400).json({ error: 'Пустая рассылка' });

  let department = null;
  if (rawDepartment !== undefined && rawDepartment !== null && rawDepartment !== '') {
    department = Number(rawDepartment);
    if (!Number.isInteger(department) || department <= 0 || !getDepartment.get(department)) {
      return res.status(400).json({ error: 'Такого отдела нет' });
    }
  } else if (!req.user.can_broadcast) {
    return res.status(403).json({ error: 'Нет права на рассылку всей организации' });
  }

  const now = Date.now();
  const filesJson = files.length ? JSON.stringify(files) : null;
  insertBroadcast.run(req.user.id, text, filesJson, department, now);
  const payload = JSON.stringify({
    type: 'broadcast',
    from_user: req.user.display_name,
    text, files, created_at: now,
    department_id: department,
    department: department ? getDepartment.get(department).name : null,
  });
  if (department) {
    // Отправителю — тоже: он мог написать в отдел, в котором сам не состоит, и без этого его
    // собственное сообщение не появилось бы у него в ленте до перезагрузки окна.
    const recipients = new Set(listUserIdsInDepartment.all(department).map((r) => r.user_id));
    recipients.add(req.user.id);
    for (const userId of recipients) sendToUser(userId, payload);
    logServer('INFO', 'department_broadcast', { fromId: req.user.id, departmentId: department, recipients: recipients.size });
  } else {
    sendToAll(payload);
  }
  res.json({ ok: true });
});

// ---------- Админка ----------
app.get('/api/admin/users', auth, requireCapability('can_admin'), (req, res) => res.json(listUsersFull.all()));

// Кто сейчас в сети и с каких машин. То же самое рассылается по WebSocket, но
// панель администратора открывают и через прокси платформы, где апгрейд до WS
// не пробрасывается, — а список пользователей должен показывать статус в любом
// случае. Отдаём снимок целиком: он маленький и считается по памяти процесса.
app.get('/api/admin/presence', auth, requireCapability('can_admin'), (req, res) => {
  // connections — сколько сокетов сервер видит прямо сейчас. Без этого числа
  // список, где все «не в сети», ничего не объясняет: непонятно, панель ли
  // сломалась, или клиенты действительно не подключены (например, не проходит
  // рукопожатие TLS). Ноль соединений при работающих клиентах — это ответ.
  res.json({ users: presenceSnapshot(), connections: connMeta.size });
});

// Включение/выключение самостоятельной регистрации (см. registrationOpen выше).
app.get('/api/admin/registration', auth, requireCapability('can_admin'), (req, res) => {
  res.json({ open: registrationOpen() });
});
app.patch('/api/admin/registration', auth, requireCapability('can_admin'), (req, res) => {
  const open = !!(req.body || {}).open;
  setSettingRaw('registration_open', open ? '1' : '0');
  logServer('INFO', 'registration_toggled', { adminId: req.user.id, open });
  res.json({ open });
});

app.post('/api/admin/users', auth, requireCapability('can_admin'), (req, res) => {
  const { username, password, department_id, department_ids, can_broadcast, can_admin } = req.body || {};
  if (!username || !password || password.length < 4) return res.status(400).json({ error: 'Логин и пароль (мин. 4 символа) обязательны' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = insertUser.run(username, hash, username, can_broadcast ? 1 : 0, can_admin ? 1 : 0, Date.now());
    invalidateUserIdsCache();
    // department_id — старая форма запроса (один отдел); принимаем обе, чтобы не ломать ничего,
    // что обращается к API напрямую.
    const ids = Array.isArray(department_ids) ? department_ids : (department_id ? [department_id] : []);
    if (ids.length) setUserDepartments(info.lastInsertRowid, ids);
    broadcastUsersChanged();
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch {
    res.status(409).json({ error: 'Такой логин уже занят' });
  }
});

app.patch('/api/admin/users/:id', auth, requireCapability('can_admin'), (req, res) => {
  const id = Number(req.params.id);
  const { department_id, department_ids, password, display_name, can_broadcast, can_admin, version } = req.body || {};
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
  if (department_ids !== undefined) setUserDepartments(id, department_ids);
  else if (department_id !== undefined) setUserDepartments(id, department_id ? [department_id] : []);
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
  // Внешние ключи в SQLite здесь не включены (PRAGMA foreign_keys), поэтому связи чистим руками —
  // иначе строки в user_departments пережили бы самого сотрудника и всплыли бы у нового с тем же id.
  clearUserDepartments.run(id);
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
  const id = Number(req.params.id);
  db.prepare('DELETE FROM user_departments WHERE department_id = ?').run(id); // см. комментарий у удаления сотрудника
  deleteDepartmentStmt.run(id);
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
  // Имена авторов запрашиваем по одному разу на человека, а не на каждый файл: у активной
  // организации файлов тысячи, а отправителей — десятки.
  const nameCache = new Map();
  const userName = (id) => {
    if (!nameCache.has(id)) nameCache.set(id, (getUserById.get(id) || {}).display_name || `#${id}`);
    return nameCache.get(id);
  };
  const groupNames = new Map(db.prepare('SELECT id, name FROM groups').all().map((g) => [g.id, g.name]));

  const msgs = db.prepare('SELECT from_id, room, to_id, files_json, created_at FROM messages WHERE files_json IS NOT NULL').all();
  for (const m of msgs) {
    let files = [];
    try { files = JSON.parse(m.files_json); } catch { continue; }
    // Раньше любая комната подписывалась как «общая комната» — с появлением групп это стало
    // неправдой: файл из закрытой группы выглядел в панели как выложенный всей организации.
    let context = 'личная переписка';
    if (isGroupRoom(m.room)) context = `группа «${groupNames.get(groupIdFromRoom(m.room)) || '?'}»`;
    else if (m.room) context = 'общая комната';
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
  invalidateUploadsCache();
  logServer('INFO', 'file_deleted', { adminId: req.user.id, diskName });
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

// ---------- Обновления клиентов ----------
// Под этим именем к серверу подключается веб-панель администратора (см. connectPresenceWs в
// public/index.html) — рабочим местом она не является.
const ADMIN_WEB_HOSTNAME = 'Веб-панель администратора';
// Какая версия сейчас выложена на сервере — читаем прямо из latest.yml, который положил
// electron-builder. Полноценный разбор YAML ради одного поля не нужен и потянул бы зависимость:
// строка "version: 1.0.1" в этом файле всегда первая и всегда такого вида.
function publishedVersion(track) {
  try {
    const text = fs.readFileSync(path.join(updatesDir, track, 'latest.yml'), 'utf8');
    const m = text.match(/^version:\s*(\S+)/m);
    const f = text.match(/^path:\s*(\S+)/m);
    return m ? { version: m[1], file: f ? f[1] : null } : null;
  } catch { return null; }
}
app.get('/api/admin/update-published', auth, requireCapability('can_admin'), (req, res) => {
  res.json({ win7: publishedVersion('win7'), win10: publishedVersion('win10') });
});

// Кто сейчас на связи и с какой версией. Один человек может сидеть с нескольких компьютеров и
// держать несколько окон — схлопываем по паре "сотрудник + компьютер", иначе в списке было бы по
// строке на каждое открытое окно чата.
app.get('/api/admin/clients', auth, requireCapability('can_admin'), (req, res) => {
  const byMachine = new Map();
  for (const meta of connMeta.values()) {
    // Сама веб-панель тоже держит подключение (чтобы показывать, кто в сети), но это не рабочее
    // место: обновлять там нечего и журнала у неё нет. В списке машин она была бы только шумом.
    if (meta.hostname === ADMIN_WEB_HOSTNAME) continue;
    const key = `${meta.userId}:${meta.hostname}`;
    const prev = byMachine.get(key);
    if (!prev) {
      const u = getUserById.get(meta.userId);
      byMachine.set(key, {
        userId: meta.userId,
        user: u ? u.display_name : `#${meta.userId}`,
        hostname: meta.hostname,
        version: meta.appVersion || null,
        track: meta.buildTrack || null,
        connections: 1,
        hasLogDump: clientLogDumps.has(key),
      });
    } else {
      prev.connections += 1;
      // Версию берём с того подключения, которое её сообщило: у окон, открытых старым клиентом
      // после обновления сборки, её может не быть.
      if (!prev.version && meta.appVersion) { prev.version = meta.appVersion; prev.track = meta.buildTrack; }
    }
  }
  res.json([...byMachine.values()].sort((a, b) => a.user.localeCompare(b.user, 'ru')));
});

// Принудительное обновление конкретной машины. Отправляем команду во все её подключения — клиент
// скачает обновление и перезапустится сам (см. force-update в main.js десктоп-клиента).
app.post('/api/admin/force-update', auth, requireCapability('can_admin'), (req, res) => {
  const { userId, host } = req.body || {};
  const target = toUserId(userId);
  if (!target) return res.status(400).json({ error: 'Не указан сотрудник' });
  const out = JSON.stringify({ type: 'force-update' });
  let sent = 0;
  for (const [ws, meta] of connMeta) {
    if (meta.userId !== target) continue;
    if (host && meta.hostname !== host) continue;
    sendTo(ws, out);
    sent += 1;
  }
  logServer('INFO', 'force_update_requested', { adminId: req.user.id, userId: target, host, connections: sent });
  if (!sent) return res.status(409).json({ error: 'Этот клиент сейчас не в сети' });
  res.json({ ok: true, sent });
});

// Запрос журнала с машины сотрудника — клиент пришлёт его на /api/client-log-file (см. выше).
app.post('/api/admin/request-log', auth, requireCapability('can_admin'), (req, res) => {
  const { userId, host } = req.body || {};
  const target = toUserId(userId);
  if (!target) return res.status(400).json({ error: 'Не указан сотрудник' });
  const out = JSON.stringify({ type: 'send-log' });
  let sent = 0;
  for (const [ws, meta] of connMeta) {
    if (meta.userId !== target) continue;
    if (host && meta.hostname !== host) continue;
    sendTo(ws, out);
    sent += 1;
  }
  logServer('INFO', 'client_log_requested', { adminId: req.user.id, userId: target, host });
  if (!sent) return res.status(409).json({ error: 'Этот клиент сейчас не в сети' });
  res.json({ ok: true });
});

// ---------- Сертификат сервера (раздел "Сертификат" в панели) ----------
// Сертификат домена выдаётся на два года, корневой — на десять. Раз менять их всё равно придётся,
// пусть это делается там же, где видно, что сейчас установлено, — а не правкой переменных
// окружения на сервере по инструкции из README, которую в этот момент никто не найдёт.
app.get('/api/admin/tls', auth, requireCapability('can_admin'), async (req, res) => {
  const clientRoot = clientRootFingerprint();
  const inStore = fs.existsSync(CERT_STORE_PFX);
  // Что лежит в хранилище — отдельно от того, что действует сейчас. Эти две вещи расходятся ровно
  // в одном случае: сертификат загрузили на сервер, работающий по http. Файл принят, но включится
  // он только с перезапуском — и об этом администратору надо сказать прямо, а не показать пустоту.
  let stored = null;
  if (inStore) {
    try {
      stored = await inspectTlsOptions(resolveTlsOptions().options);
    } catch (err) {
      stored = { error: String((err && err.message) || err) };
    }
  }
  const active = currentCertificate;
  res.json({
    enabled: server instanceof https.Server,
    source: tlsSource,                              // store | env-pfx | env-pem | null
    envAlsoSet: tlsSource === 'store' ? envTlsSource() : null, // "двойная настройка", см. envTlsSource
    storeHasCertificate: inStore,
    restartRequired: inStore && tlsSource !== 'store',
    requestSecure: Boolean(req.secure),             // сама панель сейчас открыта по https или нет
    certificate: active,
    stored,
    clientRootFingerprint: clientRoot,
    rootMatchesClient: clientRoot && active && active.rootFingerprint
      ? clientRoot === active.rootFingerprint
      : null,
  });
});

// Замена сертификата. Файл сначала разбирается (в том числе проверяется пароль и срок), и только
// потом попадает на диск: испортить работающий сервер загрузкой не того файла нельзя.
app.post('/api/admin/tls', auth, requireCapability('can_admin'), async (req, res) => {
  const { pfx, password } = req.body || {};
  if (!pfx || typeof pfx !== 'string') return res.status(400).json({ error: 'Файл не передан' });

  let buffer;
  try {
    buffer = Buffer.from(pfx, 'base64');
  } catch {
    return res.status(400).json({ error: 'Файл повреждён при передаче' });
  }
  if (!buffer.length) return res.status(400).json({ error: 'Файл пустой' });

  const options = { pfx: buffer };
  if (password) options.passphrase = String(password);

  let info;
  try {
    info = await inspectTlsOptions(options);
  } catch (err) {
    const raw = String((err && err.message) || err);
    logServer('WARN', 'tls_upload_rejected', { adminId: req.user.id, error: raw });
    // "mac verify failure" означает ровно одно — пароль не тот (или файл не PFX). Показывать
    // администратору эту фразу бессмысленно, он не обязан знать, что такое MAC.
    if (/mac verify failure/i.test(raw)) {
      return res.status(400).json({ error: password ? 'Неверный пароль к файлу' : 'Файл защищён паролем — укажите его' });
    }
    return res.status(400).json({ error: 'Это не похоже на PFX-файл с сертификатом и ключом' });
  }

  if (info.daysLeft !== null && info.daysLeft < 0) {
    return res.status(400).json({ error: `Срок действия этого сертификата истёк ${info.validTo}` });
  }

  // Загрузка закрытого ключа по незашифрованному каналу — ровно тот случай, когда его может
  // перехватить кто угодно в сети. Запретить нельзя (первую установку иначе и не сделать), но
  // и промолчать нельзя: пусть останется в журнале.
  if (!req.secure) {
    logServer('WARN', 'tls_upload_over_http', {
      adminId: req.user.id,
      ip: req.ip,
      hint: 'Закрытый ключ передан по незашифрованному каналу. Если сеть недоверенная — перевыпустите сертификат',
    });
  }

  try {
    ensureCertsDir();
    // Один шаг назад на случай, если новый файл окажется не тем: старый не затирается насовсем.
    if (fs.existsSync(CERT_STORE_PFX)) fs.copyFileSync(CERT_STORE_PFX, CERT_STORE_PFX + '.bak');
    if (fs.existsSync(CERT_STORE_PASS)) fs.copyFileSync(CERT_STORE_PASS, CERT_STORE_PASS + '.bak');
    fs.writeFileSync(CERT_STORE_PFX, buffer, { mode: 0o600 });
    if (password) fs.writeFileSync(CERT_STORE_PASS, String(password), { mode: 0o600 });
    else if (fs.existsSync(CERT_STORE_PASS)) fs.unlinkSync(CERT_STORE_PASS);
  } catch (err) {
    logServer('ERROR', 'tls_store_write_failed', { error: String((err && err.message) || err) });
    return res.status(500).json({ error: 'Не удалось сохранить файл на диск сервера' });
  }

  // Уже работающему https-серверу сертификат можно заменить на ходу: новые соединения пойдут с
  // новым, уже открытые доживут со старым. Перезапуск нужен только при первой установке —
  // http-сервер превратить в https без него нельзя.
  let applied = false;
  if (server instanceof https.Server && typeof server.setSecureContext === 'function') {
    try {
      server.setSecureContext(options);
      applied = true;
      tlsSource = 'store';
      currentCertificate = info;
    } catch (err) {
      logServer('ERROR', 'tls_apply_failed', { error: String((err && err.message) || err) });
    }
  }

  logServer('INFO', 'tls_certificate_replaced', {
    adminId: req.user.id,
    subject: info.subject,
    san: info.san,
    issuer: info.issuer,
    valid_to: info.validTo,
    days_left: info.daysLeft,
    certificates: info.certificates,
    applied,
  });

  const clientRoot = clientRootFingerprint();
  res.json({
    ok: true,
    applied,                       // false — файл сохранён, но нужен перезапуск сервера
    certificate: info,
    rootMatchesClient: clientRoot && info.rootFingerprint ? clientRoot === info.rootFingerprint : null,
  });
});

// Убрать сертификат из хранилища. Работающий сервер при этом остаётся на https до перезапуска —
// выключить шифрование на ходу нельзя, да и не нужно.
app.delete('/api/admin/tls', auth, requireCapability('can_admin'), (req, res) => {
  try {
    for (const file of [CERT_STORE_PFX, CERT_STORE_PASS]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  } catch (err) {
    return res.status(500).json({ error: 'Не удалось удалить файл: ' + String((err && err.message) || err) });
  }
  // Удаление из хранилища НЕ означает "теперь без шифрования": если сертификат задан ещё и
  // переменной окружения, после перезапуска сервер возьмёт его оттуда — и со стороны это выглядит
  // так, будто удаление не сработало. Поэтому сразу считаем и возвращаем, что реально будет дальше.
  const next = resolveTlsOptions();
  logServer('WARN', 'tls_certificate_removed', { adminId: req.user.id, next_source: next ? next.source : null });
  res.json({ ok: true, nextSource: next ? next.source : null, nextWhere: next ? next.where : null });
});

// PFX больше стандартного лимита express.json() — ответ должен остаться JSON, иначе панель
// покажет кусок HTML вместо понятной ошибки.
app.use('/api/admin/tls', (err, req, res, next) => {
  if (err) return res.status(413).json({ error: 'Файл слишком большой для загрузки через панель' });
  next();
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
  // Уровень присылает сам клиент (см. logLocal в main.js). У записей, сделанных прежними сборками,
  // его нет — там по-прежнему ERROR, как и раньше.
  return { ts, level: meta.level || 'ERROR', source: 'client', event: meta.kind || 'client_error', meta };
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

// ---------- HTTPS ----------
// TLS разворачивает сам сервер — обратного прокси перед ним нет намеренно. Так не остаётся
// параллельного незашифрованного порта, про который легко забыть (а он обнулил бы весь смысл),
// не нужно отдельно пробрасывать WebSocket, и req.ip остаётся настоящим адресом сотрудника,
// от которого зависит защита от подбора пароля.
//
// Шифрование включается САМО, как только задан сертификат, — отдельного переключателя нет,
// чтобы не было состояния "сертификат положили, а включить забыли". Ничего не задано — сервер
// работает по http, как раньше (нужно для локальной разработки и до момента установки сертификата).
//
// Три способа задать сертификат, работает любой (проверяются в этом же порядке):
//
//   1. Хранилище certs/ — сюда кладёт файл веб-панель, раздел "Сертификат". Основной способ:
//      сертификат домена живёт два года, корневой — десять, менять их придётся, и лезть за этим
//      на сервер в консоль не нужно.
//
//   2. PFX (.pfx / .p12) из переменных окружения — то, что выдаёт удостоверяющий центр
//      Windows-домена как есть. Конвертировать ничего не нужно, Node читает этот формат сам:
//
//        set TLS_PFX=C:\iskra\server.pfx
//        set TLS_PFX_PASSWORD=пароль-которым-защищён-файл
//        npm start
//
//   3. PEM — отдельно сертификат и ключ (обычный вариант для Linux):
//
//        TLS_CERT=/etc/iskra/fullchain.crt TLS_KEY=/etc/iskra/server.key npm start
//
//      Здесь TLS_CERT — обязательно ПОЛНАЯ цепочка (сертификат сервера + промежуточные УЦ), а не
//      только сертификат сервера, и ключ должен быть без пароля, иначе сервер не поднимется без
//      ручного ввода при каждом запуске.
//
// Пароль от PFX — в переменной окружения, в скрипте запуска или в хранилище certs/ рядом с самим
// файлом; в репозитории ему не место (certs/ и *.pfx внесены в .gitignore).
const TLS_PFX = process.env.TLS_PFX;
const TLS_PFX_PASSWORD = process.env.TLS_PFX_PASSWORD;
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;

// Хранилище сертификата, которым управляет веб-панель (раздел "Сертификат"). Сертификат домена
// выдаётся на два года, а корневой — на десять: рано или поздно и тот и другой придётся менять, и
// делать это через правку переменных окружения на сервере неудобно ровно тогда, когда это нужно.
// Приоритет у хранилища, а не у переменных окружения: администратор, заменивший сертификат из
// панели, вправе рассчитывать, что заменился именно он. Чтобы это не превратилось в "поменял
// переменную, а ничего не изменилось", источник пишется в журнал при каждом запуске и виден в
// панели.
const certsDir = path.join(__dirname, 'certs');
const CERT_STORE_PFX = path.join(certsDir, 'server.pfx');
const CERT_STORE_PASS = path.join(certsDir, 'server.pass');

// Внутри .pfx лежит закрытый ключ. Права на папку — только владельцу процесса; на Windows chmod
// почти ничего не значит (там ACL), поэтому это подстраховка для Linux, а не полная защита.
function ensureCertsDir() {
  if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(certsDir, 0o700); } catch { /* Windows — здесь правами управляют ACL */ }
}

// Откуда брать сертификат. Возвращает null, если его нет нигде — тогда сервер работает по http.
function resolveTlsOptions() {
  if (fs.existsSync(CERT_STORE_PFX)) {
    const options = { pfx: fs.readFileSync(CERT_STORE_PFX) };
    if (fs.existsSync(CERT_STORE_PASS)) options.passphrase = fs.readFileSync(CERT_STORE_PASS, 'utf8');
    return { options, source: 'store', where: CERT_STORE_PFX };
  }
  if (TLS_PFX) {
    const options = { pfx: fs.readFileSync(TLS_PFX) };
    if (TLS_PFX_PASSWORD) options.passphrase = TLS_PFX_PASSWORD;
    return { options, source: 'env-pfx', where: TLS_PFX };
  }
  if (TLS_CERT && TLS_KEY) {
    return {
      options: { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) },
      source: 'env-pem',
      where: TLS_CERT,
    };
  }
  return null;
}

let tlsSource = null; // что реально сейчас используется — показывается в панели

// Задан ли сертификат ещё и переменными окружения. Нужно, чтобы предупредить о "двойной настройке":
// пока файл лежит в хранилище, действует он, а переменная стоит в тени и ничем себя не проявляет —
// ровно до того дня, когда файл из хранилища удалят и обнаружат, что сервер всё так же на https.
function envTlsSource() {
  if (TLS_PFX) return 'env-pfx';
  if (TLS_CERT && TLS_KEY) return 'env-pem';
  return null;
}

function createAppServer() {
  let resolved;
  try {
    resolved = resolveTlsOptions();
  } catch (err) {
    logServer('ERROR', 'tls_unreadable', { error: String((err && err.message) || err) });
    throw err;
  }
  if (!resolved) {
    logServer('WARN', 'tls_disabled', { reason: 'сертификат не задан — трафик идёт открытым текстом' });
    return http.createServer(app);
  }
  // Пароль не подошёл или файл битый — это выясняется здесь, при запуске, а не при первом
  // подключении сотрудника.
  try {
    tls.createSecureContext(resolved.options);
  } catch (err) {
    logServer('ERROR', 'tls_pfx_unreadable', {
      source: resolved.source,
      where: resolved.where,
      reason: resolved.options.passphrase
        ? 'файл не читается — вероятно, неверный пароль'
        : 'файл не читается — вероятно, он защищён паролем, а пароль не задан',
      error: String((err && err.message) || err),
    });
    throw err;
  }
  tlsSource = resolved.source;
  logServer('INFO', 'tls_enabled', { source: resolved.source, where: resolved.where });
  if (resolved.source === 'store' && envTlsSource()) {
    logServer('WARN', 'tls_shadow_config', {
      shadowed: envTlsSource(),
      hint: 'Сертификат задан и в хранилище certs/, и переменными окружения. Действует хранилище; переменная вступит в силу, только если файл из хранилища удалить. Уберите её из скрипта запуска, чтобы управление было в одном месте',
    });
  }
  return https.createServer(resolved.options, app);
}

// ---------- Что сервер РЕАЛЬНО отдаёт клиенту ----------
// Из PFX содержимое цепочки снаружи не видно, а в PEM легко положить лишнее — поэтому смотрим не в
// файл, а на результат: поднимаем сертификат в настоящем TLS-сервере, подключаемся к нему и
// разбираем то, что он предъявил. Так же проверяется и файл, который администратор только что
// загрузил в панель, — ещё до того, как он станет действующим.
function describeChain(peer) {
  const chain = [];
  let cert = peer;
  while (cert && cert.fingerprint256 && !chain.some((c) => c.fingerprint256 === cert.fingerprint256)) {
    chain.push(cert);
    cert = cert.issuerCertificate;
  }
  const leaf = chain[0] || {};
  const last = chain[chain.length - 1] || {};
  const selfSignedRoot = Boolean(last.subject && last.issuer && JSON.stringify(last.subject) === JSON.stringify(last.issuer));
  const validTo = leaf.valid_to ? new Date(leaf.valid_to) : null;
  return {
    subject: (leaf.subject && leaf.subject.CN) || null,
    san: leaf.subjectaltname || null,
    issuer: (leaf.issuer && leaf.issuer.CN) || null,
    validFrom: leaf.valid_from || null,
    validTo: leaf.valid_to || null,
    daysLeft: validTo ? Math.round((validTo - Date.now()) / 86400000) : null,
    fingerprint: leaf.fingerprint256 || null,
    rootSubject: (last.subject && last.subject.CN) || null,
    rootFingerprint: last.fingerprint256 || null,
    certificates: chain.length,
    chainComplete: selfSignedRoot,
  };
}

// Разбор произвольного сертификата (например, только что загруженного) без его установки.
function inspectTlsOptions(options) {
  return new Promise((resolve, reject) => {
    let probe;
    try {
      probe = tls.createServer(options, (socket) => socket.end());
    } catch (err) { return reject(err); }
    const fail = (err) => { try { probe.close(); } catch { /* уже закрыт */ } reject(err); };
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const socket = tls.connect({ host: '127.0.0.1', port: probe.address().port, rejectUnauthorized: false }, () => {
        let info;
        try { info = describeChain(socket.getPeerCertificate(true)); } catch (err) { socket.destroy(); return fail(err); }
        socket.destroy();
        probe.close(() => resolve(info));
      });
      socket.on('error', fail);
    });
  });
}

// Последнее, что удалось узнать о действующем сертификате: панель показывает это, не трогая сеть.
let currentCertificate = null;

// Корневой сертификат, вшитый в сборку клиента. Если сервер подписан уже другим корнем, клиенты
// перестанут ему доверять — а выяснится это только тогда, когда у людей перестанет открываться
// приложение. Поэтому сравниваем сами и показываем в панели.
function clientRootFingerprint() {
  const file = path.join(__dirname, '..', 'desktop-client', 'rosstat-root-ca.crt');
  try {
    return new crypto.X509Certificate(fs.readFileSync(file)).fingerprint256;
  } catch {
    return null; // на боевом сервере папки клиента может не быть — это не ошибка
  }
}

// Смысл проверки при старте — в двух вещах, каждая из которых иначе всплывает сильно позже и не
// там, где причина:
//   * имя в SAN должно дословно совпадать с адресом в desktop-client/config.js, иначе клиент
//     отвергнет соединение по несовпадению имени;
//   * если цепочка обрывается на сертификате, который сам себя не подписывал, значит промежуточных
//     УЦ в ней не хватает. Браузеры на доменных машинах иногда дотягивают недостающее сами, а Node
//     (то есть автообновление клиента) — никогда: в браузере всё выглядит исправно, а обновления
//     молча не идут.
async function reportTlsCertificate() {
  try {
    const resolved = resolveTlsOptions();
    if (!resolved) return;
    currentCertificate = await inspectTlsOptions(resolved.options);
    logServer('INFO', 'tls_certificate', {
      subject: currentCertificate.subject,
      san: currentCertificate.san,
      issuer: currentCertificate.issuer,
      valid_to: currentCertificate.validTo,
      days_left: currentCertificate.daysLeft,
      certificates: currentCertificate.certificates,
    });
    if (!currentCertificate.chainComplete) {
      logServer('WARN', 'tls_chain_incomplete', {
        certificates: currentCertificate.certificates,
        hint: 'Сервер не отдаёт полную цепочку до корневого УЦ. Для PFX — экспортируйте его вместе со всеми сертификатами пути; для PEM — cat server.crt chain.crt > fullchain.crt',
      });
    }
    const clientRoot = clientRootFingerprint();
    if (clientRoot && currentCertificate.rootFingerprint && clientRoot !== currentCertificate.rootFingerprint) {
      logServer('WARN', 'tls_root_differs_from_client', {
        server_root: currentCertificate.rootSubject,
        hint: 'Сервер подписан не тем корневым УЦ, который вшит в сборку клиента. Замените desktop-client/rosstat-root-ca.crt и пересоберите установщики, иначе клиенты перестанут доверять серверу',
      });
    }
    warnIfExpiring();
  } catch (err) {
    logServer('WARN', 'tls_check_failed', { error: String((err && err.message) || err) });
  }
}

// Автопродления нет: сертификат перевыпускают руками, и единственный способ не проспать это —
// напоминать заранее. Раз в сутки, начиная за 30 дней.
function warnIfExpiring() {
  if (!currentCertificate || currentCertificate.daysLeft === null) return;
  if (currentCertificate.daysLeft > 30) return;
  logServer(currentCertificate.daysLeft <= 0 ? 'ERROR' : 'WARN', 'tls_certificate_expiring', {
    subject: currentCertificate.subject,
    valid_to: currentCertificate.validTo,
    days_left: currentCertificate.daysLeft,
    hint: 'Выпустите новый сертификат в удостоверяющем центре домена и загрузите его в панели, раздел "Сертификат"',
  });
}
setInterval(warnIfExpiring, 24 * 60 * 60 * 1000).unref();

const server = createAppServer();
const wss = new WebSocketServer({ server });

const online = new Map();   // userId -> Set(ws)              — для маршрутизации сообщений
const connMeta = new Map(); // ws -> { userId, hostname, state } — для presence (может быть несколько ПК на юзера)

// Отправка в сокет всегда через это, а не ws.send() напрямую. Между обрывом связи и событием
// 'close' сокет какое-то время ещё числится в connMeta, но писать в него уже нельзя — а рассылок
// "всем подключённым" здесь много, и попасть в этот промежуток тем легче, чем больше людей онлайн.
// Ошибку при этом гасим: недоставленное сообщение отдельному отвалившемуся клиенту не повод
// прерывать рассылку остальным.
function sendTo(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try { ws.send(payload); } catch { /* сокет закрылся между проверкой и отправкой */ }
}
function sendToAll(payload) {
  for (const ws of connMeta.keys()) sendTo(ws, payload);
}
function sendToUser(userId, payload) {
  const conns = online.get(userId);
  if (conns) for (const ws of conns) sendTo(ws, payload);
}

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

    // Живое соединение — это уже «в сети». Раньше состояние выводилось ТОЛЬКО из
    // meta.state, и запись оставалась 'offline', если состояние оказывалось
    // чем-то третьим: человек значился не в сети, хотя его сокет висел прямо
    // здесь, в этом же цикле. Теперь «не в сети» может получиться единственным
    // способом — когда соединений нет вовсе.
    if (meta.state === 'idle') {
      if (entry.state !== 'active') {
        entry.state = 'idle';
        // Если у пользователя несколько ПК и оба "отошли" — берём более раннее время, т.е. самый
        // давний по времени переход в AFK (человек отошёл ото всех, начиная с этого момента).
        if (meta.idleSince && (!entry.idleSince || meta.idleSince < entry.idleSince)) entry.idleSince = meta.idleSince;
      }
    } else {
      entry.state = 'active';
      entry.idleSince = null;
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

// Клиенты присылают свой статус каждые 15 секунд, и раньше КАЖДЫЙ такой тик рассылал полный
// снимок присутствия всем подключённым. При 200 сотрудниках это 200 снимков в 15 секунд, каждый
// размером со список всех пользователей, каждый — всем 200 адресатам: трафик растёт как квадрат
// численности, хотя сам статус почти всегда не меняется. Сравниваем с прошлым снимком и молчим,
// если он тот же — рассылка идёт только когда кто-то реально появился, отошёл или отключился.
let lastPresencePayload = null;
function broadcastPresence() {
  const payload = JSON.stringify({ type: 'presence', users: presenceSnapshot() });
  if (payload === lastPresencePayload) return;
  lastPresencePayload = payload;
  sendToAll(payload);
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
  sendToAll(JSON.stringify({ type: 'users-changed' }));
}

// Группа создана/переименована/у неё поменялись участники/её удалили — оповещаем ВСЕХ подключённых
// (не только текущих/бывших участников — проще и надёжнее целевой рассылки, а список групп у
// каждого клиента крошечный, перезапросить его не накладно), клиент сам решает, актуально ли это
// для него, и просто перезапрашивает /api/groups.
function broadcastGroupsChanged() {
  sendToAll(JSON.stringify({ type: 'groups-changed' }));
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  // Имя ПК присылает сам клиент, то есть доверять ему нельзя: обрезаем по длине, чтобы через него
  // нельзя было раздуть снимок присутствия (он рассылается всем) или дневной лог сервера.
  const hostname = (url.searchParams.get('host') || 'неизвестный ПК').slice(0, 64);
  // Версия клиента и трек сборки — чтобы администратор видел в панели, у кого что установлено и до
  // кого обновление ещё не доехало. Как и имя ПК, приходят от клиента, поэтому обрезаем по длине.
  const appVersion = (url.searchParams.get('ver') || '').slice(0, 20) || null;
  const buildTrack = (url.searchParams.get('track') || '').slice(0, 20) || null;
  let payload;
  try { payload = jwt.verify(token, SECRET); } catch { logServer('WARN', 'ws_auth_failed', { ip: req.socket.remoteAddress }); return ws.close(); }
  const user = getUserById.get(payload.id);
  if (!user) return ws.close();

  // Сокет без обработчика 'error' — это падение всего сервера: 'error' на EventEmitter без
  // слушателя превращается в исключение, а неперехваченное исключение у нас завершает процесс
  // (см. process.on('uncaughtException') в начале файла). А прилетает такой 'error' в самой
  // обычной ситуации: ECONNRESET, когда клиентский ПК выключили или он потерял сеть, не успев
  // корректно закрыть соединение. То есть один погасший в неудачный момент Windows-клиент мог
  // уронить мессенджер у всей организации.
  ws.on('error', (err) => logServer('WARN', 'ws_error', { userId: user.id, message: err.message }));

  if (!online.has(user.id)) online.set(user.id, new Set());
  online.get(user.id).add(ws);
  connMeta.set(ws, { userId: user.id, hostname, appVersion, buildTrack, state: 'active', lastSeen: Date.now(), idleSince: null });
  // Снимок присутствия этому сокету — обязательно отдельно от broadcastPresence(): та теперь молчит,
  // когда снимок не изменился (см. её комментарий), а при втором подключении с того же ПК он и не
  // меняется — новое окно осталось бы вообще без списка, кто сейчас в сети.
  sendTo(ws, JSON.stringify({ type: 'presence', users: presenceSnapshot() }));
  broadcastPresence();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    // Всё тело обработчика — под try: исключение здесь ничем не перехватывается и убивает процесс.
    // Достаточно было прислать, например, {"type":"send","to":{},"text":"x"} — объект вместо числа
    // роняет привязку параметров в better-sqlite3, и сервер выключался. То есть любой вошедший
    // сотрудник (или тот, кто добрался до порта) мог погасить мессенджер одной строкой.
    try {
      handleClientMessage(ws, user, msg);
    } catch (err) {
      logServer('ERROR', 'ws_message_failed', { userId: user.id, type: msg && msg.type, message: err.message });
    }
  });

  ws.on('close', () => {
    online.get(user.id)?.delete(ws);
    if (online.get(user.id)?.size === 0) online.delete(user.id);
    connMeta.delete(ws);
    broadcastPresence();
  });
});

// Ошибка самого сервера WebSocket (не отдельного соединения) — тоже обязана иметь слушателя,
// иначе она всплывает как неперехваченное исключение и гасит процесс.
wss.on('error', (err) => logServer('ERROR', 'wss_error', { message: err.message }));

// Вынесено из wss.on('connection') отдельной функцией, чтобы её вызов можно было целиком обернуть
// в try/catch выше. Все входящие поля здесь — из сети, поэтому каждое приводится к ожидаемому типу
// явно (см. toUserId/toRoom), а не подставляется в SQL как пришло.
function toUserId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function toRoom(v) {
  return typeof v === 'string' && v.length && v.length <= 64 ? v : null;
}

function handleClientMessage(ws, user, msg) {
    if (!msg || typeof msg !== 'object') return;

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
      const room = toRoom(msg.room);
      const to = toUserId(msg.to);
      const out = JSON.stringify({ type: 'typing', room, from_id: user.id, from_user: user.display_name });
      if (isGroupRoom(room)) {
        // Только участникам группы, а не буквально всем (как для 'general') — иначе кто угодно
        // подключённый увидел бы, что кто-то печатает в группе, где его самого нет.
        // Проверка членства обязательна и здесь: без неё посторонний, подставив id группы, узнавал
        // бы её состав по тому, кому доставился его собственный «печатает».
        const groupId = groupIdFromRoom(room);
        if (!isGroupMemberStmt.get(groupId, user.id)) return;
        for (const uid of groupMemberIds(groupId)) {
          if (uid === user.id) continue;
          sendToUser(uid, out);
        }
      } else if (room) {
        for (const [c, meta] of connMeta) { if (meta.userId !== user.id) sendTo(c, out); }
      } else if (to) {
        sendToUser(to, out);
      }
      return;
    }

    if (msg.type === 'read') {
      const peer = toUserId(msg.peer);
      const upTo = Number(msg.upTo);
      if (!peer || !Number.isFinite(upTo) || upTo <= 0) return;
      const info = markDmRead.run(Date.now(), peer, user.id, upTo);
      if (info.changes > 0) {
        // Сообщаем автору (peer), что я прочитал его сообщения по upTo включительно — если он сейчас
        // онлайн, его открытое окно переписки со мной сразу перекрасит галочки в синий.
        const out = JSON.stringify({ type: 'read-receipt', peer: user.id, upTo });
        sendToUser(peer, out);
      }
      return;
    }

    // Реакции — по одной эмодзи на пользователя на сообщение: повторный клик той же эмодзи снимает
    // реакцию, другой — заменяет. Рассылаем ПОЛНЫЙ актуальный набор реакций сообщения (а не дельту) —
    // проще и надёжнее инкрементального патча, а реакций на одном сообщении обычно немного.
    if (msg.type === 'react') {
      const messageId = toUserId(msg.messageId); // тот же критерий: целое положительное
      const emoji = typeof msg.emoji === 'string' ? msg.emoji.slice(0, 8) : '';
      if (!messageId || !emoji) return;
      const target = getMessageRoute.get(messageId);
      if (!target) return;
      // Реакция в группе — только от её участника: иначе посторонний мог бы и пометить чужое
      // сообщение, и по разосланному обновлению узнать, что за переписка скрывается за id.
      if (isGroupRoom(target.room) && !isGroupMemberStmt.get(groupIdFromRoom(target.room), user.id)) return;
      // В личной переписке реакцию может ставить только один из двух её участников.
      if (!target.room && target.from_id !== user.id && target.to_id !== user.id) return;
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
        sendToAll(out);
      } else {
        const targets = new Set([...(online.get(target.to_id) || []), ...(online.get(target.from_id) || [])]);
        targets.forEach((c) => sendTo(c, out));
      }
      return;
    }

    if (msg.type !== 'send') return;
    const room = toRoom(msg.room);
    const to = toUserId(msg.to);
    if (!room && !to) return;
    // Писать в группу может только её участник — молча игнорируем чужую попытку (не подсказываем
    // подбором id группы, что именно там за люди/переписка).
    if (isGroupRoom(room) && !isGroupMemberStmt.get(groupIdFromRoom(room), user.id)) return;
    const now = Date.now();
    const text = typeof msg.text === 'string' ? msg.text.slice(0, 4000).trim() : '';
    // Несколько файлов в одном сообщении: msg.files — массив; msg.file (в ед. числе) — старый формат,
    // поддерживаем на случай, если где-то остался не обновлённый клиент.
    const rawFiles = Array.isArray(msg.files) ? msg.files : (msg.file ? [msg.file] : []);
    const files = normalizeIncomingFiles(rawFiles);
    if (!text && !files.length) return;
    const filesJson = files.length ? JSON.stringify(files) : null;

    // Ответ на сообщение (reply) — снимок автора/текста делаем ЗДЕСЬ, на сервере (источник истины),
    // а не доверяем тому, что прислал клиент: то, на что отвечают, могло не быть у него в DOM
    // (старая страница пагинации), а после отправки должно остаться верным, даже если оригинал
    // потом станет недоступен клиенту.
    let replyToId = null, replySnapshot = null, replyOut = null;
    const replyToRaw = toUserId(msg.replyTo); // тот же критерий: целое положительное
    if (replyToRaw) {
      const target = getMessageForReply.get(replyToRaw);
      if (target) {
        const targetUser = getUserById.get(target.from_id);
        replyToId = target.id;
        replyOut = { id: target.id, from_user: targetUser ? targetUser.display_name : '?', text: (target.text || '').slice(0, 300) };
        replySnapshot = JSON.stringify({ from_user: replyOut.from_user, text: replyOut.text });
      }
    }

    if (room) {
      const info = insertMessage.run(user.id, room, null, text, filesJson, now, replyToId, replySnapshot);
      const out = JSON.stringify({ type: 'message', id: info.lastInsertRowid, room, from_id: user.id, from_user: user.display_name, text, files, created_at: now, reply: replyOut });
      if (isGroupRoom(room)) {
        for (const uid of groupMemberIds(groupIdFromRoom(room))) sendToUser(uid, out);
      } else {
        sendToAll(out); // общая комната — всем
      }
    } else {
      const info = insertMessage.run(user.id, null, to, text, filesJson, now, replyToId, replySnapshot);
      const out = JSON.stringify({ type: 'message', id: info.lastInsertRowid, to_id: to, from_id: user.id, from_user: user.display_name, text, files, created_at: now, reply: replyOut });
      const targets = new Set([...(online.get(to) || []), ...(online.get(user.id) || [])]);
      targets.forEach((c) => sendTo(c, out));
    }
}

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
  const scheme = server instanceof https.Server ? 'https' : 'http';
  console.log(`Искра запущена: ${scheme}://localhost:${PORT}`);
  if (scheme === 'https') reportTlsCertificate();
});
