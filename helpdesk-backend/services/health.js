const fs = require("node:fs");
const path = require("node:path");
const modules = require("../config/modules");
const backup = require("./backup");
const scheduler = require("./scheduler");
const { currentTlsState } = require("./tls");
const mailer = require("./mailer");

// ============================================================================
//  Состояние системы — одна сводка для раздела «Администрирование → Состояние»
//
//  Раньше, чтобы понять, всё ли в порядке, надо было идти на сервер: смотреть
//  службы, журналы, свободное место и папку копий. Здесь то же самое собрано
//  на одной странице, и у каждого пункта уровень: ok / warn / crit — по нему
//  страница красит строку и считает итог.
//
//  Ничего не меняет и не пишет — только смотрит. Модули опрашиваются тем же
//  адресом, что и прокси (config/modules.js), с коротким таймаутом.
// ============================================================================

const ROOT = path.join(__dirname, "..", "..");
const PROBE_MS = 4000;
const GB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;

const item = (level, label, text, extra = {}) => ({ level, label, text, ...extra });
const size = (bytes) => (bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} КБ` : `${(bytes / 1048576).toFixed(1)} МБ`);

// TLS-ошибки — модуль работает, но платформа не доверяет его сертификату:
// через меню он тогда не откроется, хотя служба жива.
const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|UNABLE_TO_GET_ISSUER/;

async function probeModule(mod) {
  const started = Date.now();
  try {
    const res = await fetch(mod.target.replace(/\/$/, "") + "/", { redirect: "manual", signal: AbortSignal.timeout(PROBE_MS) });
    await res.arrayBuffer().catch(() => {});
    return item("ok", mod.label, `работает — ответ за ${Date.now() - started} мс`, { target: mod.target });
  } catch (err) {
    const code = (err.cause && err.cause.code) || err.code || "";
    if (err.name === "TimeoutError") return item("crit", mod.label, `не ответил за ${PROBE_MS / 1000} с`, { target: mod.target });
    if (TLS_CODES.test(code)) {
      return item("warn", mod.label, `работает, но платформа не доверяет его сертификату (${code}) — из меню не откроется`, { target: mod.target });
    }
    if (code === "ECONNREFUSED") return item("crit", mod.label, "не запущен — порт не отвечает", { target: mod.target });
    return item("crit", mod.label, `недоступен: ${code || err.message}`, { target: mod.target });
  }
}

function services() {
  const up = process.uptime();
  const since = new Date(Date.now() - up * 1000).toISOString();
  const platform = item("ok", "Платформа", "работает", { since, node: process.version });
  return Promise.all(modules.map(probeModule)).then((mods) => [platform, ...mods]);
}

function version() {
  const file = path.join(ROOT, ".update", "version.txt");
  try {
    const sha = fs.readFileSync(file, "utf8").trim();
    return item("ok", "Версия", sha ? sha.slice(0, 7) : "неизвестна", { sha, updatedAt: fs.statSync(file).mtime.toISOString() });
  } catch {
    return item("ok", "Версия", "не обновлялась скриптом update.ps1 — номер неизвестен");
  }
}

/** Корень тома: «C:\», «\\сервер\ресурс\». */
function volumeOf(p) {
  return path.parse(path.resolve(p)).root.toLowerCase();
}

function disk(label, dir) {
  try {
    const st = fs.statfsSync(dir);
    const free = st.bavail * st.bsize;
    const total = st.blocks * st.bsize;
    const share = total ? free / total : 0;
    // По абсолютному месту: на терабайтном диске 6% — это 60 ГБ, тревожиться рано.
    const level = free < 2 * GB ? "crit" : free < 10 * GB || share < 0.05 ? "warn" : "ok";
    return item(level, label, `свободно ${(free / GB).toFixed(1)} из ${(total / GB).toFixed(1)} ГБ (${Math.round(share * 100)}%)`,
      { dir, free, total });
  } catch (err) {
    return item("warn", label, `не удалось узнать свободное место: ${err.code || err.message}`, { dir });
  }
}

function disks(db) {
  const list = [["Диск с платформой и базами", ROOT]];
  const { dir } = backup.backupDir(db);
  // Папку копий смотрим, только если она на другом томе — иначе это та же строка.
  if (volumeOf(dir) !== volumeOf(ROOT) && fs.existsSync(dir)) list.push(["Папка резервных копий", dir]);
  return list.map(([label, d]) => disk(label, d));
}

function backups(db, now = Date.now()) {
  const out = [];
  const { dir } = backup.backupDir(db);
  const job = scheduler.status(db).jobs.find((j) => j.id === "backup");
  const last = job && job.last;
  const copies = backup.listCopies(dir);
  const newest = Array.isArray(copies) && copies.length ? copies[0] : null;

  if (last && !last.ok) {
    out.push(item("crit", "Последняя копия", `попытка ${last.at} не удалась: ${last.error}`, { at: last.at }));
  } else if (!newest) {
    out.push(item("warn", "Последняя копия", Array.isArray(copies) ? "копий ещё нет" : copies.error));
  } else {
    const age = now - Date.parse(newest.modified);
    // Копия ежемесячная: 40 дней — с запасом на поздний запуск в начале месяца.
    out.push(item(age > 40 * DAY ? "warn" : "ok", "Последняя копия",
      `${newest.name}, ${size(newest.size)}` + (age > 40 * DAY ? " — старше 40 дней" : ""),
      { at: newest.modified }));
  }
  const sameVolume = !dir.startsWith("\\\\") && volumeOf(dir) === volumeOf(ROOT);
  out.push(item(sameVolume ? "warn" : "ok", "Где лежат копии",
    dir + (sameVolume ? " — на том же диске, что и базы: при отказе диска пропадут вместе с ними" : ""), { dir }));
  return out;
}

const DB_LABEL = { helpdesk: "Платформа", certviewer: "Сертвивер", smdr: "Журнал звонков", messenger: "«Искра»" };

function databases() {
  return Object.entries(backup.databases()).map(([name, file]) => {
    const label = DB_LABEL[name] || name;
    try {
      const st = fs.statSync(file);
      return item("ok", label, size(st.size), { file, modified: st.mtime.toISOString() });
    } catch {
      return item("warn", label, "файл не найден", { file });
    }
  });
}

function certificate() {
  const s = currentTlsState();
  if (!s.secure) return item("warn", "Сертификат", "не задан — платформа работает по http");
  const c = s.certificate;
  if (!c) return item("warn", "Сертификат", "задан, но разобрать его не удалось");
  const left = c.validTo ? Math.floor((Date.parse(c.validTo) - Date.now()) / DAY) : null;
  const level = left === null ? "warn" : left < 0 ? "crit" : left <= 30 ? "warn" : "ok";
  const text = left === null ? "срок неизвестен" : left < 0 ? `истёк ${-left} дн. назад` : `действует ещё ${left} дн.`;
  return item(level, "Сертификат", `${c.subject || ""} — ${text}`.replace(/^ — /, ""), { validTo: c.validTo });
}

function jobs(db) {
  const st = scheduler.status(db);
  const out = st.jobs.map((j) => {
    if (!j.last) return item("ok", j.label, "ещё не выполнялось");
    if (!j.last.ok) return item("warn", j.label, `последняя попытка не удалась: ${j.last.error}`, { at: j.last.at });
    return item("ok", j.label, "выполнено", { at: j.last.at });
  });
  if (!st.running) out.unshift(item("crit", "Планировщик", "не запущен — оповещения и копии не делаются"));
  return out;
}

function mail(db) {
  const out = [];
  if (!mailer.readSettings(db).configured) out.push(item("warn", "Почта оповещений", "почтовый сервер не настроен — письма ждут в очереди"));
  const q = db.prepare(`
    SELECT SUM(status = 'pending') AS pending,
           SUM(status = 'failed' AND created_at >= datetime('now', 'localtime', '-7 days')) AS failed
    FROM notification_deliveries WHERE channel = 'email'
  `).get();
  const pending = q.pending || 0;
  const failed = q.failed || 0;
  out.push(item(failed ? "warn" : pending > 20 ? "warn" : "ok", "Письма оповещений",
    `в очереди ${pending}, не ушло за 7 дней ${failed}`));
  const paused = db.prepare("SELECT COUNT(*) AS n FROM mail_campaigns WHERE status = 'paused'").get().n;
  if (paused) out.push(item("warn", "Рассылки", `на паузе: ${paused} — откройте «Ассистент → Рассылки»`));
  return out;
}

/** Вся сводка. Разделы — в том порядке, в каком их показывает страница. */
async function collect(db) {
  const sections = [
    { id: "services", title: "Службы", items: await services() },
    { id: "backup", title: "Резервные копии баз", items: backups(db) },
    { id: "disks", title: "Место на дисках", items: disks(db) },
    { id: "cert", title: "Сертификат сервера", items: [certificate()] },
    { id: "jobs", title: "Планировщик", items: jobs(db) },
    { id: "mail", title: "Почта", items: mail(db) },
    { id: "db", title: "Базы", items: databases() },
    { id: "version", title: "Версия", items: [version()] },
  ];
  const all = sections.flatMap((s) => s.items);
  return {
    checkedAt: new Date().toISOString(),
    crit: all.filter((i) => i.level === "crit").length,
    warn: all.filter((i) => i.level === "warn").length,
    sections,
  };
}

module.exports = { collect, probeModule, backups, disk, certificate };
