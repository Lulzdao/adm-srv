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
  const { file_url, file_name, file_size, files_json, ...rest } = row;
  let files = [];
  if (files_json) {
    try { files = JSON.parse(files_json); } catch { files = []; }
  } else if (file_url) {
    files = [{ url: file_url, name: file_name, size: file_size }];
  }
  files = files.map((f) => ({ ...f, exists: fileExistsForUrl(f.url) }));
  return { ...rest, files };
}
function fileExistsForUrl(url) {
  const diskName = String(url || '').split('/').pop();
  return !!diskName && fs.existsSync(path.join(uploadsDir, diskName));
}

const insertUser = db.prepare('INSERT INTO users (username, password_hash, display_name, can_broadcast, can_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)');
const getUserByName = db.prepare('SELECT * FROM users WHERE username = ?');
// Права регулируются только персонально — на пользователе, без наследования от отдела (раньше можно
// было выдать право сразу всему отделу; отказались от этого в пользу простоты — только "Пользователи").
const getUserById = db.prepare('SELECT id, username, display_name, department_id, can_broadcast, can_admin FROM users WHERE id = ?');
const countUsers = db.prepare('SELECT COUNT(*) AS c FROM users');
const listUsersFull = db.prepare(`
  SELECT u.id, u.username, u.display_name, u.department_id, u.can_broadcast, u.can_admin, d.name AS department
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
const deleteUserStmt = db.prepare('DELETE FROM users WHERE id = ?');

const listDepartments = db.prepare('SELECT * FROM departments ORDER BY sort_order, id');
const insertDepartment = db.prepare('INSERT INTO departments (name, sort_order) VALUES (?, ?)');
const updateDepartmentStmt = db.prepare('UPDATE departments SET name = ? WHERE id = ?');
const setDepartmentOrder = db.prepare('UPDATE departments SET sort_order = ? WHERE id = ?');
const deleteDepartmentStmt = db.prepare('DELETE FROM departments WHERE id = ?');

// Право проверяется по уже эффективному значению req.user, которое auth() перечитывает из базы
// на каждый запрос — смена права действует сразу, без перелогина.
function requireCapability(cap) {
  return (req, res, next) => {
    if (!req.user[cap]) return res.status(403).json({ error: 'Недостаточно прав' });
    next();
  };
}

const insertMessage = db.prepare('INSERT INTO messages (from_id, room, to_id, text, files_json, created_at) VALUES (?, ?, ?, ?, ?, ?)');

// История комнаты: по умолчанию (без фильтров) — последние 200; с since/until — диапазон дат; с q — поиск по тексту
const roomHistoryAll = db.prepare(`
  SELECT m.id, m.text, m.created_at, m.from_id, m.file_url, m.file_name, m.file_size, m.files_json, u.display_name AS from_user
  FROM messages m JOIN users u ON u.id = m.from_id
  WHERE m.room = ? ORDER BY m.id DESC LIMIT 200
`);
const roomHistoryRange = db.prepare(`
  SELECT m.id, m.text, m.created_at, m.from_id, m.file_url, m.file_name, m.file_size, m.files_json, u.display_name AS from_user
  FROM messages m JOIN users u ON u.id = m.from_id
  WHERE m.room = ? AND m.created_at >= ? AND m.created_at < ? ORDER BY m.id ASC
`);
const roomHistorySearch = db.prepare(`
  SELECT m.id, m.text, m.created_at, m.from_id, m.file_url, m.file_name, m.file_size, m.files_json, u.display_name AS from_user
  FROM messages m JOIN users u ON u.id = m.from_id
  WHERE m.room = ? AND lower_ru(m.text) LIKE '%' || lower_ru(?) || '%' ORDER BY m.id DESC LIMIT 200
`);
const roomHistoryDays = db.prepare(`
  SELECT strftime('%Y-%m-%d', datetime(m.created_at/1000, 'unixepoch', ?)) AS day, COUNT(*) AS count
  FROM messages m WHERE m.room = ? GROUP BY day ORDER BY day DESC
`);

const dmHistoryAll = db.prepare(`
  SELECT m.id, m.text, m.created_at, m.from_id, m.to_id, m.read_at, m.file_url, m.file_name, m.file_size, m.files_json, u.display_name AS from_user
  FROM messages m JOIN users u ON u.id = m.from_id
  WHERE (m.from_id = ? AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = ?)
  ORDER BY m.id DESC LIMIT 200
`);
const dmHistoryRange = db.prepare(`
  SELECT m.id, m.text, m.created_at, m.from_id, m.to_id, m.read_at, m.file_url, m.file_name, m.file_size, m.files_json, u.display_name AS from_user
  FROM messages m JOIN users u ON u.id = m.from_id
  WHERE ((m.from_id = ? AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = ?)) AND m.created_at >= ? AND m.created_at < ?
  ORDER BY m.id ASC
`);
const dmHistorySearch = db.prepare(`
  SELECT m.id, m.text, m.created_at, m.from_id, m.to_id, m.read_at, m.file_url, m.file_name, m.file_size, m.files_json, u.display_name AS from_user
  FROM messages m JOIN users u ON u.id = m.from_id
  WHERE ((m.from_id = ? AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = ?)) AND lower_ru(m.text) LIKE '%' || lower_ru(?) || '%'
  ORDER BY m.id DESC LIMIT 200
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
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

app.post('/api/upload', auth, express.raw({ limit: '50mb', type: () => true }), (req, res) => {
  const originalName = String(req.query.name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);
  const safeName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${originalName}`;
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'Пустой файл' });
  fs.writeFileSync(path.join(uploadsDir, safeName), req.body);
  res.json({ url: `/uploads/${safeName}`, name: originalName, size: req.body.length });
});
// Файл больше лимита (50 МБ) — express.raw() бросает ошибку мимо обработчика выше; ловим её здесь,
// иначе клиент получит HTML-страницу вместо JSON и "Не удалось загрузить файл" без объяснения причины.
app.use('/api/upload', (err, req, res, next) => {
  if (err) return res.status(413).json({ error: `Файл больше ${MAX_UPLOAD_BYTES / 1024 / 1024} МБ` });
  next();
});

// Скачивание: требует токен (?token=...), т.к. обычная ссылка не может передать заголовок
// Authorization. На диске файл лежит под "грязным" именем (метка времени + случайный хеш —
// нужно для исключения коллизий и path traversal), поэтому явно задаём оригинальное имя через
// Content-Disposition — иначе при сохранении подставлялось бы страшное техническое имя файла.
// Клиент передаёт оригинальное имя параметром ?name=, зная его из истории переписки.
app.get('/uploads/:diskName', (req, res) => {
  try { jwt.verify(req.query.token, SECRET); } catch { return res.sendStatus(401); }
  const filePath = path.join(uploadsDir, req.params.diskName);
  if (!filePath.startsWith(uploadsDir) || !fs.existsSync(filePath)) return res.sendStatus(404);
  const displayName = req.query.name ? String(req.query.name).slice(0, 260) : req.params.diskName;
  res.download(filePath, displayName);
});

app.post('/api/register', (req, res) => {
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
    const token = jwt.sign({ id: info.lastInsertRowid }, SECRET, { expiresIn: '30d' });
    res.json({ token, user: getUserById.get(info.lastInsertRowid) });
  } catch {
    res.status(409).json({ error: 'Такой логин уже занят' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = getUserByName.get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  const token = jwt.sign({ id: user.id }, SECRET, { expiresIn: '30d' });
  res.json({ token, user: getUserById.get(user.id) });
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

app.get('/api/users', auth, (req, res) => res.json(listUsersBasic.all()));
app.get('/api/departments', auth, (req, res) => res.json(listDepartments.all()));

// История: без параметров — последние 200 сообщений (как раньше); ?since=&until= — диапазон
// (используется для "сегодняшнего" окна чата и просмотра конкретного дня); ?q= — поиск по тексту
// во всей истории переписки (диапазон дат при этом игнорируется).
app.get('/api/history/room/:room', auth, (req, res) => {
  const { since, until, q } = req.query;
  if (q) return res.json(roomHistorySearch.all(req.params.room, q).reverse().map(normalizeRow));
  if (since && until) return res.json(roomHistoryRange.all(req.params.room, Number(since), Number(until)).map(normalizeRow)); // уже ASC из SQL
  res.json(roomHistoryAll.all(req.params.room).reverse().map(normalizeRow));
});
// Группировка по дням учитывает часовой пояс КЛИЕНТА (?offsetMinutes= — минуты впереди UTC,
// т.е. для UTC+3 это 180), а не сервера — так деление на дни всегда совпадает с тем, что человек
// видит на часах, даже если сервер физически стоит в другом часовом поясе.
function tzModifier(req) {
  const minutes = Number(req.query.offsetMinutes) || 0;
  const sign = minutes >= 0 ? '+' : '-';
  return `${sign}${Math.abs(minutes)} minutes`;
}

app.get('/api/history/room/:room/days', auth, (req, res) => res.json(roomHistoryDays.all(tzModifier(req), req.params.room)));

app.get('/api/history/dm/:userId', auth, (req, res) => {
  const other = Number(req.params.userId);
  const { since, until, q } = req.query;
  if (q) return res.json(dmHistorySearch.all(req.user.id, other, other, req.user.id, q).reverse().map(normalizeRow));
  if (since && until) return res.json(dmHistoryRange.all(req.user.id, other, other, req.user.id, Number(since), Number(until)).map(normalizeRow)); // уже ASC из SQL
  res.json(dmHistoryAll.all(req.user.id, other, other, req.user.id).reverse().map(normalizeRow));
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
  const { department_id, password, display_name, can_broadcast, can_admin } = req.body || {};
  if (can_broadcast !== undefined || can_admin !== undefined) {
    const current = db.prepare('SELECT can_broadcast, can_admin FROM users WHERE id = ?').get(id);
    if (!current) return res.status(404).json({ error: 'Пользователь не найден' });
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
  broadcastUsersChanged();
  res.json({ ok: true });
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
  res.json(roomHistoryAll.all(req.params.room).reverse().map(normalizeRow));
});
app.get('/api/admin/history/dm/:u1/:u2', auth, requireCapability('can_admin'), (req, res) => {
  const a = Number(req.params.u1), b = Number(req.params.u2);
  res.json(dmHistoryAll.all(a, b, b, a).reverse().map(normalizeRow));
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
function broadcastUsersChanged() {
  const payload = JSON.stringify({ type: 'users-changed' });
  for (const ws of connMeta.keys()) ws.send(payload);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  const hostname = url.searchParams.get('host') || 'неизвестный ПК';
  let payload;
  try { payload = jwt.verify(token, SECRET); } catch { return ws.close(); }
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

    if (msg.type !== 'send') return;
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

    if (msg.room) {
      insertMessage.run(user.id, msg.room, null, text, filesJson, now);
      const out = JSON.stringify({ type: 'message', room: msg.room, from_id: user.id, from_user: user.display_name, text, files, created_at: now });
      for (const c of connMeta.keys()) c.send(out); // общая комната — всем
    } else if (msg.to) {
      insertMessage.run(user.id, null, msg.to, text, filesJson, now);
      const out = JSON.stringify({ type: 'message', to_id: msg.to, from_id: user.id, from_user: user.display_name, text, files, created_at: now });
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

server.listen(PORT, () => {
  ensureBootstrapAdmin();
  console.log(`Мини-мессенджер запущен: http://localhost:${PORT}`);
});
