'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, login, makeUser, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  Удаление своего сообщения (решение пользователя 2026-10-22)
//
//  Человек написал не тому и сразу удалил: у получателя сообщение пропадает. Удаление «мягкое» —
//  в базе строка остаётся, участникам переписки её больше не видно (история, поиск, счётчики),
//  а администратор в «Переписках» веб-панели видит её с отметкой deleted_at.
// ============================================================================

let srv, admin, анна, борис, вера;
before(async () => {
  srv = await startServer();
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  анна = await makeUser(srv.url, admin.token, 'анна-удаление');
  борис = await makeUser(srv.url, admin.token, 'борис-удаление');
  вера = await makeUser(srv.url, admin.token, 'вера-удаление');
});
after(() => srv && srv.stop());

const dmOf = async (token, peer) => (await request(srv.url, 'GET', `/api/history/dm/${peer}`, { token })).json;

test('личное: удаляет только автор, у получателя пропадает, у администратора — с отметкой', async () => {
  const wsА = await connect(srv.url, анна.token);
  const wsБ = await connect(srv.url, борис.token);
  try {
    wsА.send({ type: 'send', to: борис.id, text: 'это не тебе' });
    const { id } = await wsБ.next((m) => m.type === 'message' && m.text === 'это не тебе');
    assert.equal((await request(srv.url, 'GET', '/api/unread-dms', { token: борис.token })).json[анна.id], 1);

    // Чужое удалить нельзя: Борис пробует — сообщение на месте.
    wsБ.send({ type: 'delete', id });
    wsА.send({ type: 'send', to: борис.id, text: 'метка-1' });
    await wsБ.next((m) => m.text === 'метка-1');
    assert.ok((await dmOf(борис.token, анна.id)).some((m) => m.id === id), 'чужое не удалилось');

    wsА.send({ type: 'delete', id });
    const у_получателя = await wsБ.next((m) => m.type === 'message_deleted' && m.id === id);
    assert.equal(у_получателя.unread, true, 'Борис не читал — его клиент убавит счётчик');
    assert.equal(у_получателя.from_id, анна.id);
    await wsА.next((m) => m.type === 'message_deleted' && m.id === id); // и другим окнам автора

    assert.ok(!(await dmOf(борис.token, анна.id)).some((m) => m.id === id), 'у получателя в истории нет');
    assert.ok(!(await dmOf(анна.token, борис.id)).some((m) => m.id === id), 'у автора в истории нет');
    const поиск = await request(srv.url, 'GET', `/api/history/dm/${анна.id}?q=${encodeURIComponent('не тебе')}`, { token: борис.token });
    assert.deepEqual(поиск.json, [], 'поиском не находится');
    assert.equal((await request(srv.url, 'GET', '/api/unread-dms', { token: борис.token })).json[анна.id], 1, 'непрочитанным осталось только «метка-1»');

    const уАдмина = await request(srv.url, 'GET', `/api/admin/history/dm/${анна.id}/${борис.id}`, { token: admin.token });
    const m = уАдмина.json.find((x) => x.id === id);
    assert.ok(m, 'администратор видит удалённое');
    assert.equal(m.text, 'это не тебе', 'текст сохранён');
    assert.ok(m.deleted_at > 0);
    const лента = await request(srv.url, 'GET', '/api/admin/history/all', { token: admin.token });
    assert.ok(лента.json.find((x) => x.id === id).deleted_at > 0, 'и в ленте всех сообщений');

    // Удалённое не исправить, на него не ответить и не поставить реакцию.
    wsА.send({ type: 'edit', id, text: 'воскрешение' });
    wsА.send({ type: 'react', id, emoji: '👍' });
    wsБ.send({ type: 'send', to: анна.id, text: 'ответ на удалённое', replyTo: id });
    const ответ = await wsА.next((x) => x.type === 'message' && x.text === 'ответ на удалённое');
    assert.equal(ответ.reply, null, 'цитаты удалённого нет');
    const после = await request(srv.url, 'GET', `/api/admin/history/dm/${анна.id}/${борис.id}`, { token: admin.token });
    assert.equal(после.json.find((x) => x.id === id).text, 'это не тебе', 'правка удалённого не прошла');
    await assert.rejects(wsБ.next((x) => x.type === 'message_edited' || x.type === 'reaction', 300), 'ни правки, ни реакции не разослано');
  } finally { wsА.close(); wsБ.close(); }
});

test('группа: удаление видят все участники, прочитанное личное приходит с unread=false', async () => {
  const g = await request(srv.url, 'POST', '/api/groups', { token: анна.token, body: { name: 'удаление-группа', memberIds: [борис.id] } });
  assert.equal(g.status, 200, g.text);
  const room = `group:${g.json.id}`;
  const wsА = await connect(srv.url, анна.token);
  const wsБ = await connect(srv.url, борис.token);
  const wsВ = await connect(srv.url, вера.token);
  try {
    wsА.send({ type: 'send', room, text: 'в группу по ошибке' });
    const { id } = await wsБ.next((m) => m.type === 'message' && m.text === 'в группу по ошибке');
    wsА.send({ type: 'delete', id });
    const у_бориса = await wsБ.next((m) => m.type === 'message_deleted' && m.id === id);
    assert.equal(у_бориса.room, room);
    assert.equal(у_бориса.unread, false, 'в группе счётчика непрочитанных личных нет');
    await assert.rejects(wsВ.next((m) => m.type === 'message_deleted', 300), 'вера не в группе — ей ничего');
    const история = await request(srv.url, 'GET', `/api/history/room/${room}`, { token: борис.token });
    assert.ok(!история.json.some((m) => m.id === id));
    const уАдмина = await request(srv.url, 'GET', `/api/admin/history/room/${room}`, { token: admin.token });
    assert.ok(уАдмина.json.find((m) => m.id === id).deleted_at > 0);
  } finally { wsА.close(); wsБ.close(); wsВ.close(); }
});
