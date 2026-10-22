'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, login, makeUser, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  Имя ПК у того, кто не в сети (lastHosts)
//
//  «Искра» у сотрудника могла не запуститься или упасть, а компьютер включён. Администратору
//  нужно видеть, с какого ПК человек был в последний раз, и подключиться к нему (просьба
//  пользователя 2026-10-22). hosts при этом остаётся пустым: по нему клиент решает, можно ли
//  человеку писать, — пустой значит «не в сети, сообщение дождётся».
// ============================================================================

let srv, admin, анна, борис;
before(async () => {
  srv = await startServer({ env: { PRESENCE_GRACE_MS: '0' } });
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  анна = await makeUser(srv.url, admin.token, 'анна-последний-пк');
  борис = await makeUser(srv.url, admin.token, 'борис-последний-пк');
});
after(() => srv && srv.stop());

test('вышел из сети — в статусе остаётся имя его ПК, hosts пустой', async () => {
  const окно = await connect(srv.url, анна.token, { presence: 'delta' });
  try {
    const первый = await окно.next((m) => m.type === 'presence');
    assert.equal(первый.users[борис.id].lastHosts, undefined, 'ни разу не был в сети — имени ПК нет');

    const ws = await connect(srv.url, борис.token, { host: 'PC-BORIS', presence: 'delta' });
    const вошёл = await окно.next((m) => m.type === 'presence-delta' && m.users[борис.id] && m.users[борис.id].state === 'active');
    assert.deepEqual(вошёл.users[борис.id].hosts, ['PC-BORIS']);
    assert.equal(вошёл.users[борис.id].lastHosts, undefined, 'в сети — имя ПК только в hosts');
    ws.close();

    // Самая первая рассылка после запуска сервера — на всех, Борис в ней «не в сети» ещё до входа:
    // нужна именно та, что пришла после входа.
    const вышел = await окно.next((m) => m.type === 'presence-delta' && m.users[борис.id] && m.users[борис.id].state === 'offline'
      && m.users[борис.id].since >= вошёл.users[борис.id].since);
    assert.deepEqual(вышел.users[борис.id].hosts, [], 'писать ему по-прежнему можно — сообщение дождётся');
    assert.deepEqual(вышел.users[борис.id].lastHosts, ['PC-BORIS']);
  } finally { окно.close(); }
});

test('веб-панель и «неизвестный ПК» в последние ПК не попадают', async () => {
  const вера = await makeUser(srv.url, admin.token, 'вера-последний-пк');
  const окно = await connect(srv.url, анна.token, { presence: 'delta' });
  try {
    await окно.next((m) => m.type === 'presence');
    const ws = await connect(srv.url, вера.token, { host: '', presence: 'delta' });
    const вошла = await окно.next((m) => m.type === 'presence-delta' && m.users[вера.id] && m.users[вера.id].state === 'active');
    ws.close();
    const вышла = await окно.next((m) => m.type === 'presence-delta' && m.users[вера.id] && m.users[вера.id].state === 'offline'
      && m.users[вера.id].since >= вошла.users[вера.id].since);
    assert.equal(вышла.users[вера.id].lastHosts, undefined);
  } finally { окно.close(); }
});
