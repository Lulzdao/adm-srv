const fs = require("node:fs");
const nodemailer = require("nodemailer");
const mailer = require("./mailer");
const { getSetting } = require("./settings");

// ============================================================================
//  Очередь рассылок
//
//  Письма уходят по одному с паузой между ними: сотни писем разом почтовый
//  сервер примет за спам, упрётся в лимит писем в минуту, а получатели
//  окажутся в чёрном списке. Пауза настраивается (по умолчанию 3 секунды —
//  три сотни писем за четверть часа).
//
//  Очередь живёт в базе (mail_recipients.status), а не в памяти: служба
//  перезапустилась посреди рассылки — отправка продолжится с того же места,
//  и уже отправленным повторно ничего не уйдёт.
//
//  Кроме пароля от собственного ящика: он есть только в памяти, пока идёт
//  отправка, и не пишется ни в базу, ни в журнал. После перезапуска такая
//  рассылка встаёт на паузу и просит пароль заново.
// ============================================================================

const MAX_ATTEMPTS = 3;
// Столько неудач соединения ПОДРЯД — и рассылка встаёт на паузу: сервер лежит,
// и перебирать на нём оставшиеся сотни адресов бессмысленно.
const MAX_CONNECTION_FAILURES = 3;

const KEYS = {
  host: "mail_host", port: "mail_port", secure: "mail_secure",
  user: "mail_user", password: "mail_password", from: "mail_from",
  delay: "mail_delay_ms", signature: "mail_signature", allowOwn: "mail_allow_own",
  sharedGroup: "mail_shared_group",
};

/**
 * Настройки рассылок. Сервер по умолчанию — тот же, что у оповещений
 * платформы: почтовый сервер в организации один, а вот ящик для рассылок
 * обычно отдельный.
 */
function readSettings(db) {
  const get = (k) => {
    const v = getSetting(db, KEYS[k]);
    return v === null || v === "" ? null : v;
  };
  const base = mailer.readSettings(db);
  const delay = get("delay");
  return {
    host: get("host") || base.host || "",
    port: Number(get("port")) || base.port || 465,
    secure: get("secure") === null ? base.secure : get("secure") === "1",
    user: get("user") || "",
    password: get("password") || "",
    from: get("from") || "",
    delayMs: delay === null ? 3000 : Math.max(0, Math.min(60000, Number(delay) || 0)),
    signature: get("signature") ?? "Липецкстат",
    allowOwn: get("allowOwn") !== "0",
    // Группа AD, участникам которой доступен общий ящик. Пусто — всем.
    sharedGroup: get("sharedGroup") || "",
    hostFromPlatform: !get("host"),
  };
}

function transportFor(s, auth) {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: auth && auth.user ? { user: auth.user, pass: auth.pass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
}

/** Подстановка {Колонка} из строки списка: регистр и «ё» не важны. */
const norm = (s) => String(s).trim().toLowerCase().replace(/ё/g, "е");
function fill(text, fields) {
  const map = new Map(Object.entries(fields || {}).map(([k, v]) => [norm(k), v]));
  return String(text).replace(/\{([^{}\n]{1,60})\}/g, (all, key) => (map.has(norm(key)) ? String(map.get(norm(key)) ?? "") : all));
}

/** Текст письма: шаблон с обращением и реквизитами или текст как есть. */
function letterText(campaign, r, signature) {
  const fields = { ...(r.fields ? JSON.parse(r.fields) : {}), ОКПО: r.okpo || "", Наименование: r.name || "" };
  const body = fill(campaign.body, fields);
  if (!campaign.use_template) return body;
  const head = ["Здравствуйте, уважаемый респондент!"];
  if (r.okpo) head.push(`ОКПО: ${r.okpo}`);
  if (r.name) head.push(`Наименование: ${r.name}`);
  return `${head.join("\n")}\n\n${body}\n\nС уважением,\n${signature}`;
}

function createQueue(db) {
  const secrets = new Map();   // id рассылки -> пароль своего ящика (только в памяти)
  const transports = new Map();
  let running = false;
  let timer = null;
  let stopped = false;

  const campaign = (id) => db.prepare("SELECT * FROM mail_campaigns WHERE id = ?").get(id);

  function pause(id, reason) {
    db.prepare("UPDATE mail_campaigns SET status = 'paused', paused_reason = ? WHERE id = ? AND status = 'sending'").run(reason, id);
    transports.delete(id);
  }

  function transport(c, s) {
    if (transports.has(c.id)) return transports.get(c.id);
    let auth;
    if (c.sender_mode === "own") {
      const pass = secrets.get(c.id);
      if (pass === undefined) return null;
      auth = { user: c.sender_login || c.sender_address, pass };
    } else {
      auth = { user: s.user, pass: s.password };
    }
    const t = transportFor(s, auth);
    transports.set(c.id, t);
    return t;
  }

  // Отчёт уходит ДО отметки «завершена»: иначе тот, кто увидел на странице
  // «завершена», мог ещё не получить письма с отчётом.
  async function finish(c) {
    const t = transports.get(c.id);
    // Отчёт — автору на почту, как было в «Почтальоне». Не дошёл отчёт — не
    // беда: всё то же видно на странице рассылки.
    const author = db.prepare("SELECT email FROM users WHERE id = ?").get(c.created_by);
    const to = (author && author.email) || c.sender_address;
    if (t && to) {
      const rows = db.prepare("SELECT * FROM mail_recipients WHERE campaign_id = ? ORDER BY row_no").all(c.id);
      const failed = rows.filter((r) => r.status === "failed");
      const lines = [
        `Рассылка «${c.subject}» завершена.`,
        "",
        `Отправлено: ${rows.length - failed.length} из ${rows.length}.`,
      ];
      if (failed.length) {
        lines.push("", "Не отправлено:");
        for (const r of failed) lines.push(`  • ${[r.okpo, r.name].filter(Boolean).join(" — ")} <${r.emails}>: ${r.error || "ошибка"}`);
      }
      lines.push("", "Текст рассылки:", "", c.body);
      try {
        await t.sendMail({ from: c.sender_address, to, subject: `Отчёт о рассылке: ${c.subject}`.slice(0, 200), text: lines.join("\n") });
      } catch { /* отчёт необязателен */ }
    }
    db.prepare("UPDATE mail_campaigns SET status = 'done', finished_at = datetime('now') WHERE id = ? AND status = 'sending'").run(c.id);
    transports.delete(c.id);
    secrets.delete(c.id);
  }

  async function sendOne(c, s) {
    const r = db.prepare(`
      SELECT * FROM mail_recipients WHERE campaign_id = ? AND status = 'pending' ORDER BY attempts, row_no LIMIT 1
    `).get(c.id);
    if (!r) { await finish(c); return; }
    const t = transport(c, s);
    if (!t) { pause(c.id, "Нужен пароль от ящика: отправка остановилась при перезапуске службы"); return; }

    const attachments = db.prepare("SELECT filename, path FROM mail_attachments WHERE campaign_id = ? ORDER BY id").all(c.id)
      .filter((a) => fs.existsSync(a.path)).map((a) => ({ filename: a.filename, path: a.path }));
    const author = db.prepare("SELECT email FROM users WHERE id = ?").get(c.created_by);
    try {
      await t.sendMail({
        from: c.sender_address,
        to: r.emails,
        // Ответ респондента должен прийти тому, кто рассылал, а не в общий ящик.
        replyTo: c.sender_mode === "shared" && author && author.email ? author.email : undefined,
        subject: fill(c.subject, { ...(r.fields ? JSON.parse(r.fields) : {}), ОКПО: r.okpo || "", Наименование: r.name || "" }),
        text: letterText(c, r, s.signature),
        attachments,
      });
      db.prepare("UPDATE mail_recipients SET status = 'sent', attempts = attempts + 1, error = NULL, sent_at = datetime('now') WHERE id = ?").run(r.id);
      c._connFailures = 0;
    } catch (err) {
      const text = mailerDescribe(err);
      if (err && err.code === "EAUTH") {
        // Неверный пароль — дальше пробовать бессмысленно. Письмо не считаем
        // неудачным: адресат ни при чём.
        secrets.delete(c.id);
        pause(c.id, `Почтовый сервер не принял логин или пароль: ${text}`);
        return;
      }
      const connection = ["ECONNECTION", "ESOCKET", "ETIMEDOUT", "EDNS", "ECONNRESET", "ECONNREFUSED"].includes(err && err.code);
      const attempts = r.attempts + 1;
      const retriable = connection || isTemporary(err);
      const status = retriable && attempts < MAX_ATTEMPTS ? "pending" : "failed";
      db.prepare("UPDATE mail_recipients SET status = ?, attempts = ?, error = ? WHERE id = ?").run(status, attempts, text, r.id);
      if (connection) {
        transports.delete(c.id);
        c._connFailures = (c._connFailures || 0) + 1;
        if (c._connFailures >= MAX_CONNECTION_FAILURES) pause(c.id, `Почтовый сервер недоступен: ${text}`);
      }
    }
  }

  const failures = new Map(); // id рассылки -> неудач соединения подряд

  async function loop() {
    if (running || stopped) return;
    running = true;
    try {
      for (;;) {
        if (stopped) break;
        const active = db.prepare("SELECT * FROM mail_campaigns WHERE status = 'sending' ORDER BY id").all();
        if (!active.length) break;
        const s = readSettings(db);
        if (!s.host) {
          for (const c of active) pause(c.id, "Почтовый сервер не настроен — администратор задаёт его в настройках рассылок");
          break;
        }
        // По одному письму из каждой активной рассылки по кругу: две рассылки
        // от разных людей идут одновременно, а не одна после другой.
        for (const c of active) {
          c._connFailures = failures.get(c.id) || 0;
          await sendOne(c, s);
          failures.set(c.id, c._connFailures || 0);
          if (stopped) break;
          if (s.delayMs) await new Promise((r) => { timer = setTimeout(r, s.delayMs); timer.unref(); });
        }
      }
    } catch (err) {
      // База закрыта (служба останавливается) или что-то непредвиденное —
      // очередь продолжит со следующего толчка.
      if (!stopped && !/not open/.test(err.message)) console.error("[рассылки] сбой очереди:", err.message);
    } finally {
      running = false;
    }
  }

  return {
    /** Запустить отправку (если уже идёт — ничего не делает). */
    kick() { setImmediate(loop); },
    /** Запомнить пароль своего ящика на время отправки. */
    setSecret(id, pass) { secrets.set(id, pass); transports.delete(id); },
    forget(id) { secrets.delete(id); transports.delete(id); },
    hasSecret: (id) => secrets.has(id),
    isRunning: () => running,
    /** После старта службы: свои ящики — на паузу (пароля нет), общий — дальше. */
    resume() {
      const own = db.prepare("SELECT id FROM mail_campaigns WHERE status = 'sending' AND sender_mode = 'own'").all();
      for (const c of own) if (!secrets.has(c.id)) pause(c.id, "Нужен пароль от ящика: отправка остановилась при перезапуске службы");
      if (db.prepare("SELECT 1 FROM mail_campaigns WHERE status = 'sending' LIMIT 1").get()) this.kick();
    },
    stop() { stopped = true; if (timer) clearTimeout(timer); },
    campaign,
  };
}

function isTemporary(err) {
  const code = Number(err && err.responseCode);
  return code >= 400 && code < 500;
}

// Текст ошибки — тот же перевод, что у оповещений платформы.
const mailerDescribe = (err) => String(mailer.describeError(err)).slice(0, 500);

module.exports = { createQueue, readSettings, transportFor, fill, letterText, KEYS, MAX_ATTEMPTS };
