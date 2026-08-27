const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { KINDS, byKind, RECIPIENTS } = require("../config/notifications");
const { settingsFor, resolveEmails, render, retryPending } = require("../services/notifications");
const mailer = require("../services/mailer");

module.exports = function notificationRoutes(db) {
  const router = express.Router();

  // ==========================================================================
  //  Бейдж «Входящих заявок» — он есть у всех ролей
  //
  //  Это персональные отметки: строки доставки канала inapp. Раздел
  //  «Оповещения» — совсем другое, он журнал и открыт только ИТ (ниже).
  // ==========================================================================

  router.get("/", requireAuth, (req, res) => {
    const rows = db.prepare(`
      SELECT d.id, e.ticket_id, e.kind AS type, d.is_read, e.created_at,
             t.display_id, t.title, t.status
      FROM notification_deliveries d
      JOIN notification_events e ON e.id = d.event_id
      JOIN tickets t ON t.id = e.ticket_id
      WHERE d.channel = 'inapp' AND d.user_id = ?
      ORDER BY e.created_at DESC LIMIT 50
    `).all(req.session.user.id);
    res.json({ notifications: rows });
  });

  router.patch("/:id/read", requireAuth, (req, res) => {
    db.prepare("UPDATE notification_deliveries SET is_read = 1 WHERE id = ? AND user_id = ? AND channel = 'inapp'")
      .run(req.params.id, req.session.user.id);
    res.json({ ok: true });
  });

  // Открыли заявку — считаем прочитанным всё по ней разом, а не по одному.
  // Раньше это было единственной причиной, по которой счётчик не спадал.
  router.patch("/ticket/:ticketId/read", requireAuth, (req, res) => {
    db.prepare(`
      UPDATE notification_deliveries SET is_read = 1
      WHERE channel = 'inapp' AND user_id = ?
        AND event_id IN (SELECT id FROM notification_events WHERE ticket_id = ?)
    `).run(req.session.user.id, req.params.ticketId);
    res.json({ ok: true });
  });

  // ==========================================================================
  //  Раздел «Оповещения» — только ИТ
  //
  //  Исполнителям ХОЗ и ЕГРПО он не нужен: им хватает «Входящих заявок» с
  //  бейджем, который работает как работал.
  // ==========================================================================

  const it = requireRole("it");

  // Лента. Это журнал, а не входящие: отметок «прочитано» здесь нет, зато у
  // каждого события видно, куда оно уехало и чем закончилось.
  router.get("/feed", it, (req, res) => {
    const { kind, source, severity, q } = req.query;
    const where = [];
    const params = [];
    if (kind && byKind(kind)) { where.push("e.kind = ?"); params.push(kind); }
    if (source) { where.push("e.source = ?"); params.push(source); }
    if (severity) { where.push("e.severity = ?"); params.push(severity); }
    if (q) { where.push("e.subject LIKE ?"); params.push(`%${q}%`); }

    const rows = db.prepare(`
      SELECT e.id, e.kind, e.source, e.subject, e.ticket_id, e.severity, e.created_at,
             t.display_id,
             SUM(CASE WHEN d.channel = 'email' THEN 1 ELSE 0 END) AS mails,
             SUM(CASE WHEN d.channel = 'email' AND d.status = 'sent' THEN 1 ELSE 0 END) AS sent,
             SUM(CASE WHEN d.channel = 'email' AND d.status = 'failed' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN d.channel = 'email' AND d.status = 'pending' THEN 1 ELSE 0 END) AS pending
      FROM notification_events e
      LEFT JOIN notification_deliveries d ON d.event_id = e.id
      LEFT JOIN tickets t ON t.id = e.ticket_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      GROUP BY e.id
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 200
    `).all(...params);

    const labels = Object.fromEntries(KINDS.map((k) => [k.kind, k.label]));
    res.json({ events: rows.map((r) => ({ ...r, label: labels[r.kind] || r.kind })) });
  });

  // Куда именно уехало одно событие — раскрытие строки в ленте.
  router.get("/feed/:id/deliveries", it, (req, res) => {
    const rows = db.prepare(`
      SELECT d.id, d.channel, d.address, d.status, d.error, d.sent_at, u.full_name
      FROM notification_deliveries d
      LEFT JOIN users u ON u.id = d.user_id
      WHERE d.event_id = ? ORDER BY d.channel, d.id
    `).all(req.params.id);
    res.json({ deliveries: rows });
  });

  // Справочник категорий вместе с их настройками. Фронтенд строит по нему обе
  // вкладки — «Шаблоны» и «Отправка», — не зная заранее, что вообще заведено.
  router.get("/kinds", it, (req, res) => {
    const items = KINDS.map((def) => {
      const s = settingsFor(db, def.kind);
      const borrowed = def.recipients === RECIPIENTS.BORROW
        ? def.borrowFrom.replace("@department", "<отдел заявки>")
        : null;
      return {
        kind: def.kind,
        label: def.label,
        hint: def.hint,
        source: def.source,
        severity: def.severity,
        trigger: def.trigger,
        recipients: def.recipients,
        borrowedFrom: borrowed,
        vars: def.vars,
        enabled: s.enabled,
        emails: s.emails,
        thresholds: s.thresholds,
        subjectTpl: s.subjectTpl,
        bodyTpl: s.bodyTpl,
        // Планировщика пока нет: категории со сроками и минутами заведены,
        // список получателей заполнить можно, но рассылка по ним ещё не идёт.
        scheduled: def.trigger !== "event",
      };
    });
    res.json({ kinds: items });
  });

  const KNOWN_KINDS = new Set(KINDS.map((k) => k.kind));
  const EMAILS_MAX = 4000;
  const TPL_MAX = 8000;

  // Ключ настройки берём только из справочника, а не из параметра запроса:
  // иначе через него можно записать любую строку в notification_settings.
  router.put("/kinds/:kind", it, (req, res) => {
    const kind = req.params.kind;
    if (!KNOWN_KINDS.has(kind)) return res.status(404).json({ error: "Неизвестная категория оповещений" });

    const def = byKind(kind);
    const body = req.body || {};

    // Адреса проверяем ПРИ СОХРАНЕНИИ, а не при отправке. Списки ведём
    // вручную, опечатка неизбежна, и заметить её надо сейчас — когда человек
    // смотрит на поле, — а не через месяц по отсутствию писем.
    let emails;
    if (body.emails !== undefined) {
      if (def.recipients !== RECIPIENTS.LIST) {
        return res.status(400).json({ error: "У этой категории свой список адресов не ведётся" });
      }
      if (typeof body.emails !== "string" || body.emails.length > EMAILS_MAX) {
        return res.status(400).json({ error: "Список адресов должен быть текстом до 4000 символов" });
      }
      const parsed = mailer.parseEmails(body.emails);
      const bad = parsed.filter((a) => !mailer.isEmail(a));
      if (bad.length) {
        return res.status(400).json({ error: `Не похоже на адрес: ${bad.slice(0, 3).join(", ")}` });
      }
      emails = parsed.join("\n");
    }

    for (const [field, value] of [["subjectTpl", body.subjectTpl], ["bodyTpl", body.bodyTpl]]) {
      if (value !== undefined && (typeof value !== "string" || value.length > TPL_MAX)) {
        return res.status(400).json({ error: `Поле ${field} должно быть текстом до 8000 символов` });
      }
    }

    let thresholds;
    if (body.thresholds !== undefined) {
      const nums = String(body.thresholds).split(/[\s,]+/).filter(Boolean).map(Number);
      if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 365)) {
        return res.status(400).json({ error: "Пороги — целые числа дней от 0 до 365, через запятую" });
      }
      // По убыванию: первым срабатывает самый ранний порог.
      thresholds = [...new Set(nums)].sort((a, b) => b - a).join(",");
    }

    const cur = settingsFor(db, kind);
    db.prepare(`
      INSERT INTO notification_settings (kind, enabled, emails, thresholds, subject_tpl, body_tpl, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'), ?)
      ON CONFLICT(kind) DO UPDATE SET
        enabled = excluded.enabled, emails = excluded.emails, thresholds = excluded.thresholds,
        subject_tpl = excluded.subject_tpl, body_tpl = excluded.body_tpl,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by
    `).run(
      kind,
      body.enabled === undefined ? (cur.enabled ? 1 : 0) : (body.enabled ? 1 : 0),
      emails === undefined ? cur.emails : emails,
      thresholds === undefined ? cur.thresholds : thresholds,
      body.subjectTpl === undefined ? cur.subjectTpl : body.subjectTpl,
      body.bodyTpl === undefined ? cur.bodyTpl : body.bodyTpl,
      req.session.user.ad_login
    );

    // Наружу отдаём только настраиваемое: сам справочник фронтенд уже получил
    // из /kinds, дублировать его в каждом ответе незачем.
    const saved = settingsFor(db, kind);
    res.json({
      ok: true,
      settings: {
        enabled: saved.enabled, emails: saved.emails, thresholds: saved.thresholds,
        subjectTpl: saved.subjectTpl, bodyTpl: saved.bodyTpl,
      },
    });
  });

  // Предпросмотр шаблона на выдуманном примере. Правка шаблона вслепую —
  // прямой путь к письму с «{{номре}}» в теме.
  router.post("/kinds/:kind/preview", it, (req, res) => {
    const def = byKind(req.params.kind);
    if (!def) return res.status(404).json({ error: "Неизвестная категория оповещений" });

    const sample = sampleFor(def);
    const s = settingsFor(db, def.kind);
    const subjectTpl = (req.body && req.body.subjectTpl) || s.subjectTpl;
    const bodyTpl = (req.body && req.body.bodyTpl) || s.bodyTpl;
    res.json({ subject: render(subjectTpl, sample), body: render(bodyTpl, sample), sample });
  });

  // ---- Настройки почты -----------------------------------------------------

  router.get("/smtp", it, (req, res) => {
    const s = mailer.readSettings(db);
    // Пароль наружу не отдаём никогда — только признак, что он задан.
    res.json({
      smtp: {
        host: s.host, port: s.port, secure: s.secure, user: s.user, from: s.from,
        hasPassword: s.hasPassword, configured: s.configured, source: s.source,
      },
    });
  });

  router.put("/smtp", it, (req, res) => {
    const b = req.body || {};
    if (b.host !== undefined && typeof b.host !== "string") {
      return res.status(400).json({ error: "Адрес сервера должен быть строкой" });
    }
    if (b.from && !mailer.isEmail(String(b.from).replace(/^.*<|>.*$/g, ""))) {
      return res.status(400).json({ error: "Адрес отправителя не похож на почтовый" });
    }
    mailer.writeSettings(db, b);
    const s = mailer.readSettings(db);
    res.json({ ok: true, smtp: { host: s.host, port: s.port, secure: s.secure, user: s.user, from: s.from, hasPassword: s.hasPassword, configured: s.configured, source: s.source } });
  });

  // Проверка соединения и, если попросили, тестовое письмо. Сейчас узнать,
  // работает ли почта, можно только по отсутствию писем — это и чиним.
  router.post("/smtp/test", it, async (req, res) => {
    const check = await mailer.verify(db);
    if (!check.ok) return res.json(check);

    const to = (req.body && req.body.to) || req.session.user.email;
    if (!to) {
      return res.json({ ok: true, detail: check.detail, warning: "Соединение есть, но некуда отправить пробное письмо: у вашей учётной записи не заполнен адрес в домене" });
    }
    if (!mailer.isEmail(to)) return res.status(400).json({ error: "Адрес получателя не похож на почтовый" });

    const sent = await mailer.send(db, {
      to,
      subject: "Проверка почты — ИТ-сервисы",
      text: "Это пробное письмо из раздела «Оповещения» платформы «ИТ-сервисы».\n" +
            "Если оно дошло — отправка настроена верно.",
    });
    res.json(sent.ok ? { ok: true, detail: `${check.detail}; пробное письмо отправлено на ${to}` } : sent);
  });

  // Журнал отправок: последние попытки со статусом и текстом ошибки.
  router.get("/deliveries", it, (req, res) => {
    const rows = db.prepare(`
      SELECT d.id, d.address, d.status, d.error, d.created_at, d.sent_at,
             e.kind, e.subject
      FROM notification_deliveries d
      JOIN notification_events e ON e.id = d.event_id
      WHERE d.channel = 'email'
      ORDER BY d.id DESC LIMIT 50
    `).all();
    const labels = Object.fromEntries(KINDS.map((k) => [k.kind, k.label]));
    res.json({ deliveries: rows.map((r) => ({ ...r, label: labels[r.kind] || r.kind })) });
  });

  router.post("/deliveries/retry", it, async (req, res) => {
    // Кнопка в панели перебирает и то, что уже помечено неудачным: обычно её
    // жмут сразу после того, как поправили настройки или адрес.
    const count = await retryPending(db, { includeFailed: true });
    res.json({ ok: true, retried: count });
  });

  // Кому уйдёт письмо по этой категории прямо сейчас — чтобы «почему Иванов не
  // получил» проверялось нажатием, а не рассуждением.
  router.get("/kinds/:kind/recipients", it, (req, res) => {
    const def = byKind(req.params.kind);
    if (!def) return res.status(404).json({ error: "Неизвестная категория оповещений" });
    if (def.recipients === RECIPIENTS.AUTHOR) {
      return res.json({ mode: "author", note: "Адрес берётся из домена у автора конкретной заявки" });
    }
    // У заимствующей категории список зависит от отдела заявки — показываем
    // все варианты, иначе ответ был бы неполным.
    if (def.recipients === RECIPIENTS.BORROW && def.borrowFrom.includes("@department")) {
      const departments = require("../config/departments");
      return res.json({
        mode: "borrow",
        byDepartment: departments.map((d) => ({
          name: d.name,
          emails: resolveEmails(db, def.kind, { department: d.role }),
        })),
      });
    }
    res.json({ mode: def.recipients, emails: resolveEmails(db, def.kind, {}) });
  });

  return router;
};

// Выдуманные данные для предпросмотра. Настоящих здесь быть не должно: экран
// настроек открывают и показывают, а в подстановках — ФИО и номера документов.
function sampleFor(def) {
  const base = {
    "номер": "ИТ-0148",
    "тема": "Не печатает принтер в 212",
    "описание": "После обновления драйвера задания висят в очереди.",
    "автор": "Пробников Пробник Пробникович",
    "кабинет": "212",
    "важность": "обычная",
    "отдел": "ИТ",
    "статус": "в работе",
    "исполнитель": "Тестова Проба Тестовна",
    "текст": "Уточняю: принтер сетевой, модель на наклейке сзади.",
    "автор_комментария": "Тестова Проба Тестовна",
  };
  const certs = {
    "вид": def.kind === "expired" ? "Доверенность" : "Сертификат",
    "фио": "Образцов Образец Образцович",
    "срок": "22.09.2026",
    "осталось_дней": "20",
    "номер_документа": "000000000000000001",
  };
  const smdr = { "период": "июль 2026", "минуты": "4210", "звонков": "1867" };
  if (def.source === "certs") return certs;
  if (def.source === "smdr") return smdr;
  return base;
}
