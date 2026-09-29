const config = require("../config/config");
const modules = require("../config/modules");

// ============================================================================
//  Канал оповещений «Искра»
//
//  Платформа отправляет личное сообщение от служебного пользователя «Центр»
//  через точку /api/system/notify самой «Искры». Получатель ищется там по ФИО:
//  в «Искре» логин и есть ФИО, а у администратора платформы ФИО приходит из
//  домена. Не нашёлся или нашлось двое — «Искра» так и отвечает, и причина
//  остаётся в журнале доставок, а не пропадает молча.
//
//  Адрес по умолчанию — тот же, по которому платформа проксирует веб-панель
//  «Искры» (config/modules.js): имя из её сертификата, иначе HTTPS не пройдёт
//  проверку имени. Задавать ISKRA_NOTIFY_URL нужно, только если «Искра»
//  переехала.
// ============================================================================

const TIMEOUT_MS = 8000;

function endpoint() {
  if (config.iskra.url) return config.iskra.url;
  const mod = modules.find((m) => m.id === "messenger");
  return mod ? mod.target.replace(/\/$/, "") + "/api/system/notify" : "";
}

/** Настроен ли канал. Без секрета «Искра» всё равно ответит отказом. */
function configured() {
  return whyDisabled() === null;
}

/** Почему канал выключен — для панели. null, если включён. */
function whyDisabled() {
  if (!config.iskra.token) return "в .env платформы не задан ISKRA_NOTIFY_TOKEN";
  // Секрет едет в заголовке HTTP, а там допустима только латиница: с кириллицей
  // fetch падает ещё до сети, и это выглядело бы как «Искра недоступна».
  if (!/^[\x21-\x7e]+$/.test(config.iskra.token)) return "ISKRA_NOTIFY_TOKEN должен состоять из латиницы, цифр и знаков, без пробелов и кириллицы";
  if (!endpoint()) return "не задан адрес «Искры» (ISKRA_NOTIFY_URL)";
  return null;
}

/**
 * Отправить сообщение человеку с таким ФИО.
 * Возвращает то же, что mailer.send: { ok, error, retriable }.
 */
async function send({ to, text }) {
  if (!configured()) return { ok: false, error: `Канал «Искра» не настроен: ${whyDisabled()}`, retriable: false };
  if (!to) return { ok: false, error: "У получателя в платформе нет ФИО", retriable: false };

  let res;
  try {
    res = await fetch(endpoint(), {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.iskra.token}` },
      body: JSON.stringify({ to, text }),
    });
  } catch (err) {
    const reason = err.name === "TimeoutError" ? "не ответила вовремя" : (err.cause && err.cause.code) || err.message;
    // Лежит или перезапускается — попробуем на следующем обходе.
    return { ok: false, error: `«Искра» недоступна (${reason})`, retriable: true };
  }

  let body = {};
  try { body = await res.json(); } catch { /* не JSON — объясним по коду */ }
  if (res.ok) return { ok: true };
  const detail = body && body.error ? body.error : `ответ ${res.status}`;
  // 401/403 — секрет не совпал: повтор не поможет, пока не поправят .env.
  // 404/409 — нет такого человека или их двое: тоже не само пройдёт.
  // 5xx — сбой на той стороне, пробуем позже.
  return { ok: false, error: `«Искра»: ${detail}`, retriable: res.status >= 500 };
}

module.exports = { send, configured, whyDisabled, endpoint };
