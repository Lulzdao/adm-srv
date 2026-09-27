'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, login, makeUser, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  Объявления: кто что видит и кто что может отправить
//
//  Объявление всей организации — только с правом can_broadcast. Написать отделу может
//  любой, а читать ленту отдела — его сотрудники (и автор — своё). Общая лента каждому
//  показывает объявления всем + своих отделов + своё; поиск и календарь по дням —
//  по тем же правилам. Администратор видит всё только по явному ?all=1.
//
//  Имена и тексты выдуманы.
// ============================================================================

let srv, admin, вещатель, бухгалтер, кадровик, посторонний, отделБух, отделКадры;
before(async () => {
  srv = await startServer();
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  const mk = async (name) => (await request(srv.url, 'POST', '/api/admin/departments', { token: admin.token, body: { name } })).json.id;
  отделБух = await mk('Бухгалтерия тестовая');
  отделКадры = await mk('Кадры тестовые');
  вещатель = await makeUser(srv.url, admin.token, 'вещатель', { can_broadcast: true });
  бухгалтер = await makeUser(srv.url, admin.token, 'бухгалтер', { department_ids: [отделБух] });
  кадровик = await makeUser(srv.url, admin.token, 'кадровик', { department_ids: [отделКадры] });
  посторонний = await makeUser(srv.url, admin.token, 'посторонний');
});
after(() => srv && srv.stop());

const отправить = (кто, body) => request(srv.url, 'POST', '/api/broadcast', { token: кто.token, body });
const лента = async (кто, query = '') => {
  const r = await request(srv.url, 'GET', `/api/broadcasts${query}`, { token: кто.token });
  assert.equal(r.status, 200, r.text);
  return r.json.map((b) => b.text);
};

test('объявление всей организации — только с правом рассылки', async () => {
  assert.equal((await отправить(посторонний, { text: 'всем без права' })).status, 403);
  assert.equal((await отправить(вещатель, { text: 'всем от вещателя' })).status, 200);
  for (const кто of [бухгалтер, кадровик, посторонний]) {
    assert.ok((await лента(кто)).includes('всем от вещателя'), 'объявление всем видят все');
  }
  assert.ok(!(await лента(посторонний)).includes('всем без права'), 'отклонённое не сохраняется');
});

test('объявление отделу видят его сотрудники и автор — и никто больше', async () => {
  // Написать отделу может любой — даже не его сотрудник.
  assert.equal((await отправить(кадровик, { text: 'бухгалтерии от кадров', departmentId: отделБух })).status, 200);
  assert.ok((await лента(бухгалтер)).includes('бухгалтерии от кадров'), 'сотрудник отдела видит');
  assert.ok((await лента(кадровик)).includes('бухгалтерии от кадров'), 'автор видит своё, хотя сам не в отделе');
  assert.ok(!(await лента(посторонний)).includes('бухгалтерии от кадров'), 'посторонний не видит');
  assert.ok(!(await лента(вещатель)).includes('бухгалтерии от кадров'), 'право рассылки не даёт читать чужие отделы');
});

test('ленту отдела читают только его сотрудники; администратор — по праву', async () => {
  await отправить(бухгалтер, { text: 'внутри бухгалтерии', departmentId: отделБух });
  assert.ok((await лента(бухгалтер, `?departmentId=${отделБух}`)).includes('внутри бухгалтерии'));
  const чужой = await request(srv.url, 'GET', `/api/broadcasts?departmentId=${отделБух}`, { token: посторонний.token });
  assert.equal(чужой.status, 403);
  assert.equal((await request(srv.url, 'GET', '/api/broadcasts?departmentId=abc', { token: бухгалтер.token })).status, 400);
  assert.ok((await лента(admin, `?departmentId=${отделБух}`)).includes('внутри бухгалтерии'));
});

test('?all=1 раскрывает всё только администратору', async () => {
  await отправить(кадровик, { text: 'только кадрам', departmentId: отделКадры });
  assert.ok((await лента(admin, '?all=1')).includes('только кадрам'));
  assert.ok(!(await лента(посторонний, '?all=1')).includes('только кадрам'), 'у не-админа all=1 молча игнорируется');
});

test('поиск и календарь по дням не показывают чужих объявлений', async () => {
  await отправить(кадровик, { text: 'секретный приказ кадрам', departmentId: отделКадры });
  assert.deepEqual(await лента(посторонний, `?q=${encodeURIComponent('секретный приказ')}`), []);
  assert.deepEqual(await лента(кадровик, `?q=${encodeURIComponent('секретный приказ')}`), ['секретный приказ кадрам']);

  const дни = async (кто) => {
    const r = await request(srv.url, 'GET', '/api/broadcasts/days', { token: кто.token });
    assert.equal(r.status, 200, r.text);
    return r.json.reduce((sum, d) => sum + d.count, 0);
  };
  assert.ok((await дни(кадровик)) > (await дни(посторонний)), 'в счётчике по дням чужие объявления не учитываются');
});

test('неверный отдел и пустое объявление отклоняются', async () => {
  assert.equal((await отправить(бухгалтер, { text: 'в никуда', departmentId: 999999 })).status, 400);
  assert.equal((await отправить(вещатель, { text: '   ' })).status, 400);
});

test('по WebSocket объявление отделу приходит только адресатам', async () => {
  const [wsБух, wsПост, wsАвтор] = await Promise.all([
    connect(srv.url, бухгалтер.token), connect(srv.url, посторонний.token), connect(srv.url, кадровик.token),
  ]);
  try {
    const текст = 'живое объявление бухгалтерии';
    const пришло = (ws) => ws.next((m) => m.type === 'broadcast' && m.text === текст, 1500).then(() => true, () => false);
    const ждём = [пришло(wsБух), пришло(wsПост), пришло(wsАвтор)];
    assert.equal((await отправить(кадровик, { text: текст, departmentId: отделБух })).status, 200);
    const [бух, пост, автор] = await Promise.all(ждём);
    assert.equal(бух, true, 'сотрудник отдела получил');
    assert.equal(автор, true, 'автор получил своё');
    assert.equal(пост, false, 'постороннему не пришло');
  } finally {
    wsБух.close(); wsПост.close(); wsАвтор.close();
  }
});
