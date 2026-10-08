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

// Где искать просмотрщик, по порядку. Папка у администраторов одна и та же, а диск — разный: у кого
// E:, у кого C:. Поэтому путь из сборки пробуется на нескольких дисках, а последним идёт папка
// сервера UltraVNC (Program Files\uvnc_s): она есть на каждом ПК, и просмотрщик с плагином
// шифрования в ней тоже лежит.
//
// Путь из машинной политики — единственный: администратор назвал его явно, и молча брать вместо
// него другой файл нельзя.
const DRIVES = ['C', 'D', 'E', 'F'];
function viewerCandidates(policyPath, defaultPath, programFilesDirs) {
  if (policyPath) return [policyPath];
  const list = [defaultPath];
  const tail = /^[a-z]:(\\.+)$/i.exec(defaultPath || '');
  if (tail) for (const d of DRIVES) list.push(`${d}:${tail[1]}`);
  for (const pf of programFilesDirs || []) if (pf) list.push(`${pf}\\uvnc_s\\vncviewer.exe`);
  const seen = new Set();
  return list.filter((p) => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()));
}

// Первый существующий из кандидатов или null. exists — (путь) => boolean.
function findViewer(candidates, exists) {
  for (const p of candidates) if (exists(p)) return p;
  return null;
}

module.exports = { isRemoteHost, remoteHostsOf, viewerArgs, viewerCandidates, findViewer };
