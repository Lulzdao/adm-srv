'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, request, login, makeUser, upload, connect, ADMIN } = require('./helpers/server');

// ============================================================================
//  Кому доступен файл и что можно процитировать
//
//  Файл доступен тому, кто его загрузил, и тем, кто может прочитать сообщение или объявление, где
//  он лежит; администратору — всё. Раньше токен на скачивание выдавался на любой файл любому
//  вошедшему, а список файлов в сообщении принимался от клиента как есть — так что и «положить чужой
//  файл в своё сообщение» было способом получить к нему доступ. Ответ на сообщение по чужому id
//  показывал начало чужой личной переписки.
//
//  Все имена и тексты выдуманы.
// ============================================================================

let srv, admin, автор, собеседник, посторонний, коллега, вещатель, отдел;
before(async () => {
  srv = await startServer();
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  const д = await request(srv.url, 'POST', '/api/admin/departments', { token: admin.token, body: { name: 'Отдел тестовый' } });
  отдел = д.json.id;
  автор = await makeUser(srv.url, admin.token, 'автор');
  собеседник = await makeUser(srv.url, admin.token, 'собеседник');
  посторонний = await makeUser(srv.url, admin.token, 'посторонний');
  коллега = await makeUser(srv.url, admin.token, 'коллега', { department_ids: [отдел] });
  вещатель = await makeUser(srv.url, admin.token, 'вещатель', { can_broadcast: true });
});
after(() => srv && srv.stop());

const diskName = (file) => file.url.split('/').pop();
const tokenFor = (кто, file) =>
  request(srv.url, 'GET', `/api/download-token?path=${encodeURIComponent(file.url)}`, { token: кто.token });

async function canDownload(кто, file) {
  const r = await tokenFor(кто, file);
  if (r.status === 403) return false;
  assert.equal(r.status, 200, r.text);
  const got = await fetch(`${srv.url}/uploads/${encodeURIComponent(diskName(file))}?token=${r.json.token}`);
  assert.equal(got.status, 200, 'токен выдан, а файл не отдаётся');
  return true;
}

/** Отправить сообщение по WebSocket и дождаться, пока сервер его разошлёт (и, значит, сохранит). */
async function send(кто, msg) {
  const ws = await connect(srv.url, кто.token);
  try {
    ws.send({ type: 'send', ...msg });
    return await ws.next((m) => m.type === 'message' && m.from_id === кто.id && m.text === msg.text);
  } finally {
    ws.close();
  }
}

test('загрузивший скачивает свой файл, посторонний — нет', async () => {
  const f = await upload(srv.url, автор.token, 'черновик.txt');
  assert.equal(await canDownload(автор, f), true);
  assert.equal(await canDownload(посторонний, f), false, 'имя файла на диске не должно быть ключом к нему');
});

test('файл из личного сообщения видят оба участника, и только они', async () => {
  const f = await upload(srv.url, автор.token, 'отчёт за квартал.xlsx');
  await send(автор, { to: собеседник.id, text: 'отчёт во вложении', files: [f] });
  assert.equal(await canDownload(собеседник, f), true);
  assert.equal(await canDownload(посторонний, f), false);
  assert.equal(await canDownload(admin, f), true, 'администратор читает любую переписку и из панели');
});

test('чужой файл нельзя «положить» в своё сообщение, чтобы получить к нему доступ', async () => {
  const f = await upload(srv.url, автор.token, 'личное.pdf');
  const m = await send(посторонний, { to: посторонний.id, text: 'сам себе', files: [f] });
  assert.deepEqual(m.files, [], 'файл без права отправителя отбрасывается при отправке');
  assert.equal(await canDownload(посторонний, f), false);
});

test('переслать можно то, что уже доступно', async () => {
  const f = await upload(srv.url, автор.token, 'пересылка.txt');
  await send(автор, { to: собеседник.id, text: 'держи', files: [f] });
  const m = await send(собеседник, { to: посторонний.id, text: 'пересылаю', files: [f] });
  assert.equal(m.files.length, 1);
  assert.equal(await canDownload(посторонний, f), true);
});

test('в сообщение не попадают ссылки не на наш сервер', async () => {
  const m = await send(автор, { to: собеседник.id, text: 'ссылка', files: [{ url: 'http://example.test/x.exe', name: 'x.exe' }] });
  assert.deepEqual(m.files, []);
});

test('файл группы — участникам, файл общей комнаты — всем', async () => {
  const g = await request(srv.url, 'POST', '/api/groups', { token: автор.token, body: { name: 'Группа тестовая', memberIds: [собеседник.id] } });
  const вГруппе = await upload(srv.url, автор.token, 'для группы.docx');
  await send(автор, { room: `group:${g.json.id}`, text: 'группе', files: [вГруппе] });
  assert.equal(await canDownload(собеседник, вГруппе), true);
  assert.equal(await canDownload(посторонний, вГруппе), false);

  const общий = await upload(srv.url, автор.token, 'для всех.txt');
  await send(автор, { room: 'general', text: 'всем', files: [общий] });
  assert.equal(await canDownload(посторонний, общий), true);
});

test('файл объявления отделу — сотрудникам отдела, объявления всем — всем', async () => {
  const отделу = await upload(srv.url, автор.token, 'приказ по отделу.pdf');
  const r1 = await request(srv.url, 'POST', '/api/broadcast', { token: автор.token, body: { text: 'отделу', departmentId: отдел, files: [отделу] } });
  assert.equal(r1.status, 200, r1.text);
  assert.equal(await canDownload(коллега, отделу), true);
  assert.equal(await canDownload(посторонний, отделу), false);

  const всем = await upload(srv.url, вещатель.token, 'график отпусков.xlsx');
  const r2 = await request(srv.url, 'POST', '/api/broadcast', { token: вещатель.token, body: { text: 'всем', files: [всем] } });
  assert.equal(r2.status, 200, r2.text);
  assert.equal(await canDownload(посторонний, всем), true);
});

test('токен на один файл не открывает другой', async () => {
  const мой = await upload(srv.url, посторонний.token, 'мой.txt');
  const чужой = await upload(srv.url, автор.token, 'чужой.txt');
  const r = await tokenFor(посторонний, мой);
  const got = await fetch(`${srv.url}/uploads/${encodeURIComponent(diskName(чужой))}?token=${r.json.token}`);
  assert.equal(got.status, 401);
});

test('ответ на чужое личное сообщение не показывает его текст', async () => {
  const тайное = await send(автор, { to: собеседник.id, text: 'тайное содержимое' });
  const попытка = await send(посторонний, { to: автор.id, text: 'ответ наугад', replyTo: тайное.id });
  assert.equal(попытка.reply, null, 'цитата чужого сообщения утекла бы всем адресатам ответа');
  const законный = await send(собеседник, { to: автор.id, text: 'отвечаю', replyTo: тайное.id });
  assert.equal(законный.reply && законный.reply.text, 'тайное содержимое');
});
