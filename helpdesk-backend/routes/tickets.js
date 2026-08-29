const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const config = require("../config/config");
const { requireAuth } = require("../middleware/auth");
const { emit } = require("../services/notifications");
const { ticketNewKind } = require("../config/notifications");

const ALLOWED_MIME = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 МБ

const departments = require("../config/departments");

const TITLE_MAX = 50;
const DESCRIPTION_MAX = 140;
const COMMENT_MAX = 5000;

// Допустимые значения — те же, что в CHECK-ограничениях db/schema.sql.
// Проверяем их здесь, до похода в базу: иначе произвольная строка от
// клиента доезжала до SQLite, роняла запрос на CHECK и возвращала 500
// вместо внятного 400 — а строка при этом успевала осесть в
// status_history (у той таблицы CHECK нет) и потом отрисовывалась в
// истории заявки на фронтенде.
const STATUSES = new Set(["new", "progress", "waiting", "resolved", "closed", "cancelled"]);
const PRIORITIES = new Set(["low", "medium", "high", "critical"]);

// Идентификатор заявки в URL — только положительное целое. Проверять
// обязательно ДО любой работы с ним: :id подставлялся в путь папки для
// вложений, и значение вида "..%2f..%2f" уводило запись файла за пределы
// каталога загрузок.
function parseTicketId(raw) {
  if (!/^[1-9]\d{0,17}$/.test(String(raw))) return null;
  return Number(raw);
}

// Короткие необязательные поля (кабинет, добавочный): null — не заполнено,
// false — слишком длинное/не текст, иначе — обрезанная по краям строка.
const SHORT_FIELD_MAX = 50;
function optionalShortText(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > SHORT_FIELD_MAX) return false;
  return value.trim() || null;
}

// Карты выводятся из config/departments.js — добавили туда новый отдел,
// здесь ничего трогать не нужно.
const DEPT_PREFIX = Object.fromEntries(departments.map((d) => [d.name, d.prefix]));
const DEPT_ROLE = Object.fromEntries(departments.map((d) => [d.name, d.role]));
const ROLE_DEPT = Object.fromEntries(departments.filter((d) => d.role !== "it").map((d) => [d.role, d.name]));
const DEFAULT_DEPARTMENT = departments[0].name;

// --- Оповещения по заявке ---------------------------------------------------
//
// Подстановки для писем собираются в одном месте: если каждая категория
// выбирала бы поля сама, набор {{переменных}} между письмами разъехался бы, и
// редактор шаблонов начал бы обещать то, чего в payload нет.

const PRIORITY_LABEL = { low: "низкая", medium: "обычная", high: "высокая", critical: "критическая" };
const STATUS_LABEL = {
  new: "новая", progress: "в работе", waiting: "ожидание",
  resolved: "выполнена", closed: "закрыта", cancelled: "отменена",
};
// Завершающие статусы: у них своё письмо — «ваша заявка выполнена» читается
// совсем не так, как «статус изменён на в работе».
const DONE_STATUSES = new Set(["resolved", "closed"]);

function ticketPayload(db, ticketId) {
  const t = db.prepare(`
    SELECT t.display_id, t.title, t.description, t.room, t.priority, t.status,
           c.name AS category, creator.full_name AS created_by_name,
           assignee.full_name AS assigned_to_name
    FROM tickets t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN users creator ON creator.id = t.created_by
    LEFT JOIN users assignee ON assignee.id = t.assigned_to
    WHERE t.id = ?
  `).get(ticketId);
  if (!t) return {};
  return {
    "номер": t.display_id,
    "тема": t.title,
    "описание": t.description || "",
    "автор": t.created_by_name || "",
    "кабинет": t.room || "—",
    "важность": PRIORITY_LABEL[t.priority] || t.priority,
    "отдел": t.category || "",
    "статус": STATUS_LABEL[t.status] || t.status,
    "исполнитель": t.assigned_to_name || "не назначен",
  };
}

const ticketSubject = (payload) => `${payload["номер"]} — ${payload["тема"]}`;

// Кому зажечь бейдж у «Входящих заявок». Это персональная отметка, поэтому
// исполнителей ищем по роли отдела: очередь разбирает любой из них.
const deptUserIds = (db, role, exceptId) =>
  db.prepare("SELECT id FROM users WHERE role = ? AND id != ?").all(role, exceptId || 0).map((u) => u.id);

// Единое правило видимости конкретной заявки, используется во всех местах,
// где нужно решить "может ли этот человек её увидеть/менять":
// — it видит всё;
// — hoz/egrpo видят очередь своего отдела ПЛЮС собственные заявки в любом
//   отделе (если сотрудник хоз.отдела сам завёл заявку в ИТ, он её не теряет);
// — все остальные — только то, что сами создали или на что назначены.
function canAccessTicket(user, ticket) {
  if (user.role === "it") return true;
  if (ROLE_DEPT[user.role] && ticket.category === ROLE_DEPT[user.role]) return true;
  return ticket.created_by === user.id || ticket.assigned_to === user.id;
}

// Право МЕНЯТЬ заявку (статус, исполнитель, приоритет) — уже, чем право её
// видеть: только ИТ и исполнители того отдела, куда заявка заведена.
// Ровно это и показывает фронтенд (блок "Управление" виден по тому же
// условию), но раньше проверка была только на клиенте — по API заявитель
// мог сменить статус, приоритет и назначить исполнителем кого угодно.
function canManageTicket(user, ticket) {
  if (user.role === "it") return true;
  return Boolean(ROLE_DEPT[user.role]) && ticket.category === ROLE_DEPT[user.role];
}

module.exports = function ticketRoutes(db) {
  const router = express.Router();
  router.use(requireAuth);

  const upload = multer({
    // Имя файла в multipart приходит байтами UTF-8, а busboy по умолчанию
    // читает их как latin1 — и «записка.txt» оседала в базе как
    // «Ð·Ð°Ð¿Ð¸Ñ\x81ÐºÐ°.txt». В организации, где по-русски названо всё,
    // это означало искажённое имя у каждого вложения — и в карточке, и при
    // скачивании. Одна строка вместо ручного перекодирования Buffer из latin1:
    // так правка не сломается, если multer однажды сменит умолчание.
    defParamCharset: "utf8",
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        // req.ticket проставлен в authorizeAttachment ниже — там же :id уже
        // проверен как целое число, поэтому в путь не может попасть ни "..",
        // ни слэш. Собирать путь напрямую из req.params.id нельзя: Express
        // отдаёт параметр уже раскодированным, и "..%2f..%2f" превращался в
        // настоящий переход по каталогам (файл уезжал за пределы uploads/).
        const dir = path.join(config.uploadsDir, "tickets", String(req.ticket.id));
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const safe = Date.now() + "_" + path.basename(file.originalname).replace(/[^\w.\-]+/g, "_");
        cb(null, safe);
      },
    }),
    limits: { fileSize: MAX_FILE_SIZE, files: 1 },
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_MIME.has(file.mimetype)) {
        return cb(new Error("Недопустимый тип файла"));
      }
      cb(null, true);
    },
  });

  // Проверка прав ДО multer: иначе файл успевал записаться на диск ещё до
  // того, как выяснится, что заявки нет или доступа к ней нет.
  function authorizeAttachment(req, res, next) {
    const id = parseTicketId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Некорректный идентификатор заявки" });

    const ticket = db.prepare(`
      SELECT t.*, c.name AS category FROM tickets t
      LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?
    `).get(id);
    if (!ticket) return res.status(404).json({ error: "Заявка не найдена" });
    if (!canAccessTicket(req.session.user, ticket)) {
      return res.status(403).json({ error: "Недостаточно прав на прикрепление файлов к этой заявке" });
    }
    req.ticket = ticket;
    next();
  }

  // GET /api/tickets?status=&category=&q=&mine=1
  // status: пусто = скрыть закрытые/отменённые; "archive" = только они;
  // "all" = вообще без фильтра по статусу (для дашборда); конкретное
  // значение = точное совпадение.
  // mine=1 — "Мои заявки": строго то, что человек сам создал, независимо
  // от роли и отдела. Без mine — "Входящие": для it это вообще все заявки,
  // для исполнителя (hoz/egrpo/...) — очередь именно его отдела, для
  // обычного пользователя — то, что он создал или на что назначен.
  router.get("/", (req, res) => {
    // Повторённый параметр (?status=a&status=b) Express отдаёт массивом, а
    // node:sqlite умеет привязывать только скаляры и падал бы на нём — берём
    // строку в любом случае.
    const asText = (v) => (Array.isArray(v) ? v[0] : v);
    const status = asText(req.query.status);
    const category = asText(req.query.category);
    const q = asText(req.query.q);
    const mine = asText(req.query.mine);
    const user = req.session.user;

    if ([status, category, q].some((v) => v !== undefined && typeof v !== "string")) {
      return res.status(400).json({ error: "Некорректные параметры фильтра" });
    }

    const clauses = [];
    const params = {};

    if (status === "archive") { clauses.push("t.status IN ('closed', 'cancelled')"); }
    else if (status && status !== "all") { clauses.push("t.status = @status"); params.status = status; }
    else if (!status) { clauses.push("t.status NOT IN ('closed', 'cancelled')"); }

    if (category) { clauses.push("c.name = @category"); params.category = category; }
    if (q) { clauses.push("(t.title LIKE @q OR t.display_id LIKE @q)"); params.q = `%${q}%`; }

    if (mine === "1") {
      clauses.push("t.created_by = @uid");
      params.uid = user.id;
    } else if (user.role === "it") {
      // "Входящие" для админа — без ограничений, видит все отделы.
    } else if (ROLE_DEPT[user.role]) {
      clauses.push("c.name = @deptName");
      params.deptName = ROLE_DEPT[user.role];
    } else {
      clauses.push("(t.created_by = @uid OR t.assigned_to = @uid)");
      params.uid = user.id;
    }

    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const rows = db.prepare(`
      SELECT t.id, t.display_id, t.title, t.priority, t.status, t.room, t.extension,
             t.created_at, t.updated_at,
             c.name AS category,
             creator.full_name AS created_by, creator.ad_login AS created_by_login,
             assignee.full_name AS assigned_to
      FROM tickets t
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN users creator ON creator.id = t.created_by
      LEFT JOIN users assignee ON assignee.id = t.assigned_to
      ${where}
      ORDER BY t.updated_at DESC
    `).all(params);

    res.json({ tickets: rows });
  });

  // POST /api/tickets
  router.post("/", (req, res) => {
    const { title, description, category, priority, room, extension } = req.body || {};
    // Тип проверяем явно: без этого объект/массив в поле title доходил до
    // .trim() и валил запрос пятисоткой вместо понятного 400.
    if (typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "Укажите тему заявки" });
    }
    if (title.trim().length > TITLE_MAX) {
      return res.status(400).json({ error: `Тема не может быть длиннее ${TITLE_MAX} символов` });
    }
    if (description !== undefined && description !== null && typeof description !== "string") {
      return res.status(400).json({ error: "Описание должно быть текстом" });
    }
    if (description && description.length > DESCRIPTION_MAX) {
      return res.status(400).json({ error: `Описание не может быть длиннее ${DESCRIPTION_MAX} символов` });
    }
    if (priority !== undefined && priority !== null && priority !== "" && !PRIORITIES.has(priority)) {
      return res.status(400).json({ error: "Недопустимый приоритет заявки" });
    }
    const roomValue = optionalShortText(room);
    const extensionValue = optionalShortText(extension);
    if (roomValue === false || extensionValue === false) {
      return res.status(400).json({ error: `Кабинет и добавочный не могут быть длиннее ${SHORT_FIELD_MAX} символов` });
    }
    const user = req.session.user;

    // Отдел обязателен для маршрутизации и нумерации — если не пришёл
    // или не найден в справочнике, безопасный дефолт — первый отдел в конфиге.
    let cat = typeof category === "string" && category
      ? db.prepare("SELECT id, name FROM categories WHERE name = ?").get(category)
      : null;
    if (!cat) cat = db.prepare("SELECT id, name FROM categories WHERE name = ?").get(DEFAULT_DEPARTMENT);

    const displayId = nextDisplayId(db, cat.name);

    const info = db.prepare(`
      INSERT INTO tickets (display_id, title, description, category_id, priority, room, extension, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(displayId, title.trim(), description || null, cat.id, priority || "medium", roomValue, extensionValue, user.id);

    const ticketId = info.lastInsertRowid;

    const deptRole = DEPT_ROLE[cat.name] || "it";
    const newPayload = ticketPayload(db, ticketId);
    emit(db, {
      kind: ticketNewKind(deptRole),
      subject: ticketSubject(newPayload),
      ticketId,
      dedupKey: `ticket_new:${ticketId}`,
      payload: newPayload,
      department: deptRole,
      inappUserIds: deptUserIds(db, deptRole, user.id),
    });

    res.status(201).json(getTicketDetail(db, ticketId, user));
  });

  // GET /api/tickets/:id
  router.get("/:id", (req, res) => {
    const id = parseTicketId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Некорректный идентификатор заявки" });

    const ticket = getTicketDetail(db, id, req.session.user);
    if (!ticket) return res.status(404).json({ error: "Заявка не найдена" });
    if (!canAccessTicket(req.session.user, ticket)) {
      return res.status(403).json({ error: "Недостаточно прав для просмотра этой заявки" });
    }
    res.json({ ticket });
  });

  // GET /api/tickets/:id/assignees — кандидаты в исполнители: те, у кого
  // роль соответствует отделу заявки, плюс всегда it (могут подхватить
  // любую заявку в порядке эскалации).
  router.get("/:id/assignees", (req, res) => {
    const id = parseTicketId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Некорректный идентификатор заявки" });

    const ticket = db.prepare(`
      SELECT t.*, c.name AS category FROM tickets t
      LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?
    `).get(id);
    if (!ticket) return res.status(404).json({ error: "Заявка не найдена" });
    if (!canAccessTicket(req.session.user, ticket)) {
      return res.status(403).json({ error: "Недостаточно прав" });
    }
    const deptRole = DEPT_ROLE[ticket.category];
    const rows = db.prepare(
      "SELECT id, full_name, role FROM users WHERE role = ? OR role = 'it' ORDER BY full_name"
    ).all(deptRole || "it");
    res.json({ users: rows });
  });

  // PATCH /api/tickets/:id  { status?, assigned_to?, priority? }
  router.patch("/:id", (req, res) => {
    const user = req.session.user;
    const id = parseTicketId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Некорректный идентификатор заявки" });

    const ticket = db.prepare(`
      SELECT t.*, c.name AS category FROM tickets t
      LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?
    `).get(id);
    if (!ticket) return res.status(404).json({ error: "Заявка не найдена" });
    if (!canManageTicket(user, ticket)) {
      return res.status(403).json({ error: "Недостаточно прав на изменение этой заявки" });
    }

    const { status, assigned_to, priority } = req.body || {};

    if (status !== undefined && !STATUSES.has(status)) {
      return res.status(400).json({ error: "Недопустимый статус заявки" });
    }
    if (priority !== undefined && !PRIORITIES.has(priority)) {
      return res.status(400).json({ error: "Недопустимый приоритет заявки" });
    }
    // Исполнитель — либо снятие назначения, либо существующий сотрудник с
    // подходящей ролью (те же кандидаты, что отдаёт /assignees). Раньше сюда
    // проходил любой id, в том числе чужого пользователя без отношения к отделу.
    let assignee;
    if (assigned_to !== undefined && assigned_to !== null && assigned_to !== "") {
      const assigneeId = parseTicketId(assigned_to);
      const deptRole = DEPT_ROLE[ticket.category];
      assignee = assigneeId === null ? null : db.prepare(
        "SELECT id FROM users WHERE id = ? AND (role = ? OR role = 'it')"
      ).get(assigneeId, deptRole || "it");
      if (!assignee) return res.status(400).json({ error: "Такого исполнителя нельзя назначить на эту заявку" });
    }

    if (status && status !== ticket.status) {
      // Идентификатор записи в истории служит ключом от повторов: статус может
      // ходить туда-обратно (в работу → ожидание → в работу), и каждый переход
      // заслуживает своего письма, а вот один переход — ровно одного.
      const hist = db.prepare("INSERT INTO status_history (ticket_id, old_status, new_status, changed_by) VALUES (?, ?, ?, ?)")
        .run(ticket.id, ticket.status, status, user.id);
      db.prepare("UPDATE tickets SET status = ?, updated_at = datetime('now'), closed_at = CASE WHEN ? IN ('closed','cancelled','resolved') THEN datetime('now') ELSE closed_at END WHERE id = ?")
        .run(status, status, ticket.id);

      // Взял заявку в работу — стал исполнителем, если ещё никто не назначен.
      if (status === "progress" && !ticket.assigned_to) {
        db.prepare("UPDATE tickets SET assigned_to = ? WHERE id = ?").run(user.id, ticket.id);
      }

      const statusPayload = ticketPayload(db, ticket.id);
      const byAuthor = ticket.created_by === user.id;
      emit(db, {
        kind: DONE_STATUSES.has(status) ? "ticket_resolved" : "ticket_status",
        subject: ticketSubject(statusPayload),
        ticketId: ticket.id,
        dedupKey: `ticket_status:${ticket.id}:${hist.lastInsertRowid}`,
        payload: statusPayload,
        department: DEPT_ROLE[ticket.category] || "it",
        // Автор закрыл собственную заявку — писать ему об этом незачем. Событие
        // в ленте при этом остаётся: история не должна зависеть от того, кто
        // нажал кнопку.
        authorUserId: byAuthor ? null : ticket.created_by,
        inappUserIds: byAuthor ? [] : [ticket.created_by],
      });
    }

    if (assigned_to !== undefined) {
      db.prepare("UPDATE tickets SET assigned_to = ?, updated_at = datetime('now') WHERE id = ?")
        .run(assignee ? assignee.id : null, ticket.id);
    }

    if (priority) {
      db.prepare("UPDATE tickets SET priority = ?, updated_at = datetime('now') WHERE id = ?")
        .run(priority, ticket.id);
    }

    res.json(getTicketDetail(db, ticket.id, user));
  });

  // POST /api/tickets/:id/comments  { text, is_internal }
  router.post("/:id/comments", (req, res) => {
    const user = req.session.user;
    const { text, is_internal } = req.body || {};
    const id = parseTicketId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Некорректный идентификатор заявки" });
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Текст комментария не может быть пустым" });
    }
    if (text.length > COMMENT_MAX) {
      return res.status(400).json({ error: `Комментарий не может быть длиннее ${COMMENT_MAX} символов` });
    }

    const ticket = db.prepare(`
      SELECT t.*, c.name AS category FROM tickets t
      LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?
    `).get(id);
    if (!ticket) return res.status(404).json({ error: "Заявка не найдена" });
    if (!canAccessTicket(user, ticket)) {
      return res.status(403).json({ error: "Недостаточно прав на комментирование этой заявки" });
    }

    // Право пометить заметку внутренней — ровно у того, кто её потом увидит
    // (см. getTicketDetail). Раньше здесь стояло role !== "user", и сотрудник
    // хозотдела, заведя заявку в ИТ, мог создать в ней пометку, невидимую ему
    // самому: писать её он был вправе, а читать — уже нет.
    const internal = is_internal && canManageTicket(user, ticket) ? 1 : 0;

    const info = db.prepare("INSERT INTO comments (ticket_id, user_id, text, is_internal) VALUES (?, ?, ?, ?)")
      .run(ticket.id, user.id, text.trim(), internal);

    db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticket.id);

    if (!internal) {
      // Раньше здесь адресатом был ticket.assigned_to, когда комментировал
      // автор. У неразобранной заявки исполнитель ещё не назначен — там NULL,
      // и `if (notifyTarget)` тихо проглатывал уведомление. Заявитель дописывал
      // уточнение к новой заявке, и об этом не узнавал никто.
      //
      // Теперь правило без исключений: написал автор — уходит тем, кто получил
      // саму заявку; написал кто угодно другой — уходит автору.
      const fromAuthor = user.id === ticket.created_by;
      const deptRole = DEPT_ROLE[ticket.category] || "it";
      const payload = ticketPayload(db, ticket.id);
      payload["текст"] = text.trim();
      payload["автор_комментария"] = user.full_name || user.ad_login;

      emit(db, {
        kind: fromAuthor ? "ticket_comment_in" : "ticket_comment_out",
        subject: ticketSubject(payload),
        ticketId: ticket.id,
        dedupKey: `ticket_comment:${info.lastInsertRowid}`,
        payload,
        department: deptRole,
        authorUserId: fromAuthor ? null : ticket.created_by,
        inappUserIds: fromAuthor
          ? (ticket.assigned_to ? [ticket.assigned_to] : deptUserIds(db, deptRole, user.id))
          : [ticket.created_by],
      });
    }

    res.status(201).json({ id: info.lastInsertRowid });
  });

  // POST /api/tickets/:id/attachments  (multipart/form-data, field name: file)
  router.post("/:id/attachments", authorizeAttachment, upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Файл не получен" });

    const info = db.prepare(`
      INSERT INTO attachments (ticket_id, filename, filepath, filesize, mime_type, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.ticket.id,
      path.basename(req.file.originalname),
      req.file.path,
      req.file.size,
      req.file.mimetype,
      req.session.user.id
    );

    res.status(201).json({ id: Number(info.lastInsertRowid), filename: path.basename(req.file.originalname) });
  });

  // GET /api/tickets/:id/attachments/:attachmentId — скачивание вложения.
  // Раньше файлы можно было только загрузить: маршрута отдачи не было
  // вообще, каталог uploads/ статикой не раздаётся, и приложенный к заявке
  // файл нельзя было получить обратно ничем, кроме доступа к диску сервера.
  router.get("/:id/attachments/:attachmentId", (req, res) => {
    const ticketId = parseTicketId(req.params.id);
    const attachmentId = parseTicketId(req.params.attachmentId);
    if (ticketId === null || attachmentId === null) {
      return res.status(400).json({ error: "Некорректный идентификатор" });
    }

    const ticket = db.prepare(`
      SELECT t.*, c.name AS category FROM tickets t
      LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?
    `).get(ticketId);
    if (!ticket) return res.status(404).json({ error: "Заявка не найдена" });
    if (!canAccessTicket(req.session.user, ticket)) {
      return res.status(403).json({ error: "Недостаточно прав для просмотра этой заявки" });
    }

    // Вложение обязательно должно принадлежать именно этой заявке — иначе по
    // ссылке с доступной заявки можно было бы вытащить файл из чужой.
    const att = db.prepare("SELECT * FROM attachments WHERE id = ? AND ticket_id = ?").get(attachmentId, ticket.id);
    if (!att) return res.status(404).json({ error: "Вложение не найдено" });

    // filepath пишем сами, но перед отдачей всё равно убеждаемся, что путь
    // не ушёл за пределы каталога загрузок (страховка на случай записей,
    // созданных прежней версией с уязвимым сохранением файлов).
    const uploadsRoot = path.resolve(config.uploadsDir);
    const filePath = path.resolve(att.filepath);
    if (filePath !== uploadsRoot && !filePath.startsWith(uploadsRoot + path.sep)) {
      console.error(`Вложение ${att.id} лежит вне каталога загрузок: ${att.filepath}`);
      return res.status(410).json({ error: "Файл недоступен" });
    }
    if (!fs.existsSync(filePath)) return res.status(410).json({ error: "Файл больше не хранится на сервере" });

    // Всегда как вложение и без угадывания типа браузером: даже если в базе
    // остался неожиданный mime, файл будет скачан, а не исполнен в origin
    // платформы.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", "application/octet-stream");
    res.download(filePath, path.basename(att.filename));
  });

  return router;
};

// Внутренние заметки — переписка исполнителей между собой. Видит их тот, кто
// заявкой УПРАВЛЯЕТ (ИТ и исполнители того отдела), а не всякий, кто вправе её
// открыть: у заявителя есть право читать свою заявку, но не служебные пометки о
// ней. Фильтра здесь не было вовсе — карточка отдавала все комментарии подряд,
// и фронтенд честно рисовал заявителю чужую заметку с плашкой
// «ВНУТРЕННЯЯ ЗАМЕТКА». Отсюда и параметр viewer: без него функция не может
// решить, что показывать, а звать её без зрителя больше негде.
function getTicketDetail(db, id, viewer) {
  const ticket = db.prepare(`
    SELECT t.*, c.name AS category, creator.full_name AS created_by_name, assignee.full_name AS assigned_to_name
    FROM tickets t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN users creator ON creator.id = t.created_by
    LEFT JOIN users assignee ON assignee.id = t.assigned_to
    WHERE t.id = ?
  `).get(id);
  if (!ticket) return null;

  // Отсев делает БД, а не вызывающий: забыть фильтр на одном из трёх вызовов
  // куда легче, чем не передать зрителя — а без него заметки не покажутся вовсе.
  const seesInternal = viewer && canManageTicket(viewer, ticket) ? 1 : 0;
  ticket.comments = db.prepare(`
    SELECT co.id, co.text, co.is_internal, co.created_at, u.full_name AS author
    FROM comments co JOIN users u ON u.id = co.user_id
    WHERE co.ticket_id = ? AND (? = 1 OR co.is_internal = 0)
    ORDER BY co.created_at ASC
  `).all(id, seesInternal);

  ticket.attachments = db.prepare(`
    SELECT id, filename, filesize, mime_type, uploaded_at FROM attachments WHERE ticket_id = ?
  `).all(id);

  ticket.history = db.prepare(`
    SELECT sh.old_status, sh.new_status, sh.changed_at, u.full_name AS changed_by
    FROM status_history sh JOIN users u ON u.id = sh.changed_by
    WHERE sh.ticket_id = ? ORDER BY sh.changed_at ASC
  `).all(id);

  return ticket;
}

// Номер зависит от отдела: ИТ-0001, ХОЗ-0001, ЕГРПО-0001 — свой счётчик
// на каждый отдел, а не общий сквозной.
//
// Считаем от НАИБОЛЬШЕГО уже выданного номера, а не от количества заявок.
// Через COUNT(*) счётчик откатывается назад при первом же удалении строки из
// tickets: следующая заявка получает номер, который уже занят, и вставка
// падает на UNIQUE display_id. Заявки перестали бы создаваться совсем — до тех
// пор, пока счётчик не догонит удалённое. Маршрута удаления сейчас нет, но
// чистка тестовых заявок прямо в базе — обычное дело, и цена ошибки тут
// несоразмерна цене правки.
//
// substr в SQLite считает СИМВОЛЫ, а не байты, поэтому кириллический префикс
// длиной в буквах даёт верное смещение: «ИТ-0007» -> позиция 4.
function nextDisplayId(db, deptName) {
  const prefix = DEPT_PREFIX[deptName] || "ЗАЯВ";
  const row = db.prepare(`
    SELECT MAX(CAST(substr(display_id, ?) AS INTEGER)) AS n
    FROM tickets WHERE display_id LIKE ?
  `).get(prefix.length + 2, `${prefix}-%`);
  return `${prefix}-${String((row.n || 0) + 1).padStart(4, "0")}`;
}
