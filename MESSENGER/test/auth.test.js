'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, login, makeUser, ADMIN } = require('./helpers/server');

// ============================================================================
//  Вход, токены и права администратора
//
//  Один сервер на весь файл: запуск процесса и bcrypt небыстрые, а входов с одного адреса сервер
//  пускает не больше 30 за 10 минут — каждый тест заводит своих пользователей, чтобы не мешать
//  соседям.
// ============================================================================

let srv;
let admin;
before(async () => {
  srv = await startServer();
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
});
after(() => srv && srv.stop());

test('стартовый администратор заводится из bootstrap-admin.js и получает права', async () => {
  const r = await request(srv.url, 'GET', '/api/me', { token: admin.token });
  assert.equal(r.status, 200);
  assert.equal(r.json.can_admin, 1);
});

test('неверный пароль — 401, и пароль в ответе не подсказывается', async () => {
  await makeUser(srv.url, admin.token, 'неверный-пароль');
  const r = await request(srv.url, 'POST', '/api/login', { body: { username: 'неверный-пароль', password: 'не тот' } });
  assert.equal(r.status, 401);
  assert.equal(r.json.token, undefined);
});

test('после пяти неудач логин блокируется даже для верного пароля', async () => {
  const u = await makeUser(srv.url, admin.token, 'подбор');
  for (let i = 0; i < 5; i++) {
    const r = await request(srv.url, 'POST', '/api/login', { body: { username: u.username, password: `догадка-${i}` } });
    assert.equal(r.status, 401);
  }
  const r = await request(srv.url, 'POST', '/api/login', { body: { username: u.username, password: 'пароль-для-теста-1' } });
  assert.equal(r.status, 429, 'иначе пароль подбирается перебором');
});

test('без токена и с поддельным токеном API закрыто', async () => {
  assert.equal((await request(srv.url, 'GET', '/api/me')).status, 401);
  // Подпись от чужого ключа: структура настоящая, ключ — нет.
  const чужой = require('jsonwebtoken').sign({ id: admin.id }, 'не-ключ-сервера');
  assert.equal((await request(srv.url, 'GET', '/api/me', { token: чужой })).status, 401);
});

test('обычному сотруднику разделы администратора закрыты', async () => {
  const u = await makeUser(srv.url, admin.token, 'рядовой');
  for (const [method, p] of [
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/files'],
    ['GET', '/api/admin/logs'],
    ['GET', `/api/admin/history/dm/${admin.id}/${u.id}`],
    ['POST', '/api/admin/users'],
    ['PATCH', '/api/admin/registration'],
  ]) {
    const r = await request(srv.url, method, p, { token: u.token, body: method === 'GET' ? undefined : {} });
    assert.equal(r.status, 403, `${method} ${p}: ${r.text}`);
  }
});

test('право администратора снимается сразу, без повторного входа', async () => {
  const u = await makeUser(srv.url, admin.token, 'временный-админ', { can_admin: true });
  assert.equal((await request(srv.url, 'GET', '/api/admin/users', { token: u.token })).status, 200);
  const снять = await request(srv.url, 'PATCH', `/api/admin/users/${u.id}`, { token: admin.token, body: { can_admin: false } });
  assert.equal(снять.status, 200, снять.text);
  assert.equal((await request(srv.url, 'GET', '/api/admin/users', { token: u.token })).status, 403,
    'токен выдан раньше, но права читаются из базы на каждый запрос');
});

test('закрытая регистрация не заводит учётку', async () => {
  const закрыть = await request(srv.url, 'PATCH', '/api/admin/registration', { token: admin.token, body: { open: false } });
  assert.equal(закрыть.status, 200);
  const r = await request(srv.url, 'POST', '/api/register', { body: { username: 'самозванец', password: 'пароль-1' } });
  assert.equal(r.status, 403);
  assert.equal((await request(srv.url, 'POST', '/api/login', { body: { username: 'самозванец', password: 'пароль-1' } })).status, 401);
});

// Отдельный сервер: тест считает входы с одного адреса, и чужие входы из этого файла ему мешали бы.
test('входы с одного адреса не закрывают регистрацию — у маршрутов свои счётчики', async (t) => {
  const own = await startServer();
  t.after(() => own.stop());
  const a = await login(own.url, ADMIN.username, ADMIN.password);
  await request(own.url, 'PATCH', '/api/admin/registration', { token: a.token, body: { open: true } });
  // Одиннадцать входов — больше предела регистраций (10 в час), но меньше предела входов (30).
  for (let i = 0; i < 10; i++) await login(own.url, ADMIN.username, ADMIN.password);
  const r = await request(own.url, 'POST', '/api/register', { body: { username: 'новенький', password: 'пароль-1' } });
  assert.equal(r.status, 200, `регистрация упёрлась в счётчик входов: ${r.status} ${r.text}`);
});
