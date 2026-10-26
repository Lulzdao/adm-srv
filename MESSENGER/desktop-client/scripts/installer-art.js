// Перерисовать картинки установщика в стиле самой «Искры»:  npm run installer-art
//
//   build/installerSidebar.bmp   164×314 — экраны приветствия и завершения (и у деинсталлятора)
//   build/installerHeader.bmp    150×57  — полоса сверху на остальных страницах мастера
//
// До 2026-10-26 там были тёмно-синие картинки со старой синей звездой, а программа после редизайна
// светлая и тёплая, с серебряным значком (build/icon.png) и надписью «ИСКРА» шрифтом Unbounded.
// Рисуем тем же движком, что и окна программы (Electron/Chromium), — с теми же шрифтами из
// renderer/fonts, цветами светлой темы (renderer/theme.css) и значком; поэтому запускать под Electron,
// не под Node. NSIS принимает только BMP без прозрачности — пишем 24-битный.
//
// Файлы лежат в git: сборке они нужны готовыми. Запускать после правки значка, шрифтов или цветов.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

// Ровно 1 пиксель картинки на 1 пиксель CSS — иначе на экране с масштабом 125–150% снимок вышел бы крупнее.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
// Сглаживание шрифта без цветной каймы: субпиксельное (под ЖК-экран) в картинке давало красно-синие края букв.
app.commandLine.appendSwitch('disable-lcd-text');

const root = path.resolve(__dirname, '..');
const url = (p) => pathToFileURL(path.join(root, p)).href;

// Светлая тема и акцент по умолчанию («azure», см. settings в main.js и theme.css).
const C = { bg: '#f4f1ec', panel: '#fbfaf7', panel2: '#ece7e0', text: '#1d1915', muted: '#75695e', accent: '#3772bb' };

const fonts = `
  @font-face { font-family: Unbounded; font-weight: 700; src: url('${url('renderer/fonts/Unbounded-Bold.woff2')}'); }
  @font-face { font-family: Onest; font-weight: 500; src: url('${url('renderer/fonts/Onest-Medium.woff2')}'); }
  html, body { margin: 0; overflow: hidden; -webkit-font-smoothing: antialiased; }
  .brand { font-family: Unbounded; font-weight: 700; color: ${C.text}; text-transform: uppercase; }
  .note { font-family: Onest; font-weight: 500; color: ${C.muted}; }`;

const ART = [
  {
    file: 'build/installerSidebar.bmp', width: 164, height: 314,
    // Значок с мягким отсветом акцента — как искра на тёплом фоне окна; под ним «ИСКРА» и подпись.
    html: `<style>${fonts}
      body { width: 164px; height: 314px; display: flex; flex-direction: column; align-items: center;
        background: radial-gradient(circle at 50% 30%, ${C.accent}22 0, ${C.accent}00 62px),
                    linear-gradient(180deg, ${C.panel} 0%, ${C.bg} 55%, ${C.panel2} 100%); }
      img { width: 92px; height: 92px; margin-top: 50px; }
      .brand { font-size: 19px; letter-spacing: 2.5px; margin-top: 14px; }
      .note { font-size: 11px; line-height: 1.45; text-align: center; margin-top: 8px; }
      .org { position: absolute; bottom: 16px; font-size: 10px; letter-spacing: .3px; opacity: .85; }
    </style>
    <img src="${url('build/icon.png')}"><div class="brand">Искра</div>
    <div class="note">Корпоративный<br>мессенджер</div><div class="note org">Липецкстат</div>`,
  },
  {
    file: 'build/installerHeader.bmp', width: 150, height: 57,
    // Фон белый — как полоса заголовка мастера NSIS, на которую картинка ложится.
    html: `<style>${fonts}
      body { width: 150px; height: 57px; display: flex; align-items: center; justify-content: center; gap: 9px; background: #ffffff; }
      img { width: 34px; height: 34px; }
      .brand { font-size: 14px; letter-spacing: 1.6px; }
    </style>
    <img src="${url('build/icon.png')}"><div class="brand">Искра</div>`,
  },
];

// BMP 24 бита, строки снизу вверх, каждая выровнена на 4 байта. bgra — то, что отдаёт NativeImage.toBitmap().
function bmp24(bgra, width, height) {
  const row = Math.ceil((width * 3) / 4) * 4;
  const out = Buffer.alloc(54 + row * height);
  out.write('BM', 0); out.writeUInt32LE(out.length, 2); out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14); out.writeInt32LE(width, 18); out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26); out.writeUInt16LE(24, 28); out.writeUInt32LE(row * height, 34);
  for (let y = 0; y < height; y++) {
    const dst = 54 + (height - 1 - y) * row;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      out[dst + x * 3] = bgra[s]; out[dst + x * 3 + 1] = bgra[s + 1]; out[dst + x * 3 + 2] = bgra[s + 2];
    }
  }
  return out;
}

async function render({ file, width, height, html }) {
  const win = new BrowserWindow({ width, height, show: false, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  const tmp = path.join(os.tmpdir(), `iskra-installer-art-${process.pid}-${path.basename(file, '.bmp')}.html`);
  fs.writeFileSync(tmp, `<!doctype html><meta charset="utf-8">${html}`);
  await win.loadFile(tmp);
  // Шрифты и значок должны догрузиться, иначе на снимке окажется запасной шрифт.
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode())))');
  await new Promise((r) => setTimeout(r, 300));
  const image = (await win.webContents.capturePage({ x: 0, y: 0, width, height })).resize({ width, height });
  fs.writeFileSync(path.join(root, file), bmp24(image.toBitmap(), width, height));
  // PNG — посмотреть глазами (BMP открывается не везде); во временной папке, чтобы не попал в git.
  const preview = path.join(os.tmpdir(), path.basename(file).replace(/\.bmp$/, '.png'));
  fs.writeFileSync(preview, image.toPNG());
  fs.unlinkSync(tmp);
  win.destroy();
  console.log(`${file}: ${width}×${height} (посмотреть: ${preview})`);
}

// Картинки рисуются по одной: закрыли окно первой — по умолчанию Electron на этом завершается, и
// загрузка следующей обрывалась (ERR_FAILED). Выходим сами, когда нарисованы все.
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try { for (const a of ART) await render(a); } catch (err) { console.error(err); process.exitCode = 1; }
  app.quit();
});
