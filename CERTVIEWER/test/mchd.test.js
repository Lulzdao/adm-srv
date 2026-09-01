'use strict';

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");

const { makeZip } = require("./zipFixture");
const { parseArchive, readZip, parseEis, parseEmchd, toIsoDate } = require("../mchd");

// ============================================================================
//  Разбор выгрузки МЧД
//
//  Самый рискованный код проекта: ZIP и XML читаются своими руками, а входной
//  файл приходит извне и доверять ему нельзя. Здесь проверяются оба формата,
//  обе ветки сжатия и поведение на намеренно испорченных архивах.
//
//  ВСЕ ДАННЫЕ ВЫДУМАНЫ. Настоящих доверенностей в тестах нет и быть не должно.
// ============================================================================

const EIS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<powerOfAttorney xmlns="http://zakupki.gov.ru/cc/POATypes/1">
  <uuid>00000000-1111-2222-3333-444444444444</uuid>
  <regNumber>000000000000000001</regNumber>
  <createDate>2025-01-10</createDate>
  <endDate>2027-01-09</endDate>
  <principalInfo>
    <lastName>Доверителев</lastName><firstName>Доверитель</firstName><middleName>Доверителевич</middleName>
  </principalInfo>
  <representativeInfo>
    <lastName>Пробников</lastName><firstName>Пробник</firstName><middleName>Пробникович</middleName>
  </representativeInfo>
</powerOfAttorney>`;

const FNS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Файл ИдФайл="ON_DOVBB_000000_000000_20250110_11111111-2222-3333-4444-555555555555" ВерсФорм="EMCHD_1">
  <Документ>
    <Доверенность ИдФайл="11111111-2222-3333-4444-555555555555">
      <СвДов НомДовер="000000000000000002" ДатаВыдДовер="10.01.2025" СрокДейст="09.01.2027"/>
      <СвДоверит><ЮЛ НаимОрг="Тестовая организация"/></СвДоверит>
      <СвУпПред>
        <ФЛ><ФИО Фамилия="Тестова" Имя="Проба" Отчество="Тестовна"/></ФЛ>
      </СвУпПред>
    </Доверенность>
  </Документ>
</Файл>`;

test("readZip: читает и хранение без сжатия, и deflate", () => {
  const zip = makeZip([
    { name: "plain.xml", data: "<a>без сжатия</a>", store: true },
    { name: "packed.xml", data: EIS_XML },
  ]);
  const files = readZip(zip);
  assert.equal(files.length, 2);
  assert.equal(files[0].data.toString("utf8"), "<a>без сжатия</a>");
  assert.match(files[1].data.toString("utf8"), /powerOfAttorney/);
});

test("readZip: находит каталог, даже когда в хвосте комментарий", () => {
  // Сигнатуру EOCD приходится искать с конца, потому что после неё может лежать
  // комментарий до 64 КБ. Проверяем, что поиск не ломается на длинном хвосте.
  const zip = makeZip([{ name: "a.xml", data: EIS_XML }], { comment: "к".repeat(3000) });
  assert.equal(readZip(zip).length, 1);
});

test("readZip: внятно отказывается от не-ZIP", () => {
  assert.throws(
    () => readZip(Buffer.from("это вообще не архив, а просто текст")),
    /не ZIP-архив/
  );
});

test("readZip: испорченная сигнатура каталога — отказ, а не падение", () => {
  const zip = makeZip([{ name: "a.xml", data: EIS_XML }], { corruptEocd: true });
  assert.throws(() => readZip(zip), /не ZIP-архив/);
});

test("readZip: пустой буфер не роняет процесс", () => {
  assert.throws(() => readZip(Buffer.alloc(0)), Error);
});

test("readZip: обрезанный архив не читает за границу буфера", () => {
  // Файл оборвали на середине — смещения в каталоге указывают в никуда.
  // Проверка именно на «не падает необработанным исключением»: буфер читается
  // по числам из недоверенного файла, и выход за границу здесь был бы дырой.
  const full = makeZip([{ name: "a.xml", data: EIS_XML }, { name: "b.xml", data: FNS_XML }]);
  for (const cut of [10, 40, 100, Math.floor(full.length / 2), full.length - 25]) {
    const truncated = full.subarray(0, cut);
    try { readZip(truncated); } catch (err) {
      assert.ok(err instanceof Error, `обрезка на ${cut}: ожидалась Error`);
    }
  }
});

test("parseEis: берёт ФИО представителя, а не доверителя", () => {
  // В документе два ФИО, и перепутать их легко: доверитель идёт раньше.
  // Реестр должен показывать того, НА КОГО выдана доверенность.
  const r = parseEis(EIS_XML);
  assert.equal(r.fullName, "Пробников Пробник Пробникович");
  assert.equal(r.uuid, "00000000-1111-2222-3333-444444444444");
  assert.equal(r.regNumber, "000000000000000001");
  assert.equal(r.validTo, "2027-01-09");
  assert.equal(r.format, "ЕИС");
});

test("parseEmchd: читает значения из атрибутов с кириллическими именами", () => {
  // Граница слова \b в JS определена через [A-Za-z0-9_], поэтому перед
  // кириллической буквой её нет и `\bФамилия=` не совпадает никогда.
  // На этом разбор ФНС молча возвращал пустые поля — тест держит починку.
  const r = parseEmchd(FNS_XML);
  assert.equal(r.fullName, "Тестова Проба Тестовна");
  assert.equal(r.regNumber, "000000000000000002");
  assert.equal(r.validTo, "09.01.2027");
  assert.equal(r.format, "ФНС");
});

test("parseEis / parseEmchd: чужой формат не разбирают", () => {
  assert.equal(parseEis(FNS_XML), null);
  assert.equal(parseEmchd(EIS_XML), null);
});

test("toIsoDate: приводит оба вида дат к одному", () => {
  assert.equal(toIsoDate("2026-08-27"), "2026-08-27");
  assert.equal(toIsoDate("27.08.2026"), "2026-08-27");
  assert.equal(toIsoDate("2026-08-27T10:11:12Z"), "2026-08-27");
  assert.equal(toIsoDate("чепуха"), "");
  assert.equal(toIsoDate(""), "");
  assert.equal(toIsoDate(null), "");
});

test("parseArchive: разбирает выгрузку ЕИС целиком, вместе с подписью", () => {
  const zip = makeZip([
    { name: "poa_XML_PF.xml", data: EIS_XML },
    { name: "poa_SIGN_PF.sig", data: "подпись, которую мы не проверяем" },
  ]);
  const r = parseArchive(zip);
  assert.equal(r.fullName, "Пробников Пробник Пробникович");
  assert.equal(r.validFrom, "2025-01-10");
  assert.equal(r.validTo, "2027-01-09");
  assert.equal(r.signed, true);
  assert.equal(r.format, "ЕИС");
});

test("parseArchive: без подписи signed=false, но разбор проходит", () => {
  const r = parseArchive(makeZip([{ name: "poa_XML_PF.xml", data: EIS_XML }]));
  assert.equal(r.signed, false);
});

test("parseArchive: формат ФНС подхватывается, когда формата ЕИС в архиве нет", () => {
  const zip = makeZip([{ name: "poa_XML_PF_MC.xml", data: FNS_XML }]);
  const r = parseArchive(zip);
  assert.equal(r.fullName, "Тестова Проба Тестовна");
  assert.equal(r.validTo, "2027-01-09", "дата ФНС должна приводиться к ISO");
  assert.equal(r.format, "ФНС");
});

test("parseArchive: ЕИС в приоритете, когда в архиве оба формата", () => {
  // В настоящей выгрузке лежат оба. Значения ЕИС в тексте тегов, а не в
  // атрибутах, и разбор устойчивее — поэтому берём его.
  const zip = makeZip([
    { name: "poa_XML_PF_MC.xml", data: FNS_XML },
    { name: "poa_XML_PF.xml", data: EIS_XML },
  ]);
  assert.equal(parseArchive(zip).format, "ЕИС");
});

test("parseArchive: архив с паролем отвергается внятно", () => {
  const zip = makeZip([{ name: "poa_XML_PF.xml", data: EIS_XML }], { encrypted: true });
  assert.throws(() => parseArchive(zip), /защищён паролем/);
});

test("parseArchive: архив без XML — понятный отказ", () => {
  const zip = makeZip([{ name: "readme.txt", data: "тут нет доверенности" }]);
  assert.throws(() => parseArchive(zip), /нет XML/);
});

test("parseArchive: XML без ФИО не проходит за доверенность", () => {
  const zip = makeZip([{ name: "a.xml", data: '<powerOfAttorney xmlns="http://zakupki.gov.ru/cc/POATypes/1"><uuid>x</uuid></powerOfAttorney>' }]);
  assert.throws(() => parseArchive(zip), /не похоже на МЧД|ФИО/);
});

test("parseArchive: XML без срока действия отвергается отдельным сообщением", () => {
  const noEnd = EIS_XML.replace(/<endDate>[^<]*<\/endDate>/, "");
  const zip = makeZip([{ name: "a.xml", data: noEnd }]);
  assert.throws(() => parseArchive(zip), /срок/);
});

test("parseArchive: не-ZIP на входе не роняет процесс", () => {
  // Пользователь перетащил на страницу .pdf вместо архива. Должен получить
  // внятный текст, а не пятисотку.
  assert.throws(() => parseArchive(Buffer.from("%PDF-1.7\n...")), /не ZIP-архив/);
});

test("readZip: файл с неизвестным методом сжатия пропускается, остальные читаются", () => {
  // Метод сжатия код берёт из ЦЕНТРАЛЬНОГО КАТАЛОГА, а не из локального
  // заголовка: при потоковой записи локальный бывает неполным. Поэтому и
  // портим запись в каталоге — иначе тест проверял бы не то, что выполняется.
  const zip = makeZip([
    { name: "exotic.xml", data: EIS_XML },
    { name: "poa_XML_PF.xml", data: EIS_XML },
  ]);
  const patched = Buffer.from(zip);

  const eocd = patched.length - 22 - 0;               // комментария в фикстуре нет
  const centralStart = patched.readUInt32LE(eocd + 16);
  patched.writeUInt16LE(9, centralStart + 10);        // 9 = deflate64, мы его не умеем

  const files = readZip(patched);
  assert.equal(files.length, 1, "непонятный метод — файл пропускаем, а не падаем");
  assert.equal(files[0].name, "poa_XML_PF.xml");
  assert.equal(parseArchive(patched).format, "ЕИС", "разбор опирается на оставшийся файл");
});

test("readZip: когда неизвестен метод у ВСЕХ файлов — внятный отказ", () => {
  const zip = makeZip([{ name: "a.xml", data: EIS_XML }]);
  const patched = Buffer.from(zip);
  const centralStart = patched.readUInt32LE(patched.length - 22 + 16);
  patched.writeUInt16LE(9, centralStart + 10);
  assert.throws(() => readZip(patched), /нет файлов/);
});

test("readZip: каталоги внутри архива пропускаются", () => {
  const zip = makeZip([
    { name: "dir/", data: "", store: true },
    { name: "dir/poa_XML_PF.xml", data: EIS_XML },
  ]);
  const files = readZip(zip);
  assert.equal(files.length, 1, "запись-каталог не должна попадать в список файлов");
  assert.equal(files[0].name, "dir/poa_XML_PF.xml");
});

// ---------------------------------------------------------------------------
//  Пределы распаковки
//
//  Архив приходит от человека, и верить ему нельзя ни в размерах, ни в числе
//  записей. Распаковка синхронная: сколько она тянет, столько модуль не
//  отвечает никому.
// ---------------------------------------------------------------------------

test("распаковка: архив с огромным содержимым отвергается, а не съедает память", () => {
  // Однородные данные жмутся примерно 1000:1. Настоящая выгрузка ЕИС — это
  // десятки килобайт, так что законному архиву предел не мешает.
  const огромное = Buffer.alloc(200 * 1024 * 1024, 0x41);
  const архив = makeZip([{ name: "бомба.xml", data: огромное }]);
  assert.ok(архив.length < 1024 * 1024, "сам архив должен быть маленьким — в этом и суть");

  const начало = Date.now();
  assert.throws(() => readZip(архив), /слишком большой объём/);
  assert.ok(Date.now() - начало < 500, "отказ должен быть мгновенным, до распаковки");
});

test("распаковка: лживый заголовок не проводит бомбу мимо предела", () => {
  const огромное = Buffer.alloc(64 * 1024 * 1024, 0x42);
  const архив = makeZip([{ name: "лжец.xml", data: огромное }]);

  // Подменяем заявленный размер в записи центрального каталога на скромный:
  // читаем-то мы именно его, и без второй проверки бомба прошла бы.
  const CEN = 0x02014b50;
  let cen = -1;
  for (let i = 0; i < архив.length - 4; i++) {
    if (архив.readUInt32LE(i) === CEN) { cen = i; break; }
  }
  assert.ok(cen > 0, "запись центрального каталога не найдена — тест устарел");
  архив.writeUInt32LE(1024, cen + 24); // «внутри всего килобайт»

  assert.throws(() => readZip(архив), /слишком большой объём/,
    "заголовку верить нельзя — предел должен стоять и на самой распаковке");
});

test("распаковка: слишком много записей отвергается", () => {
  const архив = makeZip([{ name: "a.xml", data: Buffer.from("<x/>") }]);
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = архив.length - 22; i >= 0; i--) {
    if (архив.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  assert.ok(eocd > 0);
  архив.writeUInt16LE(5000, eocd + 10); // «внутри пять тысяч файлов»

  assert.throws(() => readZip(архив), /слишком большой объём/);
});

test("распаковка: обычная выгрузка проходит как прежде", () => {
  // Предел не должен задевать законный архив — проверяем на размере,
  // сопоставимом с настоящей выгрузкой.
  const xml = Buffer.from("<?xml version=\"1.0\"?><Доверенность/>".repeat(500), "utf8");
  const архив = makeZip([
    { name: "ДОВ_XML_PF.xml", data: xml },
    { name: "ДОВ_SIGN_PF.sig", data: Buffer.from("выдуманная-подпись") },
  ]);
  const files = readZip(архив);
  assert.equal(files.length, 2);
  assert.equal(files[0].data.length, xml.length);
});
