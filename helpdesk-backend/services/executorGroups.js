const departments = require("../config/departments");
const { getSetting, setSetting } = require("./settings");
const { packRoles, unpackRoles } = require("./userStore");

// ============================================================================
//  Группы исполнителей: состав по логинам и скрытие из «Новой заявки»
//
//  Исполнителем отдела человека делает группа в домене (настройка
//  <role>_group_A/B) — или, теперь, его логин в списке группы (<role>_logins).
//  Второе нужно для маленьких групп вроде «АДМ» из одной-двух учёток, ради
//  которых заводить группу в домене незачем. Действует для любого отдела,
//  встроенного и заведённого из панели.
//
//  Отдел, выданный списком, помечается у пользователя в login_roles: при правке
//  списка снимается ровно он, а отдел, который даёт группа в домене, остаётся.
//  Пересчёт идёт сразу при сохранении, без повторного входа: права читаются из
//  базы на каждом запросе (app.js), оповещения — тоже по базе.
// ============================================================================

class GroupError extends Error {}

/**
 * Список логинов из текста: по одному на строку, через запятую, точку с запятой
 * или пробел. «ДОМЕН\логин» и «логин@домен» сводятся к логину — логины в
 * доменах зеркальные. Регистр не важен, как и в домене.
 */
function parseLogins(text) {
  const out = [];
  for (let raw of String(text || "").split(/[\s,;]+/)) {
    raw = raw.trim();
    if (raw.includes("\\")) raw = raw.slice(raw.lastIndexOf("\\") + 1);
    if (raw.includes("@")) raw = raw.slice(0, raw.indexOf("@"));
    const login = raw.toLowerCase();
    if (login && !out.includes(login)) out.push(login);
  }
  return out;
}

const loginsOf = (db, role) => parseLogins(getSetting(db, `${role}_logins`));
const isHidden = (db, role) => getSetting(db, `${role}_hidden`) === "1";

/** Отделы, в которые логин вписан списком. */
function rolesByLogin(db, login) {
  const l = String(login || "").toLowerCase();
  if (!l) return [];
  return departments.filter((d) => loginsOf(db, d.role).includes(l)).map((d) => d.role);
}

/** Отделы по порядку справочника: первый — «основной» (users.role). */
function ordered(roles) {
  const set = new Set(roles);
  const known = departments.map((d) => d.role).filter((r) => set.has(r));
  // Отдел, которого в справочнике уже нет, не выбрасываем молча — это решает не пересчёт.
  return [...known, ...[...set].filter((r) => !known.includes(r))];
}

/**
 * Свести отделы пользователя: base — то, что дал домен (или .env у локальной
 * учётки), плюс выданное списками логинов. Возвращает поля для users.
 */
function combine(db, login, base) {
  const byLogin = rolesByLogin(db, login);
  const roles = ordered([...base, ...byLogin]);
  return {
    roles: packRoles(roles),
    login_roles: packRoles(byLogin.filter((r) => !base.includes(r))),
    role: roles.find((r) => departments.some((d) => d.role === r)) || "user",
  };
}

/** Пересчитать одного пользователя по уже записанным roles/login_roles. */
function recomputeUser(db, user) {
  const own = unpackRoles(user.login_roles);
  // Строка без списка отделов, но с ролью — из ранних версий: отдел в role.
  const legacy = !user.roles && user.role && user.role !== "user" ? [user.role] : [];
  const base = [...legacy, ...unpackRoles(user.roles).filter((r) => !own.includes(r))];
  const next = combine(db, user.ad_login, base);
  // Сравниваем как множества: порядок в строке ничего не значит, а лишняя
  // запись переставила бы «основной» отдел тем, кого правка не касалась.
  const sameSet = (a, b) => unpackRoles(a).sort().join() === unpackRoles(b).sort().join();
  if (sameSet(next.roles, packRoles([...legacy, ...unpackRoles(user.roles)])) && sameSet(next.login_roles, user.login_roles)) return false;
  db.prepare("UPDATE users SET roles = ?, login_roles = ?, role = ? WHERE id = ?").run(next.roles, next.login_roles, next.role, user.id);
  return true;
}

/** Пересчитать всех — после правки списков и при запуске. */
function recomputeAll(db) {
  let changed = 0;
  for (const u of db.prepare("SELECT id, ad_login, role, roles, login_roles FROM users").all()) {
    if (recomputeUser(db, u)) changed++;
  }
  return changed;
}

/** Адреса тех, кто вписан в группу логином, — им уходит письмо о новой заявке. */
function memberEmails(db, role) {
  const logins = loginsOf(db, role);
  if (!logins.length) return [];
  return db.prepare(
    `SELECT email FROM users WHERE lower(ad_login) IN (${logins.map(() => "?").join(",")}) AND email IS NOT NULL AND email != ''`
  ).all(...logins).map((r) => r.email);
}

// ---- Справочник для панели --------------------------------------------------

function list(db) {
  const count = db.prepare(`
    SELECT COUNT(t.id) AS n FROM categories c LEFT JOIN tickets t ON t.category_id = c.id WHERE c.name = ?
  `);
  const known = db.prepare("SELECT full_name FROM users WHERE ad_login = ? COLLATE NOCASE");
  return departments.map((d) => ({
    role: d.role, name: d.name, prefix: d.prefix, hint: d.hint || "", custom: Boolean(d.custom),
    groupA: getSetting(db, `${d.role}_group_A`) || "",
    groupB: getSetting(db, `${d.role}_group_B`) || "",
    // Логин и ФИО, если человек уже входил: так видно опечатку в логине.
    logins: loginsOf(db, d.role).map((login) => ({ login, name: (known.get(login) || {}).full_name || null })),
    hidden: isHidden(db, d.role),
    tickets: count.get(d.name).n,
  }));
}

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .-]{0,29}$/u;
const PREFIX_RE = /^[A-Za-zА-Яа-яЁё0-9]{1,10}$/;
const LOGINS_MAX = 200;

function checkLogins(text) {
  if (typeof text !== "string" || text.length > 5000) throw new GroupError("Логины — текстом, до 5000 знаков");
  const logins = parseLogins(text);
  if (logins.length > LOGINS_MAX) throw new GroupError(`Не больше ${LOGINS_MAX} логинов в группе`);
  if (logins.some((l) => l.length > 64 || !/^[\p{L}\p{N}._$-]+$/u.test(l))) throw new GroupError("В списке логинов есть недопустимый — пишите логины домена, по одному на строку");
  return logins;
}

/** Состав и видимость — у любого отдела. */
function update(db, role, { logins, hidden, hint } = {}) {
  const dept = departments.byRole(role);
  if (!dept) throw new GroupError("Такой группы исполнителей нет");
  if (logins !== undefined) setSetting(db, `${role}_logins`, checkLogins(logins).join("\n"));
  if (hidden !== undefined) setSetting(db, `${role}_hidden`, hidden ? "1" : "");
  if (hint !== undefined && dept.custom) {
    if (typeof hint !== "string" || hint.length > 120) throw new GroupError("Подпись плитки — до 120 знаков");
    db.prepare("UPDATE executor_groups SET hint = ? WHERE role = ?").run(hint.trim(), role);
    departments.sync(db);
  }
  recomputeAll(db);
}

/** Новая группа из панели. Возвращает её role. */
function create(db, { name, prefix, hint = "", logins = "", hidden = false } = {}) {
  name = typeof name === "string" ? name.trim() : "";
  prefix = typeof prefix === "string" ? prefix.trim().toUpperCase() : "";
  if (!NAME_RE.test(name)) throw new GroupError("Название — от 1 до 30 знаков: буквы, цифры, пробел, точка, дефис");
  if (!PREFIX_RE.test(prefix)) throw new GroupError("Префикс номера — от 1 до 10 букв или цифр, без пробелов и дефиса");
  if (typeof hint !== "string" || hint.length > 120) throw new GroupError("Подпись плитки — до 120 знаков");
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  if (departments.some((d) => same(d.name, name))) throw new GroupError(`Группа «${name}» уже есть`);
  if (departments.some((d) => same(d.prefix, prefix))) throw new GroupError(`Префикс ${prefix} уже занят группой «${departments.find((d) => same(d.prefix, prefix)).name}»`);
  // Заявки с таким префиксом могли остаться от удалённой группы — нумерация бы с ними смешалась.
  if (db.prepare("SELECT 1 FROM tickets WHERE display_id LIKE ? LIMIT 1").get(`${prefix}-%`)) {
    throw new GroupError(`Заявки с префиксом ${prefix} уже есть — выберите другой`);
  }
  const list = checkLogins(logins);
  const info = db.prepare("INSERT INTO executor_groups (role, name, prefix, hint) VALUES ('', ?, ?, ?)").run(name, prefix, hint.trim());
  const role = `grp${info.lastInsertRowid}`;
  db.prepare("UPDATE executor_groups SET role = ? WHERE id = ?").run(role, info.lastInsertRowid);
  db.prepare("INSERT OR IGNORE INTO categories (name) VALUES (?)").run(name);
  setSetting(db, `${role}_logins`, list.join("\n"));
  setSetting(db, `${role}_hidden`, hidden ? "1" : "");
  departments.sync(db);
  recomputeAll(db);
  return role;
}

/** Удалить группу из панели — только пока в ней нет ни одной заявки. */
function remove(db, role) {
  const dept = departments.byRole(role);
  if (!dept) throw new GroupError("Такой группы исполнителей нет");
  if (!dept.custom) throw new GroupError("Встроенный отдел из панели не удаляется");
  const cat = db.prepare("SELECT id FROM categories WHERE name = ?").get(dept.name);
  if (cat && db.prepare("SELECT 1 FROM tickets WHERE category_id = ? LIMIT 1").get(cat.id)) {
    throw new GroupError("В группе есть заявки — удалить её нельзя. Скройте её из «Новой заявки», если она больше не нужна");
  }
  // Сначала убрать список: пересчёт снимет выданный им отдел.
  setSetting(db, `${role}_logins`, "");
  recomputeAll(db);
  db.prepare("DELETE FROM executor_groups WHERE role = ?").run(role);
  if (cat) db.prepare("DELETE FROM categories WHERE id = ?").run(cat.id);
  db.prepare("DELETE FROM settings WHERE key IN (?, ?, ?, ?)").run(`${role}_logins`, `${role}_hidden`, `${role}_group_A`, `${role}_group_B`);
  db.prepare("DELETE FROM notification_settings WHERE kind = ?").run(`ticket_new:${role}`);
  // Программы, что выполняла группа, возвращаются в общую очередь заявок на доступ.
  let map = {};
  try { map = JSON.parse(getSetting(db, "asst_program_executors") || "{}") || {}; } catch { /* битая настройка — начнём с пустой */ }
  for (const [prog, r] of Object.entries(map)) if (r === role) delete map[prog];
  setSetting(db, "asst_program_executors", JSON.stringify(map));
  departments.sync(db);
  // Отдел мог остаться у кого-то из домена или из старой сессии — снимаем.
  for (const u of db.prepare("SELECT id, roles, login_roles FROM users WHERE roles LIKE ?").all(`%,${role},%`)) {
    const roles = unpackRoles(u.roles).filter((r) => r !== role);
    const own = unpackRoles(u.login_roles).filter((r) => r !== role);
    db.prepare("UPDATE users SET roles = ?, login_roles = ?, role = ? WHERE id = ?").run(packRoles(roles), packRoles(own), ordered(roles)[0] || "user", u.id);
  }
}

module.exports = {
  GroupError, parseLogins, loginsOf, isHidden, rolesByLogin, combine, recomputeAll, memberEmails,
  list, update, create, remove,
};
