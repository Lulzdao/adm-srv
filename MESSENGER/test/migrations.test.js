'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

// ============================================================================
//  Обновление структуры базы — всё или ничего
//
//  База «прежней версии» (у users нет прав и номера входа, отделы — одной колонкой), последний шаг
//  обновления срывается. После сбоя в базе не должно остаться ни одного изменения, а следующий
//  запуск без помехи должен пройти целиком. Сервер — настоящий процесс, как у службы.
// ============================================================================

const SERVER_DIR = path.resolve(__dirname, '..');

function serverCopy(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iskra-migr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  fs.copyFileSync(path.join(SERVER_DIR, 'server.js'), path.join(dir, 'server.js'));
  fs.cpSync(path.join(SERVER_DIR, 'lib'), path.join(dir, 'lib'), { recursive: true });
  return dir;
}

/** Запустить и дождаться выхода или строки «Искра запущена». */
function run(dir) {
  const env = { ...process.env, PORT: '0', NODE_PATH: path.join(SERVER_DIR, 'node_modules') };
  delete env.JWT_SECRET;
  const proc = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return new Promise((resolve) => {
    const done = (running) => { clearTimeout(timer); if (running) proc.kill(); resolve({ running, code: proc.exitCode, out }); };
    const timer = setTimeout(() => done(true), 15000);
    const onData = (d) => { out += d; if (/Искра запущена/.test(out)) done(true); };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', () => done(false));
  }).then(async (r) => {
    if (proc.exitCode === null) await new Promise((res) => proc.once('exit', res));
    return r;
  });
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

test('сбой на последнем шаге обновления откатывает все шаги', async (t) => {
  const dir = serverCopy(t);
  const file = path.join(dir, 'messenger.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'employee', department_id INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE departments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL);
    INSERT INTO departments (name) VALUES ('Отдел старый');
    INSERT INTO users (username, password_hash, display_name, department_id, created_at) VALUES ('старый', 'x', 'Старый Сотрудник', 1, 0);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
    -- Помеха: последний шаг ставит отметку «отделы перенесены» — её и срываем.
    CREATE TRIGGER сорвать BEFORE INSERT ON app_settings WHEN NEW.key = 'migrated_user_departments'
      BEGIN SELECT RAISE(ABORT, 'помеха из теста'); END;
  `);
  old.close();

  const failed = await run(dir);
  assert.equal(failed.running, false, 'со сбоем обновления сервер не должен работать');
  assert.equal(failed.code, 1);

  const after = new DatabaseSync(file);
  try {
    const added = columns(after, 'users').filter((c) => ['can_admin', 'can_broadcast', 'version', 'session_gen'].includes(c));
    assert.deepEqual(added, [], 'колонки, добавленные первыми шагами, должны откатиться');
    const tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    assert.ok(!tables.includes('messages') && !tables.includes('user_departments'), 'таблицы из схемы тоже не должны остаться');
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM app_settings').get().n, 0, 'и отметки о переносах');
    after.exec('DROP TRIGGER сорвать');
  } finally {
    after.close();
  }
  const logs = fs.readdirSync(path.join(dir, 'logs'), { recursive: true }).filter((f) => f.endsWith('.log'))
    .map((f) => fs.readFileSync(path.join(dir, 'logs', f), 'utf8')).join('\n');
  assert.match(logs, /db_migration_failed/, 'в журнале — что обновление отменено');

  const ok = await run(dir);
  assert.equal(ok.running, true, `без помехи сервер запускается:\n${ok.out}`);
  const db = new DatabaseSync(file);
  try {
    assert.ok(columns(db, 'users').includes('session_gen'));
    assert.deepEqual({ ...db.prepare('SELECT user_id, department_id FROM user_departments').get() }, { user_id: 1, department_id: 1 },
      'отдел сотрудника перенесён');
  } finally {
    db.close();
  }
});
