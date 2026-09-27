'use strict';

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { freshDb, tempDir } = require("./helpers/tempDb");

// ============================================================================
//  Ежемесячная резервная копия баз: один файл на базу и месяц
//
//  Главное — копия работающей базы: служба держит её открытой, свежие записи
//  лежат ещё в журнале WAL, а не в самом файле. Копирование файла их бы потеряло;
//  VACUUM INTO — нет. Данные выдуманы.
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

/** «Работающая» база журнала звонков: WAL, открытое соединение, записи не сброшены в файл. */
function liveDb(file, rows) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  db.exec("CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY, number TEXT)");
  const ins = db.prepare("INSERT INTO calls (number) VALUES (?)");
  for (let i = 0; i < rows; i++) ins.run(`8900000${String(i).padStart(4, "0")}`);
  return db;
}

const countIn = (file, table) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } finally { db.close(); }
};

function stand(t) {
  const dir = tempDir("adm-srv-backup-");
  const { db, cleanup } = freshDb();
  const smdrFile = path.join(dir, "smdr.db");
  const live = liveDb(smdrFile, 1000);
  // Сначала закрыть «работающую» базу: открытый файл Windows удалить не даст.
  t.after(() => {
    live.close();
    cleanup();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const backups = path.join(dir, "backups");
  withEnv(t, {
    BACKUP_DIR: backups,
    BACKUP_DATABASES: `helpdesk=${process.env.DB_PATH};smdr=${smdrFile};messenger=${path.join(dir, "нет-такой.db")}`,
  });
  return { db, dir, live, smdrFile, backups, backup: require("../services/backup") };
}

test("копия за месяц: по файлу на базу, свежие записи из WAL на месте, отсутствующая база — не ошибка", async (t) => {
  const { db, live, smdrFile, backups, backup } = stand(t);
  assert.ok(fs.existsSync(`${smdrFile}-wal`) && fs.statSync(`${smdrFile}-wal`).size > 0, "записи лежат ещё в журнале WAL");

  const detail = await backup.run(db, new Date(2026, 9, 5));
  assert.strictEqual(detail.месяц, "2026-10");
  assert.strictEqual(detail.скопировано, "helpdesk, smdr");
  assert.strictEqual(detail["нет файла"], "messenger", "базы нет на этой машине — пропуск, а не сбой");
  assert.deepStrictEqual(fs.readdirSync(backups).sort(), ["helpdesk-2026-10.db", "smdr-2026-10.db"]);
  assert.strictEqual(countIn(path.join(backups, "smdr-2026-10.db"), "calls"), 1000, "все звонки, включая ещё не сброшенные из WAL");
  assert.ok(countIn(path.join(backups, "helpdesk-2026-10.db"), "categories") > 0, "база платформы скопирована целиком");
  assert.ok(live, "служба продолжает работать с базой");
});

test("новый месяц — новый файл, старые копии остаются; повтор в том же месяце — заменяет", async (t) => {
  const { db, live, backups, backup } = stand(t);
  await backup.run(db, new Date(2026, 9, 5));

  live.prepare("INSERT INTO calls (number) VALUES ('новый звонок')").run();
  await backup.run(db, new Date(2026, 9, 20));
  assert.strictEqual(countIn(path.join(backups, "smdr-2026-10.db"), "calls"), 1001, "повтор в том же месяце обновил копию");

  await backup.run(db, new Date(2026, 10, 1));
  const files = fs.readdirSync(backups).sort();
  assert.deepStrictEqual(files, ["helpdesk-2026-10.db", "helpdesk-2026-11.db", "smdr-2026-10.db", "smdr-2026-11.db"]);
  assert.ok(!files.some((f) => f.endsWith(".tmp")), "недоделанных файлов не остаётся");
});

test("испорченная база — задание падает и называет её, остальные копируются", async (t) => {
  const { db, dir, backups, backup } = stand(t);
  const bad = path.join(dir, "битая.db");
  fs.writeFileSync(bad, "это не база данных, а мусор ".repeat(200));
  process.env.BACKUP_DATABASES += `;broken=${bad}`;

  await assert.rejects(() => backup.run(db, new Date(2026, 9, 5)), /broken/);
  assert.ok(fs.existsSync(path.join(backups, "smdr-2026-10.db")), "исправные базы скопированы");
  assert.ok(!fs.existsSync(path.join(backups, "broken-2026-10.db")), "от испорченной копии нет");
});

test("по умолчанию — все четыре базы; «Искра» — по общему хранилищу сертификатов", (t) => {
  withEnv(t, { BACKUP_DATABASES: undefined, SHARED_CERT_DIR: "C:\\ISKRA\\iskra-server\\certs" });
  const { cleanup } = freshDb();
  t.after(cleanup);
  const list = require("../services/backup").databases();
  assert.deepStrictEqual(Object.keys(list).sort(), ["certviewer", "helpdesk", "messenger", "smdr"]);
  assert.strictEqual(list.messenger, path.join("C:\\ISKRA\\iskra-server", "messenger.db"));
  assert.strictEqual(list.helpdesk, path.resolve(process.env.DB_PATH));
});

test("задание планировщика: раз в месяц, видно в панели, «проверить сейчас» работает", async (t) => {
  const { db, backups } = stand(t);
  const scheduler = require("../services/scheduler");
  const job = scheduler.JOBS.find((j) => j.id === "backup");
  assert.ok(job, "задание есть в списке");
  assert.strictEqual(job.period, "monthly");

  const r = await scheduler.runJob(db, job, { force: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(fs.readdirSync(backups).length >= 2);
  const s = scheduler.status(db).jobs.find((j) => j.id === "backup");
  assert.strictEqual(s.last.ok, true);
  assert.ok(s.ranWindow, "месяц отмечен выполненным");
});

// ============================================================================
//  Куда класть копии — из панели
// ============================================================================

test("папка для копий: панель важнее .env, .env важнее папки по умолчанию", (t) => {
  withEnv(t, { BACKUP_DIR: String.raw`C:\из-env\backups` });
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const backup = require("../services/backup");
  assert.deepStrictEqual(backup.backupDir(db), { dir: String.raw`C:\из-env\backups`, source: "env" });
  backup.setBackupDir(db, String.raw`\\сервер\копии\adm-srv`);
  assert.deepStrictEqual(backup.backupDir(db), { dir: String.raw`\\сервер\копии\adm-srv`, source: "panel" });
  backup.setBackupDir(db, "");
  delete process.env.BACKUP_DIR;
  assert.strictEqual(backup.backupDir(db).source, "default");
});

test("проверка папки: пишет пробный файл и убирает его; относительный путь и нет диска — понятный отказ", (t) => {
  const { cleanup } = freshDb();
  t.after(cleanup);
  const backup = require("../services/backup");
  const dir = path.join(tempDir("adm-srv-backup-check-"), "вложенная", "папка");
  t.after(() => fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true }));

  assert.deepStrictEqual(backup.checkDir(dir), { ok: true });
  assert.deepStrictEqual(fs.readdirSync(dir), [], "пробный файл не остаётся");

  const rel = backup.checkDir(String.raw`backups\копии`);
  assert.strictEqual(rel.ok, false);
  assert.match(rel.error, /полный путь/);

  // Буква, которой на этой машине нет, — как сетевой диск, которого не видит служба.
  const free = "QRSTUVWXYZ".split("").find((l) => !fs.existsSync(`${l}:/`));
  if (free) {
    const r = backup.checkDir(`${free}:/backups`);
    assert.strictEqual(r.ok, false);
    assert.match(r.hint, /сетевой диск, подключённый буквой/, "подсказка про диск-букву и UNC-путь");
  }
});

test("папка недоступна — задание падает с подсказкой, месяц не закрыт", async (t) => {
  const { db, backups } = stand(t);
  const backup = require("../services/backup");
  const free = "QRSTUVWXYZ".split("").find((l) => !fs.existsSync(`${l}:/`));
  if (!free) return;
  backup.setBackupDir(db, `${free}:/backups`);
  await assert.rejects(() => backup.run(db, new Date(2026, 9, 5)), /недоступна.*сетевой диск/);
  assert.ok(!fs.existsSync(backups), "в папку по умолчанию втихую не пишем");
});
