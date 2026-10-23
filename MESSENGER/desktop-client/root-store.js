// Корневые сертификаты из хранилища Windows (LocalMachine\Root) — для главного процесса (main.js) и
// для задания обновления (updater.js). Читаем через PowerShell: --use-system-ca есть только в Node 22,
// а сборка под Windows 7 живёт на Node 16 (см. collectTrustAnchors в main.js).
//
// Каждый сертификат — одной строкой base64 через [Console]::Out.WriteLine, а НЕ обычным выводом
// конвейера. PowerShell 2.0 (Windows 7) при выводе в канал переносит строки по ширине буфера
// консоли — 120 символов, — и сертификат длиной в пару тысяч символов разваливался на два десятка
// обрывков. Ни один не разбирался, а счётчик «прочитано из хранилища» показывал 1311 вместо 99:
// на Windows 7 хранилище не работало вовсе, и задание обновления падало с «self signed certificate
// in certificate chain», где на Windows 10 всё проходило (найдено 2026-10-23 через powershell
// -Version 2). [Console]::Out пишет мимо форматирования PowerShell — строка выходит целиком.

const crypto = require('crypto');

const ROOT_STORE_COMMAND =
  'Get-ChildItem Cert:\\LocalMachine\\Root | ForEach-Object { [Console]::Out.WriteLine([Convert]::ToBase64String($_.RawData)) }';

// Вывод команды → список PEM. Берём только строки, которые действительно разбираются как сертификат:
// обрывок или мусор в списке доверенных Node молча пропускает, и счёт прочитанного врал бы.
function pemsFromStoreOutput(output) {
  const pems = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const b64 = line.trim();
    if (!b64) continue;
    try { new crypto.X509Certificate(Buffer.from(b64, 'base64')); } catch { continue; }
    pems.push(`-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`);
  }
  return pems;
}

module.exports = { ROOT_STORE_COMMAND, pemsFromStoreOutput };
