'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { startServer, getStatus, request, login, ADMIN } = require('./helpers/server');
const { findOpenssl, makePfx } = require('./helpers/pki');

// ============================================================================
//  Сертификат, заменённый со стороны, — без перезапуска
//
//  certs/ у «Искры» общий с платформой: новый сертификат могут загрузить и из панели
//  платформы. Раньше «Искра» об этом не узнавала и до перезапуска отдавала клиентам
//  старый. Теперь она следит за каталогом: годный файл применяется на лету, битый — нет
//  (сервис продолжает работать с прежним), по http на https на ходу не переходит.
// ============================================================================

// Сервер в тесте — с самоподписанным сертификатом; проверку доверия выключаем только здесь.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const OPENSSL = findOpenssl();
const skip = OPENSSL ? false : 'нет openssl — сертификаты для теста выпустить нечем';
let pkiDir, A, B, C;
before(() => {
  if (!OPENSSL) return;
  pkiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iskra-pki-'));
  A = makePfx(OPENSSL, pkiDir, 'a', 'pass-a');
  B = makePfx(OPENSSL, pkiDir, 'b', 'pass-b');
  C = makePfx(OPENSSL, pkiDir, 'c', 'pass-c');
});
after(() => { if (pkiDir) fs.rmSync(pkiDir, { recursive: true, force: true }); });

/** Какой сертификат сервер отдаёт новому соединению прямо сейчас. */
function servedFingerprint(url) {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port: Number(port), servername: 'localhost', rejectUnauthorized: false }, () => {
      const fp = s.getPeerCertificate().fingerprint256;
      s.end();
      resolve(fp);
    });
    s.on('error', reject);
  });
}

async function waitFor(check, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function putStore(dir, cert) {
  // Как пишет панель платформы: сначала .pfx, потом .pass.
  fs.writeFileSync(path.join(dir, 'certs', 'server.pfx'), cert.pfx);
  fs.writeFileSync(path.join(dir, 'certs', 'server.pass'), cert.password);
}

test('сертификат, заменённый в certs/ со стороны, применяется без перезапуска', { skip }, async (t) => {
  const srv = await startServer({ files: { 'certs/server.pfx': A.pfx, 'certs/server.pass': A.password } });
  t.after(() => srv.stop());
  assert.equal(await servedFingerprint(srv.url), A.fingerprint, 'на старте — сертификат A');

  putStore(srv.dir, B);
  assert.ok(await waitFor(async () => (await servedFingerprint(srv.url)) === B.fingerprint),
    'новый сертификат должен подхватиться сам, без перезапуска');
  assert.equal(await getStatus(`${srv.url}/api/ping`), 200, 'сервер при этом работает');
});

test('битый файл в certs/ не применяется — работает прежний сертификат', { skip }, async (t) => {
  const srv = await startServer({ files: { 'certs/server.pfx': A.pfx, 'certs/server.pass': A.password } });
  t.after(() => srv.stop());

  fs.writeFileSync(path.join(srv.dir, 'certs', 'server.pfx'), 'это не сертификат');
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(await servedFingerprint(srv.url), A.fingerprint, 'прежний сертификат остаётся');
  assert.equal(await getStatus(`${srv.url}/api/ping`), 200, 'сервер не упал');

  // Неверный пароль — тоже битый файл.
  fs.writeFileSync(path.join(srv.dir, 'certs', 'server.pfx'), B.pfx);
  fs.writeFileSync(path.join(srv.dir, 'certs', 'server.pass'), 'не тот пароль');
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(await servedFingerprint(srv.url), A.fingerprint);

  // Поправили пароль — применился.
  fs.writeFileSync(path.join(srv.dir, 'certs', 'server.pass'), B.password);
  assert.ok(await waitFor(async () => (await servedFingerprint(srv.url)) === B.fingerprint));
});

test('своя загрузка через панель по-прежнему применяется сразу', { skip }, async (t) => {
  const srv = await startServer({ files: { 'certs/server.pfx': A.pfx, 'certs/server.pass': A.password } });
  t.after(() => srv.stop());
  const admin = await login(srv.url, ADMIN.username, ADMIN.password);
  const r = await request(srv.url, 'POST', '/api/admin/tls', {
    token: admin.token, body: { pfx: C.pfx.toString('base64'), password: C.password },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.applied, true);
  assert.equal(await servedFingerprint(srv.url), C.fingerprint, 'без ожидания слежения');
});

test('сервер по http: появившийся сертификат не ломает работу, в журнале — «нужен перезапуск»', { skip }, async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  fs.mkdirSync(path.join(srv.dir, 'certs'), { recursive: true });
  putStore(srv.dir, A);
  const logDir = path.join(srv.dir, 'logs');
  const logged = await waitFor(() => fs.readdirSync(logDir, { recursive: true })
    .filter((f) => f.endsWith('.log'))
    .some((f) => fs.readFileSync(path.join(logDir, f), 'utf8').includes('tls_restart_required')));
  assert.ok(logged, 'в журнале сервера должно быть предупреждение tls_restart_required');
  assert.equal(await getStatus(`${srv.url}/api/ping`), 200, 'по http продолжает работать');
});
