'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, login, makeUser, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  Статусы «в сети» только изменившихся (presence=delta, клиент 1.0.31+)
//
//  Раньше любая смена статуса у одного человека рассылала каждому окну список на всех
//  (журнал 2026-10-21: 126 МБ в час). Теперь окно с presence=delta получает полный список
//  один раз, при подключении, а дальше — только тех, у кого статус поменялся. Старые клиенты
//  (без ключа) получают полный список, как раньше; окно рассылки (presence=none) — ничего.
// ============================================================================

let srv, admin, анна, борис, вера;
before(async () => {
  srv = await startServer({ env: { PRESENCE_GRACE_MS: '0' } });
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  анна = await makeUser(srv.url, admin.token, 'анна-дельта');
  борис = await makeUser(srv.url, admin.token, 'борис-дельта');
  вера = await makeUser(srv.url, admin.token, 'вера-дельта');
});
after(() => srv && srv.stop());

test('новое окно: полный список при подключении, дальше — только изменившиеся; старое окно — полный список', async () => {
  const новое = await connect(srv.url, анна.token, { presence: 'delta' });
  const старое = await connect(srv.url, анна.token);
  const рассылка = await connect(srv.url, анна.token, { presence: 'none' });
  try {
    const первый = await новое.next((m) => m.type === 'presence');
    assert.ok(первый.users[борис.id], 'при подключении — полный список, с теми, кто не в сети');
    assert.equal(первый.users[борис.id].state, 'offline');

    const ws = await connect(srv.url, борис.token, { presence: 'delta' });
    try {
      // Самая первая рассылка после запуска сервера — на всех (сравнивать ещё не с чем); ждём ту, где Борис вошёл.
      const дельта = await новое.next((m) => m.type === 'presence-delta' && m.users[борис.id] && m.users[борис.id].state === 'active');
      assert.ok(!(вера.id in дельта.users), 'у веры ничего не менялось — её в рассылке нет');
      assert.ok(Object.keys(дельта.users).length <= 2, `только изменившиеся: ${Object.keys(дельта.users).join(', ')}`);

      const полный = await старое.next((m) => m.type === 'presence' && m.users[борис.id] && m.users[борис.id].state === 'active');
      assert.ok(полный.users[вера.id], 'клиент до 1.0.31 по-прежнему получает список на всех');

      ws.send({ type: 'status', state: 'idle' });
      const отошёл = await новое.next((m) => m.type === 'presence-delta' && m.users[борис.id] && m.users[борис.id].state === 'idle');
      assert.deepEqual(Object.keys(отошёл.users), [String(борис.id)]);
    } finally { ws.close(); }

    const вышел = await новое.next((m) => m.type === 'presence-delta' && m.users[борис.id] && m.users[борис.id].state === 'offline');
    assert.ok(вышел);

    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(рассылка.next((m) => m.type === 'presence' || m.type === 'presence-delta', 200), 'окну рассылки статусы не шлются');
  } finally { новое.close(); старое.close(); рассылка.close(); }
});

test('учётку удалили — в рассылке изменений она приходит как null', async () => {
  const лишний = await makeUser(srv.url, admin.token, 'удаляемый-дельта');
  const новое = await connect(srv.url, анна.token, { presence: 'delta' });
  try {
    await новое.next((m) => m.type === 'presence');
    const ws = await connect(srv.url, лишний.token, { presence: 'delta' });
    await новое.next((m) => m.type === 'presence-delta' && m.users[лишний.id]);
    ws.close();
    await новое.next((m) => m.type === 'presence-delta' && m.users[лишний.id] && m.users[лишний.id].state === 'offline');
    const { request } = require('./helpers/server');
    const r = await request(srv.url, 'DELETE', `/api/admin/users/${лишний.id}`, { token: admin.token });
    assert.equal(r.status, 200, r.text);
    // Удаление само по себе рассылку не запускает — она уйдёт со следующей сменой статуса у кого-нибудь.
    const ws2 = await connect(srv.url, вера.token, { presence: 'delta' });
    try {
      const m = await новое.next((x) => x.type === 'presence-delta' && x.users[вера.id]);
      assert.equal(m.users[лишний.id], null, 'удалённого — убрать из списка');
    } finally { ws2.close(); }
  } finally { новое.close(); }
});
