'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ============================================================================
//  Редактор объявлений: один файл в двух местах
//
//  richtext.js (редактор и очистка при показе) лежит и в окне объявлений клиента, и в панели
//  администратора — сборки у них разные, общего каталога нет. Правка одной копии без другой
//  дала бы разное оформление (или разную очистку) в клиенте и в панели. Белый список тегов в
//  нём — тот же, что у сервера (lib/richtext.js).
// ============================================================================

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

test('richtext.js в клиенте и в панели — одна и та же копия', () => {
  assert.equal(read('public/richtext.js'), read('desktop-client/renderer/richtext.js'),
    'скопируйте desktop-client/renderer/richtext.js в public/richtext.js (или наоборот)');
});

test('белый список тегов у клиента и у сервера один', () => {
  const tags = (src) => {
    const m = src.match(/const TAGS = \{([\s\S]*?)\};/);
    assert.ok(m, 'не найден TAGS — тест устарел');
    return [...m[1].matchAll(/(\w+):/g)].map((x) => x[1]).sort();
  };
  assert.deepEqual(tags(read('desktop-client/renderer/richtext.js')), tags(read('lib/richtext.js')));
});

test('текстовая версия: строка редактора после текста — с новой строки, без лишних пустых', () => {
  const { htmlToText } = require('../lib/richtext');
  // Так редактор пишет «жирный заголовок, Enter, текст»: первая строка без блока, дальше — <div>.
  assert.equal(htmlToText('<span style="font-weight: bold">Собрание</span><div>В пятницу</div><div><ul><li>отчёты</li></ul></div>'),
    'Собрание\nВ пятницу\n\n• отчёты');
  assert.equal(htmlToText('<div>Раз</div><div>Два</div>'), 'Раз\nДва');
  assert.equal(htmlToText('<p>Абзац</p><p>Ещё</p>'), 'Абзац\n\nЕщё');
});
