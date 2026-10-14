'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, login, makeUser, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  Статус переживает перезапуск службы
//
//  «В сети с», «отошёл с», «не в сети с» раньше жили только в памяти, и после перезапуска
//  службы (в том числе при обновлении сервера) отсчёт у всех начинался заново. Теперь они
//  в базе. Сроки укорочены: обрыв — 400 мс, ожидание переподключения после запуска — 1500 мс.
//  Имена выдуманы.
// ============================================================================

let srv, admin, наблюдатель, активный, отошедший, ушедший;
before(async () => {
  srv = await startServer({ env: { PRESENCE_GRACE_MS: '400', PRESENCE_STARTUP_GRACE_MS: '1500' } });
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  наблюдатель = await makeUser(srv.url, admin.token, 'наблюдатель');
  активный = await makeUser(srv.url, admin.token, 'активный');
  отошедший = await makeUser(srv.url, admin.token, 'отошедший');
  ушедший = await makeUser(srv.url, admin.token, 'ушедший');
});
after(() => srv && srv.stop());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Последние известные наблюдателю записи присутствия: читаем все снимки, пришедшие за waitMs.
async function presenceOf(ws, waitMs, known = {}) {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    try {
      const m = await ws.next((x) => x.type === 'presence', Math.max(50, until - Date.now()));
      Object.assign(known, m.users);
    } catch { break; }
  }
  return known;
}

test('после перезапуска службы «в сети с», «отошёл с» и «не в сети с» продолжаются, а не начинаются заново', async () => {
  // До перезапуска: один в сети, другой отошёл, третий был и ушёл.
  let wsАктивный = await connect(srv.url, активный.token, { host: 'PC-A' });
  let wsОтошедший = await connect(srv.url, отошедший.token, { host: 'PC-B' });
  wsОтошедший.send({ type: 'status', state: 'idle' });
  const wsУшедший = await connect(srv.url, ушедший.token, { host: 'PC-C' });
  await sleep(200);
  wsУшедший.terminate();
  await sleep(700); // срок обрыва (400 мс) вышел — «не в сети»

  let смотрит = await connect(srv.url, наблюдатель.token);
  const до = await presenceOf(смотрит, 300);
  смотрит.close();
  assert.equal(до[активный.id].state, 'active');
  assert.equal(до[отошедший.id].state, 'idle');
  assert.equal(до[ушедший.id].state, 'offline');
  assert.ok(до[отошедший.id].idleSince, 'у отошедшего есть «отошёл с»');

  await sleep(300); // чтобы «сейчас» после перезапуска заведомо отличалось от прежних отметок
  await srv.restart();

  // Сразу после запуска, пока клиенты ещё не переподключились, — прежние статусы.
  смотрит = await connect(srv.url, наблюдатель.token);
  const сразу = await presenceOf(смотрит, 200);
  assert.equal(сразу[активный.id].state, 'active', 'ещё не вернулся, но «в сети» — ждём переподключения');
  assert.equal(сразу[активный.id].since, до[активный.id].since);
  assert.equal(сразу[ушедший.id].state, 'offline');
  assert.equal(сразу[ушедший.id].since, до[ушедший.id].since, '«не в сети с» — прежнее');

  // Клиенты переподключились; отошедший по-прежнему отошёл.
  wsАктивный = await connect(srv.url, активный.token, { host: 'PC-A' });
  wsОтошедший = await connect(srv.url, отошедший.token, { host: 'PC-B' });
  wsОтошедший.send({ type: 'status', state: 'idle' });
  const после = await presenceOf(смотрит, 2000, сразу); // дольше срока ожидания после запуска
  try {
    assert.equal(после[активный.id].state, 'active');
    assert.equal(после[активный.id].since, до[активный.id].since, '«в сети с» — прежнее');
    assert.equal(после[отошедший.id].state, 'idle');
    assert.equal(после[отошедший.id].since, до[отошедший.id].since);
    assert.equal(после[отошедший.id].idleSince, до[отошедший.id].idleSince, '«отошёл с» — прежнее');
    assert.equal(после[ушедший.id].since, до[ушедший.id].since);
  } finally { смотрит.close(); wsАктивный.close(); wsОтошедший.close(); }
});

test('не вернулся после перезапуска — через срок ожидания «не в сети»', async () => {
  let ws = await connect(srv.url, активный.token, { host: 'PC-A' });
  await sleep(200);
  await srv.restart();
  const смотрит = await connect(srv.url, наблюдатель.token);
  try {
    const сразу = await presenceOf(смотрит, 200);
    assert.equal(сразу[активный.id].state, 'active');
    const потом = await presenceOf(смотрит, 2000, сразу);
    assert.equal(потом[активный.id].state, 'offline', 'срок ожидания вышел — не в сети');
  } finally { смотрит.close(); ws.close(); }
});
