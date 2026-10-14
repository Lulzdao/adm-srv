'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, request, login, makeUser, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  Лента всех последних сообщений (скрытая кнопка в «Переписках» панели)
//
//  Личные, группы и общая комната вперемешку, с подписью «где написано»; только администратору;
//  каждое открытие пишется в журнал. Имена и тексты выдуманы.
// ============================================================================

let srv, admin, анна, борис;
before(async () => {
  srv = await startServer();
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  анна = await makeUser(srv.url, admin.token, 'анна');
  борис = await makeUser(srv.url, admin.token, 'борис');
});
after(() => srv && srv.stop());

async function say(кто, msg) {
  const ws = await connect(srv.url, кто.token);
  try {
    ws.send({ type: 'send', ...msg });
    await ws.next((m) => m.type === 'message' && m.text === msg.text, 2000);
  } finally { ws.close(); }
}

test('все последние сообщения одной лентой — с подписью, где написано; только администратору', async () => {
  const группа = await request(srv.url, 'POST', '/api/groups', { token: анна.token, body: { name: 'Проектная', memberIds: [борис.id] } });
  assert.equal(группа.status, 200, группа.text);
  await say(анна, { to: борис.id, text: 'лично Борису' });
  await say(борис, { room: 'general', text: 'всем в общей' });
  await say(анна, { room: `group:${группа.json.id}`, text: 'в группу' });

  const r = await request(srv.url, 'GET', '/api/admin/history/all', { token: admin.token });
  assert.equal(r.status, 200, r.text);
  const byText = Object.fromEntries(r.json.map((m) => [m.text, m]));
  assert.equal(byText['лично Борису'].place, 'лично → борис');
  assert.equal(byText['всем в общей'].place, 'общая комната');
  assert.equal(byText['в группу'].place, 'группа «Проектная»');
  assert.equal(byText['лично Борису'].from_user, 'анна');
  const ids = r.json.map((m) => m.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'старые сверху, новые снизу');

  // Более ранние — по ?before=.
  const раньше = await request(srv.url, 'GET', `/api/admin/history/all?before=${byText['в группу'].id}`, { token: admin.token });
  assert.ok(раньше.json.every((m) => m.id < byText['в группу'].id));
  assert.ok(раньше.json.some((m) => m.text === 'лично Борису'));

  assert.equal((await request(srv.url, 'GET', '/api/admin/history/all', { token: анна.token })).status, 403, 'не администратору — отказ');

  await new Promise((res) => setTimeout(res, 200));
  const dir = path.join(srv.dir, 'logs');
  const log = fs.readdirSync(dir, { recursive: true }).filter((f) => /server-.*\.log$/.test(String(f)))
    .map((f) => fs.readFileSync(path.join(dir, String(f)), 'utf8')).join('');
  assert.equal((log.match(/admin_all_messages_viewed/g) || []).length, 1, 'открытие ленты записано один раз, листание — нет');
});
