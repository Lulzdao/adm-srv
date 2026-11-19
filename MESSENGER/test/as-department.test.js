'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, login, makeUser, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  Объявление «от имени отдела» (решение пользователя 2026-11-19)
//
//  Получатели видят подписью отдел, а не автора: в ленте, в живом объявлении по WebSocket и в
//  уведомлении (from_user — название отдела, номера автора нет). Сам автор видит своё со своим
//  номером — может исправить. Подписать можно только своим отделом. Настоящего автора видит
//  администратор в панели (?all=1). Имена и тексты выдуманы.
// ============================================================================

let srv, admin, автор, читатель, двухотдельный, отделИТ, отделКадры;
before(async () => {
  srv = await startServer();
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  const mk = async (name) => (await request(srv.url, 'POST', '/api/admin/departments', { token: admin.token, body: { name } })).json.id;
  отделИТ = await mk('Отдел ИТ тестовый');
  отделКадры = await mk('Кадры тестовые');
  автор = await makeUser(srv.url, admin.token, 'Петров Пётр Петрович', { can_broadcast: true, department_ids: [отделИТ] });
  читатель = await makeUser(srv.url, admin.token, 'Сидорова Анна Ивановна', { department_ids: [отделКадры] });
  двухотдельный = await makeUser(srv.url, admin.token, 'Иванов Иван Иванович', { department_ids: [отделИТ, отделКадры] });
});
after(() => srv && srv.stop());

const отправить = (кто, body) => request(srv.url, 'POST', '/api/broadcast', { token: кто.token, body });
const найти = async (кто, text, query = '') => {
  const r = await request(srv.url, 'GET', `/api/broadcasts${query}`, { token: кто.token });
  assert.equal(r.status, 200, r.text);
  return r.json.find((b) => b.text === text);
};

test('получатели видят подписью отдел, автор — своё со своим номером, панель — настоящего автора', async () => {
  const wsЧитатель = await connect(srv.url, читатель.token);
  const wsАвтор = await connect(srv.url, автор.token);
  try {
    assert.equal((await отправить(автор, { text: 'плановые работы в субботу', asDepartmentId: отделИТ })).status, 200);

    const живое = await wsЧитатель.next((m) => m.type === 'broadcast' && m.text === 'плановые работы в субботу');
    assert.equal(живое.from_user, 'Отдел ИТ тестовый', 'подпись — отдел');
    assert.equal(живое.from_id, null, 'номера автора у получателя нет — по нему нашлось бы имя');
    assert.equal(живое.as_department, 'Отдел ИТ тестовый');
    assert.ok(!JSON.stringify(живое).includes('Петров'), 'имени автора в объявлении нет нигде');

    const своё = await wsАвтор.next((m) => m.type === 'broadcast' && m.text === 'плановые работы в субботу');
    assert.equal(своё.from_id, автор.id, 'автор получает своё с номером — окно даст исправить');
    assert.equal(своё.from_user, 'Отдел ИТ тестовый');

    const вЛенте = await найти(читатель, 'плановые работы в субботу');
    assert.equal(вЛенте.from_user, 'Отдел ИТ тестовый');
    assert.equal(вЛенте.from_id, null);
    assert.equal((await найти(автор, 'плановые работы в субботу')).from_id, автор.id);
    const поиск = await найти(читатель, 'плановые работы в субботу', '?q=плановые');
    assert.equal(поиск.from_user, 'Отдел ИТ тестовый', 'и в поиске по истории');

    const вПанели = await найти(admin, 'плановые работы в субботу', '?all=1');
    assert.equal(вПанели.from_user, 'Петров Пётр Петрович', 'панель видит настоящего автора');
    assert.equal(вПанели.as_department, 'Отдел ИТ тестовый');
  } finally { wsЧитатель.close(); wsАвтор.close(); }
});

test('подписать можно только своим отделом; несуществующий — отказ', async () => {
  const чужой = await отправить(автор, { text: 'от имени кадров', asDepartmentId: отделКадры });
  assert.equal(чужой.status, 403);
  assert.match(чужой.json.error, /своим отделом/);
  assert.equal((await отправить(автор, { text: 'от несуществующего', asDepartmentId: 999999 })).status, 400);
  assert.equal((await отправить(автор, { text: 'от кривого', asDepartmentId: 'abc' })).status, 400);
  assert.equal(await найти(читатель, 'от имени кадров'), undefined, 'отклонённое не сохраняется');
  // Право писать от флажка не появляется: без «Рассылок» всем — по-прежнему нельзя.
  assert.equal((await отправить(двухотдельный, { text: 'всем от отдела без права', asDepartmentId: отделИТ })).status, 403);
});

test('сообщение отделу от имени другого своего отдела; автор исправляет своё', async () => {
  assert.equal((await отправить(двухотдельный, { text: 'кадрам от ИТ', departmentId: отделКадры, asDepartmentId: отделИТ })).status, 200);
  const у = await найти(читатель, 'кадрам от ИТ');
  assert.equal(у.from_user, 'Отдел ИТ тестовый');
  assert.equal(у.department, 'Кадры тестовые');

  const своё = await найти(двухотдельный, 'кадрам от ИТ');
  const r = await request(srv.url, 'PATCH', `/api/broadcast/${своё.id}`, { token: двухотдельный.token, body: { text: 'кадрам от ИТ, исправлено' } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await найти(читатель, 'кадрам от ИТ, исправлено')).from_user, 'Отдел ИТ тестовый', 'после правки подпись та же');
  const чужая = await request(srv.url, 'PATCH', `/api/broadcast/${своё.id}`, { token: читатель.token, body: { text: 'подмена' } });
  assert.equal(чужая.status, 403, 'исправить может только автор, хоть номер и скрыт');
});

test('без флажка — как раньше, подписано автором', async () => {
  assert.equal((await отправить(автор, { text: 'обычное объявление' })).status, 200);
  const b = await найти(читатель, 'обычное объявление');
  assert.equal(b.from_user, 'Петров Пётр Петрович');
  assert.equal(b.from_id, автор.id);
  assert.equal(b.as_department_id, null);
});
