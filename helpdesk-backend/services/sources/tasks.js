const { emit, settingsFor } = require("../notifications");
const T = require("../tasks");

// ============================================================================
//  Ежедневный обход задач: сроки, просрочки, утренняя сводка
//
//  Всё держится на dedup_key событий, как у сроков сертификатов: обход можно
//  запускать сколько угодно раз в день, напоминание по одному порогу одной
//  задачи уходит ровно один раз. В ключ входит сам срок — сдвинули его, и
//  пороги отсчитываются заново, а не молчат, потому что «уже напоминали».
// ============================================================================

const DEFAULT_THRESHOLDS = [3, 1, 0];
// Сколько дней вперёд показывать в утренней сводке, кроме сегодняшних.
const DIGEST_AHEAD_DAYS = 3;

function thresholds(db) {
  const s = settingsFor(db, "task_due");
  const nums = String((s && s.thresholds) || "").split(/[\s,]+/).filter(Boolean).map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0);
  return nums.length ? nums : DEFAULT_THRESHOLDS;
}

function openTasks(db) {
  return db.prepare("SELECT * FROM tasks WHERE status != 'done' AND due_date IS NOT NULL ORDER BY due_date, due_time").all();
}

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};

function run(db, now = new Date()) {
  const today = T.localDay(now);
  const limits = new Set(thresholds(db));
  const tasks = openTasks(db);
  let due = 0, overdue = 0, digests = 0;

  for (const t of tasks) {
    const days = T.daysUntil(t.due_date, now);
    if (days === null) continue;
    const people = T.assigneesOf(db, t.id).map((u) => u.id);

    if (days >= 0 && limits.has(days) && people.length) {
      const id = emit(db, {
        kind: "task_due",
        subject: t.title,
        subjectRef: String(t.id),
        dedupKey: `task_due:${t.id}:${t.due_date}:${days}`,
        payload: T.taskPayload(db, t, { осталось: T.relativeDue(days) }),
        userIds: people,
      });
      if (id) {
        due++;
        T.addEvent(db, t.id, null, "reminder", `напомнила ответственным: срок ${T.relativeDue(days)}`);
      }
    }

    if (days < 0) {
      // Ответственным и автору: автор ставил задачу и должен знать, что она
      // встала. Одно событие в день — ключ с сегодняшней датой.
      const targets = [...new Set([...people, t.created_by])];
      const late = -days;
      const id = emit(db, {
        kind: "task_overdue",
        subject: t.title,
        subjectRef: String(t.id),
        dedupKey: `task_overdue:${t.id}:${today}`,
        payload: T.taskPayload(db, t, { просрочено: `${late} ${plural(late, "день", "дня", "дней")}` }),
        userIds: targets,
      });
      if (id) {
        overdue++;
        // В историю — только первый день: ежедневная строка «всё ещё
        // просрочено» утопила бы в ней всё остальное.
        if (late === 1) T.addEvent(db, t.id, null, "reminder", "срок прошёл — напомнила ответственным и автору");
      }
    }
  }

  // Утренняя сводка — только по будням: в субботу администратору незачем
  // получать список рабочих задач.
  const weekday = now.getDay();
  if (weekday >= 1 && weekday <= 5) {
    const people = db.prepare(`
      SELECT DISTINCT u.id, u.full_name FROM task_assignees a
      JOIN tasks t ON t.id = a.task_id JOIN users u ON u.id = a.user_id
      WHERE t.status != 'done' AND u.is_admin = 1
    `).all();
    for (const p of people) {
      const mine = db.prepare(`
        SELECT t.* FROM tasks t JOIN task_assignees a ON a.task_id = t.id
        WHERE a.user_id = ? AND t.status != 'done' AND t.due_date IS NOT NULL
        ORDER BY t.due_date, t.due_time
      `).all(p.id).map((t) => ({ ...t, days: T.daysUntil(t.due_date, now) }));
      const late = mine.filter((t) => t.days < 0);
      const todayList = mine.filter((t) => t.days === 0);
      const soon = mine.filter((t) => t.days > 0 && t.days <= DIGEST_AHEAD_DAYS);
      if (!late.length && !todayList.length && !soon.length) continue;

      const line = (t) => `  • ${t.title} — ${T.formatDue(t)}`;
      const blocks = [];
      if (late.length) blocks.push(`Срок прошёл:\n${late.map(line).join("\n")}`);
      if (todayList.length) blocks.push(`Сегодня:\n${todayList.map(line).join("\n")}`);
      if (soon.length) blocks.push(`Скоро:\n${soon.map(line).join("\n")}`);
      blocks.push(T.listLink());

      const id = emit(db, {
        kind: "task_digest",
        subject: `Сводка для ${p.full_name}`,
        subjectRef: `digest:${p.id}`,
        dedupKey: `task_digest:${p.id}:${today}`,
        payload: {
          кому: p.full_name.split(" ").slice(1).join(" ") || p.full_name,
          дата: T.formatDue({ due_date: today }).replace(/,.*$/, ""),
          сводка: blocks.join("\n\n"),
          просрочено_шт: String(late.length),
          сегодня_шт: String(todayList.length),
        },
        userIds: [p.id],
      });
      if (id) digests++;
    }
  }

  return { напоминаний: due, просрочек: overdue, сводок: digests };
}

module.exports = { run, DEFAULT_THRESHOLDS };
