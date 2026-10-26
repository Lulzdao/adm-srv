'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startServer, login, makeUser, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  Мёртвое соединение: клиент не отвечает на ping — «не в сети» за секунды, а не через 90 минут
//
//  Выключили питание или выдернули кабель — соединение не закрывается, сервер узнаёт об этом
//  только по молчанию. Раньше ответ на служебный ping не проверялся, и такого человека снимала
//  подстраховка через 90 минут (найдено 2026-10-26 на Win7-ВМ). Здесь ping каждые 100 мс, мёртвым
//  считается соединение без ответа 500 мс.
// ============================================================================

let srv, admin, живой, мёртвый, смотрит;
before(async () => {
  srv = await startServer({ env: { WS_PING_MS: '100', WS_DEAD_MS: '500', PRESENCE_GRACE_MS: '0' } });
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  живой = await makeUser(srv.url, admin.token, 'живой-клиент');
  мёртвый = await makeUser(srv.url, admin.token, 'мёртвый-клиент');
  смотрит = await makeUser(srv.url, admin.token, 'наблюдатель-пинг');
});
after(() => srv && srv.stop());

test('не отвечает на ping — уходит «не в сети»; отвечающий — остаётся', async () => {
  const окно = await connect(srv.url, смотрит.token, { presence: 'delta' });
  const ok = await connect(srv.url, живой.token, { host: 'PC-ALIVE' });
  // autoPong: false — как выключенный ПК: соединение есть, ответа нет.
  const dead = new WebSocket(`${srv.url.replace('http', 'ws')}/?token=${encodeURIComponent(мёртвый.token)}&host=PC-DEAD`, { autoPong: false });
  await new Promise((resolve, reject) => { dead.once('open', resolve); dead.once('error', reject); });
  try {
    const вошёл = await окно.next((m) => m.type === 'presence-delta' && m.users[мёртвый.id] && m.users[мёртвый.id].state === 'active', 3000);
    const ушёл = await окно.next((m) => m.type === 'presence-delta' && m.users[мёртвый.id] && m.users[мёртвый.id].state === 'offline'
      && m.users[мёртвый.id].since >= вошёл.users[мёртвый.id].since, 5000);
    assert.ok(ушёл, 'мёртвое соединение снято');
    // Самая первая рассылка после запуска — на всех, «живой» в ней ещё «не в сети»: смотрим только то,
    // что пришло после его входа.
    const живойВошёл = await окно.next((m) => m.type === 'presence-delta' && m.users[живой.id] && m.users[живой.id].state === 'active', 3000);
    await new Promise((r) => setTimeout(r, 800));
    await assert.rejects(окно.next((m) => m.type === 'presence-delta' && m.users[живой.id] && m.users[живой.id].state === 'offline'
      && m.users[живой.id].since >= живойВошёл.users[живой.id].since, 300), 'отвечающий на ping остаётся в сети');
  } finally { окно.close(); ok.close(); dead.terminate(); }
});
