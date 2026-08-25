const fs = require("fs");
const http = require("http");
const https = require("https");
const tls = require("tls");

/**
 * TLS для платформы.
 *
 * Модель намеренно та же, что у модуля «Искра» (см. MESSENGER/server.js):
 * обратного прокси перед приложением нет, TLS разворачивает сам процесс.
 * Так не остаётся параллельного незашифрованного порта, про который легко
 * забыть, и настройка у всех сервисов платформы выглядит одинаково.
 *
 * Шифрование включается само, как только задан сертификат, — отдельного
 * переключателя нет, чтобы не было состояния «сертификат положили, а включить
 * забыли». Ничего не задано — сервер работает по http, как раньше, и пишет
 * об этом в консоль.
 *
 * Источники сертификата, в порядке приоритета:
 *   TLS_PFX (+ TLS_PFX_PASSWORD) — экспорт из УЦ домена вместе с ключом и цепочкой;
 *   TLS_CERT + TLS_KEY          — PEM, где TLS_CERT — ПОЛНАЯ цепочка.
 */
function resolveTlsOptions(env = process.env) {
  if (env.TLS_PFX) {
    const options = { pfx: fs.readFileSync(env.TLS_PFX) };
    if (env.TLS_PFX_PASSWORD) options.passphrase = env.TLS_PFX_PASSWORD;
    return { options, source: "pfx", where: env.TLS_PFX };
  }
  if (env.TLS_CERT && env.TLS_KEY) {
    return {
      options: { cert: fs.readFileSync(env.TLS_CERT), key: fs.readFileSync(env.TLS_KEY) },
      source: "pem",
      where: env.TLS_CERT,
    };
  }
  return null;
}

/**
 * Возвращает { server, secure }. Битый файл или неверный пароль выясняются
 * здесь, при запуске, а не при первом обращении пользователя.
 */
function createAppServer(app, env = process.env) {
  const resolved = resolveTlsOptions(env);

  if (!resolved) {
    console.warn(
      "[внимание] Сертификат не задан (TLS_PFX или TLS_CERT+TLS_KEY) — платформа работает по HTTP, " +
        "пароли и переписка идут открытым текстом. Это допустимо только в изолированной сети."
    );
    return { server: http.createServer(app), secure: false };
  }

  try {
    tls.createSecureContext(resolved.options);
  } catch (err) {
    const reason = resolved.options.passphrase
      ? "файл не читается — вероятно, неверный пароль"
      : "файл не читается — вероятно, он защищён паролем, а пароль не задан (TLS_PFX_PASSWORD)";
    console.error(`[остановка] Сертификат ${resolved.where}: ${reason}\n${err.message}`);
    throw err;
  }

  console.log(`TLS включён: сертификат из ${resolved.where} (${resolved.source})`);
  return { server: https.createServer(resolved.options, app), secure: true };
}

module.exports = { resolveTlsOptions, createAppServer };
