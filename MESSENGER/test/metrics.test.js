'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createMetrics, hourSummary, routeGroup, wsType, MINUTE } = require('../lib/metrics');
const { startServer, request, login, makeUser, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  Нагрузка на сервер (lib/metrics.js, раздел «Нагрузка» панели)
// ============================================================================

test('запросы раскладываются по группам: числа и имена файлов в пути не плодят строки', () => {
  assert.equal(routeGroup('GET', '/api/history/dm/15?since=1&until=2'), 'GET /api/history/dm/:id');
  assert.equal(routeGroup('GET', '/api/history/room/group:7'), 'GET /api/history/room/:группа');
  assert.equal(routeGroup('GET', '/uploads/170000-abc-отчёт.pdf?token=x'), 'GET /uploads/*');
  assert.equal(routeGroup('GET', '/updates/win10/iskra-setup-win10-1.0.28.exe'), 'GET /updates/* (обновления клиентов)');
  assert.equal(routeGroup('GET', '/panel.js'), 'GET панель (страницы, стили, скрипты)');
  assert.equal(wsType('{"type":"presence","users":{}}'), 'presence');
  assert.equal(wsType('мусор'), 'другое');
});

test('минуты складываются в сводку: итоги, ряд для графика, таблицы по трафику', () => {
  let t = Date.UTC(2026, 9, 14, 10, 0, 5);
  const m = createMetrics({ now: () => t });
  m.http({ method: 'GET', url: '/api/users', status: 200, bytesOut: 1000, ms: 20, clientKey: 'Анна' });
  m.http({ method: 'POST', url: '/api/upload', status: 200, bytesIn: 50000, bytesOut: 100, ms: 300, clientKey: 'Борис' });
  m.ws('in', '{"type":"status","state":"active"}', 'Анна');
  m.ws('out', '{"type":"presence","users":{}}', 'Анна');
  m.wsConnect();
  m.gauges({ connections: 5, users: 3, lagMaxMs: 12 });
  t += MINUTE; // следующая минута
  m.http({ method: 'GET', url: '/api/users', status: 500, bytesOut: 10, ms: 5, clientKey: 'Анна' });
  m.wsClose(true);
  m.gauges({ connections: 2, lagMaxMs: 3000 });

  const s = m.summary(5);
  assert.equal(s.series.length, 5, 'ряд — по минуте, пустые минуты тоже есть');
  assert.equal(s.totals.requests, 3);
  assert.equal(s.totals.bytesIn, 50000);
  assert.equal(s.totals.err5, 1);
  assert.equal(s.totals.drops, 1);
  assert.equal(s.totals.maxConnections, 5);
  assert.equal(s.totals.maxLagMs, 3000);
  assert.equal(s.groups[0].name, 'POST /api/upload', 'по трафику первым — тяжёлый запрос');
  const users = s.groups.find((g) => g.name === 'GET /api/users');
  assert.deepEqual([users.count, users.err, users.msMax], [2, 1, 20]);
  assert.equal(s.clients[0].name, 'Борис');
  assert.equal(s.clients.find((c) => c.name === 'Анна').wsMessages, 2);
  assert.deepEqual(s.wsTypes.map((w) => `${w.dir}:${w.type}`).sort(), ['in:status', 'out:presence']);

  const h = hourSummary(s);
  assert.equal(h.requests, 3);
  assert.match(h.topRoutes, /^POST \/api\/upload/);
});

test('хранятся последние сутки, не больше', () => {
  let t = Date.UTC(2026, 9, 14, 0, 0, 0);
  const m = createMetrics({ now: () => t });
  m.http({ method: 'GET', url: '/a', status: 200, bytesOut: 1, ms: 1 });
  t += 25 * 60 * MINUTE; // через 25 часов
  m.http({ method: 'GET', url: '/b', status: 200, bytesOut: 1, ms: 1 });
  assert.equal(m.summary(24 * 60).totals.requests, 1, 'то, что старше суток, выброшено');
});

// --- на настоящем сервере ---
let srv, admin, анна;
before(async () => {
  srv = await startServer();
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  анна = await makeUser(srv.url, admin.token, 'анна');
});
after(() => srv && srv.stop());

test('раздел «Нагрузка»: сервер считает запросы и сообщения; видит только администратор', async () => {
  const ws = await connect(srv.url, анна.token);
  try {
    ws.send({ type: 'status', state: 'active' });
    await request(srv.url, 'GET', '/api/users', { token: анна.token });
    await new Promise((r) => setTimeout(r, 200));
    const r = await request(srv.url, 'GET', '/api/admin/load?minutes=10', { token: admin.token });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.totals.requests > 0, 'запросы посчитаны');
    assert.ok(r.json.groups.some((g) => g.name === 'GET /api/users'), 'группа запроса есть');
    assert.ok(r.json.wsTypes.some((w) => w.dir === 'in' && w.type === 'status'), 'сообщение по линии посчитано');
    assert.ok(r.json.clients.some((c) => c.name === 'анна'), 'трафик по сотруднику');
    assert.ok(r.json.now.connections >= 1);
    assert.equal(r.json.series.length, 10);
    assert.equal((await request(srv.url, 'GET', '/api/admin/load', { token: анна.token })).status, 403);
  } finally { ws.close(); }
});

// --- Нагрузка переживает перезапуск службы ---
test('минуты отдаются на сохранение и загружаются обратно; старше суток — нет', () => {
  let t = Date.UTC(2026, 9, 15, 10, 0, 0);
  const a = createMetrics({ now: () => t });
  a.http({ method: 'GET', url: '/api/users', status: 200, bytesOut: 500, ms: 3, clientKey: 'Анна' });
  a.ws('in', '{"type":"status"}', 'Анна');
  const saved = JSON.parse(JSON.stringify(a.takeDirty())); // как через базу: в JSON и обратно
  assert.equal(saved.length, 1);
  assert.equal(a.takeDirty().length, 0, 'отметки сняты');

  const b = createMetrics({ now: () => t + 5 * MINUTE });
  assert.equal(b.load([...saved, { t: t - 25 * 60 * MINUTE }]), 1, 'старше суток не грузится');
  const s = b.summary(60);
  assert.equal(s.totals.requests, 1);
  assert.equal(s.groups[0].name, 'GET /api/users');
  assert.equal(s.clients[0].name, 'Анна');
  assert.equal(s.wsTypes[0].type, 'status');
});

test('сервер после перезапуска помнит нагрузку', async () => {
  const s2 = await startServer({ env: { METRICS_SAVE_MS: '200' } });
  try {
    const adm = await login(s2.url, ADMIN.username, ADMIN.password);
    for (let i = 0; i < 5; i++) await request(s2.url, 'GET', '/api/users', { token: adm.token });
    await new Promise((r) => setTimeout(r, 700)); // сохранение успело пройти
    await s2.restart();
    const adm2 = await login(s2.url, ADMIN.username, ADMIN.password);
    const r = await request(s2.url, 'GET', '/api/admin/load?minutes=60', { token: adm2.token });
    const users = r.json.groups.find((g) => g.name === 'GET /api/users');
    assert.ok(users && users.count >= 5, `запросы до перезапуска на месте: ${JSON.stringify(users)}`);
    assert.match(s2.log(), /load_history_restored/);
  } finally { await s2.stop(); }
});
