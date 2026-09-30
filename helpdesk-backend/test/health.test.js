'use strict';

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");

const { freshDb, tempDir } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");
const { findOpenssl, makePki } = require("./helpers/testPki");

// ============================================================================
//  «Администрирование → Состояние»: сводка по службам, копиям, дискам,
//  сертификату, планировщику и почте — и оповещение о неудачной копии.
//
//  Модули изображают местные серверы: живой, незапущенный (порт закрыт) и
//  живой с сертификатом, которому платформа не доверяет. Данные выдуманы.
// ============================================================================

function withEnv(t, env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const close = (server) => new Promise((r) => server.close(() => r()));

/** Порт, на котором точно никто не слушает. */
async function closedPort() {
  const s = http.createServer();
  const port = await listen(s);
  await close(s);
  return port;
}

const find = (h, section, label) => {
  const s = h.sections.find((x) => x.id === section);
  return s && s.items.find((i) => i.label === label);
};

async function stand(t, env = {}) {
  const dir = tempDir("adm-srv-health-");
  withEnv(t, { BACKUP_DIR: path.join(dir, "backups"), ...env });
  const { db, cleanup } = freshDb();
  await makeLocalUser(db, { login: "adm1", name: "Стендов Стенд", isAdmin: true });
  await makeLocalUser(db, { login: "u1", name: "Макетов Макет" });
  const app = await startApp(db);
  t.after(async () => { await app.close(); cleanup(); fs.rmSync(dir, { recursive: true, force: true }); });
  const Adm = client(app.url); await Adm.login("adm1");
  return { db, app, dir, Adm };
}

test("состояние видит только администратор", async (t) => {
  const { app, Adm } = await stand(t);
  const U = client(app.url); await U.login("u1");
  assert.strictEqual((await U.get("/api/admin/health")).status, 403);
  const r = await Adm.get("/api/admin/health");
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.json.sections.map((s) => s.id), ["services", "backup", "disks", "cert", "jobs", "mail", "db", "version"]);
});

test("службы: живая, незапущенная и с недоверенным сертификатом различаются", async (t) => {
  const openssl = findOpenssl();
  if (!openssl) return t.skip("нет openssl");
  const pkiDir = tempDir("adm-srv-health-pki-");
  const pki = makePki(openssl, pkiDir);

  const alive = http.createServer((req, res) => { res.writeHead(302, { Location: "/login" }); res.end(); });
  const alivePort = await listen(alive);
  const tlsSrv = https.createServer({ key: pki.serverKey, cert: pki.serverCert }, (req, res) => res.end("ok"));
  const tlsPort = await listen(tlsSrv);
  t.after(async () => { await close(alive); await close(tlsSrv); fs.rmSync(pkiDir, { recursive: true, force: true }); });

  const { Adm } = await stand(t, {
    MODULE_CERTS_URL: `http://127.0.0.1:${alivePort}`,
    MODULE_SMDR_URL: `http://127.0.0.1:${await closedPort()}`,
    MODULE_MESSENGER_URL: `https://localhost:${tlsPort}`,
  });
  const h = (await Adm.get("/api/admin/health")).json;
  assert.strictEqual(find(h, "services", "Платформа").level, "ok");
  const certs = find(h, "services", "Сертвивер");
  assert.strictEqual(certs.level, "ok", "ответ-перенаправление на вход — значит, служба жива");
  const smdr = find(h, "services", "Журнал звонков");
  assert.strictEqual(smdr.level, "crit");
  assert.match(smdr.text, /не запущен/);
  const iskra = find(h, "services", "Искра");
  assert.strictEqual(iskra.level, "warn", iskra.text);
  assert.match(iskra.text, /не доверяет его сертификату/);
  assert.ok(h.crit >= 1, "итог считает критичные");
});

test("копии: неудачная последняя попытка — красным, старая копия — предупреждение", async (t) => {
  const { db, dir, Adm } = await stand(t);
  const backups = path.join(dir, "backups");
  fs.mkdirSync(backups, { recursive: true });
  const old = path.join(backups, "helpdesk-2026-07.db");
  fs.writeFileSync(old, "копия");
  const twoMonths = new Date(Date.now() - 60 * 24 * 3600 * 1000);
  fs.utimesSync(old, twoMonths, twoMonths);

  let h = (await Adm.get("/api/admin/health")).json;
  const last = find(h, "backup", "Последняя копия");
  assert.strictEqual(last.level, "warn");
  assert.match(last.text, /старше 40 дней/);
  assert.match(find(h, "backup", "Где лежат копии").text, /на том же диске/, "временная папка — на диске с базами");

  const { setSetting } = require("../services/settings");
  setSetting(db, "notif_last:backup", JSON.stringify({ at: "2026-09-01T09:00:00.000Z", ok: false, error: "папка недоступна" }));
  h = (await Adm.get("/api/admin/health")).json;
  assert.strictEqual(find(h, "backup", "Последняя копия").level, "crit");
  assert.match(find(h, "backup", "Последняя копия").text, /папка недоступна/);
});

test("диск, сертификат, почта и базы — в сводке", async (t) => {
  const { Adm, dir } = await stand(t);
  withEnv(t, { BACKUP_DATABASES: `helpdesk=${process.env.DB_PATH};smdr=${path.join(dir, "нет-такой.db")}` });
  const h = (await Adm.get("/api/admin/health")).json;
  assert.match(find(h, "disks", "Диск с платформой и базами").text, /свободно [\d.]+ из [\d.]+ ГБ/);
  assert.strictEqual(find(h, "cert", "Сертификат").level, "warn", "без сертификата — предупреждение про http");
  assert.match(find(h, "mail", "Письма оповещений").text, /в очереди 0/);
  assert.strictEqual(find(h, "db", "Платформа").level, "ok");
  assert.strictEqual(find(h, "db", "Журнал звонков").text, "файл не найден");
});

test("копия не удалась три раза подряд — одно оповещение за месяц; удача сбрасывает счёт", async (t) => {
  const dir = tempDir("adm-srv-health-bk-");
  const notADir = path.join(dir, "это-файл");
  fs.writeFileSync(notADir, "не папка");
  withEnv(t, { BACKUP_DIR: notADir, BACKUP_DATABASES: undefined });
  const { db, cleanup } = freshDb();
  t.after(() => { cleanup(); fs.rmSync(dir, { recursive: true, force: true }); });
  withEnv(t, { BACKUP_DATABASES: `helpdesk=${process.env.DB_PATH}` });
  const backup = require("../services/backup");
  const events = () => db.prepare("SELECT kind, payload FROM notification_events WHERE kind = 'backup_failed'").all();
  const now = new Date(2026, 9, 1, 10);

  for (let i = 1; i <= 2; i++) await assert.rejects(backup.runWatched(db, now));
  assert.strictEqual(events().length, 0, "одна-две неудачи — ещё не повод писать");
  await assert.rejects(backup.runWatched(db, now));
  assert.strictEqual(events().length, 1, "третья подряд — оповещение");
  const payload = JSON.parse(events()[0].payload);
  assert.strictEqual(payload.месяц, "2026-10");
  assert.strictEqual(payload.попыток, "3");
  assert.match(payload.ошибка, /недоступна/);
  await assert.rejects(backup.runWatched(db, now));
  assert.strictEqual(events().length, 1, "дальше в том же месяце — без повторов");

  process.env.BACKUP_DIR = path.join(dir, "backups");
  await backup.runWatched(db, now);
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key = 'backup_fail_streak'").get().value, "0");
});
