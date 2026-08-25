const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { requireRole } = require("../middleware/auth");
const modules = require("../config/modules");
const {
  currentTlsState,
  describeChain,
  describeCaPem,
  listTrustedRoots,
  TRUSTED_DIR,
  SHARED_PFX,
} = require("../services/tls");
const tls = require("tls");

// Максимальный размер загружаемого корневого сертификата. Корень — это
// килобайты; всё, что заметно больше, точно не он.
const MAX_CA_BYTES = 64 * 1024;

// Имя файла задаёт администратор, и оно уходит в путь на диске — поэтому
// разрешаем только заведомо безопасный набор символов. Без этого «имя» вида
// ../../server.pfx перезаписало бы рабочий сертификат.
const SAFE_NAME = /^[A-Za-zА-Яа-я0-9._-]{1,80}$/;

module.exports = function certificateRoutes() {
  const router = express.Router();
  router.use(requireRole("it"));

  // Что сервер предъявляет клиентам. Хранилище общее для платформы и «Искры»:
  // они на одной машине и отвечают на одни и те же имена.
  //
  // Сертификатов может быть несколько — по одному на домен. Отдаём их вместе с
  // именами, за которые каждый отвечает, и с подсказкой, какому домену он
  // достанется: без этого «какой сертификат сейчас предъявляется вон тем
  // клиентам» выясняется только перехватом трафика.
  router.get("/server", (req, res) => {
    const state = currentTlsState();
    res.json({
      secure: state.secure,
      source: state.source,
      where: state.where,
      sharedStore: SHARED_PFX,
      // Управление файлами живёт в панели «Искры» — там уже есть загрузка с
      // проверкой пароля и цепочки. Платформа перечитывает те же файлы сама.
      managedBy: state.source === "shared-store" ? "iskra" : "env",
      certificate: state.certificate,
      entries: state.entries || [],
      domains: describeDomains(state.entries || []),
    });
  });

  // Проверка «а что увидит клиент, который придёт с таким именем». Ровно тот
  // вопрос, который возникает при двух доменах, и ровно его иначе не задать,
  // не пересаживаясь за машину в нужной подсети.
  router.get("/server/for/:name", (req, res) => {
    const name = String(req.params.name || "").toLowerCase();
    if (!/^[a-z0-9.*-]{1,253}$/.test(name)) return res.status(400).json({ error: "Некорректное имя" });
    const state = currentTlsState();
    const match = (state.entries || []).find((e) => matchesName(e.names || [], name));
    const fallback = (state.entries || []).find((e) => e.isDefault) || (state.entries || [])[0] || null;
    res.json({
      name,
      matched: Boolean(match),
      // Если имя не совпало ни с одним — клиенту уедет основной сертификат, и
      // браузер ругнётся на несовпадение имени. Показываем именно это.
      entry: match || fallback || null,
      viaSni: Boolean(match),
    });
  });

  // Кому мы доверяем. Доменов два, поэтому корней может быть несколько; плюс
  // сторонние на будущее.
  router.get("/trusted", (req, res) => {
    res.json({ dir: TRUSTED_DIR, roots: listTrustedRoots() });
  });

  router.post("/trusted", (req, res) => {
    const { name, pem } = req.body || {};
    if (typeof name !== "string" || !SAFE_NAME.test(name)) {
      return res.status(400).json({ error: "Имя файла: буквы, цифры, точка, дефис, подчёркивание (до 80 символов)" });
    }
    if (!/\.(crt|cer|pem)$/i.test(name)) {
      return res.status(400).json({ error: "Расширение файла должно быть .crt, .cer или .pem" });
    }
    if (typeof pem !== "string" || !pem.includes("BEGIN CERTIFICATE")) {
      return res.status(400).json({ error: "Это не похоже на сертификат в формате PEM" });
    }
    if (Buffer.byteLength(pem) > MAX_CA_BYTES) {
      return res.status(400).json({ error: "Файл слишком большой для корневого сертификата" });
    }

    // Разбираем ДО записи: класть в доверенные то, что не является
    // сертификатом, нельзя — потом это молча ломает запуск.
    let described;
    try {
      const x = new crypto.X509Certificate(pem);
      described = describeCaPem(pem, name);
      if (x.subject !== x.issuer) {
        // Промежуточный сертификат в списке корней бесполезен: доверие
        // якорится на корне. Предупреждаем явно, но не запрещаем — бывают
        // схемы с кросс-подписью.
        described.warning = "Это не самоподписанный корень, а промежуточный сертификат";
      }
    } catch {
      return res.status(400).json({ error: "Файл не разбирается как сертификат" });
    }

    try {
      fs.mkdirSync(TRUSTED_DIR, { recursive: true });
      fs.writeFileSync(path.join(TRUSTED_DIR, name), pem);
    } catch (err) {
      return res.status(500).json({ error: "Не удалось сохранить файл: " + err.message });
    }
    console.log(`Добавлен доверенный корень ${name} (${described.subject || "без CN"})`);
    res.status(201).json({ ok: true, root: described });
  });

  router.delete("/trusted/:name", (req, res) => {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) return res.status(400).json({ error: "Некорректное имя файла" });
    const file = path.join(TRUSTED_DIR, name);
    // Дополнительная страховка поверх SAFE_NAME: убеждаемся, что итоговый путь
    // не вышел за пределы каталога доверенных корней.
    if (path.dirname(path.resolve(file)) !== path.resolve(TRUSTED_DIR)) {
      return res.status(400).json({ error: "Некорректное имя файла" });
    }
    try {
      if (!fs.existsSync(file)) return res.status(404).json({ error: "Файл не найден" });
      fs.unlinkSync(file);
    } catch (err) {
      return res.status(500).json({ error: "Не удалось удалить файл: " + err.message });
    }
    console.log(`Удалён доверенный корень ${name}`);
    res.json({ ok: true });
  });

  // Что предъявляет каждый модуль. Полезно ровно тем, что показывает
  // рассогласование: срок, имя в сертификате и корень видно рядом, а не по
  // отдельным серверам.
  router.get("/modules", async (req, res) => {
    const results = await Promise.all(modules.map((mod) => probeModule(mod)));
    res.json({ modules: results });
  });

  return router;
};

function probeModule(mod) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(mod.target); } catch {
      return resolve({ id: mod.id, label: mod.label, target: mod.target, error: "Некорректный адрес модуля" });
    }
    const base = { id: mod.id, label: mod.label, target: mod.target };
    if (url.protocol !== "https:") {
      return resolve({ ...base, secure: false });
    }

    // rejectUnauthorized:false здесь осознанно: задача — ПОКАЗАТЬ сертификат,
    // в том числе когда он невалиден (ради этого экран и нужен). На боевое
    // проксирование это не влияет — там проверка строгая, см. routes/modules.js.
    const socket = tls.connect(
      {
        host: url.hostname,
        port: Number(url.port) || 443,
        servername: url.hostname,
        rejectUnauthorized: false,
        timeout: 4000,
      },
      () => {
        let info = null;
        try { info = describeChain(socket.getPeerCertificate(true)); } catch { /* ниже */ }
        // Отдельно: приняла бы этот сертификат обычная строгая проверка.
        const authorized = socket.authorized;
        const authorizationError = socket.authorizationError ? String(socket.authorizationError) : null;
        socket.destroy();
        resolve({ ...base, secure: true, authorized, authorizationError, certificate: info });
      }
    );
    socket.on("timeout", () => { socket.destroy(); resolve({ ...base, secure: true, error: "Модуль не ответил" }); });
    socket.on("error", (err) => resolve({ ...base, secure: true, error: err.message }));
  });
}

// Имя совпадает точно или закрыто подстановочным сертификатом (*.in.local),
// который действует ровно на один уровень имени — так же, как это считают
// браузеры.
function matchesName(names, name) {
  if (names.includes(name)) return true;
  const wildcard = name.replace(/^[^.]+\./, "*.");
  return wildcard !== name && names.includes(wildcard);
}

// Группировка сертификатов по доменному суффиксу имён. Домен здесь — не
// сущность из конфига, а просто общая часть имени: сертификат сам говорит, за
// какой домен он отвечает, и сверять его с настройками LDAP смысла нет.
function describeDomains(entries) {
  const map = new Map();
  for (const entry of entries) {
    for (const name of entry.names || []) {
      // IP-адрес доменом не является — он попадает в SAN отдельной строкой.
      const suffix = /^[0-9.:]+$/.test(name) ? name : name.split(".").slice(1).join(".");
      const key = suffix || name;
      if (!map.has(key)) map.set(key, { domain: key, names: [], file: entry.file, certificate: entry.certificate });
      map.get(key).names.push(name);
    }
  }
  return [...map.values()];
}
