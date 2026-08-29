const express = require("express");
const bcrypt = require("bcrypt");
const { authenticate, LdapAuthError } = require("../services/ldapAuth");
const { upsertFromLdap } = require("../services/userStore");
const { detectDomain, normalizeIp } = require("../services/network");
const { resolveTlsOptions } = require("../services/tls");
const config = require("../config/config");

// Простое ограничение частоты попыток входа, в памяти процесса. Внешний
// пакет не берём осознанно: сеть закрытая, ставить нечего, а нагрузка —
// десятки человек. Ключ — пара "IP + логин", чтобы подбор пароля к одной
// учётке не блокировал вход всему кабинету через общий NAT.
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map();

function attemptKey(req, login) {
  return `${normalizeIp(req.socket.remoteAddress) || "?"}|${String(login).toLowerCase()}`;
}

// Попытку засчитываем СРАЗУ, до проверки пароля, и тут же отвечаем, можно ли
// её делать. Прежний порядок — сначала посмотреть счётчик, потом, уже после
// await (bcrypt или поход в домен), увеличить — против подбора не защищал
// вовсе: между этими двумя моментами через ещё не изменившийся счётчик
// успевала пройти целая пачка одновременных запросов, и десять разрешённых
// попыток превращались в шестьдесят. Проверка и увеличение обязаны быть одним
// синхронным действием — тогда очередь событий не может вклиниться между ними.
function claimAttempt(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, first: now });
    return true;
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) return false;
  entry.count += 1;
  return true;
}

// Недоступность контроллера домена и наши собственные сбои попыткой подбора не
// являются — возвращаем счётчик назад. Иначе получасовое отсутствие домена
// заблокировало бы вход всем, кто в это время пытался войти, и лечить это
// пришлось бы перезапуском службы.
function refundAttempt(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return;
  entry.count -= 1;
  if (entry.count <= 0) loginAttempts.delete(key);
}

// Подчищаем накопленные ключи, чтобы карта не росла бесконечно на длинном
// аптайме (сервис живёт неделями между перезапусками).
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (now - entry.first > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  }
}, LOGIN_WINDOW_MS).unref();

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
    // Тип проверяем явно: раньше объект вместо логина уходил в LDAP-фильтр
    // и в SQL-параметр как есть.
    if (typeof mode !== "string" || typeof login !== "string" || typeof password !== "string"
        || !mode || !login || !password) {
      return res.status(400).json({ error: "Заполните домен, логин и пароль" });
    }
    if (login.length > 256 || password.length > 512) {
      return res.status(400).json({ error: "Слишком длинный логин или пароль" });
    }

    // Неизвестный домен отсекаем ДО счётчика: это ошибка обращения к API, а не
    // попытка подобрать пароль, и засчитывать её незачем.
    if (mode !== "A" && mode !== "B" && mode !== "local") {
      return res.status(400).json({ error: "Неизвестный домен" });
    }

    const key = attemptKey(req, login);
    if (!claimAttempt(key)) {
      return res.status(429).json({ error: "Слишком много попыток входа. Попробуйте через несколько минут." });
    }

    if (mode === "local") {
      return handleLocalLogin(db, req, res, login, password, key);
    }

    try {
      const ldapUser = await authenticate(mode, login, password, db);
      const user = upsertFromLdap(db, ldapUser);
      loginAttempts.delete(key);
      return regenerateSession(req, user, res);
    } catch (err) {
      if (err instanceof LdapAuthError) {
        const status = ["DC_UNAVAILABLE", "SEARCH_FAILED"].includes(err.code) ? 503 : 401;
        // Недоступность контроллера — не повод засчитывать попытку подбора.
        if (status !== 401) refundAttempt(key);
        if (err.cause) console.error(`LDAP ${err.code} для логина "${login}" (домен ${mode}):`, err.cause.message || err.cause);
        return res.status(status).json({ error: err.message, code: err.code });
      }
      refundAttempt(key); // наш собственный сбой не должен приближать блокировку
      console.error(`Необработанная ошибка входа для "${login}" (домен ${mode}):`, err);
      return res.status(500).json({ error: "Внутренняя ошибка аутентификации" });
    }
  });

  router.post("/logout", (req, res) => {
    req.session.destroy(() => {
      // Сессию из хранилища удалили — убираем и саму куку, чтобы в браузере
      // не оставался её идентификатор.
      // Флаги должны совпадать с теми, с которыми куку выдавали (см. server.js),
      // иначе браузер не сочтёт это той же кукой и не удалит её.
      res.clearCookie("helpdesk.sid", {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: Boolean(resolveTlsOptions()),
      });
      res.json({ ok: true });
    });
  });

  router.get("/me", (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Не авторизован" });
    res.json({ user: req.session.user });
  });

  return router;
};

async function handleLocalLogin(db, req, res, login, password, attemptsKey) {
  const user = db.prepare("SELECT * FROM users WHERE ad_login = ? AND auth_type = 'local'").get(login);
  if (!user || !user.local_password_hash) {
    return res.status(401).json({ error: "Неверный логин или пароль" });
  }
  const ok = await bcrypt.compare(password, user.local_password_hash);
  if (!ok) {
    return res.status(401).json({ error: "Неверный логин или пароль" });
  }
  db.prepare("UPDATE users SET last_domain = 'local', last_login_at = datetime('now') WHERE id = ?").run(user.id);
  loginAttempts.delete(attemptsKey);
  return regenerateSession(req, user, res);
}

// Идентификатор сессии выдаём новый сразу после успешного входа: если
// пользователю заранее подсунули известный злоумышленнику id сессии, после
// входа этот id перестаёт что-либо значить (защита от session fixation).
function regenerateSession(req, user, res) {
  req.session.regenerate((err) => {
    if (err) {
      console.error("Не удалось пересоздать сессию при входе:", err);
      return res.status(500).json({ error: "Внутренняя ошибка аутентификации" });
    }
    req.session.user = publicUser(user);
    res.json({ user: publicUser(user) });
  });
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
