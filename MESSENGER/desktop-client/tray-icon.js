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
  ember: '#f28e42', garnet: '#ef7d83', gold: '#e1b75c', jade: '#54c398', azure: '#7aaeef', violet: '#b494ed',
};

// Контур искры в поле 24×24 — те же четыре дуги, что в spark-star.svg: [начало, опора 1, опора 2, конец].
const STAR = [
  [[12, 1], [12.7, 7.6], [16.4, 11.3], [23, 12]],
  [[23, 12], [16.4, 12.7], [12.7, 16.4], [12, 23]],
  [[12, 23], [11.3, 16.4], [7.6, 12.7], [1, 12]],
  [[1, 12], [7.6, 11.3], [11.3, 7.6], [12, 1]],
];

function starPolygon(steps = 14) {
  const pts = [];
  for (const [a, b, c, d] of STAR) {
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

/** Искра цвета color (#rrggbb) на прозрачном фоне, size×size пикселей. Возвращает PNG. */
function starPng(color, size) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(color));
  const [r, g, b] = m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [242, 142, 66];
  // Контур занимает в поле 24×24 квадрат 1…23; растягиваем его на весь значок без полей — в трее
  // 16 пикселей, и каждый на счету.
  const poly = starPolygon().map(([x, y]) => [((x - 1) / 22) * size, ((y - 1) / 22) * size]);
  const SS = 4; // сглаживание: 4×4 пробы на пиксель
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // фильтр строки: «без фильтра»
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

const accentColor = (accent) => ACCENT_COLORS[accent] || ACCENT_COLORS.ember;

// Размеры под масштабы экрана Windows: 100, 125, 150, 200 и 250 %.
const TRAY_SIZES = [[1, 16], [1.25, 20], [1.5, 24], [2, 32], [2.5, 40]];

module.exports = { ACCENT_COLORS, TRAY_SIZES, accentColor, starPng };
