// Обновление «Искры» без прав сотрудника — часть, которая ходит на сервер.
//
// ЗАЧЕМ. Установщик ставит программу для всех пользователей компьютера и требует прав
// администратора. У сотрудника без них клиент скачивает обновление и поставить не может. Поэтому
// установщик заводит задание планировщика Windows от имени СИСТЕМЫ (см. updater/register-tasks.ps1):
// два раза в день оно проверяет, не вышла ли версия новее, и ставит её само.
//
// КАК. Задание запускает updater/iskra-update.ps1, а тот — этот файл: саму программу «Искра» в режиме
// обычного Node (ELECTRON_RUN_AS_NODE=1), без окон. Node нужен ради сети: PowerShell 2.0 на
// Windows 7 не умеет TLS 1.2, которым отвечает сервер. Здесь — только «узнать, скачать, проверить»;
// установщик запускает уже сценарий, когда этот процесс вышел: иначе установщик, закрывая
// работающую «Искру», закрыл бы и нас (мы — тот же .exe) и не смог бы заменить занятые файлы.
//
// БЕЗОПАСНОСТЬ. Это код с правами системы, который запускает скачанную программу, поэтому:
//  • умеет ровно одно — поставить версию «Искры» новее установленной, и только с её сервера;
//  • адрес сервера — из сборки или из машинной политики (C:\ProgramData\Iskra\config.json,
//    пишут туда только администраторы). Настройку пользователя (Ctrl+S) НЕ читаем: её может
//    поменять сам сотрудник и подсунуть системе свой «сервер обновлений»;
//  • только https с проверкой сертификата (корень организации + хранилище Windows); http —
//    лишь если его явно разрешила та же политика;
//  • скачанное сверяется с размером и контрольной суммой из latest.yml;
//  • скачиваем в свежую папку, закрытую для всех, кроме системы и администраторов: в общей
//    временной папке сотрудник мог бы подложить рядом свою библиотеку, и установщик с правами
//    системы её бы загрузил.
//
// Вывод для сценария — строки «ключ=значение» (в PowerShell 2.0 нет разбора JSON).

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024; // больше гигабайта установщик не бывает — это не он
const REQUEST_TIMEOUT_MS = 60000;               // тишина дольше минуты — связь оборвалась

// ---------- то, что проверяется тестами без сети и диска ----------

// «1.0.27» → [1, 0, 27]; null, если это не номер версии.
function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[.-].*)?$/.exec(String(text || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Строго ли a новее b. Непонятный номер новее не считается: ставить вслепую не будем.
function isNewer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// latest.yml, который кладёт electron-builder. Полный разбор YAML не нужен: берём четыре строки
// верхнего уровня. Имя файла — только имя, без папок: путь из чужого файла в запрос не подставляем.
function parseLatestYml(text) {
  const top = (key) => {
    const m = new RegExp(`^${key}:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, 'm').exec(String(text || ''));
    return m ? m[1] : null;
  };
  const version = top('version');
  const file = top('path');
  const sha512 = top('sha512');
  const sizeMatch = /^\s+size:\s*(\d+)\s*$/m.exec(String(text || ''));
  if (!parseVersion(version)) throw new Error('в latest.yml нет номера версии');
  if (!file || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/.test(file)) throw new Error('в latest.yml нет имени установщика');
  if (!sha512 || !/^[A-Za-z0-9+/]{86}==$/.test(sha512)) throw new Error('в latest.yml нет контрольной суммы');
  return { version, file, sha512, size: sizeMatch ? Number(sizeMatch[1]) : null };
}

// Откуда качать: адрес из политики важнее адреса из сборки. http — только с явного разрешения политики.
function resolveServerUrl(policy, builtIn) {
  const url = String((policy && policy.serverUrl) || builtIn || '').replace(/\/+$/, '');
  if (/^https:\/\//i.test(url)) return url;
  if (/^http:\/\//i.test(url) && policy && policy.allowInsecureHttp) return url;
  throw new Error(`адрес сервера не годится для обновления: ${url || '(пусто)'}`);
}

// ---------- сеть ----------

function get(url, ca) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { ca, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`сервер ответил ${res.statusCode} на ${url}`)); return; }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error(`сервер не отвечает: ${url}`)));
    req.on('error', reject);
  });
}

async function fetchText(url, ca) {
  const res = await get(url, ca);
  const chunks = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('latest.yml слишком большой');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Качает в файл и возвращает { size, sha512 } — сумма считается по ходу, второй раз файл не читаем.
async function download(url, ca, file, expectedSize) {
  const res = await get(url, ca);
  const hash = crypto.createHash('sha512');
  const out = fs.createWriteStream(file, { flags: 'wx' }); // wx: файл должен быть новым
  let size = 0;
  try {
    for await (const chunk of res) {
      size += chunk.length;
      if (size > MAX_INSTALLER_BYTES || (expectedSize && size > expectedSize)) throw new Error('файл больше заявленного');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  return { size, sha512: hash.digest('base64') };
}

// ---------- главное ----------

/**
 * Узнаёт выложенную версию и, если она новее установленной, скачивает и проверяет установщик.
 * @returns { update: false, published, installed } | { update: true, version, installer, dir }
 */
async function prepare({ serverUrl, track, installedVersion, ca, makeDir }) {
  const base = `${serverUrl}/updates/${track}`;
  const info = parseLatestYml(await fetchText(`${base}/latest.yml`, ca));
  if (!isNewer(info.version, installedVersion)) return { update: false, published: info.version, installed: installedVersion };

  const dir = makeDir();
  try {
    const file = path.join(dir, info.file);
    const got = await download(`${base}/${encodeURIComponent(info.file)}`, ca, file, info.size);
    if (info.size && got.size !== info.size) throw new Error(`размер не сошёлся: скачано ${got.size}, заявлено ${info.size}`);
    if (got.sha512 !== info.sha512) throw new Error('контрольная сумма установщика не сошлась');
    return { update: true, version: info.version, installer: file, dir };
  } catch (err) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* уберёт следующий запуск */ }
    throw err;
  }
}

// ---------- обвязка для запуска заданием ----------

const PROGRAM_DATA = process.env.ProgramData || 'C:\\ProgramData';
const POLICY_PATH = path.join(PROGRAM_DATA, 'Iskra', 'config.json');
const LOG_PATH = path.join(PROGRAM_DATA, 'Iskra', 'updater.log');
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';

function log(text) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    // Журнал не растёт вечно: перевалил за 300 КБ — начинаем заново.
    try { if (fs.statSync(LOG_PATH).size > 300 * 1024) fs.unlinkSync(LOG_PATH); } catch { /* ещё нет */ }
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${text}\r\n`);
  } catch { /* журнал — не повод срывать обновление */ }
}

// Кому доверяем: корень организации из сборки, корни из политики и хранилище Windows (туда корень
// домена приезжает групповыми политиками). Тот же набор, что у главного процесса клиента, — см.
// подробный разбор у collectTrustAnchors в main.js.
function trustAnchors(policy) {
  const anchors = [...tls.rootCertificates];
  try { anchors.push(fs.readFileSync(path.join(__dirname, 'rosstat-root-ca.crt'), 'utf8')); } catch { /* файла нет */ }
  for (const pem of policy.extraCa || []) anchors.push(pem);
  // -InputFormat None и закрытый ввод: PowerShell 2.0 (Windows 7) иначе может ждать ввода до тайм-аута
  // (та же ловушка, что в установщике до 1.0.28). Тайм-аут с запасом: первый запуск PowerShell от
  // имени системы на старой машине сразу после входа бывает долгим.
  let fromStore = 0;
  try {
    const out = execFileSync(path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', 'Get-ChildItem Cert:\\LocalMachine\\Root | ForEach-Object { [Convert]::ToBase64String($_.RawData) }'],
      { timeout: 60000, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const line of String(out).split(/\r?\n/)) {
      const body = line.trim().match(/.{1,64}/g);
      if (body) { anchors.push(`-----BEGIN CERTIFICATE-----\n${body.join('\n')}\n-----END CERTIFICATE-----\n`); fromStore += 1; }
    }
  } catch (err) {
    // Хранилище не прочиталось — остаются корень из сборки и политика. Пишем почему: на Windows 7
    // задание падало с «self signed certificate in certificate chain» (2026-10-15).
    log(`windows root store unreadable: ${String((err && err.message) || err).split('\n')[0]}`);
  }
  if (!fromStore) log('windows root store: 0 certificates');
  return anchors;
}

// Свежая папка под установщик, закрытая для всех, кроме системы и администраторов. Наследование
// прав снимается ДО того, как в ней появится файл. Не удалось закрыть — не качаем вовсе.
function makeSecureDir() {
  const dir = fs.mkdtempSync(path.join(SYSTEM_ROOT, 'Temp', 'iskra-update-'));
  try {
    execFileSync(path.join(SYSTEM_ROOT, 'System32', 'icacls.exe'),
      [dir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'],
      { timeout: 20000, windowsHide: true, stdio: 'ignore' });
  } catch (err) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* пустая папка — не страшно */ }
    throw new Error(`не удалось закрыть папку загрузки: ${err.message}`);
  }
  return dir;
}

// Остатки прежних запусков (прервали, выключили компьютер посреди загрузки).
function removeStaleDirs() {
  const temp = path.join(SYSTEM_ROOT, 'Temp');
  try {
    for (const name of fs.readdirSync(temp)) {
      if (!name.startsWith('iskra-update-')) continue;
      try { fs.rmSync(path.join(temp, name), { recursive: true, force: true }); } catch { /* занято — в другой раз */ }
    }
  } catch { /* папку не прочитали — не страшно */ }
}

async function main() {
  const pkg = require('./package.json');
  const { SERVER_URL } = require('./config');
  const { parseMachinePolicy } = require('./policy');

  let raw = null;
  try { raw = fs.readFileSync(POLICY_PATH, 'utf8'); } catch { /* политики нет — обычное дело */ }
  const { policy } = parseMachinePolicy(raw, (f) => fs.readFileSync(f, 'utf8'), POLICY_PATH);

  const track = pkg.buildTrack;
  if (track !== 'win7' && track !== 'win10') throw new Error(`сборка «${track || 'из исходников'}» сама не обновляется`);

  removeStaleDirs();
  const result = await prepare({
    serverUrl: resolveServerUrl(policy, SERVER_URL),
    track,
    installedVersion: pkg.version,
    ca: trustAnchors(policy),
    makeDir: makeSecureDir,
  });

  if (!result.update) {
    log(`check: installed ${result.installed}, published ${result.published} - nothing to do (${os.hostname()})`);
    process.stdout.write('update=0\n');
    return;
  }
  log(`download ok: ${pkg.version} -> ${result.version}, ${path.basename(result.installer)}`);
  process.stdout.write(`update=1\nversion=${result.version}\ninstaller=${result.installer}\ndir=${result.dir}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    log(`error: ${err && err.message}`);
    process.stdout.write('update=0\n');
    process.exitCode = 1;
  });
}

module.exports = { parseVersion, isNewer, parseLatestYml, resolveServerUrl, prepare };
