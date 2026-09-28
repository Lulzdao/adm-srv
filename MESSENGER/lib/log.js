'use strict';

// ---------- Логирование ----------
// Простой файловый логгер без внешних зависимостей — для 20-200 человек в локальной сети выделенный
// пакет (winston/pino) избыточен. Ротация "по дню" через имя файла: server-YYYY-MM-DD.log — входы/
// выходы, срабатывания rate-limit, ошибки сервера; client-YYYY-MM-DD.log — ошибки с рабочих мест
// сотрудников (см. POST /api/client-log в server.js), чтобы разбирать инциденты по логам на сервере,
// а не просить каждого прислать скриншот или лезть к нему на ПК за файлом. Обе записи дублируются в
// консоль, как и раньше (console.log/warn при старте никуда не делись).
//
// Файлы по дням разложены по папкам месяцев: logs/2026-09/server-2026-09-28.log. Журналы не
// удаляются — старое администратор чистит сам, целыми месяцами (так решил пользователь). Панель
// по-прежнему читает ровно один день, а не перебирает месячный файл.

const fs = require('fs');
const path = require('path');

// День — по местному времени сервера, как его видит администратор и как его спрашивает панель
// (todayStr в panel.js). Раньше брался день по UTC: у нас это +3 часа, и записи с полуночи до трёх
// ночи попадали во «вчерашний» файл, а панель в это время открывала пустой «сегодняшний».
// Время в самих строках по-прежнему ISO в UTC — панель переводит его в местное при показе.
function dayStamp(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function createLogger(logsDir) {
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);
  function logFilePath(source, day) { return path.join(logsDir, day.slice(0, 7), `${source}-${day}.log`); }
  let readyMonthDir = null; // папка месяца, которая точно есть, — чтобы не проверять диск на каждую строку
  function writeLogLine(source, line, sync = false) {
    const file = logFilePath(source, dayStamp());
    const dir = path.dirname(file);
    if (dir !== readyMonthDir) {
      try { fs.mkdirSync(dir, { recursive: true }); readyMonthDir = dir; } catch { /* запись ниже просто не удастся */ }
    }
    // Запись лога не должна блокировать ответ на реальный запрос и не должна валить процесс, если
    // диск временно недоступен — поэтому асинхронно и без ожидания/обработки результата.
    // Кроме ошибок сервера (sync): за ними часто сразу идёт process.exit (сбой запуска, неперехваченное
    // исключение), и асинхронная запись не успевала дойти до файла — строка оставалась только в
    // выводе службы. Ошибки редки, подождать их записи не жалко.
    if (sync) {
      try { fs.appendFileSync(file, line + '\n'); } catch { /* диск недоступен — остаётся консоль */ }
      return;
    }
    fs.appendFile(file, line + '\n', () => {});
  }
  // Журналы, написанные до раскладки по месяцам (logs/server-2026-09-28.log), — в папки месяцев.
  // Файл, для которого в папке уже есть одноимённый, не трогаем: ничего не теряем и не склеиваем.
  for (const name of fs.readdirSync(logsDir)) {
    const m = /^(?:server|client)-(\d{4}-\d{2})-\d{2}\.log$/.exec(name);
    if (!m) continue;
    const target = path.join(logsDir, m[1], name);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) fs.renameSync(path.join(logsDir, name), target);
    } catch { /* файл занят — останется на месте до следующего запуска */ }
  }
  function logServer(level, event, meta = {}) {
    const line = `${new Date().toISOString()} [${level}] ${event} ${JSON.stringify(meta)}`;
    writeLogLine('server', line, level === 'ERROR');
    (level === 'ERROR' ? console.error : console.log)(line);
  }
  function logClient(entry) {
    const line = `${new Date().toISOString()} [CLIENT] ${JSON.stringify(entry)}`;
    writeLogLine('client', line);
    console.error(line); // ошибка на чьём-то рабочем месте — сразу видно и в консоли сервера, не только в файле
  }
  return { logServer, logClient, logFilePath };
}

const LOG_VIEW_LIMIT = 2000;
// Разбирает одну строку лог-файла обратно в структуру — формат задан в logServer/logClient выше:
// "<ISO-время> [LEVEL] событие {...meta}" для серверных записей, "<ISO-время> [CLIENT] {...}" для
// присланных клиентом. Строки, не подошедшие под формат (например, обрезанные при аварийном
// завершении записи), тихо пропускаются, а не ломают всю выдачу.
function parseLogLine(line, source) {
  const spaceIdx = line.indexOf(' ');
  if (spaceIdx < 0) return null;
  const ts = line.slice(0, spaceIdx);
  const rest = line.slice(spaceIdx + 1);
  if (source === 'server') {
    const m = rest.match(/^\[(\w+)\] (\S+) (\{[\s\S]*\})$/);
    if (!m) return null;
    let meta = {};
    try { meta = JSON.parse(m[3]); } catch { /* строка повреждена — оставляем meta пустым */ }
    return { ts, level: m[1], source: 'server', event: m[2], meta };
  }
  const m = rest.match(/^\[CLIENT\] (\{[\s\S]*\})$/);
  if (!m) return null;
  let meta = {};
  try { meta = JSON.parse(m[1]); } catch { /* строка повреждена — оставляем meta пустым */ }
  // Уровень присылает сам клиент (см. logLocal в main.js). У записей, сделанных прежними сборками,
  // его нет — там по-прежнему ERROR, как и раньше.
  return { ts, level: meta.level || 'ERROR', source: 'client', event: meta.kind || 'client_error', meta };
}

module.exports = { createLogger, dayStamp, parseLogLine, LOG_VIEW_LIMIT };
