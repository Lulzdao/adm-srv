'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, login, makeUser, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  Группы: кто управляет, кто видит, кому доставляется
//
//  Группу может собрать любой сотрудник. Управлять ею (переименовать, добавить/убрать участников,
//  удалить) — только создатель или администратор; обычный участник может писать и выйти сам.
//  Переписка группы — комната 'group:<id>': читать историю, получать сообщения, реакции и
//  «печатает» должны только участники (администратор — читать по праву). Посторонний, подобравший
//  id группы, не должен ни написать туда, ни узнать по рассылкам, кто в ней и о чём пишут.
//
//  Имена и тексты выдуманы.
// ============================================================================

let srv, admin, создатель, участник, второй, посторонний;
before(async () => {
  srv = await startServer();
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  создатель = await makeUser(srv.url, admin.token, 'создатель-группы');
  участник = await makeUser(srv.url, admin.token, 'участник-группы');
  второй = await makeUser(srv.url, admin.token, 'второй-участник');
  посторонний = await makeUser(srv.url, admin.token, 'посторонний-группе');
});
after(() => srv && srv.stop());

const api = (кто, method, p, body) => request(srv.url, method, p, { token: кто.token, body });
const мои = async (кто) => {
  const r = await api(кто, 'GET', '/api/groups');
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const состав = async (кто, id) => {
  const r = await api(кто, 'GET', `/api/groups/${id}/members`);
  assert.equal(r.status, 200, r.text);
  return r.json.map((u) => u.id).sort((a, b) => a - b);
};
/** Создать группу от имени создателя; memberIds — без самого создателя, как часто шлёт клиент. */
const создать = async (name, members = [участник, второй], кто = создатель) => {
  const r = await api(кто, 'POST', '/api/groups', { name, memberIds: members.map((u) => u.id) });
  assert.equal(r.status, 200, r.text);
  return r.json.id;
};
const история = (кто, id) => api(кто, 'GET', `/api/history/room/${encodeURIComponent(`group:${id}`)}`);
/** true — сообщение пришло за ms, false — нет. Для проверок «не доставлено» ждём недолго. */
const пришло = (ws, pred, ms = 1500) => ws.next(pred, ms).then(() => true, () => false);

test('создатель всегда участник, даже если не отметил себя; пустое имя — 400', async () => {
  const id = await создать('Создатель не отмечен');
  assert.deepEqual(await состав(создатель, id), [создатель.id, участник.id, второй.id].sort((a, b) => a - b));

  for (const name of ['', '   ', undefined]) {
    const r = await api(создатель, 'POST', '/api/groups', { name, memberIds: [участник.id] });
    assert.equal(r.status, 400, `имя ${JSON.stringify(name)} должно отклоняться`);
  }
});

test('список групп — только свои, и число участников верное', async () => {
  const id = await создать('Видна троим');
  const чужая = await создать('Без постороннего и без второго', [участник]);

  const уСоздателя = (await мои(создатель)).find((g) => g.id === id);
  assert.ok(уСоздателя, 'создатель видит свою группу');
  assert.equal(уСоздателя.member_count, 3);
  assert.equal(уСоздателя.created_by, создатель.id);
  assert.equal((await мои(участник)).find((g) => g.id === чужая).member_count, 2);

  assert.ok(!(await мои(посторонний)).some((g) => g.id === id || g.id === чужая), 'посторонний чужих групп не видит');
  assert.ok(!(await мои(второй)).some((g) => g.id === чужая), 'участник видит только те группы, где он есть');
  // Администратор не участник — в его личном списке групп нет; доступ к ним у него по праву, ниже.
  assert.ok(!(await мои(admin)).some((g) => g.id === id));
});

test('состав группы: участнику и администратору можно, постороннему — 403', async () => {
  const id = await создать('Состав по праву');
  assert.equal((await состав(участник, id)).length, 3);
  assert.equal((await состав(admin, id)).length, 3, 'администратор видит состав, не будучи участником');
  assert.equal((await api(посторонний, 'GET', `/api/groups/${id}/members`)).status, 403);
});

test('переименовать — создатель или администратор; участнику и постороннему 403', async () => {
  const id = await создать('Старое имя');
  const имя = async () => (await мои(создатель)).find((g) => g.id === id).name;

  assert.equal((await api(участник, 'PATCH', `/api/groups/${id}`, { name: 'Захват участником' })).status, 403);
  assert.equal((await api(посторонний, 'PATCH', `/api/groups/${id}`, { name: 'Захват чужим' })).status, 403);
  assert.equal(await имя(), 'Старое имя', 'отклонённое переименование ничего не меняет');

  assert.equal((await api(создатель, 'PATCH', `/api/groups/${id}`, { name: 'Новое имя' })).status, 200);
  assert.equal(await имя(), 'Новое имя');
  assert.equal((await api(admin, 'PATCH', `/api/groups/${id}`, { name: 'Имя от админа' })).status, 200);
  assert.equal(await имя(), 'Имя от админа');

  assert.equal((await api(создатель, 'PATCH', `/api/groups/${id}`, { name: '  ' })).status, 400);
  assert.equal((await api(создатель, 'PATCH', '/api/groups/999999', { name: 'Нет такой' })).status, 404);
});

test('добавить и убрать участника — только создатель или администратор', async () => {
  const id = await создать('Управление составом', [участник]);

  // Обычный участник не может ни привести постороннего, ни выгнать соседа.
  assert.equal((await api(участник, 'POST', `/api/groups/${id}/members`, { userIds: [посторонний.id] })).status, 403);
  assert.equal((await api(посторонний, 'POST', `/api/groups/${id}/members`, { userIds: [посторонний.id] })).status, 403,
    'посторонний не может добавить в группу сам себя');
  assert.ok(!(await состав(создатель, id)).includes(посторонний.id));

  assert.equal((await api(создатель, 'POST', `/api/groups/${id}/members`, { userIds: [второй.id] })).status, 200);
  assert.ok((await состав(создатель, id)).includes(второй.id));

  assert.equal((await api(участник, 'DELETE', `/api/groups/${id}/members/${второй.id}`)).status, 403);
  assert.ok((await состав(создатель, id)).includes(второй.id), 'отклонённое удаление ничего не меняет');

  assert.equal((await api(admin, 'DELETE', `/api/groups/${id}/members/${второй.id}`)).status, 200);
  assert.ok(!(await состав(создатель, id)).includes(второй.id), 'администратор убирает участника из чужой группы');
  assert.equal((await история(второй, id)).status, 403, 'убранный из группы теряет доступ к истории');
});

test('участник выходит из группы сам; опустевшая группа исчезает', async () => {
  const id = await создать('Выход по желанию', [участник]);
  assert.equal((await api(участник, 'DELETE', `/api/groups/${id}/members/${участник.id}`)).status, 200,
    'выйти самому можно без прав управления');
  assert.ok(!(await мои(участник)).some((g) => g.id === id));
  assert.deepEqual(await состав(создатель, id), [создатель.id]);

  // Создатель вышел последним — группа удаляется целиком, иначе она висела бы невидимой даже для админа.
  assert.equal((await api(создатель, 'DELETE', `/api/groups/${id}/members/${создатель.id}`)).status, 200);
  assert.equal((await api(admin, 'PATCH', `/api/groups/${id}`, { name: 'Уже нет' })).status, 404);
});

test('удалить группу — создатель или администратор; id не переиспользуется', async () => {
  const id = await создать('На удаление');
  assert.equal((await api(участник, 'DELETE', `/api/groups/${id}`)).status, 403);
  assert.equal((await api(посторонний, 'DELETE', `/api/groups/${id}`)).status, 403);
  assert.ok((await мои(участник)).some((g) => g.id === id), 'отклонённое удаление ничего не меняет');

  assert.equal((await api(создатель, 'DELETE', `/api/groups/${id}`)).status, 200);
  assert.ok(!(await мои(участник)).some((g) => g.id === id));
  assert.equal((await api(создатель, 'DELETE', `/api/groups/${id}`)).status, 404);

  // История удалённой группы остаётся в базе под 'group:<id>'. Если бы новая группа получила тот же
  // id, её участники прочитали бы чужую старую переписку — поэтому id обязаны только расти.
  const новая = await создать('После удаления', [посторонний]);
  assert.ok(новая > id, `новая группа получила id ${новая}, удалённая была ${id}`);

  const id2 = await создать('Удалит админ');
  assert.equal((await api(admin, 'DELETE', `/api/groups/${id2}`)).status, 200);
});

test('сообщение в группу доставляется участникам и не уходит посторонним', async () => {
  const id = await создать('Живая переписка', [участник]);
  const room = `group:${id}`;
  const [wsСоздатель, wsУчастник, wsПост, wsВторой] = await Promise.all(
    [создатель, участник, посторонний, второй].map((u) => connect(srv.url, u.token)),
  );
  try {
    const текст = 'сообщение только для своих';
    const это = (m) => m.type === 'message' && m.text === текст;
    const ждём = [пришло(wsСоздатель, это), пришло(wsУчастник, это), пришло(wsПост, это), пришло(wsВторой, это)];
    wsУчастник.send({ type: 'send', room, text: текст });
    const [c, у, п, в] = await Promise.all(ждём);
    assert.equal(c, true, 'участник получил');
    assert.equal(у, true, 'отправитель получил своё (так клиент подтверждает отправку)');
    assert.equal(п, false, 'постороннему не пришло');
    assert.equal(в, false, 'не участнику этой группы не пришло');

    const r = await история(создатель, id);
    assert.equal(r.status, 200, r.text);
    // Поля room в строках истории нет — комната задана самим адресом запроса.
    assert.ok(r.json.some((m) => m.text === текст && m.from_id === участник.id));
  } finally {
    wsСоздатель.close(); wsУчастник.close(); wsПост.close(); wsВторой.close();
  }
});

test('посторонний не может написать в группу — попытка молча отбрасывается', async () => {
  const id = await создать('Закрыта от чужих', [участник]);
  const [wsУчастник, wsПост] = await Promise.all([connect(srv.url, участник.token), connect(srv.url, посторонний.token)]);
  try {
    const чужое = 'вторжение в группу';
    const метка = 'метка после вторжения';
    const ждёмЧужое = пришло(wsУчастник, (m) => m.text === чужое);
    wsПост.send({ type: 'send', room: `group:${id}`, text: чужое });
    // Сообщения одного сокета сервер разбирает по порядку: когда метка в общей комнате дошла,
    // попытка писать в группу уже точно обработана — ждать «на всякий случай» не нужно.
    wsПост.send({ type: 'send', room: 'general', text: метка });
    await wsУчастник.next((m) => m.text === метка);
    assert.equal(await ждёмЧужое, false, 'участники чужое сообщение не получили');

    const r = await история(участник, id);
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.json.some((m) => m.text === чужое), 'в историю группы чужое сообщение не попало');
  } finally {
    wsУчастник.close(); wsПост.close();
  }
});

test('историю группы читают участники и администратор, посторонний — 403', async () => {
  const id = await создать('История по праву', [участник]);
  const ws = await connect(srv.url, участник.token);
  try {
    ws.send({ type: 'send', room: `group:${id}`, text: 'запись в историю' });
    await ws.next((m) => m.text === 'запись в историю');
  } finally { ws.close(); }

  for (const кто of [создатель, участник, admin]) {
    const r = await история(кто, id);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.some((m) => m.text === 'запись в историю'));
  }
  assert.equal((await история(посторонний, id)).status, 403);
  // Поиск и календарь по дням — те же данные другим путём, закрыты так же.
  assert.equal((await api(посторонний, 'GET', `/api/history/room/group:${id}?q=${encodeURIComponent('запись')}`)).status, 403);
  assert.equal((await api(посторонний, 'GET', `/api/history/room/group:${id}/days`)).status, 403);
});

test('реакция постороннего на сообщение группы игнорируется', async () => {
  const id = await создать('Реакции своих', [участник]);
  const [wsУчастник, wsПост] = await Promise.all([connect(srv.url, участник.token), connect(srv.url, посторонний.token)]);
  try {
    wsУчастник.send({ type: 'send', room: `group:${id}`, text: 'на это отреагируют' });
    const { id: messageId } = await wsУчастник.next((m) => m.text === 'на это отреагируют');

    const ждёмРеакцию = пришло(wsУчастник, (m) => m.type === 'reaction' && m.messageId === messageId);
    wsПост.send({ type: 'react', messageId, emoji: '👎' });
    wsПост.send({ type: 'send', room: 'general', text: 'метка после реакции' });
    await wsУчастник.next((m) => m.text === 'метка после реакции');
    assert.equal(await ждёмРеакцию, false, 'рассылки о чужой реакции не было');

    const r = await история(участник, id);
    const сообщение = r.json.find((m) => m.id === messageId);
    assert.ok(сообщение, 'сообщение есть в истории');
    assert.ok(!(сообщение.reactions || []).length, `реакция постороннего не сохранилась: ${JSON.stringify(сообщение.reactions)}`);

    // А реакция участника — проходит: проверка выше не ложноположительная.
    wsУчастник.send({ type: 'react', messageId, emoji: '👍' });
    const обновление = await wsУчастник.next((m) => m.type === 'reaction' && m.messageId === messageId);
    assert.deepEqual(обновление.reactions, [{ emoji: '👍', userIds: [участник.id] }]);
  } finally {
    wsУчастник.close(); wsПост.close();
  }
});

test('«печатает» в группе уходит только другим участникам', async () => {
  const id = await создать('Кто печатает', [участник]);
  const room = `group:${id}`;
  const [wsСоздатель, wsУчастник, wsПост] = await Promise.all(
    [создатель, участник, посторонний].map((u) => connect(srv.url, u.token)),
  );
  try {
    const печатаетУчастник = (m) => m.type === 'typing' && m.room === room && m.from_id === участник.id;
    const ждём = [пришло(wsСоздатель, печатаетУчастник), пришло(wsПост, печатаетУчастник), пришло(wsУчастник, печатаетУчастник)];
    wsУчастник.send({ type: 'typing', room });
    const [c, п, сам] = await Promise.all(ждём);
    assert.equal(c, true, 'другой участник видит');
    assert.equal(п, false, 'посторонний не видит, что в группе кто-то печатает');
    assert.equal(сам, false, 'себе «печатает» не возвращается');

    // Посторонний, подставив id группы, не должен по своему «печатает» прощупать её состав.
    const печатаетЧужой = (m) => m.type === 'typing' && m.from_id === посторонний.id;
    const ждёмЧужой = [пришло(wsСоздатель, печатаетЧужой), пришло(wsУчастник, печатаетЧужой)];
    wsПост.send({ type: 'typing', room });
    assert.deepEqual(await Promise.all(ждёмЧужой), [false, false]);
  } finally {
    wsСоздатель.close(); wsУчастник.close(); wsПост.close();
  }
});

// Найдено при написании этих тестов (2026-10-06): внешние ключи в SQLite выключены, и удаление
// сотрудника чистило только user_departments, а в группы принимались любые числа. Строки-«призраки»
// завышали member_count, и группа, где из живых никого не осталось, не удалялась.
test('удалённый сотрудник не числится участником группы, несуществующий не добавляется', async () => {
  const уйдёт = await makeUser(srv.url, admin.token, 'уйдёт-из-организации');
  const id = await создать('С уходящим', [уйдёт]);
  assert.equal((await api(admin, 'DELETE', `/api/admin/users/${уйдёт.id}`)).status, 200);
  assert.equal((await мои(создатель)).find((g) => g.id === id).member_count, 1, 'удалённый не должен учитываться');

  const сПризраком = await создать('С несуществующим', [{ id: 987654 }]);
  assert.equal((await мои(создатель)).find((g) => g.id === сПризраком).member_count, 1, 'несуществующий id не должен добавляться');
  assert.equal((await api(создатель, 'POST', `/api/groups/${сПризраком}/members`, { userIds: [987655] })).status, 200);
  assert.equal((await мои(создатель)).find((g) => g.id === сПризраком).member_count, 1, 'и при добавлении участников тоже');
});

// Базы, где «призраки» уже накопились до исправления, чистятся при запуске сервера. Готовим базу
// заранее тем же openDatabase, что у сервера (схема та же): живой сотрудник id 1 и «призрак» 999.
test('«призраки», накопленные до исправления, убираются при запуске', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { openDatabase } = require('../lib/db');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iskra-ghosts-'));
  const file = path.join(tmp, 'messenger.db');
  const { db } = openDatabase(file, { logServer: () => {} });
  const now = Date.now();
  db.prepare('INSERT INTO users (id, username, password_hash, display_name, can_broadcast, can_admin, created_at) VALUES (1, ?, ?, ?, 0, 0, ?)')
    .run('живой-сотрудник', 'x', 'живой-сотрудник', now);
  db.prepare('INSERT INTO groups (id, name, created_by, created_at) VALUES (1, ?, 999, ?), (2, ?, 999, ?)').run('Живая', now, 'Только призраки', now);
  db.prepare('INSERT INTO group_members (group_id, user_id, added_at) VALUES (1, 1, ?), (1, 999, ?), (2, 999, ?)').run(now, now, now);
  db.close();
  const old = await startServer({ files: { 'messenger.db': fs.readFileSync(file) } });
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const a = await login(old.url, ADMIN.username, ADMIN.password);
    const members = await request(old.url, 'GET', '/api/groups/1/members', { token: a.token });
    assert.deepEqual(members.json.map((u) => u.id), [1], 'в живой группе остался только живой сотрудник');
    assert.equal((await request(old.url, 'PATCH', '/api/groups/2', { token: a.token, body: { name: 'x' } })).status, 404);
    assert.equal((await request(old.url, 'PATCH', '/api/groups/1', { token: a.token, body: { name: 'Живая' } })).status, 200, 'живая группа осталась');
    // Состав выше выбирается через JOIN с users и призрака не покажет в любом случае — само удаление
    // строк видно по счётчикам в журнале: два призрака (по одному в каждой группе) и одна пустая группа.
    assert.match(old.log(), /group_ghosts_removed.*"members":2.*"groups":1/);
  } finally {
    await old.stop();
  }
});

test('удалили последнего участника группы — группа удаляется', async () => {
  const один = await makeUser(srv.url, admin.token, 'единственный-в-группе');
  const id = await создать('Один в поле', [], один);
  assert.equal((await api(admin, 'DELETE', `/api/admin/users/${один.id}`)).status, 200);
  assert.equal((await api(admin, 'PATCH', `/api/groups/${id}`, { name: 'Ещё есть?' })).status, 404, 'группы без участников быть не должно');
});
