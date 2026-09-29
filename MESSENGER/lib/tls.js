'use strict';

// ---------- HTTPS ----------
// TLS разворачивает сам сервер — обратного прокси перед ним нет намеренно. Так не остаётся
// параллельного незашифрованного порта, про который легко забыть (а он обнулил бы весь смысл),
// не нужно отдельно пробрасывать WebSocket, и req.ip остаётся настоящим адресом сотрудника,
// от которого зависит защита от подбора пароля.
//
// Шифрование включается САМО, как только задан сертификат, — отдельного переключателя нет,
// чтобы не было состояния "сертификат положили, а включить забыли". Ничего не задано — сервер
// работает по http, как раньше (нужно для локальной разработки и до момента установки сертификата).
//
// Три способа задать сертификат, работает любой (проверяются в этом же порядке):
//
//   1. Хранилище certs/ — сюда кладёт файл веб-панель, раздел "Сертификат". Основной способ:
//      сертификат домена живёт два года, корневой — десять, менять их придётся, и лезть за этим
//      на сервер в консоль не нужно.
//
//   2. PFX (.pfx / .p12) из переменных окружения — то, что выдаёт удостоверяющий центр
//      Windows-домена как есть. Конвертировать ничего не нужно, Node читает этот формат сам:
//
//        set TLS_PFX=C:\iskra\server.pfx
//        set TLS_PFX_PASSWORD=пароль-которым-защищён-файл
//        npm start
//
//   3. PEM — отдельно сертификат и ключ (обычный вариант для Linux):
//
//        TLS_CERT=/etc/iskra/fullchain.crt TLS_KEY=/etc/iskra/server.key npm start
//
//      Здесь TLS_CERT — обязательно ПОЛНАЯ цепочка (сертификат сервера + промежуточные УЦ), а не
//      только сертификат сервера, и ключ должен быть без пароля, иначе сервер не поднимется без
//      ручного ввода при каждом запуске.
//
// Пароль от PFX — в переменной окружения, в скрипте запуска или в хранилище certs/ рядом с самим
// файлом; в репозитории ему не место (certs/ и *.pfx внесены в .gitignore).
//
// Здесь же маршруты раздела «Сертификат» панели (registerRoutes) и слежение за certs/, которое
// применяет сертификат, заменённый со стороны (например, из панели платформы).

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');

function createTls({ baseDir, logServer }) {
  let server = null; // HTTP(S)-сервер «Искры» — createServer ниже

  const TLS_PFX = process.env.TLS_PFX;
  const TLS_PFX_PASSWORD = process.env.TLS_PFX_PASSWORD;
  const TLS_CERT = process.env.TLS_CERT;
  const TLS_KEY = process.env.TLS_KEY;

  // Хранилище сертификата, которым управляет веб-панель (раздел "Сертификат"). Сертификат домена
  // выдаётся на два года, а корневой — на десять: рано или поздно и тот и другой придётся менять, и
  // делать это через правку переменных окружения на сервере неудобно ровно тогда, когда это нужно.
  // Приоритет у хранилища, а не у переменных окружения: администратор, заменивший сертификат из
  // панели, вправе рассчитывать, что заменился именно он. Чтобы это не превратилось в "поменял
  // переменную, а ничего не изменилось", источник пишется в журнал при каждом запуске и виден в
  // панели.
  const certsDir = path.join(baseDir, 'certs');
  const CERT_STORE_PFX = path.join(certsDir, 'server.pfx');
  const CERT_STORE_PASS = path.join(certsDir, 'server.pass');

  // Внутри .pfx лежит закрытый ключ. Права на папку — только владельцу процесса; на Windows chmod
  // почти ничего не значит (там ACL), поэтому это подстраховка для Linux, а не полная защита.
  function ensureCertsDir() {
    if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(certsDir, 0o700); } catch { /* Windows — здесь правами управляют ACL */ }
  }

  // Откуда брать сертификат. Возвращает null, если его нет нигде — тогда сервер работает по http.
  function resolveTlsOptions() {
    if (fs.existsSync(CERT_STORE_PFX)) {
      const options = { pfx: fs.readFileSync(CERT_STORE_PFX) };
      if (fs.existsSync(CERT_STORE_PASS)) options.passphrase = fs.readFileSync(CERT_STORE_PASS, 'utf8');
      return { options, source: 'store', where: CERT_STORE_PFX };
    }
    if (TLS_PFX) {
      const options = { pfx: fs.readFileSync(TLS_PFX) };
      if (TLS_PFX_PASSWORD) options.passphrase = TLS_PFX_PASSWORD;
      return { options, source: 'env-pfx', where: TLS_PFX };
    }
    if (TLS_CERT && TLS_KEY) {
      return {
        options: { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) },
        source: 'env-pem',
        where: TLS_CERT,
      };
    }
    return null;
  }

  let tlsSource = null; // что реально сейчас используется — показывается в панели

  // Задан ли сертификат ещё и переменными окружения. Нужно, чтобы предупредить о "двойной настройке":
  // пока файл лежит в хранилище, действует он, а переменная стоит в тени и ничем себя не проявляет —
  // ровно до того дня, когда файл из хранилища удалят и обнаружат, что сервер всё так же на https.
  function envTlsSource() {
    if (TLS_PFX) return 'env-pfx';
    if (TLS_CERT && TLS_KEY) return 'env-pem';
    return null;
  }

  function createAppServer(app) {
    let resolved;
    try {
      resolved = resolveTlsOptions();
    } catch (err) {
      logServer('ERROR', 'tls_unreadable', { error: String((err && err.message) || err) });
      throw err;
    }
    if (!resolved) {
      logServer('WARN', 'tls_disabled', { reason: 'сертификат не задан — трафик идёт открытым текстом' });
      return http.createServer(app);
    }
    // Пароль не подошёл или файл битый — это выясняется здесь, при запуске, а не при первом
    // подключении сотрудника.
    try {
      tls.createSecureContext(resolved.options);
    } catch (err) {
      logServer('ERROR', 'tls_pfx_unreadable', {
        source: resolved.source,
        where: resolved.where,
        reason: resolved.options.passphrase
          ? 'файл не читается — вероятно, неверный пароль'
          : 'файл не читается — вероятно, он защищён паролем, а пароль не задан',
        error: String((err && err.message) || err),
      });
      throw err;
    }
    tlsSource = resolved.source;
    logServer('INFO', 'tls_enabled', { source: resolved.source, where: resolved.where });
    if (resolved.source === 'store' && envTlsSource()) {
      logServer('WARN', 'tls_shadow_config', {
        shadowed: envTlsSource(),
        hint: 'Сертификат задан и в хранилище certs/, и переменными окружения. Действует хранилище; переменная вступит в силу, только если файл из хранилища удалить. Уберите её из скрипта запуска, чтобы управление было в одном месте',
      });
    }
    return https.createServer(resolved.options, app);
  }

  // ---------- Что сервер РЕАЛЬНО отдаёт клиенту ----------
  // Из PFX содержимое цепочки снаружи не видно, а в PEM легко положить лишнее — поэтому смотрим не в
  // файл, а на результат: поднимаем сертификат в настоящем TLS-сервере, подключаемся к нему и
  // разбираем то, что он предъявил. Так же проверяется и файл, который администратор только что
  // загрузил в панель, — ещё до того, как он станет действующим.
  function describeChain(peer) {
    const chain = [];
    let cert = peer;
    while (cert && cert.fingerprint256 && !chain.some((c) => c.fingerprint256 === cert.fingerprint256)) {
      chain.push(cert);
      cert = cert.issuerCertificate;
    }
    const leaf = chain[0] || {};
    const last = chain[chain.length - 1] || {};
    const selfSignedRoot = Boolean(last.subject && last.issuer && JSON.stringify(last.subject) === JSON.stringify(last.issuer));
    const validTo = leaf.valid_to ? new Date(leaf.valid_to) : null;
    return {
      subject: (leaf.subject && leaf.subject.CN) || null,
      san: leaf.subjectaltname || null,
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

  // Разбор произвольного сертификата (например, только что загруженного) без его установки.
  function inspectTlsOptions(options) {
    return new Promise((resolve, reject) => {
      let probe;
      try {
        probe = tls.createServer(options, (socket) => socket.end());
      } catch (err) { return reject(err); }
      const fail = (err) => { try { probe.close(); } catch { /* уже закрыт */ } reject(err); };
      probe.on('error', fail);
      probe.listen(0, '127.0.0.1', () => {
        const socket = tls.connect({ host: '127.0.0.1', port: probe.address().port, rejectUnauthorized: false }, () => {
          let info;
          try { info = describeChain(socket.getPeerCertificate(true)); } catch (err) { socket.destroy(); return fail(err); }
          socket.destroy();
          probe.close(() => resolve(info));
        });
        socket.on('error', fail);
      });
    });
  }

  // Последнее, что удалось узнать о действующем сертификате: панель показывает это, не трогая сеть.
  let currentCertificate = null;

  // Корневой сертификат, вшитый в сборку клиента. Если сервер подписан уже другим корнем, клиенты
  // перестанут ему доверять — а выяснится это только тогда, когда у людей перестанет открываться
  // приложение. Поэтому сравниваем сами и показываем в панели.
  function clientRootFingerprint() {
    const file = path.join(baseDir, '..', 'desktop-client', 'rosstat-root-ca.crt');
    try {
      return new crypto.X509Certificate(fs.readFileSync(file)).fingerprint256;
    } catch {
      return null; // на боевом сервере папки клиента может не быть — это не ошибка
    }
  }

  // Смысл проверки при старте — в двух вещах, каждая из которых иначе всплывает сильно позже и не
  // там, где причина:
  //   * имя в SAN должно дословно совпадать с адресом в desktop-client/config.js, иначе клиент
  //     отвергнет соединение по несовпадению имени;
  //   * если цепочка обрывается на сертификате, который сам себя не подписывал, значит промежуточных
  //     УЦ в ней не хватает. Браузеры на доменных машинах иногда дотягивают недостающее сами, а Node
  //     (то есть автообновление клиента) — никогда: в браузере всё выглядит исправно, а обновления
  //     молча не идут.
  async function reportTlsCertificate() {
    try {
      const resolved = resolveTlsOptions();
      if (!resolved) return;
      currentCertificate = await inspectTlsOptions(resolved.options);
      logServer('INFO', 'tls_certificate', {
        subject: currentCertificate.subject,
        san: currentCertificate.san,
        issuer: currentCertificate.issuer,
        valid_to: currentCertificate.validTo,
        days_left: currentCertificate.daysLeft,
        certificates: currentCertificate.certificates,
      });
      if (!currentCertificate.chainComplete) {
        logServer('WARN', 'tls_chain_incomplete', {
          certificates: currentCertificate.certificates,
          hint: 'Сервер не отдаёт полную цепочку до корневого УЦ. Для PFX — экспортируйте его вместе со всеми сертификатами пути; для PEM — cat server.crt chain.crt > fullchain.crt',
        });
      }
      const clientRoot = clientRootFingerprint();
      if (clientRoot && currentCertificate.rootFingerprint && clientRoot !== currentCertificate.rootFingerprint) {
        logServer('WARN', 'tls_root_differs_from_client', {
          server_root: currentCertificate.rootSubject,
          hint: 'Сервер подписан не тем корневым УЦ, который вшит в сборку клиента. Замените desktop-client/rosstat-root-ca.crt и пересоберите установщики, иначе клиенты перестанут доверять серверу',
        });
      }
      warnIfExpiring();
    } catch (err) {
      logServer('WARN', 'tls_check_failed', { error: String((err && err.message) || err) });
    }
  }

  // ---------- Замена сертификата со стороны: слежение за certs/ ----------
  // Сертификат в certs/ общий с платформой: загрузить новый можно и из её панели («Сертификаты»).
  // Своя загрузка (POST /api/admin/tls) применяет файл сразу, а о замене со стороны «Искра» раньше
  // не узнавала и до перезапуска отдавала клиентам прежний сертификат — «поменяли, а у сотрудников
  // старый», и искать это приходилось по журналам. Теперь, как и платформа, следим за каталогом и
  // применяем новый файл на лету. Уже открытые соединения доживают со старым сертификатом, новые
  // идут с новым.
  let appliedStoreHash = null; // что из хранилища сейчас стоит — тот же файл второй раз не применяем

  function storeHash() {
    if (!fs.existsSync(CERT_STORE_PFX)) return null;
    const h = crypto.createHash('sha256').update(fs.readFileSync(CERT_STORE_PFX));
    if (fs.existsSync(CERT_STORE_PASS)) h.update('\0').update(fs.readFileSync(CERT_STORE_PASS));
    return h.digest('hex');
  }

  async function reloadCertFromStore() {
    let hash;
    try { hash = storeHash(); } catch (err) {
      logServer('WARN', 'tls_reload_failed', { error: String((err && err.message) || err) });
      return;
    }
    // Файл убрали — прежний сертификат остаётся: перейти с https на http на ходу нельзя, да и незачем.
    if (!hash || hash === appliedStoreHash) return;

    if (!(server instanceof https.Server)) {
      appliedStoreHash = hash; // не повторять предупреждение на каждое событие каталога
      logServer('WARN', 'tls_restart_required', {
        hint: 'В certs/ появился сертификат, а сервер запущен по http — на https на ходу его не перевести. Перезапустите службу',
      });
      return;
    }

    const options = { pfx: fs.readFileSync(CERT_STORE_PFX) };
    if (fs.existsSync(CERT_STORE_PASS)) options.passphrase = fs.readFileSync(CERT_STORE_PASS, 'utf8');
    let info;
    try {
      info = await inspectTlsOptions(options);
      server.setSecureContext(options);
    } catch (err) {
      // Битый файл (неверный пароль, не PFX, запись ещё не закончена) не применяем: прежний сертификат
      // остаётся рабочим, сервис продолжает отвечать.
      logServer('ERROR', 'tls_reload_failed', {
        where: CERT_STORE_PFX,
        error: String((err && err.message) || err),
        hint: 'Новый файл в certs/ не читается — продолжаю с прежним сертификатом',
      });
      return;
    }
    appliedStoreHash = hash;
    tlsSource = 'store';
    currentCertificate = info;
    logServer('INFO', 'tls_certificate_reloaded', {
      subject: info.subject, san: info.san, valid_to: info.validTo, days_left: info.daysLeft,
    });
  }

  function watchCertStore() {
    try {
      ensureCertsDir();
      if (tlsSource === 'store') appliedStoreHash = storeHash();
    } catch (err) {
      logServer('WARN', 'tls_watch_failed', { error: String((err && err.message) || err) });
      return;
    }
    let timer = null;
    try {
      const watcher = fs.watch(certsDir, () => {
        // Каталог удалили или перенесли. На Windows слежение за исчезнувшим каталогом не падает, а
        // шлёт события без конца — десятки тысяч в секунду: процессор на 100% до перезапуска.
        if (!fs.existsSync(certsDir)) {
          try { watcher.close(); } catch { /* уже закрыт */ }
          clearTimeout(timer);
          logServer('WARN', 'tls_watch_stopped', {
            dir: certsDir,
            hint: 'Каталог certs/ исчез — слежение остановлено. Действующий сертификат работает; новый подхватится после перезапуска',
          });
          return;
        }
        // .pfx и .pass пишутся по очереди, и запись не атомарна — ждём, пока файлы улягутся.
        clearTimeout(timer);
        timer = setTimeout(() => { reloadCertFromStore(); }, 1000);
        if (timer.unref) timer.unref();
      });
      // Без обработчика 'error' сбой слежения (каталог удалили, диск отвалился) пришёл бы событием
      // и уронил весь сервер — а это мессенджер всей организации.
      watcher.on('error', (err) => logServer('WARN', 'tls_watch_failed', { error: String((err && err.message) || err) }));
    } catch (err) {
      logServer('WARN', 'tls_watch_failed', { error: String((err && err.message) || err) });
    }
  }

  // Сколько дней осталось — от даты окончания, заново при каждом вызове. daysLeft из разбора
  // сертификата считается один раз (при запуске или замене), и у службы, работающей без
  // перезапуска дольше месяца, он застывал: напоминание «за 30 дней» тогда не наступало вовсе.
  function daysLeftNow(cert) {
    const t = cert && cert.validTo ? Date.parse(cert.validTo) : NaN;
    return Number.isFinite(t) ? Math.floor((t - Date.now()) / 86400000) : null;
  }

  // Автопродления нет: сертификат перевыпускают руками, и единственный способ не проспать это —
  // напоминать заранее. Раз в сутки, начиная за 30 дней.
  function warnIfExpiring() {
    const left = daysLeftNow(currentCertificate);
    if (left === null || left > 30) return;
    logServer(left <= 0 ? 'ERROR' : 'WARN', 'tls_certificate_expiring', {
      subject: currentCertificate.subject,
      valid_to: currentCertificate.validTo,
      days_left: left,
      hint: 'Выпустите новый сертификат в удостоверяющем центре домена и загрузите его в панели, раздел "Сертификат"',
    });
  }
  setInterval(warnIfExpiring, 24 * 60 * 60 * 1000).unref();

  // Сервер «Искры»: https, если сертификат есть, иначе http. Запоминаем — замена сертификата на ходу
  // (панель, слежение за certs/) применяется к нему.
  function createServer(app) {
    server = createAppServer(app);
    return server;
  }

  function registerRoutes(app, { auth, requireCapability }) {
    // ---------- Сертификат сервера (раздел "Сертификат" в панели) ----------
    // Сертификат домена выдаётся на два года, корневой — на десять. Раз менять их всё равно придётся,
    // пусть это делается там же, где видно, что сейчас установлено, — а не правкой переменных
    // окружения на сервере по инструкции из README, которую в этот момент никто не найдёт.
    app.get('/api/admin/tls', auth, requireCapability('can_admin'), async (req, res) => {
      const clientRoot = clientRootFingerprint();
      const inStore = fs.existsSync(CERT_STORE_PFX);
      // Что лежит в хранилище — отдельно от того, что действует сейчас. Эти две вещи расходятся ровно
      // в одном случае: сертификат загрузили на сервер, работающий по http. Файл принят, но включится
      // он только с перезапуском — и об этом администратору надо сказать прямо, а не показать пустоту.
      let stored = null;
      if (inStore) {
        try {
          stored = await inspectTlsOptions(resolveTlsOptions().options);
        } catch (err) {
          stored = { error: String((err && err.message) || err) };
        }
      }
      // daysLeft — на сегодня, а не на момент разбора (см. daysLeftNow).
      const active = currentCertificate ? { ...currentCertificate, daysLeft: daysLeftNow(currentCertificate) } : null;
      res.json({
        enabled: server instanceof https.Server,
        source: tlsSource,                              // store | env-pfx | env-pem | null
        envAlsoSet: tlsSource === 'store' ? envTlsSource() : null, // "двойная настройка", см. envTlsSource
        storeHasCertificate: inStore,
        restartRequired: inStore && tlsSource !== 'store',
        requestSecure: Boolean(req.secure),             // сама панель сейчас открыта по https или нет
        certificate: active,
        stored,
        clientRootFingerprint: clientRoot,
        rootMatchesClient: clientRoot && active && active.rootFingerprint
          ? clientRoot === active.rootFingerprint
          : null,
      });
    });

    // Замена сертификата. Файл сначала разбирается (в том числе проверяется пароль и срок), и только
    // потом попадает на диск: испортить работающий сервер загрузкой не того файла нельзя.
    app.post('/api/admin/tls', auth, requireCapability('can_admin'), async (req, res) => {
      const { pfx, password } = req.body || {};
      if (!pfx || typeof pfx !== 'string') return res.status(400).json({ error: 'Файл не передан' });

      let buffer;
      try {
        buffer = Buffer.from(pfx, 'base64');
      } catch {
        return res.status(400).json({ error: 'Файл повреждён при передаче' });
      }
      if (!buffer.length) return res.status(400).json({ error: 'Файл пустой' });

      const options = { pfx: buffer };
      if (password) options.passphrase = String(password);

      let info;
      try {
        info = await inspectTlsOptions(options);
      } catch (err) {
        const raw = String((err && err.message) || err);
        logServer('WARN', 'tls_upload_rejected', { adminId: req.user.id, error: raw });
        // "mac verify failure" означает ровно одно — пароль не тот (или файл не PFX). Показывать
        // администратору эту фразу бессмысленно, он не обязан знать, что такое MAC.
        if (/mac verify failure/i.test(raw)) {
          return res.status(400).json({ error: password ? 'Неверный пароль к файлу' : 'Файл защищён паролем — укажите его' });
        }
        return res.status(400).json({ error: 'Это не похоже на PFX-файл с сертификатом и ключом' });
      }

      if (info.daysLeft !== null && info.daysLeft < 0) {
        return res.status(400).json({ error: `Срок действия этого сертификата истёк ${info.validTo}` });
      }

      // Загрузка закрытого ключа по незашифрованному каналу — ровно тот случай, когда его может
      // перехватить кто угодно в сети. Запретить нельзя (первую установку иначе и не сделать), но
      // и промолчать нельзя: пусть останется в журнале.
      if (!req.secure) {
        logServer('WARN', 'tls_upload_over_http', {
          adminId: req.user.id,
          ip: req.ip,
          hint: 'Закрытый ключ передан по незашифрованному каналу. Если сеть недоверенная — перевыпустите сертификат',
        });
      }

      try {
        ensureCertsDir();
        // Один шаг назад на случай, если новый файл окажется не тем: старый не затирается насовсем.
        if (fs.existsSync(CERT_STORE_PFX)) fs.copyFileSync(CERT_STORE_PFX, CERT_STORE_PFX + '.bak');
        if (fs.existsSync(CERT_STORE_PASS)) fs.copyFileSync(CERT_STORE_PASS, CERT_STORE_PASS + '.bak');
        fs.writeFileSync(CERT_STORE_PFX, buffer, { mode: 0o600 });
        if (password) fs.writeFileSync(CERT_STORE_PASS, String(password), { mode: 0o600 });
        else if (fs.existsSync(CERT_STORE_PASS)) fs.unlinkSync(CERT_STORE_PASS);
      } catch (err) {
        logServer('ERROR', 'tls_store_write_failed', { error: String((err && err.message) || err) });
        return res.status(500).json({ error: 'Не удалось сохранить файл на диск сервера' });
      }

      // Уже работающему https-серверу сертификат можно заменить на ходу: новые соединения пойдут с
      // новым, уже открытые доживут со старым. Перезапуск нужен только при первой установке —
      // http-сервер превратить в https без него нельзя.
      let applied = false;
      if (server instanceof https.Server && typeof server.setSecureContext === 'function') {
        try {
          server.setSecureContext(options);
          applied = true;
          tlsSource = 'store';
          currentCertificate = info;
          appliedStoreHash = storeHash();
        } catch (err) {
          logServer('ERROR', 'tls_apply_failed', { error: String((err && err.message) || err) });
        }
      }

      logServer('INFO', 'tls_certificate_replaced', {
        adminId: req.user.id,
        subject: info.subject,
        san: info.san,
        issuer: info.issuer,
        valid_to: info.validTo,
        days_left: info.daysLeft,
        certificates: info.certificates,
        applied,
      });

      const clientRoot = clientRootFingerprint();
      res.json({
        ok: true,
        applied,                       // false — файл сохранён, но нужен перезапуск сервера
        certificate: info,
        rootMatchesClient: clientRoot && info.rootFingerprint ? clientRoot === info.rootFingerprint : null,
      });
    });

    // Убрать сертификат из хранилища. Работающий сервер при этом остаётся на https до перезапуска —
    // выключить шифрование на ходу нельзя, да и не нужно.
    app.delete('/api/admin/tls', auth, requireCapability('can_admin'), (req, res) => {
      try {
        for (const file of [CERT_STORE_PFX, CERT_STORE_PASS]) {
          if (fs.existsSync(file)) fs.unlinkSync(file);
        }
      } catch (err) {
        return res.status(500).json({ error: 'Не удалось удалить файл: ' + String((err && err.message) || err) });
      }
      // Удаление из хранилища НЕ означает "теперь без шифрования": если сертификат задан ещё и
      // переменной окружения, после перезапуска сервер возьмёт его оттуда — и со стороны это выглядит
      // так, будто удаление не сработало. Поэтому сразу считаем и возвращаем, что реально будет дальше.
      const next = resolveTlsOptions();
      logServer('WARN', 'tls_certificate_removed', { adminId: req.user.id, next_source: next ? next.source : null });
      res.json({ ok: true, nextSource: next ? next.source : null, nextWhere: next ? next.where : null });
    });

    // PFX больше стандартного лимита express.json() — ответ должен остаться JSON, иначе панель
    // покажет кусок HTML вместо понятной ошибки.
    app.use('/api/admin/tls', (err, req, res, next) => {
      if (err) return res.status(413).json({ error: 'Файл слишком большой для загрузки через панель' });
      next();
    });
  }

  return { createServer, registerRoutes, reportTlsCertificate, watchCertStore };
}

module.exports = { createTls };
