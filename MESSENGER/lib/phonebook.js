'use strict';
// ============================================================================
//  Номер сотрудника из справочника журнала звонков (с 1.1.33)
//
//  Просьба пользователя 2026-11-07: при наведении на сотрудника в «Искре» видеть его рабочий номер.
//  Номера ведутся в модуле «Журнал звонков» (SMDR/web-node, страница «Справочник добавочных»:
//  добавочный → ФИО). Модуль работает на этой же машине и отдаёт справочник по
//  GET /api/directory только локально, поэтому «Искра» ходит туда напрямую, раз в REFRESH_MS.
//
//  Связи по id между системами нет — сопоставляем по ФИО. В справочнике ФИО пишут по-разному:
//  «Петров Игорь Николаевич», «Петров И.Н.», «петров и. н.», с «ё» и без. Поэтому ключей два:
//  полное ФИО и «фамилия + инициалы». Ключ по инициалам, который подходит нескольким людям из
//  справочника, не используем — лучше без номера, чем чужой номер.
//
//  Справочник недоступен (модуль остановлен, не установлен) — номеров просто нет; «Искра» работает
//  как раньше. Адрес — SMDR_DIRECTORY_URL, пустое значение выключает.
// ============================================================================

const http = require('http');

const REFRESH_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 5000;

function words(name) {
  return String(name || '').toLowerCase().replace(/ё/g, 'е').replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
}
// Ключи одного ФИО: полное («петров игорь николаевич») и с инициалами («петров и н»).
function keysOf(name) {
  const w = words(name);
  if (!w.length) return [];
  const keys = [w.join(' ')];
  if (w.length >= 2) keys.push([w[0], ...w.slice(1).map((x) => x.charAt(0))].join(' '));
  return [...new Set(keys)];
}

// [{ ext, fio }] → функция «ФИО → номера через запятую или null».
function buildIndex(entries) {
  const byKey = new Map(); // ключ → Map(ФИО-как-записано → Set(добавочных))
  for (const e of Array.isArray(entries) ? entries : []) {
    const ext = String((e && e.ext) || '').trim();
    if (!/^\d{1,10}$/.test(ext)) continue;
    const fio = words(e.fio).join(' ');
    for (const key of keysOf(e.fio)) {
      if (!byKey.has(key)) byKey.set(key, new Map());
      const people = byKey.get(key);
      if (!people.has(fio)) people.set(fio, new Set());
      people.get(fio).add(ext);
    }
  }
  return (displayName) => {
    for (const key of keysOf(displayName)) {
      const people = byKey.get(key);
      // Одному ключу — один человек из справочника (у него может быть несколько добавочных).
      if (people && people.size === 1) return [...[...people.values()][0]].sort().join(', ');
    }
    return null;
  };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`ответ ${res.statusCode}`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 5 * 1024 * 1024) req.destroy(new Error('слишком большой ответ')); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (err) { reject(err); } });
    });
    req.on('timeout', () => req.destroy(new Error('не отвечает')));
    req.on('error', reject);
  });
}

// Живой справочник: phoneOf(ФИО), version() — меняется, когда поменялось содержимое (для ETag списка).
function startPhonebook({ url, log, onChange }) {
  let lookup = () => null;
  let version = 0;
  let lastJson = null;
  let failing = false;
  async function refresh() {
    if (!url) return;
    try {
      const entries = await fetchJson(url);
      const json = JSON.stringify(entries);
      if (failing) { failing = false; log('INFO', 'phonebook_available', { url }); }
      if (json === lastJson) return;
      lastJson = json;
      lookup = buildIndex(entries);
      version += 1;
      if (onChange) onChange();
    } catch (err) {
      // В журнал — один раз на сбой, а не каждые пять минут.
      if (!failing) { failing = true; log('WARN', 'phonebook_unavailable', { url, message: err.message }); }
    }
  }
  if (url) {
    refresh();
    setInterval(refresh, REFRESH_MS).unref();
  }
  return { phoneOf: (name) => lookup(name), version: () => version, refresh };
}

module.exports = { keysOf, buildIndex, startPhonebook };
