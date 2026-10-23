'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, login, makeUser, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  Адреса ПК для подключения администратора (2026-10-23)
//
//  Имена компьютеров сети in.local из rosstat.local не находятся: DNS их не знает. Клиент сообщает
//  серверу IPv4 своего ПК (ключ ip), администратор получает их и подключается по адресу. Ввод чужой:
//  только IPv4, не больше четырёх; адреса — только администраторам.
// ============================================================================

let srv, admin, анна;
before(async () => {
  srv = await startServer();
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  анна = await makeUser(srv.url, admin.token, 'анна-адреса');
});
after(() => srv && srv.stop());

const addrsOf = (token, host) => request(srv.url, 'GET', `/api/admin/host-addresses/${encodeURIComponent(host)}`, { token });

test('клиент сообщил адреса — администратор их получает; мусор отброшен, не больше четырёх', async () => {
  const ws = await connect(srv.url, анна.token, {
    host: 'P48-INLOCAL-07',
    ip: '192.168.254.33,10.0.0.5,999.1.1.1,-connect evil,192.168.254.33,172.19.0.1,10.1.1.1,10.2.2.2',
  });
  try {
    const r = await addrsOf(admin.token, 'P48-INLOCAL-07');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.addresses, ['192.168.254.33', '10.0.0.5', '172.19.0.1', '10.1.1.1']);
    assert.ok(r.json.updatedAt > 0);
  } finally { ws.close(); }

  // Ушёл из сети — последнее известное остаётся (ПК мог остаться включённым).
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual((await addrsOf(admin.token, 'P48-INLOCAL-07')).json.addresses[0], '192.168.254.33');

  // Адрес сменился (DHCP) — запомнен новый.
  const ws2 = await connect(srv.url, анна.token, { host: 'P48-INLOCAL-07', ip: '192.168.254.40' });
  try { assert.deepEqual((await addrsOf(admin.token, 'P48-INLOCAL-07')).json.addresses, ['192.168.254.40']); }
  finally { ws2.close(); }
});

test('адреса чужих ПК — только администратору; неизвестный ПК — пустой список', async () => {
  const ws = await connect(srv.url, анна.token, { host: 'P48-INLOCAL-08', ip: '192.168.254.50' });
  try {
    assert.equal((await addrsOf(анна.token, 'P48-INLOCAL-08')).status, 403);
    assert.deepEqual((await addrsOf(admin.token, 'нет-такого')).json.addresses, []);
  } finally { ws.close(); }
  // Клиент без адресов (до 1.1.32) прежние не стирает.
  const old = await connect(srv.url, анна.token, { host: 'P48-INLOCAL-08' });
  try { assert.deepEqual((await addrsOf(admin.token, 'P48-INLOCAL-08')).json.addresses, ['192.168.254.50']); }
  finally { old.close(); }
});
