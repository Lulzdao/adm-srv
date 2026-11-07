'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, login, makeUser, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  Отправка с подтверждением: номер отправки (cid) в эхе и повтор без дубля
//
//  Сообщение, отправленное в тихий обрыв сети, уходило в мёртвое соединение и пропадало молча
//  (найдено 2026-10-26 на Win7-ВМ). Клиент 1.1.33+ держит его «отправляется», пока не увидит эхо со
//  своим номером, и повторяет. Повтор того, что уже записано, сервер второй раз не пишет.
// ============================================================================

let srv, admin, анна, борис;
before(async () => {
  srv = await startServer();
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  анна = await makeUser(srv.url, admin.token, 'анна-подтверждение');
  борис = await makeUser(srv.url, admin.token, 'борис-подтверждение');
});
after(() => srv && srv.stop());

test('эхо несёт номер отправки; повтор с тем же номером — без второго сообщения, но с эхом', async () => {
  const wsА = await connect(srv.url, анна.token);
  const wsБ = await connect(srv.url, борис.token);
  try {
    const cid = 'cid-' + Date.now().toString(36) + 'abc';
    wsА.send({ type: 'send', to: борис.id, text: 'с подтверждением', cid });
    const эхо = await wsА.next((m) => m.type === 'message' && m.text === 'с подтверждением');
    assert.equal(эхо.cid, cid, 'отправитель видит свой номер');
    await wsБ.next((m) => m.type === 'message' && m.text === 'с подтверждением');

    wsА.send({ type: 'send', to: борис.id, text: 'с подтверждением', cid }); // повтор: эхо потерялось
    const эхо2 = await wsА.next((m) => m.type === 'message' && m.cid === cid);
    assert.equal(эхо2.id, эхо.id, 'то же сообщение, не новое');
    await assert.rejects(wsБ.next((m) => m.type === 'message' && m.text === 'с подтверждением', 400), 'получателю повтор не приходит');
    const h = await request(srv.url, 'GET', `/api/history/dm/${борис.id}`, { token: анна.token });
    assert.equal(h.json.filter((m) => m.text === 'с подтверждением').length, 1, 'в базе одно сообщение');

    wsА.send({ type: 'send', to: борис.id, text: 'кривой номер', cid: 'плохой номер!' });
    const без = await wsА.next((m) => m.type === 'message' && m.text === 'кривой номер');
    assert.equal(без.cid, undefined, 'негодный номер не возвращается — как у старого клиента');
  } finally { wsА.close(); wsБ.close(); }
});
