const express = require("express");
const { requireAdmin } = require("../middleware/auth");
const { sanitizeHtml } = require("../services/mailHtml");
const { emit, settingsFor } = require("../services/notifications");
const T = require("../services/tasks");

// ============================================================================
//  Задачи администраторов
//
//  Раздел целиком — только для администраторов платформы, и ответственными
//  тоже назначаются только они. Проверка стоит на КАЖДОМ маршруте (router.use
//  ниже), а не только на пункте меню: скрытая кнопка — не защита.
//
//  Всё, что меняется в задаче, пишется в её историю (task_events) с автором и
//  временем. История — то, ради чего задачу открывают через неделю: «кто
//  сдвинул срок и почему».
// ============================================================================

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 4000;
const COMMENT_MAX = 2000;
const CHECK_TEXT_MAX = 200;
const CHECK_ITEMS_MAX = 50;
const TAGS_MAX = 5;
const TAG_MAX = 30;
const ASSIGNEES_MAX = 10;

const PRIORITIES = new Set(["low", "medium", "high", "critical"]);
const STATUSES = new Set(["todo", "progress", "done"]);

function parseId(raw) {
  return /^[1-9]\d{0,17}$/.test(String(raw)) ? Number(raw) : null;
}

/** Ошибка проверки ввода: ловится в обработчике и уходит ответом 400. */
class Invalid extends Error {}
const fail = (msg) => { throw new Invalid(msg); };

function text(value, { max, field, required = false }) {
  if (value === undefined || value === null || value === "") {
    if (required) fail(`Заполните поле «${field}»`);
    return null;
  }
  if (typeof value !== "string") fail(`Поле «${field}» должно быть текстом`);
  const v = value.trim();
  if (required && !v) fail(`Заполните поле «${field}»`);
  if (v.length > max) fail(`Поле «${field}» — не длиннее ${max} символов`);
  return v || null;
}

// Доска заметок: потолок на размер листа (HTML с оформлением).
const BOARD_MAX = 1000000;

function dueDate(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!T.parseDay(value)) fail("Срок — дата в виде ГГГГ-ММ-ДД");
  return value;
}

function dueTime(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) fail("Время срока — в виде ЧЧ:ММ");
  return value;
}

/**
 * Срок целиком: день (и время) или период «с … по …». У периода нет времени,
 * а первый день не позже последнего; период в один день — это просто день.
 */
function dueRange(from, to, time) {
  if (!to) return { due_from: null, due_date: null, due_time: null };
  if (from && from > to) fail("Начало срока позже его конца");
  if (from && from < to) return { due_from: from, due_date: to, due_time: null };
  return { due_from: null, due_date: to, due_time: time };
}

function tags(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  const clean = [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
  if (clean.length > TAGS_MAX) fail(`Меток — не больше ${TAGS_MAX}`);
  if (clean.some((t) => t.length > TAG_MAX)) fail(`Метка — не длиннее ${TAG_MAX} символов`);
  return clean;
}

module.exports = function tasksRouter(db) {
  const router = express.Router();
  router.use(requireAdmin);

  /** Ответственными можно назначить только администраторов — проверяем по базе. */
  function checkAssignees(raw) {
    if (!Array.isArray(raw) || !raw.length) fail("Назначьте хотя бы одного ответственного");
    const ids = [...new Set(raw.map(parseId))];
    if (ids.includes(null)) fail("Некорректный ответственный");
    if (ids.length > ASSIGNEES_MAX) fail(`Ответственных — не больше ${ASSIGNEES_MAX}`);
    const found = db.prepare(
      `SELECT id FROM users WHERE is_admin = 1 AND id IN (${ids.map(() => "?").join(",")})`
    ).all(...ids);
    if (found.length !== ids.length) fail("Ответственным можно назначить только администратора платформы");
    return ids;
  }

  /** Заявка по номеру («ИТ-0042») или пусто. */
  function ticketRef(value) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || value.length > 30) fail("Номер заявки — вроде «ИТ-0042»");
    const t = db.prepare("SELECT id FROM tickets WHERE display_id = ?").get(value.trim().toUpperCase());
    if (!t) fail(`Заявки ${value.trim()} нет`);
    return t.id;
  }

  const getTask = (id) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);

  function handle(fn) {
    return (req, res) => {
      try {
        fn(req, res);
      } catch (err) {
        if (err instanceof Invalid) return res.status(400).json({ error: err.message });
        throw err;
      }
    };
  }

  /** Пометить, что человек видел задачу до последнего события включительно. */
  function markSeen(taskId, userId) {
    const last = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM task_events WHERE task_id = ?").get(taskId).id;
    db.prepare("UPDATE task_assignees SET seen_event_id = ? WHERE task_id = ? AND user_id = ?").run(last, taskId, userId);
  }

  function notifyAssigned(task, userIds, actor) {
    const targets = userIds.filter((id) => id !== actor.id);
    if (!targets.length) return;
    emit(db, {
      kind: "task_assigned",
      subject: task.title,
      subjectRef: String(task.id),
      dedupKey: `task_assigned:${task.id}:${targets.join(",")}:${Date.now()}`,
      payload: T.taskPayload(db, task, { кто_назначил: actor.full_name }),
      userIds: targets,
    });
  }

  // --------------------------------------------------------------------------
  //  Кого можно назначить: администраторы платформы
  // --------------------------------------------------------------------------
  router.get("/people", (req, res) => {
    const people = db.prepare("SELECT id, full_name FROM users WHERE is_admin = 1 ORDER BY full_name").all();
    res.json({ people });
  });

  // --------------------------------------------------------------------------
  //  Счётчик для меню: мои открытые задачи, которые просрочены или где есть
  //  новое от других.
  // --------------------------------------------------------------------------
  router.get("/summary", (req, res) => {
    const me = req.session.user.id;
    const rows = db.prepare(`
      SELECT t.id, t.status, t.due_date, t.due_time,
        EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = t.id AND e.id > a.seen_event_id
                AND e.user_id IS NOT NULL AND e.user_id != a.user_id) AS unread
      FROM tasks t JOIN task_assignees a ON a.task_id = t.id AND a.user_id = ?
      WHERE t.status != 'done'
    `).all(me);
    const now = new Date();
    const overdue = rows.filter((t) => T.isOverdue(t, now)).length;
    const attention = rows.filter((t) => t.unread || T.isOverdue(t, now)).length;
    res.json({ overdue, unread: rows.filter((t) => t.unread).length, attention });
  });

  // --------------------------------------------------------------------------
  //  Список
  //
  //  scope: all | mine (я ответственный) | created (я автор)
  //  status: open | done | all. Готовые — последние 200: история бесконечна, а
  //  листать её в списке никто не станет, для этого есть поиск.
  //  from, to: YYYY-MM-DD — только задачи со сроком в этих днях (календарь).
  //  Календарю нужны и выполненные — он показывает их зачёркнутыми, — поэтому
  //  с диапазоном обычно идёт status=all.
  // --------------------------------------------------------------------------
  router.get("/", handle((req, res) => {
    const me = req.session.user.id;
    const scope = ["all", "mine", "created"].includes(req.query.scope) ? req.query.scope : "all";
    const done = req.query.status === "done";
    const all = req.query.status === "all";
    const from = req.query.from ? dueDate(req.query.from) : null;
    const to = req.query.to ? dueDate(req.query.to) : null;
    const ranged = Boolean(from && to);

    const where = [all ? "1 = 1" : done ? "t.status = 'done'" : "t.status != 'done'"];
    const params = [];
    // Период попадает в календарь, если пересекается с показанными днями.
    if (ranged) { where.push("COALESCE(t.due_from, t.due_date) <= ? AND t.due_date >= ?"); params.push(to, from); }
    if (scope === "mine") { where.push("EXISTS (SELECT 1 FROM task_assignees x WHERE x.task_id = t.id AND x.user_id = ?)"); params.push(me); }
    if (scope === "created") { where.push("t.created_by = ?"); params.push(me); }

    const rows = db.prepare(`
      SELECT t.id, t.title, t.priority, t.status, t.due_date, t.due_from, t.due_time, t.tags, t.done_at,
             t.created_by, cu.full_name AS created_by_name,
             k.id AS ticket_id, k.display_id AS ticket_display_id,
             (SELECT COUNT(*) FROM task_checklist c WHERE c.task_id = t.id) AS check_total,
             (SELECT COUNT(*) FROM task_checklist c WHERE c.task_id = t.id AND c.done = 1) AS check_done,
             EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ?
                     AND EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = t.id AND e.id > a.seen_event_id
                                 AND e.user_id IS NOT NULL AND e.user_id != a.user_id)) AS unread
      FROM tasks t
      JOIN users cu ON cu.id = t.created_by
      LEFT JOIN tickets k ON k.id = t.ticket_id
      WHERE ${where.join(" AND ")}
      ORDER BY ${done && !ranged ? "t.done_at DESC" : "t.due_date IS NULL, t.due_date, t.due_time IS NULL, t.due_time, t.id"}
      LIMIT ${done && !ranged ? 200 : 1000}
    `).all(me, ...params);

    const people = db.prepare(`
      SELECT a.task_id, u.id, u.full_name FROM task_assignees a JOIN users u ON u.id = a.user_id
    `).all();
    const byTask = new Map();
    for (const p of people) {
      if (!byTask.has(p.task_id)) byTask.set(p.task_id, []);
      byTask.get(p.task_id).push({ id: p.id, full_name: p.full_name });
    }

    // Поиск — здесь, а не в SQL: LOWER() в SQLite понимает только латиницу, а
    // задач у администраторов сотни, не миллионы.
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase().slice(0, 100) : "";
    const now = new Date();
    const tasks = rows
      .map((t) => ({
        id: t.id, title: t.title, priority: t.priority, status: t.status,
        due_date: t.due_date, due_from: t.due_from, due_time: t.due_time, done_at: t.done_at,
        tags: t.tags ? t.tags.split(",") : [],
        ticket: t.ticket_id ? { id: t.ticket_id, display_id: t.ticket_display_id } : null,
        created_by: { id: t.created_by, full_name: t.created_by_name },
        assignees: byTask.get(t.id) || [],
        checklist: { done: t.check_done, total: t.check_total },
        unread: Boolean(t.unread),
        overdue: T.isOverdue(t, now),
        days: t.due_date ? T.daysUntil(t.due_date, now) : null,
      }))
      .filter((t) => !q || t.title.toLowerCase().includes(q) || t.tags.some((g) => g.toLowerCase().includes(q))
        || (t.ticket && t.ticket.display_id.toLowerCase().includes(q)));
    // Пороги напоминаний — чтобы карточка честно показывала «напомню за 3 дня,
    // за 1 день и в день срока», а не выдуманный текст.
    const s = settingsFor(db, "task_due");
    const thresholds = String((s && s.thresholds) || "").split(",").filter(Boolean).map(Number);
    res.json({ tasks, today: T.localDay(now), thresholds, remindersOn: Boolean(s && s.enabled) });
  }));

  // --------------------------------------------------------------------------
  //  Карточка
  // --------------------------------------------------------------------------
  // --------------------------------------------------------------------------
  //  Доска заметок: общий лист с оформлением (Задачи → Заметки)
  //
  //  Сохраняется сам по ходу набора. Сохранение несёт номер версии, с которой
  //  начинали: если лист за это время сохранил кто-то другой — 409 и его
  //  текст, а не тихая перезапись. HTML чистится тем же белым списком, что и
  //  текст рассылок.
  // --------------------------------------------------------------------------
  const boardRow = () => {
    const r = db.prepare(`
      SELECT b.html, b.version, b.updated_at, u.full_name AS updated_by
      FROM notes_board b LEFT JOIN users u ON u.id = b.updated_by WHERE b.id = 1
    `).get();
    return r ? { ...r } : { html: "", version: 0, updated_at: null, updated_by: null };
  };
  router.get("/board", (req, res) => res.json(boardRow()));
  router.put("/board", handle((req, res) => {
    const b = req.body || {};
    if (typeof b.html !== "string") fail("Нет текста заметок");
    if (b.html.length > BOARD_MAX) fail("Заметок слишком много для одного листа — перенесите часть в задачи");
    const cur = boardRow();
    if (!Number.isInteger(b.version) || b.version !== cur.version) {
      return res.status(409).json({ error: "Заметки успели изменить", ...cur });
    }
    const html = sanitizeHtml(b.html);
    db.prepare(`
      INSERT INTO notes_board (id, html, version, updated_by, updated_at) VALUES (1, ?, 1, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET html = excluded.html, version = notes_board.version + 1,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).run(html, req.session.user.id);
    res.json(boardRow());
  }));

  router.get("/:id", handle((req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Некорректный номер задачи" });
    const t = getTask(id);
    if (!t) return res.status(404).json({ error: "Задача не найдена" });
    const ticket = t.ticket_id ? db.prepare("SELECT id, display_id, title FROM tickets WHERE id = ?").get(t.ticket_id) : null;
    const checklist = db.prepare("SELECT id, text, done FROM task_checklist WHERE task_id = ? ORDER BY position, id").all(id)
      .map((c) => ({ ...c, done: Boolean(c.done) }));
    const events = db.prepare(`
      SELECT e.id, e.kind, e.text, e.created_at, e.user_id, u.full_name AS user_name
      FROM task_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.task_id = ? ORDER BY e.id DESC LIMIT 200
    `).all(id);
    const creator = db.prepare("SELECT id, full_name FROM users WHERE id = ?").get(t.created_by);
    res.json({
      task: {
        id: t.id, title: t.title, description: t.description, priority: t.priority, status: t.status,
        due_date: t.due_date, due_from: t.due_from, due_time: t.due_time, tags: t.tags ? t.tags.split(",") : [],
        created_at: t.created_at, done_at: t.done_at, created_by: creator,
        ticket, assignees: T.assigneesOf(db, id), checklist, events,
        overdue: T.isOverdue(t), days: t.due_date ? T.daysUntil(t.due_date) : null,
      },
    });
  }));

  // Открыл задачу — всё, что в ней было до этой минуты, для него прочитано.
  router.post("/:id/seen", handle((req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Некорректный номер задачи" });
    markSeen(id, req.session.user.id);
    res.json({ ok: true });
  }));

  // --------------------------------------------------------------------------
  //  Создание
  // --------------------------------------------------------------------------
  router.post("/", handle((req, res) => {
    const b = req.body || {};
    const me = req.session.user;
    const title = text(b.title, { max: TITLE_MAX, field: "Задача", required: true });
    const description = text(b.description, { max: DESCRIPTION_MAX, field: "Описание" });
    const priority = b.priority === undefined ? "medium" : b.priority;
    if (!PRIORITIES.has(priority)) fail("Неизвестная важность");
    const time = dueTime(b.due_time);
    if (time && !b.due_date) fail("Время срока без даты не имеет смысла");
    if (b.due_from && !b.due_date) fail("У периода нужен последний день");
    const due = dueRange(dueDate(b.due_from), dueDate(b.due_date), time);
    const tagList = tags(b.tags);
    const assignees = checkAssignees(b.assignees);
    const ticketId = ticketRef(b.ticket);
    const items = Array.isArray(b.checklist) ? b.checklist.map((x) => text(x, { max: CHECK_TEXT_MAX, field: "Пункт чек-листа" })).filter(Boolean) : [];
    if (items.length > CHECK_ITEMS_MAX) fail(`Пунктов чек-листа — не больше ${CHECK_ITEMS_MAX}`);

    let taskId;
    db.exec("BEGIN");
    try {
      const info = db.prepare(`
        INSERT INTO tasks (title, description, priority, due_from, due_date, due_time, tags, ticket_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(title, description, priority, due.due_from, due.due_date, due.due_time, tagList.join(","), ticketId, me.id);
      taskId = Number(info.lastInsertRowid);
      const addA = db.prepare("INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)");
      for (const uid of assignees) addA.run(taskId, uid);
      const addC = db.prepare("INSERT INTO task_checklist (task_id, text, position) VALUES (?, ?, ?)");
      items.forEach((txt, i) => addC.run(taskId, txt, i));
      T.addEvent(db, taskId, me.id, "created", "создал задачу");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    // Себе, если он и ответственный, «новым» созданное не считаем.
    markSeen(taskId, me.id);
    notifyAssigned(getTask(taskId), assignees, me);
    res.status(201).json({ id: taskId });
  }));

  // --------------------------------------------------------------------------
  //  Правка. Принимает любое подмножество полей; каждое изменение — строка в
  //  истории, чтобы через неделю было видно, кто сдвинул срок.
  // --------------------------------------------------------------------------
  router.patch("/:id", handle((req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Некорректный номер задачи" });
    const cur = getTask(id);
    if (!cur) return res.status(404).json({ error: "Задача не найдена" });
    const b = req.body || {};
    const me = req.session.user;

    const next = { ...cur };
    const events = [];
    let newAssignees = null;
    let added = [];

    if (b.title !== undefined) {
      next.title = text(b.title, { max: TITLE_MAX, field: "Задача", required: true });
      if (next.title !== cur.title) events.push(["title", `переименовал задачу: «${next.title}»`]);
    }
    if (b.description !== undefined) {
      next.description = text(b.description, { max: DESCRIPTION_MAX, field: "Описание" });
      if ((next.description || "") !== (cur.description || "")) events.push(["description", "изменил описание"]);
    }
    if (b.priority !== undefined) {
      if (!PRIORITIES.has(b.priority)) fail("Неизвестная важность");
      next.priority = b.priority;
      if (next.priority !== cur.priority) events.push(["priority", `поменял важность: ${T.PRIORITY_LABEL[next.priority]}`]);
    }
    if (b.status !== undefined) {
      if (!STATUSES.has(b.status)) fail("Неизвестный статус");
      next.status = b.status;
      if (next.status !== cur.status) {
        events.push(["status", next.status === "done" ? "отметил задачу выполненной" : `перевёл в «${T.STATUS_LABEL[next.status]}»`]);
        // Время выполнения ставит сама база (UTC, как все отметки задач) — см. UPDATE ниже.
        next.done_at = next.status === "done" ? "now" : null;
        next.done_by = next.status === "done" ? me.id : null;
      }
    }
    if (b.due_date !== undefined || b.due_time !== undefined || b.due_from !== undefined) {
      Object.assign(next, dueRange(
        b.due_from !== undefined ? dueDate(b.due_from) : cur.due_from,
        b.due_date !== undefined ? dueDate(b.due_date) : cur.due_date,
        b.due_time !== undefined ? dueTime(b.due_time) : cur.due_time,
      ));
      if (next.due_date !== cur.due_date || next.due_time !== cur.due_time || next.due_from !== cur.due_from) {
        const was = cur.due_date ? T.formatDue(cur) : "без срока";
        const now = next.due_date ? T.formatDue(next) : "без срока";
        events.push(["due", `сдвинул срок: ${was} → ${now}`]);
      }
    }
    if (b.tags !== undefined) {
      next.tags = tags(b.tags).join(",");
      if (next.tags !== cur.tags) events.push(["tags", next.tags ? `поменял метки: ${next.tags.split(",").join(", ")}` : "убрал метки"]);
    }
    if (b.ticket !== undefined) {
      next.ticket_id = ticketRef(b.ticket);
      if (next.ticket_id !== cur.ticket_id) {
        const k = next.ticket_id ? db.prepare("SELECT display_id FROM tickets WHERE id = ?").get(next.ticket_id) : null;
        events.push(["ticket", k ? `связал с заявкой ${k.display_id}` : "убрал связь с заявкой"]);
      }
    }
    if (b.assignees !== undefined) {
      newAssignees = checkAssignees(b.assignees);
      const before = T.assigneesOf(db, id).map((u) => u.id);
      added = newAssignees.filter((x) => !before.includes(x));
      const removed = before.filter((x) => !newAssignees.includes(x));
      if (added.length || removed.length) {
        const name = (uid) => (db.prepare("SELECT full_name FROM users WHERE id = ?").get(uid) || {}).full_name || "?";
        const parts = [];
        if (added.length) parts.push(`назначил: ${added.map(name).join(", ")}`);
        if (removed.length) parts.push(`снял: ${removed.map(name).join(", ")}`);
        events.push(["assignees", parts.join("; ")]);
      } else {
        newAssignees = null;
      }
    }

    if (!events.length) return res.json({ ok: true, changed: false });

    db.exec("BEGIN");
    try {
      db.prepare(`
        UPDATE tasks SET title = ?, description = ?, priority = ?, status = ?, due_from = ?, due_date = ?, due_time = ?,
          tags = ?, ticket_id = ?, done_at = CASE WHEN ? = 'now' THEN datetime('now') ELSE ? END, done_by = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(next.title, next.description, next.priority, next.status, next.due_from, next.due_date, next.due_time,
        next.tags, next.ticket_id, next.done_at, next.done_at, next.done_by, id);
      if (newAssignees) {
        db.prepare(`DELETE FROM task_assignees WHERE task_id = ? AND user_id NOT IN (${newAssignees.map(() => "?").join(",")})`)
          .run(id, ...newAssignees);
        const addA = db.prepare("INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)");
        for (const uid of newAssignees) addA.run(id, uid);
      }
      for (const [kind, txt] of events) T.addEvent(db, id, me.id, kind, txt);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    markSeen(id, me.id);
    if (added.length) notifyAssigned(getTask(id), added, me);
    res.json({ ok: true, changed: true });
  }));

  // Удалить может только автор: у задачи есть история и ответственные, и
  // чужая задача не должна исчезать по одному неосторожному клику.
  router.delete("/:id", handle((req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Некорректный номер задачи" });
    const t = getTask(id);
    if (!t) return res.status(404).json({ error: "Задача не найдена" });
    if (t.created_by !== req.session.user.id) return res.status(403).json({ error: "Удалить задачу может только её автор" });
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    res.json({ ok: true });
  }));

  // --------------------------------------------------------------------------
  //  Комментарии
  // --------------------------------------------------------------------------
  router.post("/:id/comments", handle((req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Некорректный номер задачи" });
    const t = getTask(id);
    if (!t) return res.status(404).json({ error: "Задача не найдена" });
    const me = req.session.user;
    const body = text((req.body || {}).text, { max: COMMENT_MAX, field: "Комментарий", required: true });
    T.addEvent(db, id, me.id, "comment", body);
    markSeen(id, me.id);
    const others = T.assigneesOf(db, id).map((u) => u.id).filter((uid) => uid !== me.id);
    if (others.length) {
      emit(db, {
        kind: "task_comment",
        subject: t.title,
        subjectRef: String(id),
        dedupKey: `task_comment:${id}:${Date.now()}:${me.id}`,
        payload: T.taskPayload(db, t, { автор_комментария: me.full_name, текст: body }),
        userIds: others,
      });
    }
    res.status(201).json({ ok: true });
  }));

  // --------------------------------------------------------------------------
  //  Чек-лист
  // --------------------------------------------------------------------------
  router.post("/:id/checklist", handle((req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Некорректный номер задачи" });
    if (!getTask(id)) return res.status(404).json({ error: "Задача не найдена" });
    const body = text((req.body || {}).text, { max: CHECK_TEXT_MAX, field: "Пункт чек-листа", required: true });
    const count = db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS last FROM task_checklist WHERE task_id = ?").get(id);
    if (count.n >= CHECK_ITEMS_MAX) fail(`Пунктов чек-листа — не больше ${CHECK_ITEMS_MAX}`);
    const info = db.prepare("INSERT INTO task_checklist (task_id, text, position) VALUES (?, ?, ?)").run(id, body, count.last + 1);
    T.addEvent(db, id, req.session.user.id, "checklist", `добавил пункт: «${body}»`);
    markSeen(id, req.session.user.id);
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  }));

  router.patch("/:id/checklist/:itemId", handle((req, res) => {
    const id = parseId(req.params.id);
    const itemId = parseId(req.params.itemId);
    if (id === null || itemId === null) return res.status(400).json({ error: "Некорректный номер" });
    const item = db.prepare("SELECT * FROM task_checklist WHERE id = ? AND task_id = ?").get(itemId, id);
    if (!item) return res.status(404).json({ error: "Пункт не найден" });
    const b = req.body || {};
    const me = req.session.user;
    if (b.done !== undefined) {
      const done = Boolean(b.done);
      if (done !== Boolean(item.done)) {
        db.prepare("UPDATE task_checklist SET done = ?, done_by = ?, done_at = CASE WHEN ? THEN datetime('now') END WHERE id = ?")
          .run(done ? 1 : 0, done ? me.id : null, done ? 1 : 0, itemId);
        T.addEvent(db, id, me.id, "checklist", `${done ? "выполнил" : "вернул в работу"} пункт: «${item.text}»`);
      }
    }
    if (b.text !== undefined) {
      const body = text(b.text, { max: CHECK_TEXT_MAX, field: "Пункт чек-листа", required: true });
      if (body !== item.text) {
        db.prepare("UPDATE task_checklist SET text = ? WHERE id = ?").run(body, itemId);
        T.addEvent(db, id, me.id, "checklist", `переименовал пункт: «${body}»`);
      }
    }
    markSeen(id, me.id);
    res.json({ ok: true });
  }));

  router.delete("/:id/checklist/:itemId", handle((req, res) => {
    const id = parseId(req.params.id);
    const itemId = parseId(req.params.itemId);
    if (id === null || itemId === null) return res.status(400).json({ error: "Некорректный номер" });
    const item = db.prepare("SELECT * FROM task_checklist WHERE id = ? AND task_id = ?").get(itemId, id);
    if (!item) return res.status(404).json({ error: "Пункт не найден" });
    db.prepare("DELETE FROM task_checklist WHERE id = ?").run(itemId);
    T.addEvent(db, id, req.session.user.id, "checklist", `убрал пункт: «${item.text}»`);
    markSeen(id, req.session.user.id);
    res.json({ ok: true });
  }));

  return router;
};
