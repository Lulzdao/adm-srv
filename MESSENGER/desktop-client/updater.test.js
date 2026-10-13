// Обновление без прав сотрудника (updater.js): что считается новой версией, чему в latest.yml верим
// и что скачанное действительно сверяется. Сервер — настоящий, на localhost; адреса и файлы выдуманы.
//
// Запуск:  node --test  (из папки desktop-client)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseVersion, isNewer, parseLatestYml, resolveServerUrl, prepare } = require('./updater');

const sha512 = (buf) => crypto.createHash('sha512').update(buf).digest('base64');
const ymlFor = (version, file, body, size = body.length) =>
  `version: ${version}\nfiles:\n  - url: ${file}\n    sha512: ${sha512(body)}\n    size: ${size}\npath: ${file}\nsha512: ${sha512(body)}\nreleaseDate: '2026-10-13T12:38:28.267Z'\n`;

// Сервер обновлений в миниатюре: отдаёт то, что лежит в files, и считает обращения.
async function feed(files) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const body = files[req.url];
    if (body === undefined) { res.writeHead(404); res.end('нет'); return; }
    res.writeHead(200); res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => server.close(r)) };
}
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iskra-updater-test-'));

test('версии сравниваются как номера, а не как строки', () => {
  assert.deepStrictEqual(parseVersion('1.0.27'), [1, 0, 27]);
  assert.strictEqual(parseVersion('1.0'), null);
  assert.strictEqual(parseVersion('новая'), null);
  assert.strictEqual(isNewer('1.0.27', '1.0.26'), true);
  assert.strictEqual(isNewer('1.0.10', '1.0.9'), true, 'строкой 1.0.10 была бы «меньше» 1.0.9');
  assert.strictEqual(isNewer('1.1.0', '1.0.99'), true);
  assert.strictEqual(isNewer('1.0.26', '1.0.26'), false, 'та же версия — не обновление');
  assert.strictEqual(isNewer('1.0.25', '1.0.26'), false, 'назад не откатываем');
  assert.strictEqual(isNewer('2.0', '1.0.26'), false, 'непонятный номер новее не считается');
  assert.strictEqual(isNewer('1.0.27', ''), false);
});

test('latest.yml: берём версию, имя, сумму и размер; чужое имя файла не принимаем', () => {
  const body = Buffer.from('установщик');
  const info = parseLatestYml(ymlFor('1.0.27', 'iskra-setup-win10-1.0.27.exe', body));
  assert.deepStrictEqual(info, { version: '1.0.27', file: 'iskra-setup-win10-1.0.27.exe', sha512: sha512(body), size: body.length });

  const bad = (text, re) => assert.throws(() => parseLatestYml(text), re);
  bad('', /нет номера версии/);
  bad(ymlFor('1.0.27', '..\\..\\Windows\\evil.exe', body), /нет имени установщика/);
  bad(ymlFor('1.0.27', 'http://чужой.сервер/x.exe', body), /нет имени установщика/);
  bad(ymlFor('1.0.27', 'setup.msi', body), /нет имени установщика/);
  bad(`version: 1.0.27\npath: a.exe\nsha512: короткая\n`, /нет контрольной суммы/);
});

test('адрес сервера: https всегда, http — только с разрешения политики, настройка пользователя не участвует', () => {
  const builtIn = 'https://iskra.test.local:3103';
  assert.strictEqual(resolveServerUrl({}, builtIn), builtIn);
  assert.strictEqual(resolveServerUrl({ serverUrl: 'https://other.test.local:3103/' }, builtIn), 'https://other.test.local:3103');
  assert.throws(() => resolveServerUrl({ serverUrl: 'http://other.test.local:3103' }, builtIn), /не годится/);
  assert.strictEqual(resolveServerUrl({ serverUrl: 'http://other.test.local:3103', allowInsecureHttp: true }, builtIn), 'http://other.test.local:3103');
  assert.throws(() => resolveServerUrl({}, 'ftp://x'), /не годится/);
  assert.throws(() => resolveServerUrl({}, ''), /не годится/);
});

test('версия на сервере не новее — ничего не качается', async () => {
  const body = Buffer.from('установщик 1.0.26');
  const srv = await feed({ '/updates/win10/latest.yml': ymlFor('1.0.26', 'iskra-setup-win10-1.0.26.exe', body) });
  try {
    let made = 0;
    const r = await prepare({ serverUrl: srv.url, track: 'win10', installedVersion: '1.0.26', makeDir: () => { made += 1; return tempDir(); } });
    assert.deepStrictEqual(r, { update: false, published: '1.0.26', installed: '1.0.26' });
    assert.deepStrictEqual(srv.hits, ['/updates/win10/latest.yml'], 'за установщиком не ходили');
    assert.strictEqual(made, 0, 'папку под загрузку не создавали');
  } finally { await srv.close(); }
});

test('версия новее — установщик скачан в свою папку и сверен', async () => {
  const body = crypto.randomBytes(300 * 1024);
  const srv = await feed({
    '/updates/win7/latest.yml': ymlFor('1.0.27', 'iskra-setup-win7-1.0.27.exe', body),
    '/updates/win7/iskra-setup-win7-1.0.27.exe': body,
  });
  const dir = tempDir();
  try {
    const r = await prepare({ serverUrl: srv.url, track: 'win7', installedVersion: '1.0.26', makeDir: () => dir });
    assert.strictEqual(r.update, true);
    assert.strictEqual(r.version, '1.0.27');
    assert.strictEqual(r.dir, dir);
    assert.strictEqual(r.installer, path.join(dir, 'iskra-setup-win7-1.0.27.exe'));
    assert.ok(fs.readFileSync(r.installer).equals(body), 'файл дошёл целиком');
  } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('подменённый или обрезанный установщик не принимается, и папка за ним убирается', async () => {
  const body = Buffer.from('настоящий установщик');
  const yml = ymlFor('1.0.27', 'iskra-setup-win10-1.0.27.exe', body);
  for (const [what, served, re] of [
    ['подменён (тот же размер)', Buffer.alloc(body.length, 0x41), /контрольная сумма установщика не сошлась/],
    ['обрезан', body.subarray(0, 5), /размер не сошёлся/],
    ['длиннее заявленного', Buffer.concat([body, Buffer.from('хвост')]), /больше заявленного/],
  ]) {
    const srv = await feed({ '/updates/win10/latest.yml': yml, '/updates/win10/iskra-setup-win10-1.0.27.exe': served });
    const dir = tempDir();
    try {
      await assert.rejects(prepare({ serverUrl: srv.url, track: 'win10', installedVersion: '1.0.26', makeDir: () => dir }), re, what);
      assert.strictEqual(fs.existsSync(dir), false, `${what}: папка с негодным файлом убрана`);
    } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('сервер недоступен или на нём нет файлов — ошибка, а не «обновлений нет»', async () => {
  const srv = await feed({});
  try {
    await assert.rejects(prepare({ serverUrl: srv.url, track: 'win10', installedVersion: '1.0.26', makeDir: tempDir }), /ответил 404/);
  } finally { await srv.close(); }
  await assert.rejects(prepare({ serverUrl: 'http://127.0.0.1:1', track: 'win10', installedVersion: '1.0.26', makeDir: tempDir }));
});
