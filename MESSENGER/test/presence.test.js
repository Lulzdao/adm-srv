'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, login, makeUser, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  Присутствие: короткий обрыв связи — не «вышел из сети»
//
//  Клиент после обрыва переподключается сам через пару секунд, но коллеги успевали увидеть
//  «не в сети → в сети»: статусы моргали, у целой группы сразу, если связь рвалась одновременно.
//  Последнее соединение человека, закрывшись, ещё какое-то время держит его статус (в тестах
//  срок укорочен до 700 мс через PRESENCE_GRACE_MS). Имена выдуманы.
// ============================================================================

const GRACE = 700;
let srv, admin, наблюдатель, сотрудник;
before(async () => {
  srv = await startServer({ env: { PRESENCE_GRACE_MS: String(GRACE) } });
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  наблюдатель = await makeUser(srv.url, admin.token, 'наблюдатель');
  сотрудник = await makeUser(srv.url, admin.token, 'сотрудник');
});
after(() => srv && srv.stop());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Последний известный наблюдателю статус сотрудника: читаем все снимки присутствия, что пришли за
// waitMs. Сервер шлёт снимок только при изменении, поэтому если новых не было — статус прежний.
const known = new Map(); // наблюдатель -> последний увиденный статус сотрудника
async function lastState(ws, userId, waitMs) {
  let state = known.get(ws);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    try {
      const m = await ws.next((x) => x.type === 'presence', Math.max(50, until - Date.now()));
      state = m.users[userId] && m.users[userId].state;
    } catch { break; }
  }
  known.set(ws, state);
  return state;
}

test('обрыв и переподключение в пределах срока — коллеги не видят «не в сети»', async () => {
  const смотрит = await connect(srv.url, наблюдатель.token);
  let клиент = await connect(srv.url, сотрудник.token, { host: 'PC-1' });
  try {
    assert.equal(await lastState(смотрит, сотрудник.id, 300), 'active');

    клиент.terminate();                                   // связь оборвалась
    const seen = [];
    const t0 = Date.now();
    while (Date.now() - t0 < GRACE / 2) {
      try { const m = await смотрит.next((x) => x.type === 'presence', 100); seen.push(m.users[сотрудник.id].state); } catch { /* тишина */ }
    }
    клиент = await connect(srv.url, сотрудник.token, { host: 'PC-1' }); // вернулся до конца срока
    for (const s of seen) assert.notEqual(s, 'offline', 'пока идёт срок, статус прежний');
    assert.equal(await lastState(смотрит, сотрудник.id, GRACE + 400), 'active', 'и после срока — в сети');
  } finally { смотрит.close(); клиент.close(); }
});

test('не вернулся — через срок «не в сети», как раньше', async () => {
  const смотрит = await connect(srv.url, наблюдатель.token);
  const клиент = await connect(srv.url, сотрудник.token, { host: 'PC-1' });
  try {
    assert.equal(await lastState(смотрит, сотрудник.id, 300), 'active');
    клиент.terminate();
    assert.equal(await lastState(смотрит, сотрудник.id, GRACE / 2), 'active', 'сразу после обрыва — ещё в сети');
    assert.equal(await lastState(смотрит, сотрудник.id, GRACE + 600), 'offline', 'срок вышел — не в сети');
  } finally { смотрит.close(); }
});

test('отошедший остаётся «отошёл», а не превращается в «в сети»', async () => {
  const смотрит = await connect(srv.url, наблюдатель.token);
  const клиент = await connect(srv.url, сотрудник.token, { host: 'PC-1' });
  try {
    клиент.send({ type: 'status', state: 'idle' });
    assert.equal(await lastState(смотрит, сотрудник.id, 300), 'idle');
    клиент.terminate();
    assert.equal(await lastState(смотрит, сотрудник.id, GRACE / 2), 'idle');
  } finally { смотрит.close(); }
});

test('обрыв записывается в журнал сервера, обычное закрытие окна — нет', async () => {
  const обрыв = await connect(srv.url, сотрудник.token, { host: 'PC-DROP' });
  const закрыл = await connect(srv.url, сотрудник.token, { host: 'PC-CLOSE' });
  await sleep(100);
  обрыв.terminate();
  закрыл.close();
  await sleep(300);
  const dir = path.join(srv.dir, 'logs');
  const text = fs.readdirSync(dir, { recursive: true })
    .filter((f) => /server-.*\.log$/.test(String(f)))
    .map((f) => fs.readFileSync(path.join(dir, String(f)), 'utf8')).join('');
  assert.match(text, /ws_dropped.*PC-DROP.*"code":1006/, 'обрыв виден с кодом 1006');
  assert.doesNotMatch(text, /ws_dropped.*PC-CLOSE/, 'обычное закрытие не пишется');
});
