const nodemailer = require("nodemailer");
const config = require("../config/config");
const { getSetting, setSetting } = require("./settings");

// ============================================================================
//  Отправка почты
//
//  Настройки живут в базе, а не только в .env: раздел «Оповещения» должен
//  настраиваться из панели целиком, иначе он наполовину декоративный. Это то
//  же решение, что уже принято по сертификатам — загружать из веба, а не
//  править файлы на сервере руками.
//
//  .env при этом остаётся запасным путём: если в базе пусто, берём оттуда.
//  Так платформа, поднятая на новом месте со старым .env, продолжает слать
//  письма, пока настройки не завели через панель.
//
//  Пароль SMTP лежит в базе открытым текстом. Уровень доверия тот же, что у
//  .env: оба файла лежат рядом на одном сервере, ни один не доступен из сети,
//  и оба одинаково читаются тем, кто до сервера уже добрался. Наружу пароль не
//  отдаётся никогда — API возвращает только признак «задан или нет».
// ============================================================================

const KEYS = {
  host: "smtp_host",
  port: "smtp_port",
  secure: "smtp_secure",
  user: "smtp_user",
  password: "smtp_password",
  from: "smtp_from",
};

// Транспорт держим собранным между письмами (nodemailer переиспользует
// соединение), но сбрасываем, как только настройки изменили из панели —
// иначе письма продолжали бы уходить через прежний сервер до перезапуска.
let cached = null;
let cachedFingerprint = "";

/**
 * Действующие настройки: что в базе, дополненное .env там, где база молчит.
 * Поле `source` говорит, откуда взялось значение хоста, — чтобы в панели было
 * видно, правится оно здесь же или в файле на сервере.
 */
function readSettings(db) {
  const fromDb = (key) => {
    const v = getSetting(db, KEYS[key]);
    return v === null || v === "" ? null : v;
  };

  const host = fromDb("host") || config.smtp.host || "";
  const portRaw = fromDb("port");
  const secureRaw = fromDb("secure");
  const password = fromDb("password") || config.smtp.password || "";

  return {
    host,
    port: Number(portRaw || config.smtp.port) || 465,
    // В базе храним строкой «1»/«0»: settings — таблица ключ-значение, типов там нет.
    secure: secureRaw === null ? config.smtp.secure !== false : secureRaw === "1",
    user: fromDb("user") || config.smtp.user || "",
    password,
    from: fromDb("from") || config.smtp.from || "",
    source: fromDb("host") ? "панель" : config.smtp.host ? ".env" : null,
    configured: Boolean(host),
    hasPassword: Boolean(password),
  };
}

/**
 * Сохранить настройки из панели. Пустой пароль означает «не менять»: иначе
 * администратор, поправивший порт, каждый раз молча стирал бы пароль.
 * Чтобы пароль убрать, передайте clearPassword.
 */
function writeSettings(db, values) {
  const put = (key, value) => setSetting(db, KEYS[key], value === undefined || value === null ? "" : String(value));

  if (values.host !== undefined) put("host", String(values.host).trim());
  if (values.port !== undefined) put("port", String(Number(values.port) || 465));
  if (values.secure !== undefined) put("secure", values.secure ? "1" : "0");
  if (values.user !== undefined) put("user", String(values.user).trim());
  if (values.from !== undefined) put("from", String(values.from).trim());

  if (values.clearPassword) put("password", "");
  else if (values.password) put("password", String(values.password));

  reset();
}

function reset() {
  cached = null;
  cachedFingerprint = "";
}

function fingerprint(s) {
  return [s.host, s.port, s.secure, s.user, s.password].join("|");
}

function getTransporter(db) {
  const s = readSettings(db);
  if (!s.configured) return null;

  const fp = fingerprint(s);
  if (cached && cachedFingerprint === fp) return cached;

  cached = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: s.user ? { user: s.user, pass: s.password } : undefined,
    // Ждать соединения вечно нельзя: отправка идёт внутри запроса на создание
    // заявки, и недоступный почтовый сервер подвесил бы саму заявку.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  cachedFingerprint = fp;
  return cached;
}

/**
 * Проверка соединения без отправки письма — кнопка «Проверить» в панели.
 * Всегда возвращает результат, никогда не бросает: на этой кнопке текст ошибки
 * и есть весь смысл.
 */
async function verify(db) {
  const s = readSettings(db);
  if (!s.configured) {
    return { ok: false, error: "Адрес SMTP-сервера не задан — письма не отправляются вовсе" };
  }
  try {
    await getTransporter(db).verify();
    return { ok: true, detail: `${s.host}:${s.port}${s.secure ? ", TLS" : ""}` };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

/**
 * Отправить письмо. Возвращает { ok, error } и не бросает исключений:
 * упавшая отправка не должна ронять действие, ради которого она затевалась
 * (создание заявки, комментарий). Причина при этом не теряется — вызывающий
 * записывает её в журнал доставки.
 */
async function send(db, { to, subject, text }) {
  const s = readSettings(db);
  // Почта ещё не настроена — это не провал доставки, а «пока некуда». Письмо
  // остаётся в очереди и уйдёт, как только заполнят настройки: иначе всё,
  // что случилось до настройки SMTP, потерялось бы навсегда.
  if (!s.configured) {
    return { ok: false, error: "SMTP не настроен", retriable: true };
  }
  // А вот адреса у получателя нет — повторять бессмысленно, пока его не заведут.
  if (!to) {
    return { ok: false, error: "Адрес получателя не известен", retriable: false };
  }
  try {
    await getTransporter(db).sendMail({
      from: s.from || s.user || "helpdesk@localhost",
      to,
      subject,
      text,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err), retriable: isRetriable(err) };
  }
}

// Стоит ли повторять. Недоступный сервер и таймаут — да, почтовый сервер
// поднимут. Отвергнутый адрес и отказ в аутентификации — нет: пока не
// поправят настройки или список, повтор даст ровно ту же ошибку и только
// засорит журнал.
function isRetriable(err) {
  const code = err && err.code;
  return ["ECONNECTION", "ESOCKET", "ETIMEDOUT", "EDNS", "ECONNRESET"].includes(code);
}

// Ошибки nodemailer наружу выглядят как «connect ETIMEDOUT 10.0.0.1:465» —
// технически точно и совершенно бесполезно для того, кто настраивает почту.
// Переводим самые частые в то, что подсказывает, куда смотреть.
function describe(err) {
  const code = err && err.code;
  const text = (err && err.message) || "неизвестная ошибка";
  if (code === "EAUTH") return `Сервер отверг логин или пароль: ${text}`;
  if (code === "ECONNECTION" || code === "ESOCKET") {
    return `Не удалось соединиться с сервером — проверьте адрес, порт и режим TLS: ${text}`;
  }
  if (code === "ETIMEDOUT" || code === "ECONNECTION_TIMEOUT") {
    return "Сервер не ответил вовремя — проверьте адрес и что порт не закрыт межсетевым экраном";
  }
  if (code === "EENVELOPE") return `Сервер не принял адрес получателя: ${text}`;
  if (code === "EDNS") return `Имя сервера не разрешается в адрес: ${text}`;
  return text;
}

/**
 * Проверка адреса — при СОХРАНЕНИИ списка, а не при отправке. Раз списки
 * получателей ведём вручную, опечатка неизбежна, и заметить её надо в тот
 * момент, когда человек смотрит на поле, а не через месяц по отсутствию писем.
 * Правило нарочно нестрогое: задача — поймать «ivanov@» и «ivanov.ru», а не
 * реализовать RFC 5322.
 */
function isEmail(value) {
  return /^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(String(value || "").trim());
}

/** Разобрать список адресов из текстового поля: по одному на строку, запятые тоже принимаем. */
function parseEmails(text) {
  return String(text || "")
    .split(/[\r\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = { readSettings, writeSettings, verify, send, reset, isEmail, parseEmails };
