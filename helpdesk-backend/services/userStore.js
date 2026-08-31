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
  const role = toBindable(ldapUser.role);
  const domain = toBindable(ldapUser.domain);
  // Признак администратора пересчитывается при КАЖДОМ входе: вышел человек из
  // группы в домене — на следующем входе признак снимется сам.
  const isAdmin = ldapUser.isAdmin ? 1 : 0;
  // Отделов может быть несколько; role хранит первый по порядку — для подписи
  // и для тех мест, где нужен «основной» отдел.
  const roles = packRoles(ldapUser.roles);

  const existing = db.prepare("SELECT * FROM users WHERE ad_login = ?").get(login);

  // Локальные аварийные учётки доменным входом не трогаем: иначе доменный
  // аккаунт с совпавшим логином перезаписал бы им роль и ФИО и въехал бы в
  // ту же строку пользователя (а вместе с ней — в её заявки и права).
  if (existing && existing.auth_type === "local") {
    throw new Error(`Логин "${login}" занят локальной аварийной учётной записью`);
  }

  if (existing) {
    db.prepare(
      `UPDATE users SET full_name = ?, department = ?, email = ?, phone = ?,
       role = ?, roles = ?, is_admin = ?, last_domain = ?, last_login_at = datetime('now')
       WHERE id = ?`
    ).run(fullName, department, email, phone, role, roles, isAdmin, domain, existing.id);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id);
  }

  const info = db.prepare(
    `INSERT INTO users (ad_login, full_name, department, email, phone, role, roles, is_admin, auth_type, last_domain, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ad', ?, datetime('now'))`
  ).run(login, fullName, department, email, phone, role, roles, isAdmin, domain);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
}

module.exports = { upsertFromLdap, packRoles, unpackRoles, roleLike };
