'use strict';

// Размеры окон по умолчанию заданы 2026-10-08 (версия 1.0.17): список — шириной 340 во всю высоту у
// правого края, объявления — 574×423, чат — 380×520. Но на машинах до этого стояла прежняя «Искра»
// (1.1.1.0 от 25.08, ещё раньше — mini-messenger), и её settings.json в профиле остаётся: новый
// клиент брал оттуда старые запомненные размеры, и при «первой установке» окна выходили не те
// (замечено 2026-10-14). Поэтому один раз выбрасываем размеры, запомненные версией до 1.0.17, —
// после этого окна открываются в размерах по умолчанию. Размеры, которые человек сам подогнал уже
// в новой версии, не трогаем.
const SIZE_KEYS = ['rosterSize', 'chatSize', 'broadcastSize'];
const FIRST_VERSION_WITH_DEFAULTS = [1, 0, 17];

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Запомнены ли размеры версией, где уже были нынешние размеры по умолчанию. Старая нумерация 1.1.x
// (сборка 25.08) — старше 1.0.17, хотя число больше: её узнаём отдельно.
function sizesFromCurrentDefaults(lastSeenVersion) {
  const v = parseVersion(lastSeenVersion);
  if (!v || v[0] !== 1 || v[1] !== 0) return false;
  return v[2] >= FIRST_VERSION_WITH_DEFAULTS[2];
}

// saved — настройки, прочитанные из файла (без значений по умолчанию). Возвращает их же с
// выброшенными старыми размерами и отметкой, что проверка сделана (чтобы не повторять).
function dropStaleWindowSizes(saved) {
  if (!saved || saved.windowSizesChecked) return saved;
  const out = { ...saved, windowSizesChecked: true };
  if (!sizesFromCurrentDefaults(saved.lastSeenVersion)) for (const k of SIZE_KEYS) out[k] = null;
  return out;
}

module.exports = { dropStaleWindowSizes, sizesFromCurrentDefaults };
