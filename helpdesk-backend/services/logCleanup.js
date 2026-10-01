const fs = require("node:fs");
const path = require("node:path");

// ============================================================================
//  Очистка старых журналов служб
//
//  Службы запущены через NSSM с ротацией (DEPLOY.md: AppRotateFiles 1,
//  AppRotateBytes 10 МБ): когда platform.out.log дорастает до 10 МБ, NSSM
//  переименовывает его в platform.out-20261001T184700.123.log и начинает
//  новый. Старые куски он НЕ удаляет никогда — за годы папка logs занимает
//  гигабайты на том же диске, что и базы.
//
//  Задание планировщика раз в месяц удаляет куски старше LOG_KEEP_DAYS (по
//  умолчанию 180 дней; 0 — не удалять ничего). Трогает ТОЛЬКО файлы с меткой
//  времени NSSM в имени: текущие журналы (*.out.log, *.err.log), журналы
//  «Искры» по месяцам (их чистят вручную — так решено) и всё прочее в папке
//  остаётся как есть.
// ============================================================================

const ROOT = path.join(__dirname, "..", "..");
const DEFAULT_KEEP_DAYS = 180;
// <имя>-ГГГГММДДTЧЧММСС.ммм.log — так NSSM называет отрезанный кусок.
const ROTATED = /^.+-\d{8}T\d{6}\.\d{3}\.log$/;
const DAY = 24 * 60 * 60 * 1000;

function logsDir() {
  return process.env.SERVICE_LOGS_DIR || path.join(ROOT, "logs");
}

function keepDays() {
  const raw = process.env.LOG_KEEP_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_KEEP_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_KEEP_DAYS;
}

/** Нарезанные куски в папке журналов: [{ name, size, mtime }]. Папки нет — пусто. */
function rotatedFiles(dir = logsDir()) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!ROTATED.test(name)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) out.push({ name, size: st.size, mtime: st.mtimeMs });
    } catch { /* файл исчез между чтением списка и stat — не беда */ }
  }
  return out;
}

/** Сколько всего занимает папка журналов (для «Состояния»). */
function usage(dir = logsDir()) {
  let bytes = 0; let files = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      try { const st = fs.statSync(path.join(dir, name)); if (st.isFile()) { bytes += st.size; files++; } } catch { /* пропал */ }
    }
  } catch { return null; }
  return { dir, files, bytes, rotated: rotatedFiles(dir).length, keepDays: keepDays() };
}

/** Задание планировщика. Возвращает сводку для панели. */
function run(db, now = new Date()) {
  const dir = logsDir();
  const days = keepDays();
  if (!days) return { каталог: dir, удалено: "ничего — очистка выключена (LOG_KEEP_DAYS=0)" };
  const border = now.getTime() - days * DAY;
  let removed = 0; let bytes = 0; const failed = [];
  const all = rotatedFiles(dir);
  for (const f of all) {
    if (f.mtime >= border) continue;
    try { fs.unlinkSync(path.join(dir, f.name)); removed++; bytes += f.size; }
    catch (err) { failed.push(`${f.name}: ${err.code || err.message}`); }
  }
  const detail = { каталог: dir, "старше дней": days, удалено: removed, мегабайт: Math.round(bytes / 1048576 * 10) / 10, осталось: all.length - removed };
  // Занятый файл — не авария: попробуем через месяц. Но в сводке его видно.
  if (failed.length) detail["не удалось"] = failed.slice(0, 5).join("; ");
  return detail;
}

module.exports = { run, usage, logsDir, keepDays };
