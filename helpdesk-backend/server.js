const express = require("express");
const path = require("path");
const session = require("express-session");
const config = require("./config/config");
const { initDb, ensureLocalAccounts } = require("./db/init");

const db = initDb();
ensureLocalAccounts(db);

const app = express();

// Заголовок-версия Express выдаёт стек и версию сервера — снимаем.
app.disable("x-powered-by");

// Ограничение размера JSON-тела: без него любой вошедший мог отправить
// запрос на сотни мегабайт и занять память процесса.
app.use(express.json({ limit: "100kb" }));

if (!process.env.SESSION_SECRET) {
  console.warn(
    "[внимание] SESSION_SECRET не задан в .env — используется значение по умолчанию. " +
      "Сессии можно подделать: задайте свой секрет и перезапустите сервер."
  );
}

app.use(session({
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
    // secure: true — включить, когда сервер будет за HTTPS/reverse proxy
  },
}));

app.use("/api/auth", require("./routes/auth")(db));
app.use("/api/tickets", require("./routes/tickets")(db));
app.use("/api/notifications", require("./routes/notifications")(db));
app.use("/api/admin", require("./routes/admin")(db));
app.use("/api/departments", require("./routes/departments")());
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

app.listen(config.port, () => {
  console.log(`Сервер запущен на порту ${config.port}`);
});
