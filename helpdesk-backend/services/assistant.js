const { getSetting, setSetting } = require("./settings");
const { defaultTemplate } = require("./docxDefaults");
const { fillDocx, DOCX_TYPE } = require("./docx");

// ============================================================================
//  Ассистент: общее для его разделов
//
//  Справочники, шаблоны документов, нумерация, разбор выгрузок из 1С. Сами
//  разделы — в routes/assistant*.js и routes/mailings.js.
// ============================================================================

// Виды документов и метки, которые есть в данных для каждого. Список меток
// показывается администратору рядом с загрузкой шаблона — чтобы свой бланк
// можно было сделать, не заглядывая в код.
const TEMPLATES = {
  access: {
    label: "Служебная записка на доступ сотрудника",
    tags: "TYPEREQUEST, FIO, post, department, location, tel, appList, comment, chiefType, chiefFIO, bossPostD, bossFIOD, orgName, date",
  },
  transfer: {
    label: "Заявка на передачу оборудования",
    tags: "num, date, postTo, depTo, FIOTo, postFrom, depFrom, FIOFrom, postToI, FIOToI, postFromI, FIOFromI, bossPostD, bossFIOD, bossZamPost, bossZamFIO, orgName; список {#tec}: num, name, inv, count",
  },
  defect: {
    label: "Акт о выявленных неисправностях (дефектах)",
    tags: "actNumber, date, approveBlock, responsiblePost, responsibleName, chiefPost, chiefName; списки {#tecToRepair}: name, inventoryNum, location; {#defects}: defectsName, count; {#defectRepair}: repairWorks, count",
  },
  repair: {
    label: "Акт о проведении ремонтно-восстановительных работ",
    tags: "actNumber, date, approveBlock, remains, responsiblePost, responsibleName, chiefPost, chiefName; списки {#tecToRepair}: name, inventoryNum, location; {#repair}: repairWorks, name, nomenclature, count",
  },
  parts_memo: {
    label: "Служебная записка на запасные части",
    tags: "date, orgName, bossPostD, bossFIOD, chiefPost, chiefName; списки {#tecToRepair}: name, inventoryNum, location; {#parts}: name, nomenclature, count",
  },
  writeoff: {
    label: "Акт технического состояния (списание оборудования)",
    tags: "actNumber, date, approveBlock, tecName, tecInventory, tecDate, tecDefect, chairPost, chairName, membersLine, responsiblePost, responsibleName, chiefPost, chiefName; список {#members}: post, name",
  },
  cartridges: {
    label: "Ведомость на списание картриджей",
    tags: "month, year, total, approveBlock, responsiblePost, responsibleName, chiefPost, chiefName; список {#repairCartridges}: num, nomenclature, name, count, location",
  },
};

const ACCESS_TYPES = {
  register: { label: "Заявка на регистрацию нового сотрудника", short: "Регистрация" },
  edit: { label: "Заявка на редактирование учетной записи сотрудника", short: "Изменение учётки" },
  restore: { label: "Заявка на восстановление доступа заблокированного сотрудника", short: "Восстановление доступа" },
  block: { label: "Заявка на блокировку сотрудника", short: "Блокировка" },
  delete: { label: "Заявка на удаление сотрудника", short: "Удаление учётки" },
};

// Списки по умолчанию — как было в прежнем «Ассистенте». Правятся в настройках.
const DEFAULT_PROGRAMS = ["АРМ ГС", "АПК РЦ", "ВЕБСБОР", "ПС-НСИ", "СПО НДХ", "СПЭЭО", "СЭД", "ЦСОД"];
const DEFAULT_POSTS = [
  "Начальник отдела", "Заместитель начальника отдела", "Главный специалист - эксперт",
  "Ведущий специалист - эксперт", "Специалист - эксперт", "Главный экономист", "Ведущий экономист",
  "Экономист 1 категории", "Экономист 2 категории", "Старший специалист 1 разряда",
  "Старший специалист 2 разряда", "Старший специалист 3 разряда",
];

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

// ---------------------------------------------------------------------------
//  Настройки
// ---------------------------------------------------------------------------

function getJson(db, key, fallback) {
  const raw = getSetting(db, key);
  if (raw === null || raw === "") return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
const setJson = (db, key, value) => setSetting(db, key, JSON.stringify(value));

function settings(db) {
  return {
    orgName: getSetting(db, "asst_org_name") || "Липецкстат",
    accessDept: getSetting(db, "asst_access_dept") || "",
    programs: getJson(db, "asst_programs", DEFAULT_PROGRAMS),
    posts: getJson(db, "asst_posts", DEFAULT_POSTS),
  };
}

// ---------------------------------------------------------------------------
//  Люди и даты
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");
/** Сегодня по местному времени сервера, YYYY-MM-DD. */
function today(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
/** YYYY-MM-DD -> ДД.ММ.ГГГГ; всё остальное — как есть. */
function ruDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || "");
}
const isIsoDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + "T00:00:00"));

/** «Иванов Иван Иванович» -> «Иванов И.И.» */
function shortName(full) {
  const [last, ...rest] = String(full || "").trim().split(/\s+/);
  if (!last) return "";
  return `${last} ${rest.filter(Boolean).map((w) => w[0].toUpperCase() + ".").join("")}`.trim();
}

function people(db, role) {
  return db.prepare("SELECT * FROM asst_people WHERE role = ? ORDER BY sort, id").all(role);
}
const person = (db, role) => people(db, role)[0] || null;
const dept = (db, name) => db.prepare("SELECT * FROM asst_depts WHERE name = ?").get(name) || null;

/**
 * Поля, общие для всех документов: организация, руководитель в шапке «кому»,
 * заместитель, начальник ОИРиТ и блок «УТВЕРЖДАЮ» для актов.
 */
function commonFields(db, now = new Date()) {
  const boss = person(db, "boss") || {};
  const deputy = person(db, "deputy") || {};
  const chief = person(db, "it_chief") || {};
  const { orgName } = settings(db);
  return {
    orgName,
    date: ruDate(today(now)),
    bossPostD: boss.post_dat || boss.post || "",
    bossFIOD: boss.name_dat || boss.name || "",
    bossZamPost: deputy.post || "",
    bossZamFIO: deputy.name || "",
    chiefPost: chief.post || "",
    chiefName: chief.name || "",
    approveBlock: boss.name
      ? `УТВЕРЖДАЮ\n${boss.post || "Руководитель"} ${orgName}\n____________ ${boss.name}\n«___» ____________ ${now.getFullYear()} г.`
      : "",
  };
}

/** Составитель акта: из справочника «составители» по id или первый. */
function responsible(db, id) {
  const r = (id && db.prepare("SELECT * FROM asst_people WHERE id = ? AND role = 'responsible'").get(id))
    || person(db, "responsible") || {};
  return { responsiblePost: r.post || "", responsibleName: r.name || "" };
}

// ---------------------------------------------------------------------------
//  Шаблоны и нумерация
// ---------------------------------------------------------------------------

/** Действующий шаблон: загруженный администратором или встроенный. */
function templateOf(db, kind) {
  const row = db.prepare("SELECT data FROM asst_templates WHERE kind = ?").get(kind);
  return row ? Buffer.from(row.data) : defaultTemplate(kind);
}

function renderDoc(db, kind, data) {
  return fillDocx(templateOf(db, kind), data);
}

/** Следующий номер в году: реестр актов и заявок на передачу — свои. */
function nextNumber(db, table, year) {
  const row = db.prepare(`SELECT MAX(num) AS n FROM ${table} WHERE year = ?`).get(year);
  const start = table === "asst_acts" ? Number(getSetting(db, `asst_act_start_${year}`)) || 1 : 1;
  return Math.max((row.n || 0) + 1, start);
}

// ---------------------------------------------------------------------------
//  Ответ файлом
// ---------------------------------------------------------------------------

/** Имя файла без запрещённых в Windows знаков. */
const safeFileName = (s) => String(s).replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

function sendFile(res, buf, filename, type = DOCX_TYPE) {
  const name = safeFileName(filename);
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader("Cache-Control", "no-store");
  res.end(buf);
}

// ---------------------------------------------------------------------------
//  Выгрузки из 1С
// ---------------------------------------------------------------------------

// Поля в выгрузке разделены «t###t» — так их пишет обработка в 1С (задумывался
// «\t###\t», но обратные косые черты по дороге потерялись). Принимаем и то,
// и другое, и просто табуляцию — если выгрузку когда-нибудь поправят.
const FIELD_SEP = /\\?t###\\?t|\t###\t|\t/;

function parseExport(text) {
  return String(text).replace(/^﻿/, "").split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .map((line) => line.split(FIELD_SEP).map((f) => f.trim()));
}

const toCount = (s) => {
  const n = Number(String(s || "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n) : null;
};

/** tec.txt: наименование | инвентарный | дата ввода | количество. */
function parseEquipment(text) {
  const rows = parseExport(text).filter((f) => f.length >= 2 && f[0]);
  if (!rows.length) throw new Error("В файле не нашлось ни одной строки с оборудованием — это точно выгрузка tec.txt?");
  return rows.map((f) => ({ name: f[0], inv: f[1] || null, commissioned: f[2] || null, count: toCount(f[3]) ?? 1 }));
}

const CARTRIDGE = /картридж|тонер|драм|фотобарабан|фотопроводник|чернил/i;

/** rep.txt: наименование | местонахождение | номенклатурный номер | количество. */
function parseParts(text) {
  const rows = parseExport(text).filter((f) => f.length >= 3 && f[0]);
  if (!rows.length) throw new Error("В файле не нашлось ни одной строки с запчастями — это точно выгрузка rep.txt?");
  return rows.map((f) => ({
    name: f[0], location: f[1] || null, nomenclature: f[2] || null, count: toCount(f[3]) ?? 0,
    cartridge: CARTRIDGE.test(f[0]) ? 1 : 0,
  }));
}

module.exports = {
  TEMPLATES, ACCESS_TYPES, DEFAULT_PROGRAMS, DEFAULT_POSTS, MONTHS,
  getJson, setJson, settings,
  today, ruDate, isIsoDate, shortName, people, person, dept, commonFields, responsible,
  templateOf, renderDoc, nextNumber, sendFile, safeFileName,
  parseExport, parseEquipment, parseParts, CARTRIDGE,
};
