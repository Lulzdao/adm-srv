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
// Коды SQLite, по которым сбой при запуске объясняется словами, а не стеком.
const SQLITE_BUSY = 5, SQLITE_LOCKED = 6, SQLITE_CORRUPT = 11, SQLITE_NOTADB = 26;

/**
 * Открыть базу так, чтобы сбои запуска объясняли себя.
 *
 * busy_timeout — первым делом, до любого обращения к файлу: иначе база, которую
 * кто-то держит открытой на запись (DB Browser, копирование), роняла службу при
 * запуске сразу, без ожидания. Проверка на стенде: занятая на 3 секунды база
 * раньше давала «database is locked» и выход, теперь служба дожидается.
 *
 * Испорченный файл по-прежнему останавливает службу (работать не на чем), но с
 * указанием файла и что делать. Повреждение внутри живой базы запуск не
 * останавливает — заявки, до которых оно не дотянулось, работают, — а громко
 * пишется в журнал; то же покажет задание «Резервная копия баз».
 */
function openDatabase(file) {
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
  } catch (err) {
    stopOnDatabaseError(err, file);
  }
  let problems;
  try {
    const rows = db.prepare("PRAGMA quick_check").all().map((r) => Object.values(r)[0]);
    problems = rows.length === 1 && rows[0] === "ok" ? null : rows.slice(0, 5).join("; ");
  } catch (err) {
    problems = err.message;
  }
  if (problems) {
    console.error(
      `[внимание] База ${file} повреждена: ${problems}\n` +
        "           Служба работает, но часть данных может не читаться, а запись — усугубить повреждение.\n" +
        "           Остановите службу и восстановите базу из резервной копии (DEPLOY.md, «Резервные копии баз»)."
    );
  }
  return db;
}

function stopOnDatabaseError(err, file) {
  const code = err && err.errcode;
  if (code === SQLITE_NOTADB || code === SQLITE_CORRUPT) {
    console.error(
      `[остановка] Файл базы ${file} повреждён или это не база SQLite (${err.message}).\n` +
        "            Остановите службу, переименуйте этот файл (и -wal, -shm рядом) и положите на его место последнюю копию\n" +
        "            <база>-ГГГГ-ММ.db из папки резервных копий (DEPLOY.md, «Резервные копии баз»)."
    );
    process.exit(1);
  }
  if (code === SQLITE_BUSY || code === SQLITE_LOCKED) {
    console.error(
      `[остановка] База ${file} занята другой программой дольше 5 секунд (${err.message}).\n` +
        "            Закройте программу, в которой она открыта (DB Browser и т.п.), — служба перезапустится сама."
    );
    process.exit(1);
  }
  throw err;
}

function initDb() {
  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = openDatabase(config.dbPath);
  db.exec("PRAGMA foreign_keys = ON");

  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

  // Схема и миграции — одной транзакцией: либо всё, либо ничего. Раньше каждый
  // шаг записывался сразу, и сбой посередине (занятая база, кончилось место,
  // ошибка в миграции) оставлял базу наполовину обновлённой: колонки уже
  // добавлены, данные ещё не перенесены, а отметка «перенос сделан» — то ли
  // есть, то ли нет. Теперь база остаётся как до запуска, и следующий запуск
  // (NSSM перезапустит службу) проходит все шаги заново. DDL в SQLite тоже
  // транзакционный, так что ALTER TABLE откатывается вместе с остальным.
  // IMMEDIATE — сразу берём блокировку на запись, а не на полпути.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(schema);

    // Отделы — из единого конфига, не из статичного SQL. Добавили новый
    // отдел в config/departments.js — при следующем старте сервера здесь
    // появится соответствующая строка, руками ничего создавать не нужно.
    for (const dept of departments) {
      db.prepare("INSERT OR IGNORE INTO categories (name) VALUES (?)").run(dept.name);
    }

    migrateIsAdmin(db);
    migrateRoles(db);
    migrateNotifications(db);
    migrateStatuses(db);
    migrateDeliveryChannels(db, schema);
    migrateNotificationChannels(db);
    migrateUserGroups(db);
    migrateMailBoxes(db);
    dropAssistantExtras(db);
    mergeLoginCaseDuplicates(db);
    migrateTaskPeriod(db);
    migrateNotesBoard(db);
    // Категории «Срок действия истёк» больше нет (о просрочке напоминает
    // задача на перевыпуск) — её настройки не нужны. События в ленте остаются.
    db.prepare("DELETE FROM notification_settings WHERE kind = 'expired'").run();
    encryptStoredPasswords(db);
    db.exec("COMMIT");
    // Открытые пароли остались бы в свободных страницах файла и в журнале WAL —
    // пересобираем файл и чистим журнал (только если миграция что-то шифровала).
    if (needsVacuum) { db.exec("VACUUM"); db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
  } catch (err) {
    db.exec("ROLLBACK");
    db.close(); // дальше служба остановится; открытый файл базы ей ни к чему
    console.error(`[остановка] Обновление структуры базы не удалось и отменено целиком — база осталась как до запуска: ${err.message}`);
    throw err;
  }

  return db;
}

// Колонка is_admin в уже существующей базе.
//
// schema.sql применяется через CREATE TABLE IF NOT EXISTS — для существующей
// таблицы он не делает ничего, и новая колонка сама не появится. Добавляем её
// отдельно, по факту отсутствия: так миграция идемпотентна и переживает любое
// число перезапусков.
function migrateIsAdmin(db) {
  const columns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (columns.includes("is_admin")) return;
  db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  console.log("В таблицу users добавлен признак is_admin (администраторы определяются группой из .env)");
}

// Список отделов исполнителя. Заполняем из прежней единственной роли: до этой
// правки она и была всем, что известно о человеке. Полный список приедет из
// домена при следующем входе — там он и пересчитывается.
function migrateRoles(db) {
  const columns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (columns.includes("roles")) return;
  db.exec("ALTER TABLE users ADD COLUMN roles TEXT NOT NULL DEFAULT ''");
  const info = db.prepare(
    "UPDATE users SET roles = ',' || role || ',' WHERE role != 'user' AND roles = ''"
  ).run();
  console.log(`В таблицу users добавлен список отделов roles (перенесено записей: ${info.changes})`);
}

// Перевод заявок на сокращённый набор статусов.
//
// Статусов стало три: новая, в работе, закрыта. Прежние «ожидание», «выполнена»
// и «отменена» убраны — на практике «ожидание» от «в работе» никто не отличал, а
// «выполнена» и «отменена» одинаково означали, что заявкой больше не занимаются.
// Без этого перевода такие заявки стали бы невидимками: список фильтрует по
// новому набору, и строка со статусом «отменена» не попала бы ни в текущие
// (там условие «не закрыта»), ни в архив.
//
// История переходов (status_history) остаётся как есть: это летопись, и
// переписывать её нельзя. Подписи для исчезнувших значений держит клиент.
function migrateStatuses(db) {
  const map = { waiting: "progress", resolved: "closed", cancelled: "closed" };
  let total = 0;
  for (const [from, to] of Object.entries(map)) {
    const info = db.prepare("UPDATE tickets SET status = ? WHERE status = ?").run(to, from);
    total += info.changes;
  }
  if (total) console.log(`Заявки переведены на сокращённый набор статусов (затронуто: ${total})`);
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

// Канал доставки «iskra» — сообщение в мессенджере от имени «Центра».
//
// Список допустимых каналов записан в CHECK таблицы notification_deliveries, а
// CHECK в SQLite у существующей таблицы не меняется — только пересборкой:
// новая таблица, копия строк, замена. Идёт внутри общей транзакции запуска,
// поэтому сбой на любом шаге откатывает всё, и прежняя таблица остаётся как
// была. Индексы при замене таблицы пропадают вместе с ней — их заново создаёт
// повторный прогон schema.sql (там всё IF NOT EXISTS).
//
// Узнаём, нужна ли пересборка, по тексту самой таблицы в sqlite_master: так
// миграция идемпотентна и не требует отдельной отметки.
function migrateDeliveryChannels(db, schema) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notification_deliveries'").get();
  if (!row || row.sql.includes("'iskra'")) return;
  db.exec(`
    CREATE TABLE notification_deliveries_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('inapp', 'email', 'iskra')),
      user_id INTEGER REFERENCES users(id),
      address TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
      error TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      sent_at TEXT
    );
    INSERT INTO notification_deliveries_new
      (id, event_id, channel, user_id, address, status, error, is_read, created_at, sent_at)
      SELECT id, event_id, channel, user_id, address, status, error, is_read, created_at, sent_at
      FROM notification_deliveries;
    DROP TABLE notification_deliveries;
    ALTER TABLE notification_deliveries_new RENAME TO notification_deliveries;
  `);
  db.exec(schema);
  const n = db.prepare("SELECT COUNT(*) AS n FROM notification_deliveries").get().n;
  console.log(`Таблица доставок оповещений пересобрана под канал «Искра» (строк перенесено: ${n})`);
}

// Колонка channels у настроек категорий оповещений — тот же приём, что у
// is_admin: schema.sql существующую таблицу не трогает.
function migrateNotificationChannels(db) {
  const columns = db.prepare("PRAGMA table_info(notification_settings)").all().map((c) => c.name);
  if (columns.includes("channels")) return;
  db.exec("ALTER TABLE notification_settings ADD COLUMN channels TEXT");
}

// Группы AD у пользователя — для прав Ассистента. Заполнятся при следующем
// входе каждого сотрудника; до того пусто, то есть «ни в одной группе».
function migrateUserGroups(db) {
  const columns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (columns.includes("ad_groups")) return;
  db.exec("ALTER TABLE users ADD COLUMN ad_groups TEXT NOT NULL DEFAULT ''");
}

// Общих ящиков рассылок стало несколько (у каждого отдела свой). Рассылке
// нужна колонка mailbox_id, а ящик, заведённый раньше единственным набором
// настроек (mail_from / mail_password / mail_shared_group), переезжает в
// таблицу первым ящиком — чтобы после обновления ничего не вводить заново.
function migrateMailBoxes(db) {
  const columns = db.prepare("PRAGMA table_info(mail_campaigns)").all().map((c) => c.name);
  if (!columns.includes("mailbox_id")) {
    db.exec("ALTER TABLE mail_campaigns ADD COLUMN mailbox_id INTEGER REFERENCES mail_boxes(id) ON DELETE SET NULL");
  }
  // Оформленный текст письма (жирный, шрифты, размеры…). У старых рассылок — NULL.
  if (!columns.includes("body_html")) db.exec("ALTER TABLE mail_campaigns ADD COLUMN body_html TEXT");
  const get = (k) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(k) || {}).value || "";
  const from = get("mail_from").trim();
  if (!from) return;
  db.prepare("INSERT OR IGNORE INTO mail_boxes (address, password, ad_group) VALUES (?, ?, ?)")
    .run(from, get("mail_password"), get("mail_shared_group"));
  const box = db.prepare("SELECT id FROM mail_boxes WHERE address = ?").get(from);
  db.prepare("UPDATE mail_campaigns SET mailbox_id = ? WHERE sender_mode = 'shared' AND mailbox_id IS NULL AND sender_address = ?").run(box.id, from);
  db.prepare("DELETE FROM settings WHERE key IN ('mail_from', 'mail_user', 'mail_password', 'mail_shared_group')").run();
  console.log(`Общий ящик рассылок ${from} перенесён в список ящиков`);
}

// Из Ассистента убраны «Системы отдела», «Передача техники», «Журнал техники»
// и базы техники и запчастей из 1С: акты теперь заполняются вручную. Их
// таблицы и настройки удаляются, чтобы в базе не оставалось данных, которых
// больше никто не видит и не правит. Подписанты «заместитель» и «начальник
// ОИРиТ» тоже больше не нужны: начальник отдела ИТ берётся из справочника
// отделов.
/**
 * Двойники одного человека, заведённые из-за регистра логина («Ivanov» и
 * «ivanov»): домен регистр не различает, а платформа раньше различала. Всё,
 * что числится за двойниками (заявки, комментарии, задачи, акты, рассылки…),
 * переносится на самую раннюю запись, двойники удаляются, их входы
 * сбрасываются. Ссылки на пользователей ищутся по внешним ключам схемы, так
 * что новая таблица со ссылкой на users подхватится сама. После слияния —
 * уникальный индекс без учёта регистра, чтобы двойники больше не появлялись.
 */
/** Срок задачи периодом: «с … по …». Последний день остаётся в due_date. */
function migrateTaskPeriod(db) {
  const cols = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
  if (cols.length && !cols.includes("due_from")) db.exec("ALTER TABLE tasks ADD COLUMN due_from TEXT");
  // Задачи, которые платформа заводит сама (перевыпуск сертификата/МЧД): по
  // этому ключу вторая такая же не заводится.
  if (cols.length && !cols.includes("source_ref")) db.exec("ALTER TABLE tasks ADD COLUMN source_ref TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_ref ON tasks(source_ref) WHERE source_ref IS NOT NULL");
}

/**
 * Заметки были одним общим листом (notes_board), стали карточками (notes).
 * Написанное на листе переезжает первой карточкой, лист удаляется.
 */
function migrateNotesBoard(db) {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes_board'").get();
  if (!has) return;
  const old = db.prepare("SELECT html, updated_by, updated_at FROM notes_board WHERE id = 1").get();
  if (old && old.html && old.html.replace(/<[^>]*>|&nbsp;|\s/g, "")) {
    db.prepare(`INSERT INTO notes (title, html, x, y, w, h, created_by, updated_by, updated_at)
      VALUES ('Заметки', ?, 40, 40, 520, 420, ?, ?, COALESCE(?, datetime('now')))`).run(old.html, old.updated_by, old.updated_by, old.updated_at);
  }
  db.exec("DROP TABLE notes_board");
}

function mergeLoginCaseDuplicates(db) {
  const groups = db.prepare(`
    SELECT lower(ad_login) AS k FROM users GROUP BY lower(ad_login) HAVING COUNT(*) > 1
  `).all();
  const refs = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${name})`).all()) {
      if (fk.table === "users") refs.push({ table: name, column: fk.from });
    }
  }
  const removed = [];
  for (const { k } of groups) {
    const rows = db.prepare("SELECT * FROM users WHERE lower(ad_login) = ? ORDER BY id").all(k);
    // Аварийную локальную учётку с доменной не сливаем — это разные входы.
    if (rows.some((r) => r.auth_type === "local")) {
      console.warn(`[миграция] логин «${rows[0].ad_login}»: есть и локальная, и доменная запись — оставлены как есть`);
      continue;
    }
    const keep = rows[0];
    // Профиль — с самого свежего входа: ФИО, почта и отделы там актуальнее.
    const latest = rows.slice().sort((a, b) => String(b.last_login_at || "").localeCompare(String(a.last_login_at || "")))[0];
    for (const dup of rows.slice(1)) {
      for (const { table, column } of refs) {
        // OR IGNORE — для таблиц, где пара (что-то, пользователь) уникальна
        // (исполнители задачи): там, где обе записи уже есть, лишняя удаляется.
        db.prepare(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE ${column} = ?`).run(keep.id, dup.id);
        db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(dup.id);
      }
      db.prepare("DELETE FROM users WHERE id = ?").run(dup.id);
      removed.push(dup.id);
    }
    db.prepare(`UPDATE users SET ad_login = ?, full_name = ?, department = ?, email = ?, phone = ?, role = ?, roles = ?,
      is_admin = ?, ad_groups = ?, last_domain = ?, last_login_at = ? WHERE id = ?`).run(
      latest.ad_login, latest.full_name, latest.department, latest.email, latest.phone, latest.role, latest.roles,
      latest.is_admin, latest.ad_groups, latest.last_domain, latest.last_login_at, keep.id);
    console.log(`[миграция] логин «${latest.ad_login}»: ${rows.length} записи слиты в одну (id ${keep.id})`);
  }
  // Входы удалённых двойников: в сессии лежит их id — сбрасываем, человек
  // просто войдёт заново и попадёт в объединённую запись.
  if (removed.length) {
    const gone = new Set(removed);
    for (const s of db.prepare("SELECT sid, sess FROM sessions").all()) {
      let id = null;
      try { id = JSON.parse(s.sess).user?.id ?? null; } catch { /* битая сессия — не наша забота */ }
      if (gone.has(id)) db.prepare("DELETE FROM sessions WHERE sid = ?").run(s.sid);
    }
  }
  const left = db.prepare("SELECT COUNT(*) AS n FROM (SELECT 1 FROM users GROUP BY lower(ad_login) HAVING COUNT(*) > 1)").get().n;
  if (!left) db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login_nocase ON users(ad_login COLLATE NOCASE)");
}

function dropAssistantExtras(db) {
  const exists = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const gone = ["asst_journal", "asst_transfers", "asst_links", "asst_equipment", "asst_parts"].filter(exists);
  for (const t of gone) db.exec(`DROP TABLE ${t}`);
  db.prepare(`DELETE FROM settings WHERE key LIKE 'asst_equipment_imported_%' OR key LIKE 'asst_parts_imported_%'`).run();
  if (exists("asst_people")) db.prepare("DELETE FROM asst_people WHERE role IN ('deputy', 'it_chief')").run();
  // Должность начальника и склонение названия отдела подставляются сами, ФИО
  // «кого?» нигде не нужно — столбцы под них в справочнике отделов лишние.
  if (exists("asst_depts")) {
    const cols = db.prepare("PRAGMA table_info(asst_depts)").all().map((c) => c.name);
    for (const c of ["name_gen", "chief_post", "chief_post_gen", "chief_post_dat", "chief_name_gen"]) {
      if (cols.includes(c)) db.exec(`ALTER TABLE asst_depts DROP COLUMN ${c}`);
    }
  }
  if (gone.length) console.log(`Ассистент: удалены таблицы убранных разделов (${gone.join(", ")})`);
}

// Пароли почты, сохранённые до шифрования (services/secretBox.js), — зашифровать.
// Идемпотентно: зашифрованные («enc:v1:…») и пустые не трогаются. Открытый текст
// остался бы в свободных страницах файла — поэтому после миграции VACUUM (он вне
// транзакции, см. initDb).
let needsVacuum = false;
function encryptStoredPasswords(db) {
  needsVacuum = false;
  const box = require("../services/secretBox");
  let n = 0;
  for (const r of db.prepare("SELECT id, password FROM mail_boxes WHERE password != ''").all()) {
    if (box.isSealed(r.password)) continue;
    db.prepare("UPDATE mail_boxes SET password = ? WHERE id = ?").run(box.seal(r.password), r.id);
    n++;
  }
  const smtp = db.prepare("SELECT value FROM settings WHERE key = 'smtp_password'").get();
  if (smtp && smtp.value && !box.isSealed(smtp.value)) {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'smtp_password'").run(box.seal(smtp.value));
    n++;
  }
  if (n) {
    console.log(`Пароли почты зашифрованы: ${n} (ключ — ${box.keyInfo().source === "env" ? "SECRET_KEY в .env" : box.keyInfo().file})`);
    needsVacuum = true;
  }
}

// Посев локальных аварийных аккаунтов ("break glass"), на случай если оба
// домена недоступны. Пароли задаются заранее через
// scripts/set-local-admin-password.js и хранятся только как bcrypt-хэш.
//
// Пароль аварийной учётки живёт ТОЛЬКО в .env, база — лишь его копия, и сверяется
// она на каждом старте. Раньше хэш попадал в базу один раз, при создании учётки,
// и дальше не трогался: убрали LOCAL_ADMIN_PASSWORD_HASH из .env — а вход по
// старому паролю работал (строка с хэшем осталась); сменили пароль — действовал
// и старый; переименовали логин — прежний оставался рабочей учёткой с паролем.
// Теперь локальная учётка без хэша в .env войти не может: вход проверяет
// local_password_hash, и здесь он обнуляется.
function ensureLocalAccounts(db) {
  const enabled = new Set(config.localAccounts.filter((a) => a.passwordHash).map((a) => a.login));
  const stale = db.prepare(
    "SELECT id, ad_login FROM users WHERE auth_type = 'local' AND local_password_hash IS NOT NULL"
  ).all().filter((u) => !enabled.has(u.ad_login));
  for (const u of stale) {
    db.prepare("UPDATE users SET local_password_hash = NULL WHERE id = ?").run(u.id);
    console.log(`Аварийный вход ${u.ad_login} закрыт: в .env для него не задан хэш пароля`);
  }

  for (const acc of config.localAccounts) {
    if (!acc.passwordHash) continue;
    const existing = db.prepare(
      "SELECT id, email, is_admin, roles, local_password_hash FROM users WHERE ad_login = ?"
    ).get(acc.login);
    const wantAdmin = acc.isAdmin ? 1 : 0;
    // Список отделов у локальной учётки выводится из её роли: домена у неё нет,
    // а очередь своего отдела она видеть должна.
    const wantRoles = acc.role && acc.role !== "user" ? `,${acc.role},` : "";

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
      // Признак администратора — тоже из конфига, по той же причине: из
      // интерфейса он не меняется, значит источник истины здесь один.
      if ((existing.roles || "") !== wantRoles) {
        db.prepare("UPDATE users SET roles = ? WHERE id = ?").run(wantRoles, existing.id);
      }
      if (Number(existing.is_admin || 0) !== wantAdmin) {
        db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(wantAdmin, existing.id);
        console.log(`Локальному аккаунту ${acc.login} ${wantAdmin ? "выданы" : "сняты"} права администратора`);
      }
      if (existing.local_password_hash !== acc.passwordHash) {
        db.prepare("UPDATE users SET local_password_hash = ? WHERE id = ?").run(acc.passwordHash, existing.id);
        console.log(`Пароль локального аккаунта ${acc.login} взят из .env`);
      }
      continue;
    }

    db.prepare(
      `INSERT INTO users (ad_login, full_name, role, roles, is_admin, email, auth_type, local_password_hash)
       VALUES (?, ?, ?, ?, ?, ?, 'local', ?)`
    ).run(acc.login, acc.fullName, acc.role, wantRoles, wantAdmin, acc.email || null, acc.passwordHash);

    console.log(`Создан локальный аккаунт: ${acc.login} (роль: ${acc.role})`);
  }
}

if (require.main === module) {
  const db = initDb();
  ensureLocalAccounts(db);
  console.log(`База данных готова: ${config.dbPath}`);
  db.close();
}

module.exports = { initDb, ensureLocalAccounts, migrateStatuses };
