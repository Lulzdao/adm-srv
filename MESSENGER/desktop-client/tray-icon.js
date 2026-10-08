// Значок в трее: та же искра, что в шапке списка (renderer/spark-star.svg), без фона и в цвете
// выбранного акцента. Рисуется на лету — шести готовых файлов на шесть акцентов не держим, а
// новый акцент не потребует рисовать ещё один.
//
// Electron здесь ни при чём (модуль чистый, чтобы его можно было проверить тестом): на выходе —
// обычный PNG в Buffer, а nativeImage из него собирает main.js.
'use strict';
const zlib = require('node:zlib');

// Цвета акцентов — как в тёмной теме (theme.css): панель задач Windows тёмная и при светлой теме
// приложения, а светлые варианты акцентов на ней тускнеют.
const ACCENT_COLORS = {
  ember: '#f28e42', garnet: '#ef7d83', pink: '#f37fae', gold: '#e1b75c', jade: '#54c398', azure: '#7aaeef', violet: '#b494ed',
};

// Контур искры в поле 24×24 — те же четыре дуги, что в spark-star.svg: [начало, опора 1, опора 2, конец].
const STAR = [
  [[12, 1], [12.7, 7.6], [16.4, 11.3], [23, 12]],
  [[23, 12], [16.4, 12.7], [12.7, 16.4], [12, 23]],
  [[12, 23], [11.3, 16.4], [7.6, 12.7], [1, 12]],
  [[1, 12], [7.6, 11.3], [11.3, 7.6], [12, 1]],
];

// «Падающая» искра для значка программы: верхний луч вытянут на всю высоту, сама звезда сидит ниже
// и уже — будто летит вниз и тянет за собой след. Вершины: верх (12,1), бока на высоте 15.5, низ (12,23).
// Опорные точки дуг лежат на отрезке «вершина → центр»: чем ближе к центру, тем тоньше луч.
// wide — вариант для панели задач: бока разведены на всю ширину значка и звезда чуть выше. На ярлыке
// (крупно) хороша узкая, а в кнопке панели задач она терялась — там значок 24–32 пикселя.
function fallingStar(wide) {
  const cy = wide ? 14 : 15.5; const half = wide ? 11 : 7.5;
  const c = [12, cy];
  const tips = [[12, 1], [12 + half, cy], [12, 23], [12 - half, cy]];
  const pull = wide ? [0.66, 0.4, 0.4, 0.4] : [0.9, 0.62, 0.62, 0.62]; // верхний луч — самый тонкий и длинный
  const ctrl = (i) => [tips[i][0] + (c[0] - tips[i][0]) * pull[i], tips[i][1] + (c[1] - tips[i][1]) * pull[i]];
  return tips.map((tip, i) => { const j = (i + 1) % 4; return [tip, ctrl(i), ctrl(j), tips[j]]; });
}

function starPolygon(shape, steps = 14) {
  const pts = [];
  for (const [a, b, c, d] of (shape === 'falling' ? fallingStar(false) : shape === 'falling-wide' ? fallingStar(true) : STAR)) {
    for (let i = 0; i < steps; i++) {
      const t = i / steps, u = 1 - t;
      pts.push([
        u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
        u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
      ]);
    }
  }
  return pts;
}

function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const rgb = (color) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(color));
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [242, 142, 66];
};

/**
 * Искра цвета color (#rrggbb) на прозрачном фоне, size×size пикселей. Возвращает PNG.
 * colorBottom — второй цвет: искра заливается сверху вниз от color к нему (значок программы).
 * pad — поле вокруг искры, доля стороны (0 — во весь значок).
 * shape: 'falling' — искра с вытянутым вверх лучом (значок программы), 'falling-wide' — она же во всю
 * ширину (панель задач); иначе — ровная, как в шапке списка.
 */
function starPng(color, size, { colorBottom, pad = 0, shape } = {}) {
  const top = rgb(color); const bottom = colorBottom ? rgb(colorBottom) : top;
  // Контур занимает в поле 24×24 квадрат 1…23; по умолчанию растягиваем его на весь значок без
  // полей — в трее 16 пикселей, и каждый на счету.
  const inner = size * (1 - 2 * pad); const off = size * pad;
  const poly = starPolygon(shape).map(([x, y]) => [off + ((x - 1) / 22) * inner, off + ((y - 1) / 22) * inner]);
  const SS = 4; // сглаживание: 4×4 пробы на пиксель
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // фильтр строки: «без фильтра»
    const k = size > 1 ? y / (size - 1) : 0;
    const [r, g, b] = top.map((c, i) => Math.round(c + (bottom[i] - c) * k));
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) if (inside(poly, x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hits++;
      const o = row + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 бит на канал, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const accentColor = (accent) => ACCENT_COLORS[accent] || ACCENT_COLORS.azure;

// Размеры под масштабы экрана Windows: 100, 125, 150, 200 и 250 %.
const TRAY_SIZES = [[1, 16], [1.25, 20], [1.5, 24], [2, 32], [2.5, 40]];

// Значок программы (ярлык, панель задач, Проводник) — лазурная «падающая» искра без фона: светлая
// лазурь на кончике следа, основная — внизу. Лазурь видна и на тёмной панели задач, и на белом
// фоне Проводника — белая искра на светлом пропадала. Файл build/icon.ico собирает
// scripts/make-icons.js (`npm run icons`); размеры — все, что Windows спрашивает у ярлыка.
const APP_ICON = { top: '#a1bdf9', bottom: '#7aaeef', pad: 0.04, shape: 'falling' };
const APP_ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
// Панель задач Windows показывает значок ПРОГРАММЫ (тот же build/icon.ico), а не значок окна — проверено:
// окно отдавало ей крупный значок, а в кнопке всё равно стоял рисунок из файла. Поэтому рисунок зависит от
// размера: мелкие (их берут панель задач и списки Проводника) — искра во всю ширину без полей, иначе она
// теряется; крупные (ярлык на рабочем столе) — узкая с полями, там она выглядит лучше.
const APP_ICON_SMALL = { top: APP_ICON.top, bottom: APP_ICON.bottom, pad: 0, shape: 'falling-wide' };
const APP_ICON_SMALL_UP_TO = 40;
/** PNG значка программы нужного размера — с тем рисунком, который этому размеру положен. */
function appIconPng(size) {
  const v = size <= APP_ICON_SMALL_UP_TO ? APP_ICON_SMALL : APP_ICON;
  return starPng(v.top, size, { colorBottom: v.bottom, pad: v.pad, shape: v.shape });
}

/** Файл .ico из готовых PNG: [{ size, png }]. Формат — заголовок, таблица, сами PNG подряд. */
function icoFromPngs(entries) {
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  const table = Buffer.alloc(16 * entries.length);
  let offset = 6 + table.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    table[o] = size >= 256 ? 0 : size; table[o + 1] = size >= 256 ? 0 : size; // 0 означает 256
    table.writeUInt16LE(1, o + 4); table.writeUInt16LE(32, o + 6);             // одна плоскость, 32 бита на точку
    table.writeUInt32LE(png.length, o + 8); table.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([head, table, ...entries.map((e) => e.png)]);
}

module.exports = { ACCENT_COLORS, TRAY_SIZES, APP_ICON, APP_ICON_SMALL, APP_ICON_SMALL_UP_TO, APP_ICON_SIZES, accentColor, appIconPng, starPng, icoFromPngs };
