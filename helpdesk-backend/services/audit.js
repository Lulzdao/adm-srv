const { KINDS } = require("../config/notifications");

// ============================================================================
//  Журнал действий администраторов
//
//  Кто и когда поменял настройки платформы: группы домена, папку копий,
//  сертификат, почту, оповещения, ящики рассылок, справочники Ассистента.
//  Раньше это было видно только по журналам служб, и то частично: «группа
//  исполнителей вчера была другой» — а кто менял, узнать было не у кого.
//
//  Устроен прослойкой, а не вызовами в каждом маршруте: записывается КАЖДЫЙ
//  успешный изменяющий запрос (POST/PUT/PATCH/DELETE) в административные
//  разделы. Новый маршрут, про который забыли, всё равно попадёт в журнал —
//  с общей подписью «METHOD путь»; тест (audit.test.js) требует, чтобы у
//  существующих маршрутов подпись была человеческой.
//
//  ЧТО НЕ ПИШЕТСЯ НИКОГДА: пароли, ключи, содержимое загруженных файлов.
//  Про пароль записывается только «изменён» / «очищен». Тела запросов целиком
//  не сохраняются — только поля, перечисленные в правиле.
//
//  Журнал только дополняется: маршрутов правки и удаления записей нет.
// ============================================================================

/** Разделы, где любое изменение — действие администратора. */
const AREAS = [
  /^\/api\/admin\//,
  /^\/api\/certificates\//,
  /^\/api\/notifications\/(kinds|schedule|smtp|deliveries)\b/,
  /^\/api\/mailings\/settings\b/,
  /^\/api\/assistant\/settings\//,
];

const kindLabel = (kind) => (KINDS.find((k) => k.kind === kind) || {}).label || kind;
/** Пароль в подробностях: не значение, а что с ним сделали. */
const secret = (body, field = "password", clear = "clearPassword") =>
  (body && body[clear] ? "очищен" : body && typeof body[field] === "string" && body[field] ? "изменён" : "не менялся");
/** Выбранные поля с русскими названиями: журнал читает человек, а не программа. names — { поле: «подпись» }. */
const named = (obj, names) => Object.fromEntries(Object.keys(names).filter((k) => obj && obj[k] !== undefined).map((k) => [names[k], obj[k]]));
const SMTP_NAMES = { host: "сервер", port: "порт", secure: "шифрование", user: "логин", from: "отправитель" };
const DICT_LABEL = { depts: "Отделы и начальники", people: "Подписанты", rules: "Типовые неисправности", reasons: "Причины списания" };
const dictLabel = (d) => DICT_LABEL[d] || d;
// Планировщик подключается при вызове: он тянет за собой рассылку и источники, а журналу нужен только список заданий.
const jobLabel = (id) => ((require("./scheduler").JOBS.find((j) => j.id === id) || {}).label || id);

// Правило: метод, путь (регулярное выражение по req.originalUrl без строки запроса), подпись и
// подробности. p — совпавшие группы пути, body — тело запроса, out — JSON ответа, before — снимок,
// снятый до выполнения (см. before). skip: true — действие ничего не меняет (проверка, предпросмотр).
const RULES = [
  { m: "POST", re: /^\/api\/auth\/login$/, only: (req) => req.session.user && req.session.user.is_admin,
    text: () => "Вход администратора", details: ({ body }) => ({ способ: body.mode === "local" ? "локальная учётка" : `домен ${body.mode}` }) },

  { m: "PUT", re: /^\/api\/admin\/settings$/, text: () => "Группы домена для отделов изменены",
    details: ({ body }) => ({ отделы: (body.departments || []).map((d) => named(d, { role: "отдел", groupA: "группа в домене A", groupB: "группа в домене B" })) }) },
  { m: "POST", re: /^\/api\/admin\/backup\/check$/, skip: true },
  { m: "PUT", re: /^\/api\/admin\/backup$/, text: ({ body }) => `Папка резервных копий: ${String(body.dir || "").trim() || "по умолчанию"}` },

  { m: "POST", re: /^\/api\/certificates\/server$/, text: () => "Загружен сертификат сервера",
    details: ({ out }) => ({ ...named((out && out.certificate) || {}, { subject: "выдан на", validTo: "действует до" }), "нужен перезапуск": Boolean(out && out.restartRequired) }) },
  { m: "POST", re: /^\/api\/certificates\/restart$/, text: () => "Платформа перезапущена из панели" },
  { m: "POST", re: /^\/api\/certificates\/trusted$/, text: ({ out }) => `Добавлен доверенный корень${out && out.root && out.root.subject ? ` ${out.root.subject}` : ""}` },
  { m: "DELETE", re: /^\/api\/certificates\/trusted\/([^/]+)$/, text: ({ p }) => `Удалён доверенный корень ${p[1]}` },

  { m: "PUT", re: /^\/api\/notifications\/kinds\/([^/]+)$/, text: ({ p }) => `Оповещения: изменена категория «${kindLabel(p[1])}»`,
    details: ({ body }) => ({ ...named(body, { enabled: "включено", emails: "адреса", thresholds: "пороги", channels: "каналы" }),
      ...(body.subject_tpl !== undefined || body.subjectTpl !== undefined ? { "тема письма": "изменена" } : {}),
      ...(body.body_tpl !== undefined || body.bodyTpl !== undefined ? { "текст письма": "изменён" } : {}) }) },
  { m: "POST", re: /^\/api\/notifications\/kinds\/[^/]+\/preview$/, skip: true },
  { m: "PUT", re: /^\/api\/notifications\/schedule$/, text: ({ body }) => `Оповещения: час ежедневных заданий — ${body.hour}:00` },
  { m: "POST", re: /^\/api\/notifications\/schedule\/([^/]+)\/run$/, text: ({ p }) => `Задание запущено вручную: ${jobLabel(p[1])}`,
    details: ({ out }) => (out && out.ok === false ? { итог: "не выполнено", ошибка: out.error } : {}) },
  { m: "PUT", re: /^\/api\/notifications\/smtp$/, text: () => "Почта оповещений: настройки изменены",
    details: ({ body }) => ({ ...named(body, SMTP_NAMES), пароль: secret(body) }) },
  { m: "POST", re: /^\/api\/notifications\/smtp\/test$/, skip: true },
  { m: "POST", re: /^\/api\/notifications\/deliveries\/retry$/, text: () => "Оповещения: повтор отправки неушедших писем" },

  { m: "PUT", re: /^\/api\/mailings\/settings$/, text: () => "Рассылки: настройки изменены",
    details: ({ body }) => named(body, { host: "сервер", port: "порт", secure: "шифрование", delayMs: "пауза между письмами, мс", signature: "подпись", allowOwn: "свой ящик разрешён" }) },
  { m: "POST", re: /^\/api\/mailings\/settings\/mailboxes$/, text: ({ body }) => `Рассылки: добавлен общий ящик ${body.address || ""}`,
    details: ({ body }) => ({ группа: body.ad_group || "(все)", пароль: body.password ? "задан" : "не задан" }) },
  { m: "PUT", re: /^\/api\/mailings\/settings\/mailboxes\/(\d+)$/,
    before: (req, db, p) => db.prepare("SELECT address FROM mail_boxes WHERE id = ?").get(Number(p[1])),
    text: ({ before, p }) => `Рассылки: изменён общий ящик ${(before && before.address) || `#${p[1]}`}`,
    details: ({ body }) => ({ ...named(body, { address: "адрес", ad_group: "группа" }), пароль: body.password ? "изменён" : "не менялся" }) },
  { m: "DELETE", re: /^\/api\/mailings\/settings\/mailboxes\/(\d+)$/,
    before: (req, db, p) => db.prepare("SELECT address FROM mail_boxes WHERE id = ?").get(Number(p[1])),
    text: ({ before, p }) => `Рассылки: удалён общий ящик ${(before && before.address) || `#${p[1]}`}` },
  { m: "POST", re: /^\/api\/mailings\/settings\/mailboxes\/\d+\/verify$/, skip: true },

  { m: "PUT", re: /^\/api\/assistant\/settings\/general$/, text: () => "Ассистент: общие настройки изменены",
    details: ({ body }) => ({ изменено: Object.keys(body || {}) }) },
  { m: "POST", re: /^\/api\/assistant\/settings\/dict\/([^/]+)$/, text: ({ p }) => `Справочник «${dictLabel(p[1])}»: добавлена запись`,
    details: ({ body }) => body },
  { m: "PUT", re: /^\/api\/assistant\/settings\/dict\/([^/]+)\/(\d+)$/, text: ({ p }) => `Справочник «${dictLabel(p[1])}»: изменена запись #${p[2]}`,
    details: ({ body }) => body },
  { m: "DELETE", re: /^\/api\/assistant\/settings\/dict\/([^/]+)\/(\d+)$/, text: ({ p }) => `Справочник «${dictLabel(p[1])}»: удалена запись #${p[2]}` },
  { m: "POST", re: /^\/api\/assistant\/settings\/templates\/([^/]+)$/, text: ({ p }) => `Ассистент: загружен шаблон «${p[1]}»`,
    details: ({ req }) => (req.file ? { файл: req.file.originalname, байт: req.file.size } : {}) },
  { m: "DELETE", re: /^\/api\/assistant\/settings\/templates\/([^/]+)$/, text: ({ p }) => `Ассистент: шаблон «${p[1]}» возвращён к стандартному` },
];

const pathOf = (req) => String(req.originalUrl || "").split("?")[0];

function findRule(method, path) {
  for (const r of RULES) {
    if (r.m !== method) continue;
    const p = r.re.exec(path);
    if (p) return { rule: r, p };
  }
  return null;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_DETAILS = 4000;

/** Подробности — JSON; слишком длинные обрезаются, поля с паролем на всякий случай вычёркиваются. */
function packDetails(details) {
  if (!details || typeof details !== "object") return null;
  const clean = JSON.stringify(details, (k, v) => (/pass|парол|secret|token|key/i.test(k) && typeof v === "string" && !/^(изменён|очищен|не менялся|задан|не задан)$/.test(v) ? "(скрыто)" : v));
  if (!clean || clean === "{}") return null;
  return clean.length > MAX_DETAILS ? clean.slice(0, MAX_DETAILS) + "…" : clean;
}

function record(db, { user, action, summary, details, ip }) {
  try {
    db.prepare("INSERT INTO admin_audit (at, user_id, login, full_name, action, summary, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), user ? user.id : null, user ? user.ad_login : null, user ? user.full_name : null,
        action, summary, packDetails(details), ip || null);
  } catch (err) {
    // Журнал не должен ронять само действие: оно уже выполнено.
    console.error("[журнал действий] запись не удалась:", err.message);
  }
}

/** Прослойка: ставится после сессии, до маршрутов. */
function middleware(db) {
  return (req, res, next) => {
    if (!MUTATING.has(req.method)) return next();
    const path = pathOf(req);
    const found = findRule(req.method, path);
    if (!found && !AREAS.some((re) => re.test(path))) return next();
    if (found && found.rule.skip) return next();

    // Снимок «как было» — до выполнения: после удаления ящика его адрес уже не узнать.
    let before = null;
    if (found && found.rule.before) { try { before = found.rule.before(req, db, found.p); } catch { /* таблицы может не быть — не беда */ } }

    // Ответ маршрута — для подробностей (чей сертификат загружен и т. п.).
    let out = null;
    const json = res.json.bind(res);
    res.json = (body) => { out = body; return json(body); };

    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;       // отказ и ошибка — не действие
      const user = req.session && req.session.user;
      if (!user) return;
      if (found && found.rule.only && !found.rule.only(req)) return;
      const ctx = { req, body: req.body || {}, out, before, p: found ? found.p : [] };
      let summary; let details = null;
      try {
        summary = found ? found.rule.text(ctx) : `${req.method} ${path}`;
        details = found && found.rule.details ? found.rule.details(ctx) : null;
      } catch { summary = `${req.method} ${path}`; }
      record(db, { user, action: `${req.method} ${found ? found.rule.re.source.replace(/\\\//g, "/").replace(/^\^|\$$/g, "") : path}`.slice(0, 200), summary: String(summary).slice(0, 300), details, ip: req.ip });
    });
    next();
  };
}

/** Чтение журнала: новые сверху, поиск по тексту и логину, страницами через before. */
function list(db, { q = "", before = null, limit = 100 } = {}) {
  const where = []; const args = [];
  if (before) { where.push("id < ?"); args.push(Number(before)); }
  // LIKE в SQLite не приводит кириллицу к одному регистру — текст ищем уже в JS, по приведённому к нижнему.
  const text = String(q || "").trim().toLowerCase();
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const sql = `SELECT id, at, login, full_name, summary, details, ip FROM admin_audit ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC`;
  const rows = [];
  for (const r of db.prepare(sql).iterate(...args)) {
    if (text && !`${r.summary} ${r.login} ${r.full_name} ${r.details || ""}`.toLowerCase().includes(text)) continue;
    rows.push({ ...r, details: r.details ? safeParse(r.details) : null });
    if (rows.length > lim) break;
  }
  const more = rows.length > lim;
  return { rows: rows.slice(0, lim), more };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return { текст: s }; } }

module.exports = { middleware, record, list, findRule, RULES, AREAS };
