// Второй рубеж защиты: даже если откуда-то ещё (не только LDAP) прилетит
// неожиданный тип — массив, объект, undefined — не даём ему улететь в
// SQLite-параметр и уронить весь вход. node:sqlite принимает только
// null/строку/число/bigint/Buffer.
function toBindable(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v;
  if (Array.isArray(v)) return v.length ? String(v[0]) : null;
  return String(v);
}

// Список отделов хранится строкой ",it,hoz," — с запятыми по краям. Так точное
// совпадение ищется простым LIKE '%,it,%': без обрамляющих запятых поиск "it"
// нашёлся бы внутри "audit" и подобных.
function packRoles(roles) {
  const clean = [...new Set((roles || []).filter(Boolean))];
  return clean.length ? `,${clean.join(",")},` : "";
}

function unpackRoles(packed) {
  return String(packed || "").split(",").filter(Boolean);
}

// Группы AD хранятся так же, как отделы: ",имя1,имя2," — но строчными, потому
// что AD имена групп не различает по регистру. Запятая внутри имени группы
// встречается, поэтому она заменяется на точку с запятой и при записи, и при
// проверке — совпадение от этого не страдает.
const normGroup = (g) => String(g || "").trim().toLowerCase().replace(/,/g, ";");
function packGroups(groups) {
  const clean = [...new Set((groups || []).map(normGroup).filter(Boolean))];
  return clean.length ? `,${clean.join(",")},` : "";
}

/** Состоит ли пользователь в группе AD (по списку, сохранённому при последнем входе). */
function userInGroup(db, userId, group) {
  const g = normGroup(group);
  if (!g) return false;
  const row = db.prepare("SELECT ad_groups FROM users WHERE id = ?").get(userId);
  return Boolean(row && row.ad_groups.includes(`,${g},`));
}

const GROUPS_TIMEOUT_MS = 10000;

/**
 * Уточнить группы доменного сотрудника в AD и записать их вместо запомненных
 * при входе (см. lookupGroups в ldapAuth.js). Локальные учётки групп не имеют —
 * у них ничего не меняется. Домен не ответил — остаются запомненные: рассылка
 * не должна вставать из-за недоступного контроллера.
 * Возвращает "live" (группы из домена) или "stored" (запомненные).
 */
async function refreshAdGroups(db, userId) {
  const u = db.prepare("SELECT ad_login, auth_type, last_domain FROM users WHERE id = ?").get(userId);
  if (!u || u.auth_type !== "ad" || !u.last_domain) return "stored";
  let timer;
  try {
    const { lookupGroups } = require("./ldapAuth");
    const r = await Promise.race([
      lookupGroups(u.last_domain, u.ad_login),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("домен не ответил вовремя")), GROUPS_TIMEOUT_MS); }),
    ]);
    db.prepare("UPDATE users SET ad_groups = ? WHERE id = ?").run(packGroups(r.groups), userId);
    return "live";
  } catch (err) {
    console.warn(`[группы] ${u.ad_login}: не удалось уточнить в домене (${err.message}) — берутся запомненные при входе`);
    return "stored";
  } finally {
    clearTimeout(timer);
  }
}

/** Условие SQL «пользователь состоит в этом отделе». Возвращает шаблон для LIKE. */
function roleLike(role) {
  return `%,${role},%`;
}

function upsertFromLdap(db, ldapUser) {
  const login = toBindable(ldapUser.login);
  const fullName = toBindable(ldapUser.fullName);
  const department = toBindable(ldapUser.department);
  const email = toBindable(ldapUser.email);
  const phone = toBindable(ldapUser.phone);
  const domain = toBindable(ldapUser.domain);
  // Признак администратора пересчитывается при КАЖДОМ входе: вышел человек из
  // группы в домене — на следующем входе признак снимется сам.
  const isAdmin = ldapUser.isAdmin ? 1 : 0;
  // Отделов может быть несколько; role хранит первый по порядку — для подписи
  // и для тех мест, где нужен «основной» отдел.
  // К отделам из групп домена — те, куда логин вписан списком (Администрирование
  // → Группы исполнителей); require здесь, а не наверху: тот модуль сам берёт
  // отсюда packRoles.
  const { roles, login_roles: loginRoles, role } = require("./executorGroups").combine(db, login, (ldapUser.roles || []).filter(Boolean));
  const groups = packGroups(ldapUser.groups);

  // Без учёта регистра: домен его не различает, и раньше вход как «Ivanov» и
  // как «ivanov» заводил двух разных пользователей.
  const existing = db.prepare("SELECT * FROM users WHERE ad_login = ? COLLATE NOCASE ORDER BY id LIMIT 1").get(login);

  // Локальные аварийные учётки доменным входом не трогаем: иначе доменный
  // аккаунт с совпавшим логином перезаписал бы им роль и ФИО и въехал бы в
  // ту же строку пользователя (а вместе с ней — в её заявки и права).
  if (existing && existing.auth_type === "local") {
    throw new Error(`Логин "${login}" занят локальной аварийной учётной записью`);
  }

  if (existing) {
    db.prepare(
      `UPDATE users SET ad_login = ?, full_name = ?, department = ?, email = ?, phone = ?,
       role = ?, roles = ?, login_roles = ?, is_admin = ?, ad_groups = ?, last_domain = ?, last_login_at = datetime('now')
       WHERE id = ?`
    ).run(login, fullName, department, email, phone, role, roles, loginRoles, isAdmin, groups, domain, existing.id);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id);
  }

  const info = db.prepare(
    `INSERT INTO users (ad_login, full_name, department, email, phone, role, roles, login_roles, is_admin, ad_groups, auth_type, last_domain, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ad', ?, datetime('now'))`
  ).run(login, fullName, department, email, phone, role, roles, loginRoles, isAdmin, groups, domain);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
}

module.exports = { upsertFromLdap, packRoles, unpackRoles, roleLike, packGroups, userInGroup, refreshAdGroups };
