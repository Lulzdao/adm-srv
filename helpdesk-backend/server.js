const express = require("express");
const path = require("path");
const session = require("express-session");
const config = require("./config/config");
const { initDb, ensureLocalAccounts } = require("./db/init");

const db = initDb();
ensureLocalAccounts(db);

const app = express();
app.use(express.json());
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true, // продлевает срок действия куки при каждом активном запросе
  cookie: {
    httpOnly: true,
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
