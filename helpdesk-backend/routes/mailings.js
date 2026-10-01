const express = require("express");
const multer = require("multer");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../config/config");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { setSetting } = require("../services/settings");
const { readTable } = require("../services/tables");
const { isEmail } = require("../services/mailer");
const { userInGroup, refreshAdGroups } = require("../services/userStore");
const { buildXlsx, XLSX_TYPE } = require("../services/xlsx");
const Q = require("../services/mailQueue");
const secretBox = require("../services/secretBox");
const { handle, str, int, Invalid } = require("./assistant");
const A = require("../services/assistant");

// ============================================================================
//  Рассылки респондентам (бывший «Почтальон»)
//
//  Список респондентов (CSV или XLSX: ОКПО, наименование, почта) -> письмо по
//  шаблону каждому -> отчёт, кому ушло и кому нет. Отправляет очередь
//  (services/mailQueue.js) — с паузами между письмами и продолжением после
//  перезапуска службы.
//
//  С какого ящика: общего (задаёт администратор) или своего — тогда сотрудник
//  вводит пароль перед отправкой, и он живёт только в памяти, пока идёт
//  рассылка.
//
//  Рассылку видит её автор и администраторы.
// ============================================================================

const fail = (msg) => { throw new Invalid(msg); };
const parseId = (raw) => (/^[1-9]\d{0,17}$/.test(String(raw)) ? Number(raw) : null);

const MAX_RECIPIENTS = 2000;
const MAX_ATTACH_TOTAL = 10 * 1024 * 1024;
const MAX_ATTACH_FILES = 10;

// Как узнать колонку по заголовку.
const HEAD = {
  email: /почт|e-?mail|эл\.?\s*адрес|электрон/i,
  okpo: /окпо/i,
  name: /наименован|организац|респондент|название/i,
};

/**
 * Строки таблицы -> респонденты. Заголовок ищется в первых пяти строках; если
 * его нет, колонки угадываются по содержимому: где «@» — почта, где 8–10 цифр
 * — ОКПО, самая длинная текстовая — наименование.
 */
function parseRecipients(rows) {
  if (!rows.length) fail("В файле нет ни одной строки");
  let headIdx = rows.slice(0, 5).findIndex((r) => r.some((c) => HEAD.email.test(c)));
  let columns, cols = {};
  if (headIdx >= 0) {
    columns = rows[headIdx].map((c, i) => c || `Колонка ${i + 1}`);
    columns.forEach((c, i) => {
      for (const [key, re] of Object.entries(HEAD)) if (cols[key] === undefined && re.test(c)) cols[key] = i;
    });
  } else {
    headIdx = -1;
    const width = Math.max(...rows.map((r) => r.length));
    columns = Array.from({ length: width }, (_, i) => `Колонка ${i + 1}`);
    const share = (i, test) => rows.filter((r) => test(r[i] || "")).length / rows.length;
    for (let i = 0; i < width; i++) {
      if (cols.email === undefined && share(i, (v) => v.includes("@")) > 0.5) cols.email = i;
      else if (cols.okpo === undefined && share(i, (v) => /^\d{8,10}$/.test(v)) > 0.5) cols.okpo = i;
    }
    let best = -1, bestLen = 0;
    for (let i = 0; i < width; i++) {
      if (i === cols.email || i === cols.okpo) continue;
      const len = rows.reduce((s, r) => s + (r[i] || "").length, 0);
      if (len > bestLen) { best = i; bestLen = len; }
    }
    if (best >= 0) cols.name = best;
  }
  if (cols.email === undefined) fail("Не нашлась колонка с адресами почты — назовите её «Почта» или «E-mail»");

  const seen = new Map();
  const recipients = rows.slice(headIdx + 1).map((r, i) => {
    const raw = r[cols.email] || "";
    const emails = [...new Set(raw.split(/[\s,;]+/).map((e) => e.trim().replace(/^mailto:/i, "")).filter(Boolean))];
    const bad = emails.filter((e) => !isEmail(e));
    const fields = Object.fromEntries(columns.map((c, k) => [c, r[k] || ""]));
    const item = {
      row_no: headIdx + 2 + i,
      okpo: cols.okpo !== undefined ? r[cols.okpo] || "" : "",
      name: cols.name !== undefined ? r[cols.name] || "" : "",
      emails: emails.filter(isEmail),
      fields,
      problem: !emails.length ? "нет адреса" : bad.length ? `неверный адрес: ${bad.join(", ")}` : null,
    };
    const key = item.emails.join(",").toLowerCase();
    if (!item.problem && key) {
      if (seen.has(key)) item.duplicateOf = seen.get(key);
      else seen.set(key, item.row_no);
    }
    return item;
  });
  if (recipients.length > MAX_RECIPIENTS) fail(`В списке больше ${MAX_RECIPIENTS} строк — разбейте его на части`);
  return {
    columns,
    detected: Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, columns[i]])),
    recipients,
  };
}

/**
 * Можно ли человеку слать с общего ящика. Если группа задана — только её
 * участникам (по группам на момент последнего входа), иначе всем. Остальным
 * общий ящик не показывается вовсе: ни вариант, ни его адрес.
 */
function canUseBox(db, user, box) {
  return !box.ad_group || userInGroup(db, user.id, box.ad_group);
}

/**
 * То же перед отправкой с ящика — с группами, уточнёнными в домене прямо сейчас:
 * запомненные при входе устаревают (вход живёт до 30 дней), и исключённый из
 * группы иначе слал бы с ящика отдела до следующего входа. Домен не ответил —
 * решают запомненные.
 */
async function mayUseBox(db, user, box) {
  if (!box.ad_group) return true;
  await refreshAdGroups(db, user.id);
  return canUseBox(db, user, box);
}

/** Общие ящики, доступные человеку: без группы — всем, с группой — её участникам. */
function boxesFor(db, user) {
  return db.prepare("SELECT * FROM mail_boxes ORDER BY address").all().filter((b) => canUseBox(db, user, b));
}

function canSee(user, c) {
  return user.is_admin || c.created_by === user.id;
}

module.exports = function mailingRoutes(db) {
  const router = express.Router();
  router.use(requireAuth);
  const queue = Q.createQueue(db);
  router.queue = queue;

  const memory = multer({
    storage: multer.memoryStorage(),
    defParamCharset: "utf8",
    limits: { fileSize: MAX_ATTACH_TOTAL, files: MAX_ATTACH_FILES + 1, fieldSize: 5 * 1024 * 1024 },
  });
  const multipart = (spec) => (req, res, next) => spec(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "Файл больше 10 МБ" });
    if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") return res.status(400).json({ error: `Не больше ${MAX_ATTACH_FILES} вложений` });
    return res.status(400).json({ error: err.message });
  });

  // -------------------------------------------------------------------------
  //  Настройки — администратор
  // -------------------------------------------------------------------------

  router.get("/settings", (req, res) => {
    const s = Q.readSettings(db);
    const mine = boxesFor(db, req.session.user).map((b) => ({ id: b.id, address: b.address }));
    const base = {
      mailboxes: mine, delayMs: s.delayMs, signature: s.signature, allowOwn: s.allowOwn,
      configured: Boolean(s.host && (mine.length || s.allowOwn)),
    };
    if (!req.session.user.is_admin) return res.json(base);
    // Администратору в настройках нужны все ящики, в том числе тех групп, где
    // сам он не состоит. Пароли наружу не отдаются — только «задан или нет».
    res.json({
      ...base, host: s.host, port: s.port, secure: s.secure, hostFromPlatform: s.hostFromPlatform,
      allMailboxes: db.prepare("SELECT id, address, ad_group, password != '' AS has_password FROM mail_boxes ORDER BY address").all()
        .map((b) => ({ ...b, has_password: Boolean(b.has_password) })),
    });
  });

  router.put("/settings", requireAdmin, handle((req, res) => {
    const b = req.body || {};
    const put = (k, v) => setSetting(db, Q.KEYS[k], v === null || v === undefined ? "" : String(v));
    if (b.host !== undefined) put("host", str(b.host, { field: "Сервер", max: 200 }));
    if (b.port !== undefined) put("port", int(b.port, { field: "Порт", min: 1, max: 65535, fallback: "" }));
    if (b.secure !== undefined) put("secure", b.secure ? "1" : "0");
    if (b.delayMs !== undefined) put("delay", int(b.delayMs, { field: "Пауза", min: 0, max: 60000 }));
    if (b.signature !== undefined) put("signature", str(b.signature, { field: "Подпись", max: 300 }) || "");
    if (b.allowOwn !== undefined) put("allowOwn", b.allowOwn ? "1" : "0");
    res.json({ ok: true });
  }));

  // Общие ящики: у каждого отдела свой. Логин — сам адрес.
  function boxValues(b, partial) {
    const out = {};
    if (!partial || b.address !== undefined) {
      const address = str(b.address, { field: "Адрес ящика", max: 200, required: true });
      if (!isEmail(address)) fail("Адрес ящика — почтовый адрес");
      out.address = address;
    }
    if (b.ad_group !== undefined || !partial) out.ad_group = str(b.ad_group, { field: "Группа домена", max: 200 }) || "";
    // Пустой пароль при правке — «не менять», как у SMTP оповещений.
    // В базе — зашифрованным (services/secretBox.js): копии баз уходят на сетевую шару.
    if (typeof b.password === "string" && b.password) out.password = secretBox.seal(b.password);
    else if (!partial) out.password = "";
    return out;
  }
  const boxFromParams = (req, res) => {
    const id = parseId(req.params.id);
    const box = id && db.prepare("SELECT * FROM mail_boxes WHERE id = ?").get(id);
    if (!box) res.status(404).json({ error: "Ящик не найден" });
    return box;
  };
  const saveBox = (fn) => {
    try { return fn(); } catch (err) {
      if (/UNIQUE/.test(err.message)) fail("Такой ящик уже есть");
      throw err;
    }
  };

  router.post("/settings/mailboxes", requireAdmin, handle((req, res) => {
    const v = boxValues(req.body || {}, false);
    const info = saveBox(() => db.prepare("INSERT INTO mail_boxes (address, password, ad_group) VALUES (?, ?, ?)").run(v.address, v.password, v.ad_group));
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  }));

  router.put("/settings/mailboxes/:id", requireAdmin, handle((req, res) => {
    const box = boxFromParams(req, res); if (!box) return;
    const v = boxValues(req.body || {}, true);
    const keys = Object.keys(v);
    if (keys.length) saveBox(() => db.prepare(`UPDATE mail_boxes SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => v[k]), box.id));
    queue.forgetBox(box.id);
    res.json({ ok: true });
  }));

  router.delete("/settings/mailboxes/:id", requireAdmin, (req, res) => {
    const box = boxFromParams(req, res); if (!box) return;
    db.prepare("DELETE FROM mail_boxes WHERE id = ?").run(box.id);
    queue.forgetBox(box.id);
    res.json({ ok: true });
  });

  // Проверка входа в ящик — кнопка «Проверить» у каждого ящика.
  router.post("/settings/mailboxes/:id/verify", requireAdmin, async (req, res) => {
    const box = boxFromParams(req, res); if (!box) return;
    const s = Q.readSettings(db);
    if (!s.host) return res.json({ ok: false, error: "Сервер не задан" });
    try {
      await Q.transportFor(s, { user: box.address, pass: secretBox.open(box.password) || "" }).verify();
      res.json({ ok: true });
    } catch (err) {
      res.json({ ok: false, error: require("../services/mailer").describeError(err) });
    }
  });

  // -------------------------------------------------------------------------
  //  Разбор списка — предпросмотр до отправки
  // -------------------------------------------------------------------------

  router.post("/parse", multipart(memory.single("file")), handle((req, res) => {
    if (!req.file) fail("Выберите файл со списком");
    let rows;
    try { rows = readTable(req.file.buffer, req.file.originalname); } catch (err) { fail(err.message); }
    res.json(parseRecipients(rows));
  }));

  // -------------------------------------------------------------------------
  //  Рассылки
  // -------------------------------------------------------------------------

  router.get("/", (req, res) => {
    const u = req.session.user;
    const rows = db.prepare(`
      SELECT c.id, c.subject, c.sender_mode, c.sender_address, c.status, c.paused_reason, c.total, c.created_at, c.finished_at,
             c.created_by, u.full_name AS author,
             SUM(r.status = 'sent') AS sent, SUM(r.status = 'failed') AS failed, SUM(r.status = 'pending') AS pending
      FROM mail_campaigns c JOIN users u ON u.id = c.created_by LEFT JOIN mail_recipients r ON r.campaign_id = c.id
      ${u.is_admin ? "" : "WHERE c.created_by = ?"}
      GROUP BY c.id ORDER BY c.id DESC LIMIT 200
    `).all(...(u.is_admin ? [] : [u.id]));
    res.json({ campaigns: rows });
  });

  router.post("/", multipart(memory.array("attachments", MAX_ATTACH_FILES)), handle(async (req, res) => {
    let p;
    try { p = JSON.parse(req.body.payload || "{}"); } catch { fail("Некорректные данные формы"); }
    const s = Q.readSettings(db);
    if (!s.host) fail("Почтовый сервер для рассылок не настроен — обратитесь к администратору");

    const subject = str(p.subject, { field: "Тема", max: 200, required: true });
    const body = str(p.body, { field: "Текст", max: 20000, required: true });
    const mode = p.sender_mode === "own" ? "own" : "shared";
    let senderAddress, senderLogin = null, password = null, mailboxId = null;
    if (mode === "shared") {
      const box = parseId(p.mailbox_id) && db.prepare("SELECT * FROM mail_boxes WHERE id = ?").get(parseId(p.mailbox_id));
      if (!box) fail("Выберите общий ящик — или отправьте со своего");
      if (!(await mayUseBox(db, req.session.user, box))) fail("Этот общий ящик доступен только участникам его группы — отправьте со своего ящика");
      senderAddress = box.address;
      mailboxId = box.id;
    } else {
      if (!s.allowOwn) fail("Отправка со своего ящика выключена администратором");
      senderAddress = str(p.own_address, { field: "Ваш адрес", max: 200, required: true });
      if (!isEmail(senderAddress)) fail("Ваш адрес — почтовый адрес");
      // Логин почты — всегда сам адрес: отдельного логина у ящиков нет.
      senderLogin = senderAddress;
      password = typeof p.own_password === "string" && p.own_password ? p.own_password : fail("Введите пароль от своего ящика");
    }

    if (!Array.isArray(p.recipients) || !p.recipients.length) fail("Список получателей пуст");
    if (p.recipients.length > MAX_RECIPIENTS) fail(`Не больше ${MAX_RECIPIENTS} получателей`);
    const recipients = p.recipients.map((r, i) => {
      const emails = (Array.isArray(r && r.emails) ? r.emails : []).map((e) => String(e).trim()).filter(Boolean);
      if (!emails.length || emails.some((e) => !isEmail(e))) fail(`Строка ${r && r.row_no ? r.row_no : i + 1}: нет правильного адреса`);
      const fields = r.fields && typeof r.fields === "object" ? r.fields : {};
      const json = JSON.stringify(fields);
      if (json.length > 4000) fail(`Строка ${r.row_no || i + 1}: слишком много данных`);
      return {
        row_no: int(r.row_no, { field: "Номер строки", min: 1, max: 1e6, fallback: i + 1 }),
        okpo: str(r.okpo, { field: "ОКПО", max: 20 }), name: str(r.name, { field: "Наименование", max: 500 }),
        emails: emails.slice(0, 10).join("; "), fields: json,
      };
    });

    const files = req.files || [];
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > MAX_ATTACH_TOTAL) fail("Вложения вместе — не больше 10 МБ");

    // Свой ящик проверяем ДО постановки в очередь: неверный пароль лучше
    // узнать сразу, а не из паузы через минуту.
    if (mode === "own") {
      try {
        await Q.transportFor(s, { user: senderLogin, pass: password }).verify();
      } catch (err) {
        fail(`Не удалось войти в ваш ящик: ${require("../services/mailer").describeError(err)}`);
      }
    }

    db.exec("BEGIN IMMEDIATE");
    let id;
    const dir = () => path.join(config.uploadsDir, "mail", String(id));
    try {
      const info = db.prepare(`
        INSERT INTO mail_campaigns (created_by, subject, body, use_template, sender_mode, sender_address, sender_login, mailbox_id, status, total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?)
      `).run(req.session.user.id, subject, body, p.use_template === false ? 0 : 1, mode, senderAddress, senderLogin, mailboxId, recipients.length);
      id = Number(info.lastInsertRowid);
      const ins = db.prepare("INSERT INTO mail_recipients (campaign_id, row_no, okpo, name, emails, fields) VALUES (?, ?, ?, ?, ?, ?)");
      for (const r of recipients) ins.run(id, r.row_no, r.okpo, r.name, r.emails, r.fields);
      if (files.length) {
        fs.mkdirSync(dir(), { recursive: true });
        const insA = db.prepare("INSERT INTO mail_attachments (campaign_id, filename, path, size) VALUES (?, ?, ?, ?)");
        files.forEach((f, i) => {
          const name = A.safeFileName(path.basename(f.originalname || `вложение-${i + 1}`)) || `вложение-${i + 1}`;
          const file = path.join(dir(), `${i + 1}_${name.replace(/[^\wа-яё.\- ]+/gi, "_")}`);
          fs.writeFileSync(file, f.buffer);
          insA.run(id, name, file, f.size);
        });
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      if (id) fs.rmSync(dir(), { recursive: true, force: true });
      throw err;
    }
    if (password) queue.setSecret(id, password);
    queue.kick();
    res.status(201).json({ id });
  }));

  function campaignFromParams(req, res) {
    const id = parseId(req.params.id);
    const c = id && db.prepare("SELECT * FROM mail_campaigns WHERE id = ?").get(id);
    if (!c) { res.status(404).json({ error: "Рассылка не найдена" }); return null; }
    if (!canSee(req.session.user, c)) { res.status(403).json({ error: "Это чужая рассылка" }); return null; }
    return c;
  }

  router.get("/:id", (req, res) => {
    const c = campaignFromParams(req, res); if (!c) return;
    const recipients = db.prepare(`
      SELECT id, row_no, okpo, name, emails, status, attempts, error, sent_at FROM mail_recipients WHERE campaign_id = ? ORDER BY row_no
    `).all(c.id);
    const attachments = db.prepare("SELECT id, filename, size FROM mail_attachments WHERE campaign_id = ?").all(c.id);
    const author = db.prepare("SELECT full_name FROM users WHERE id = ?").get(c.created_by);
    const count = (st) => recipients.filter((r) => r.status === st).length;
    const s = Q.readSettings(db);
    // Как будет выглядеть письмо первому получателю — чтобы было видно, что ушло.
    const first = db.prepare("SELECT * FROM mail_recipients WHERE campaign_id = ? ORDER BY row_no LIMIT 1").get(c.id);
    res.json({
      campaign: { ...c, author: author && author.full_name, sent: count("sent"), failed: count("failed"), pending: count("pending") },
      preview: first ? Q.letterText(c, first, s.signature) : "",
      recipients, attachments,
      needsPassword: c.sender_mode === "own",
    });
  });

  // Пауза, продолжение, отмена, повтор неотправленных.
  router.post("/:id/pause", (req, res) => {
    const c = campaignFromParams(req, res); if (!c) return;
    if (c.status !== "sending") return res.status(409).json({ error: "Рассылка сейчас не отправляется" });
    db.prepare("UPDATE mail_campaigns SET status = 'paused', paused_reason = 'Остановлена вручную' WHERE id = ?").run(c.id);
    res.json({ ok: true });
  });

  // Всё, без чего продолжать нельзя, — ДО каких-либо изменений: иначе отказ
  // оставлял бы рассылку наполовину переключённой (повтор уже вернул письма в
  // очередь, а следующая попытка с паролем отвечала «неотправленных нет»).
  async function checkRestart(req, c) {
    // Продолжение и повтор снова шлют с общего ящика — право на него проверяется заново.
    const box = c.sender_mode === "shared" && c.mailbox_id && db.prepare("SELECT * FROM mail_boxes WHERE id = ?").get(c.mailbox_id);
    if (box && !(await mayUseBox(db, req.session.user, box))) fail("Этот общий ящик доступен только участникам его группы — вас в ней больше нет");
    if (c.sender_mode === "own") {
      const pass = (req.body || {}).password;
      // Пароль нужен, только если его уже нет в памяти: после ручной паузы он
      // там остался, после перезапуска службы или неверного пароля — нет.
      if (typeof pass === "string" && pass) queue.setSecret(c.id, pass);
      else if (!queue.hasSecret(c.id)) fail("Введите пароль от своего ящика");
    }
  }

  function restart(res, c) {
    db.prepare("UPDATE mail_campaigns SET status = 'sending', paused_reason = NULL, finished_at = NULL WHERE id = ?").run(c.id);
    queue.kick();
    res.json({ ok: true });
  }

  router.post("/:id/resume", handle(async (req, res) => {
    const c = campaignFromParams(req, res); if (!c) return;
    if (c.status !== "paused") return res.status(409).json({ error: "Рассылка не на паузе" });
    await checkRestart(req, c);
    restart(res, c);
  }));

  router.post("/:id/retry", handle(async (req, res) => {
    const c = campaignFromParams(req, res); if (!c) return;
    if (c.status === "sending") return res.status(409).json({ error: "Рассылка ещё идёт" });
    const failed = db.prepare("SELECT COUNT(*) AS n FROM mail_recipients WHERE campaign_id = ? AND status = 'failed'").get(c.id).n;
    if (!failed && c.status !== "paused") return res.status(409).json({ error: "Неотправленных писем нет" });
    await checkRestart(req, c);
    db.prepare("UPDATE mail_recipients SET status = 'pending', attempts = 0, error = NULL WHERE campaign_id = ? AND status = 'failed'").run(c.id);
    restart(res, c);
  }));

  router.post("/:id/cancel", (req, res) => {
    const c = campaignFromParams(req, res); if (!c) return;
    if (c.status === "done" || c.status === "cancelled") return res.status(409).json({ error: "Рассылка уже завершена" });
    db.prepare("UPDATE mail_campaigns SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?").run(c.id);
    queue.forget(c.id);
    res.json({ ok: true });
  });

  router.delete("/:id", (req, res) => {
    const c = campaignFromParams(req, res); if (!c) return;
    if (c.status === "sending") return res.status(409).json({ error: "Сначала остановите рассылку" });
    db.prepare("DELETE FROM mail_campaigns WHERE id = ?").run(c.id);
    fs.rmSync(path.join(config.uploadsDir, "mail", String(c.id)), { recursive: true, force: true });
    queue.forget(c.id);
    res.json({ ok: true });
  });

  router.get("/:id/report", (req, res) => {
    const c = campaignFromParams(req, res); if (!c) return;
    const rows = db.prepare("SELECT * FROM mail_recipients WHERE campaign_id = ? ORDER BY row_no").all(c.id);
    const LABEL = { sent: "отправлено", failed: "не отправлено", pending: "в очереди" };
    const buf = buildXlsx([{
      name: "Отчёт",
      title: `Отчёт о рассылке: ${c.subject}`,
      subtitle: `от ${A.ruDate(c.created_at.slice(0, 10))}, с адреса ${c.sender_address}`,
      columns: [
        { title: "Строка", width: 8 }, { title: "ОКПО", width: 14 }, { title: "Наименование", width: 50 },
        { title: "Адрес", width: 36 }, { title: "Статус", width: 16 }, { title: "Причина", width: 50 }, { title: "Когда", width: 18 },
      ],
      rows: rows.map((r) => [r.row_no, r.okpo, r.name, r.emails, LABEL[r.status], r.error, r.sent_at]),
    }]);
    A.sendFile(res, buf, `отчёт о рассылке ${c.id}.xlsx`, XLSX_TYPE);
  });

  queue.resume();
  return router;
};

module.exports.parseRecipients = parseRecipients;
