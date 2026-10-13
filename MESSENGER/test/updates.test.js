'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { startServer, request, login, makeUser, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  Раздача обновлений клиентам и управление клиентами из панели
//
//  updates/ — канал доставки исполняемого кода на рабочие места. Он открыт без входа
//  намеренно (у обновляющегося клиента может не быть токена), поэтому важно, чтобы
//  через него нельзя было достать ничего, кроме самих установщиков — в первую очередь
//  базу messenger.db, лежащую уровнем выше. Команды «обновись» и «пришли журнал»
//  отдаёт только администратор и только нужному клиенту.
// ============================================================================

let srv, admin, сотрудник, другой;
before(async () => {
  srv = await startServer();
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  сотрудник = await makeUser(srv.url, admin.token, 'сотрудник');
  другой = await makeUser(srv.url, admin.token, 'другой');

  for (const [track, version] of [['win7', '1.2.3'], ['win10', '2.0.0']]) {
    const dir = path.join(srv.dir, 'updates', track);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'latest.yml'), `version: ${version}\npath: Iskra-${track}-${version}.exe\nsha512: abc\n`);
    fs.writeFileSync(path.join(dir, `Iskra-${track}-${version}.exe`), `установщик ${track}`);
  }
});
after(() => srv && srv.stop());

// Сырой GET без нормализации пути — fetch сам схлопнул бы «..», и проверка ничего бы не проверила.
function rawGet(p) {
  const { port } = new URL(srv.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('установщики и latest.yml отдаются без входа — клиенту обновляться нечем предъявить токен', async () => {
  const yml = await rawGet('/updates/win10/latest.yml');
  assert.equal(yml.status, 200);
  assert.match(yml.body, /version: 2\.0\.0/);
  const exe = await rawGet('/updates/win7/Iskra-win7-1.2.3.exe');
  assert.equal(exe.status, 200);
});

test('через updates/ нельзя достать базу и другие файлы сервера', async () => {
  assert.ok(fs.existsSync(path.join(srv.dir, 'messenger.db')), 'база рядом есть — есть что защищать');
  for (const p of [
    '/updates/../messenger.db', '/updates/%2e%2e/messenger.db', '/updates/win7/..%2f..%2fmessenger.db',
    '/updates/..%5cmessenger.db', '/updates/win7/..%5c..%5cmessenger.db', '/updates/%2e%2e%5cserver.js',
    '/updates/..%2fbootstrap-admin.js',
  ]) {
    const r = await rawGet(p);
    assert.ok(!(r.status === 200 && (r.body.includes('SQLite format') || r.body.includes('require(') || r.body.includes('password'))),
      `${p} отдал файл сервера (${r.status})`);
    assert.notEqual(r.status, 200, `${p}: ожидался отказ, получено ${r.status}`);
  }
});

test('опубликованные версии видит только администратор', async () => {
  const r = await request(srv.url, 'GET', '/api/admin/update-published', { token: admin.token });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, {
    win7: { version: '1.2.3', file: 'Iskra-win7-1.2.3.exe' },
    win10: { version: '2.0.0', file: 'Iskra-win10-2.0.0.exe' },
  });
  assert.equal((await request(srv.url, 'GET', '/api/admin/update-published', { token: сотрудник.token })).status, 403);
});

test('«обновись» отдаёт только администратор и только нужному клиенту', async () => {
  const [wsСотр, wsДруг] = await Promise.all([connect(srv.url, сотрудник.token), connect(srv.url, другой.token)]);
  try {
    const пришло = (ws) => ws.next((m) => m.type === 'force-update', 1500).then(() => true, () => false);

    // Сотрудник не может заставить обновиться чужой компьютер.
    const чужими = await request(srv.url, 'POST', '/api/admin/force-update', { token: другой.token, body: { userId: сотрудник.id } });
    assert.equal(чужими.status, 403);

    const ждём = [пришло(wsСотр), пришло(wsДруг)];
    const r = await request(srv.url, 'POST', '/api/admin/force-update', { token: admin.token, body: { userId: сотрудник.id } });
    assert.equal(r.status, 200, r.text);
    const [сотр, друг] = await Promise.all(ждём);
    assert.equal(сотр, true, 'команда дошла до нужного клиента');
    assert.equal(друг, false, 'до остальных — нет');

    const нетВСети = await request(srv.url, 'POST', '/api/admin/force-update', { token: admin.token, body: { userId: 999999 } });
    assert.equal(нетВСети.status, 409);
  } finally {
    wsСотр.close(); wsДруг.close();
  }
});

// Установщик требует прав администратора: у сотрудника без них клиент по команде закрылся бы и не
// обновился. Клиент сообщает о правах при подключении (adm=1|0), старые клиенты — нет.
test('«обновись» одной машине: без прав администратора — отказ, права неизвестны — как раньше', async () => {
  const безПрав = await connect(srv.url, сотрудник.token, { host: 'PC-USER', ver: '1.0.0', track: 'win10', adm: '0' });
  const старый = await connect(srv.url, другой.token, { host: 'PC-OLD', ver: '1.0.0', track: 'win10' });
  try {
    const пришло = (ws) => ws.next((m) => m.type === 'force-update', 800).then(() => true, () => false);

    const ждёмБезПрав = пришло(безПрав);
    const r = await request(srv.url, 'POST', '/api/admin/force-update', { token: admin.token, body: { userId: сотрудник.id, host: 'PC-USER' } });
    assert.equal(r.status, 409, r.text);
    assert.match(r.json.error, /нет прав администратора/);
    assert.equal(await ждёмБезПрав, false, 'команда не ушла');

    const ждёмСтарый = пришло(старый);
    const r2 = await request(srv.url, 'POST', '/api/admin/force-update', { token: admin.token, body: { userId: другой.id, host: 'PC-OLD' } });
    assert.equal(r2.status, 200, r2.text);
    assert.equal(await ждёмСтарый, true, 'старому клиенту команда уходит, как раньше');
  } finally { безПрав.close(); старый.close(); }
});

test('«обновить всех отстающих»: только тем, у кого есть права; остальные названы в ответе', async () => {
  const третий = await makeUser(srv.url, admin.token, 'третий');
  const четвёртый = await makeUser(srv.url, admin.token, 'четвёртый');
  // Выложено: win10 — 2.0.0, win7 — 1.2.3 (см. before).
  const сПравами = await connect(srv.url, сотрудник.token, { host: 'PC-ADMIN', ver: '1.9.0', track: 'win10', adm: '1' });
  const сПравами2 = await connect(srv.url, сотрудник.token, { host: 'PC-ADMIN', ver: '1.9.0', track: 'win10', adm: '1' }); // второе окно той же машины
  const безПрав = await connect(srv.url, другой.token, { host: 'PC-USER', ver: '1.2.0', track: 'win7', adm: '0' });
  const старый = await connect(srv.url, третий.token, { host: 'PC-OLD', ver: '1.0.0', track: 'win10' });
  const свежий = await connect(srv.url, четвёртый.token, { host: 'PC-NEW', ver: '2.0.0', track: 'win10', adm: '1' });
  const все = [сПравами, сПравами2, безПрав, старый, свежий];
  try {
    await new Promise((r) => setTimeout(r, 200));
    const пришло = (ws) => ws.next((m) => m.type === 'force-update', 800).then(() => true, () => false);

    assert.equal((await request(srv.url, 'POST', '/api/admin/force-update-all', { token: другой.token, body: {} })).status, 403);

    const ждём = все.map(пришло);
    const r = await request(srv.url, 'POST', '/api/admin/force-update-all', { token: admin.token, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(
      { sent: r.json.sent, noRights: r.json.noRights, unknown: r.json.unknown, current: r.json.current },
      { sent: 1, noRights: 1, unknown: 1, current: 1 },
      'считаются машины, а не окна'
    );
    assert.deepEqual(r.json.skipped.map((s) => `${s.hostname}:${s.reason}`).sort(), ['PC-OLD:unknown', 'PC-USER:noRights']);
    assert.deepEqual(await Promise.all(ждём), [true, true, false, false, false],
      'команда — обоим окнам машины с правами; без прав, старому и уже обновлённому — нет');

    // В списке клиентов права видны — по ним панель подписывает строки и выключает кнопку.
    const list = await request(srv.url, 'GET', '/api/admin/clients', { token: admin.token });
    const byHost = Object.fromEntries(list.json.map((c) => [c.hostname, c.canElevate]));
    assert.deepEqual(byHost, { 'PC-ADMIN': true, 'PC-USER': false, 'PC-OLD': null, 'PC-NEW': true });
    assert.ok(list.json.every((c) => !('sockets' in c)), 'подключения в ответ не попадают');
  } finally { все.forEach((ws) => ws.close()); }
});

test('клиенты и их версии в панели — только администратору', async () => {
  const ws = await connect(srv.url, сотрудник.token);
  try {
    await new Promise((r) => setTimeout(r, 200));
    const r = await request(srv.url, 'GET', '/api/admin/clients', { token: admin.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(JSON.stringify(r.json).includes('сотрудник'), 'подключённый клиент виден');
    assert.equal((await request(srv.url, 'GET', '/api/admin/clients', { token: другой.token })).status, 403);
  } finally { ws.close(); }
});

test('журнал машины: клиент кладёт свой, читает только администратор', async () => {
  const положить = (кто, text) => request(srv.url, 'POST', '/api/client-log-file?host=PC-TEST', {
    token: кто.token, raw: text, headers: { 'Content-Type': 'text/plain' },
  });
  assert.equal((await положить(сотрудник, 'журнал сотрудника')).status, 200);
  // Другой сотрудник с тем же именем ПК не подменяет чужой журнал: ключ — пользователь + ПК.
  assert.equal((await положить(другой, 'подложенный журнал')).status, 200);

  const прочитать = (кто, userId) => request(srv.url, 'GET', `/api/admin/client-log?userId=${userId}&host=PC-TEST`, { token: кто.token });
  const r = await прочитать(admin, сотрудник.id);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.text, 'журнал сотрудника');
  assert.equal((await прочитать(другой, сотрудник.id)).status, 403);
  assert.equal((await прочитать(admin, 999999)).status, 404);

  assert.equal((await request(srv.url, 'POST', '/api/admin/request-log', { token: другой.token, body: { userId: сотрудник.id } })).status, 403);
});
