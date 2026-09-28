'use strict';

// ---------- База данных ----------
// node:sqlite — встроенный в Node модуль, как у платформы, Сертвивера и журнала звонков. Раньше
// здесь был better-sqlite3: нативный модуль, собранный под конкретную версию Node. На закрытом
// контуре его node_modules приходилось возить с машины с той же версией Node, а на Node 24
// версия 11 падала сама через секунды после старта («Assertion failed: (env) != nullptr» в
// деструкторе Statement при сборке мусора). Встроенному модулю собирать нечего. Файл базы тот же —
// формат SQLite один, переносить или конвертировать ничего не нужно. Нужен Node 22.13+.
//
// Открывает базу, создаёт схему и проводит миграции. Возвращает базу и то, что нужно остальному
// серверу для работы с ней: транзакцию и настройки app_settings.

const { DatabaseSync } = require('node:sqlite');

function openDatabase(DB_FILE, { logServer }) {
  const db = new DatabaseSync(DB_FILE);
  // better-sqlite3 по умолчанию ждал занятую базу 5 секунд, node:sqlite не ждёт вовсе — держим прежнее.
  // Первым делом, до любого обращения к файлу: раньше ожидание включалось после переключения в WAL, и
  // база, которую при запуске держала другая программа (DB Browser, копирование), роняла «Искру» сразу.
  db.exec('PRAGMA busy_timeout = 5000');
  // Испорченный или занятый файл — понятная строка в журнал вместо стека (как у платформы и модулей).
  try {
    db.exec('PRAGMA journal_mode = WAL');
  } catch (err) {
    const code = err && err.errcode;
    if (code === 26 || code === 11) {
      logServer('ERROR', 'db_corrupt', { file: DB_FILE, message: err.message,
        hint: 'остановите службу, переименуйте файл (и -wal, -shm рядом) и положите на его место последнюю копию messenger-ГГГГ-ММ.db из папки резервных копий платформы (DEPLOY.md, «Резервные копии баз»)' });
      process.exit(1);
    }
    if (code === 5 || code === 6) {
      logServer('ERROR', 'db_locked', { file: DB_FILE, message: err.message,
        hint: 'база занята другой программой дольше 5 секунд — закройте её (DB Browser и т.п.), служба перезапустится сама' });
      process.exit(1);
    }
    throw err;
  }
  // Повреждение внутри базы запуск не останавливает, но громко пишется в журнал.
  {
    let problems;
    try {
      const rows = db.prepare('PRAGMA quick_check').all().map((r) => Object.values(r)[0]);
      problems = rows.length === 1 && rows[0] === 'ok' ? null : rows.slice(0, 5).join('; ');
    } catch (err) {
      problems = err.message;
    }
    if (problems) {
      logServer('ERROR', 'db_damaged', { file: DB_FILE, problems,
        hint: 'часть данных может не читаться — восстановите базу из резервной копии' });
    }
  }

  // Транзакция «всё или ничего» — замена db.transaction из better-sqlite3, которого в node:sqlite нет.
  // Возвращает функцию: ошибка внутри откатывает всё, что она успела записать.
  function transaction(fn) {
    return (...args) => {
      db.exec('BEGIN');
      try {
        const result = fn(...args);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    };
  }
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
  // Кто загрузил файл. Нужен для права на скачивание (см. canAccessFile): раньше токен на скачивание
  // выдавался на любой файл любому вошедшему, и знания имени файла на диске хватало, чтобы открыть
  // вложение из чужой личной переписки. У файлов, загруженных до появления таблицы, владельца нет —
  // к ним доступ только через сообщения и объявления, в которых они лежат.
  db.exec(`
    CREATE TABLE IF NOT EXISTS uploads (
      disk_name TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

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
    // Поколение входа: номер зашит в каждый выданный токен, и токен со старым номером больше не
    // пускает. Растёт при смене пароля администратором — иначе вход, сделанный до смены (в том числе
    // тем, кто пароль подсмотрел), оставался рабочим ещё до 30 дней. Уже выданные токены без номера
    // считаются поколением 0 — обновление никого не разлогинивает.
    if (!cols.includes('session_gen')) db.exec('ALTER TABLE users ADD COLUMN session_gen INTEGER NOT NULL DEFAULT 0');
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
      const run = transaction(() => { for (const r of rows) link.run(r.id, r.department_id); });
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

  return { db, transaction, getSettingRaw, setSettingRaw };
}

module.exports = { openDatabase };
