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
 * ОБЩЕЕ ХРАНИЛИЩЕ. Платформа и «Искра» стоят на одной машине и отвечают на
 * одни и те же имена, поэтому сертификаты у них ОДНИ — те же файлы, которыми
 * уже умеет управлять панель «Искры» (раздел «Сертификат»: загрузка, проверка
 * пароля и цепочки, замена на лету). Дублировать эту машинерию в платформе
 * вредно: два хранилища — ровно та путаница, которой мы избегаем. Платформа
 * читает те же файлы и перечитывает их, когда они меняются.
 *
 * ДВА ДОМЕНА — ДВА СЕРТИФИКАТА. Подсети две, домены разные (rosstat.local и
 * in.local), удостоверяющий центр у каждого свой. Заставлять один домен
 * доверять чужому УЦ не нужно и не надо: сервер держит по сертификату на
 * домен и предъявляет тот, чьё имя клиент запросил (SNI). Клиент из любой
 * подсети видит сертификат СВОЕГО домена, выданный СВОИМ УЦ, корень которого
 * и так лежит у него в хранилище благодаря групповым политикам.
 *
 * Как это выглядит в каталоге:
 *   server.pfx              — основной (тот, что был всегда), rosstat.local
 *   server.in.local.pfx     — второй домен; суффикс произвольный, он лишь для
 *                             человека, а имена берутся из самого сертификата
 *   server*.pass            — пароль к файлу рядом с ним, если он есть
 *
 * Порядок поиска сертификата по умолчанию:
 *   1. TLS_PFX (+ TLS_PFX_PASSWORD) — если путь задан явно;
 *   2. TLS_CERT + TLS_KEY — PEM, где TLS_CERT это ПОЛНАЯ цепочка;
 *   3. общее хранилище (по умолчанию MESSENGER/certs/server.pfx).
 * Явно заданный в .env сертификат отключает и слежение за каталогом, и SNI:
 * если администратор прописал файл руками, мы не подменяем его решение.
 */

// Где лежит общее хранилище. Значение по умолчанию совпадает с тем, что
// использует MESSENGER/server.js (certsDir = <корень Искры>/certs).
const SHARED_CERT_DIR = process.env.SHARED_CERT_DIR
  || path.join(__dirname, "..", "..", "MESSENGER", "certs");
const SHARED_PFX = path.join(SHARED_CERT_DIR, "server.pfx");
const SHARED_PASS = path.join(SHARED_CERT_DIR, "server.pass");

// server.pfx и server.<что-угодно>.pfx — и ничего больше: .bak, оставленный
// «Искрой» перед заменой, подхватывать нельзя.
const STORE_FILE = /^server(\.[A-Za-z0-9][A-Za-z0-9._-]*)?\.pfx$/;

function readIfExists(file, encoding) {
  try { return fs.readFileSync(file, encoding); } catch { return null; }
}

function optionsForPfx(file) {
  const pfx = readIfExists(file);
  if (!pfx) return null;
  const options = { pfx };
  // Пароль пишется в соседний .pass как есть, без перевода строки, — так его
  // кладёт панель «Искры»; поэтому и читаем как есть, не обрезая пробелы:
  // пробел в конце пароля тоже пароль.
  const pass = readIfExists(file.replace(/\.pfx$/, ".pass"), "utf8");
  if (pass) options.passphrase = pass;
  return options;
}

/** Все сертификаты общего хранилища. Первым — основной. */
function listStoreCertificates(dir = SHARED_CERT_DIR) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => STORE_FILE.test(n))
    .sort((a, b) => (a === "server.pfx" ? -1 : b === "server.pfx" ? 1 : a.localeCompare(b)))
    .map((n) => {
      const where = path.join(dir, n);
      const options = optionsForPfx(where);
      return options ? { file: n, where, options, isDefault: n === "server.pfx" } : null;
    })
    .filter(Boolean);
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
  // Основной — server.pfx; если его нет, годится любой из хранилища: сервер
  // должен подняться и с одним сертификатом второго домена.
  const entries = listStoreCertificates(env.SHARED_CERT_DIR || SHARED_CERT_DIR);
  if (entries.length) {
    const first = entries[0];
    return { options: first.options, source: "shared-store", where: first.where };
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
 * IP из SAN тоже собираем — по ним никто ходить не должен, но показать в
 * панели полезно: видно, если сертификат выписан «на адрес».
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

// Последнее, что удалось узнать о действующих сертификатах: панель показывает
// это, не трогая сеть заново.
let current = { secure: false, source: null, where: null, certificate: null, entries: [] };

function currentTlsState() {
  return { ...current, entries: current.entries.map((e) => ({ ...e })) };
}

// --- Выбор сертификата по запрошенному имени (SNI) ----------------------
//
// Карта «имя → контекст». Пересобирается при каждой перезагрузке хранилища,
// поэтому SNICallback ставится один раз при создании сервера и просто
// смотрит сюда.
let byName = new Map();

function contextForName(servername) {
  const name = String(servername || "").toLowerCase();
  if (!name) return null;
  const exact = byName.get(name);
  if (exact) return exact;
  // Подстановочный сертификат (*.in.local) закрывает ровно один уровень имени.
  const wildcard = byName.get(name.replace(/^[^.]+\./, "*."));
  return wildcard || null;
}

function sniCallback(servername, cb) {
  // null вместо контекста — не ошибка: сервер возьмёт свой основной. Так и
  // должно быть, пока имён ещё не узнали или пришли с незнакомым именем.
  cb(null, contextForName(servername) || undefined);
}

/**
 * Перебрать хранилище, поднять контексты и разложить их по именам.
 * Всё делается на копиях: пока новая карта не собрана, старая продолжает
 * обслуживать соединения.
 */
async function loadCertStore(dir = SHARED_CERT_DIR) {
  const entries = [];
  const next = new Map();

  for (const entry of listStoreCertificates(dir)) {
    const row = { file: entry.file, where: entry.where, isDefault: entry.isDefault, names: [], certificate: null };
    let context;
    try {
      context = tls.createSecureContext(entry.options);
    } catch (err) {
      row.error = entry.options.passphrase
        ? "Файл не читается — вероятно, неверный пароль"
        : "Файл не читается — вероятно, он защищён паролем, а пароля рядом нет (server.pass)";
      entries.push(row);
      continue;
    }
    try {
      row.certificate = await inspectTlsOptions(entry.options);
      row.names = row.certificate.names || [];
      for (const name of row.names) if (!next.has(name)) next.set(name, context);
    } catch (err) {
      // Контекст рабочий, а разобрать цепочку не вышло — сертификат всё равно
      // годен как основной, просто по имени его не выберешь.
      row.error = "Не удалось разобрать цепочку: " + err.message;
    }
    entries.push(row);
  }

  byName = next;
  current.entries = entries;
  const def = entries.find((e) => e.isDefault) || entries[0];
  if (def && def.certificate) current.certificate = def.certificate;
  return entries;
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
    current = { secure: false, source: null, where: null, certificate: null, entries: [] };
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

  const shared = resolved.source === "shared-store";
  const server = https.createServer(
    // SNICallback ставим один раз и навсегда: карта имён за ним меняется на
    // ходу, а сам обработчик после создания сервера уже не заменить.
    shared ? { ...resolved.options, SNICallback: sniCallback } : resolved.options,
    app
  );
  current = { secure: true, source: resolved.source, where: resolved.where, certificate: null, entries: [] };
  console.log(`TLS включён: сертификат из ${resolved.where} (${resolved.source})`);

  // Узнаём, что реально отдаём клиенту, — уже после старта, чтобы не задерживать
  // подъём сервера, если проверка почему-то затянется.
  if (shared) {
    loadCertStore(env.SHARED_CERT_DIR || SHARED_CERT_DIR)
      .then((entries) => {
        const named = entries.filter((e) => e.names.length);
        if (named.length > 1) {
          console.log(
            "Сертификатов в хранилище: " + entries.length + "; имена: " +
              named.map((e) => e.names.join(", ")).join(" | ")
          );
        }
      })
      .catch((err) => console.error("Не удалось разобрать хранилище сертификатов:", err.message));
  } else {
    inspectTlsOptions(resolved.options)
      .then((info) => { current.certificate = info; })
      .catch((err) => console.error("Не удалось разобрать действующий сертификат:", err.message));
  }

  watchSharedStore(server, resolved.source, env.SHARED_CERT_DIR || SHARED_CERT_DIR);
  return { server, secure: true };
}

/**
 * Перечитывание общего хранилища без перезапуска.
 *
 * Ради этого всё и затевалось: администратор загружает новый файл в панели
 * «Искры» один раз, и обе службы начинают отдавать его сами. Раньше платформа
 * продолжала бы предъявлять старый сертификат до ручного перезапуска — и это
 * тот случай, когда «вроде поменяли, а не работает» ищут часами.
 *
 * Меняется только контекст: уже открытые соединения доживают со старым
 * сертификатом, новые идут с новым.
 */
function watchSharedStore(server, source, dir = SHARED_CERT_DIR) {
  if (source !== "shared-store") return; // явный путь в .env менять на ходу не наше дело
  if (!fs.existsSync(dir)) return;

  let timer = null;
  const reload = () => {
    const resolved = resolveTlsOptions();
    if (!resolved || resolved.source !== "shared-store") return;
    try {
      tls.createSecureContext(resolved.options); // сначала убеждаемся, что файл рабочий
      server.setSecureContext(resolved.options);
      current.where = resolved.where;
      console.log("Сертификат перечитан из общего хранилища без перезапуска");
    } catch (err) {
      // Важно НЕ применять битый файл: старый контекст остаётся рабочим,
      // сервис продолжает отвечать.
      console.error(`Новый сертификат не принят, оставлен прежний: ${err.message}`);
      return;
    }
    // Карту имён пересобираем в любом случае: могли добавить или убрать
    // сертификат второго домена, не трогая основной.
    loadCertStore(dir).catch(() => { /* не смертельно: основной уже применён */ });
  };

  try {
    fs.watch(dir, (event, filename) => {
      if (filename && !STORE_FILE.test(String(filename)) && !/^server[.\w-]*\.pass$/.test(String(filename))) return;
      // Панель пишет .pfx и .pass по очереди, да и запись не атомарна — ждём,
      // пока файлы улягутся, иначе прочитаем половину.
      clearTimeout(timer);
      timer = setTimeout(reload, 1500);
    }).unref();
  } catch (err) {
    console.warn(`Не удалось следить за хранилищем сертификатов: ${err.message}`);
  }
}

// --- Доверенные корни ---------------------------------------------------
//
// Это ДРУГАЯ сущность, чем сертификат сервера, и путать их нельзя:
// сертификат сервера — то, что мы предъявляем; корни — то, кому мы верим.
// Домена два, поэтому корней тоже может быть несколько, плюс сторонние на
// будущее. Здесь платформа только хранит и показывает список; в доверие
// процесса он попадает через NODE_EXTRA_CA_CERTS (см. README).
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
  listStoreCertificates,
  loadCertStore,
  contextForName,
  TRUSTED_DIR,
  SHARED_CERT_DIR,
  SHARED_PFX,
};
