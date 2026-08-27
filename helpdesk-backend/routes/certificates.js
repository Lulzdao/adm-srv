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
  reloadCertStore,
  TRUSTED_DIR,
  SHARED_PFX,
  SHARED_PASS,
} = require("../services/tls");
const tls = require("tls");

// Максимальный размер загружаемого корневого сертификата. Корень — это
// килобайты; всё, что заметно больше, точно не он.
const MAX_CA_BYTES = 64 * 1024;

// PFX с закрытым ключом и полной цепочкой — единицы-десятки килобайт. Предел
// с запасом, но не бесконечный: тело запроса читается в память.
const MAX_PFX_BYTES = 512 * 1024;


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

  // Что сервер предъявляет клиентам. Сертификат ОДИН и общий с «Искрой»: обе
  // службы на одной машине и отвечают на одно имя, поэтому и файл один.
  router.get("/server", (req, res) => {
    const state = currentTlsState();
    res.json({
      secure: state.secure,
      source: state.source,
      where: state.where,
      sharedStore: SHARED_PFX,
      // "store" — файл в общем хранилище, его можно заменить прямо здесь.
      // "env" — путь прописан в .env, тогда замена только через .env и перезапуск.
      managedBy: state.source === "shared-store" ? "store" : "env",
      // Куда платформа смотрит за общим хранилищем. Нужно как раз в случае
      // "env": по этому пути видно, найдёт ли она «Искру», если убрать TLS_PFX.
      storeDir: path.dirname(SHARED_PFX),
      certificate: state.certificate,
    });
  });

  /**
   * Загрузка сертификата сервера. Это основная работа с сертификатами:
   * «что мы предъявляем клиентам». Корни (кому верим мы) — отдельная и куда
   * более редкая история, см. ниже.
   *
   * Файл всегда один и тот же — server.pfx в общем хранилище. Его же читает
   * «Искра», поэтому загрузить можно из любой панели, разницы нет. Прежний
   * файл сохраняется рядом с суффиксом .bak.
   */
  router.post("/server", async (req, res) => {
    const { pfx, password } = req.body || {};
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
      // Сертификат без SAN не примет ни один современный клиент: и браузеры, и
      // Node давно смотрят только туда, а не в CN.
      return res.status(400).json({ error: "В сертификате нет имён (SAN) — такой не примет ни браузер, ни клиент" });
    }

    try {
      fs.mkdirSync(path.dirname(SHARED_PFX), { recursive: true, mode: 0o700 });
      // Шаг назад на случай, если новый файл окажется не тем: старый не
      // затирается насовсем.
      for (const prev of [SHARED_PFX, SHARED_PASS]) {
        if (fs.existsSync(prev)) fs.copyFileSync(prev, prev + ".bak");
      }
      fs.writeFileSync(SHARED_PFX, buffer, { mode: 0o600 });
      if (password) fs.writeFileSync(SHARED_PASS, String(password), { mode: 0o600 });
      else if (fs.existsSync(SHARED_PASS)) fs.unlinkSync(SHARED_PASS);
    } catch (err) {
      return res.status(500).json({ error: "Не удалось сохранить файл: " + err.message });
    }

    // Применяем сразу, не дожидаясь слежения за каталогом: администратор
    // должен увидеть результат, а не «сохранено, проверьте сами».
    const applied = await reloadCertStore();
    console.log(`Загружен сертификат сервера (${info.subject || "без CN"}), применён: ${applied.applied}`);
    res.status(201).json({
      ok: true,
      certificate: info,
      // false означает «нужен перезапуск»: превратить работающий http-сервер
      // в https на ходу нельзя, и это единственный такой случай.
      applied: applied.applied,
      restartRequired: !applied.applied,
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
