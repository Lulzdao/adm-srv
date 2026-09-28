'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, request, login, ADMIN } = require('./helpers/server');

// ============================================================================
//  Журналы по папкам месяцев
//
//  logs/2026-09/server-2026-09-28.log вместо россыпи дневных файлов в одной папке: старое
//  администратор удаляет сам, целыми месяцами. Файлы, записанные до этого, служба при запуске
//  раскладывает по папкам; панель читает день из папки его месяца.
// ============================================================================

const OLD_DAY = '2025-01-15';
const OLD_LINE = `${OLD_DAY}T09:00:00.000Z [WARN] login_failed {"username":"старый-вход"}\n`;

let srv, admin;
before(async () => {
  srv = await startServer({ files: { [`logs/server-${OLD_DAY}.log`]: OLD_LINE } });
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
});
after(() => srv && srv.stop());

test('журнал, записанный до раскладки, переезжает в папку своего месяца', () => {
  assert.equal(fs.existsSync(path.join(srv.dir, 'logs', `server-${OLD_DAY}.log`)), false);
  const moved = path.join(srv.dir, 'logs', '2025-01', `server-${OLD_DAY}.log`);
  assert.equal(fs.readFileSync(moved, 'utf8'), OLD_LINE, 'содержимое переносится как есть');
});

// Местная дата в заданном часовом поясе — ГГГГ-ММ-ДД.
const localDay = (timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

test('день журнала — местный, а не по UTC', async (t) => {
  // Пояс, в котором дата прямо сейчас отличается от UTC: +14 ч — с 10:00 UTC, −11 ч — до 11:00 UTC.
  // Так проверка честная в любое время суток, а не только ночью.
  const tz = new Date().getUTCHours() >= 10 ? 'Pacific/Kiritimati' : 'Pacific/Niue';
  const day = localDay(tz);
  assert.notEqual(day, new Date().toISOString().slice(0, 10), 'пояс подобран так, чтобы даты различались');
  const other = await startServer({ env: { TZ: tz } });
  t.after(() => other.stop());
  await login(other.url, ADMIN.username, ADMIN.password);
  const file = path.join(other.dir, 'logs', day.slice(0, 7), `server-${day}.log`);
  for (let i = 0; i < 20 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(file), `ожидался файл за местный день ${day} (${tz})`);
  const today = await request(other.url, 'GET', '/api/admin/logs', { token: (await login(other.url, ADMIN.username, ADMIN.password)).token });
  assert.ok(today.json.entries.some((e) => e.event === 'login'), 'панель без ?day= показывает местный «сегодня»');
});

test('новые записи ложатся в папку текущего месяца', async () => {
  const day = localDay(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const file = path.join(srv.dir, 'logs', day.slice(0, 7), `server-${day}.log`);
  // Вход выше уже записан; запись асинхронная — даём ей мгновение.
  for (let i = 0; i < 20 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(fs.readFileSync(file, 'utf8'), /\] login /);
  assert.deepEqual(fs.readdirSync(path.join(srv.dir, 'logs')).filter((f) => f.endsWith('.log')), [],
    'в корне logs файлов больше нет');
});

test('панель читает день из папки его месяца — и старый, и сегодняшний', async () => {
  const old = await request(srv.url, 'GET', `/api/admin/logs?day=${OLD_DAY}`, { token: admin.token });
  assert.equal(old.status, 200);
  assert.ok(old.json.entries.some((e) => e.event === 'login_failed'), JSON.stringify(old.json));

  const today = await request(srv.url, 'GET', '/api/admin/logs', { token: admin.token });
  assert.ok(today.json.entries.some((e) => e.event === 'login'), JSON.stringify(today.json).slice(0, 300));
});
