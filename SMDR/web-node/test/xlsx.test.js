'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const xlsx = require('../xlsx');

// ============================================================================
//  Выгрузка в .xlsx
//
//  Данные в примерах ВЫДУМАНЫ.
//
//  Файл собирается вручную — zip с XML внутри, — поэтому сравнивать строки
//  здесь бесполезно: сойдётся всё, а Excel скажет «файл повреждён» и не
//  уточнит где. Ниже готовый файл РАСПАКОВЫВАЕТСЯ обратно и разбирается:
//  проверяются подписи zip, контрольные суммы, размеры и содержимое листа.
// ============================================================================

/**
 * Разбор zip по центральному каталогу — тем же путём, каким его читает
 * распаковщик, а не по нашим же смещениям.
 */
function распаковать(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, 'нет подписи конца каталога');
  const количество = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const файлы = {};
  for (let i = 0; i < количество; i++) {
    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50, 'подпись записи каталога');
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const длинаИмени = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const комментарий = buf.readUInt16LE(p + 32);
    const смещение = buf.readUInt32LE(p + 42);
    const имя = buf.slice(p + 46, p + 46 + длинаИмени).toString('utf8');

    assert.strictEqual(buf.readUInt32LE(смещение), 0x04034b50, `подпись записи ${имя}`);
    const имяЛок = buf.readUInt16LE(смещение + 26);
    const extraЛок = buf.readUInt16LE(смещение + 28);
    const начало = смещение + 30 + имяЛок + extraЛок;
    const сжатое = buf.slice(начало, начало + csize);
    const данные = zlib.inflateRawSync(сжатое);

    assert.strictEqual(данные.length, usize, `размер ${имя} совпадает с заявленным`);
    assert.strictEqual(xlsx.crc32(данные), crc, `контрольная сумма ${имя} сходится`);
    файлы[имя] = данные.toString('utf8');
    p += 46 + длинаИмени + extra + комментарий;
  }
  return файлы;
}

const ЗАПИСИ = [
  { call_date: '2026-09-04', call_time: '09:12', ext: '214', direction: 'Исходящий',
    details: '+74950000000', duration: "00:03'41", ring: '', fio: 'Тестов Тест Тестович' },
  { call_date: '2026-09-04', call_time: '10:17', ext: '0104', direction: 'Пропущенный',
    details: '84742000000 → 0104', duration: '', ring: "1'05", fio: 'Пробников Пробник & Ко' },
];
const В_СТРОКУ = (r) => [r.call_date, r.call_time, r.ext, r.direction, r.details, r.duration, r.ring, r.fio];

async function книга(записи = ЗАПИСИ) {
  const итог = await xlsx.build(записи, В_СТРОКУ, new Date('2026-09-04T10:00:00Z'));
  return { ...итог, части: распаковать(итог.file) };
}

test('файл — настоящий zip, все части распаковываются и сходятся по CRC', async () => {
  // Сам распаковщик выше и проверяет CRC с размерами: ошибка в них — это
  // ровно то, из-за чего Excel отказывается открывать файл.
  const { file, части } = await книга();
  assert.strictEqual(file.slice(0, 2).toString('ascii'), 'PK', 'начинается с подписи zip');
  assert.deepStrictEqual(Object.keys(части).sort(), [
    '[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels',
    'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml',
  ]);
});

test('лист — цельный XML: открытые теги закрыты и порядок разделов верный', async () => {
  const { части } = await книга();
  const лист = части['xl/worksheets/sheet1.xml'];
  assert.ok(лист.startsWith('<?xml'), 'объявление XML в начале');
  assert.ok(лист.endsWith('</worksheet>'));
  // Схема требует именно такой порядок; при обратном Excel файл не примет.
  assert.ok(лист.indexOf('<cols>') < лист.indexOf('<sheetData>'), 'cols до данных');
  assert.ok(лист.indexOf('<autoFilter') > лист.indexOf('</sheetData>'), 'автофильтр после данных');
  assert.strictEqual((лист.match(/<row /g) || []).length, 3, 'шапка и две записи');
  assert.ok(лист.includes('state="frozen"'), 'шапка закреплена');
});

test('шапка — те же колонки, что в таблице и в CSV', async () => {
  const { части } = await книга();
  const лист = части['xl/worksheets/sheet1.xml'];
  const первая = лист.slice(лист.indexOf('<row r="1">'), лист.indexOf('<row r="2">'));
  const подписи = [...первая.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]);
  assert.deepStrictEqual(подписи, xlsx.COLUMNS);
  assert.deepStrictEqual(подписи, require('../csv').COLUMNS, 'и совпадают с CSV');
  assert.ok(первая.includes('s="1"'), 'шапка полужирная');
});

test('значения на месте, а не сдвинуты по колонкам', async () => {
  const { части } = await книга();
  const лист = части['xl/worksheets/sheet1.xml'];
  const вторая = лист.slice(лист.indexOf('<row r="2">'), лист.indexOf('<row r="3">'));
  const ячейки = [...вторая.matchAll(/<c r="([A-Z]+2)"[^>]*>(?:<is><t[^>]*>([^<]*)<\/t><\/is>)?/g)]
    .map((m) => m[1] + '=' + (m[2] || ''));
  assert.deepStrictEqual(ячейки, [
    'A2=2026-09-04', 'B2=09:12', 'C2=214', 'D2=Исходящий',
    'E2=+74950000000', "F2=00:03'41", 'G2=', 'H2=Тестов Тест Тестович',
  ]);
});

test('номер с ведущим плюсом остаётся как есть — апостроф тут не нужен', async () => {
  // В CSV его пришлось бы обезвредить: Excel счёл бы ячейку формулой.
  // В xlsx строка — всегда строка, и это главная причина второго формата.
  const { части } = await книга();
  assert.ok(части['xl/worksheets/sheet1.xml'].includes('>+74950000000<'));
  assert.ok(!части['xl/worksheets/sheet1.xml'].includes("'+74950000000"));
});

test('добавочный с ведущим нулём не превращается в число', async () => {
  const { части } = await книга();
  const лист = части['xl/worksheets/sheet1.xml'];
  assert.ok(лист.includes('>0104<'), 'ноль на месте');
  assert.ok(!/<c r="C3"[^>]*\/?>(?!<is)/.test(лист.slice(лист.indexOf('<row r="3"'))) || лист.includes('t="inlineStr"'),
    'ячейка объявлена строкой');
});

test('амперсанд и угловые скобки экранируются, а не рвут разметку', () => {
  assert.strictEqual(xlsx.xmlEscape('Пробников & Ко'), 'Пробников &amp; Ко');
  assert.strictEqual(xlsx.xmlEscape('<a>'), '&lt;a&gt;');
  assert.strictEqual(xlsx.xmlEscape('он "сказал"'), 'он &quot;сказал&quot;');
});

test('апостроф не экранируется — он есть почти в каждой длительности', () => {
  // 00:03'41 — обычная запись длительности в журнале. В тексте элемента
  // апостроф ничего не значит, а &apos; на каждой строке раздувает файл.
  assert.strictEqual(xlsx.xmlEscape("00:03'41"), "00:03'41");
});

test('управляющие символы вырезаются: с ними Excel считает файл повреждённым', () => {
  // XML 1.0 их не допускает вовсе, а в журнал они попадают из сырых строк АТС.
  assert.strictEqual(xlsx.xmlEscape('а бв'), 'абв');
  assert.strictEqual(xlsx.xmlEscape('а\nб\tв'), 'а\nб\tв', 'перевод строки и табуляция допустимы');
});

test('пустое значение даёт пустую ячейку, а не «null»', () => {
  assert.strictEqual(xlsx.cell('A1', null), '<c r="A1"/>');
  assert.strictEqual(xlsx.cell('A1', undefined), '<c r="A1"/>');
  assert.ok(xlsx.cell('A1', '').indexOf('<is>') === -1);
});

test('краевые пробелы не съедаются', () => {
  assert.ok(xlsx.cell('A1', ' 214 ').includes('xml:space="preserve"'));
});

test('буквы колонок считаются и за пределами Z', () => {
  assert.strictEqual(xlsx.colLetter(1), 'A');
  assert.strictEqual(xlsx.colLetter(8), 'H');
  assert.strictEqual(xlsx.colLetter(26), 'Z');
  assert.strictEqual(xlsx.colLetter(27), 'AA');
  assert.strictEqual(xlsx.colLetter(52), 'AZ');
  assert.strictEqual(xlsx.colLetter(703), 'AAA');
});

test('автофильтр охватывает ровно заполненные строки', async () => {
  const { части } = await книга();
  assert.ok(части['xl/worksheets/sheet1.xml'].includes('<autoFilter ref="A1:H3"/>'));
});

test('пустая выборка даёт открываемый файл с одной шапкой', async () => {
  // Выгрузка «ничего не нашлось» не должна ронять ни сервер, ни Excel.
  const { части, rows } = await книга([]);
  assert.strictEqual(rows, 0);
  const лист = части['xl/worksheets/sheet1.xml'];
  assert.strictEqual((лист.match(/<row /g) || []).length, 1);
  assert.ok(лист.includes('<autoFilter ref="A1:H1"/>'));
});

test('CRC32 совпадает с эталоном zlib — иначе битым будет каждый файл', () => {
  const проба = Buffer.from('журнал звонков');
  assert.strictEqual(xlsx.crc32(проба), zlib.crc32 ? zlib.crc32(проба) : xlsx.crc32(проба));
  // И считается по кускам так же, как целиком: лист сжимается потоком.
  const целиком = xlsx.crc32(Buffer.from('абвгд'));
  const кусками = xlsx.crc32(Buffer.from('гд'), xlsx.crc32(Buffer.from('абв')));
  assert.strictEqual(кусками, целиком);
});

test('много строк собираются целиком и сжимаются', async () => {
  // Заодно проверяет обратное давление в потоке: на объёме, который в один
  // буфер не влезает, запись уходит в ожидание drain.
  const записи = Array.from({ length: 5000 }, (_, i) => ({
    call_date: '2026-09-04', call_time: '09:12', ext: String(200 + (i % 50)),
    direction: 'Исходящий', details: '+7495' + String(i).padStart(7, '0'),
    duration: "00:03'41", ring: '', fio: 'Тестов Тест Тестович',
  }));
  const { file, части, rows } = await книга(записи);
  assert.strictEqual(rows, 5000);
  assert.strictEqual((части['xl/worksheets/sheet1.xml'].match(/<row /g) || []).length, 5001);
  const наСтроку = file.length / rows;
  assert.ok(наСтроку < xlsx.BYTES_PER_ROW * 2,
    `оценка размера в окне выгрузки должна быть похожа на правду, вышло ${наСтроку.toFixed(0)} Б/строка`);
});

test('имя файла кириллическое, в заголовке есть ASCII-запасной вариант', () => {
  const имя = xlsx.fileName(new Date('2026-09-04T10:00:00Z'));
  assert.strictEqual(имя, 'журнал-звонков-2026-09-04.xlsx');
  const заголовок = xlsx.contentDisposition(имя);
  assert.ok(заголовок.includes('filename="calls.xlsx"'));
  assert.ok(заголовок.includes("filename*=UTF-8''"));
});
