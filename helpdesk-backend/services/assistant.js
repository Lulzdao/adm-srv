const { getSetting, setSetting } = require("./settings");
const { defaultTemplate } = require("./docxDefaults");
const { fillDocx, DOCX_TYPE } = require("./docx");

// ============================================================================
//  Ассистент: общее для его разделов
//
//  Справочники, шаблоны документов, нумерация актов. Сами
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
    // Отдел ИТ из справочника отделов: его начальнику адресована записка на доступ.
    itDept: getSetting(db, "asst_it_dept") || "",
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

// Должность начальника отдела у всех одна — в справочник её не вписывают.
const CHIEF = { post: "Начальник", gen: "начальника", dat: "начальнику" };

/**
 * Название отдела в родительном падеже — «прошу передать начальнику отдела …».
 * Названия устроены однотипно, поэтому склоняем сами, а не просим вписывать:
 *   «Отдел статистики цен»      -> «отдела статистики цен»
 *   «Административный отдел»    -> «административного отдела»
 *   «Общий отдел»               -> «общего отдела»
 * Что под правила не попало — остаётся как есть, с маленькой буквы.
 */
function deptGen(name) {
  const s = String(name || "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  let m = /^отдел(\s.*)?$/i.exec(s);
  if (m) return `отдела${m[1] || ""}`;
  m = /^(.*\s)?(\S+?)(ый|ой|ий)\s+отдел(\s.*)?$/i.exec(s);
  if (m) {
    const [, before = "", stem, end, tail = ""] = m;
    const ending = end.toLowerCase() === "ий" && !/[гкх]$/i.test(stem) ? "его" : "ого";
    const adj = `${before}${stem}${ending}`;
    return `${adj[0].toLowerCase()}${adj.slice(1)} отдела${tail}`;
  }
  return s[0].toLowerCase() + s.slice(1);
}

function people(db, role) {
  return db.prepare("SELECT * FROM asst_people WHERE role = ? ORDER BY sort, id").all(role);
}
const person = (db, role) => people(db, role)[0] || null;
const dept = (db, name) => db.prepare("SELECT * FROM asst_depts WHERE name = ?").get(name) || null;

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Начальник отдела ИТ — из справочника отделов: какой отдел — отдел ИТ,
 * выбирается в Администрировании заявок. Ему адресована служебная записка на
 * доступ, он же подписывает акты.
 */
function itChief(db) {
  const name = getSetting(db, "asst_it_dept") || "";
  const d = name ? dept(db, name) : null;
  if (!d) return { dept: "", post: "", postDat: "", name: "", nameDat: "" };
  return {
    dept: d.name,
    post: `${CHIEF.post} ${deptGen(d.name)}`,
    postDat: capitalize(`${CHIEF.dat} ${deptGen(d.name)}`),
    name: d.chief_name || "",
    nameDat: d.chief_name_dat || d.chief_name || "",
  };
}

/**
 * Поля, общие для всех документов: организация, руководитель в шапке «кому»,
 * начальник отдела ИТ и блок «УТВЕРЖДАЮ» для актов.
 */
function commonFields(db, now = new Date()) {
  const boss = person(db, "boss") || {};
  const chief = itChief(db);
  const { orgName } = settings(db);
  return {
    orgName,
    date: ruDate(today(now)),
    bossPostD: boss.post_dat || boss.post || "",
    bossFIOD: boss.name_dat || boss.name || "",
    chiefPost: chief.post,
    chiefName: chief.name,
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

/** Следующий номер акта в году — не меньше первого номера из настроек. */
function nextActNumber(db, year) {
  const row = db.prepare("SELECT MAX(num) AS n FROM asst_acts WHERE year = ?").get(year);
  return Math.max((row.n || 0) + 1, Number(getSetting(db, `asst_act_start_${year}`)) || 1);
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

module.exports = {
  TEMPLATES, ACCESS_TYPES, MONTHS,
  setJson, settings,
  CHIEF, deptGen,
  today, ruDate, isIsoDate, shortName, people, person, dept, itChief, commonFields, responsible,
  templateOf, renderDoc, nextActNumber, sendFile, safeFileName,
};
