'use strict';

const zlib = require("node:zlib");

// ============================================================================
//  Сборка ZIP-архивов для тестов
//
//  mchd.js читает ZIP своими руками, по смещениям из центрального каталога.
//  Чтобы проверить это честно, архивы надо собирать тоже руками: готовый
//  архиватор дал бы один вариант раскладки, а нам нужны и хранение без сжатия,
//  и deflate, и намеренно битые заголовки.
// ============================================================================

const LOC_SIG = 0x04034b50;
const CEN_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/**
 * Собрать архив из [{ name, data, store }].
 * store=true — без сжатия (метод 0), иначе deflate (метод 8).
 */
function makeZip(entries, { comment = "", corruptEocd = false, encrypted = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const method = e.store ? 0 : 8;
    const payload = method === 0 ? raw : zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const flags = encrypted ? 0x1 : 0;

    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(LOC_SIG, 0);
    loc.writeUInt16LE(20, 4);          // версия
    loc.writeUInt16LE(flags, 6);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(payload.length, 18);
    loc.writeUInt32LE(raw.length, 22);
    loc.writeUInt16LE(nameBuf.length, 26);
    loc.writeUInt16LE(0, 28);          // extra
    locals.push(loc, nameBuf, payload);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CEN_SIG, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);          // extra
    cen.writeUInt16LE(0, 32);          // comment
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, nameBuf);

    offset += loc.length + nameBuf.length + payload.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const commentBuf = Buffer.from(comment, "utf8");

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(corruptEocd ? 0x11111111 : EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);

  return Buffer.concat([localPart, centralPart, eocd, commentBuf]);
}

// Своя таблица CRC32: mchd.js её не проверяет, но заголовок должен быть
// правдоподобным — иначе тест доказывал бы работу на заведомо кривом файле.
let TABLE = null;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

module.exports = { makeZip, crc32 };
