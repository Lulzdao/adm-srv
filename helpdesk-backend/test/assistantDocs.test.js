'use strict';

const test = require("node:test");
const assert = require("node:assert");
const { readZip, writeZip } = require("../services/zip");
const { readFirstSheet, buildXlsx } = require("../services/xlsx");
const { readTable, parseCsv } = require("../services/tables");
const { fillDocx, listTags, checkTemplate } = require("../services/docx");
const { defaultTemplate, KINDS } = require("../services/docxDefaults");
const { parseEquipment, parseParts, shortName } = require("../services/assistant");

// ============================================================================
//  Ассистент: документы без HTTP — zip, книги Excel, CSV, шаблоны Word
//
//  Шаблоны здесь собираются из XML прямо в тесте — так видно, какие именно
//  куски Word подаются на вход, включая метки, разорванные между <w:t>, как
//  их на самом деле сохраняет Word после правки опечатки.
//
//  Все ФИО и наименования ВЫДУМАНЫ.
// ============================================================================

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
function docxOf(body, extra = []) {
  return writeZip([
    ["[Content_Types].xml", "<Types/>"],
    ["word/document.xml", `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`],
    ...extra,
  ]);
}
const para = (...runs) => `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${runs.map((t) => `<w:r><w:rPr><w:b/></w:rPr><w:t>${t}</w:t></w:r>`).join("")}</w:p>`;
const row = (...cells) => `<w:tr>${cells.map((c) => `<w:tc>${para(c)}</w:tc>`).join("")}</w:tr>`;
const docXml = (buf, part = "word/document.xml") => readZip(buf).get(part).toString("utf8");
const textOf = (xml) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:br\/>/g)].map((m) => (m[1] === undefined ? "\n" : m[1])).join("");

test("zip: что собрали, то и прочитали — с кириллицей в именах и сжатием", () => {
  const big = "Строка журнала техники\n".repeat(2000);
  const buf = writeZip([["акты/акт № 1.txt", "первый"], ["данные.txt", big], ["пусто.txt", ""]]);
  const back = readZip(buf);
  assert.deepStrictEqual([...back.keys()], ["акты/акт № 1.txt", "данные.txt", "пусто.txt"]);
  assert.strictEqual(back.get("данные.txt").toString(), big);
  assert.ok(buf.length < big.length / 10, "повторяющийся текст сжат");
  assert.throws(() => readZip(Buffer.from("не zip вовсе, просто текст достаточной длины")), /не похож на zip/);
});

test("xlsx: собранная книга читается обратно, числа остаются числами, ОКПО — цифрами", () => {
  const buf = buildXlsx([{
    name: "Список", columns: [{ title: "ОКПО" }, { title: "Наименование" }, { title: "Кол-во" }],
    rows: [["01234567", 'ООО "Ромашка" & Ко <тест>', 3], ["12345678", "Выдуманное предприятие", 10]],
  }]);
  const rows = readFirstSheet(buf);
  assert.deepStrictEqual(rows[0], ["ОКПО", "Наименование", "Кол-во"]);
  assert.deepStrictEqual(rows[1], ["01234567", 'ООО "Ромашка" & Ко <тест>', "3"]);
  assert.strictEqual(rows[2][2], "10");
  assert.match(docXml(buf, "xl/worksheets/sheet1.xml"), /<c r="C2" s="2"><v>3<\/v><\/c>/);
});

test("xlsx: книга, сохранённая Excel, — общие строки, пропуски ячеек, число вместо ОКПО", () => {
  // Так выглядит лист после Excel: строки в sharedStrings, пустые ячейки
  // пропущены (B2 нет), ОКПО набран числом.
  const buf = writeZip([
    ["xl/workbook.xml", '<workbook xmlns:r="r"><sheets><sheet name="Л" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ["xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
    ["xl/sharedStrings.xml", '<sst><si><t>Почта</t></si><si><r><t>Выдуманное </t></r><r><t>ООО</t></r></si><si><t>test@example.invalid</t></si></sst>'],
    ["xl/worksheets/sheet1.xml", '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>'
      + '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="C3"><v>12345678</v></c><c r="D3"><v>1.2345678E+7</v></c></row>'
      + "</sheetData></worksheet>"],
  ]);
  const rows = readFirstSheet(buf);
  assert.deepStrictEqual(rows[0], ["Почта", "", "Выдуманное ООО"]);
  assert.deepStrictEqual(rows[1], []);
  assert.deepStrictEqual(rows[2], ["test@example.invalid", "", "12345678", "12345678"]);
});

test("CSV: кавычки, переносы в ячейке, разделитель «;», кодировка Windows-1251", () => {
  const text = 'ОКПО;Наименование;Почта\r\n01234567;"ООО ""Ромашка""; филиал";a@example.invalid\r\n12345678;"Две\nстроки";b@example.invalid\r\n';
  assert.deepStrictEqual(parseCsv(text)[1], ["01234567", 'ООО "Ромашка"; филиал', "a@example.invalid"]);
  // Та же таблица в кодировке Windows-1251 — так сохраняет CSV русский Excel.
  const map = { "О": 0xce, "К": 0xca, "П": 0xcf };
  const bytes = Buffer.from([map["О"], map["К"], map["П"], map["О"], 0x3b, 0x61, 0x40, 0x62, 0x2e, 0x63, 0x0d, 0x0a, 0x31, 0x3b, 0x78, 0x40, 0x79, 0x2e, 0x7a]);
  assert.deepStrictEqual(readTable(bytes), [["ОКПО", "a@b.c"], ["1", "x@y.z"]]);
  assert.throws(() => readTable(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])), /старого формата Excel/);
});

test("шаблон: метка, разорванная Word между кусками текста, заполняется, оформление остальных кусков не трогается", () => {
  const t = docxOf(para("Акт № {act", "Num", "ber} от ", "{date}") + para("Без меток"));
  const out = docXml(fillDocx(t, { actNumber: "17", date: "01.10.2026" }));
  assert.strictEqual(textOf(out), "Акт № 17 от 01.10.2026Без меток");
  assert.strictEqual((out.match(/<w:b\/>/g) || []).length, 5, "все прогоны сохранили оформление");
  assert.deepStrictEqual(listTags(t), ["actNumber", "date"]);
});

test("шаблон: список в строке таблицы повторяет строку, пустой список убирает её", () => {
  const t = docxOf(`<w:tbl>${row("Наименование", "Инв. №")}${row("{#tec}{name}", "{inv}{/}")}${row("Итого", "{total}")}</w:tbl>`);
  const out = docXml(fillDocx(t, { tec: [{ name: "Принтер", inv: "001" }, { name: "Монитор", inv: "002" }], total: 2 }));
  assert.strictEqual((out.match(/<w:tr>/g) || []).length, 4);
  assert.strictEqual(textOf(out), "НаименованиеИнв. №Принтер001Монитор002Итого2");
  const empty = docXml(fillDocx(t, { tec: [], total: 0 }));
  assert.strictEqual((empty.match(/<w:tr>/g) || []).length, 2);
});

test("шаблон: список в абзаце, списки по абзацам, {^…} и вложенные поля элемента", () => {
  const t = docxOf(
    para("Отделы: {#deps}{name}, {/deps}конец")
    + para("{#people}") + para("{name} — {post}") + para("{/}")
    + para("{^people}Людей нет{/}"),
  );
  const out = textOf(docXml(fillDocx(t, { deps: [{ name: "А" }, { name: "Б" }], people: [{ name: "Тестов Т.Т.", post: "эксперт" }, { name: "Пробный П.П.", post: "экономист" }] })));
  assert.strictEqual(out, "Отделы: А, Б, конецТестов Т.Т. — экспертПробный П.П. — экономист");
  const none = textOf(docXml(fillDocx(t, { deps: [], people: [] })));
  assert.strictEqual(none, "Отделы: конецЛюдей нет");
});

test("шаблон: значения экранируются, перевод строки становится переносом, пропуски — пустыми", () => {
  const t = docxOf(para("{a}|{b}|{missing}|{n}"));
  const out = docXml(fillDocx(t, { a: 'ООО "Ромашка" & <Ко>', b: "УТВЕРЖДАЮ\nРуководитель", n: 2.5 }));
  assert.match(out, /ООО "Ромашка" &amp; &lt;Ко&gt;/);
  assert.match(out, /УТВЕРЖДАЮ<\/w:t><w:br\/><w:t xml:space="preserve">Руководитель/);
  assert.strictEqual(textOf(out), 'ООО "Ромашка" &amp; &lt;Ко&gt;|УТВЕРЖДАЮ\nРуководитель||2,5');
});

test("шаблон: метки в колонтитуле тоже заполняются; фигурные скобки в атрибутах не трогаются", () => {
  const t = docxOf(`<w:p><w:customXml w:uri="{GUID-123}"/><w:r><w:t>{x}</w:t></w:r></w:p>`,
    [["word/header1.xml", `<w:hdr ${W}><w:p><w:r><w:t>Акт № {num}</w:t></w:r></w:p></w:hdr>`]]);
  const buf = fillDocx(t, { x: "да", num: 5 });
  assert.match(docXml(buf), /w:uri="\{GUID-123\}"/);
  assert.strictEqual(textOf(docXml(buf, "word/header1.xml")), "Акт № 5");
});

test("шаблон: незакрытый список — понятная ошибка при загрузке, а не битый документ", () => {
  assert.throws(() => checkTemplate(docxOf(para("{#tec}{name}"))), /не закрыт список \{#tec\}/);
  assert.throws(() => checkTemplate(docxOf(para("{#a}x{/b}"))), /закрыт чужой меткой/);
  assert.throws(() => fillDocx(Buffer.from("не документ, а просто строка текста"), {}), /не открывается как документ Word/);
});

test("встроенные шаблоны собираются и заполняются без остатков меток", () => {
  const data = {
    num: 3, actNumber: 7, date: "01.10.2026", orgName: "Липецкстат",
    tec: [{ num: 1, name: "Монитор выдуманный", inv: "И-1", count: 1 }],
    tecToRepair: [{ name: "Принтер выдуманный", inventoryNum: "И-2", location: "каб. 1" }],
    defects: [{ defectsName: "износ", count: 1 }], defectRepair: [{ repairWorks: "замена", count: 1 }],
    repair: [{ repairWorks: "замена", name: "Фьюзер", nomenclature: "00-1", count: 1 }],
    parts: [{ name: "Фьюзер", nomenclature: "00-1", count: 1 }],
    repairCartridges: [{ num: 1, name: "Картридж", count: 2 }], members: [{ post: "эксперт", name: "Тестов Т.Т." }],
  };
  for (const kind of KINDS) {
    const out = docXml(fillDocx(defaultTemplate(kind), data));
    assert.doesNotMatch(textOf(out), /[{}]/, kind);
  }
  assert.match(textOf(docXml(fillDocx(defaultTemplate("transfer"), data))), /Монитор выдуманный/);
});

test("выгрузки из 1С: разделитель «t###t», пустые поля, количество", () => {
  const eq = parseEquipment("Калькулятор выдуманный t###tИ-0001t###t01.06.2006t###t1\r\nФлеш диск Ethernett###tt###tt###t2\r\n\r\n");
  assert.deepStrictEqual(eq, [
    { name: "Калькулятор выдуманный", inv: "И-0001", commissioned: "01.06.2006", count: 1 },
    { name: "Флеш диск Ethernet", inv: null, commissioned: null, count: 2 },
  ]);
  const parts = parseParts("﻿Картридж выдуманный (черный)t###tt###t00-000000000001t###t6\nФьюзер выдуманныйt###tсклад t###t00-000000000002t###t2");
  assert.strictEqual(parts[0].cartridge, 1);
  assert.strictEqual(parts[1].cartridge, 0);
  assert.strictEqual(parts[1].location, "склад");
  assert.throws(() => parseParts("просто текст"), /rep\.txt/);
  assert.strictEqual(shortName("Тестов Тест Тестович"), "Тестов Т.Т.");
});

test("название отдела склоняется само: «Отдел …» и «…ый/…ий отдел»", () => {
  const { deptGen } = require("../services/assistant");
  assert.strictEqual(deptGen("Отдел статистики цен"), "отдела статистики цен");
  assert.strictEqual(deptGen("Административный отдел"), "административного отдела");
  assert.strictEqual(deptGen("Общий отдел"), "общего отдела");
  assert.strictEqual(deptGen("Бухгалтерский отдел"), "бухгалтерского отдела");
  assert.strictEqual(deptGen("  Отдел   сводных работ "), "отдела сводных работ");
  assert.strictEqual(deptGen("Сектор учёта"), "сектор учёта", "не по правилам — как есть");
});
