'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, request, login, makeUser, ADMIN } = require('./helpers/server');

// ============================================================================
//  Версии клиента из панели: загрузка, выкладка, откат, удаление (lib/releases.js)
//
//  Выкладка версии — запуск программы на всех ПК. Проверяется, что выложить можно
//  только целый установщик своей сборки (контрольная сумма и размер из latest.yml),
//  только администратору и только с паролем; что загруженное, но не выложенное,
//  клиентам не видно; что откат и удаление не оставляют клиентов без текущей версии.
//  «Установщики» здесь — случайные байты, имена и версии выдуманы.
// ============================================================================

let srv, admin, сотрудник;
before(async () => {
  srv = await startServer();
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  сотрудник = await makeUser(srv.url, admin.token, 'сотрудник');
});
after(() => srv && srv.stop());

/** Сборка, как её отдаёт electron-builder: установщик, карта блоков и latest.yml с его суммой. */
function build(track, version, { bytes = crypto.randomBytes(4096) } = {}) {
  const name = `iskra-setup-${track}-${version}.exe`;
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
  const yml = `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '2026-10-01T10:00:00.000Z'\n`;
  return { track, version, name, bytes, blockmap: Buffer.from(`карта ${name}`), yml };
}
const put = (track, name, raw, token = admin.token) =>
  request(srv.url, 'PUT', `/api/admin/releases/${track}/upload?name=${encodeURIComponent(name)}`, { token, raw, headers: { 'Content-Type': 'application/octet-stream' } });
const upload = async (b) => {
  assert.equal((await put(b.track, b.name, b.bytes)).status, 200);
  assert.equal((await put(b.track, `${b.name}.blockmap`, b.blockmap)).status, 200);
};
const publish = (b, password = ADMIN.password, token = admin.token) =>
  request(srv.url, 'POST', `/api/admin/releases/${b.track}/publish`, { token, body: { yml: b.yml, password } });
const get = (p) => request(srv.url, 'GET', p);
const list = async () => (await request(srv.url, 'GET', '/api/admin/releases', { token: admin.token })).json;

test('версиями управляет только администратор', async () => {
  const b = build('win10', '9.9.9');
  for (const [m, p, opt] of [
    ['GET', '/api/admin/releases', {}],
    ['PUT', `/api/admin/releases/win10/upload?name=${b.name}`, { raw: b.bytes }],
    ['POST', '/api/admin/releases/confirm', { body: { password: 'x' } }],
    ['POST', '/api/admin/releases/win10/publish', { body: { yml: b.yml, password: 'x' } }],
    ['POST', '/api/admin/releases/win10/current', { body: { version: '9.9.9', password: 'x' } }],
    ['DELETE', '/api/admin/releases/win10/9.9.9', {}],
  ]) {
    assert.equal((await request(srv.url, m, p, opt)).status, 401, `${m} ${p} без входа`);
    assert.equal((await request(srv.url, m, p, { ...opt, token: сотрудник.token })).status, 403, `${m} ${p} сотрудником`);
  }
});

test('загрузка: только файлы сборщика и только в свою сборку', async () => {
  assert.equal((await put('win10', 'virus.exe', Buffer.from('x'))).status, 400);
  assert.equal((await put('win10', '../server.js', Buffer.from('x'))).status, 400);
  const чужая = await put('win7', 'iskra-setup-win10-1.0.0.exe', Buffer.from('x'));
  assert.equal(чужая.status, 400);
  assert.match(чужая.json.error, /сборки win10, а загружается в win7/);
  assert.equal((await put('linux', 'iskra-setup-win10-1.0.0.exe', Buffer.from('x'))).status, 400);
  assert.equal((await put('win10', 'iskra-setup-win10-1.0.0.exe', Buffer.alloc(0))).status, 400, 'пустой файл');
});

test('выкладка: загруженное клиентам не видно, пока не выложено; нужен пароль; потом версия отдаётся', async () => {
  const b = build('win10', '1.0.0');
  await upload(b);
  assert.deepEqual((await list()).win10.staged.sort(), [b.name, `${b.name}.blockmap`]);
  for (const p of [`/updates/.staging/win10/${b.name}`, `/updates/../updates-staging/win10/${b.name}`, `/updates-staging/win10/${b.name}`, `/updates/win10/${b.name}`]) {
    assert.notEqual((await get(p)).status, 200, `${p}: загруженное до выкладки наружу не раздаётся`);
  }
  // И папка с точкой внутри updates (если кто-то положит такую руками) — тоже нет.
  fs.mkdirSync(path.join(srv.dir, 'updates', '.черновик'), { recursive: true });
  fs.writeFileSync(path.join(srv.dir, 'updates', '.черновик', 'x.exe'), 'x');
  assert.notEqual((await get(`/updates/${encodeURIComponent('.черновик')}/x.exe`)).status, 200);
  assert.equal((await get('/updates/win10/latest.yml')).status, 404, 'до выкладки текущей версии нет');

  const confirm = (password) => request(srv.url, 'POST', '/api/admin/releases/confirm', { token: admin.token, body: { password } });
  assert.equal((await confirm('не тот пароль')).status, 403, 'пароль проверяется до загрузки');
  assert.equal((await confirm(ADMIN.password)).status, 200);
  assert.equal((await publish(b, '')).status, 400, 'без пароля');
  const wrong = await publish(b, 'не тот пароль');
  assert.equal(wrong.status, 403);
  assert.equal((await get('/updates/win10/latest.yml')).status, 404, 'неверный пароль ничего не выложил');

  const ok = await publish(b);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.current.version, '1.0.0');
  assert.match((await get('/updates/win10/latest.yml')).text, /^version: 1\.0\.0/);
  const exe = await fetch(`${srv.url}/updates/win10/${b.name}`);
  assert.ok(Buffer.from(await exe.arrayBuffer()).equals(b.bytes), 'клиент получит ровно загруженный установщик');
  assert.equal((await get(`/updates/win10/${b.name}.blockmap`)).status, 200);
  assert.deepEqual((await list()).win10.staged, [], 'временная папка пуста');

  const journal = fs.readdirSync(path.join(srv.dir, 'logs'), { recursive: true }).map(String).filter((f) => f.endsWith('.log'))
    .map((f) => fs.readFileSync(path.join(srv.dir, 'logs', f), 'utf8')).join('\n');
  assert.match(journal, /release_published.*"version":"1\.0\.0"/, 'в журнале — кто и что выложил');
  assert.match(journal, /release_password_failed/);
});

test('повреждённый или чужой установщик не выкладывается', async () => {
  const b = build('win7', '1.0.0');
  // Установщик подменён после сборки: сумма в latest.yml от другого файла.
  await put('win7', b.name, crypto.randomBytes(4096));
  await put('win7', `${b.name}.blockmap`, b.blockmap);
  const sum = await publish(b);
  assert.equal(sum.status, 400);
  assert.match(sum.json.error, /Контрольная сумма/);

  // Загрузился не полностью.
  await put('win7', b.name, b.bytes.subarray(0, 100));
  assert.match((await publish(b)).json.error, /Размер установщика/);

  // latest.yml от другой сборки.
  const other = build('win10', '1.0.0');
  assert.match((await request(srv.url, 'POST', '/api/admin/releases/win7/publish', { token: admin.token, body: { yml: other.yml, password: ADMIN.password } })).json.error, /не установщик сборки win7/);
  assert.equal((await get('/updates/win7/latest.yml')).status, 404, 'ничего не выложено');

  // Без карты блоков — отказ с объяснением.
  const c = build('win7', '1.0.1');
  await put('win7', c.name, c.bytes);
  assert.match((await publish(c)).json.error, /blockmap/);
});

test('тот же номер и номер меньше текущего — отказ', async () => {
  const again = build('win10', '1.0.0');
  await upload(again);
  const r = await publish(again);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /уже выложена/);

  const next = build('win10', '1.1.0');
  await upload(next);
  assert.equal((await publish(next)).status, 200);
  const older = build('win10', '1.0.5');
  await upload(older);
  const o = await publish(older);
  assert.equal(o.status, 409);
  assert.match(o.json.error, /старше текущей 1\.1\.0/);
});

test('откат на прежнюю версию и удаление: текущую удалить нельзя', async () => {
  let l = (await list()).win10;
  assert.equal(l.current.version, '1.1.0');
  assert.deepEqual(l.versions.map((v) => [v.version, v.current, v.canMakeCurrent, v.hasBlockmap]),
    [['1.1.0', true, true, true], ['1.0.0', false, true, true]]);

  const back = await request(srv.url, 'POST', '/api/admin/releases/win10/current', { token: admin.token, body: { version: '1.0.0', password: ADMIN.password } });
  assert.equal(back.status, 200, back.text);
  assert.match((await get('/updates/win10/latest.yml')).text, /^version: 1\.0\.0/, 'клиентам снова предлагается 1.0.0');
  assert.equal((await request(srv.url, 'POST', '/api/admin/releases/win10/current', { token: admin.token, body: { version: '1.0.0', password: 'не тот' } })).status, 403);

  const del = (v) => request(srv.url, 'DELETE', `/api/admin/releases/win10/${v}`, { token: admin.token });
  const cur = await del('1.0.0');
  assert.equal(cur.status, 409);
  assert.match(cur.json.error, /Текущую версию удалить нельзя/);
  assert.equal((await del('1.1.0')).status, 200);
  assert.equal((await get('/updates/win10/iskra-setup-win10-1.1.0.exe')).status, 404);
  assert.equal((await get('/updates/win10/iskra-setup-win10-1.0.0.exe')).status, 200, 'текущая на месте');
  assert.equal((await del('7.7.7')).status, 404);
});

test('версия, выложенная руками (старый способ), видна в списке и к ней можно вернуться', async () => {
  // Раньше три файла копировали в папку на сервере — копии latest-<версия>.yml при этом нет.
  const dir = path.join(srv.dir, 'updates', 'win7');
  const old = build('win7', '2.0.0');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, old.name), old.bytes);
  fs.writeFileSync(path.join(dir, `${old.name}.blockmap`), old.blockmap);
  fs.writeFileSync(path.join(dir, 'latest.yml'), old.yml);

  const l = (await list()).win7;
  assert.equal(l.current.version, '2.0.0');
  assert.equal(l.versions.find((v) => v.version === '2.0.0').canMakeCurrent, true, 'копия latest.yml сделана при первом показе');

  const next = build('win7', '2.1.0');
  await upload(next);
  assert.equal((await publish(next)).status, 200);
  const back = await request(srv.url, 'POST', '/api/admin/releases/win7/current', { token: admin.token, body: { version: '2.0.0', password: ADMIN.password } });
  assert.equal(back.status, 200, back.text);
  assert.match(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8'), /^version: 2\.0\.0/);
});
