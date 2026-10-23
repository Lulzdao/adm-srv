// Корни из хранилища Windows (root-store.js): разбор вывода и сама команда под PowerShell 2.0 —
// той версией, что стоит на Windows 7 и раньше резала сертификаты на обрывки по 120 символов.
//
// Запуск:  node --test  (из папки desktop-client)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { ROOT_STORE_COMMAND, pemsFromStoreOutput } = require('./root-store');

// Настоящий сертификат — корень домена из комплекта клиента, одной строкой base64.
const ROOT_B64 = fs.readFileSync(path.join(__dirname, 'rosstat-root-ca.crt'), 'utf8')
  .replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');

test('строка base64 — один сертификат, тот же самый', () => {
  const pems = pemsFromStoreOutput(`${ROOT_B64}\r\n\r\n`);
  assert.equal(pems.length, 1);
  assert.equal(new crypto.X509Certificate(pems[0]).fingerprint, new crypto.X509Certificate(Buffer.from(ROOT_B64, 'base64')).fingerprint);
});

test('сертификат, порезанный на строки по 120 символов, в доверенные не попадает', () => {
  // Так выглядел вывод прежней команды под PowerShell 2.0: обрывки считались сертификатами.
  const wrapped = ROOT_B64.match(/.{1,120}/g).join('\r\n');
  assert.equal(pemsFromStoreOutput(wrapped).length, 0);
  assert.equal(pemsFromStoreOutput('мусор\r\nне base64\r\n').length, 0);
});

// PowerShell 2.0 есть не везде (нужен .NET 3.5) — где его нет, проверку пропускаем.
function storeVia(versionArgs) {
  const out = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [...versionArgs, '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', ROOT_STORE_COMMAND],
    { timeout: 60000, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return { out, pems: pemsFromStoreOutput(out) };
}
let ps2 = null;
if (process.platform === 'win32') { try { ps2 = storeVia(['-Version', '2']); } catch { ps2 = null; } }

test('PowerShell 2.0 (как на Windows 7): хранилище читается целиком, строки не обрезаны', { skip: !ps2 && 'нет PowerShell 2.0' }, () => {
  const current = storeVia([]);
  assert.ok(current.pems.length > 0, 'в хранилище есть корни');
  assert.equal(ps2.pems.length, current.pems.length);
  const lines = ps2.out.split(/\r?\n/).filter((l) => l.trim());
  assert.equal(lines.length, ps2.pems.length, 'каждая строка вывода — целый сертификат');
});
