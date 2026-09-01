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
let PKI = null;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iskra-diag-'));
  const ssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
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
  // Отрицательный срок: notAfter получается вчерашним. Ключи -not_before/-not_after подошли бы
  // лучше, но появились только в OpenSSL 3.2, а на машинах сборки встречается и 3.0.
  leaf('old', 'localhost', 'DNS:localhost,IP:127.0.0.1', ['-days', '-1']);

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

test('имя не разрешается — dns', async () => {
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
