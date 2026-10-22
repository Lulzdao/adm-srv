// Подключение к ПК сотрудника через UltraVNC (remote.js): какое имя ПК годится и с какими
// аргументами запускается просмотрщик. Имена выдуманы.
//
// Запуск:  node --test  (из папки desktop-client)

const test = require('node:test');
const assert = require('node:assert');
const { isRemoteHost, remoteHostsOf, viewerArgs, viewerCandidates, findViewer, launchViewer } = require('./remote');

test('просмотрщик ищется только на диске C: — и в Program Files, и в Program Files (x86)', () => {
  const { VNC_VIEWER_PATHS } = require('./config');
  const list = viewerCandidates(null, VNC_VIEWER_PATHS);
  assert.deepStrictEqual(list, [
    'C:\\Program Files\\uvnc_support\\vncviewer.exe',
    'C:\\Program Files (x86)\\uvnc_support\\vncviewer.exe',
    'C:\\Program Files\\uvnc_s\\vncviewer.exe',
    'C:\\Program Files (x86)\\uvnc_s\\vncviewer.exe',
  ], 'сначала папка администратора, потом папка сервера UltraVNC');
  assert.ok(list.every((p) => /^C:\\Program Files( \(x86\))?\\/.test(p)), 'другие диски и папки не просматриваются');

  // Берётся первый найденный.
  assert.strictEqual(findViewer(list, (p) => p.includes('uvnc_support')), 'C:\\Program Files\\uvnc_support\\vncviewer.exe');
  assert.strictEqual(findViewer(list, (p) => p.includes('uvnc_s\\')), 'C:\\Program Files\\uvnc_s\\vncviewer.exe');
  assert.strictEqual(findViewer(list, (p) => p.includes('(x86)\\uvnc_s\\')), 'C:\\Program Files (x86)\\uvnc_s\\vncviewer.exe');
  assert.strictEqual(findViewer(list, () => false), null);

  assert.deepStrictEqual(viewerCandidates(null, ['C:\\a.exe', 'c:\\A.exe', '', undefined]), ['C:\\a.exe'], 'без повторов и пустых');
});

test('просмотрщик не запустился — пробуется следующий; отказы и отсутствующие пути возвращаются', async () => {
  const list = ['C:\\a\\v.exe', 'C:\\b\\v.exe', 'C:\\c\\v.exe', 'C:\\d\\v.exe'];
  const started = [];
  const start = (p) => { started.push(p); return p.startsWith('C:\\b') ? Promise.reject(new Error(`spawn ${p} EACCES`)) : Promise.resolve(); };

  // a нет, b есть, но Windows отказала (как на ПК с Windows 10), c запускается; до d дело не доходит.
  let r = await launchViewer(list, (p) => !p.startsWith('C:\\a'), start);
  assert.strictEqual(r.viewer, 'C:\\c\\v.exe');
  assert.deepStrictEqual(r.missing, ['C:\\a\\v.exe']);
  assert.deepStrictEqual(r.failed, [{ path: 'C:\\b\\v.exe', message: 'spawn C:\\b\\v.exe EACCES' }]);
  assert.deepStrictEqual(started, ['C:\\b\\v.exe', 'C:\\c\\v.exe']);

  // Есть только тот, что не запускается.
  r = await launchViewer(list, (p) => p.startsWith('C:\\b'), start);
  assert.strictEqual(r.viewer, null);
  assert.strictEqual(r.failed.length, 1);
  assert.strictEqual(r.missing.length, 3);

  // Нет нигде.
  r = await launchViewer(list, () => false, start);
  assert.deepStrictEqual([r.viewer, r.failed.length, r.missing.length], [null, 0, 4]);
});

test('путь из политики — единственный: другой файл вместо него не берётся', () => {
  const list = viewerCandidates('D:\\Tools\\vncviewer.exe', ['C:\\uvnc_support\\vncviewer.exe', 'C:\\Program Files\\uvnc_s\\vncviewer.exe']);
  assert.deepStrictEqual(list, ['D:\\Tools\\vncviewer.exe']);
  assert.strictEqual(findViewer(list, (p) => p.startsWith('C:')), null);
});

test('имя ПК — только буквы, цифры, дефис, подчёркивание и точка', () => {
  for (const ok of ['p48-312-tas', 'PC-209-MAA2', 'pc_old1', 'p48-312-tas.test.local', 'a']) {
    assert.strictEqual(isRemoteHost(ok), true, ok);
  }
  for (const bad of [
    '', ' ', 'пк-бухгалтерия', 'pc 1', 'pc;calc', 'pc&calc', 'pc|x', 'pc"x', 'pc/x', 'pc\\x',
    '-listen', '-connect', '.pc', 'pc..local', 'pc:5900', 'pc::5995', 'a'.repeat(64), null, undefined, 42, {},
  ]) {
    assert.strictEqual(isRemoteHost(bad), false, String(bad));
  }
});

test('из присутствия берутся только настоящие ПК, без повторов', () => {
  assert.deepStrictEqual(
    remoteHostsOf(['p48-312-tas', 'Веб-панель администратора', 'неизвестный ПК', 'p48-312-tas', 'p48-312-tas-l']),
    ['p48-312-tas', 'p48-312-tas-l']
  );
  assert.deepStrictEqual(remoteHostsOf([]), []);
  assert.deepStrictEqual(remoteHostsOf(undefined), []);
});

test('просмотрщику уходит имя с портом и добавочные ключи из политики', () => {
  assert.deepStrictEqual(viewerArgs('p48-312-tas', 5995), ['-connect', 'p48-312-tas:5995']);
  assert.deepStrictEqual(
    viewerArgs('p48-312-tas', 5900, ['-dsmplugin', 'SecureVNCPlugin.dsm']),
    ['-connect', 'p48-312-tas:5900', '-dsmplugin', 'SecureVNCPlugin.dsm']
  );
  assert.throws(() => viewerArgs('-listen', 5995), /недопустимое имя/);
  assert.throws(() => viewerArgs('pc & calc', 5995), /недопустимое имя/);
});

// Вход по учётке Windows без окна просмотрщика: логин и пароль — парой ключей -user/-password.
test('логин по умолчанию — учётка Windows ДОМЕН\\логин; логин и пароль уходят просмотрщику парой', () => {
  const { defaultVncUser, credentialArgs } = require('./remote');
  assert.strictEqual(defaultVncUser({ USERNAME: 'ivanov', USERDOMAIN: 'ROSSTAT' }), 'ROSSTAT\\ivanov');
  assert.strictEqual(defaultVncUser({ USERNAME: 'ivanov' }), 'ivanov');
  assert.strictEqual(defaultVncUser({}), '');
  assert.deepStrictEqual(credentialArgs(' ROSSTAT\\ivanov ', 'p@ss word'), ['-user', 'ROSSTAT\\ivanov', '-password', 'p@ss word']);
  assert.deepStrictEqual(credentialArgs('ПК-7\\Артем', 'х'), ['-user', 'ПК-7\\Артем', '-password', 'х'], 'русские буквы в логине — можно');
  for (const [u, p] of [['', 'x'], ['a', ''], ['a"b', 'x'], ['a', 'x"y'], ['a\nb', 'x'], ['a', 'x\u0000'], ['a'.repeat(105), 'x'], ['a', 'x'.repeat(129)]]) {
    assert.throws(() => credentialArgs(u, p), `${JSON.stringify(u)} / ${JSON.stringify(p)}`);
  }
});

// Вывод ping.exe — настоящий, с русской Windows: в кодировке 866, прочитанный как latin1 (так его читает
// main.js), — кириллица превращается в мусор, а «TTL=», цифры и адрес остаются как есть.
const { parsePing } = require('./remote');
test('ping: ответ, время и адрес — из настоящего вывода русской Windows', () => {
  const ok = '\r\n\u0090¡¬¥­ ¯ ª¥â ¬¨ á PC-1 [10.0.0.5] á 32 ¡ ©â ¬¨ ¤ ­­ëå:\r\n\u008eâ¢¥â ®â 10.0.0.5: ç¨á«® ¡ ©â=32 ¢à¥¬ï<1¬á TTL=128\r\n';
  assert.deepStrictEqual(parsePing(ok, 'PC-1'), { reply: true, ms: 1, below: true, ip: '10.0.0.5', resolved: true });
  const slow = 'Pinging PC-2 [10.0.0.6] with 32 bytes of data:\r\nReply from 10.0.0.6: bytes=32 time=12ms TTL=127\r\n';
  assert.deepStrictEqual(parsePing(slow, 'PC-2'), { reply: true, ms: 12, below: false, ip: '10.0.0.6', resolved: true });
});
test('ping: имя нашлось, но ПК не отвечает; имя не нашлось вовсе', () => {
  const silent = '\r\n\u0090¡¬¥­ ¯ ª¥â ¬¨ á PC-3 [10.0.0.7] á 32 ¡ ©â ¬¨ ¤ ­­ëå:\r\n\u0088­â¥à¢ « ®¦¨¤ ­¨ï ¤«ï § ¯à®á  ¨áâ¥ª.\r\n';
  assert.deepStrictEqual(parsePing(silent, 'PC-3'), { reply: false, ms: null, below: false, ip: '10.0.0.7', resolved: true });
  const unreachable = 'Pinging PC-4 [10.0.0.8] with 32 bytes of data:\r\nReply from 10.0.0.1: Destination host unreachable.\r\n';
  assert.strictEqual(parsePing(unreachable, 'PC-4').reply, false, 'ответ роутера «узел недоступен» — не ответ ПК');
  const noName = '\u008fà¨ ¯à®¢¥àª¥ á¢ï§¨ ­¥ ã¤ «®áì ®¡­ àã¦¨âì ã§¥« no-such-pc.\r\n';
  assert.deepStrictEqual(parsePing(noName, 'no-such-pc'), { reply: false, ms: null, below: false, ip: null, resolved: false });
  assert.strictEqual(parsePing('', '10.0.0.9').ip, '10.0.0.9', 'адрес вместо имени — он и есть адрес');
});
