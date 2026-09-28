'use strict';

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// ============================================================================
//  Одноразовые сертификаты для тестов
//
//  Node выпускать сертификаты не умеет, поэтому их делает openssl — прямо во
//  временной папке теста. Закрытые ключи в репозиторий не попадают и живут до
//  конца теста. Нет openssl — тесты сертификатов пропускаются с пояснением
//  (на машинах с Git для Windows он лежит в C:\Program Files\Git\usr\bin).
//
//  Имена выдуманы (*.test.local), пароль — ASCII: openssl на Windows по-разному
//  кодирует кириллицу в пароле PKCS#12.
// ============================================================================

const PFX_PASSWORD = "test-pfx-pass-1";

function findOpenssl() {
  const candidates = ["openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe", "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe"];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["version"], { stdio: "pipe" });
      return bin;
    } catch { /* нет такого — пробуем следующий */ }
  }
  return null;
}

/**
 * Выпустить набор в папке dir. Возвращает пути и содержимое:
 *   ca        — самоподписанный корень (PEM);
 *   inter     — сертификат, подписанный корнем (не корень — для предупреждения);
 *   pfx       — сертификат сервера с SAN и ключом, под паролем PFX_PASSWORD;
 *   pfxOpen   — то же без пароля;
 *   pfxNoSan  — сертификат без SAN (только CN);
 *   pfxExpired — сертификат с SAN, срок которого истёк в 2021 году;
 *   serverKey, serverCert — PEM-пара сервера (для поддельного HTTPS-модуля).
 */
function makePki(openssl, dir) {
  const run = (...args) => execFileSync(openssl, args, { cwd: dir, stdio: "pipe" });
  const req = (name, cn, extra = []) =>
    run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.crt`,
      "-subj", `/CN=${cn}`, ...extra);
  const pfx = (name, out, pass) =>
    run("pkcs12", "-export", "-inkey", `${name}.key`, "-in", `${name}.crt`, "-out", out, "-passout", `pass:${pass}`);

  req("ca", "Test Root CA", ["-days", "3650"]);
  req("server", "srv.test.local", ["-days", "365", "-addext", "subjectAltName=DNS:srv.test.local,DNS:localhost"]);
  req("nosan", "nosan.test.local", ["-days", "365"]);
  req("expired", "old.test.local", ["-not_before", "20200101000000Z", "-not_after", "20210101000000Z",
    "-addext", "subjectAltName=DNS:old.test.local"]);

  run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "inter.key", "-out", "inter.csr", "-subj", "/CN=Test Intermediate");
  run("x509", "-req", "-in", "inter.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "inter.crt", "-days", "365");

  pfx("server", "server.pfx", PFX_PASSWORD);
  pfx("server", "server-open.pfx", "");
  pfx("nosan", "nosan.pfx", "");
  pfx("expired", "expired.pfx", "");

  const read = (f, enc) => fs.readFileSync(path.join(dir, f), enc);
  return {
    ca: read("ca.crt", "utf8"),
    inter: read("inter.crt", "utf8"),
    pfx: read("server.pfx"),
    pfxOpen: read("server-open.pfx"),
    pfxNoSan: read("nosan.pfx"),
    pfxExpired: read("expired.pfx"),
    serverKey: read("server.key", "utf8"),
    serverCert: read("server.crt", "utf8"),
  };
}

module.exports = { findOpenssl, makePki, PFX_PASSWORD };
