'use strict';

// ============================================================================
//  Настоящий сервер «Искры», поднятый в тесте
//
//  server.js держит базу, uploads/, logs/ и certs/ рядом с собой (path.join(__dirname, ...)) и
//  при загрузке сразу слушает порт — «собрать приложение без запуска» тут нельзя. Поэтому тест
//  копирует server.js (и lib/) во временную папку и запускает отдельным процессом: у копии своя пустая
//  база и свои файлы, рабочие данные рядом с настоящим server.js не затрагиваются. Зависимости
//  берутся из node_modules этой папки через NODE_PATH.
//
//  Проверяется ровно то, что работает в бою: HTTP, WebSocket, JWT, bcrypt, SQLite — без заглушек.
//  Логины и пароли выдуманы.
// ============================================================================

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const SERVER_DIR = path.resolve(__dirname, '..', '..');
const ADMIN = { username: 'админ-тест', password: 'пароль-админа-1' };
const PASSWORD = 'пароль-для-теста-1';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// GET без проверки сертификата: сервер в тесте может работать по https с самоподписанным.
function getStatus(url) {
  const mod = url.startsWith('https:') ? require('node:https') : require('node:http');
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { rejectUnauthorized: false }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
}

async function waitForPing(url, proc, output) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`сервер завершился при запуске:\n${output()}`);
    try {
      if ((await getStatus(`${url}/api/ping`)) === 200) return;
    } catch { /* ещё не слушает */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`сервер не поднялся за 15 с:\n${output()}`);
}

/**
 * Поднять сервер. Возвращает { url, dir, stop }. stop обязательно звать в after().
 * files — что положить рядом с server.js до запуска, например { 'certs/server.pfx': buffer }:
 * с сертификатом в certs/ сервер поднимается по https, и url будет https://localhost:<порт>.
 */
async function startServer({ files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iskra-test-'));
  fs.copyFileSync(path.join(SERVER_DIR, 'server.js'), path.join(dir, 'server.js'));
  fs.cpSync(path.join(SERVER_DIR, 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bootstrap-admin.js'), `module.exports = ${JSON.stringify(ADMIN)};\n`);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }

  const port = await freePort();
  const env = { ...process.env, PORT: String(port), NODE_PATH: path.join(SERVER_DIR, 'node_modules') };
  // Ключ подписи — свой у каждого запуска: сервер сгенерирует его сам и сохранит в свою базу.
  delete env.JWT_SECRET;
  for (const k of ['TLS_PFX', 'TLS_PFX_PASSWORD', 'TLS_CERT', 'TLS_KEY']) delete env[k];

  const proc = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });

  const secure = Object.keys(files).some((f) => f.split(path.sep).join('/') === 'certs/server.pfx');
  const url = secure ? `https://localhost:${port}` : `http://127.0.0.1:${port}`;
  try {
    await waitForPing(url, proc, () => log);
  } catch (err) {
    proc.kill();
    throw err;
  }

  return {
    url,
    dir,
    log: () => log,
    async stop() {
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once('exit', r));
        proc.kill();
        await exited;
      }
      // На Windows файлы базы отпускаются не мгновенно после выхода процесса.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/** Запрос к API. Ответ — { status, json, text }. */
async function request(url, method, p, { token, body, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(url + p, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* не JSON */ }
  return { status: res.status, json, text };
}

async function login(url, username, password = PASSWORD) {
  const r = await request(url, 'POST', '/api/login', { body: { username, password } });
  if (r.status !== 200) throw new Error(`вход "${username}" не удался: ${r.status} ${r.text}`);
  return { token: r.json.token, id: r.json.user.id };
}

/** Завести сотрудника от имени администратора и войти им. Возвращает { token, id, username }. */
async function makeUser(url, adminToken, username, extra = {}) {
  const r = await request(url, 'POST', '/api/admin/users', {
    token: adminToken, body: { username, password: PASSWORD, ...extra },
  });
  if (r.status !== 200) throw new Error(`не завёлся "${username}": ${r.status} ${r.text}`);
  return { ...(await login(url, username)), username };
}

/** Загрузить файл. Возвращает { url, name, size } — то, что клиент потом кладёт в сообщение. */
async function upload(url, token, name, content = 'содержимое файла') {
  const r = await request(url, 'POST', `/api/upload?name=${encodeURIComponent(name)}`, {
    token, raw: Buffer.from(content), headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (r.status !== 200) throw new Error(`загрузка "${name}" не удалась: ${r.status} ${r.text}`);
  return r.json;
}

/**
 * WebSocket-подключение как у клиента. send(msg) — отправить, next(pred) — дождаться входящего
 * сообщения, подходящего под условие (по умолчанию — любого).
 */
async function connect(url, token) {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/?token=${encodeURIComponent(token)}&host=test`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return {
    send: (msg) => ws.send(JSON.stringify(msg)),
    next(pred = () => true, timeoutMs = 3000) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const j = waiters.indexOf(w);
          if (j >= 0) { waiters.splice(j, 1); reject(new Error('не дождались сообщения по WebSocket')); }
        }, timeoutMs);
      });
    },
    close: () => ws.close(),
  };
}

module.exports = { startServer, getStatus, request, login, makeUser, upload, connect, ADMIN, PASSWORD };
