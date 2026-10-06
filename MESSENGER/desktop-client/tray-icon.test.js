'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const { starPng, appIconPng, accentColor, icoFromPngs, ACCENT_COLORS, TRAY_SIZES, APP_ICON, APP_ICON_SMALL_UP_TO, APP_ICON_SIZES } = require('./tray-icon');

// Разбор PNG обратно в пиксели — чтобы проверять сам рисунок, а не только то, что «что-то вернулось».
function decode(png) {
  assert.deepStrictEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'подпись PNG');
  let pos = 8; let ihdr = null; const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos); const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = data; if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4);
  assert.strictEqual(ihdr[8], 8); assert.strictEqual(ihdr[9], 6, 'RGBA');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.strictEqual(raw.length, h * (w * 4 + 1));
  const px = (x, y) => { const o = y * (w * 4 + 1) + 1 + x * 4; return [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]]; };
  return { w, h, px };
}

test('значок трея: искра нужного цвета на прозрачном фоне', () => {
  const { w, h, px } = decode(starPng('#54c398', 32));
  assert.strictEqual(w, 32); assert.strictEqual(h, 32);
  assert.deepStrictEqual(px(16, 16), [0x54, 0xc3, 0x98, 255], 'середина — сплошной цвет акцента');
  for (const [x, y] of [[0, 0], [31, 0], [0, 31], [31, 31], [6, 6], [25, 6], [6, 25], [25, 25]]) {
    assert.strictEqual(px(x, y)[3], 0, `(${x},${y}) — прозрачно: фона у значка нет`);
  }
  for (const [x, y] of [[16, 1], [16, 30], [1, 16], [30, 16]]) assert.ok(px(x, y)[3] > 0, `луч доходит до края (${x},${y})`);
});

test('значок трея: рисунок симметричен и есть для каждого размера и акцента', () => {
  for (const [, size] of TRAY_SIZES) {
    const { w, px } = decode(starPng(ACCENT_COLORS.ember, size));
    assert.strictEqual(w, size);
    for (let i = 0; i < size; i++) {
      assert.strictEqual(px(i, 3)[3], px(size - 1 - i, 3)[3], `размер ${size}: зеркально по горизонтали`);
      assert.strictEqual(px(3, i)[3], px(3, size - 1 - i)[3], `размер ${size}: зеркально по вертикали`);
    }
  }
  for (const name of ['ember', 'garnet', 'gold', 'jade', 'azure', 'violet']) assert.match(accentColor(name), /^#[0-9a-f]{6}$/);
  assert.strictEqual(accentColor('нет-такого'), ACCENT_COLORS.ember, 'неизвестный акцент — янтарь');
  assert.strictEqual(accentColor(undefined), ACCENT_COLORS.ember);
});

test('значок программы: заливка сверху вниз, поля, файл .ico совпадает с рисунком', () => {
  const { px } = decode(starPng(APP_ICON.top, 64, { colorBottom: APP_ICON.bottom, pad: APP_ICON.pad, shape: APP_ICON.shape }));
  assert.deepStrictEqual(px(32, 4).slice(0, 3).map((c, i) => Math.abs(c - [0xa1, 0xbd, 0xf9][i]) < 6), [true, true, true], 'верх — светлая лазурь');
  assert.deepStrictEqual(px(32, 59).slice(0, 3).map((c, i) => Math.abs(c - [0x7a, 0xae, 0xef][i]) < 6), [true, true, true], 'низ — основная лазурь');
  // «Падающая» форма: бока звезды ниже середины значка, верхний луч тонкий и длинный.
  assert.ok(px(32, 12)[3] > 0 && px(36, 12)[3] === 0, 'вверху — только тонкий луч по оси');
  assert.ok(px(20, 41)[3] > 0 && px(43, 41)[3] > 0, 'бока звезды — в нижней половине');
  assert.strictEqual(px(14, 22)[3], 0, 'на высоте середины луча по бокам пусто');
  assert.strictEqual(px(32, 0)[3], 0, 'сверху поле: искра не упирается в край');
  assert.strictEqual(px(0, 0)[3], 0, 'фона нет');

  const entries = APP_ICON_SIZES.map((size) => ({ size, png: appIconPng(size) }));
  const ico = icoFromPngs(entries);
  assert.strictEqual(ico.readUInt16LE(2), 1, 'тип: значок'); assert.strictEqual(ico.readUInt16LE(4), entries.length);
  entries.forEach(({ size, png }, i) => {
    const o = 6 + i * 16;
    assert.strictEqual(ico[o] || 256, size);
    assert.ok(png.equals(ico.subarray(ico.readUInt32LE(o + 12), ico.readUInt32LE(o + 12) + ico.readUInt32LE(o + 8))), `размер ${size}: PNG лежит по своему смещению`);
  });
  // Файл в git — тот, что получается из рисунка: правка рисунка без `npm run icons` не останется незамеченной.
  assert.ok(ico.equals(fs.readFileSync(path.join(__dirname, 'build', 'icon.ico'))), 'build/icon.ico устарел — выполните: npm run icons');
});

test('значок программы: мелкие размеры — искра во всю ширину (панель задач), крупные — узкая с полями (ярлык)', () => {
  const painted = (size) => {
    const { px } = decode(appIconPng(size)); let minX = size, maxX = -1;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (px(x, y)[3] > 8) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    return (maxX - minX + 1) / size;
  };
  // Панель задач берёт 24 или 32 пикселя: там искра обязана занимать почти всю ширину, иначе выглядит мелкой.
  for (const size of [16, 24, 32]) assert.ok(size <= APP_ICON_SMALL_UP_TO && painted(size) > 0.8, `размер ${size}: закрашено ${Math.round(painted(size) * 100)}% ширины`);
  // Рабочий стол берёт 48 и больше: там узкая искра с вытянутым лучом.
  for (const size of [48, 256]) assert.ok(size > APP_ICON_SMALL_UP_TO && painted(size) < 0.7, `размер ${size}: закрашено ${Math.round(painted(size) * 100)}% ширины`);
});
