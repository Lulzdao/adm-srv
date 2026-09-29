'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, login, makeUser, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  Сообщения от платформы «Центр»
//
//  Платформа шлёт сюда напоминания по задачам, «Искра» доставляет их личным
//  сообщением от служебного пользователя «Центр». Проверяется на настоящем
//  процессе сервера: HTTP-точка, поиск получателя по ФИО, доставка по
//  WebSocket и то, что служебная учётка не становится лазейкой.
//
//  Все ФИО ВЫДУМАНЫ.
// ============================================================================

const TOKEN = 'test-platform-secret-0123456789abcdef';
let srv;
let admin;
before(async () => {
  srv = await startServer({ env: { PLATFORM_NOTIFY_TOKEN: TOKEN } });
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
});
after(() => srv && srv.stop());

const notify = (body, token = TOKEN) =>
  request(srv.url, 'POST', '/api/system/notify', { body, headers: token ? { Authorization: `Bearer ${token}` } : {} });

test('без секрета и с чужим секретом — отказ, сообщение не создаётся', async () => {
  assert.equal((await notify({ to: 'Кто угодно', text: 'x' }, null)).status, 401);
  assert.equal((await notify({ to: 'Кто угодно', text: 'x' }, 'wrong-secret-but-also-long-000000000')).status, 401);
});

test('без полей to и text — 400', async () => {
  assert.equal((await notify({ to: '', text: 'x' })).status, 400);
  assert.equal((await notify({ to: 'Тестов Тест Тестович' })).status, 400);
});

test('получатель находится по ФИО без учёта регистра, «ё» и лишних пробелов, сообщение приходит по WebSocket', async () => {
  const u = await makeUser(srv.url, admin.token, 'Королёв Проба Тестович');
  const ws = await connect(srv.url, u.token);
  try {
    const r = await notify({ to: '  королев   проба тестович ', text: 'Срок задачи завтра: Заменить ИБП' });
    assert.equal(r.status, 200, r.text);
    const msg = await ws.next((m) => m.type === 'message' && m.to_id === u.id);
    assert.equal(msg.from_user, 'Центр');
    assert.equal(msg.text, 'Срок задачи завтра: Заменить ИБП');
  } finally {
    ws.close();
  }
  // И лежит в истории переписки — сотрудник, открывший «Искру» позже, его увидит.
  const users = (await request(srv.url, 'GET', '/api/users', { token: u.token })).json;
  const center = users.find((x) => x.display_name === 'Центр');
  assert.ok(center, '«Центр» виден в списке контактов — иначе клиенту некуда показать сообщение');
  const hist = await request(srv.url, 'GET', `/api/history/dm/${center.id}`, { token: u.token });
  const list = Array.isArray(hist.json) ? hist.json : hist.json.messages || [];
  assert.ok(list.some((m) => m.text === 'Срок задачи завтра: Заменить ИБП'));
});

test('нет такого человека — 404 с понятной причиной', async () => {
  const r = await notify({ to: 'Несуществующий Никто Никтович', text: 'x' });
  assert.equal(r.status, 404);
  assert.match(r.json.error, /нет пользователя/);
});

test('двое, чьи ФИО совпадают без учёта «ё», — 409, а не сообщение наугад одному из них', async () => {
  // В «Искре» ФИО и есть логин, поэтому совпасть буква в букву они не могут, а вот
  // «Семёнов» и «Семенов» — два разных логина, которые поиск по ФИО не различает.
  await makeUser(srv.url, admin.token, 'Семёнов Проба Тестович');
  await makeUser(srv.url, admin.token, 'Семенов Проба Тестович');
  const r = await notify({ to: 'Семенов Проба Тестович', text: 'x' });
  assert.equal(r.status, 409);
});

test('под «Центром» нельзя войти, его нельзя править и удалить из панели', async () => {
  const users = (await request(srv.url, 'GET', '/api/admin/users', { token: admin.token })).json;
  const center = users.find((x) => x.display_name === 'Центр');
  assert.ok(center, 'служебная учётка уже заведена предыдущими тестами');

  for (const password of ['!', '', 'пароль-для-теста-1']) {
    const r = await request(srv.url, 'POST', '/api/login', { body: { username: 'Центр', password } });
    assert.notEqual(r.status, 200, `вход под «Центром» с паролем «${password}»`);
  }
  const patch = await request(srv.url, 'PATCH', `/api/admin/users/${center.id}`, { token: admin.token, body: { password: 'новый-пароль-1234' } });
  assert.equal(patch.status, 400, 'иначе заданный пароль открыл бы вход от имени «Центра»');
  const del = await request(srv.url, 'DELETE', `/api/admin/users/${center.id}`, { token: admin.token });
  assert.equal(del.status, 400);
});

test('сообщение «Центру» от сотрудника не сохраняется: отвечать ему некому', async () => {
  const u = await makeUser(srv.url, admin.token, 'Пишущий Проба Тестович');
  const users = (await request(srv.url, 'GET', '/api/users', { token: u.token })).json;
  const center = users.find((x) => x.display_name === 'Центр');
  const ws = await connect(srv.url, u.token);
  try {
    ws.send({ type: 'send', to: center.id, text: 'ответ роботу' });
    // Контрольное сообщение самому себе через «Центр» не пройдёт; проверяем по истории.
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    ws.close();
  }
  const hist = await request(srv.url, 'GET', `/api/history/dm/${center.id}`, { token: u.token });
  const list = Array.isArray(hist.json) ? hist.json : hist.json.messages || [];
  assert.ok(!list.some((m) => m.text === 'ответ роботу'));
});

test('без PLATFORM_NOTIFY_TOKEN точка выключена целиком', async () => {
  const off = await startServer();
  try {
    const r = await request(off.url, 'POST', '/api/system/notify', {
      body: { to: 'Кто угодно', text: 'x' }, headers: { Authorization: 'Bearer ' },
    });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /выключен/);
  } finally {
    off.stop();
  }
});
