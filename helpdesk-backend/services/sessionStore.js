const session = require("express-session");

/**
 * Сеансы входа — в базе платформы, а не в памяти процесса.
 *
 * express-session по умолчанию хранит их в MemoryStore: он теряет всё при
 * перезапуске (любое обновление, перезапуск службы, переход на https из
 * панели выкидывали из системы всех сразу, хотя вход обещан на 30 дней) и сам
 * не чистит устаревшее. Пакета-хранилища на закрытый контур не поставить, а
 * node:sqlite у нас уже есть — хранилище из четырёх методов проще написать.
 *
 * Таблица sessions — в db/schema.sql. Срок берётся из куки сеанса
 * (cookie.expires, продлевается rolling), просроченные удаляются раз в час.
 */
class SqliteSessionStore extends session.Store {
  constructor(db, { cleanupMs = 60 * 60 * 1000 } = {}) {
    super();
    this.getStmt = db.prepare("SELECT sess FROM sessions WHERE sid = ? AND expires > ?");
    this.setStmt = db.prepare(
      "INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) " +
        "ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires"
    );
    this.touchStmt = db.prepare("UPDATE sessions SET expires = ? WHERE sid = ?");
    this.destroyStmt = db.prepare("DELETE FROM sessions WHERE sid = ?");
    this.cleanupStmt = db.prepare("DELETE FROM sessions WHERE expires <= ?");
    this.timer = setInterval(() => this.cleanup(), cleanupMs);
    // Держать процесс ради уборки не нужно: его держит сервер.
    if (this.timer.unref) this.timer.unref();
  }

  static expiresOf(sess) {
    const e = sess && sess.cookie && sess.cookie.expires;
    const t = e ? new Date(e).getTime() : NaN;
    // Без срока в куке (не должно случаться: maxAge задан) — сутки, чтобы не копить вечные строки.
    return Number.isFinite(t) ? t : Date.now() + 24 * 60 * 60 * 1000;
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb) {
    try {
      this.setStmt.run(sid, JSON.stringify(sess), SqliteSessionStore.expiresOf(sess));
      cb && cb(null);
    } catch (err) { cb && cb(err); }
  }

  // rolling: true продлевает куку на каждом запросе — здесь продлеваем и строку, не переписывая её.
  touch(sid, sess, cb) {
    try {
      this.touchStmt.run(SqliteSessionStore.expiresOf(sess), sid);
      cb && cb(null);
    } catch (err) { cb && cb(err); }
  }

  destroy(sid, cb) {
    try {
      this.destroyStmt.run(sid);
      cb && cb(null);
    } catch (err) { cb && cb(err); }
  }

  cleanup() {
    try { return this.cleanupStmt.run(Date.now()).changes; } catch { return 0; }
  }

  close() { clearInterval(this.timer); }
}

module.exports = { SqliteSessionStore };
