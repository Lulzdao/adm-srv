'use strict';

// Что последнее сделало задание обновления на этой машине — одной строкой для панели «Клиенты».
//
// Зачем. 15.10 на 11 машинах из 54 версия не обновилась, и понять почему можно было только собрав
// журналы с каждой машины (C:\ProgramData\Iskra\updater.log). Теперь клиент сам разбирает свой
// журнал и сообщает серверу последнее значимое событие: «поставлено», «скачано, но не поставлено»,
// «ошибка …». Администратор видит это в списке клиентов.
//
// Строки журнала пишут updater.js и updater/iskra-update.ps1: «<время ISO> <текст>».

const RULES = [
  // Установщик отработал.
  [/^install (\S+): exit code 0\b/, (m) => ({ state: 'installed', version: m[1] })],
  [/^install (\S+): exit code (-?\d+)/, (m) => ({ state: 'install-failed', version: m[1], detail: `код ${m[2]}` })],
  [/^install (\S+): could not start installer: (.*)$/, (m) => ({ state: 'install-failed', version: m[1], detail: m[2] })],
  // Скачано — и, раз после этого нет строки об установке, не поставлено.
  [/^download ok: (\S+) -> ([^\s,]+)/, (m) => ({ state: 'downloaded', version: m[2], from: m[1] })],
  [/^check: installed (\S+), published (\S+) - nothing to do/, (m) => ({ state: 'current', version: m[1] })],
  // Сбои.
  [/^error: (.*)$/, (m) => ({ state: 'error', detail: m[1] })],
  [/^updater gave no answer(.*)$/, (m) => ({ state: 'error', detail: `нет ответа от программы${m[1]}` })],
  [/^could not start updater: (.*)$/, (m) => ({ state: 'error', detail: m[1] })],
  [/^refused: (.*)$/, (m) => ({ state: 'error', detail: m[1] })],
  [/^no program exe in (.*)$/, (m) => ({ state: 'error', detail: `нет программы в ${m[1]}` })],
];

// Последнее значимое событие журнала. Служебные строки (возврат «Искры» сотруднику, хранилище
// сертификатов) пропускаем: они сопровождают событие, а не заменяют его.
function parseUpdaterLog(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+(.*)$/.exec(lines[i].trim());
    if (!m) continue;
    for (const [re, make] of RULES) {
      const r = re.exec(m[2]);
      if (!r) continue;
      const out = { ...make(r), at: Date.parse(m[1]) || null };
      if (out.detail) out.detail = String(out.detail).slice(0, 200);
      return out;
    }
  }
  return null;
}

module.exports = { parseUpdaterLog };
