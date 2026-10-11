// Неотправленные сообщения, которые переживают закрытие окна чата.
//
// Сообщение, написанное без связи, раньше жило только в памяти окна чата: закрыл окно — оно пропало
// молча. Теперь оно лежит в localStorage (общем для всех окон клиента) и уходит одним из двух путей:
//   • окно этого чата открыто — отправляет оно само (показывает «Не отправлено · Повторить»);
//   • окно закрыто — отправляет список сотрудников, когда появится связь: он работает всегда.
// Чтобы оба не отправили одно и то же, открытое окно держит «отметку хозяина» и обновляет её каждые
// несколько секунд; список трогает только те диалоги, у которых отметки нет или она протухла (окно
// закрыли или оно упало).
//
// Давнее само не уходит: сообщение «буду через пять минут», отправленное на следующий день, хуже
// неотправленного. Такое остаётся в чате с кнопкой «Повторить» — решает человек.
//
// Подключается и в окно чата, и в список; для теста — обычный модуль Node (см. outbox.test.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Outbox = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const AUTO_SEND_MAX_AGE_MS = 12 * 3600 * 1000; // старше — только вручную
  const OWNER_BEAT_MS = 4000;                    // как часто открытое окно обновляет отметку
  const OWNER_STALE_MS = 15000;                  // отметка старше — окна уже нет
  const MAX_ITEMS = 50;                          // на один диалог: защита от разрастания хранилища

  const prefix = (meId) => `outbox:${meId}:`;
  const outboxKey = (meId, type, id) => `${prefix(meId)}${type}:${id}`;
  const ownerKey = (meId, type, id) => `outbox-owner:${meId}:${type}:${id}`;
  const isFresh = (at, now) => now - at <= AUTO_SEND_MAX_AGE_MS;

  // Только то, что сервер примет как сообщение; остальное из хранилища не берём (его мог испортить кто угодно).
  function validItem(x) {
    const p = x && x.payload;
    if (!p || p.type !== 'send' || typeof x.at !== 'number') return false;
    const hasText = typeof p.text === 'string' && p.text.trim() !== '';
    const hasFiles = Array.isArray(p.files) && p.files.length > 0;
    return (hasText || hasFiles) && (p.to != null || p.room != null);
  }

  function read(storage, key) {
    try {
      const list = JSON.parse(storage.getItem(key) || '[]');
      return Array.isArray(list) ? list.filter(validItem) : [];
    } catch { return []; }
  }
  function write(storage, key, items) {
    try {
      if (!items.length) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(items.slice(-MAX_ITEMS)));
    } catch { /* хранилище переполнено или недоступно — сообщение останется только в окне, как раньше */ }
  }

  function ownerAlive(storage, key, now) {
    const at = Number(storage.getItem(key));
    return Number.isFinite(at) && at > 0 && now - at < OWNER_STALE_MS;
  }

  /**
   * Что список может отправить сам: диалоги без живого окна, в каждом — свежие сообщения.
   * Возвращает [{ key, send: [...], keep: [...] }]; keep — давние, они остаются ждать человека.
   */
  function collectClosed(storage, meId, now) {
    const out = [];
    const pre = prefix(meId);
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key || !key.startsWith(pre)) continue;
      const dialog = key.slice(pre.length);                       // "dm:5" | "room:group:3"
      if (ownerAlive(storage, `outbox-owner:${meId}:${dialog}`, now)) continue;
      const items = read(storage, key);
      const send = items.filter((x) => isFresh(x.at, now));
      if (send.length) out.push({ key, send, keep: items.filter((x) => !isFresh(x.at, now)) });
    }
    return out;
  }

  return { AUTO_SEND_MAX_AGE_MS, OWNER_BEAT_MS, OWNER_STALE_MS, MAX_ITEMS, outboxKey, ownerKey, isFresh, read, write, ownerAlive, collectClosed };
});
