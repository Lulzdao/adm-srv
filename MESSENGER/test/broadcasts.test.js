'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, request, login, makeUser, connect, upload, ADMIN } = require('./helpers/server');

// ============================================================================
//  Объявления: кто что видит и кто что может отправить
//
//  Объявление всей организации — только с правом can_broadcast. Написать отделу могут его
//  сотрудники, а любому отделу — тот, у кого есть can_broadcast или can_admin (решение
//  2026-10-14; раньше — любой). Читать ленту отдела — его сотрудники (и автор — своё). Общая лента каждому
//  показывает объявления всем + своих отделов + своё; поиск и календарь по дням —
//  по тем же правилам. Администратор видит всё только по явному ?all=1.
//
//  Имена и тексты выдуманы.
// ============================================================================

let srv, admin, вещатель, начальник, админБезРассылки, бухгалтер, кадровик, посторонний, отделБух, отделКадры;
before(async () => {
  srv = await startServer();
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  const mk = async (name) => (await request(srv.url, 'POST', '/api/admin/departments', { token: admin.token, body: { name } })).json.id;
  отделБух = await mk('Бухгалтерия тестовая');
  отделКадры = await mk('Кадры тестовые');
  вещатель = await makeUser(srv.url, admin.token, 'вещатель', { can_broadcast: true });
  начальник = await makeUser(srv.url, admin.token, 'начальник', { can_broadcast: true, can_admin: true });
  админБезРассылки = await makeUser(srv.url, admin.token, 'админ-без-рассылки', { can_admin: true });
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

test('написать отделу: его сотрудник — да; с правом «Рассылки» или «Админка» — любому; остальные — нет', async () => {
  assert.equal((await отправить(бухгалтер, { text: 'от своего', departmentId: отделБух })).status, 200);
  const чужой = await отправить(кадровик, { text: 'от чужого отдела', departmentId: отделБух });
  assert.equal(чужой.status, 403);
  assert.match(чужой.json.error, /только его сотрудники/);
  assert.equal((await отправить(посторонний, { text: 'от постороннего', departmentId: отделБух })).status, 403);
  assert.equal((await отправить(вещатель, { text: 'только рассылки', departmentId: отделБух })).status, 200, 'права «Рассылки» достаточно');
  assert.equal((await отправить(админБезРассылки, { text: 'только админка', departmentId: отделБух })).status, 200, 'права «Админка» достаточно');
  assert.equal((await отправить(начальник, { text: 'от начальника', departmentId: отделБух })).status, 200, 'с обоими — тем более');
  for (const t of ['от чужого отдела', 'от постороннего']) {
    assert.ok(!(await лента(бухгалтер)).includes(t), `отклонённое «${t}» не сохраняется`);
  }
});

test('объявление отделу видят его сотрудники и автор — и никто больше', async () => {
  // Начальник с правами «Рассылки» и «Админка» пишет отделу, в котором сам не состоит (хватило бы и одного).
  assert.equal((await отправить(начальник, { text: 'бухгалтерии от начальника', departmentId: отделБух })).status, 200);
  assert.ok((await лента(бухгалтер)).includes('бухгалтерии от начальника'), 'сотрудник отдела видит');
  assert.ok((await лента(начальник)).includes('бухгалтерии от начальника'), 'автор видит своё, хотя сам не в отделе');
  assert.ok(!(await лента(посторонний)).includes('бухгалтерии от начальника'), 'посторонний не видит');
  assert.ok(!(await лента(вещатель)).includes('бухгалтерии от начальника'), 'право рассылки не даёт читать чужие отделы');
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
    connect(srv.url, бухгалтер.token), connect(srv.url, посторонний.token), connect(srv.url, начальник.token),
  ]);
  try {
    const текст = 'живое объявление бухгалтерии';
    const пришло = (ws) => ws.next((m) => m.type === 'broadcast' && m.text === текст, 1500).then(() => true, () => false);
    const ждём = [пришло(wsБух), пришло(wsПост), пришло(wsАвтор)];
    assert.equal((await отправить(начальник, { text: текст, departmentId: отделБух })).status, 200);
    const [бух, пост, автор] = await Promise.all(ждём);
    assert.equal(бух, true, 'сотрудник отдела получил');
    assert.equal(автор, true, 'автор получил своё');
    assert.equal(пост, false, 'постороннему не пришло');
  } finally {
    wsБух.close(); wsПост.close(); wsАвтор.close();
  }
});

// Объявление с оформлением: редактор присылает html, сервер чистит его по белому списку и сам делает
// текстовую версию — по ней ищет история, её показывают уведомление и старые клиенты.
test('оформленное объявление: html очищается, текст сервер делает сам', async () => {
  const ws = await connect(srv.url, бухгалтер.token);
  try {
    const пришло = ws.next((m) => m.type === 'broadcast' && /Собрание/.test(m.text), 1500);
    const html = '<div><b>Собрание</b> в <span style="color: #d93b3b; background: url(x)">пятницу</span></div>'
      + '<ul><li>отчёт</li></ul><img src=x onerror="alert(1)"><script>alert(2)</script>'
      + '<a href="javascript:alert(3)">плохая</a> <a href="https://portal.example">портал</a>';
    assert.equal((await отправить(вещатель, { html, text: 'клиенту не верим' })).status, 200);
    const живое = await пришло;
    assert.match(живое.html, /<b>Собрание<\/b>/);
    assert.match(живое.html, /style="color: #d93b3b"/, 'цвет остался, ссылка в стиле — нет');
    assert.doesNotMatch(живое.html, /img|script|onerror|javascript|url\(/i);
    assert.match(живое.html, /<a href="https:\/\/portal\.example">портал<\/a>/);
    assert.match(живое.text, /^Собрание в пятницу/);
    assert.match(живое.text, /• отчёт/);
    assert.doesNotMatch(живое.text, /клиенту не верим/);

    const r = await request(srv.url, 'GET', '/api/broadcasts?q=пятницу', { token: бухгалтер.token });
    assert.equal(r.json.length, 1, 'поиск — по текстовой версии');
    assert.equal(r.json[0].html, живое.html, 'в истории — тот же html');
  } finally {
    ws.close();
  }
});

test('html без оформления хранится как обычный текст; пустой и слишком длинный — отказ', async () => {
  assert.equal((await отправить(вещатель, { html: '<div>просто строка</div><div>вторая</div>' })).status, 200);
  const r = await request(srv.url, 'GET', '/api/broadcasts?q=просто строка', { token: вещатель.token });
  assert.equal(r.json[0].html, null);
  assert.equal(r.json[0].text, 'просто строка\nвторая');
  assert.equal((await отправить(вещатель, { html: '<div><b> </b><br></div>' })).status, 400, 'пустое после очистки');
  assert.equal((await отправить(вещатель, { html: '<b>x</b>'.repeat(10000) })).status, 400, 'слишком длинное');
});

test('удаление объявления: только администратор; пропадает из лент, окна узнают сразу', async () => {
  const ws = await connect(srv.url, бухгалтер.token);
  try {
    assert.equal((await отправить(вещатель, { text: 'устаревшее объявление' })).status, 200);
    const live = await ws.next((m) => m.type === 'broadcast' && m.text === 'устаревшее объявление');
    assert.ok(Number.isInteger(live.id) && live.id > 0, 'в живом объявлении есть номер — по нему окно его потом уберёт');

    const del = (кто, id) => request(srv.url, 'DELETE', `/api/admin/broadcasts/${id}`, { token: кто && кто.token });
    assert.equal((await del(null, live.id)).status, 401);
    assert.equal((await del(вещатель, live.id)).status, 403, 'право рассылки — не право удалять');
    assert.equal((await del(admin, 999999)).status, 404);
    assert.equal((await del(admin, 'abc')).status, 404);

    assert.equal((await del(admin, live.id)).status, 200);
    const gone = await ws.next((m) => m.type === 'broadcast_deleted');
    assert.equal(gone.id, live.id);
    assert.ok(!(await лента(бухгалтер)).includes('устаревшее объявление'));
    assert.ok(!(await лента(admin, '?all=1')).includes('устаревшее объявление'));
    assert.equal((await del(admin, live.id)).status, 404, 'второй раз удалять нечего');
  } finally { ws.close(); }
});

test('удаление объявления удаляет его файлы, если они больше нигде не встречаются', async () => {
  const свой = await upload(srv.url, вещатель.token, 'только в объявлении.txt');
  const общий = await upload(srv.url, вещатель.token, 'и в переписке.txt');
  // Тот же файл переслан и личным сообщением — его удалять нельзя.
  const ws = await connect(srv.url, вещатель.token);
  try {
    ws.send({ type: 'send', to: бухгалтер.id, text: 'держи файл', files: [общий] });
    await ws.next((m) => m.type === 'message' && m.text === 'держи файл');
  } finally { ws.close(); }
  assert.equal((await отправить(вещатель, { text: 'с вложениями', files: [свой, общий] })).status, 200);
  const items = (await request(srv.url, 'GET', '/api/broadcasts?all=1', { token: admin.token })).json;
  const b = items.find((x) => x.text === 'с вложениями');

  const onDisk = (f) => fs.existsSync(path.join(srv.dir, 'uploads', f.url.split('/').pop()));
  assert.ok(onDisk(свой) && onDisk(общий));
  const r = await request(srv.url, 'DELETE', `/api/admin/broadcasts/${b.id}`, { token: admin.token });
  assert.equal(r.status, 200);
  assert.equal(r.json.filesRemoved, 1);
  assert.equal(onDisk(свой), false, 'файл только из объявления удалён');
  assert.equal(onDisk(общий), true, 'файл из переписки остался');
});
