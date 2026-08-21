const express = require("express");
const bcrypt = require("bcrypt");
const { authenticate, LdapAuthError } = require("../services/ldapAuth");
const { upsertFromLdap } = require("../services/userStore");
const { detectDomain, normalizeIp } = require("../services/network");
const config = require("../config/config");

module.exports = function authRoutes(db) {
  const router = express.Router();

  // GET /api/auth/detect — по IP клиента подсказывает, в каком он домене,
  // чтобы не показывать вкладки выбора сети на экране логина.
  router.get("/detect", (req, res) => {
    const ip = req.socket.remoteAddress;
    const mode = detectDomain(ip, config);
    res.json({ mode, ip: normalizeIp(ip) });
  });

  // POST /api/auth/login  { mode: 'A' | 'B' | 'local', login, password }
  router.post("/login", async (req, res) => {
    const { mode, login, password } = req.body || {};
    if (!mode || !login || !password) {
      return res.status(400).json({ error: "Заполните домен, логин и пароль" });
    }

    if (mode === "local") {
      return handleLocalLogin(db, req, res, login, password);
    }

    if (mode !== "A" && mode !== "B") {
      return res.status(400).json({ error: "Неизвестный домен" });
    }

    try {
      const ldapUser = await authenticate(mode, login, password, db);
      const user = upsertFromLdap(db, ldapUser);
      setSession(req, user);
      return res.json({ user: publicUser(user) });
    } catch (err) {
      if (err instanceof LdapAuthError) {
        const status = ["DC_UNAVAILABLE", "SEARCH_FAILED"].includes(err.code) ? 503 : 401;
        if (err.cause) console.error(`LDAP ${err.code} для логина "${login}" (домен ${mode}):`, err.cause.message || err.cause);
        return res.status(status).json({ error: err.message, code: err.code });
      }
      console.error(`Необработанная ошибка входа для "${login}" (домен ${mode}):`, err);
      return res.status(500).json({ error: "Внутренняя ошибка аутентификации" });
    }
  });

  router.post("/logout", (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  router.get("/me", (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Не авторизован" });
    res.json({ user: req.session.user });
  });

  return router;
};

async function handleLocalLogin(db, req, res, login, password) {
  const user = db.prepare("SELECT * FROM users WHERE ad_login = ? AND auth_type = 'local'").get(login);
  if (!user || !user.local_password_hash) {
    return res.status(401).json({ error: "Неверный логин или пароль" });
  }
  const ok = await bcrypt.compare(password, user.local_password_hash);
  if (!ok) {
    return res.status(401).json({ error: "Неверный логин или пароль" });
  }
  db.prepare("UPDATE users SET last_domain = 'local', last_login_at = datetime('now') WHERE id = ?").run(user.id);
  setSession(req, user);
  res.json({ user: publicUser(user) });
}

function setSession(req, user) {
  req.session.user = publicUser(user);
}

function publicUser(user) {
  return {
    id: user.id,
    ad_login: user.ad_login,
    full_name: user.full_name,
    department: user.department,
    email: user.email,
    role: user.role,
    auth_type: user.auth_type,
  };
}
