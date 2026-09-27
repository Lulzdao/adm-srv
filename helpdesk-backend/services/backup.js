const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const config = require("../config/config");

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

/** Каталог для копий: BACKUP_DIR или <корень установки>\backups. */
function backupDir() {
  return process.env.BACKUP_DIR || path.join(ROOT, "backups");
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
  const dir = backupDir();
  const month = monthKey(now);
  const list = Object.entries(databases());
  if (!list.length) return { месяц: month, скопировано: "ничего — список баз пуст" };
  fs.mkdirSync(dir, { recursive: true });
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

module.exports = { run, databases, backupDir, snapshot };
