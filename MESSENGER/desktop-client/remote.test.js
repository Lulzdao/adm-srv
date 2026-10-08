// Подключение к ПК сотрудника через UltraVNC (remote.js): какое имя ПК годится и с какими
// аргументами запускается просмотрщик. Имена выдуманы.
//
// Запуск:  node --test  (из папки desktop-client)

const test = require('node:test');
const assert = require('node:assert');
const { isRemoteHost, remoteHostsOf, viewerArgs, viewerCandidates, findViewer } = require('./remote');

test('просмотрщик ищется на нескольких дисках и в папке сервера UltraVNC', () => {
  const list = viewerCandidates(null, 'E:\\uvnc_support\\vncviewer.exe', ['C:\\Program Files', 'C:\\Program Files', undefined, 'C:\\Program Files (x86)']);
  assert.deepStrictEqual(list, [
    'E:\\uvnc_support\\vncviewer.exe',
    'C:\\uvnc_support\\vncviewer.exe',
    'D:\\uvnc_support\\vncviewer.exe',
    'F:\\uvnc_support\\vncviewer.exe',
    'C:\\Program Files\\uvnc_s\\vncviewer.exe',
    'C:\\Program Files (x86)\\uvnc_s\\vncviewer.exe',
  ], 'путь из сборки первым, без повторов');

  // У коллеги папка на C:, у другого её нет вовсе — берётся та, что есть на каждом ПК.
  assert.strictEqual(findViewer(list, (p) => p.startsWith('C:\\uvnc_support')), 'C:\\uvnc_support\\vncviewer.exe');
  assert.strictEqual(findViewer(list, (p) => p.includes('uvnc_s\\')), 'C:\\Program Files\\uvnc_s\\vncviewer.exe');
  assert.strictEqual(findViewer(list, () => false), null);
});

test('путь из политики — единственный: другой файл вместо него не берётся', () => {
  const list = viewerCandidates('D:\\Tools\\vncviewer.exe', 'E:\\uvnc_support\\vncviewer.exe', ['C:\\Program Files']);
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
