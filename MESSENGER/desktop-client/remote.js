// Подключение к ПК сотрудника через UltraVNC (ПКМ по контакту у администратора) — то, что можно
// проверить обычными тестами без Electron (см. remote.test.js). Сам запуск — в main.js, remote-connect.
//
// «Искра» здесь только подставляет имя ПК в просмотрщик. Пускать или нет, решает сервер UltraVNC на
// той машине: вход по учётной записи домена, пароль спрашивает сам просмотрщик — к нам он не попадает.

// Имя ПК сообщает сам клиент при подключении к серверу (см. connectWs в окнах), то есть это чужой
// ввод, и он уходит аргументом в запускаемую программу. Поэтому только то, из чего состоят имена
// компьютеров: буквы, цифры, дефис, подчёркивание, точка. Первый символ — буква или цифра: имя,
// начинающееся с дефиса, просмотрщик принял бы за свой ключ.
const HOST_RE = /^[a-z0-9][a-z0-9_-]{0,62}(\.[a-z0-9][a-z0-9_-]{0,62})*$/i;

function isRemoteHost(name) {
  return typeof name === 'string' && name.length <= 253 && HOST_RE.test(name);
}

// Имена ПК сотрудника, к которым есть смысл подключаться: без веб-панели администратора и без
// «неизвестный ПК» (так сервер подписывает подключение, не назвавшее себя) — они проверку не проходят.
function remoteHostsOf(hosts) {
  return [...new Set((hosts || []).filter(isRemoteHost))];
}

// Запись «имя:порт» — та же, какой просмотрщик сам запоминает адреса в своём списке (options.vnc).
function viewerArgs(host, port, extraArgs) {
  if (!isRemoteHost(host)) throw new Error('недопустимое имя ПК');
  return ['-connect', `${host}:${port}`, ...(extraArgs || [])];
}

// Где искать просмотрщик, по порядку: пути из сборки (VNC_VIEWER_PATHS в config.js — все на диске
// C:, включая папку сервера UltraVNC в Program Files и в Program Files (x86)).
//
// Путь из машинной политики — единственный: администратор назвал его явно, и молча брать вместо
// него другой файл нельзя.
function viewerCandidates(policyPath, defaultPaths) {
  if (policyPath) return [policyPath];
  const seen = new Set();
  return (defaultPaths || []).filter((p) => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()));
}

// Первый существующий из кандидатов или null. exists — (путь) => boolean.
function findViewer(candidates, exists) {
  for (const p of candidates) if (exists(p)) return p;
  return null;
}

// Запускает первый просмотрщик, который запустится. Файл может лежать на месте и не запускаться:
// на одном из ПК Windows отвечала EACCES на просмотрщик из папки сервера (2026-10-13) — права на
// файл или запрет антивируса, с нашей стороны не различить. Поэтому отказ — не конец: пробуем
// следующий путь из списка.
//   exists — (путь) => boolean;  start — (путь) => Promise, отклоняется, если запустить не удалось.
// Возвращает { viewer } или { viewer: null, missing: [...], failed: [{ path, message }] }.
async function launchViewer(candidates, exists, start) {
  const missing = [];
  const failed = [];
  for (const p of candidates) {
    if (!exists(p)) { missing.push(p); continue; }
    try {
      await start(p);
      return { viewer: p, missing, failed };
    } catch (err) {
      failed.push({ path: p, message: String((err && err.message) || err) });
    }
  }
  return { viewer: null, missing, failed };
}

// Вход по учётной записи Windows (MS-Logon UltraVNC) без окна просмотрщика: логин и пароль уходят ему
// ключами -user и -password — так он подключается сразу. Одного -user просмотрщик не принимает
// (проверено на UltraVNC 1.4.3.1: окно входа остаётся пустым), поэтому только парой.
// Логин по умолчанию — учётка, под которой администратор вошёл в Windows: ДОМЕН\логин.
function defaultVncUser(env) {
  const user = String((env && env.USERNAME) || '').trim();
  const domain = String((env && env.USERDOMAIN) || '').trim();
  return user ? (domain ? `${domain}\\${user}` : user) : '';
}

// Логин и пароль — аргументами программы (без оболочки, но всё же): без управляющих символов и кавычек,
// разумной длины. Пробелы и русские буквы в логине допустимы — такие учётки бывают.
const CONTROL_RE = /[\u0000-\u001f\u007f"]/;
function credentialArgs(user, password) {
  const u = typeof user === 'string' ? user.trim() : '';
  const p = typeof password === 'string' ? password : '';
  if (!u || u.length > 104 || CONTROL_RE.test(u)) throw new Error('недопустимый логин');
  if (!p || p.length > 128 || CONTROL_RE.test(p)) throw new Error('недопустимый пароль');
  return ['-user', u, '-password', p];
}

// Разбор вывода ping.exe для окна подключения: отвечает ли ПК и за сколько. Текст ping переведён на язык
// Windows и выходит в кодировке консоли (866), поэтому опираемся только на непереводимое: «TTL=» есть
// в каждой строке ответа на любом языке, время стоит перед ним («время<1мс TTL=128», «time=3ms TTL=128»),
// адрес — в квадратных скобках первой строки («Обмен пакетами с PC-1 [10.0.0.5]»). Нет ни ответа, ни
// адреса — имя не нашлось в сети.
// → { reply: bool, ms: число | null, below: bool (время «<1»), ip: строка | null, resolved: bool }
function parsePing(output, host) {
  const text = String(output || '');
  const ipMatch = text.match(/\[(\d{1,3}(?:\.\d{1,3}){3})\]/);
  const ip = ipMatch ? ipMatch[1] : (/^\d{1,3}(\.\d{1,3}){3}$/.test(host || '') ? host : null);
  const time = text.match(/([=<])(\d+)[^\s=<]*\s+TTL=/i);
  const reply = /TTL=/i.test(text);
  return { reply, ms: time ? Number(time[2]) : null, below: !!time && time[1] === '<', ip, resolved: reply || !!ip };
}

// ---------- Подключение по адресу, когда имя ПК не находится ----------
// Компьютеры сети in.local (свой домен, свой DNS) по имени из rosstat.local не находятся: наш DNS их
// имён не знает (2026-10-23). Поэтому клиент сообщает серверу и адреса своего ПК, а «Подключиться к
// ПК» пробует сначала имя, потом эти адреса.

function isIPv4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text || ''));
  return !!m && m.slice(1).every((n) => Number(n) <= 255);
}

// Адреса своего ПК для сервера (os.networkInterfaces()): только IPv4, без петли и без 169.254.x.x
// (адрес, который Windows ставит сама, когда DHCP не ответил, — по нему никто не подключится).
// Не больше четырёх: у ПК бывают виртуальные адаптеры, а строка уходит в адрес подключения.
function localIPv4(interfaces) {
  const out = [];
  for (const list of Object.values(interfaces || {})) {
    for (const a of list || []) {
      // family — 'IPv4' в Node 16 (сборка win7) и 4 в Node 18.0–18.3.
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal || !isIPv4(a.address) || a.address.startsWith('169.254.')) continue;
      if (!out.includes(a.address)) out.push(a.address);
    }
  }
  return out.slice(0, 4);
}

// Куда подключаться: имя, если порт по нему отвечает; иначе первый адрес ПК, где порт отвечает;
// не ответил никто — всё равно имя (просмотрщик сам будет переподключаться: ПК может загружаться).
//   isOpen — (имя или адрес) => Promise<boolean>.  → { target, open }
async function pickTarget(host, addrs, isOpen) {
  if (await isOpen(host)) return { target: host, open: true };
  for (const ip of (addrs || []).filter(isIPv4)) {
    if (ip !== host && await isOpen(ip)) return { target: ip, open: true };
  }
  return { target: host, open: false };
}

module.exports = {
  isRemoteHost, remoteHostsOf, viewerArgs, viewerCandidates, findViewer, launchViewer, defaultVncUser, credentialArgs, parsePing,
  isIPv4, localIPv4, pickTarget,
};
