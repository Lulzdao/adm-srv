'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, login, makeUser, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  Правка своего сообщения и объявления («изменено», как в Telegram)
// ============================================================================

let srv, admin, анна, борис;
before(async () => {
  srv = await startServer();
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  анна = await makeUser(srv.url, admin.token, 'анна-правка');
  борис = await makeUser(srv.url, admin.token, 'борис-правка');
});
after(() => srv && srv.stop());

test('сообщение: исправляет только автор, собеседник получает правку, в истории — «изменено»', async () => {
  const wsА = await connect(srv.url, анна.token);
  const wsБ = await connect(srv.url, борис.token);
  try {
    wsА.send({ type: 'send', to: борис.id, text: 'встреча в 10' });
    const { id } = await wsБ.next((m) => m.type === 'message' && m.text === 'встреча в 10');

    // Чужое сообщение исправить нельзя: Борис пробует — ничего не меняется.
    wsБ.send({ type: 'edit', id, text: 'подделка' });
    wsА.send({ type: 'edit', id, text: 'встреча в 11' });
    const правка = await wsБ.next((m) => m.type === 'message_edited' && m.id === id);
    assert.equal(правка.text, 'встреча в 11');
    assert.ok(правка.edited_at > 0);

    const r = await request(srv.url, 'GET', `/api/history/dm/${анна.id}`, { token: борис.token });
    const m = r.json.find((x) => x.id === id);
    assert.equal(m.text, 'встреча в 11', 'в истории — исправленный текст, не «подделка»');
    assert.ok(m.edited_at > 0, 'в истории есть отметка правки');

    // Пустым текст сообщения без файлов сделать нельзя.
    wsА.send({ type: 'edit', id, text: '   ' });
    wsА.send({ type: 'send', to: борис.id, text: 'метка' });
    await wsБ.next((x) => x.text === 'метка');
    const r2 = await request(srv.url, 'GET', `/api/history/dm/${анна.id}`, { token: борис.token });
    assert.equal(r2.json.find((x) => x.id === id).text, 'встреча в 11');
  } finally { wsА.close(); wsБ.close(); }
});

test('объявление: исправляет только автор с правом рассылки, все получают правку', async () => {
  const автор = await makeUser(srv.url, admin.token, 'автор-объявлений', { can_broadcast: true });
  const wsБ = await connect(srv.url, борис.token);
  try {
    assert.equal((await request(srv.url, 'POST', '/api/broadcast', { token: автор.token, body: { text: 'Субботник в пятницу' } })).status, 200);
    const { id } = await wsБ.next((m) => m.type === 'broadcast' && m.text === 'Субботник в пятницу');

    assert.equal((await request(srv.url, 'PATCH', `/api/broadcast/${id}`, { token: борис.token, body: { text: 'чужая правка' } })).status, 403);
    const r = await request(srv.url, 'PATCH', `/api/broadcast/${id}`, { token: автор.token, body: { text: 'Субботник в субботу' } });
    assert.equal(r.status, 200, r.text);
    const правка = await wsБ.next((m) => m.type === 'broadcast_edited' && m.id === id);
    assert.equal(правка.text, 'Субботник в субботу');

    const лента = await request(srv.url, 'GET', '/api/broadcasts', { token: борис.token });
    const b = лента.json.find((x) => x.id === id);
    assert.equal(b.text, 'Субботник в субботу');
    assert.ok(b.edited_at > 0);
    assert.equal((await request(srv.url, 'PATCH', `/api/broadcast/${id}`, { token: автор.token, body: { text: '' } })).status, 400);
  } finally { wsБ.close(); }
});
