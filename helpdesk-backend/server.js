const config = require("./config/config");
const { createApp } = require("./app");
const { initDb, ensureLocalAccounts } = require("./db/init");
const { resolveTlsOptions, createAppServer } = require("./services/tls");

// Точка запуска: всё, что имеет побочные эффекты. Сборка самого приложения
// живёт в app.js и ничего не начинает — так её можно поднять в тесте.

const db = initDb();
ensureLocalAccounts(db);

// Узнаём про TLS ДО настройки сессии: от этого зависит флаг Secure у куки, а
// поменять его после создания middleware уже нельзя.
const tlsEnabled = Boolean(resolveTlsOptions());

if (!process.env.SESSION_SECRET) {
  console.warn(
    "[внимание] SESSION_SECRET не задан в .env — используется значение по умолчанию. " +
      "Сессии можно подделать: задайте свой секрет и перезапустите сервер."
  );
}

const app = createApp(db, { secureCookie: tlsEnabled });

// Планировщик оповещений — после того, как маршруты собраны: первый обход он
// делает сразу при старте, и к этому моменту всё, чем он пользуется, должно
// быть готово.
require("./services/scheduler").start(db);

const { server, secure } = createAppServer(app);
// Порт занят — чаще всего это вторая копия платформы, запущенная вручную рядом
// со службой. Без обработчика процесс падал со стеком EADDRINUSE; теперь —
// одна понятная строка и выход с ошибкой, чтобы NSSM попробовал снова позже.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[остановка] Порт ${config.port} уже занят — платформа уже запущена (служба ITS-Platform или вручную) ` +
        "или порт занят другой программой: netstat -ano | findstr :" + config.port
    );
  } else {
    console.error(`[остановка] Не удалось открыть порт ${config.port}: ${err.message}`);
  }
  process.exit(1);
});
server.listen(config.port, () => {
  console.log(`Сервер запущен: ${secure ? "https" : "http"}://localhost:${config.port}`);
});
