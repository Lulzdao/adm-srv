const mailer = require("./mailer");
const { byKind, RECIPIENTS } = require("../config/notifications");

// ============================================================================
//  Оповещения: одно событие — сколько угодно доставок
//
//  Раньше здесь была функция notify(), которая писала строку в таблицу
//  notifications и пыталась отправить письмо. У неё было три беды, и все три
//  чинятся именно разделением факта и доставки:
//
//    1. Строка была одна на получателя, поэтому одно и то же событие
//       появлялось в списке столько раз, скольким людям оно уехало.
//    2. Таблица требовала ticket_id NOT NULL — оповещению про сертификат
//       было нечего туда положить.
//    3. Отправка письма нигде не отмечалась: не ушло — и никто не узнал.
//
//  Теперь emit() создаёт ОДНО событие и к нему строки доставки: по одной на
//  каждый адрес и на каждую персональную отметку в интерфейсе. Результат
//  каждой отправки, включая текст ошибки SMTP, остаётся в базе.
// ============================================================================

const insertEventStmt = (db) =>
  db.prepare(`
    INSERT INTO notification_events (kind, source, subject, ticket_id, subject_ref, dedup_key, severity, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedup_key) DO NOTHING
  `);

const insertDeliveryStmt = (db) =>
  db.prepare(`
    INSERT INTO notification_deliveries (event_id, channel, user_id, address, status)
    VALUES (?, ?, ?, ?, ?)
  `);

/**
 * Настройки категории: строка из базы, дополненная значениями по умолчанию из
 * справочника. Строки в базе может не быть вовсе — категорию ещё не открывали
 * в панели, и это нормальное состояние, а не ошибка.
 */
function settingsFor(db, kind) {
  const def = byKind(kind);
  if (!def) return null;
  const row = db.prepare("SELECT * FROM notification_settings WHERE kind = ?").get(kind) || {};
  return {
    def,
    enabled: row.enabled === undefined ? true : Boolean(row.enabled),
    emails: row.emails || "",
    thresholds: row.thresholds || def.thresholds || "",
    subjectTpl: row.subject_tpl || def.defaultSubject,
    bodyTpl: row.body_tpl || def.defaultBody,
  };
}

/**
 * Кому уходит письмо по этой категории.
 *
 * Три источника адресов, и ни один не ходит в LDAP на лету: список ведём
 * руками, а почта автора уже лежит в users.email — она перезаписывается из
 * домена при каждом входе, поэтому свежая по определению.
 */
function resolveEmails(db, kind, ctx) {
  const s = settingsFor(db, kind);
  if (!s) return [];

  if (s.def.recipients === RECIPIENTS.AUTHOR) {
    if (!ctx.authorUserId) return [];
    const user = db.prepare("SELECT email FROM users WHERE id = ?").get(ctx.authorUserId);
    return user && user.email ? [user.email] : [];
  }

  if (s.def.recipients === RECIPIENTS.BORROW) {
    // @department — заявка ушла в отдел, комментарий по ней уходит тем же людям.
    const target = s.def.borrowFrom.replace("@department", ctx.department || "");
    // Своей строки настроек у заимствующей категории нет, поэтому берём
    // список напрямую у той, на которую она ссылается.
    const donor = settingsFor(db, target);
    return donor ? mailer.parseEmails(donor.emails) : [];
  }

  return mailer.parseEmails(s.emails);
}

/** Подстановка {{ключ}} значениями из payload. Ненайденное — пустая строка. */
function render(tpl, payload) {
  return String(tpl || "").replace(/\{\{\s*([\wа-яёА-ЯЁ_]+)\s*\}\}/g, (_, key) => {
    const v = payload ? payload[key] : undefined;
    return v === undefined || v === null ? "" : String(v);
  });
}

/**
 * Записать факт и разослать его.
 *
 * Возвращает id события или null, если такое событие уже было (сработал
 * dedup_key). Письма уходят вне запроса: недоступный почтовый сервер не должен
 * подвешивать создание заявки, ради которого всё и затевалось.
 */
function emit(db, {
  kind,
  subject = "",
  ticketId = null,
  subjectRef = null,
  dedupKey,
  payload = {},
  department = null,
  authorUserId = null,
  inappUserIds = [],
}) {
  const s = settingsFor(db, kind);
  if (!s) {
    console.error(`[оповещения] неизвестная категория «${kind}» — событие не создано`);
    return null;
  }
  if (!s.enabled) return null;

  const key = dedupKey || `${kind}:${ticketId || subjectRef || ""}:${Date.now()}`;

  const info = insertEventStmt(db).run(
    kind,
    s.def.source,
    subject,
    ticketId,
    subjectRef,
    key,
    s.def.severity || "info",
    JSON.stringify(payload)
  );
  // changes === 0 — такое событие уже создавали. Это штатный путь для
  // планировщика, а не ошибка: он обходит сроки чаще, чем меняются пороги.
  if (!info.changes) return null;

  const eventId = Number(info.lastInsertRowid);
  const addDelivery = insertDeliveryStmt(db);

  // Персональные отметки в интерфейсе — то, что считает бейдж у «Входящих
  // заявок». Есть только у заявок: лента ИТ — журнал, отметок «прочитано» в
  // ней нет, и заводить их для сертификатов незачем.
  for (const userId of inappUserIds) {
    addDelivery.run(eventId, "inapp", userId, null, "sent");
  }

  const addresses = [...new Set(resolveEmails(db, kind, { department, authorUserId }))];
  for (const address of addresses) {
    addDelivery.run(eventId, "email", null, address, "pending");
  }

  if (addresses.length) {
    const text = render(s.bodyTpl, payload);
    const subj = render(s.subjectTpl, payload);
    // Намеренно без await: вызов идёт из обработчика запроса.
    deliverPending(db, eventId, subj, text).catch((err) =>
      console.error("[оповещения] сбой рассылки:", err.message)
    );
  }

  return eventId;
}

// Вся отправка почты идёт ОДНОЙ очередью.
//
// emit() намеренно не ждёт рассылку: недоступный почтовый сервер не должен
// подвешивать запрос, ради которого всё затевалось. Но из-за этого ежечасный
// повтор планировщика успевает выбрать те же самые ожидающие строки, пока
// первая рассылка ещё идёт, — и адресат получает два одинаковых письма, а
// исход записывается дважды. Заодно очередь убирает вторую беду: пачка
// событий больше не открывает десяток одновременных подключений к SMTP.
//
// Надёжнее было бы держать состояние «отправляется» в самой таблице — оно
// пережило бы и перезапуск. Но status ограничен CHECK-ом, а его в SQLite не
// изменить без пересборки таблицы: цена несоразмерна выигрышу. Процесс у
// платформы один, и очереди в памяти для этого достаточно.
let mailQueue = Promise.resolve();

function enqueueMail(job) {
  const started = mailQueue.then(job, job);
  // Хвост очереди не должен зависеть от исхода предыдущей задачи: иначе одна
  // ошибка отменила бы всю дальнейшую рассылку.
  mailQueue = started.then(() => {}, () => {});
  return started;
}

/** Отправить все ожидающие письма события и записать исход каждого. */
async function deliverPending(db, eventId, subject, text) {
  return enqueueMail(async () => {
    // Выборку делаем ВНУТРИ очереди, а не до неё: иначе список ожидающих строк
    // был бы снят до того, как предыдущая рассылка их разберёт.
    const rows = db.prepare(
      "SELECT id, address FROM notification_deliveries WHERE event_id = ? AND channel = 'email' AND status = 'pending'"
    ).all(eventId);

    for (const row of rows) {
      const result = await mailer.send(db, { to: row.address, subject, text });
      writeOutcome(db, row.id, result);
      if (!result.ok) {
        console.error(`[оповещения] письмо на ${row.address} не ушло: ${result.error}`);
      }
    }
  });
}

// Исход одной отправки. Причина записывается ВСЕГДА, в том числе когда письмо
// осталось в очереди: «не ушло» без объяснения — ровно та тишина, из-за
// которой раньше нельзя было понять, работает почта или нет.
function writeOutcome(db, deliveryId, result) {
  const status = result.ok ? "sent" : result.retriable ? "pending" : "failed";
  db.prepare(
    `UPDATE notification_deliveries
     SET status = ?, error = ?, sent_at = CASE WHEN ? = 'sent' THEN datetime('now','localtime') ELSE sent_at END
     WHERE id = ?`
  ).run(status, result.ok ? null : result.error, status, deliveryId);
}

/**
 * Разослать по событиям, у которых на момент создания не было ни одного адреса.
 *
 * Ловушка первой настройки. Планировщик делает первый обход сразу при старте
 * платформы — то есть заведомо раньше, чем администратор успел вписать
 * получателей. События создаются, писем ноль, и создать их заново уже нельзя:
 * dedup_key для того и нужен. Снаружи это выглядит как «всё настроил, и ничего
 * не пришло».
 *
 * Поэтому при сохранении списка адресов добираем то, что осталось без
 * доставок. Окно в 30 дней взято по самому раннему порогу: события старше него
 * всё равно уже неактуальны.
 */
async function backfillDeliveries(db, kind, { days = 30 } = {}) {
  const s = settingsFor(db, kind);
  if (!s) return 0;

  const events = db.prepare(`
    SELECT e.id, e.payload FROM notification_events e
    WHERE e.kind = ?
      AND e.created_at >= datetime('now','localtime',?)
      AND NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.event_id = e.id AND d.channel = 'email')
    ORDER BY e.id
  `).all(kind, `-${days} days`);
  if (!events.length) return 0;

  // Категории со списком и заимствующие его не зависят от конкретного события,
  // поэтому адреса достаточно вычислить один раз.
  const addresses = [...new Set(resolveEmails(db, kind, {}))];
  if (!addresses.length) return 0;

  const addDelivery = db.prepare(
    "INSERT INTO notification_deliveries (event_id, channel, address, status) VALUES (?, 'email', ?, 'pending')"
  );
  for (const ev of events) {
    for (const address of addresses) addDelivery.run(ev.id, address);
  }
  await retryPending(db, { limit: events.length * addresses.length });
  return events.length;
}

/**
 * Повторить отправку того, что осталось в pending. Пригодится планировщику:
 * почтовый сервер бывает недоступен ровно в ту минуту, когда создали заявку,
 * и терять из-за этого письмо не нужно.
 */
async function retryPending(db, { includeFailed = false, limit = 100 } = {}) {
  // Тоже через общую очередь: повтор и текущая рассылка иначе разбирают одни и
  // те же строки, и адресат получает письмо дважды.
  return enqueueMail(async () => {
    const rows = db.prepare(`
      SELECT d.id, d.address, e.kind, e.payload
      FROM notification_deliveries d
      JOIN notification_events e ON e.id = d.event_id
      WHERE d.channel = 'email' AND (d.status = 'pending' ${includeFailed ? "OR d.status = 'failed'" : ""})
      ORDER BY d.id LIMIT ?
    `).all(limit);

    for (const row of rows) {
      const s = settingsFor(db, row.kind);
      if (!s) continue;
      let payload = {};
      try { payload = JSON.parse(row.payload || "{}"); } catch { /* повреждённый payload не повод падать */ }
      const result = await mailer.send(db, {
        to: row.address,
        subject: render(s.subjectTpl, payload),
        text: render(s.bodyTpl, payload),
      });
      writeOutcome(db, row.id, result);
    }
    return rows.length;
  });
}

module.exports = { emit, settingsFor, resolveEmails, render, retryPending, backfillDeliveries };
