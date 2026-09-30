const { writeZip } = require("./zip");
const { escapeXml } = require("./docx");

// ============================================================================
//  Шаблоны документов по умолчанию
//
//  Чтобы Ассистент выдавал документы сразу после установки, а не с ошибкой
//  «шаблон не загружен». Оформление строгое и простое; свой бланк с шапкой и
//  нужными формулировками администратор загружает в настройках — метки в нём
//  те же, что здесь (и те же, что были в прежнем «Ассистенте»).
//
//  В этих шаблонах нет ни одной фамилии: всё, что зависит от людей, приходит
//  из справочников метками.
// ============================================================================

const FONT = "Times New Roman";

function run(text, { bold = false, size } = {}) {
  const rPr = (bold ? "<w:b/>" : "") + (size ? `<w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/>` : "");
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

/** Абзац. text — строка или массив кусков [{text, bold}]. */
function p(text, { align, bold, size, after = 0, before = 0, indent } = {}) {
  const pieces = Array.isArray(text) ? text : [{ text }];
  const pPr = (align ? `<w:jc w:val="${align === "center" ? "center" : align === "right" ? "right" : "both"}"/>` : "")
    + `<w:spacing w:before="${before * 20}" w:after="${after * 20}"/>`
    + (indent ? `<w:ind w:left="${indent * 567}"/>` : "");
  return `<w:p><w:pPr>${pPr}</w:pPr>${pieces.map((x) => run(x.text, { bold: x.bold ?? bold, size })).join("")}</w:p>`;
}

const empty = () => p("");

/**
 * Таблица. widths — ширины колонок в сантиметрах, header — шапка (жирным),
 * rows — строки ячеек-строк. borders: false — таблица-разметка для подписей.
 */
function table({ widths, header, rows, borders = true, size }) {
  const tw = (cm) => Math.round(cm * 567);
  const border = borders
    ? '<w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders>'
    : "";
  const cell = (text, i, head) => `<w:tc><w:tcPr><w:tcW w:w="${tw(widths[i])}" w:type="dxa"/></w:tcPr>`
    + String(text).split("\n").map((line) => p(line, { bold: head, size, align: head ? "center" : undefined })).join("")
    + "</w:tc>";
  const tr = (cells, head) => `<w:tr>${head ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells.map((c, i) => cell(c, i, head)).join("")}</w:tr>`;
  // Таблица без рамок — это разметка подписей; сдвигаем её на поле ячейки,
  // чтобы текст стоял ровно по краю абзацев, а не на 1,5 мм правее.
  const indent = borders ? "" : '<w:tblInd w:w="-80" w:type="dxa"/>';
  return `<w:tbl><w:tblPr><w:tblW w:w="${tw(widths.reduce((a, b) => a + b, 0))}" w:type="dxa"/>${indent}${border}`
    + '<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>'
    + `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${tw(w)}"/>`).join("")}</w:tblGrid>`
    + (header ? tr(header, true) : "") + rows.map((r) => tr(r, false)).join("") + "</w:tbl>";
}

/** Подписи: «должность ____ Фамилия И.О.» строкой таблицы без рамок. */
function signature(post, name) {
  return table({ widths: [8, 4.5, 4.5], borders: false, rows: [[post, "____________", name]] });
}

function docx(body, { landscape = false } = {}) {
  const page = landscape
    ? '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>'
    : '<w:pgSz w:w="11906" w:h="16838"/>';
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<w:body>${body.join("")}<w:sectPr>${page}<w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1418" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults>'
    + `<w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}" w:eastAsia="${FONT}"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault>`
    + '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>';
  return writeZip([
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
      + "</Types>"],
    ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + "</Relationships>"],
    ["word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + "</Relationships>"],
    ["word/document.xml", document],
    ["word/styles.xml", styles],
  ]);
}

// Шапка «кому» в правом верхнем углу — в дательном падеже: руководителю, а в
// записке на доступ — начальнику отдела ИТ (поля те же, подставляет маршрут).
const addressee = () => [
  p("{bossPostD}", { align: "right" }),
  p("{orgName}", { align: "right" }),
  p("{bossFIOD}", { align: "right", after: 18 }),
];

const BUILDERS = {
  access: () => docx([
    ...addressee(),
    p("Служебная записка", { align: "center", bold: true }),
    p("от {date}", { align: "center", after: 12 }),
    p("{TYPEREQUEST}", { align: "center", bold: true, after: 8 }),
    table({
      widths: [5, 11.3],
      rows: [
        ["Фамилия, имя, отчество", "{FIO}"],
        ["Должность", "{post}"],
        ["Отдел", "{department}"],
        ["Кабинет", "{location}"],
        ["Телефоны", "{tel}"],
      ],
    }),
    p("", { after: 6 }),
    p("Необходимо предоставить доступ:", { bold: true }),
    p("{appList}", { after: 6 }),
    p("{comment}", { after: 18 }),
    signature("{chiefType}", "{chiefFIO}"),
  ]),

  defect: () => docx([
    p("{approveBlock}", { align: "right", after: 12 }),
    p("Акт о выявленных неисправностях (дефектах) № {actNumber}", { align: "center", bold: true }),
    p("от {date}", { align: "center", after: 12 }),
    p("Оборудование:", { bold: true, after: 4 }),
    table({
      widths: [8.3, 4, 4],
      header: ["Наименование", "Инвентарный номер", "Местонахождение"],
      rows: [["{#tecToRepair}{name}", "{inventoryNum}", "{location}{/}"]],
    }),
    p("", { after: 6 }),
    p("Выявленные неисправности:", { bold: true, after: 4 }),
    table({
      widths: [13.3, 3],
      header: ["Неисправность", "Кол-во"],
      rows: [["{#defects}{defectsName}", "{count}{/}"]],
    }),
    p("", { after: 6 }),
    p("Необходимые работы:", { bold: true, after: 4 }),
    table({
      widths: [10.3, 2.5, 3.5],
      header: ["Работы", "Кол-во", "Срок"],
      rows: [["{#defectRepair}{repairWorks}", "{count}", "1 рабочий день{/}"]],
    }),
    p("", { after: 18 }),
    signature("{responsiblePost}", "{responsibleName}"),
    p("", { after: 8 }),
    signature("{chiefPost}", "{chiefName}"),
  ]),

  repair: () => docx([
    p("{approveBlock}", { align: "right", after: 12 }),
    p("Акт о проведении ремонтно-восстановительных работ № {actNumber}", { align: "center", bold: true }),
    p("от {date}", { align: "center", after: 12 }),
    p("Оборудование:", { bold: true, after: 4 }),
    table({
      widths: [8.3, 4, 4],
      header: ["Наименование", "Инвентарный номер", "Местонахождение"],
      rows: [["{#tecToRepair}{name}", "{inventoryNum}", "{location}{/}"]],
    }),
    p("", { after: 6 }),
    p("Выполненные работы и использованные запасные части:", { bold: true, after: 4 }),
    table({
      widths: [5.3, 5.5, 3.5, 2],
      header: ["Работы", "Запасная часть", "Номенклатурный номер", "Кол-во"],
      rows: [["{#repair}{repairWorks}", "{name}", "{nomenclature}", "{count}{/}"]],
    }),
    p("", { after: 6 }),
    p("В процессе ремонта образовались запасные части – {remains}.", { align: "both", after: 18 }),
    signature("{responsiblePost}", "{responsibleName}"),
    p("", { after: 8 }),
    signature("{chiefPost}", "{chiefName}"),
  ]),

  writeoff: () => docx([
    p("{approveBlock}", { align: "right", after: 12 }),
    p("Акт технического состояния № {actNumber}", { align: "center", bold: true }),
    p("от {date}", { align: "center", after: 12 }),
    p("Комиссия в составе: председатель — {chairPost} {chairName}; члены комиссии: {membersLine} — провела осмотр оборудования.", { align: "both", after: 8 }),
    p("В результате осмотра и тестирования {tecName} инвентарный № {tecInventory}, в эксплуатацию введён в {tecDate} г., выявлены недостатки:", { align: "both", after: 4 }),
    p("{tecDefect}", { align: "both", after: 8 }),
    p("Заключение: оборудование к дальнейшей эксплуатации непригодно, ремонт экономически нецелесообразен. Рекомендуется списание.", { align: "both", after: 18 }),
    signature("Председатель комиссии", "{chairName}"),
    p("Члены комиссии:", { before: 6 }),
    table({ widths: [8, 4.5, 4.5], borders: false, rows: [["{#members}{post}", "____________", "{name}{/}"]] }),
    p("", { after: 8 }),
    signature("{responsiblePost}", "{responsibleName}"),
  ]),

  cartridges: () => docx([
    p("{approveBlock}", { align: "right", after: 12 }),
    p("Ведомость на списание картриджей и расходных материалов", { align: "center", bold: true }),
    p("(за {month} месяц {year} года)", { align: "center", after: 12 }),
    table({
      widths: [1.2, 3.3, 7.3, 1.8, 3.5],
      header: ["№", "Номенклатурный номер", "Наименование", "Кол-во", "Где установлен"],
      rows: [["{#repairCartridges}{num}", "{nomenclature}", "{name}", "{count}", "{location}{/}"]],
    }),
    p("Итого: {total} шт.", { before: 6, after: 18 }),
    signature("{responsiblePost}", "{responsibleName}"),
    p("", { after: 8 }),
    signature("{chiefPost}", "{chiefName}"),
  ]),

  parts_memo: () => docx([
    ...addressee(),
    p("Служебная записка", { align: "center", bold: true }),
    p("от {date}", { align: "center", after: 12 }),
    p("Прошу выдать запасные части для ремонта следующего оборудования:", { align: "both", after: 8 }),
    table({
      widths: [8.3, 4, 4],
      header: ["Наименование", "Инвентарный номер", "Местонахождение"],
      rows: [["{#tecToRepair}{name}", "{inventoryNum}", "{location}{/}"]],
    }),
    p("", { after: 6 }),
    table({
      widths: [9.3, 4, 3],
      header: ["Запасная часть", "Номенклатурный номер", "Кол-во"],
      rows: [["{#parts}{name}", "{nomenclature}", "{count}{/}"]],
    }),
    p("", { after: 18 }),
    signature("{chiefPost}", "{chiefName}"),
  ]),
};

const cache = new Map();
/** Шаблон по умолчанию для вида документа (Buffer) или null. */
function defaultTemplate(kind) {
  if (!BUILDERS[kind]) return null;
  if (!cache.has(kind)) cache.set(kind, BUILDERS[kind]());
  return cache.get(kind);
}

module.exports = { defaultTemplate, KINDS: Object.keys(BUILDERS) };
