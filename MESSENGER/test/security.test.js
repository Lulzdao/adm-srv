'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const jwt = require('jsonwebtoken');
const { startServer, request, login, makeUser, upload, connect, ADMIN, PASSWORD } = require('./helpers/server');

// ============================================================================
//  Отзыв входа, имена файлов, реакции в группах, правка сотрудников
//
//  Находки проверки безопасности 2026-09-28:
//   - токен входа живёт 30 дней, и ни смена пароля, ни удаление сотрудника его не отзывали — а
//     открытый WebSocket удалённого сотрудника продолжал принимать сообщения;
//   - имя файла в сообщении выбирал отправитель: разрешённый «.txt» получатель сохранял как «.exe»;
//     «.exe.» с точкой в конце проходил запрет расширений;
//   - реакции в закрытой группе рассылались всем подключённым;
//   - администратор мог снять право администратора сам с себя; правка сотрудника сохранялась
//     наполовину, если пароль в том же запросе был коротким.
//
//  Все имена и тексты выдуманы.
// ============================================================================

let srv, admin;
before(async () => {
  srv = await startServer();
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
});
after(() => srv && srv.stop());

const me = (кто) => request(srv.url, 'GET', '/api/me', { token: кто.token });
const closed = (ws, ms = 3000) => new Promise((resolve) => {
  if (ws.raw.readyState === ws.raw.CLOSED) return resolve(true);
  const t = setTimeout(() => resolve(false), ms);
  ws.raw.once('close', () => { clearTimeout(t); resolve(true); });
});

/** WebSocket, у которого виден сам сокет — чтобы дождаться, что сервер его закрыл. */
async function open(кто) {
  const WebSocket = require('ws');
  const raw = new WebSocket(`${srv.url.replace('http', 'ws')}/?token=${encodeURIComponent(кто.token)}&host=test`);
  await new Promise((resolve, reject) => { raw.once('open', resolve); raw.once('error', reject); });
  return { raw };
}

// Решение пользователя 2026-10-08: смена пароля — для следующего входа; уже вошедший клиент не вылетает.
test('смена пароля администратором не выкидывает уже вошедших; новый пароль — для следующего входа', async () => {
  const u = await makeUser(srv.url, admin.token, 'сменит-пароль');
  const ws = await open(u);
  assert.equal((await me(u)).status, 200);

  const r = await request(srv.url, 'PATCH', `/api/admin/users/${u.id}`, { token: admin.token, body: { password: 'новый-пароль-1' } });
  assert.equal(r.status, 200, r.text);

  assert.equal((await me(u)).status, 200, 'прежний вход продолжает работать');
  assert.equal(await closed(ws), false, 'открытое окно не отключено');
  const ws2 = await open(u);
  assert.equal(await closed(ws2), false, 'переподключение с прежним входом проходит');
  ws.raw.close(); ws2.raw.close();
  const старый = await request(srv.url, 'POST', '/api/login', { body: { username: 'сменит-пароль', password: PASSWORD } });
  assert.equal(старый.status, 401, 'старым паролем войти заново нельзя');
  const новый = await login(srv.url, 'сменит-пароль', 'новый-пароль-1');
  assert.equal((await me(новый)).status, 200, 'новый вход работает');
});

test('правка без пароля входы не закрывает', async () => {
  const u = await makeUser(srv.url, admin.token, 'переименуют');
  const r = await request(srv.url, 'PATCH', `/api/admin/users/${u.id}`, { token: admin.token, body: { display_name: 'Переименованный' } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await me(u)).status, 200);
});

test('удалённый сотрудник теряет и HTTP, и открытое окно', async () => {
  const u = await makeUser(srv.url, admin.token, 'уволится');
  const ws = await open(u);
  const r = await request(srv.url, 'DELETE', `/api/admin/users/${u.id}`, { token: admin.token });
  assert.equal(r.status, 200, r.text);
  assert.equal((await me(u)).status, 401);
  assert.equal(await closed(ws), true, 'иначе удалённый продолжал бы писать в открытом окне');
});

test('токены, выданные до обновления (без номера входа), продолжают работать', async () => {
  const u = await makeUser(srv.url, admin.token, 'старый-токен');
  const db = new DatabaseSync(path.join(srv.dir, 'messenger.db'), { readOnly: true });
  const secret = db.prepare("SELECT value FROM app_settings WHERE key = 'jwt_secret'").get().value;
  db.close();
  const старый = jwt.sign({ id: u.id }, secret, { expiresIn: '30d' });
  assert.equal((await me({ token: старый })).status, 200, 'обновление сервера не должно разлогинить всех');
});

// 2026-10-08: работающий клиент не должен вылетать через 30 дней — при подключении окна с токеном старше
// суток сервер выдаёт свежий (сообщение 'token'); свежему токену новый не нужен.
test('вход продлевается: токену старше суток при подключении выдаётся новый', async () => {
  const u = await makeUser(srv.url, admin.token, 'давно-вошёл');
  const db = new DatabaseSync(path.join(srv.dir, 'messenger.db'), { readOnly: true });
  const secret = db.prepare("SELECT value FROM app_settings WHERE key = 'jwt_secret'").get().value;
  db.close();
  const firstToken = (raw) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 1500);
    raw.on('message', (m) => { const d = JSON.parse(m); if (d.type === 'token') { clearTimeout(t); resolve(d.token); } });
  });
  const старый = jwt.sign({ id: u.id, sg: 0, iat: Math.floor(Date.now() / 1000) - 2 * 24 * 3600 }, secret, { expiresIn: '30d' });
  const ws = await open({ token: старый });
  const новый = await firstToken(ws.raw);
  ws.raw.close();
  assert.ok(новый, 'старому входу выдан новый токен');
  assert.equal((await me({ token: новый })).status, 200, 'новый токен — рабочий вход');
  assert.ok(jwt.decode(новый).iat > jwt.decode(старый).iat, 'и выдан сейчас');

  const ws2 = await open(u); // свежий токен из makeUser
  assert.equal(await firstToken(ws2.raw), null, 'свежему входу новый токен не нужен');
  ws2.raw.close();
});

test('токен на скачивание файла не годится как вход', async () => {
  const u = await makeUser(srv.url, admin.token, 'качает');
  const f = await upload(srv.url, u.token, 'заметка.txt');
  const t = await request(srv.url, 'GET', `/api/download-token?path=${encodeURIComponent(f.url)}`, { token: u.token });
  assert.equal(t.status, 200);
  assert.equal((await me({ token: t.json.token })).status, 401);
});

test('имя файла в сообщении — то, под которым его загрузили, а не выбранное отправителем', async () => {
  const отправитель = await makeUser(srv.url, admin.token, 'подменит-имя');
  const получатель = await makeUser(srv.url, admin.token, 'получит-файл');
  const f = await upload(srv.url, отправитель.token, 'отчёт.txt', 'MZ не совсем текст');

  const wsП = await connect(srv.url, получатель.token);
  const wsО = await connect(srv.url, отправитель.token);
  try {
    wsО.send({ type: 'send', to: получатель.id, text: 'смотри отчёт', files: [{ url: f.url, name: 'отчёт.exe', size: 1 }] });
    const пришло = await wsП.next((m) => m.type === 'message' && m.text === 'смотри отчёт');
    assert.equal(пришло.files.length, 1);
    assert.equal(пришло.files[0].name, 'отчёт.txt');
  } finally {
    wsП.close(); wsО.close();
  }

  const история = await request(srv.url, 'GET', `/api/history/dm/${отправитель.id}`, { token: получатель.token });
  assert.equal(история.json.at(-1).files[0].name, 'отчёт.txt');

  const t = await request(srv.url, 'GET', `/api/download-token?path=${encodeURIComponent(f.url)}`, { token: получатель.token });
  const got = await fetch(`${srv.url}/uploads/${encodeURIComponent(f.url.split('/').pop())}?token=${t.json.token}&name=${encodeURIComponent('отчёт.exe')}`);
  assert.equal(got.status, 200);
  const disposition = decodeURIComponent(got.headers.get('content-disposition'));
  assert.match(disposition, /отчёт\.txt/);
  assert.doesNotMatch(disposition, /\.exe/, 'имя из ?name= не подставляется');
});

test('точка или пробел в конце имени не обходят запрет расширений', async () => {
  const u = await makeUser(srv.url, admin.token, 'хитрое-имя');
  for (const name of ['программа.exe.', 'программа.exe ', 'программа.exe. .']) {
    const r = await request(srv.url, 'POST', `/api/upload?name=${encodeURIComponent(name)}`, {
      token: u.token, raw: Buffer.from('MZ'), headers: { 'Content-Type': 'application/octet-stream' },
    });
    assert.equal(r.status, 415, `«${name}»: ${r.status} ${r.text}`);
  }
});

test('реакция в закрытой группе приходит только её участникам', async () => {
  const участник = await makeUser(srv.url, admin.token, 'в-группе');
  const чужой = await makeUser(srv.url, admin.token, 'не-в-группе');
  const g = await request(srv.url, 'POST', '/api/groups', { token: участник.token, body: { name: 'Закрытая', memberIds: [] } });
  const room = `group:${g.json.id}`;

  const wsУ = await connect(srv.url, участник.token);
  const wsЧ = await connect(srv.url, чужой.token);
  try {
    wsУ.send({ type: 'send', room, text: 'секрет группы' });
    const msg = await wsУ.next((m) => m.type === 'message' && m.text === 'секрет группы');
    const чужомуПришло = wsЧ.next((m) => m.type === 'reaction', 1500).then(() => true, () => false);
    wsУ.send({ type: 'react', messageId: msg.id, emoji: '👍' });
    await wsУ.next((m) => m.type === 'reaction' && m.messageId === msg.id);
    assert.equal(await чужомуПришло, false);
  } finally {
    wsУ.close(); wsЧ.close();
  }
});

test('администратор не снимает право администратора сам с себя; другой — может', async () => {
  const второй = await makeUser(srv.url, admin.token, 'второй-админ', { can_admin: true });
  const сам = await request(srv.url, 'PATCH', `/api/admin/users/${второй.id}`, { token: второй.token, body: { can_admin: false } });
  assert.equal(сам.status, 400);
  assert.equal((await me(второй)).json.can_admin, 1);
  const другой = await request(srv.url, 'PATCH', `/api/admin/users/${второй.id}`, { token: admin.token, body: { can_admin: false } });
  assert.equal(другой.status, 200, другой.text);
  assert.equal((await me(второй)).json.can_admin, 0);
});

test('правка с ошибкой не сохраняется наполовину', async () => {
  const u = await makeUser(srv.url, admin.token, 'половина-правки');
  const r = await request(srv.url, 'PATCH', `/api/admin/users/${u.id}`, { token: admin.token, body: { can_broadcast: true, password: '12' } });
  assert.equal(r.status, 400);
  assert.equal((await me(u)).json.can_broadcast, 0, 'право не должно выдаться, раз запрос отклонён');
  const занят = await request(srv.url, 'PATCH', `/api/admin/users/${u.id}`, { token: admin.token, body: { can_broadcast: true, username: ADMIN.username } });
  assert.equal(занят.status, 409);
  assert.equal((await me(u)).json.can_broadcast, 0);
});

test('логин и пароль не строкой — 400, а не ошибка сервера', async () => {
  for (const body of [{ username: {}, password: 'x' }, { username: 'кто-то', password: ['x'] }, {}]) {
    const r = await request(srv.url, 'POST', '/api/login', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('логин при заведении — без пробелов по краям и не длиннее 60', async () => {
  const r = await request(srv.url, 'POST', '/api/admin/users', { token: admin.token, body: { username: '  С Пробелами  ', password: PASSWORD } });
  assert.equal(r.status, 200, r.text);
  await login(srv.url, 'С Пробелами');
  const длинный = await request(srv.url, 'POST', '/api/admin/users', { token: admin.token, body: { username: 'я'.repeat(61), password: PASSWORD } });
  assert.equal(длинный.status, 400);
  const неСтрока = await request(srv.url, 'POST', '/api/admin/users', { token: admin.token, body: { username: ['а'], password: PASSWORD } });
  assert.equal(неСтрока.status, 400);
});
