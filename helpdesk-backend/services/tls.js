const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const tls = require("tls");
const crypto = require("crypto");

/**
 * TLS платформы.
 *
 * Обратного прокси перед приложением нет намеренно: TLS разворачивает сам
 * процесс, и параллельного незашифрованного порта, про который легко забыть,
 * не остаётся. Шифрование включается само, как только есть сертификат.
 *
 * СЕРТИФИКАТ ОДИН. Платформа и «Искра» стоят на одной машине и отвечают на
 * одно имя — p48-srv-adm01.rosstat.local. Обращаются по нему из обеих подсетей:
 * в in.local заведена запись и маршрут через шлюз, который знает этот адрес,
 * поэтому второго имени, второго сертификата и выбора сертификата по имени
 * (SNI) не требуется. Удостоверяющий центр тоже один — его корень раздаётся
 * групповыми политиками в оба домена.
 *
 * Файл один и тот же для обеих служб: MESSENGER/certs/server.pfx, рядом
 * server.pass с паролем. Оба сервиса читают его и перечитывают, когда он
 * меняется, поэтому загрузить новый можно из любой панели — платформы или
 * «Искры», разницы нет.
 *
 * Порядок поиска:
 *   1. TLS_PFX (+ TLS_PFX_PASSWORD) — если путь задан явно;
 *   2. TLS_CERT + TLS_KEY — PEM, где TLS_CERT это ПОЛНАЯ цепочка;
 *   3. общее хранилище (по умолчанию MESSENGER/certs/server.pfx).
 * Явно заданный в .env сертификат отключает слежение за файлом: если
 * администратор прописал путь руками, мы не подменяем его решение.
 */

// Где лежит общее хранилище. Значение по умолчанию совпадает с тем, что
// использует MESSENGER/server.js (certsDir = <корень Искры>/certs).
const SHARED_CERT_DIR = process.env.SHARED_CERT_DIR
  || path.join(__dirname, "..", "..", "MESSENGER", "certs");
const SHARED_PFX = path.join(SHARED_CERT_DIR, "server.pfx");
const SHARED_PASS = path.join(SHARED_CERT_DIR, "server.pass");

function readIfExists(file, encoding) {
  try { return fs.readFileSync(file, encoding); } catch { return null; }
}

function resolveTlsOptions(env = process.env) {
  if (env.TLS_PFX) {
    const options = { pfx: fs.readFileSync(env.TLS_PFX) };
    if (env.TLS_PFX_PASSWORD) options.passphrase = env.TLS_PFX_PASSWORD;
    return { options, source: "env-pfx", where: env.TLS_PFX };
  }
  if (env.TLS_CERT && env.TLS_KEY) {
    return {
      options: { cert: fs.readFileSync(env.TLS_CERT), key: fs.readFileSync(env.TLS_KEY) },
      source: "env-pem",
      where: env.TLS_CERT,
    };
  }
  const dir = env.SHARED_CERT_DIR || SHARED_CERT_DIR;
  const file = path.join(dir, "server.pfx");
  const pfx = readIfExists(file);
  if (pfx) {
    const options = { pfx };
    // Пароль лежит в соседнем .pass как есть, без перевода строки, — так его
    // пишет панель. Поэтому и читаем как есть, не обрезая пробелы: пробел в
    // конце пароля тоже пароль.
    const pass = readIfExists(path.join(dir, "server.pass"), "utf8");
    if (pass) options.passphrase = pass;
    return { options, source: "shared-store", where: file };
  }
  return null;
}

/**
 * Что сертификат представляет собой на самом деле. Смотрим не в файл, а на
 * результат: поднимаем его в настоящем TLS-сервере на случайном порту,
 * подключаемся и разбираем предъявленную цепочку. Из PFX её содержимое иначе
 * не видно, а в PEM легко положить лишнее или забыть промежуточный.
 */
function inspectTlsOptions(options) {
  return new Promise((resolve, reject) => {
    let probe;
    try { probe = tls.createServer(options, (socket) => socket.end()); }
    catch (err) { return reject(err); }

    const fail = (err) => { try { probe.close(); } catch { /* уже закрыт */ } reject(err); };
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const socket = tls.connect(
        { host: "127.0.0.1", port: probe.address().port, rejectUnauthorized: false },
        () => {
          let info;
          try { info = describeChain(socket.getPeerCertificate(true)); }
          catch (err) { socket.destroy(); return fail(err); }
          socket.destroy();
          probe.close(() => resolve(info));
        }
      );
      socket.on("error", fail);
    });
  });
}

function describeChain(peer) {
  const chain = [];
  let cert = peer;
  while (cert && cert.fingerprint256 && !chain.some((c) => c.fingerprint256 === cert.fingerprint256)) {
    chain.push(cert);
    cert = cert.issuerCertificate;
  }
  const leaf = chain[0] || {};
  const last = chain[chain.length - 1] || {};
  const validTo = leaf.valid_to ? new Date(leaf.valid_to) : null;
  // Самоподписанный последний элемент означает, что корень в цепочке есть —
  // то есть сервер отдаёт её целиком и клиенту не нужно ничего доискивать.
  const selfSignedRoot = Boolean(
    last.subject && last.issuer && JSON.stringify(last.subject) === JSON.stringify(last.issuer)
  );

  return {
    subject: (leaf.subject && leaf.subject.CN) || null,
    san: leaf.subjectaltname || null,
    names: dnsNames(leaf),
    issuer: (leaf.issuer && leaf.issuer.CN) || null,
    validFrom: leaf.valid_from || null,
    validTo: leaf.valid_to || null,
    daysLeft: validTo ? Math.round((validTo - Date.now()) / 86400000) : null,
    fingerprint: leaf.fingerprint256 || null,
    rootSubject: (last.subject && last.subject.CN) || null,
    rootFingerprint: last.fingerprint256 || null,
    certificates: chain.length,
    chainComplete: selfSignedRoot,
  };
}

/**
 * Имена, за которые сертификат отвечает. Берём из SAN, а не из CN: браузеры и
 * Node давно смотрят только туда, и сертификат «на CN без SAN» не примет никто.
 * Показываем их в панели — по ним видно, к серверу под каким именем вообще
 * можно обращаться.
 */
function dnsNames(leaf) {
  const san = leaf && leaf.subjectaltname;
  if (!san) return [];
  return String(san)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^(DNS|IP Address):/i.test(part))
    .map((part) => part.replace(/^(DNS|IP Address):/i, "").toLowerCase());
}

// Работающий https-сервер: держим ссылку, чтобы применить новый сертификат
// сразу после загрузки из панели, не дожидаясь срабатывания fs.watch.
let activeServer = null;
let activeDir = SHARED_CERT_DIR;

// Последнее, что удалось узнать о действующем сертификате: панель показывает
// это, не трогая сеть заново.
let current = { secure: false, source: null, where: null, certificate: null };

function currentTlsState() {
  return { ...current };
}

function refreshCertificateInfo(options) {
  return inspectTlsOptions(options)
    .then((info) => { current.certificate = info; return info; })
    .catch((err) => {
      console.error("Не удалось разобрать действующий сертификат:", err.message);
      return null;
    });
}

/**
 * Возвращает { server, secure }. Битый файл или неверный пароль выясняются
 * здесь, при запуске, а не при первом обращении пользователя.
 */
function createAppServer(app, env = process.env) {
  const resolved = resolveTlsOptions(env);

  if (!resolved) {
    console.warn(
      "[внимание] Сертификат не задан и общего хранилища нет — платформа работает по HTTP, " +
        "пароли и переписка идут открытым текстом. Это допустимо только в изолированной сети."
    );
    current = { secure: false, source: null, where: null, certificate: null };
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

  const server = https.createServer(resolved.options, app);
  current = { secure: true, source: resolved.source, where: resolved.where, certificate: null };
  console.log(`TLS включён: сертификат из ${resolved.where} (${resolved.source})`);

  // Узнаём, что реально отдаём клиенту, — уже после старта, чтобы не задерживать
  // подъём сервера, если проверка почему-то затянется.
  refreshCertificateInfo(resolved.options);

  watchSharedStore(server, resolved.source, env.SHARED_CERT_DIR || SHARED_CERT_DIR);
  return { server, secure: true };
}

/**
 * Перечитывание сертификата без перезапуска.
 *
 * Ради этого всё и затевалось: администратор загружает новый файл один раз —
 * в панели платформы или «Искры», всё равно, — и обе службы начинают отдавать
 * его сами. Иначе платформа продолжала бы предъявлять старый сертификат до
 * ручного перезапуска, и это тот случай, когда «вроде поменяли, а не
 * работает» ищут часами.
 *
 * Меняется только контекст: уже открытые соединения доживают со старым
 * сертификатом, новые идут с новым.
 */
async function reloadCertStore() {
  if (!activeServer || current.source !== "shared-store") {
    // Сертификат задан явно в .env — менять его на ходу не наше дело.
    return { applied: false, reason: "not-shared-store" };
  }
  const resolved = resolveTlsOptions();
  if (!resolved || resolved.source !== "shared-store") {
    return { applied: false, reason: "store-empty" };
  }
  try {
    tls.createSecureContext(resolved.options); // сначала убеждаемся, что файл рабочий
    activeServer.setSecureContext(resolved.options);
    current.where = resolved.where;
  } catch (err) {
    // Важно НЕ применять битый файл: старый контекст остаётся рабочим,
    // сервис продолжает отвечать.
    console.error(`Новый сертификат не принят, оставлен прежний: ${err.message}`);
    return { applied: false, reason: "unreadable", error: err.message };
  }
  await refreshCertificateInfo(resolved.options);
  console.log("Сертификат перечитан из общего хранилища без перезапуска");
  return { applied: true };
}

function watchSharedStore(server, source, dir = SHARED_CERT_DIR) {
  if (source !== "shared-store") return; // явный путь в .env менять на ходу не наше дело
  activeServer = server;
  activeDir = dir;
  if (!fs.existsSync(dir)) return;

  let timer = null;
  try {
    fs.watch(dir, (event, filename) => {
      if (filename && !/^server\.(pfx|pass)$/.test(String(filename))) return;
      // Панель пишет .pfx и .pass по очереди, да и запись не атомарна — ждём,
      // пока файлы улягутся, иначе прочитаем половину.
      clearTimeout(timer);
      timer = setTimeout(() => { reloadCertStore().catch(() => { /* уже залогировано */ }); }, 1500);
    }).unref();
  } catch (err) {
    console.warn(`Не удалось следить за хранилищем сертификатов: ${err.message}`);
  }
}

// --- Доверенные корни ---------------------------------------------------
//
// Это ДРУГАЯ сущность, чем сертификат сервера, и путать их нельзя:
// сертификат сервера — то, что мы предъявляем; корни — то, кому верим мы,
// когда сами ходим наружу (LDAPS к контроллерам доменов, проверка «Искры»
// при проксировании). Клиентов это не касается: они берут корни из хранилища
// Windows. Удостоверяющий центр у нас один, так что в обычной жизни здесь
// пусто; список нужен на машине вне домена и на время смены УЦ.
const TRUSTED_DIR = process.env.TRUSTED_CA_DIR || path.join(__dirname, "..", "certs", "trusted");

function describeCaPem(pem, file) {
  try {
    const x = new crypto.X509Certificate(pem);
    const validTo = new Date(x.validTo);
    return {
      file,
      subject: x.subject.split("\n").find((l) => l.startsWith("CN=")) || x.subject.split("\n")[0] || null,
      issuer: x.issuer.split("\n").find((l) => l.startsWith("CN=")) || null,
      validFrom: x.validFrom,
      validTo: x.validTo,
      daysLeft: Number.isNaN(validTo.getTime()) ? null : Math.round((validTo - Date.now()) / 86400000),
      fingerprint: x.fingerprint256,
      selfSigned: x.subject === x.issuer, // корень, а не промежуточный
    };
  } catch (err) {
    return { file, error: "Файл не разбирается как сертификат" };
  }
}

function listTrustedRoots() {
  let names;
  try { names = fs.readdirSync(TRUSTED_DIR); } catch { return []; }
  return names
    .filter((n) => /\.(crt|cer|pem)$/i.test(n))
    .map((n) => {
      const pem = readIfExists(path.join(TRUSTED_DIR, n), "utf8");
      return pem ? describeCaPem(pem, n) : { file: n, error: "Файл не читается" };
    });
}

module.exports = {
  resolveTlsOptions,
  createAppServer,
  currentTlsState,
  inspectTlsOptions,
  describeChain,
  describeCaPem,
  listTrustedRoots,
  reloadCertStore,
  TRUSTED_DIR,
  SHARED_CERT_DIR,
  SHARED_PFX,
  SHARED_PASS,
};
