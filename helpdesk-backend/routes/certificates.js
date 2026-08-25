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
  inspectTlsOptions,
  listStoreCertificates,
  reloadCertStore,
  TRUSTED_DIR,
  SHARED_CERT_DIR,
  SHARED_PFX,
} = require("../services/tls");
const tls = require("tls");

// Максимальный размер загружаемого корневого сертификата. Корень — это
// килобайты; всё, что заметно больше, точно не он.
const MAX_CA_BYTES = 64 * 1024;

// PFX с закрытым ключом и полной цепочкой — единицы-десятки килобайт. Предел
// с запасом, но не бесконечный: тело запроса читается в память.
const MAX_PFX_BYTES = 512 * 1024;

// Имена файлов хранилища: server.pfx и server.<домен>.pfx. Тот же набор, что
// в services/tls.js, — держать его в согласии обязательно, иначе панель будет
// писать файлы, которых сервер не видит.
const STORE_FILE = /^server(\.[A-Za-z0-9][A-Za-z0-9._-]*)?\.pfx$/;

// Имя файла задаёт администратор, и оно уходит в путь на диске — поэтому
// разрешаем только заведомо безопасный набор символов. Без этого «имя» вида
// ../../server.pfx перезаписало бы рабочий сертификат.
const SAFE_NAME = /^[A-Za-zА-Яа-я0-9._-]{1,80}$/;

module.exports = function certificateRoutes() {
  const router = express.Router();
  // Свой разбор тела: общий парсер в server.js ограничен 100 КБ, а PFX с
  // цепочкой в base64 в этот предел не влезает. Поэтому маршрут смонтирован
  // до общего парсера и читает тело сам.
  router.use(express.json({ limit: String(Math.round(MAX_PFX_BYTES * 1.4 / 1024)) + "kb" }));
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

  /**
   * Загрузка сертификата сервера. Это основная работа с сертификатами:
   * «что мы предъявляем клиентам». Корни (кому верим мы) — отдельная и куда
   * более редкая история, см. ниже.
   *
   * Имя файла администратор НЕ выбирает: его определяет сам сертификат. Домен
   * берётся из имён в SAN, и если для этого домена файл уже есть — он
   * перезаписывается. Иначе появляется новый. Так продление сертификата
   * заменяет старый, а не оседает вторым файлом рядом, и не нужно помнить
   * договорённость об именах.
   */
  router.post("/server", async (req, res) => {
    const { pfx, password, makeDefault } = req.body || {};
    if (typeof pfx !== "string" || !pfx) return res.status(400).json({ error: "Файл не передан" });
    if (pfx.length > MAX_PFX_BYTES * 1.4) return res.status(400).json({ error: "Файл слишком большой" });

    let buffer;
    try { buffer = Buffer.from(pfx, "base64"); }
    catch { return res.status(400).json({ error: "Файл не удалось прочитать" }); }
    if (!buffer.length) return res.status(400).json({ error: "Файл пустой" });
    if (buffer.length > MAX_PFX_BYTES) return res.status(400).json({ error: "Файл слишком большой" });

    const options = { pfx: buffer };
    if (password) options.passphrase = String(password);

    // Разбираем ДО записи: в хранилище не должно попадать то, что сервер потом
    // не сможет поднять. Заодно отсюда узнаём имена — по ним выбирается файл.
    let info;
    try {
      info = await inspectTlsOptions(options);
    } catch (err) {
      const raw = String((err && err.message) || err);
      // "mac verify failure" означает ровно одно — пароль не тот (или файл не
      // PFX). Администратор не обязан знать, что такое MAC.
      if (/mac verify failure/i.test(raw)) {
        return res.status(400).json({ error: password ? "Неверный пароль к файлу" : "Файл защищён паролем — укажите его" });
      }
      return res.status(400).json({ error: "Это не похоже на PFX-файл с сертификатом и закрытым ключом" });
    }

    if (info.daysLeft !== null && info.daysLeft < 0) {
      return res.status(400).json({ error: `Срок действия этого сертификата истёк ${info.validTo}` });
    }
    if (!info.names.length) {
      // Сертификат без SAN не примет ни один современный клиент, и выбрать по
      // имени его тоже нельзя — то есть он бесполезен ровно там, где нужен.
      return res.status(400).json({ error: "В сертификате нет имён (SAN) — такой не примет ни браузер, ни клиент" });
    }

    const existing = listStoreCertificates(SHARED_CERT_DIR);
    const known = currentTlsState().entries || []; // здесь уже разобранные имена из SAN
    const file = makeDefault || !existing.length ? "server.pfx" : targetFile(info.names, known);

    try {
      fs.mkdirSync(SHARED_CERT_DIR, { recursive: true, mode: 0o700 });
      const full = path.join(SHARED_CERT_DIR, file);
      // Шаг назад на случай, если новый файл окажется не тем: старый не
      // затирается насовсем.
      for (const ext of [".pfx", ".pass"]) {
        const prev = full.replace(/\.pfx$/, ext);
        if (fs.existsSync(prev)) fs.copyFileSync(prev, prev + ".bak");
      }
      fs.writeFileSync(full, buffer, { mode: 0o600 });
      const passFile = full.replace(/\.pfx$/, ".pass");
      if (password) fs.writeFileSync(passFile, String(password), { mode: 0o600 });
      else if (fs.existsSync(passFile)) fs.unlinkSync(passFile);
    } catch (err) {
      return res.status(500).json({ error: "Не удалось сохранить файл: " + err.message });
    }

    // Применяем сразу, не дожидаясь слежения за каталогом: администратор
    // должен увидеть результат, а не «сохранено, проверьте сами».
    const applied = await reloadCertStore();
    console.log(`Загружен сертификат сервера ${file} (${info.subject || "без CN"}), применён: ${applied.applied}`);
    res.status(201).json({
      ok: true,
      file,
      certificate: info,
      // false означает «нужен перезапуск»: превратить работающий http-сервер
      // в https на ходу нельзя, и это единственный такой случай.
      applied: applied.applied,
      restartRequired: !applied.applied,
    });
  });

  router.delete("/server/:file", async (req, res) => {
    const { file } = req.params;
    if (!STORE_FILE.test(file)) return res.status(400).json({ error: "Некорректное имя файла" });
    const full = path.join(SHARED_CERT_DIR, file);
    if (path.dirname(path.resolve(full)) !== path.resolve(SHARED_CERT_DIR)) {
      return res.status(400).json({ error: "Некорректное имя файла" });
    }
    const existing = listStoreCertificates(SHARED_CERT_DIR);
    if (!existing.some((e) => e.file === file)) return res.status(404).json({ error: "Файл не найден" });
    if (existing.length === 1) {
      // Удаление последнего оставило бы сервис без сертификата — и он не
      // выключился бы, а продолжил отвечать старым до перезапуска, после
      // которого поднялся бы по http. Такое лучше делать осознанно, руками.
      return res.status(400).json({ error: "Это единственный сертификат — удалять его через панель нельзя" });
    }
    try {
      for (const ext of [".pfx", ".pass"]) {
        const target = full.replace(/\.pfx$/, ext);
        if (fs.existsSync(target)) fs.renameSync(target, target + ".bak");
      }
    } catch (err) {
      return res.status(500).json({ error: "Не удалось удалить файл: " + err.message });
    }
    await reloadCertStore();
    console.log(`Удалён сертификат сервера ${file} (оставлена копия .bak)`);
    res.json({ ok: true });
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

/**
 * В какой файл лечь загруженному сертификату.
 *
 * Правило одно: сертификат «занимает» домен из своих имён. Если файл на этот
 * домен уже есть — перезаписываем его (это продление). Если нет — заводим
 * новый по имени домена. Так администратору не нужно ни выбирать имя файла,
 * ни помнить, какой файл за какой домен отвечал.
 */
function targetFile(names, existing) {
  const domains = names.filter((n) => !/^[0-9.:]+$/.test(n)).map((n) => n.split(".").slice(1).join("."));
  const domain = domains.find(Boolean);
  const busy = existing.find((e) => (e.names || []).some((n) => domains.includes(n.split(".").slice(1).join("."))));
  if (busy) return busy.file;
  if (!domain) return "server.pfx";
  const safe = domain.toLowerCase().replace(/[^a-z0-9.-]/g, "-");
  return `server.${safe}.pfx`;
}
