const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const config = require("../config/config");

// ============================================================================
//  Шифрование паролей, которые платформа хранит в базе
//
//  Пароли общих ящиков рассылок (mail_boxes.password) и SMTP оповещений
//  (settings.smtp_password) — это пароли приложений от почты организации.
//  Лежали открытым текстом, а база каждый месяц копируется на сетевую шару
//  (services/backup.js) и перед каждым обновлением (update.ps1): любой, кто
//  дотянулся до копии, получал почтовые ящики отделов.
//
//  Теперь в базе — AES-256-GCM, строка «enc:v1:<base64 iv|tag|данные>».
//  Ключ — НЕ в базе: переменная SECRET_KEY в .env (64 hex-символа или 32 байта
//  base64) или файл secret.key рядом с базой, который создаётся сам при первом
//  запуске. Копии баз берут только файлы *.db, поэтому без ключа пароли из них
//  не прочитать. Обратная сторона: переносите базу на другой сервер — переносите
//  и secret.key (иначе пароли ящиков придётся ввести заново; «Администрирование →
//  Состояние» об этом скажет).
//
//  Значение без префикса читается как есть: это пароль, сохранённый до
//  шифрования, — миграция (db/init.js) зашифрует его при запуске.
// ============================================================================

const PREFIX = "enc:v1:";
let cached = null;

function keyFile() {
  return path.join(path.dirname(path.resolve(config.dbPath)), "secret.key");
}

function parseKey(text) {
  const t = String(text || "").trim();
  if (/^[0-9a-f]{64}$/i.test(t)) return Buffer.from(t, "hex");
  const b = Buffer.from(t, "base64");
  return b.length === 32 ? b : null;
}

/** Ключ: из SECRET_KEY, иначе из secret.key рядом с базой (создаётся, если его нет). */
function key() {
  if (cached) return cached.key;
  const env = process.env.SECRET_KEY;
  if (env && env.trim()) {
    const k = parseKey(env);
    if (!k) throw new Error("SECRET_KEY в .env: нужен ключ 32 байта — 64 hex-символа или base64");
    cached = { key: k, source: "env" };
    return k;
  }
  const file = keyFile();
  let k = null;
  try { k = parseKey(fs.readFileSync(file, "utf8")); } catch { /* файла ещё нет */ }
  if (!k) {
    if (fs.existsSync(file)) throw new Error(`Файл ключа ${file} испорчен — нужен ключ 32 байта (hex или base64)`);
    k = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // wx — не перезаписать ключ, если его создал параллельный процесс.
    fs.writeFileSync(file, k.toString("hex") + "\n", { flag: "wx", mode: 0o600 });
  }
  cached = { key: k, source: "file", file };
  return k;
}

const isSealed = (value) => typeof value === "string" && value.startsWith(PREFIX);

/** Зашифровать. Пустое остаётся пустым: «пароль не задан» видно без ключа. */
function seal(plain) {
  if (plain === null || plain === undefined || plain === "") return "";
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
}

/**
 * Расшифровать. Не зашифрованное — как есть. Не подходит ключ (база с другого
 * сервера без его secret.key) — null: вызывающий считает пароль не заданным.
 */
function open(value) {
  if (!isSealed(value)) return value;
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Где ключ — для «Состояния». */
function keyInfo() {
  key();
  return { source: cached.source, file: cached.file || null };
}

/** Только для тестов: забыть ключ (новый DB_PATH / SECRET_KEY). */
function reset() { cached = null; }

module.exports = { seal, open, isSealed, keyInfo, keyFile, reset, PREFIX };
