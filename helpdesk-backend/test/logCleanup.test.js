'use strict';

require("./helpers/isolateEnv");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { tempDir } = require("./helpers/tempDb");

// ============================================================================
//  Очистка старых журналов служб (services/logCleanup.js)
//
//  Главное — что НЕ удаляется: текущие журналы, свежие куски, журналы «Искры»
//  по месяцам и любые чужие файлы. Удаляются только куски, которые нарезал
//  NSSM (метка времени в имени), и только старше срока.
// ============================================================================

const DAY = 24 * 60 * 60 * 1000;

function stand(t, env = {}) {
  const dir = tempDir("adm-srv-logs-");
  const saved = { SERVICE_LOGS_DIR: process.env.SERVICE_LOGS_DIR, LOG_KEEP_DAYS: process.env.LOG_KEEP_DAYS };
  process.env.SERVICE_LOGS_DIR = dir;
  if ("LOG_KEEP_DAYS" in env) process.env.LOG_KEEP_DAYS = env.LOG_KEEP_DAYS; else delete process.env.LOG_KEEP_DAYS;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = (name, ageDays, size = 1024) => {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "x".repeat(size));
    const when = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(p, when, when);
  };
  file("platform.out.log", 0);                               // текущий журнал
  file("platform.err.log", 400);                             // текущий, давно не менялся — всё равно не кусок
  file("platform.out-20250101T101010.123.log", 400, 2048);   // старый кусок
  file("iskra.err-20250215T000000.001.log", 300);            // старый кусок другой службы
  file("platform.out-20260920T101010.123.log", 20);          // свежий кусок
  file("2025-01/server-2025-01-05.log", 400);                // журналы «Искры» по месяцам — чистят вручную
  file("заметки-администратора.txt", 900);                   // чужой файл
  file("platform.out-2025.log", 900);                        // похоже, но не метка времени NSSM
  const names = () => fs.readdirSync(dir, { recursive: true }).map(String).filter((n) => fs.statSync(path.join(dir, n)).isFile()).sort();
  return { dir, names };
}

test("удаляются только нарезанные NSSM куски старше срока", (t) => {
  const { names } = stand(t);
  const before = names();
  const r = require("../services/logCleanup").run(null);
  assert.strictEqual(r.удалено, 2);
  assert.strictEqual(r["старше дней"], 180);
  assert.strictEqual(r.осталось, 1, "свежий кусок остался");
  assert.deepStrictEqual(before.filter((n) => !names().includes(n)).sort(),
    ["iskra.err-20250215T000000.001.log", "platform.out-20250101T101010.123.log"]);
});

test("LOG_KEEP_DAYS: свой срок; 0 — не удалять ничего; мусор — срок по умолчанию", (t) => {
  const a = stand(t, { LOG_KEEP_DAYS: "10" });
  const cleanup = require("../services/logCleanup");
  assert.strictEqual(cleanup.run(null).удалено, 3, "при сроке 10 дней уходит и кусок двадцатидневной давности");
  assert.ok(a.names().includes("platform.out.log") && a.names().includes("platform.err.log"), "текущие журналы на месте");

  const b = stand(t, { LOG_KEEP_DAYS: "0" });
  const before = b.names();
  assert.match(cleanup.run(null).удалено, /выключена/);
  assert.deepStrictEqual(b.names(), before);

  stand(t, { LOG_KEEP_DAYS: "сто" });
  assert.strictEqual(cleanup.keepDays(), 180);
});

test("папки журналов нет — задание проходит, ничего не удаляя; «Состояние» показывает размер", (t) => {
  const { dir } = stand(t);
  const cleanup = require("../services/logCleanup");
  const u = cleanup.usage();
  assert.strictEqual(u.rotated, 3);
  assert.ok(u.bytes > 2048 && u.files >= 6);

  process.env.SERVICE_LOGS_DIR = path.join(dir, "нет-такой");
  assert.strictEqual(cleanup.run(null).удалено, 0);
  assert.strictEqual(cleanup.usage(), null);
});

test("задание есть в планировщике", () => {
  const { JOBS } = require("../services/scheduler");
  const job = JOBS.find((j) => j.id === "logs");
  assert.ok(job && job.period === "monthly");
});
