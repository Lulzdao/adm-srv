'use strict';

require("./helpers/isolateEnv");
const test = require("node:test");
const assert = require("node:assert");
const { freshDb, makeUser, makeTicket } = require("./helpers/tempDb");

// ============================================================================
//  Проверка «кто мог видеть внутренние заметки» (scripts/check-internal-leak.js)
//
//  Скрипт запускают один раз на боевой базе, и ошибиться он не должен ни в одну
//  сторону: пропустить заявителя, видевшего заметку, или завалить список
//  исполнителями, которым заметки положены. Имена выдуманы.
// ============================================================================

const departments = require("../config/departments");
const { findExposures } = require("../scripts/check-internal-leak");

function note(db, ticketId, userId, text, at, internal = 1) {
  db.prepare("INSERT INTO comments (ticket_id, user_id, text, is_internal, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(ticketId, userId, text, internal, at);
}

test("заявитель без прав — в списке; исполнитель отдела и администратор — нет", (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const заявитель = makeUser(db, { login: "zayavitel", name: "Заявитель Обычный" });
  const исполнитель = makeUser(db, { login: "ispolnitel", name: "Исполнитель ИТ", role: "it" });
  db.prepare("UPDATE users SET roles = ',it,' WHERE id = ?").run(исполнитель);
  const админ = makeUser(db, { login: "admin", name: "Админ Платформы" });
  db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(админ);
  const хозник = makeUser(db, { login: "hoznik", name: "Исполнитель ХОЗ", role: "hoz" });
  db.prepare("UPDATE users SET roles = ',hoz,' WHERE id = ?").run(хозник);

  const t1 = makeTicket(db, { displayId: "ИТ-0001", title: "Не печатает", createdBy: заявитель });
  note(db, t1, исполнитель, "Картридж списать, заявителю не говорить", "2026-08-20 10:00:00");
  note(db, t1, исполнитель, "Обычный ответ", "2026-08-20 11:00:00", 0);               // не заметка
  note(db, t1, исполнитель, "Заметка после исправления", "2026-09-05 10:00:00");       // позже даты

  const t2 = makeTicket(db, { displayId: "ИТ-0002", title: "Сам себе", createdBy: исполнитель });
  note(db, t2, админ, "Исполнитель ИТ видит законно", "2026-08-20 10:00:00");

  const t3 = makeTicket(db, { displayId: "ИТ-0003", title: "От админа", createdBy: админ });
  note(db, t3, исполнитель, "Админ видит законно", "2026-08-20 10:00:00");

  // Исполнитель ХОЗ, подавший заявку в ИТ, — для ИТ он обычный заявитель.
  const t4 = makeTicket(db, { displayId: "ИТ-0004", title: "Чужой отдел", createdBy: хозник });
  note(db, t4, исполнитель, "Хозник это видеть не должен", "2026-08-21 10:00:00");

  const found = findExposures(db, departments, "2026-09-01");
  assert.deepStrictEqual(found.map((f) => f.ticket), ["ИТ-0001", "ИТ-0004"]);
  assert.deepStrictEqual(found[0].readers, ["заявитель Заявитель Обычный"]);
  assert.match(found[0].excerpt, /Картридж списать/);
});

test("назначенный не-исполнитель тоже в списке; дата отсекает позднее", (t) => {
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const заявитель = makeUser(db, { login: "z2", name: "Заявитель Второй" });
  const исполнитель = makeUser(db, { login: "i2", name: "Исполнитель Второй", role: "it" });
  db.prepare("UPDATE users SET roles = ',it,' WHERE id = ?").run(исполнитель);
  const стажёр = makeUser(db, { login: "s2", name: "Стажёр Назначенный" });
  const t1 = makeTicket(db, { displayId: "ИТ-0010", title: "С назначенным", createdBy: заявитель });
  db.prepare("UPDATE tickets SET assigned_to = ? WHERE id = ?").run(стажёр, t1);
  note(db, t1, исполнитель, "Видели оба", "2026-08-25 09:00:00");

  const found = findExposures(db, departments, "2026-09-01");
  assert.deepStrictEqual(found[0].readers, ["заявитель Заявитель Второй", "назначенный Стажёр Назначенный"]);
  assert.strictEqual(findExposures(db, departments, "2026-08-25").length, 0, "заметка в день даты и позже — не в списке");
});
