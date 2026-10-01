'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// zip.js — один файл на две службы: он же лежит в helpdesk-backend/services/zip.js (платформа).
// Общей папки у служб нет, поэтому это копия; тест не даёт копиям разойтись. Править —
// в платформе, сюда копировать. Тот же тест лежит у платформы.
test('zip.js журнала звонков и платформы совпадают байт в байт', (t) => {
  const mine = path.join(__dirname, '..', 'zip.js');
  const other = path.join(__dirname, '..', '..', '..', 'helpdesk-backend', 'services', 'zip.js');
  if (!fs.existsSync(other)) return t.skip('платформа стоит отдельно — сверить не с чем');
  const norm = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  assert.strictEqual(norm(mine), norm(other),
    'файлы разошлись: правку нужно внести в helpdesk-backend/services/zip.js и скопировать сюда');
});
