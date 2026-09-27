'use strict';

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");

const { freshDb, tempDir } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");
const { findOpenssl, makePki, PFX_PASSWORD } = require("./helpers/testPki");

// ============================================================================
//  Раздел «Сертификаты» по HTTP
//
//  Сертификат сервера один на платформу и «Искру» и лежит в общем хранилище —
//  поэтому ошибка здесь стоит обеим службам сразу. Проверяется: загружается только
//  годный PFX (пароль, SAN, срок), прежний файл сохраняется как .bak, пароль
//  кладётся рядом; доверенные корни — белый список имён и защита пути; показ
//  сертификатов модулей. Раздел только для администратора.
//
//  Хранилище и каталог корней — во временной папке теста (SHARED_CERT_DIR,
//  TRUSTED_CA_DIR): по умолчанию это ../MESSENGER/certs, настоящая папка.
// ============================================================================

const OPENSSL = findOpenssl();
const skip = OPENSSL ? false : "нет openssl — сертификаты для теста выпустить нечем";

let pki;
let pkiDir;
function certs() {
  if (!pki) {
    pkiDir = tempDir("adm-srv-pki-");
    pki = makePki(OPENSSL, pkiDir);
  }
  return pki;
}
// Одноразовые ключи не должны переживать тест.
test.after(() => { if (pkiDir) fs.rmSync(pkiDir, { recursive: true, force: true }); });

async function stand(t, extraEnv = {}) {
  const dir = tempDir("adm-srv-certs-");
  const env = {
    SHARED_CERT_DIR: path.join(dir, "store"),
    TRUSTED_CA_DIR: path.join(dir, "trusted"),
    TLS_PFX: "", TLS_CERT: "", TLS_KEY: "",
    ...extraEnv,
  };
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }

  const { db, cleanup } = freshDb();
  const app = await startApp(db);
  t.after(async () => {
    await app.close();
    cleanup();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Страховка: запись идёт только во временную папку, а не в рабочее хранилище.
  const { SHARED_PFX, TRUSTED_DIR } = require("../services/tls");
  assert.ok(SHARED_PFX.startsWith(dir) && TRUSTED_DIR.startsWith(dir), `хранилище не во временной папке: ${SHARED_PFX}`);

  await makeLocalUser(db, { login: "!админ", name: "Админ Тестовый", role: "it", isAdmin: true });
  await makeLocalUser(db, { login: "!итшник", name: "Исполнитель Тестовый", role: "it" });
  const админ = client(app.url);
  await админ.login("!админ");
  return { app, админ, store: env.SHARED_CERT_DIR, trusted: env.TRUSTED_CA_DIR };
}

const загрузить = (кто, buf, password) =>
  кто.post("/api/certificates/server", { pfx: buf.toString("base64"), password });

test("раздел «Сертификаты» — только администратору", { skip }, async (t) => {
  const { app } = await stand(t);
  const итшник = client(app.url);
  await итшник.login("!итшник");
  for (const [метод, адрес, тело] of [
    ["get", "/api/certificates/server"], ["post", "/api/certificates/server", { pfx: "AA==" }],
    ["get", "/api/certificates/trusted"], ["post", "/api/certificates/trusted", {}],
    ["delete", "/api/certificates/trusted/x.crt"], ["get", "/api/certificates/modules"],
  ]) {
    assert.strictEqual((await итшник[метод](адрес, тело)).status, 403, `${метод} ${адрес}`);
  }
});

test("годный PFX ложится в общее хранилище, пароль — рядом, прежний — в .bak", { skip }, async (t) => {
  const { админ, store } = await stand(t);
  let r = await загрузить(админ, certs().pfx, PFX_PASSWORD);
  assert.strictEqual(r.status, 201, r.text);
  assert.deepStrictEqual(r.json.certificate.names.sort(), ["localhost", "srv.test.local"]);
  assert.strictEqual(r.json.restartRequired, true, "платформа шла по HTTP — на ходу в HTTPS не переключить");
  assert.ok(fs.readFileSync(path.join(store, "server.pfx")).equals(certs().pfx));
  assert.strictEqual(fs.readFileSync(path.join(store, "server.pass"), "utf8"), PFX_PASSWORD, "пароль как есть, без перевода строки");

  r = await загрузить(админ, certs().pfxOpen, "");
  assert.strictEqual(r.status, 201, r.text);
  assert.ok(fs.readFileSync(path.join(store, "server.pfx.bak")).equals(certs().pfx), "прежний файл сохраняется");
  assert.strictEqual(fs.existsSync(path.join(store, "server.pass")), false, "файл без пароля — старый пароль убирается");

  const info = await админ.get("/api/certificates/server");
  assert.strictEqual(info.json.sharedStore, path.join(store, "server.pfx"));
});

test("негодный файл отвергается с понятной причиной и ничего не пишет", { skip }, async (t) => {
  const { админ, store } = await stand(t);
  const случаи = [
    [certs().pfx, "не тот пароль", /Неверный пароль/],
    [certs().pfx, "", /защищён паролем/],
    [Buffer.from("это не сертификат"), "", /не похоже на PFX/],
    [certs().pfxNoSan, "", /нет имён \(SAN\)/],
    [certs().pfxExpired, "", /истёк/],
  ];
  for (const [buf, pass, ошибка] of случаи) {
    const r = await загрузить(админ, buf, pass);
    assert.strictEqual(r.status, 400, r.text);
    assert.match(r.json.error, ошибка);
  }
  assert.strictEqual((await админ.post("/api/certificates/server", {})).status, 400);
  assert.strictEqual(fs.existsSync(path.join(store, "server.pfx")), false, "в хранилище не должно попасть то, что сервер не поднимет");
});

test("доверенные корни: добавить, увидеть, удалить; промежуточный — с предупреждением", { skip }, async (t) => {
  const { админ, trusted } = await stand(t);
  let r = await админ.post("/api/certificates/trusted", { name: "test-root.crt", pem: certs().ca });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.json.root.warning, undefined);
  assert.ok(fs.existsSync(path.join(trusted, "test-root.crt")));

  r = await админ.post("/api/certificates/trusted", { name: "inter.pem", pem: certs().inter });
  assert.strictEqual(r.status, 201, r.text);
  assert.match(r.json.root.warning, /промежуточный/);

  const список = (await админ.get("/api/certificates/trusted")).json.roots;
  assert.strictEqual(список.length, 2);

  assert.strictEqual((await админ.delete("/api/certificates/trusted/test-root.crt")).status, 200);
  assert.strictEqual((await админ.delete("/api/certificates/trusted/test-root.crt")).status, 404);
});

test("имя корня — из белого списка: ни выхода из каталога, ни чужих расширений", { skip }, async (t) => {
  const { админ, store } = await stand(t);
  await загрузить(админ, certs().pfxOpen, "");
  for (const name of ["../server.pfx", "..\\server.pfx", "root.exe", "root", ""]) {
    const r = await админ.post("/api/certificates/trusted", { name, pem: certs().ca });
    assert.strictEqual(r.status, 400, `имя «${name}» должно отвергаться`);
  }
  assert.strictEqual((await админ.post("/api/certificates/trusted", { name: "x.crt", pem: "не PEM" })).status, 400);
  assert.strictEqual((await админ.post("/api/certificates/trusted", { name: "x.crt", pem: "-----BEGIN CERTIFICATE-----\nмусор\n-----END CERTIFICATE-----" })).status, 400);

  const удалить = await админ.delete(`/api/certificates/trusted/${encodeURIComponent("..")}%2Fserver.pfx`);
  assert.notStrictEqual(удалить.status, 200);
  assert.ok(fs.existsSync(path.join(store, "server.pfx")), "сертификат сервера не должен удаляться через раздел корней");
});

test("показ сертификатов модулей: HTTP-модули — без TLS, HTTPS — с цепочкой и оценкой доверия", { skip }, async (t) => {
  // Поддельная «Искра» по HTTPS с самоподписанным сертификатом.
  const iskra = https.createServer({ key: certs().serverKey, cert: certs().serverCert }, (req, res) => res.end("ok"));
  await new Promise((r) => iskra.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => iskra.close(r)));

  const { админ } = await stand(t, { MODULE_MESSENGER_URL: `https://localhost:${iskra.address().port}` });
  const mods = (await админ.get("/api/certificates/modules")).json.modules;
  const byId = Object.fromEntries(mods.map((m) => [m.id, m]));
  assert.strictEqual(byId.certs.secure, false);
  assert.strictEqual(byId.smdr.secure, false);
  assert.strictEqual(byId.messenger.secure, true, JSON.stringify(byId.messenger));
  assert.strictEqual(byId.messenger.authorized, false, "самоподписанный — показать можно, доверять нельзя");
  assert.ok(byId.messenger.authorizationError);
  assert.ok(byId.messenger.certificate, "цепочку видно даже у недоверенного сертификата — ради этого экран и нужен");
});
