// Проверка разбора машинной политики C:\ProgramData\Iskra\config.json (policy.js).
//
// Главное — метка BOM: её ставят Блокнот Windows 7 и Windows PowerShell 5.1, и на пилоте 2026-09-30
// политика, записанная через Set-Content -Encoding UTF8, молча не действовала — клиент уходил на
// адрес из сборки. Адреса и пути выдуманы.
//
// Запуск:  node --test  (из папки desktop-client)

const test = require('node:test');
const assert = require('node:assert');
const { parseMachinePolicy } = require('./policy');

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const files = { 'C:\\GPO\\root.crt': PEM };
const readFile = (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; };
const SRC = 'C:\\ProgramData\\Iskra\\config.json';

test('файла нет — пустая политика без ошибки', () => {
  const { policy, error } = parseMachinePolicy(null, readFile, SRC);
  assert.strictEqual(error, null);
  assert.strictEqual(policy.serverUrl, null);
});

test('метка BOM в начале не мешает — политика действует', () => {
  const raw = '\uFEFF{ "serverUrl": "https://iskra.test.local:3103", "extraCaFiles": ["C:\\\\GPO\\\\root.crt"] }';
  const { policy, error } = parseMachinePolicy(raw, readFile, SRC);
  assert.strictEqual(error, null);
  assert.strictEqual(policy.serverUrl, 'https://iskra.test.local:3103');
  assert.deepStrictEqual(policy.extraCa, [PEM]);
  assert.strictEqual(policy.source, SRC);
});

test('испорченный файл — пустая политика и понятная ошибка для журнала', () => {
  const { policy, error } = parseMachinePolicy('{ "serverUrl": ', readFile, SRC);
  assert.strictEqual(policy.serverUrl, null);
  assert.match(error, /не JSON/);
  assert.match(parseMachinePolicy('["https://x"]', readFile, SRC).error, /ожидался объект/);
});

test('http — только явным allowInsecureHttp: true; корни текстом и из файлов, пропавший файл пропускается', () => {
  const { policy } = parseMachinePolicy(JSON.stringify({
    serverUrl: '  http://iskra.test.local:3103  ', allowInsecureHttp: 'true',
    extraCaPem: [PEM, 'не сертификат'], extraCaFiles: ['C:\\GPO\\root.crt', 'C:\\GPO\\нет.crt', 42],
  }), readFile, SRC);
  assert.strictEqual(policy.serverUrl, 'http://iskra.test.local:3103');
  assert.strictEqual(policy.allowInsecureHttp, false, 'строка "true" — не согласие');
  assert.strictEqual(policy.extraCa.length, 2);
});

test('просмотрщик UltraVNC: путь, порт и добавочные ключи; негодные значения не действуют', () => {
  const { policy } = parseMachinePolicy(JSON.stringify({
    vncViewerPath: '  D:\\Tools\\vnc\\vncviewer.exe ', vncPort: 5900, vncViewerArgs: ['-dsmplugin', 'SecureVNCPlugin.dsm', 7, ''],
  }), readFile, SRC);
  assert.strictEqual(policy.vncViewerPath, 'D:\\Tools\\vnc\\vncviewer.exe');
  assert.strictEqual(policy.vncPort, 5900);
  assert.deepStrictEqual(policy.vncViewerArgs, ['-dsmplugin', 'SecureVNCPlugin.dsm']);

  const none = parseMachinePolicy('{ "vncViewerPath": 5, "vncPort": "5900" }', readFile, SRC).policy;
  assert.strictEqual(none.vncViewerPath, null);
  assert.strictEqual(none.vncPort, null, 'порт строкой — не порт');
  assert.strictEqual(none.vncViewerArgs, null, 'ключи не заданы — действуют из сборки');
  assert.strictEqual(parseMachinePolicy('{ "vncPort": 70000 }', readFile, SRC).policy.vncPort, null);
  assert.strictEqual(parseMachinePolicy(null, readFile, SRC).policy.vncViewerArgs, null);
  assert.deepStrictEqual(parseMachinePolicy('{ "vncViewerArgs": [] }', readFile, SRC).policy.vncViewerArgs, [], 'пустой список — без ключей');
});
