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
