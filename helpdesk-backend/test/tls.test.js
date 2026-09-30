'use strict';

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// ============================================================================
//  Сертификаты сервера
//
//  Самый большой сервис проекта и до сих пор не покрытый ничем. Здесь
//  проверяется то, что можно проверить БЕЗ настоящего сертификата: откуда
//  берутся настройки TLS и как разбирается предъявленная цепочка.
//
//  Сознательно не генерируем сертификаты через openssl: тесты должны идти и на
//  боевом Windows Server, где его может не быть. Разбор цепочки проверяется на
//  собранных вручную объектах — ровно в том виде, в каком их отдаёт
//  socket.getPeerCertificate(true).
//
//  Все имена и отпечатки выдуманы.
// ============================================================================

function свежийTls() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes("/services/tls.js") || key.includes("/config/config.js")) delete require.cache[key];
  }
  return require("../services/tls");
}

function временныйКаталог() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "adm-srv-tls-"));
}

test("resolveTlsOptions: без переменных и без хранилища — TLS выключен", () => {
  const tls = свежийTls();
  const dir = временныйКаталог();
  assert.strictEqual(tls.resolveTlsOptions({ SHARED_CERT_DIR: dir }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Порядок — как у «Искры»: общее хранилище (его загружают из панели) важнее переменных. Раньше
// у платформы было наоборот, и забытая в .env TLS_PFX тихо перекрывала сертификат из панели.
test("resolveTlsOptions: общее хранилище важнее TLS_PFX — как у «Искры»", () => {
  const tls = свежийTls();
  const dir = временныйКаталог();
  const pfxИзПеременной = path.join(dir, "из-переменной.pfx");
  fs.writeFileSync(pfxИзПеременной, Buffer.from("выдуманное-содержимое-1"));
  fs.writeFileSync(path.join(dir, "server.pfx"), Buffer.from("выдуманное-содержимое-2"));

  const r = tls.resolveTlsOptions({ TLS_PFX: pfxИзПеременной, SHARED_CERT_DIR: dir });
  assert.strictEqual(r.source, "shared-store");
  assert.strictEqual(r.options.pfx.toString(), "выдуманное-содержимое-2");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveTlsOptions: без файла в хранилище работает запасной путь TLS_PFX", () => {
  const tls = свежийTls();
  const dir = временныйКаталог();
  const pfxИзПеременной = path.join(dir, "из-переменной.pfx");
  fs.writeFileSync(pfxИзПеременной, Buffer.from("выдуманное-содержимое-1"));

  const r = tls.resolveTlsOptions({ TLS_PFX: pfxИзПеременной, SHARED_CERT_DIR: dir });
  assert.strictEqual(r.source, "env-pfx");
  assert.strictEqual(r.where, pfxИзПеременной);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Дальше — на настоящих сертификатах (openssl; нет его — тесты пропускаются, как в certificateRoutes).
const { findOpenssl, makePki } = require("./helpers/testPki");
const OPENSSL = findOpenssl();
let pkiCache = null;
function pki() {
  if (!pkiCache) pkiCache = makePki(OPENSSL, временныйКаталог());
  return pkiCache;
}
function молча(t, ...names) {
  const saved = names.map((n) => [n, console[n]]);
  const out = [];
  for (const n of names) console[n] = (...a) => out.push(a.join(" "));
  t.after(() => { for (const [n, f] of saved) console[n] = f; });
  return out;
}

test("запуск: хранилище и TLS_PFX сразу — действует хранилище, лишняя переменная названа", { skip: !OPENSSL }, (t) => {
  const tls = свежийTls();
  const dir = временныйКаталог();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "server.pfx"), pki().pfxOpen);
  const old = path.join(dir, "старый.pfx");
  fs.writeFileSync(old, pki().pfxExpired);
  const said = молча(t, "log", "warn");

  const { secure } = tls.createAppServer(() => {}, { TLS_PFX: old, SHARED_CERT_DIR: dir });
  assert.strictEqual(secure, true);
  const state = tls.currentTlsState();
  assert.strictEqual(state.source, "shared-store");
  assert.strictEqual(state.shadowedEnv, "TLS_PFX");
  assert.ok(said.some((s) => /TLS_PFX тоже задана, но не используется/.test(s)), said.join(" | "));
});

test("стартовали с TLS_PFX, потом файл загрузили в хранилище — переход на него без перезапуска", { skip: !OPENSSL }, async (t) => {
  const tls = свежийTls();
  const dir = временныйКаталог();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fromEnv = path.join(dir, "из-переменной.pfx");
  fs.writeFileSync(fromEnv, pki().pfxOpen);
  const said = молча(t, "log", "warn", "error");

  // Хранилище по умолчанию указывает на каталог процесса — для перечитывания задаём его явно.
  const prev = process.env.SHARED_CERT_DIR;
  process.env.SHARED_CERT_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.SHARED_CERT_DIR; else process.env.SHARED_CERT_DIR = prev; });

  tls.createAppServer(() => {}, { TLS_PFX: fromEnv, SHARED_CERT_DIR: dir });
  assert.strictEqual(tls.currentTlsState().source, "env-pfx");

  fs.writeFileSync(path.join(dir, "server.pfx"), pki().pfxOpen);
  const r = await tls.reloadCertStore();
  assert.strictEqual(r.applied, true, JSON.stringify(r) + " " + said.join(" | "));
  assert.strictEqual(tls.currentTlsState().source, "shared-store");
});

// На Windows слежение за удалённым каталогом не падает, а шлёт события без конца (десятки тысяч в
// секунду) — процессор на 100% до перезапуска. Каталог исчез — слежение должно остановиться.
test("каталог хранилища удалили — слежение останавливается, а не крутится вхолостую", { skip: !OPENSSL }, async (t) => {
  const tls = свежийTls();
  const dir = временныйКаталог();
  fs.writeFileSync(path.join(dir, "server.pfx"), pki().pfxOpen);
  const said = молча(t, "log", "warn", "error");
  tls.createAppServer(() => {}, { SHARED_CERT_DIR: dir });
  await new Promise((r) => setTimeout(r, 200));

  fs.rmSync(dir, { recursive: true, force: true });
  // Счётчик событий снаружи не виден, поэтому меряем занятость цикла: при «вечных» событиях таймер
  // на 50 мс срабатывает с большим опозданием или цикл целиком занят обработкой.
  const started = Date.now();
  let ticks = 0;
  await new Promise((resolve) => {
    const iv = setInterval(() => { if (++ticks === 10) { clearInterval(iv); resolve(); } }, 50);
  });
  assert.ok(Date.now() - started < 2000, `цикл событий занят: 10 тиков по 50 мс заняли ${Date.now() - started} мс`);
  assert.ok(said.some((s) => /исчез — слежение за ним остановлено/.test(s)), said.join(" | "));
});

test("resolveTlsOptions: общее хранилище подхватывает пароль из соседнего файла", () => {
  const tls = свежийTls();
  const dir = временныйКаталог();
  fs.writeFileSync(path.join(dir, "server.pfx"), Buffer.from("выдуманный-pfx"));
  // Пробел на конце — тоже часть пароля, обрезать его нельзя.
  fs.writeFileSync(path.join(dir, "server.pass"), "секрет ", "utf8");

  const r = tls.resolveTlsOptions({ SHARED_CERT_DIR: dir });
  assert.strictEqual(r.source, "shared-store");
  assert.strictEqual(r.options.passphrase, "секрет ", "пробел в конце пароля обрезать нельзя");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveTlsOptions: пара PEM читается, когда заданы оба файла", () => {
  const tls = свежийTls();
  const dir = временныйКаталог();
  const cert = path.join(dir, "c.pem"); const key = path.join(dir, "k.pem");
  fs.writeFileSync(cert, "выдуманный-сертификат");
  fs.writeFileSync(key, "выдуманный-ключ");

  const r = tls.resolveTlsOptions({ TLS_CERT: cert, TLS_KEY: key, SHARED_CERT_DIR: dir });
  assert.strictEqual(r.source, "env-pem");
  assert.strictEqual(r.options.cert.toString(), "выдуманный-сертификат");
  assert.strictEqual(r.options.key.toString(), "выдуманный-ключ");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveTlsOptions: один только TLS_CERT без ключа не считается настройкой", () => {
  const tls = свежийTls();
  const dir = временныйКаталог();
  const cert = path.join(dir, "c.pem");
  fs.writeFileSync(cert, "выдуманный-сертификат");
  assert.strictEqual(tls.resolveTlsOptions({ TLS_CERT: cert, SHARED_CERT_DIR: dir }), null,
    "половина пары — это не настроенный TLS");
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- разбор предъявленной цепочки -------------------------------------------

/** Узел цепочки в том виде, в каком его отдаёт getPeerCertificate(true). */
function узел({ cn, issuerCn, fp, san, validTo, validFrom }) {
  return {
    subject: { CN: cn },
    issuer: { CN: issuerCn },
    fingerprint256: fp,
    subjectaltname: san,
    valid_from: validFrom || "Jan  1 00:00:00 2026 GMT",
    valid_to: validTo || "Jan  1 00:00:00 2027 GMT",
  };
}

test("describeChain: цепочка до самоподписанного корня считается полной", () => {
  const tls = свежийTls();
  const корень = узел({ cn: "Выдуманный УЦ", issuerCn: "Выдуманный УЦ", fp: "CC:CC" });
  корень.issuerCertificate = корень; // так это и приходит от Node — корень ссылается на себя
  const промежуточный = узел({ cn: "Выдуманный УЦ-2", issuerCn: "Выдуманный УЦ", fp: "BB:BB" });
  промежуточный.issuerCertificate = корень;
  const лист = узел({ cn: "сервер.пример.тест", issuerCn: "Выдуманный УЦ-2", fp: "AA:AA",
                     san: "DNS:сервер.пример.тест, DNS:псевдоним.пример.тест" });
  лист.issuerCertificate = промежуточный;

  const info = tls.describeChain(лист);
  assert.strictEqual(info.certificates, 3);
  assert.strictEqual(info.chainComplete, true, "самоподписанный последний узел — это полная цепочка");
  assert.strictEqual(info.subject, "сервер.пример.тест");
  assert.strictEqual(info.rootSubject, "Выдуманный УЦ");
  assert.deepStrictEqual(info.names, ["сервер.пример.тест", "псевдоним.пример.тест"]);
});

test("describeChain: без корня цепочка считается неполной", () => {
  const tls = свежийTls();
  const промежуточный = узел({ cn: "Выдуманный УЦ-2", issuerCn: "Выдуманный УЦ", fp: "BB:BB" });
  const лист = узел({ cn: "сервер.пример.тест", issuerCn: "Выдуманный УЦ-2", fp: "AA:AA" });
  лист.issuerCertificate = промежуточный;

  const info = tls.describeChain(лист);
  assert.strictEqual(info.certificates, 2);
  assert.strictEqual(info.chainComplete, false);
});

test("describeChain: зацикленная цепочка не вешает разбор", () => {
  const tls = свежийTls();
  // Node отдаёт самоподписанный сертификат ссылающимся на самого себя.
  // Наивный обход по issuerCertificate тут крутился бы вечно.
  const сам = узел({ cn: "сам-себе", issuerCn: "сам-себе", fp: "AA:AA" });
  сам.issuerCertificate = сам;
  const info = tls.describeChain(сам);
  assert.strictEqual(info.certificates, 1, "один и тот же сертификат не должен попасть в цепочку дважды");
  assert.strictEqual(info.chainComplete, true);
});

test("describeChain: срок считается в днях и не падает на пустом сертификате", () => {
  const tls = свежийTls();
  const через10дней = new Date(Date.now() + 10 * 86400000).toUTCString();
  const info = tls.describeChain(узел({ cn: "x", issuerCn: "y", fp: "AA", validTo: через10дней }));
  assert.ok(Math.abs(info.daysLeft - 10) <= 1, `ожидалось около 10 дней, получено ${info.daysLeft}`);

  const пусто = tls.describeChain({});
  assert.strictEqual(пусто.certificates, 0);
  assert.strictEqual(пусто.daysLeft, null);
  assert.deepStrictEqual(пусто.names, []);
});

test("dnsNames: берутся только DNS и IP, регистр приводится к нижнему", () => {
  const tls = свежийTls();
  assert.deepStrictEqual(
    tls.dnsNames({ subjectaltname: "DNS:Сервер.Пример.Тест, IP Address:10.0.0.1, email:кто@пример.тест" }),
    ["сервер.пример.тест", "10.0.0.1"]
  );
  assert.deepStrictEqual(tls.dnsNames({}), []);
  assert.deepStrictEqual(tls.dnsNames(null), []);
});

test("inspectTlsOptions: заведомо негодные настройки отвергаются, а не висят", async () => {
  const tls = свежийTls();
  const начало = Date.now();
  await assert.rejects(
    () => tls.inspectTlsOptions({ pfx: Buffer.from("это не сертификат"), passphrase: "нет" }),
    "мусор вместо сертификата обязан привести к ошибке"
  );
  assert.ok(Date.now() - начало < tls.INSPECT_TIMEOUT_MS,
    "ошибка должна прийти сразу, а не по истечении предела ожидания");
});
