const express = require("express");
const path = require("path");
const session = require("express-session");
const { SqliteSessionStore } = require("./services/sessionStore");
const config = require("./config/config");
const { unpackRoles } = require("./services/userStore");

// ============================================================================
//  Сборка приложения — отдельно от его запуска
//
//  Раньше всё это лежало прямо в server.js, вперемешку с listen(), созданием
//  базы и стартом планировщика. Из-за этого маршруты нельзя было проверить
//  тестом: любой require("./server") поднимал настоящий сервер на боевом порту,
//  открывал боевую базу и запускал обход оповещений. Отсюда и нулевое покрытие
//  всех routes/* — не потому, что тесты «не написали», а потому, что писать их
//  было не на чем.
//
//  Здесь функция только собирает express-приложение из готовой базы и ничего
//  не начинает: ни слушать порт, ни ходить в домен, ни рассылать почту.
// ============================================================================

/**
 * @param db          открытая база (node:sqlite DatabaseSync)
 * @param secureCookie ставить ли у куки флаг Secure. Решается снаружи, потому
 *                     что зависит от наличия TLS-сертификата, а поменять флаг
 *                     после создания middleware уже нельзя.
 */
function createApp(db, { secureCookie = false } = {}) {
  const app = express();

  // Заголовок-версия Express выдаёт стек и версию сервера — снимаем.
  app.disable("x-powered-by");

  app.use(session({
    // Сеансы — в базе (services/sessionStore.js): переживают перезапуск и обновление платформы.
    store: new SqliteSessionStore(db),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true, // продлевает срок действия куки при каждом активном запросе
    name: "helpdesk.sid", // не оставляем узнаваемый connect.sid по умолчанию
    cookie: {
      httpOnly: true,
      // Явно, а не полагаясь на умолчание браузера: куку не отправят при
      // переходе/отправке формы с чужого сайта — это закрывает CSRF на
      // изменяющих запросах и к платформе, и к проксируемым модулям.
      sameSite: "lax",
      maxAge: config.sessionMaxAgeDays * 24 * 60 * 60 * 1000,
      // По HTTPS куку помечаем Secure — браузер не отправит её открытым
      // текстом, если кто-то откроет платформу по http. По HTTP флаг ставить
      // нельзя: браузер тогда не примет куку вовсе и вход перестанет работать.
      secure: secureCookie,
    },
  }));

  // Отделы пользователя — из базы на каждом запросе, а не только снимком при
  // входе: группу исполнителей по списку логинов правят в панели, и вписанный
  // туда человек должен увидеть её очередь сразу, без повторного входа. Запрос
  // один и по первичному ключу. Признак администратора остаётся снимком: он из
  // группы в .env и меняется только входом.
  const userRoles = db.prepare("SELECT role, roles FROM users WHERE id = ?");
  app.use((req, res, next) => {
    const u = req.session && req.session.user;
    const row = u && userRoles.get(u.id);
    if (row) {
      const roles = unpackRoles(row.roles);
      if (roles.join() !== (u.roles || []).join() || row.role !== u.role) { u.roles = roles; u.role = row.role; }
    }
    next();
  });

  // Журнал действий администраторов: до маршрутов, чтобы видеть ответ каждого (services/audit.js).
  app.use(require("./services/audit").middleware(db));

  // Сертификаты — до общего парсера тела: PFX с цепочкой не влезает в его
  // предел, и маршрут читает тело сам (см. routes/certificates.js).
  app.use("/api/certificates", require("./routes/certificates")());

  // Ограничение размера JSON-тела для всего остального: без него любой вошедший
  // мог отправить запрос на сотни мегабайт и занять память процесса.
  // Заметки (Задачи → Заметки) — текст с оформлением, ему 100 КБ мало.
  // Свой разборщик стоит раньше общего; общий уже разобранное тело не трогает.
  app.use("/api/tasks/notes", express.json({ limit: "1mb" }));
  app.use(express.json({ limit: "100kb" }));

  app.use("/api/auth", require("./routes/auth")(db));
  app.use("/api/tickets", require("./routes/tickets")(db));
  app.use("/api/notifications", require("./routes/notifications")(db));
  app.use("/api/tasks", require("./routes/tasks")(db));
  // Ассистент: акты — отдельным файлом, но под тем же префиксом.
  app.use("/api/assistant", require("./routes/assistant")(db));
  app.use("/api/assistant", require("./routes/assistantActs")(db));
  app.use("/api/mailings", require("./routes/mailings")(db));
  app.use("/api/admin", require("./routes/admin")(db));
  app.use("/api/departments", require("./routes/departments")(db));
  app.use(require("./routes/modules")());

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  // Раздаём собранный фронтенд той же самой Express-инстанцией — один процесс,
  // один порт, проще для деплоя через NSSM. Сборки/бандлера нет: чистые
  // HTML/CSS/JS файлы, никаких нативных зависимостей на этапе сборки.
  app.use(express.static(path.join(__dirname, "public")));

  app.use((err, req, res, next) => {
    console.error(err);
    if (err.message === "Недопустимый тип файла") {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  });

  return app;
}

module.exports = { createApp };
