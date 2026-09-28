'use strict';

// ---------- Rate-limiting против перебора паролей ----------
// Два независимых счётчика, оба — простые in-memory Map с ленивым протуханием (для 20-200 человек
// в локальной сети выделенный npm-пакет вроде express-rate-limit избыточен):
//  1) ipRateLimit — поток запросов с одного IP на /api/login и на /api/register (защита от
//     заливки запросами вообще, не только подбора пароля к конкретному логину). Счётчик у каждого
//     маршрута СВОЙ: раньше Map была одна на оба, а пределы разные (30 входов и 10 регистраций) —
//     и после десяти обычных утренних входов из кабинета за одним NAT регистрация с этого адреса
//     закрывалась на час;
//  2) loginFails — счётчик подряд неверных паролей для КОНКРЕТНОГО логина: после нескольких
//     промахов аккаунт временно блокируется, независимо от того, с какого IP или через сколько
//     разных IP идёт перебор.

function createRateLimits({ logServer }) {
  const ipLimiters = []; // по Map на каждый ограничитель: ip -> { count, resetAt }
  function ipRateLimit({ windowMs, max }) {
    const ipAttempts = new Map();
    ipLimiters.push(ipAttempts);
    return (req, res, next) => {
      const now = Date.now();
      let entry = ipAttempts.get(req.ip);
      if (!entry || entry.resetAt < now) {
        entry = { count: 0, resetAt: now + windowMs };
        ipAttempts.set(req.ip, entry);
      }
      entry.count += 1;
      if (entry.count > max) {
        logServer('WARN', 'rate_limited', { ip: req.ip, path: req.path });
        return res.status(429).json({ error: 'Слишком много попыток с этого адреса, попробуйте позже' });
      }
      next();
    };
  }

  const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
  const LOGIN_MAX_FAILS = 5;
  const LOGIN_LOCK_MS = 5 * 60 * 1000;
  const loginFails = new Map(); // username (lower) -> { count, windowStart, lockedUntil }
  function checkLoginLock(username) {
    const entry = loginFails.get(String(username || '').toLowerCase());
    if (entry && entry.lockedUntil > Date.now()) return Math.ceil((entry.lockedUntil - Date.now()) / 1000);
    return 0;
  }
  function registerLoginFail(username) {
    const key = String(username || '').toLowerCase();
    const now = Date.now();
    let entry = loginFails.get(key);
    if (!entry || now - entry.windowStart > LOGIN_FAIL_WINDOW_MS) entry = { count: 0, windowStart: now, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= LOGIN_MAX_FAILS) entry.lockedUntil = now + LOGIN_LOCK_MS;
    loginFails.set(key, entry);
  }
  function clearLoginFails(username) {
    loginFails.delete(String(username || '').toLowerCase());
  }
  // Периодическая уборка протухших записей, чтобы счётчики не росли бесконечно.
  setInterval(() => {
    const now = Date.now();
    for (const ipAttempts of ipLimiters) {
      for (const [k, v] of ipAttempts) if (v.resetAt < now) ipAttempts.delete(k);
    }
    for (const [k, v] of loginFails) {
      const stale = v.lockedUntil ? v.lockedUntil < now : now - v.windowStart > LOGIN_FAIL_WINDOW_MS;
      if (stale) loginFails.delete(k);
    }
  }, 10 * 60 * 1000).unref();

  return { ipRateLimit, checkLoginLock, registerLoginFail, clearLoginFails };
}

module.exports = { createRateLimits };
