const zlib = require("node:zlib");

// ============================================================================
//  Zip: чтение и сборка
//
//  Документы Word и книги Excel — это zip с XML внутри. Ассистенту надо и
//  читать их (шаблоны актов, списки респондентов), и собирать (готовые акты,
//  ведомости, архив актов одним файлом). Пакет с npm на закрытый контур не
//  поставить, а deflate и crc32 в Node уже есть — остаётся разметка самого
//  zip, это пара сотен строк.
//
//  Поддерживается ровно то, что встречается в офисных файлах: записи без
//  сжатия и с deflate, имена в UTF-8. Zip64 и шифрования в них не бывает.
//
//  ОДИН ФАЙЛ НА ДВЕ СЛУЖБЫ. Этот же файл байт в байт лежит в SMDR/web-node/zip.js
//  (выгрузка журнала звонков в .xlsx). Общей папки у служб нет — на сервере они
//  могут стоять в разных каталогах, — поэтому это копия, а не ссылка. Правите
//  здесь — скопируйте туда: совпадение проверяют тесты обеих служб
//  (zipShared.test.js), разошедшиеся файлы их роняют. Раньше разметка zip была
//  написана дважды, и ошибку пришлось бы чинить в двух местах по-разному.
// ============================================================================

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

// Предел распакованного размера одной записи. Список респондентов или шаблон
// акта весят килобайты; zip-бомба из пары килобайт разворачивается в гигабайты
// и положила бы процесс вместе со всей платформой.
const MAX_ENTRY = 64 * 1024 * 1024;

/**
 * Прочитать zip целиком. Возвращает Map «имя -> содержимое» в порядке
 * центрального каталога — порядок важен при пересборке .docx: Word открывает
 * файл и так, но [Content_Types].xml первым — то, как его пишет сам Office.
 */
function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error("Файл не похож на zip — он пустой или обрезан");
  // Конец каталога ищем с хвоста: после него может стоять комментарий до 64 КБ.
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_END) { end = i; break; }
  }
  if (end < 0) throw new Error("Файл не похож на zip — это не документ Office");

  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error("Каталог zip повреждён");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue; // папка
    if (usize > MAX_ENTRY) throw new Error(`Запись «${name}» слишком велика`);
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error("Zip повреждён");
    // Длины имени и extra в локальном заголовке могут отличаться от каталожных.
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY });
    else throw new Error(`Запись «${name}» сжата неизвестным способом (${method})`);
    out.set(name, data);
  }
  return out;
}

/** CRC32, в том числе по кускам: crc32(кусок, crc32(предыдущий)). Начинать с нуля. */
function crc32(buf, seed = 0) {
  return zlib.crc32(buf, seed) >>> 0;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Сборщик zip в памяти. Файлы у Ассистента мелкие — потоковая запись ни к чему. */
class ZipBuilder {
  constructor(now = new Date()) {
    this.parts = [];
    this.central = [];
    this.offset = 0;
    this.stamp = dosTime(now);
  }

  /**
   * Запись из готового содержимого (строка или Buffer) — для всего, что помещается в память.
   */
  add(name, content) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    return this.addCompressed(name, [zlib.deflateRawSync(data)], crc32(data), data.length);
  }

  /**
   * Запись из уже сжатых (deflate raw) кусков: crc и usize — контрольная сумма и размер
   * НЕсжатых данных. Нужна потоковой выгрузке: лист на сотни тысяч строк сжимается на лету,
   * и несжатого XML целиком в памяти не оказывается.
   */
  addCompressed(name, chunks, crc, usize) {
    const packed = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    const nameBuf = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // бит 11: имя в UTF-8 — иначе «акт.docx» в архиве станет кракозябрами
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(this.stamp.time, 10);
    local.writeUInt16LE(this.stamp.date, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(this.stamp.time, 12);
    central.writeUInt16LE(this.stamp.date, 14);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(usize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(this.offset, 42);

    this.parts.push(local, nameBuf, packed);
    this.central.push(central, nameBuf);
    this.offset += 30 + nameBuf.length + packed.length;
    return this;
  }

  finish() {
    const dir = Buffer.concat(this.central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_END, 0);
    const count = this.central.length / 2;
    end.writeUInt16LE(count, 8);
    end.writeUInt16LE(count, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(this.offset, 16);
    return Buffer.concat([...this.parts, dir, end]);
  }
}

/** Собрать zip из Map или массива пар [имя, содержимое]. */
function writeZip(entries, now) {
  const z = new ZipBuilder(now);
  for (const [name, data] of entries) z.add(name, data);
  return z.finish();
}

module.exports = { readZip, writeZip, ZipBuilder, crc32 };
