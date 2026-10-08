// Пересобрать запасные значки трея из рисунка искры (tray-icon.js):  npm run icons
//
// Значок программы (build/icon.ico — ярлык, панель задач, Проводник, установщик; build/icon.png —
// он же картинкой 256×256) с 2026-10-08 — готовый рисунок от пользователя (две звезды, 16–256 точек),
// этот скрипт его НЕ трогает. Заменить — положить новый .ico в build/icon.ico и его 256×256 в icon.png.
//
//   tray-icon.ico             запасной значок трея (сам трей рисуется на лету в цвете акцента)
//   tray-icon-fallback.png    запасной для запасного — если .ico не декодируется
//
// Файлы лежат в git: сборке они нужны готовыми. Запускать после правки рисунка или цветов.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { TRAY_SIZES, ACCENT_COLORS, starPng, icoFromPngs } = require('../tray-icon');

const root = path.resolve(__dirname, '..');
fs.writeFileSync(path.join(root, 'tray-icon.ico'), icoFromPngs(TRAY_SIZES.map(([, size]) => ({ size, png: starPng(ACCENT_COLORS.ember, size) }))));
fs.writeFileSync(path.join(root, 'tray-icon-fallback.png'), starPng(ACCENT_COLORS.ember, 32));
console.log('Значки трея пересобраны: tray-icon.ico, tray-icon-fallback.png (значок программы build/icon.ico не трогается)');
