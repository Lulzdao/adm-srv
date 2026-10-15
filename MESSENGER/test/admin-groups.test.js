'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, login, makeUser, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  «Переписки» панели: все группы для администратора (GET /api/admin/groups)
// ============================================================================

let srv, admin, анна, борис;
before(async () => {
  srv = await startServer();
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  анна = await makeUser(srv.url, admin.token, 'анна-группы');
  борис = await makeUser(srv.url, admin.token, 'борис-группы');
});
after(() => srv && srv.stop());

test('администратор видит все группы — и те, где сам не состоит, — и открывает их переписку', async () => {
  const r0 = await request(srv.url, 'POST', '/api/groups', { token: анна.token, body: { name: 'Годовой отчёт', memberIds: [борис.id] } });
  assert.equal(r0.status, 200, r0.text);
  const gid = r0.json.id;
  const ws = await connect(srv.url, анна.token);
  try {
    ws.send({ type: 'send', room: `group:${gid}`, text: 'сдаём в пятницу' });
    await ws.next((m) => m.type === 'message' && m.text === 'сдаём в пятницу');
  } finally { ws.close(); }

  const r = await request(srv.url, 'GET', '/api/admin/groups', { token: admin.token });
  assert.equal(r.status, 200, r.text);
  const g = r.json.groups.find((x) => x.id === gid);
  assert.deepEqual([g.name, g.member_count, g.messages], ['Годовой отчёт', 2, 1]);
  assert.equal(r.json.generalMessages, 0, 'в старой общей комнате пусто — пункт в панели не покажется');

  const h = await request(srv.url, 'GET', `/api/admin/history/room/${encodeURIComponent(`group:${gid}`)}`, { token: admin.token });
  assert.equal(h.status, 200, h.text);
  assert.deepEqual(h.json.map((m) => m.text), ['сдаём в пятницу']);

  assert.equal((await request(srv.url, 'GET', '/api/admin/groups', { token: анна.token })).status, 403, 'не администратору — нельзя');
});
