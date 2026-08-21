const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const config = require("../config/config");
const { requireAuth } = require("../middleware/auth");
const { notify } = require("../services/notifications");

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

// Карты выводятся из config/departments.js — добавили туда новый отдел,
// здесь ничего трогать не нужно.
const DEPT_PREFIX = Object.fromEntries(departments.map((d) => [d.name, d.prefix]));
const DEPT_ROLE = Object.fromEntries(departments.map((d) => [d.name, d.role]));
const ROLE_DEPT = Object.fromEntries(departments.filter((d) => d.role !== "it").map((d) => [d.role, d.name]));
const DEFAULT_DEPARTMENT = departments[0].name;

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

module.exports = function ticketRoutes(db) {
  const router = express.Router();
  router.use(requireAuth);

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(config.uploadsDir, "tickets", String(req.params.id));
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const safe = Date.now() + "_" + file.originalname.replace(/[^\w.\-]+/g, "_");
        cb(null, safe);
      },
    }),
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_MIME.has(file.mimetype)) {
        return cb(new Error("Недопустимый тип файла"));
      }
      cb(null, true);
    },
  });

  // GET /api/tickets?status=&category=&q=&mine=1
  // status: пусто = скрыть закрытые/отменённые; "archive" = только они;
  // "all" = вообще без фильтра по статусу (для дашборда); конкретное
  // значение = точное совпадение.
  // mine=1 — "Мои заявки": строго то, что человек сам создал, независимо
  // от роли и отдела. Без mine — "Входящие": для it это вообще все заявки,
  // для исполнителя (hoz/egrpo/...) — очередь именно его отдела, для
  // обычного пользователя — то, что он создал или на что назначен.
  router.get("/", (req, res) => {
    const { status, category, q, mine } = req.query;
    const user = req.session.user;

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
    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Укажите тему заявки" });
    }
    if (title.trim().length > TITLE_MAX) {
      return res.status(400).json({ error: `Тема не может быть длиннее ${TITLE_MAX} символов` });
    }
    if (description && description.length > DESCRIPTION_MAX) {
      return res.status(400).json({ error: `Описание не может быть длиннее ${DESCRIPTION_MAX} символов` });
    }
    const user = req.session.user;

    // Отдел обязателен для маршрутизации и нумерации — если не пришёл
    // или не найден в справочнике, безопасный дефолт — первый отдел в конфиге.
    let cat = category ? db.prepare("SELECT id, name FROM categories WHERE name = ?").get(category) : null;
    if (!cat) cat = db.prepare("SELECT id, name FROM categories WHERE name = ?").get(DEFAULT_DEPARTMENT);

    const displayId = nextDisplayId(db, cat.name);

    const info = db.prepare(`
      INSERT INTO tickets (display_id, title, description, category_id, priority, room, extension, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(displayId, title.trim(), description || null, cat.id, priority || "medium", room || null, extension || null, user.id);

    const ticketId = info.lastInsertRowid;

    notify(db, { ticketId, type: "new_ticket", toRole: DEPT_ROLE[cat.name] || "it", excludeUserId: user.id });

    res.status(201).json(getTicketDetail(db, ticketId));
  });

  // GET /api/tickets/:id
  router.get("/:id", (req, res) => {
    const ticket = getTicketDetail(db, req.params.id);
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
    const ticket = db.prepare(`
      SELECT t.*, c.name AS category FROM tickets t
      LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?
    `).get(req.params.id);
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
    const ticket = db.prepare(`
      SELECT t.*, c.name AS category FROM tickets t
      LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?
    `).get(req.params.id);
    if (!ticket) return res.status(404).json({ error: "Заявка не найдена" });
    if (!canAccessTicket(user, ticket)) {
      return res.status(403).json({ error: "Недостаточно прав на изменение этой заявки" });
    }

    const { status, assigned_to, priority } = req.body || {};

    if (status && status !== ticket.status) {
      db.prepare("INSERT INTO status_history (ticket_id, old_status, new_status, changed_by) VALUES (?, ?, ?, ?)")
        .run(ticket.id, ticket.status, status, user.id);
      db.prepare("UPDATE tickets SET status = ?, updated_at = datetime('now'), closed_at = CASE WHEN ? IN ('closed','cancelled','resolved') THEN datetime('now') ELSE closed_at END WHERE id = ?")
        .run(status, status, ticket.id);

      // Взял заявку в работу — стал исполнителем, если ещё никто не назначен.
      if (status === "progress" && !ticket.assigned_to) {
        db.prepare("UPDATE tickets SET assigned_to = ? WHERE id = ?").run(user.id, ticket.id);
      }

      notify(db, { ticketId: ticket.id, type: "status_changed", toUserId: ticket.created_by, excludeUserId: user.id });
    }

    if (assigned_to !== undefined) {
      db.prepare("UPDATE tickets SET assigned_to = ?, updated_at = datetime('now') WHERE id = ?")
        .run(assigned_to || null, ticket.id);
    }

    if (priority) {
      db.prepare("UPDATE tickets SET priority = ?, updated_at = datetime('now') WHERE id = ?")
        .run(priority, ticket.id);
    }

    res.json(getTicketDetail(db, ticket.id));
  });

  // POST /api/tickets/:id/comments  { text, is_internal }
  router.post("/:id/comments", (req, res) => {
    const user = req.session.user;
    const { text, is_internal } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: "Текст комментария не может быть пустым" });

    const ticket = db.prepare(`
      SELECT t.*, c.name AS category FROM tickets t
      LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?
    `).get(req.params.id);
    if (!ticket) return res.status(404).json({ error: "Заявка не найдена" });
    if (!canAccessTicket(user, ticket)) {
      return res.status(403).json({ error: "Недостаточно прав на комментирование этой заявки" });
    }

    const internal = is_internal && user.role !== "user" ? 1 : 0;

    const info = db.prepare("INSERT INTO comments (ticket_id, user_id, text, is_internal) VALUES (?, ?, ?, ?)")
      .run(ticket.id, user.id, text.trim(), internal);

    db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticket.id);

    if (!internal) {
      const notifyTarget = user.id === ticket.created_by ? ticket.assigned_to : ticket.created_by;
      if (notifyTarget) notify(db, { ticketId: ticket.id, type: "new_comment", toUserId: notifyTarget });
    }

    res.status(201).json({ id: info.lastInsertRowid });
  });

  // POST /api/tickets/:id/attachments  (multipart/form-data, field name: file)
  router.post("/:id/attachments", upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Файл не получен" });
    const user = req.session.user;

    const ticket = db.prepare(`
      SELECT t.*, c.name AS category FROM tickets t
      LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?
    `).get(req.params.id);
    if (!ticket) return res.status(404).json({ error: "Заявка не найдена" });
    if (!canAccessTicket(user, ticket)) {
      return res.status(403).json({ error: "Недостаточно прав на прикрепление файлов к этой заявке" });
    }

    const info = db.prepare(`
      INSERT INTO attachments (ticket_id, filename, filepath, filesize, mime_type, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.params.id, req.file.originalname, req.file.path, req.file.size, req.file.mimetype, user.id);

    res.status(201).json({ id: info.lastInsertRowid, filename: req.file.originalname });
  });

  return router;
};

function getTicketDetail(db, id) {
  const ticket = db.prepare(`
    SELECT t.*, c.name AS category, creator.full_name AS created_by_name, assignee.full_name AS assigned_to_name
    FROM tickets t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN users creator ON creator.id = t.created_by
    LEFT JOIN users assignee ON assignee.id = t.assigned_to
    WHERE t.id = ?
  `).get(id);
  if (!ticket) return null;

  ticket.comments = db.prepare(`
    SELECT co.id, co.text, co.is_internal, co.created_at, u.full_name AS author
    FROM comments co JOIN users u ON u.id = co.user_id
    WHERE co.ticket_id = ? ORDER BY co.created_at ASC
  `).all(id);

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
function nextDisplayId(db, deptName) {
  const prefix = DEPT_PREFIX[deptName] || "ЗАЯВ";
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM tickets t
    JOIN categories c ON c.id = t.category_id
    WHERE c.name = ?
  `).get(deptName);
  return `${prefix}-${String(row.n + 1).padStart(4, "0")}`;
}
