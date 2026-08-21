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

function upsertFromLdap(db, ldapUser) {
  const login = toBindable(ldapUser.login);
  const fullName = toBindable(ldapUser.fullName);
  const department = toBindable(ldapUser.department);
  const email = toBindable(ldapUser.email);
  const phone = toBindable(ldapUser.phone);
  const role = toBindable(ldapUser.role);
  const domain = toBindable(ldapUser.domain);

  const existing = db.prepare("SELECT * FROM users WHERE ad_login = ?").get(login);

  if (existing) {
    db.prepare(
      `UPDATE users SET full_name = ?, department = ?, email = ?, phone = ?,
       role = ?, last_domain = ?, last_login_at = datetime('now')
       WHERE id = ?`
    ).run(fullName, department, email, phone, role, domain, existing.id);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id);
  }

  const info = db.prepare(
    `INSERT INTO users (ad_login, full_name, department, email, phone, role, auth_type, last_domain, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ad', ?, datetime('now'))`
  ).run(login, fullName, department, email, phone, role, domain);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
}

module.exports = { upsertFromLdap };
