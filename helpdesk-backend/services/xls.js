// ============================================================================
//  Книги Excel 97–2003 (.xls): прочитать первый лист
//
//  ЦСОД и старые версии Excel до сих пор отдают таблицы в .xls, а пакет с npm
//  на закрытый контур не поставить. Формат — составной файл OLE (CFB), внутри
//  поток Workbook из записей BIFF8. Нужно немногое: тексты и числа ячеек
//  первого листа — ровно то, что readFirstSheet в xlsx.js отдаёт для .xlsx, и в
//  том же виде (массив строк, в строке — тексты ячеек), чтобы дальше разницы
//  между форматами не было.
//
//  Не поддерживаются: защищённые паролем книги и книги Excel 5.0/95 (BIFF5) —
//  на них понятный отказ с советом пересохранить.
// ============================================================================

const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECT = 0xffffffff;

const isXls = (buf) => Buffer.isBuffer(buf) && buf.length >= 512 && buf.subarray(0, 8).equals(CFB_SIGNATURE);

class XlsError extends Error {}
const broken = () => new XlsError("Файл .xls повреждён или обрезан — откройте его в Excel и сохраните заново");

// ---------------------------------------------------------------------------
//  Составной файл OLE: найти поток Workbook
// ---------------------------------------------------------------------------

function readCfbStream(buf, names) {
  const sectorSize = 1 << buf.readUInt16LE(0x1e);
  const miniSectorSize = 1 << buf.readUInt16LE(0x20);
  if (sectorSize !== 512 && sectorSize !== 4096) throw broken();
  const sectorCount = Math.floor((buf.length - sectorSize) / sectorSize);
  const sector = (n) => {
    if (n >= sectorCount) throw broken();
    const start = (n + 1) * sectorSize;
    return buf.subarray(start, start + sectorSize);
  };

  // Номера секторов FAT: первые 109 — в заголовке, остальные — цепочкой DIFAT.
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = buf.readUInt32LE(0x4c + i * 4);
    if (s !== FREE_SECT && s !== END_OF_CHAIN) fatSectors.push(s);
  }
  let difat = buf.readUInt32LE(0x44);
  for (let guard = 0; difat !== END_OF_CHAIN && difat !== FREE_SECT; guard++) {
    if (guard > sectorCount) throw broken();
    const sec = sector(difat);
    for (let i = 0; i < sectorSize / 4 - 1; i++) {
      const s = sec.readUInt32LE(i * 4);
      if (s !== FREE_SECT && s !== END_OF_CHAIN) fatSectors.push(s);
    }
    difat = sec.readUInt32LE(sectorSize - 4);
  }
  const fat = [];
  for (const s of fatSectors) {
    const sec = sector(s);
    for (let i = 0; i < sectorSize; i += 4) fat.push(sec.readUInt32LE(i));
  }

  // Цепочка секторов; петля в битом файле не должна повесить процесс.
  const chain = (start, table) => {
    const out = [];
    for (let s = start; s !== END_OF_CHAIN; s = table[s]) {
      if (s === undefined || s === FREE_SECT || out.length > table.length) throw broken();
      out.push(s);
    }
    return out;
  };
  const readChain = (start) => Buffer.concat(chain(start, fat).map(sector));

  const dir = readChain(buf.readUInt32LE(0x30));
  const entries = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = dir.readUInt16LE(off + 64);
    entries.push({
      name: dir.toString("utf16le", off, off + Math.max(0, Math.min(64, nameLen) - 2)),
      type: dir[off + 66],
      start: dir.readUInt32LE(off + 116),
      size: dir.readUInt32LE(off + 120),
    });
  }
  const root = entries.find((e) => e.type === 5);
  const entry = entries.find((e) => e.type === 2 && names.includes(e.name));
  if (!root || !entry) return null;

  // Маленькие потоки (до 4 КБ) живут в мини-потоке корня, со своей таблицей.
  if (entry.size < buf.readUInt32LE(0x38)) {
    const miniFat = [];
    const miniFatStart = buf.readUInt32LE(0x3c);
    if (miniFatStart !== END_OF_CHAIN) {
      const data = readChain(miniFatStart);
      for (let i = 0; i + 4 <= data.length; i += 4) miniFat.push(data.readUInt32LE(i));
    }
    const container = readChain(root.start);
    const parts = chain(entry.start, miniFat).map((s) => container.subarray(s * miniSectorSize, (s + 1) * miniSectorSize));
    return Buffer.concat(parts).subarray(0, entry.size);
  }
  return readChain(entry.start).subarray(0, entry.size);
}

// ---------------------------------------------------------------------------
//  Записи BIFF8
// ---------------------------------------------------------------------------

const R = {
  BOF: 0x0809, EOF: 0x000a, FILEPASS: 0x002f, BOUNDSHEET: 0x0085, SST: 0x00fc, CONTINUE: 0x003c,
  LABELSST: 0x00fd, LABEL: 0x0204, RSTRING: 0x00d6, NUMBER: 0x0203, RK: 0x027e, MULRK: 0x00bd,
  FORMULA: 0x0006, STRING: 0x0207, BOOLERR: 0x0205,
};

function* records(wb, from = 0) {
  for (let pos = from; pos + 4 <= wb.length;) {
    const type = wb.readUInt16LE(pos);
    const len = wb.readUInt16LE(pos + 2);
    if (pos + 4 + len > wb.length) throw broken();
    yield { type, data: wb.subarray(pos + 4, pos + 4 + len), pos };
    pos += 4 + len;
  }
}

/**
 * Текст в формате BIFF8 (XLUnicodeString) с продолжением в следующих записях.
 * segments — данные записи и её CONTINUE: строка может разорваться на границе,
 * и тогда продолжение начинается с нового байта флагов (сжатые или 16-битные знаки).
 */
class SegmentReader {
  constructor(segments) { this.segs = segments; this.i = 0; this.pos = 0; }
  ensure() {
    while (this.i < this.segs.length && this.pos >= this.segs[this.i].length) { this.i++; this.pos = 0; }
    if (this.i >= this.segs.length) throw broken();
  }
  u8() { this.ensure(); return this.segs[this.i][this.pos++]; }
  u16() { return this.u8() | (this.u8() << 8); }
  u32() { return (this.u16() | (this.u16() << 16)) >>> 0; }
  skip(n) { for (let k = 0; k < n; k++) this.u8(); }
  get atEnd() { return this.i >= this.segs.length || (this.i === this.segs.length - 1 && this.pos >= this.segs[this.i].length); }
  string(lenBytes = 2) {
    const cch = lenBytes === 1 ? this.u8() : this.u16();
    let flags = this.u8();
    const runs = flags & 0x08 ? this.u16() : 0;
    const ext = flags & 0x04 ? this.u32() : 0;
    let out = "";
    for (let left = cch; left > 0;) {
      if (this.pos >= this.segs[this.i].length) {
        // Знаки продолжаются в следующей записи — с собственным байтом флагов.
        this.i++; this.pos = 0;
        if (this.i >= this.segs.length) throw broken();
        flags = this.segs[this.i][this.pos++];
      }
      const seg = this.segs[this.i];
      const wide = flags & 0x01;
      const fit = Math.min(left, Math.floor((seg.length - this.pos) / (wide ? 2 : 1)));
      if (fit <= 0) throw broken();
      out += seg.toString(wide ? "utf16le" : "latin1", this.pos, this.pos + fit * (wide ? 2 : 1));
      this.pos += fit * (wide ? 2 : 1);
      left -= fit;
    }
    this.skip(runs * 4 + ext);
    return out;
  }
}

function rkValue(rk) {
  let v;
  if (rk & 0x02) v = rk >> 2;
  else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    v = b.readDoubleLE(0);
  }
  return rk & 0x01 ? v / 100 : v;
}

// Число — как его покажет xlsx.js: целое без «.0» (String так и делает).
const numText = (n) => String(n);

/**
 * Первый лист книги .xls как массив строк, каждая строка — массив текстов.
 * Пустые ячейки внутри строки — пустые строки, чтобы колонки не съезжали.
 */
function readXlsFirstSheet(buf) {
  if (!isXls(buf)) throw new XlsError("Файл не похож на книгу Excel 97–2003 (.xls)");
  let wb;
  try {
    wb = readCfbStream(buf, ["Workbook", "Book"]);
  } catch (err) {
    if (err instanceof XlsError) throw err;
    throw broken();
  }
  if (!wb) throw new XlsError("В файле нет книги Excel — это документ другой программы?");

  const sheets = [];
  const sst = [];
  try {
    const first = records(wb).next().value;
    if (!first || first.type !== R.BOF) throw broken();
    if (first.data.readUInt16LE(0) !== 0x0600) {
      throw new XlsError("Книга в формате Excel 5.0/95 не поддерживается — откройте её в Excel и сохраните как .xlsx");
    }
    let sstSegments = null;
    for (const rec of records(wb)) {
      if (sstSegments && rec.type === R.CONTINUE) { sstSegments.push(rec.data); continue; }
      if (sstSegments) { parseSst(sstSegments, sst); sstSegments = null; }
      if (rec.type === R.FILEPASS) throw new XlsError("Книга защищена паролем — снимите защиту в Excel и загрузите снова");
      else if (rec.type === R.BOUNDSHEET) sheets.push({ offset: rec.data.readUInt32LE(0), kind: rec.data[5] });
      else if (rec.type === R.SST) sstSegments = [rec.data];
      else if (rec.type === R.EOF) break;
    }
    if (sstSegments) parseSst(sstSegments, sst);
  } catch (err) {
    if (err instanceof XlsError) throw err;
    throw broken();
  }

  const sheet = sheets.find((s) => s.kind === 0);
  if (!sheet) throw new XlsError("В книге нет ни одного листа");

  const rows = [];
  const put = (row, col, value) => {
    while (rows.length <= row) rows.push([]);
    const cells = rows[row];
    while (cells.length < col) cells.push("");
    cells[col] = value;
  };
  try {
    let pendingFormula = null;
    for (const { type, data } of records(wb, sheet.offset)) {
      if (type === R.EOF) break;
      if (pendingFormula && type === R.STRING) {
        put(pendingFormula.row, pendingFormula.col, new SegmentReader([data]).string());
        pendingFormula = null;
        continue;
      }
      pendingFormula = null;
      if (type === R.LABELSST) put(data.readUInt16LE(0), data.readUInt16LE(2), sst[data.readUInt32LE(6)] ?? "");
      else if (type === R.LABEL || type === R.RSTRING) put(data.readUInt16LE(0), data.readUInt16LE(2), new SegmentReader([data.subarray(6)]).string());
      else if (type === R.NUMBER) put(data.readUInt16LE(0), data.readUInt16LE(2), numText(data.readDoubleLE(6)));
      else if (type === R.RK) put(data.readUInt16LE(0), data.readUInt16LE(2), numText(rkValue(data.readUInt32LE(6))));
      else if (type === R.MULRK) {
        const row = data.readUInt16LE(0);
        const firstCol = data.readUInt16LE(2);
        const count = (data.length - 6) / 6;
        for (let k = 0; k < count; k++) put(row, firstCol + k, numText(rkValue(data.readUInt32LE(4 + k * 6 + 2))));
      } else if (type === R.BOOLERR) {
        if (!data[7]) put(data.readUInt16LE(0), data.readUInt16LE(2), data[6] ? "ИСТИНА" : "ЛОЖЬ");
      } else if (type === R.FORMULA) {
        // Значение формулы — последний расчёт, сохранённый в файле.
        const row = data.readUInt16LE(0), col = data.readUInt16LE(2);
        if (data.readUInt16LE(12) !== 0xffff) put(row, col, numText(data.readDoubleLE(6)));
        else if (data[6] === 0) pendingFormula = { row, col }; // текст — в следующей записи STRING
        else if (data[6] === 1) put(row, col, data[8] ? "ИСТИНА" : "ЛОЖЬ");
      }
    }
  } catch (err) {
    if (err instanceof XlsError) throw err;
    throw broken();
  }
  return rows;
}

function parseSst(segments, out) {
  const r = new SegmentReader(segments);
  r.skip(4); // всего строк в книге
  const unique = r.u32();
  for (let k = 0; k < unique && !r.atEnd; k++) out.push(r.string());
}

module.exports = { readXlsFirstSheet, isXls, XlsError };
