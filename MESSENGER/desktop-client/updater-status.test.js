'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseUpdaterLog } = require('./updater-status');

// Строки — из настоящих журналов машин 15.10 (см. collect-iskra-logs.ps1).
test('скачано, но не поставлено — так выглядели журналы до 1.0.30', () => {
  const s = parseUpdaterLog([
    '2026-10-14T10:06:17.065Z download ok: 1.0.27 -> 1.0.28, iskra-setup-win10-1.0.28.exe',
    '2026-10-15T05:30:51.776Z download ok: 1.0.28 -> 1.0.29, iskra-setup-win10-1.0.29.exe',
  ].join('\r\n'));
  assert.equal(s.state, 'downloaded');
  assert.equal(s.version, '1.0.29');
  assert.equal(s.at, Date.parse('2026-10-15T05:30:51.776Z'));
});

test('поставлено; служебная строка о возврате «Искры» не мешает', () => {
  const s = parseUpdaterLog([
    '2026-10-16T05:30:51.776Z download ok: 1.0.29 -> 1.0.30, iskra-setup-win10-1.0.30.exe',
    '2026-10-16T05:31:40.000Z install 1.0.30: exit code 0',
    '2026-10-16T05:31:41.000Z relaunch: schtasks exit code 1: ошибка',
  ].join('\n'));
  assert.deepEqual([s.state, s.version], ['installed', '1.0.30']);
});

test('ошибки и неудачная установка', () => {
  assert.equal(parseUpdaterLog('2026-10-15T05:32:41.585Z error: self signed certificate in certificate chain').detail, 'self signed certificate in certificate chain');
  const f = parseUpdaterLog('2026-10-16T05:31:40.000Z install 1.0.30: exit code 2');
  assert.deepEqual([f.state, f.detail], ['install-failed', 'код 2']);
  assert.equal(parseUpdaterLog('2026-10-16T05:31:40.000Z updater gave no answer, exit code -1').state, 'error');
  assert.equal(parseUpdaterLog('2026-10-14T05:41:05.243Z check: installed 1.0.27, published 1.0.27 - nothing to do (pc)').state, 'current');
});

test('пустой журнал или только служебные строки — событий нет', () => {
  assert.equal(parseUpdaterLog(''), null);
  assert.equal(parseUpdaterLog('2026-10-15T05:00:00.000Z windows root store: 0 certificates\nмусор'), null);
});
