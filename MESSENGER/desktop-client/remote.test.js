// Подключение к ПК сотрудника через UltraVNC (remote.js): какое имя ПК годится и с какими
// аргументами запускается просмотрщик. Имена выдуманы.
//
// Запуск:  node --test  (из папки desktop-client)

const test = require('node:test');
const assert = require('node:assert');
const { isRemoteHost, remoteHostsOf, viewerArgs } = require('./remote');

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
