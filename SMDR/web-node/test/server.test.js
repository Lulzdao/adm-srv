'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// ============================================================================
//  Веб-часть без таблицы звонков: ни одна страница не роняет процесс
//
//  Таблицу calls создаёт сборщик. Пока он ни разу не запускался (новая машина,
//  сборщик не настроен), веб-часть должна отвечать «звонков ещё нет», а не падать.
//  Выгрузка в .xlsx — асинхронный обработчик, и её ошибка раньше уходила мимо
//  всех обработчиков: один щелчок «Выгрузить» завершал процесс.
//  Настоящий server.js — копией во временной папке, со своей пустой базой.
// ============================================================================

const WEB = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

test('без таблицы calls страницы и выгрузки отвечают 503, процесс жив', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smdr-web-'));
  fs.cpSync(WEB, path.join(root, 'web-node'), {
    recursive: true,
    filter: (s) => !/[\\/](node_modules|test)([\\/]|$)/.test(path.relative(WEB, s) ? s : ''),
  });
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(root, 'web-node'),
    env: { ...process.env, PORT: String(port), NODE_PATH: path.join(WEB, 'node_modules') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (proc.exitCode === null) { proc.kill(); await new Promise((r) => proc.once('exit', r)); }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`не запустился:\n${out}`)), 10000);
    const onData = (d) => { out += d; if (/Веб запущен/.test(out)) { clearTimeout(timer); resolve(); } };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
  });

  for (const url of ['/export.xlsx', '/export.csv', '/api/export/preview', '/', '/stats']) {
    const r = await fetch(`http://127.0.0.1:${port}${url}`);
    assert.equal(r.status, 503, `${url}: ${r.status}`);
    assert.match(await r.text(), /Звонков ещё нет/);
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(proc.exitCode, null, `процесс завершился:\n${out}`);
});
