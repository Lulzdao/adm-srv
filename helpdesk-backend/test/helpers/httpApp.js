'use strict';

const http = require("node:http");
const bcrypt = require("bcrypt");
const { packRoles } = require("../../services/userStore");

// ============================================================================
//  Платформа целиком, поднятая в тесте
//
//  Не «вызовем обработчик напрямую», а настоящий HTTP: свой порт, свои куки,
//  свой express-session, свой разбор тела. Разница принципиальная — именно на
//  стыках маршрута, middleware и сессии живут те дефекты, ради которых всё это
//  и заводится: забытая проверка прав, потерянная кука, 500 вместо 400.
//
//  Порт берём нулевой: несколько тестовых файлов идут одновременно, и жёсткий
//  номер рано или поздно столкнётся с занятым.
// ============================================================================

/** Поднять приложение на свободном порту. Возвращает { url, close }. */
async function startApp(db, { secureCookie = false } = {}) {
  const { createApp } = require("../../app");
  const server = http.createServer(createApp(db, { secureCookie }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// Хэш считаем ОДИН раз на весь файл тестов: bcrypt намеренно медленный, и
// десяток учёток по 60 мс каждая — это уже заметная часть времени прогона.
let sharedHash = null;
const TEST_PASSWORD = "пароль-для-теста-1";

/**
 * Локальная учётная запись с заданной ролью.
 *
 * Через неё тест входит по-настоящему: тот же маршрут, тот же bcrypt, та же
 * пересозданная сессия, что и у живого пользователя.
 *
 * role и isAdmin — РАЗНЫЕ вещи: роль говорит, в каком отделе человек
 * исполнитель, isAdmin — администратор ли он платформы. В бою признак
 * выдаётся только группой из .env и из панели недостижим. Подкладывать сессию в
 * обход входа нельзя — тогда тест перестанет замечать поломки самого входа.
 */
async function makeLocalUser(db, { login, name, role = "user", roles = null, email = null, isAdmin = false }) {
  if (!sharedHash) sharedHash = await bcrypt.hash(TEST_PASSWORD, 10);
  // Отделов может быть несколько. Если список не задан явно — выводим его из
  // role, чтобы обычные тесты не приходилось переписывать.
  const список = roles || (role !== "user" ? [role] : []);
  const info = db.prepare(`
    INSERT INTO users (ad_login, full_name, role, roles, is_admin, email, auth_type, local_password_hash)
    VALUES (?, ?, ?, ?, ?, ?, 'local', ?)
  `).run(login, name, список[0] || role, packRoles(список), isAdmin ? 1 : 0, email, sharedHash);
  return Number(info.lastInsertRowid);
}

/**
 * Клиент с собственной банкой кук — как отдельный браузер.
 * Несколько таких в одном тесте изображают разных сотрудников одновременно.
 */
function client(baseUrl) {
  let cookie = "";

  async function request(method, path, body, extra = {}) {
    const headers = { ...(extra.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(baseUrl + path, { method, headers, body: payload, redirect: "manual" });

    // Куку запоминаем целиком до первой точки с запятой: атрибуты (Path,
    // HttpOnly, SameSite) серверу обратно не отправляют.
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const raw of setCookie) {
      const pair = raw.split(";")[0];
      if (pair.startsWith("helpdesk.sid=")) cookie = pair;
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* не JSON — отдадим текстом */ }
    return { status: res.status, json, text, headers: res.headers, setCookie };
  }

  return {
    get: (p, extra) => request("GET", p, undefined, extra),
    post: (p, b, extra) => request("POST", p, b, extra),
    patch: (p, b, extra) => request("PATCH", p, b, extra),
    delete: (p, extra) => request("DELETE", p, undefined, extra),
    /** Войти локальной учёткой. Бросает, если вход не удался. */
    async login(loginName) {
      const r = await request("POST", "/api/auth/login", {
        mode: "local", login: loginName, password: TEST_PASSWORD,
      });
      if (r.status !== 200) throw new Error(`вход "${loginName}" не удался: ${r.status} ${r.text}`);
      return r.json.user;
    },
    get cookie() { return cookie; },
  };
}

module.exports = { startApp, makeLocalUser, client, TEST_PASSWORD };
