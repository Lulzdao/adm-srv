const config = require("../config/config");

// ============================================================================
//  Задачи: общее для маршрутов и ежедневного обхода
//
//  Сроки считаются в МЕСТНОМ времени сервера и по календарным дням: «за 1 день»
//  — это вчера по календарю, а не «ровно 24 часа назад». Иначе задача со
//  сроком «пятница» напоминала бы о себе в четверг в разное время в
//  зависимости от того, во сколько её завели.
// ============================================================================

// Те же слова, что в интерфейсе («Низкий», «Средний», …), только в роде слова «важность».
const PRIORITY_LABEL = { low: "низкая", medium: "средняя", high: "высокая", critical: "критичная" };
const STATUS_LABEL = { todo: "к выполнению", progress: "в работе", done: "готово" };
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

const pad = (n) => String(n).padStart(2, "0");
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Дата YYYY-MM-DD как полночь местного времени; null, если не дата. */
function parseDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // 2026-02-31 JavaScript молча превращает в 3 марта — такую дату отвергаем.
  return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

/** Сколько календарных дней до срока: 0 — сегодня, отрицательное — просрочено. */
function daysUntil(dueDate, now = new Date()) {
  const due = parseDay(dueDate);
  if (!due) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}

/**
 * Просрочена ли задача прямо сейчас. Срок со временем истекает в эту минуту,
 * без времени — с концом дня: «до пятницы» значит «до конца пятницы».
 */
function isOverdue(task, now = new Date()) {
  if (task.status === "done" || !task.due_date) return false;
  const d = daysUntil(task.due_date, now);
  if (d === null) return false;
  if (d < 0) return true;
  return d === 0 && Boolean(task.due_time) && task.due_time < localTime(now);
}

/**
 * «2 окт, пт, 18:00» — как срок подписан в письмах. Период — «5–11 окт» или
 * «28 сен – 4 окт»: задача на неделю или месяц, а не на конкретный день.
 */
function formatDue(task) {
  const d = parseDay(task.due_date);
  if (!d) return "без срока";
  const f = parseDay(task.due_from);
  if (f && f < d) {
    return f.getMonth() === d.getMonth() && f.getFullYear() === d.getFullYear()
      ? `${f.getDate()}–${d.getDate()} ${MONTHS[d.getMonth()]}`
      : `${f.getDate()} ${MONTHS[f.getMonth()]} – ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${WEEKDAYS[d.getDay()]}${task.due_time ? `, ${task.due_time}` : ""}`;
}

/** «сегодня», «завтра», «через 3 дн.» — для темы напоминания. */
function relativeDue(days) {
  if (days === 0) return "сегодня";
  if (days === 1) return "завтра";
  return `через ${days} дн.`;
}

/** Ссылка на задачу, если известен адрес платформы; иначе — как её найти. */
function taskLink(id) {
  return config.publicUrl ? `${config.publicUrl}/#task/${id}` : "Открыть: Центр → Задачи";
}

/** Ссылка на список задач — для утренней сводки. */
function listLink() {
  return config.publicUrl ? `${config.publicUrl}/#tasks` : "Открыть: Центр → Задачи";
}

function assigneesOf(db, taskId) {
  return db.prepare(`
    SELECT u.id, u.full_name FROM task_assignees a JOIN users u ON u.id = a.user_id
    WHERE a.task_id = ? ORDER BY u.full_name
  `).all(taskId);
}

/** Подстановки для шаблонов писем о задаче (см. TASK_VARS в config/notifications.js). */
function taskPayload(db, task, extra = {}) {
  return {
    задача: task.title,
    срок: formatDue(task),
    важность: PRIORITY_LABEL[task.priority] || task.priority,
    ответственные: assigneesOf(db, task.id).map((u) => u.full_name).join(", ") || "не назначены",
    описание: task.description || "",
    ссылка: taskLink(task.id),
    ...extra,
  };
}

/** Запись в историю задачи. userId = null — действие самой платформы. */
function addEvent(db, taskId, userId, kind, text) {
  const info = db.prepare("INSERT INTO task_events (task_id, user_id, kind, text) VALUES (?, ?, ?, ?)")
    .run(taskId, userId, kind, text);
  return Number(info.lastInsertRowid);
}

module.exports = {
  PRIORITY_LABEL, STATUS_LABEL, localDay, parseDay, daysUntil, isOverdue,
  formatDue, relativeDue, listLink, assigneesOf, taskPayload, addEvent,
};
