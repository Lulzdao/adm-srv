// Какие внутренние заметки могли видеть заявители — до исправления c083ad2 (2026-08-29).
//
// До него карточка заявки отдавала ВСЕ комментарии каждому, кто мог её открыть, в том числе
// заметки «для ИТ» (is_internal = 1) — заявителю. Исправление закрыло это на будущее, но журнала
// просмотров нет, и кто что успел прочитать, узнать нельзя. Можно перечислить, где такое было
// возможно: внутренняя заметка, написанная до установки исправления на сервер, в заявке, которую
// мог открыть человек без права видеть заметки — её автор-заявитель или назначенный на неё
// не-исполнитель. Администраторы и исполнители отдела заявки видят заметки законно — их нет в списке.
//
// Только чтение: база открывается readOnly, ничего не меняется. Запуск на сервере, из
// helpdesk-backend:
//
//   node scripts/check-internal-leak.js 2026-09-01
//
// Дата — день, когда на сервер встала версия с исправлением (не раньше 2026-08-29). Заметки,
// созданные раньше неё, попадают в список. Без даты — 2026-08-29, день самого исправления.
// Права исполнителей берутся НЫНЕШНИЕ (истории прав нет): если человек стал исполнителем позже,
// его заявки из списка выпадут — это стоит иметь в виду.

const path = require("path");
const { DatabaseSync } = require("node:sqlite");

// Кто мог увидеть заметку, не имея на то права. Возвращает список строк отчёта.
function findExposures(db, departments, beforeDate) {
  const roleOf = new Map(departments.map((d) => [d.name, d.role]));
  const rows = db.prepare(`
    SELECT c.id AS comment_id, c.created_at AS note_at, c.text,
           t.id AS ticket_id, t.display_id, t.title, cat.name AS category,
           a.full_name AS note_author,
           r.id AS requester_id, r.full_name AS requester, r.is_admin AS requester_admin, r.roles AS requester_roles,
           s.id AS assignee_id, s.full_name AS assignee, s.is_admin AS assignee_admin, s.roles AS assignee_roles
    FROM comments c
    JOIN tickets t ON t.id = c.ticket_id
    LEFT JOIN categories cat ON cat.id = t.category_id
    LEFT JOIN users a ON a.id = c.user_id
    LEFT JOIN users r ON r.id = t.created_by
    LEFT JOIN users s ON s.id = t.assigned_to
    WHERE c.is_internal = 1 AND c.created_at < ?
    ORDER BY c.created_at
  `).all(beforeDate);

  // Может ли человек законно видеть заметки этой заявки: администратор или исполнитель её отдела.
  const staff = (isAdmin, roles, category) => {
    if (isAdmin) return true;
    const role = roleOf.get(category);
    return Boolean(role && String(roles || "").includes(`,${role},`));
  };

  const out = [];
  for (const r of rows) {
    const readers = [];
    if (r.requester_id && !staff(r.requester_admin, r.requester_roles, r.category)) readers.push(`заявитель ${r.requester}`);
    if (r.assignee_id && r.assignee_id !== r.requester_id && !staff(r.assignee_admin, r.assignee_roles, r.category)) {
      readers.push(`назначенный ${r.assignee}`);
    }
    if (!readers.length) continue;
    out.push({
      ticket: r.display_id, title: r.title, noteAt: r.note_at, noteAuthor: r.note_author,
      readers, excerpt: String(r.text).replace(/\s+/g, " ").slice(0, 80),
    });
  }
  return out;
}

function main() {
  const before = process.argv[2] || "2026-08-29";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) {
    console.error("Дата — в виде ГГГГ-ММ-ДД, например: node scripts/check-internal-leak.js 2026-09-01");
    process.exit(2);
  }
  const config = require("../config/config");
  const departments = require("../config/departments");
  const file = path.resolve(__dirname, "..", config.dbPath);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const found = findExposures(db, departments, before);
    console.log(`База: ${file}`);
    console.log(`Внутренние заметки до ${before}, которые мог видеть человек без права на них: ${found.length}\n`);
    for (const f of found) {
      console.log(`${f.ticket} «${f.title}» — заметка ${f.noteAt} (автор ${f.noteAuthor || "?"})`);
      console.log(`   мог видеть: ${f.readers.join(", ")}`);
      console.log(`   текст: ${f.excerpt}${f.excerpt.length === 80 ? "…" : ""}\n`);
    }
    if (!found.length) console.log("Таких заметок нет.");
  } finally {
    db.close();
  }
}

if (require.main === module) main();

module.exports = { findExposures };
