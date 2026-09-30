const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const config = require("../config/config");
const { getSetting, setSetting } = require("./settings");

// ============================================================================
//  Ежемесячная резервная копия баз: один файл на базу и месяц
//
//  Все данные хранятся в одной базе у каждой службы — звонки, заявки, оповещения
//  копятся годами, и это нормально: SQLite спокойно держит гигабайты, а поиск и
//  статистика за любой период работают как есть (решение 2026-09-27 — не делить
//  базы по месяцам). Но базы — единственное, что нельзя восстановить из
//  репозитория. Поэтому раз в месяц каждая копируется в отдельный файл:
//  backups\smdr-2026-10.db и т.д. Старые копии не удаляются.
//
//  Копия делается VACUUM INTO: SQLite сам собирает целостный снимок, даже пока
//  служба работает и пишет в базу (WAL), — в отличие от копирования файла, где
//  свежие записи из -wal не попали бы, а сам файл мог оказаться посреди записи.
//  Готовая копия проверяется integrity_check.
//
//  Задание планировщика «Резервная копия баз» (services/scheduler.js), раз в месяц.
// ============================================================================

const ROOT = path.join(__dirname, "..", "..");
const DEFAULT_DIR = path.join(ROOT, "backups");
const SETTING = "backup_dir";

/**
 * Куда класть копии: папка из панели («Администрирование» → «Резервные копии баз»)
 * → BACKUP_DIR из .env → <корень установки>\backups. source говорит, откуда
 * взято, — в панели видно, правится ли путь там же или в файле на сервере.
 */
function backupDir(db) {
  const fromPanel = db ? String(getSetting(db, SETTING) || "").trim() : "";
  if (fromPanel) return { dir: fromPanel, source: "panel" };
  if (process.env.BACKUP_DIR) return { dir: process.env.BACKUP_DIR, source: "env" };
  return { dir: DEFAULT_DIR, source: "default" };
}

// Учётная запись, под которой служба ходит в сеть. Служба NSSM по умолчанию работает
// как LocalSystem, а та в сети представляется учётной записью компьютера — ей и нужны
// права на сетевую папку. Имя показываем в подсказке, чтобы не гадать, кому их давать.
function networkAccount() {
  const domain = process.env.USERDOMAIN && process.env.USERDOMAIN !== os.hostname() ? process.env.USERDOMAIN : "ДОМЕН";
  return `${domain}\\${os.hostname().toUpperCase()}$`;
}

/**
 * Проверить папку: создать (если нет), записать пробный файл, прочитать, удалить —
 * от имени самой службы, то есть ровно с теми правами, с какими потом пойдёт копия.
 * Возвращает { ok } или { ok: false, error, hint } и никогда не бросает.
 */
function checkDir(dir) {
  const value = String(dir || "").trim();
  if (!value) return { ok: false, error: "Путь не указан" };
  if (!path.isAbsolute(value)) {
    return { ok: false, error: "Нужен полный путь", hint: "Например \\\\сервер\\папка\\backups или D:\\backups" };
  }
  const isUnc = value.startsWith("\\\\");
  const probe = path.join(value, `.adm-srv-проверка-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(value, { recursive: true });
    fs.writeFileSync(probe, "проверка записи резервной копии");
    const back = fs.readFileSync(probe, "utf8");
    fs.unlinkSync(probe);
    if (back !== "проверка записи резервной копии") throw new Error("записанное не читается обратно");
    return { ok: true };
  } catch (err) {
    try { fs.unlinkSync(probe); } catch { /* его и не было */ }
    const code = err.code || "";
    let hint;
    if (!isUnc && /^[A-Za-z]:/.test(value) && (code === "ENOENT" || code === "EPERM" || code === "EACCES")) {
      hint = "Если это сетевой диск, подключённый буквой, служба его не видит: такие диски есть только в сеансе " +
        "пользователя. Укажите сетевой путь: \\\\сервер\\папка\\backups.";
    } else if (isUnc && (code === "EACCES" || code === "EPERM")) {
      hint = `Нет прав на запись. Служба ходит в сеть под учётной записью компьютера — дайте ей права на ` +
        `изменение в этой папке (и на уровне общего ресурса, и в свойствах папки): ${networkAccount()}.`;
    } else if (isUnc) {
      hint = "Сетевая папка недоступна: проверьте имя сервера и общего ресурса и что сервер в сети.";
    }
    return { ok: false, error: err.message, hint };
  }
}

/** Копии, которые уже лежат в папке, — новые сверху. */
function listCopies(dir, limit = 24) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^[A-Za-z0-9_-]+-\d{4}-\d{2}\.db$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, size: st.size, modified: st.mtime.toISOString() };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified) || b.name.localeCompare(a.name))
      .slice(0, limit);
  } catch (err) {
    return { error: err.code === "ENOENT" ? "папки пока нет — появится с первой копией" : err.message };
  }
}

/**
 * Какие базы копировать: { имя: путь }.
 *
 * По умолчанию — все четыре, рядом с платформой. База «Искры» ищется по общему
 * хранилищу сертификатов (SHARED_CERT_DIR = <Искра>\certs): на боевом сервере
 * «Искра» может стоять отдельно, и путь к ней платформа уже знает оттуда.
 * BACKUP_DATABASES («имя=путь;имя=путь») заменяет список целиком.
 */
function databases() {
  const raw = process.env.BACKUP_DATABASES;
  if (raw && raw.trim()) {
    const list = {};
    for (const part of raw.split(";")) {
      const i = part.indexOf("=");
      if (i <= 0) continue;
      const name = part.slice(0, i).trim();
      const file = part.slice(i + 1).trim();
      if (/^[A-Za-z0-9_-]+$/.test(name) && file) list[name] = file;
    }
    return list;
  }
  const certDir = process.env.SHARED_CERT_DIR || path.join(ROOT, "MESSENGER", "certs");
  return {
    helpdesk: path.resolve(config.dbPath),
    certviewer: path.join(ROOT, "CERTVIEWER", "certificates.db"),
    smdr: path.join(ROOT, "SMDR", "smdr.db"),
    messenger: path.join(path.dirname(certDir), "messenger.db"),
  };
}

const pad = (n) => String(n).padStart(2, "0");
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Снимок одной базы в файл. Повторный запуск в том же месяце заменяет файл. */
function snapshot(src, dest) {
  const tmp = `${dest}.tmp`;
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  const db = new DatabaseSync(src, { readOnly: true });
  try {
    db.exec(`VACUUM INTO ${sqlString(tmp)}`);
  } finally {
    db.close();
  }
  const check = new DatabaseSync(tmp, { readOnly: true });
  let result;
  try {
    result = check.prepare("PRAGMA integrity_check").get();
  } finally {
    check.close();
  }
  const verdict = result && Object.values(result)[0];
  if (verdict !== "ok") {
    fs.unlinkSync(tmp);
    throw new Error(`копия ${path.basename(dest)} не прошла проверку целостности: ${verdict}`);
  }
  // Готовую копию — на место одним переименованием: полусделанного файла под
  // настоящим именем не бывает никогда.
  fs.renameSync(tmp, dest);
  return fs.statSync(dest).size;
}

/**
 * Сделать копии за текущий месяц. Возвращает сводку для панели. Если хоть одна
 * база не скопировалась — ошибка: планировщик тогда не отметит месяц
 * сделанным и повторит через час (удачные копии просто перезапишутся).
 */
async function run(db, now = new Date()) {
  const { dir } = backupDir(db);
  const month = monthKey(now);
  const list = Object.entries(databases());
  if (!list.length) return { месяц: month, скопировано: "ничего — список баз пуст" };
  // Папку (в том числе сетевую) создаём сами; не выходит — понятная ошибка с подсказкой,
  // окно месяца не закрывается, и через час будет новая попытка.
  const access = checkDir(dir);
  if (!access.ok) throw new Error(`папка для копий ${dir} недоступна: ${access.error}${access.hint ? ` — ${access.hint}` : ""}`);
  const done = [];
  const missing = [];
  const failed = [];
  let bytes = 0;
  for (const [name, file] of list) {
    if (!fs.existsSync(file)) { missing.push(name); continue; }
    try {
      bytes += snapshot(file, path.join(dir, `${name}-${month}.db`));
      done.push(name);
    } catch (err) {
      failed.push(`${name}: ${err.message}`);
    }
  }
  if (failed.length) throw new Error(`не скопированы — ${failed.join("; ")}`);
  const detail = { месяц: month, скопировано: done.join(", ") || "ничего", мегабайт: Math.round(bytes / 1048576 * 10) / 10, каталог: dir };
  if (missing.length) detail["нет файла"] = missing.join(", ");
  return detail;
}

// Сколько попыток подряд не удалось. Один сбой — не повод писать: сетевая папка
// бывает недоступна минуту, а следующая попытка через час. Три подряд — уже нет.
const STREAK = "backup_fail_streak";
const ALERT_AFTER = 3;

/**
 * run() для планировщика: считает неудачи подряд и после третьей оповещает
 * (категория «Резервная копия баз не удалась», одно событие за месяц).
 */
async function runWatched(db, now = new Date()) {
  try {
    const detail = await run(db, now);
    setSetting(db, STREAK, "0");
    return detail;
  } catch (err) {
    const streak = (Number(getSetting(db, STREAK)) || 0) + 1;
    setSetting(db, STREAK, String(streak));
    if (streak >= ALERT_AFTER) {
      const month = monthKey(now);
      require("./notifications").emit(db, {
        kind: "backup_failed",
        subject: `Резервная копия баз за ${month} не удалась`,
        subjectRef: month,
        dedupKey: `backup_failed:${month}`,
        payload: { месяц: month, ошибка: err.message, папка: backupDir(db).dir, попыток: String(streak) },
      });
    }
    throw err;
  }
}

/** Сохранить папку из панели. Пусто — вернуться к .env / папке по умолчанию. */
function setBackupDir(db, dir) {
  setSetting(db, SETTING, String(dir || "").trim());
}

module.exports = { run, runWatched, databases, backupDir, setBackupDir, checkDir, listCopies, snapshot, DEFAULT_DIR };
