'use strict';

// Одноразовые сертификаты для тестов — выпускает openssl во временной папке теста. Закрытые ключи в
// репозиторий не попадают. Нет openssl — тесты сертификата пропускаются (на машинах с Git для
// Windows он лежит в C:\Program Files\Git\usr\bin). Имена выдуманы, пароль — ASCII: openssl на
// Windows по-разному кодирует кириллицу в пароле PKCS#12.

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function findOpenssl() {
  for (const bin of ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe']) {
    try { execFileSync(bin, ['version'], { stdio: 'pipe' }); return bin; } catch { /* следующий */ }
  }
  return null;
}

/** Сертификат для localhost в PFX под паролем. Возвращает { pfx, password, fingerprint }. */
function makePfx(openssl, dir, name, password) {
  const run = (...args) => execFileSync(openssl, args, { cwd: dir, stdio: 'pipe' });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.crt`,
    '-days', '30', '-subj', `/CN=${name}.test.local`, '-addext', 'subjectAltName=DNS:localhost');
  run('pkcs12', '-export', '-inkey', `${name}.key`, '-in', `${name}.crt`, '-out', `${name}.pfx`, '-passout', `pass:${password}`);
  return {
    pfx: fs.readFileSync(path.join(dir, `${name}.pfx`)),
    password,
    fingerprint: new crypto.X509Certificate(fs.readFileSync(path.join(dir, `${name}.crt`))).fingerprint256,
  };
}

module.exports = { findOpenssl, makePfx };
