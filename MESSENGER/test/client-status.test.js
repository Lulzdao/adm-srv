'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, login, makeUser, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  Состояние обновления машины в панели «Клиенты» (сообщение 'client-status', клиент 1.0.30+)
// ============================================================================

let srv, admin, анна;
before(async () => {
  srv = await startServer();
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  анна = await makeUser(srv.url, admin.token, 'анна-статус');
});
after(() => srv && srv.stop());

test('клиент сообщает, как обновляется и что сделало задание; панель это видит', async () => {
  const ws = await connect(srv.url, анна.token, { host: 'PC-STATUS', ver: '1.0.30', track: 'win10', adm: 0 });
  try {
    ws.send({
      type: 'client-status',
      updater: {
        plan: 'task',
        last: { state: 'downloaded', version: '1.0.30', from: '1.0.29', at: 1791990000000, detail: 'x'.repeat(500), лишнее: 'не должно дойти' },
        мусор: true,
      },
    });
    // Сообщения обрабатываются по порядку: дождёмся ответа на следующее — и статус уже записан.
    ws.send({ type: 'status', state: 'active' });
    await new Promise((r) => setTimeout(r, 200));
    const r = await request(srv.url, 'GET', '/api/admin/clients', { token: admin.token });
    assert.equal(r.status, 200, r.text);
    const m = r.json.find((c) => c.hostname === 'PC-STATUS');
    assert.ok(m, 'машина в списке');
    assert.equal(m.updater.plan, 'task');
    assert.equal(m.updater.last.state, 'downloaded');
    assert.equal(m.updater.last.version, '1.0.30');
    assert.equal(m.updater.last.detail.length, 200, 'длинная строка обрезана');
    assert.equal(m.updater.last['лишнее'], undefined, 'неизвестные поля не сохраняются');
    assert.equal(m.updater['мусор'], undefined);

    // Неизвестный способ обновления не принимается как есть.
    ws.send({ type: 'client-status', updater: { plan: 'взлом', last: null } });
    await new Promise((r2) => setTimeout(r2, 200));
    const r2 = await request(srv.url, 'GET', '/api/admin/clients', { token: admin.token });
    assert.equal(r2.json.find((c) => c.hostname === 'PC-STATUS').updater.plan, null);
  } finally { ws.close(); }
});
