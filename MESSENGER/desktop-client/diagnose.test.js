// Проверка разбора причин, по которым клиент не достучался до сервера (diagnose.js).
//
// Тест поднимает НАСТОЯЩИЕ серверы — http, https с доверенным сертификатом, https с чужим
// корнем, с истёкшим сертификатом, с чужим именем — и смотрит, какой код вернёт разбор.
// Проверять это иначе (подсовывая ошибки-заглушки) бессмысленно: вся ценность модуля в том,
// какие коды ошибок реально приходят от Node, а их придумать нельзя, их можно только получить.
//
// Запуск:  node --test  (из папки desktop-client)

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { diagnoseServer } = require('./diagnose');

// ---------------------------------------------------------------------------
//  Сертификаты для стенда
//
//  Выписываются на месте, а не лежат в репозитории: закрытому ключу, пусть и одноразовому,
//  в репозитории не место, а истёкший сертификат приходится делать датами в прошлом — такой
//  файл через год всё равно пришлось бы перевыпускать.
// ---------------------------------------------------------------------------
// openssl — из PATH или из Git для Windows (там он есть почти всегда, а в PATH его нет): без этого
// на обычной рабочей машине вся TLS-часть тестов молча пропускалась.
function findOpenssl() {
  for (const bin of ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe']) {
    try { execFileSync(bin, ['version'], { stdio: 'pipe' }); return bin; } catch { /* следующий */ }
  }
  return 'openssl';
}

let PKI = null;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iskra-diag-'));
  const OPENSSL = findOpenssl();
  const ssl = (...args) => execFileSync(OPENSSL, args, { cwd: dir, stdio: 'pipe' });
  const f = (name) => path.join(dir, name);

  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem',
      '-days', '2', '-subj', '/CN=Испытательный УЦ');

  // Обычный сертификат на localhost, выписанный этим УЦ.
  const leaf = (out, cn, san, extra = []) => {
    ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${out}.key`, '-out', `${out}.csr`, '-subj', `/CN=${cn}`);
    fs.writeFileSync(f(`${out}.ext`), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`);
    ssl('x509', '-req', '-in', `${out}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
        '-out', `${out}.pem`, '-extfile', `${out}.ext`, ...extra);
  };
  leaf('srv', 'localhost', 'DNS:localhost,IP:127.0.0.1', ['-days', '2']);
  leaf('other', 'чужое-имя.local', 'DNS:чужое-имя.local', ['-days', '2']);
  // Истёкший: notAfter — вчера. Ключи -not_before/-not_after есть с OpenSSL 3.2, а отрицательный
  // -days, наоборот, новые версии (3.5) не принимают; на машинах встречаются и 3.0, и 3.5 — пробуем
  // новый способ, при отказе — старый.
  const stamp = (d) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  try {
    leaf('old', 'localhost', 'DNS:localhost,IP:127.0.0.1',
      ['-not_before', stamp(new Date(Date.now() - 3 * 86400000)), '-not_after', stamp(new Date(Date.now() - 86400000))]);
  } catch {
    leaf('old', 'localhost', 'DNS:localhost,IP:127.0.0.1', ['-days', '-1']);
  }

  const read = (n) => fs.readFileSync(f(n), 'utf8');
  PKI = {
    ca: read('ca.pem'),
    good: { key: read('srv.key'), cert: read('srv.pem') },
    other: { key: read('other.key'), cert: read('other.pem') },
    expired: { key: read('old.key'), cert: read('old.pem') },
  };
} catch (err) {
  console.log(`TLS-часть тестов пропущена: openssl недоступен (${err.message.split('\n')[0]})`);
}

// Список корней «глазами системы»: по умолчанию — только то, что знает сам Node.
const СИСТЕМНЫЕ = [...tls.rootCertificates];

const ОТВЕТ_ИСКРЫ = JSON.stringify({ ok: true, app: 'iskra', secure: true });

function поднять(server, t) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((r) => server.close(r)));
      resolve(server.address().port);
    });
  });
}

const httpСервер = (handler) => http.createServer(handler);
const httpsСервер = (pair, handler) => https.createServer({ key: pair.key, cert: pair.cert }, handler);
const отдаётИскру = (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(ОТВЕТ_ИСКРЫ); };

// Подмена доверия ровно та же, что в main.js: свой корень добавляется только тогда, когда
// вызывающий не задал ca сам. Именно на этой разнице держится вывод «нет в системе».
function сВшитымКорнем(pem, fn) {
  const original = tls.createSecureContext;
  tls.createSecureContext = (options = {}) => {
    if (!options.ca) options = { ...options, ca: [...tls.rootCertificates, pem] };
    return original(options);
  };
  return fn().finally(() => { tls.createSecureContext = original; });
}

// ---------------------------------------------------------------------------

test('сервер отвечает — код ok', async (t) => {
  const port = await поднять(httpСервер(отдаётИскру), t);
  const d = await diagnoseServer(`http://127.0.0.1:${port}`, СИСТЕМНЫЕ);
  assert.strictEqual(d.code, 'ok', JSON.stringify(d));
});

test('по адресу отвечает не «Искра»', async (t) => {
  const port = await поднять(httpСервер((req, res) => res.end('<html>панель маршрутизатора</html>')), t);
  const d = await diagnoseServer(`http://127.0.0.1:${port}`, СИСТЕМНЫЕ);
  assert.strictEqual(d.code, 'not-iskra', JSON.stringify(d));
});

test('сервер отвечает ошибкой — виден её код', async (t) => {
  const port = await поднять(httpСервер((req, res) => { res.statusCode = 503; res.end('busy'); }), t);
  const d = await diagnoseServer(`http://127.0.0.1:${port}`, СИСТЕМНЫЕ);
  assert.strictEqual(d.code, 'http-status');
  assert.strictEqual(d.status, 503);
});

test('порт закрыт — отказ в подключении, а не «недоступен»', async () => {
  // Занимаем порт и тут же освобождаем: так мы знаем номер, на котором точно никто не слушает.
  const свободный = await new Promise((r) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
  });
  const d = await diagnoseServer(`http://127.0.0.1:${свободный}`, СИСТЕМНЫЕ);
  assert.strictEqual(d.code, 'refused', JSON.stringify(d));
});

// Имя в зоне .invalid по стандарту не существует. Но DNS-прокси (например, у VPN-клиентов с режимом
// «поддельных адресов») отвечает адресом на любое имя — тогда проверять тут нечего, и это видно по
// тому, что имя «разрешилось».
// И ещё: разбор ждёт ответа 6 секунд; если DNS машины отвечает «нет такого имени» дольше, честный
// результат — «таймаут», и проверять код «dns» на такой машине тоже нечего.
test('имя не разрешается — dns', async (t) => {
  const started = Date.now();
  const answered = await require('node:dns').promises.lookup('такого-имени-точно-нет.invalid').then(() => true, () => false);
  if (answered) return t.skip('DNS этой машины отвечает адресом даже на несуществующее имя (DNS-прокси)');
  if (Date.now() - started > 5000) return t.skip(`DNS этой машины отвечает «нет имени» за ${Math.round((Date.now() - started) / 1000)} с — дольше, чем ждёт разбор`);
  const d = await diagnoseServer('http://такого-имени-точно-нет.invalid:3103', СИСТЕМНЫЕ);
  assert.strictEqual(d.code, 'dns', JSON.stringify(d));
});

test('адрес записан неверно', async () => {
  const d = await diagnoseServer('не адрес вовсе', СИСТЕМНЫЕ);
  assert.strictEqual(d.code, 'bad-url', JSON.stringify(d));
});

test('https на порт без TLS — видно, что перепутан протокол', { skip: !PKI }, async (t) => {
  const port = await поднять(httpСервер(отдаётИскру), t);
  const d = await diagnoseServer(`https://localhost:${port}`, СИСТЕМНЫЕ);
  assert.ok(['protocol', 'reset'].includes(d.code), `ожидался protocol/reset, получено ${JSON.stringify(d)}`);
});

test('сертификат доверен системой — ok', { skip: !PKI }, async (t) => {
  const port = await поднять(httpsСервер(PKI.good, отдаётИскру), t);
  const d = await diagnoseServer(`https://localhost:${port}`, [...СИСТЕМНЫЕ, PKI.ca]);
  assert.strictEqual(d.code, 'ok', JSON.stringify(d));
});

test('корня нет в системе, но он есть у приложения — ca-missing-in-system', { skip: !PKI }, async (t) => {
  const port = await поднять(httpsСервер(PKI.good, отдаётИскру), t);
  const d = await сВшитымКорнем(PKI.ca, () => diagnoseServer(`https://localhost:${port}`, СИСТЕМНЫЕ));
  assert.strictEqual(d.code, 'ca-missing-in-system', JSON.stringify(d));
});

test('корня нет нигде — cert-untrusted, а не «нет в системе»', { skip: !PKI }, async (t) => {
  const port = await поднять(httpsСервер(PKI.good, отдаётИскру), t);
  const d = await diagnoseServer(`https://localhost:${port}`, СИСТЕМНЫЕ);
  assert.strictEqual(d.code, 'cert-untrusted', JSON.stringify(d));
});

test('сертификат просрочен', { skip: !PKI }, async (t) => {
  const port = await поднять(httpsСервер(PKI.expired, отдаётИскру), t);
  const d = await diagnoseServer(`https://localhost:${port}`, [...СИСТЕМНЫЕ, PKI.ca]);
  assert.strictEqual(d.code, 'cert-expired', JSON.stringify(d));
});

test('сертификат выписан на другое имя', { skip: !PKI }, async (t) => {
  const port = await поднять(httpsСервер(PKI.other, отдаётИскру), t);
  const d = await diagnoseServer(`https://localhost:${port}`, [...СИСТЕМНЫЕ, PKI.ca]);
  assert.strictEqual(d.code, 'cert-name', JSON.stringify(d));
});
