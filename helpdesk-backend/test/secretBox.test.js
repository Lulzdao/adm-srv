'use strict';

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { freshDb } = require("./helpers/tempDb");
const { startApp, makeLocalUser, client } = require("./helpers/httpApp");
const { startFakeSmtp } = require("./helpers/fakeSmtp");

// ============================================================================
//  Пароли почты в базе — зашифрованы (services/secretBox.js)
//
//  Главное: в файле базы (а значит, и в её копиях на шаре) пароля открытым
//  текстом нет, а отправка с ним работает. Ключ — вне базы. Пароли выдуманы.
// ============================================================================

const BOX_PASS = "пароль-приложения-ящика-отдела";
const SMTP_PASS = "пароль-почты-оповещений";

/** Всё содержимое файла базы (с журналом WAL) — как его увидел бы тот, кто унёс копию. */
function rawDbText(db, file) {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return fs.readFileSync(file).toString("latin1") + (fs.existsSync(file + "-wal") ? fs.readFileSync(file + "-wal").toString("latin1") : "");
}
const bytesOf = (s) => Buffer.from(s, "utf8").toString("latin1");

test("seal/open: шифрует со случайным IV, пустое остаётся пустым, чужой ключ — null", (t) => {
  const { cleanup } = freshDb();
  t.after(cleanup);
  const box = require("../services/secretBox");
  const a = box.seal("секрет");
  assert.ok(a.startsWith("enc:v1:"));
  assert.notStrictEqual(box.seal("секрет"), a, "IV случайный — одинаковые пароли не видны как одинаковые");
  assert.strictEqual(box.open(a), "секрет");
  assert.strictEqual(box.seal(""), "");
  assert.strictEqual(box.open("старый-открытый"), "старый-открытый", "не зашифрованное читается как есть");
  assert.ok(fs.existsSync(box.keyFile()), "ключ создан рядом с базой");
  assert.match(fs.readFileSync(box.keyFile(), "utf8"), /^[0-9a-f]{64}\n$/);

  // База переехала на другой сервер без secret.key — пароль не расшифровать, но и не упасть.
  fs.writeFileSync(box.keyFile(), "0".repeat(64));
  box.reset();
  assert.strictEqual(box.open(a), null);
});

test("SECRET_KEY из .env важнее файла; кривой ключ — понятная ошибка", (t) => {
  const { cleanup } = freshDb();
  t.after(() => { delete process.env.SECRET_KEY; cleanup(); });
  process.env.SECRET_KEY = "ab".repeat(32);
  const box = require("../services/secretBox");
  box.reset();
  assert.strictEqual(box.open(box.seal("x")), "x");
  assert.deepStrictEqual(box.keyInfo(), { source: "env", file: null });
  assert.ok(!fs.existsSync(box.keyFile()), "при ключе в .env файл не создаётся");
  process.env.SECRET_KEY = "короткий";
  box.reset();
  assert.throws(() => box.seal("x"), /SECRET_KEY/);
});

test("пароли ящика и SMTP в файле базы — только зашифрованными, отправка работает", async (t) => {
  const smtp = await startFakeSmtp({ auth: { user: "otdel@example.invalid", pass: BOX_PASS } });
  const { db, cleanup } = freshDb();
  await makeLocalUser(db, { login: "adm1", name: "Стендов Стенд", isAdmin: true });
  const app = await startApp(db);
  t.after(async () => { await app.close(); await smtp.close(); cleanup(); });
  const Adm = client(app.url); await Adm.login("adm1");

  await Adm.put("/api/mailings/settings", { host: "127.0.0.1", port: smtp.port, secure: false, delayMs: 0 });
  const id = (await Adm.post("/api/mailings/settings/mailboxes", { address: "otdel@example.invalid", password: BOX_PASS })).json.id;
  assert.deepStrictEqual((await Adm.post(`/api/mailings/settings/mailboxes/${id}/verify`, {})).json, { ok: true },
    "расшифрованный пароль принят почтовым сервером");
  assert.strictEqual((await Adm.get("/api/mailings/settings")).json.allMailboxes[0].has_password, true);

  // Пароль SMTP оповещений — через настройки оповещений.
  const r = await Adm.put("/api/notifications/smtp", { host: "127.0.0.1", port: smtp.port, secure: false, user: "otdel@example.invalid", password: SMTP_PASS, from: "otdel@example.invalid" });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(require("../services/mailer").readSettings(db).password, SMTP_PASS, "платформа читает его расшифрованным");

  const raw = rawDbText(db, process.env.DB_PATH);
  assert.ok(!raw.includes(bytesOf(BOX_PASS)), "пароль ящика не лежит в файле базы открытым текстом");
  assert.ok(!raw.includes(bytesOf(SMTP_PASS)), "пароль SMTP тоже");
  assert.match(db.prepare("SELECT password FROM mail_boxes WHERE id = ?").get(id).password, /^enc:v1:/);
});

test("миграция при запуске шифрует пароли, сохранённые до шифрования", (t) => {
  const { db, dir, cleanup } = freshDb();
  let again;
  // Сначала закрыть вторую базу: открытый файл Windows удалить не даст.
  t.after(() => { if (again) again.close(); cleanup(); });
  db.prepare("INSERT INTO mail_boxes (address, password, ad_group) VALUES ('stary@example.invalid', ?, '')").run(BOX_PASS);
  db.prepare("INSERT INTO mail_boxes (address, password, ad_group) VALUES ('bez-parolya@example.invalid', '', '')").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('smtp_password', ?)").run(SMTP_PASS);
  db.close();

  // Повторный запуск на той же базе — как рестарт службы после обновления.
  require("./helpers/tempDb").resetModuleCache();
  again = require("../db/init").initDb();
  const box = require("../services/secretBox");
  const rows = again.prepare("SELECT address, password FROM mail_boxes ORDER BY address").all();
  assert.strictEqual(rows[0].password, "", "пустой пароль остаётся пустым");
  assert.match(rows[1].password, /^enc:v1:/);
  assert.strictEqual(box.open(rows[1].password), BOX_PASS);
  const smtpRow = again.prepare("SELECT value FROM settings WHERE key = 'smtp_password'").get().value;
  assert.strictEqual(box.open(smtpRow), SMTP_PASS);
  assert.ok(!rawDbText(again, path.join(dir, "test.db")).includes(bytesOf(BOX_PASS)), "старый открытый пароль из файла ушёл");
});

test("«Состояние»: ключ не подходит к паролям — тревога с подсказкой", async (t) => {
  const { db, cleanup } = freshDb();
  await makeLocalUser(db, { login: "adm1", name: "Стендов Стенд", isAdmin: true });
  const app = await startApp(db);
  t.after(async () => { await app.close(); cleanup(); });
  const Adm = client(app.url); await Adm.login("adm1");
  await Adm.post("/api/mailings/settings/mailboxes", { address: "otdel@example.invalid", password: BOX_PASS });
  const item = async () => (await Adm.get("/api/admin/health")).json.sections.find((s) => s.id === "mail").items.find((i) => i.label === "Ключ паролей почты");
  assert.strictEqual((await item()).level, "ok");

  // База «переехала» без своего secret.key: на месте другой ключ.
  const box = require("../services/secretBox");
  fs.writeFileSync(box.keyFile(), "1".repeat(64));
  box.reset();
  const bad = await item();
  assert.strictEqual(bad.level, "crit");
  assert.match(bad.text, /otdel@example\.invalid.*secret\.key/);
});
