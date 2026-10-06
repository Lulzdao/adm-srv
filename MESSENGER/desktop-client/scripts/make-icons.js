// Пересобрать файлы значков из одного рисунка искры (tray-icon.js):  npm run icons
//
//   build/icon.ico            значок программы: ярлык, панель задач, Проводник, установщик.
//                             Мелкие размеры и крупные — разные рисунки, см. appIconPng в tray-icon.js
//   build/icon.png            крупный рисунок картинкой 256×256
//   tray-icon.ico             запасной значок трея (сам трей рисуется на лету в цвете акцента)
//   tray-icon-fallback.png    запасной для запасного — если .ico не декодируется
//
// Файлы лежат в git: сборке они нужны готовыми. Запускать после правки рисунка или цветов.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { APP_ICON_SIZES, TRAY_SIZES, ACCENT_COLORS, appIconPng, starPng, icoFromPngs } = require('../tray-icon');

const root = path.resolve(__dirname, '..');
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), icoFromPngs(APP_ICON_SIZES.map((size) => ({ size, png: appIconPng(size) }))));
fs.writeFileSync(path.join(root, 'build', 'icon.png'), appIconPng(256));
fs.writeFileSync(path.join(root, 'tray-icon.ico'), icoFromPngs(TRAY_SIZES.map(([, size]) => ({ size, png: starPng(ACCENT_COLORS.ember, size) }))));
fs.writeFileSync(path.join(root, 'tray-icon-fallback.png'), starPng(ACCENT_COLORS.ember, 32));
console.log('Значки пересобраны: build/icon.ico (' + APP_ICON_SIZES.join(', ') + '), build/icon.png, tray-icon.ico, tray-icon-fallback.png');
