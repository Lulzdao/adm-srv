'use strict';

require("./helpers/isolateEnv");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

// ============================================================================
//  Запуск при сбоях: испорченная, повреждённая и занятая база, занятый порт
//
//  Проверка на стенде 2026-09-28: база, которую держит другая программа, роняла
//  запуск сразу, без ожидания; испорченный файл и занятый порт давали стек вместо
//  объяснения. Здесь — настоящий server.js отдельным процессом, как его запускает
//  служба, со своей базой во временной папке.
// ============================================================================

const ROOT = path.resolve(__dirname, "..");

// Папка и всё, что держит её файлы. Уборка — одним хуком: хуки after выполняются в порядке
// регистрации, и отдельный хук удаления папки срабатывал раньше остановки сервера (EPERM, а
// сервер оставался жить).
const procsByDir = new Map(); // папка -> процессы, которые держат её файлы

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startup-"));
  const procs = [];
  procsByDir.set(dir, procs);
  t.after(async () => {
    for (const p of procs) {
      if (p.exitCode === null) {
        const exited = new Promise((res) => p.once("exit", res));
        p.kill();
        await exited;
      }
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return dir;
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Запустить платформу; дождаться выхода или строки «Сервер запущен». */
function start(dir, { port, waitMs = 15000 } = {}) {
  const env = {
    ...process.env,
    DB_PATH: path.join(dir, "helpdesk.db"),
    PORT: String(port),
    SESSION_SECRET: "проверка-запуска",
    SHARED_CERT_DIR: path.join(dir, "certs"),
  };
  for (const k of ["TLS_PFX", "TLS_PFX_PASSWORD", "TLS_CERT", "TLS_KEY"]) delete env[k];
  const proc = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  procsByDir.get(dir).push(proc);
  let out = "";
  return new Promise((resolve) => {
    const done = (running) => { clearTimeout(timer); resolve({ proc, out, running, code: proc.exitCode }); };
    const timer = setTimeout(() => done(true), waitMs);
    const onData = (d) => { out += d; if (/Сервер запущен/.test(out)) done(true); };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", () => done(false));
  });
}

test("файл базы — не база: остановка с подсказкой про резервную копию, без стека", async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "helpdesk.db"), Buffer.alloc(8192, 0x5a));
  const r = await start(dir, { port: await freePort() });
  assert.equal(r.running, false);
  assert.equal(r.code, 1);
  assert.match(r.out, /повреждён или это не база SQLite/);
  assert.match(r.out, /Резервные копии баз/);
  assert.doesNotMatch(r.out, /\n\s+at /, "стек вместо объяснения не нужен");
});

test("база занята другой программой пару секунд: платформа дожидается и запускается", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "helpdesk.db");
  const locker = spawn(process.execPath, ["-e", `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec('CREATE TABLE zz (x)'); db.exec('BEGIN EXCLUSIVE'); db.exec('INSERT INTO zz VALUES (1)');
    console.log('держу');
    setTimeout(() => { db.exec('COMMIT'); db.close(); process.exit(0); }, 2000);
  `], { stdio: ["ignore", "pipe", "inherit"] });
  procsByDir.get(dir).push(locker);
  await new Promise((r) => locker.stdout.once("data", r));

  const r = await start(dir, { port: await freePort() });
  assert.equal(r.running, true, `платформа не дождалась базы:\n${r.out}`);
});

test("повреждение внутри базы: платформа работает, но пишет об этом в журнал", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "helpdesk.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE junk (id INTEGER PRIMARY KEY, t TEXT)");
  const ins = db.prepare("INSERT INTO junk (t) VALUES (?)");
  for (let i = 0; i < 2000; i++) ins.run("x".repeat(200));
  db.close();
  const fd = fs.openSync(file, "r+");
  fs.writeSync(fd, Buffer.alloc(4096 * 3, 0xff), 0, 4096 * 3, 4096);
  fs.closeSync(fd);

  const r = await start(dir, { port: await freePort() });
  assert.equal(r.running, true, r.out);
  assert.match(r.out, /База .* повреждена/);
});

test("порт занят: одна понятная строка и выход с ошибкой", async (t) => {
  const dir = tempDir(t);
  const port = await freePort();
  // Порт держит «вторая копия» — так же, без адреса, как слушает сама платформа.
  const busy = net.createServer().listen(port);
  await new Promise((r) => busy.once("listening", r));
  t.after(() => busy.close());

  const r = await start(dir, { port });
  assert.equal(r.running, false, r.out);
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`Порт ${port} уже занят`));
});
