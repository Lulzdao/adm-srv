const { readFirstSheet } = require("./xlsx");
const { readXlsFirstSheet, isXls } = require("./xls");
const { fillDocx, listTags, checkTemplate } = require("./docx");
const { parseLogins } = require("./executorGroups");

// ============================================================================
//  Бюллетени: таблица из ЦСОД + шаблон Word → готовый документ
//
//  Форма бюллетеня — шаблон Word и правила: из каких столбцов таблицы брать
//  наименование, код и значения, какие строки выводить в таблицу документа.
//  Месяц и год берутся из заголовка таблицы («…за сентябрь 2026 года») — от них
//  зависят заголовок, текст и шапка таблицы документа, со склонением месяца.
//
//  Метки шаблона — те же, что у Ассистента ({поле}, {#список}…{/}), см.
//  services/docx.js. Что доступно в шаблоне:
//
//    {год} {прошлый_год} {ММ} {дата}           2026, 2025, 09, 01.11.2026
//    {Месяц} {месяц} {МЕСЯЦ}                     Сентябрь, сентябрь, СЕНТЯБРЬ
//    {месяцу} {месяце} {месяцем}                 сентябрю, сентябре, сентябрём
//    {пред_месяц} {пред_месяцу} {год_пред_месяца} август, августу, 2026
//    {Период} {период} {ПЕРИОД} {периоду}        Январь-сентябрь, …, январю-сентябрю
//    {102.1}                                     строка с кодом 102, первое значение
//                                                (точки в коде — подчёркиванием: {07_10.1})
//    {#строки}…{/}                               строки по правилам формы, у каждой
//                                                {наименование} {код} {1} {2} …
//                                                и признак своего вида: {#раздел}…{/}
//
//  Доступ — по группам бюллетеней (Администрирование → Бюллетени): у группы
//  свой набор форм; группе можно дать право править формы.
// ============================================================================

class BulletinError extends Error {}
const fail = (msg) => { throw new BulletinError(msg); };

// именительный, дательный, предложный, творительный
const MONTHS = [
  ["январь", "январю", "январе", "январём"],
  ["февраль", "февралю", "феврале", "февралём"],
  ["март", "марту", "марте", "мартом"],
  ["апрель", "апрелю", "апреле", "апрелем"],
  ["май", "маю", "мае", "маем"],
  ["июнь", "июню", "июне", "июнем"],
  ["июль", "июлю", "июле", "июлем"],
  ["август", "августу", "августе", "августом"],
  ["сентябрь", "сентябрю", "сентябре", "сентябрём"],
  ["октябрь", "октябрю", "октябре", "октябрём"],
  ["ноябрь", "ноябрю", "ноябре", "ноябрём"],
  ["декабрь", "декабрю", "декабре", "декабрём"],
];
const PERIOD_RE = new RegExp(`(${MONTHS.map((m) => m[0]).join("|")})\\s+(\\d{4})`);

const LIST = "строки";
const ROW_FIELDS = ["наименование", "код"];
const PERIOD_TAGS = ["дата", "год", "прошлый_год", "ММ", "Месяц", "месяц", "МЕСЯЦ", "месяцу", "месяце", "месяцем",
  "пред_месяц", "пред_месяцу", "год_пред_месяца", "Период", "период", "ПЕРИОД", "периоду"];

// ---------------------------------------------------------------------------
//  Таблица
// ---------------------------------------------------------------------------

/** Первый лист .xlsx или .xls — по содержимому файла, а не по расширению. */
function readTable(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) fail("Файл таблицы пустой");
  if (isXls(buf)) return readXlsFirstSheet(buf);
  if (buf[0] === 0x50 && buf[1] === 0x4b) return readFirstSheet(buf);
  fail("Это не таблица Excel (.xlsx или .xls). Если её выгрузили из ЦСОД, откройте файл в Excel и сохраните заново");
}

const squash = (s) => String(s ?? "").split(/\s+/).filter(Boolean).join(" ");
const headerText = (rows, depth = 10) => rows.slice(0, depth).map((r) => (r || []).map(squash).filter(Boolean).join(" ")).join(" ");

/** Месяц (1–12) и год из заголовка таблицы; null — не нашлись. */
function parsePeriod(rows) {
  const m = PERIOD_RE.exec(headerText(rows).toLowerCase());
  return m ? { month: MONTHS.findIndex((x) => x[0] === m[1]) + 1, year: Number(m[2]) } : null;
}

/** «C» -> 2. */
function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Строки таблицы с непустым кодом: { code, name, values }. */
function dataRows(rows, s) {
  const nameCol = colIndex(s.nameCol), codeCol = colIndex(s.codeCol);
  const valueCols = s.valueCols.map(colIndex);
  const out = [];
  for (const row of rows) {
    const r = row || [];
    const code = squash(r[codeCol]);
    if (!code) continue;
    out.push({ code, name: squash(r[nameCol]), values: valueCols.map((c) => r[c] ?? "") });
  }
  return out;
}

/**
 * Маска кодов — без регулярных выражений: их пишет не программист, а
 * регулярное выражение с вложенными повторами повесило бы процесс.
 *   #  — цифра, @ — латинская буква, * — что угодно, остальное — как есть;
 *   несколько масок — через запятую: «10, 11, 12», «##.#», «@».
 */
function maskToRegExp(mask) {
  const parts = String(mask).split(",").map((p) => p.trim()).filter(Boolean);
  const one = (p) => [...p].map((ch) => (ch === "#" ? "\\d" : ch === "@" ? "[A-Z]" : ch === "*" ? ".*" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^(?:${parts.map(one).join("|")})$`);
}

/**
 * Строки для списка {#строки}: в порядке таблицы, каждая — по первому
 * подходящему правилу. Раздел — последняя строка выше с кодом из одной
 * латинской буквы (так устроены ОКВЭД и ОКПД2).
 */
function selectRows(data, rules) {
  const compiled = rules.map((r) => ({ ...r, re: maskToRegExp(r.codes) }));
  const out = [];
  let section = null;
  for (const row of data) {
    if (/^[A-Z]$/.test(row.code)) section = row.code;
    const rule = compiled.find((r) => r.re.test(row.code) && (!r.sections.length || r.sections.includes(section)));
    if (rule) out.push({ row, rule });
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Значения
// ---------------------------------------------------------------------------

function toNumber(v) {
  const t = String(v ?? "").replace(/[\s ]/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(t)) return null;
  return Number(t);
}

const fmtNumber = (n, digits) => n.toFixed(digits).replace(".", ",");

/** 103.9 -> «103,9»; от порога и выше — в разах: 463.5 -> «в 4,6 р.». Не число — как есть, пусто — «…». */
function fmtValue(v, { digits, timesFrom }) {
  const n = toNumber(v);
  if (n === null) return squash(v) || "…";
  if (timesFrom && n >= timesFrom) return `в ${fmtNumber(n / 100, digits)} р.`;
  return fmtNumber(n, digits);
}

const sentenceCase = (s) => (s === s.toUpperCase() && s !== s.toLowerCase() ? s[0] + s.slice(1).toLowerCase() : s);

function periodData({ month, year }, date) {
  const [nom, dat, prep, instr] = MONTHS[month - 1];
  const prev = MONTHS[(month + 10) % 12];
  const period = month === 1 ? nom : `январь-${nom}`;
  return {
    дата: date,
    год: String(year), прошлый_год: String(year - 1), ММ: String(month).padStart(2, "0"),
    Месяц: nom[0].toUpperCase() + nom.slice(1), месяц: nom, МЕСЯЦ: nom.toUpperCase(),
    месяцу: dat, месяце: prep, месяцем: instr,
    пред_месяц: prev[0], пред_месяцу: prev[1], год_пред_месяца: String(month === 1 ? year - 1 : year),
    Период: period[0].toUpperCase() + period.slice(1), период: period, ПЕРИОД: period.toUpperCase(),
    периоду: month === 1 ? dat : `январю-${dat}`,
  };
}

const codeKey = (code) => code.replace(/\./g, "_");

function rowData(row, s) {
  const out = { наименование: row.name, код: row.code };
  row.values.forEach((v, i) => { out[String(i + 1)] = fmtValue(v, s); });
  return out;
}

/** Данные для шаблона из прочитанной таблицы. */
function buildData(rows, s, date) {
  const period = parsePeriod(rows);
  const data = period ? periodData(period, date) : {};
  const all = dataRows(rows, s);
  for (const row of all) {
    const key = codeKey(row.code);
    if (!(key in data)) data[key] = rowData(row, s);
  }
  data[LIST] = selectRows(all, s.rules).map(({ row, rule }) => ({
    ...rowData(rule.sentenceCase ? { ...row, name: sentenceCase(row.name) } : row, s),
    [rule.kind]: true,
  }));
  return { data, period };
}

// ---------------------------------------------------------------------------
//  Проверка меток шаблона
// ---------------------------------------------------------------------------

/** Что метка значит при этих правилах: «period», «row», «list», «code» или null — неизвестна. */
function tagKind(tag, s) {
  const name = tag.replace(/^[#^]/, "");
  if (name === LIST) return "list";
  if (PERIOD_TAGS.includes(name)) return "period";
  if (ROW_FIELDS.includes(name) || s.rules.some((r) => r.kind === name)) return "row";
  if (/^\d+$/.test(name) && Number(name) >= 1 && Number(name) <= s.valueCols.length) return "row";
  const m = /^([\p{L}\p{N}_]+)\.(\d+|наименование|код)$/u.exec(name);
  if (m && (!/^\d+$/.test(m[2]) || (Number(m[2]) >= 1 && Number(m[2]) <= s.valueCols.length))) return "code";
  return null;
}

/** Метки шаблона, которых при этих правилах не бывает (опечатка, лишний столбец). */
function unknownTags(template, s) {
  return listTags(template).filter((t) => !tagKind(t, s)).map((t) => `{${t}}`);
}

/**
 * Проверить загружаемый шаблон: открывается, списки закрыты. Возвращает
 * предупреждения — метки, которым при этих правилах нечего подставить.
 */
function checkFormTemplate(template, s) {
  try { checkTemplate(template); } catch (err) { fail(err.message); }
  const unknown = unknownTags(template, s);
  return unknown.length ? [`В шаблоне есть метки, которым нечего подставить: ${unknown.join(", ")}`] : [];
}

// ---------------------------------------------------------------------------
//  Документ
// ---------------------------------------------------------------------------

/**
 * Собрать документ. Метка, которую нечем заполнить, — ошибка, а не пустое
 * место в документе: незаметная дыра в бюллетене хуже понятного отказа.
 */
function makeDocument({ table, template, settings, date }) {
  const rows = readTable(table);
  const { data, period } = buildData(rows, settings, date);
  const problems = [];
  let needsPeriod = false;
  for (const tag of listTags(template)) {
    const kind = tagKind(tag, settings);
    const name = tag.replace(/^[#^]/, "");
    if (!kind) problems.push(`в шаблоне неизвестная метка {${tag}}`);
    else if (kind === "period") needsPeriod = true;
    else if (kind === "code" && !(name.split(".")[0] in data)) {
      problems.push(`в таблице нет строки с кодом ${name.split(".")[0].replace(/_/g, ".")} (метка {${name}})`);
    }
  }
  if (needsPeriod && !period) problems.unshift("в заголовке таблицы не нашлись месяц и год («…за сентябрь 2026 года»)");
  if (problems.length) fail(`Документ не собран: ${problems.join("; ")}.`);
  return { docx: fillDocx(template, data), period, rows: data[LIST].length };
}

/** Имя готового файла по образцу формы: {название}, {ММ}, {ГГГГ}, {месяц}. */
function outputName(form, period) {
  const p = period || { month: new Date().getMonth() + 1, year: new Date().getFullYear() };
  const name = (form.settings.fileName || "{название}_{ММ}_{ГГГГ}")
    .replace(/\{название\}/g, form.name)
    .replace(/\{ММ\}/g, String(p.month).padStart(2, "0"))
    .replace(/\{ГГГГ\}/g, String(p.year))
    .replace(/\{месяц\}/g, MONTHS[p.month - 1][0])
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().slice(0, 120);
  return `${name || "бюллетень"}.docx`;
}

/** Формы, к которым подходит таблица (по признаку в заголовке). */
function matchingForms(table, forms) {
  const head = headerText(readTable(table)).toLowerCase();
  return forms.filter((f) => f.settings.sign && head.includes(squash(f.settings.sign).toLowerCase()));
}

// ---------------------------------------------------------------------------
//  Правила формы
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  sign: "", fileName: "{название}_{ММ}_{ГГГГ}", nameCol: "A", codeCol: "B", valueCols: ["C", "D", "E"],
  rules: [], timesFrom: 200, digits: 1,
};

const COL_RE = /^[A-Z]{1,2}$/;
const KIND_RE = /^[\p{L}_][\p{L}\p{N}_]{0,29}$/u;
const RESERVED = new Set([LIST, ...ROW_FIELDS, ...PERIOD_TAGS]);

/** Проверить и привести правила формы из запроса. Ошибка — BulletinError с понятным текстом. */
function normalizeSettings(input) {
  const s = input && typeof input === "object" ? input : fail("Правила формы — объектом");
  const text = (v, field, max) => {
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") fail(`«${field}» — текстом`);
    if (v.length > max) fail(`«${field}» — не длиннее ${max} знаков`);
    return v.trim();
  };
  const col = (v, field) => {
    const c = text(v, field, 2).toUpperCase();
    if (!COL_RE.test(c)) fail(`«${field}» — буква столбца Excel: A, B, … AZ`);
    return c;
  };
  const out = {
    sign: text(s.sign, "Признак таблицы", 200),
    fileName: text(s.fileName, "Имя файла", 100) || DEFAULT_SETTINGS.fileName,
    nameCol: col(s.nameCol ?? DEFAULT_SETTINGS.nameCol, "Столбец наименования"),
    codeCol: col(s.codeCol ?? DEFAULT_SETTINGS.codeCol, "Столбец кода"),
  };
  const values = Array.isArray(s.valueCols) ? s.valueCols : fail("Столбцы значений — списком");
  if (!values.length || values.length > 20) fail("Столбцов значений — от 1 до 20");
  out.valueCols = values.map((v) => col(v, "Столбец значения"));

  const rules = Array.isArray(s.rules) ? s.rules : fail("Правила строк — списком");
  if (rules.length > 20) fail("Правил строк — не больше 20");
  out.rules = rules.map((r, i) => {
    const n = i + 1;
    if (!r || typeof r !== "object") fail(`Правило ${n} — объектом`);
    const kind = text(r.kind, `Вид строки (правило ${n})`, 30);
    if (!KIND_RE.test(kind)) fail(`Вид строки в правиле ${n} — одно слово: буквы, цифры, подчёркивание`);
    if (RESERVED.has(kind)) fail(`Вид строки «${kind}» совпадает со служебной меткой — выберите другое слово`);
    const codes = text(r.codes, `Коды (правило ${n})`, 200);
    if (!codes) fail(`В правиле ${n} не заданы коды`);
    const sections = (Array.isArray(r.sections) ? r.sections : String(r.sections || "").split(/[\s,;]+/))
      .map((x) => String(x).trim().toUpperCase()).filter(Boolean);
    if (sections.some((x) => !/^[A-Z]$/.test(x))) fail(`Разделы в правиле ${n} — латинские буквы через запятую: B, C`);
    return { kind, codes, sections, sentenceCase: Boolean(r.sentenceCase) };
  });

  const times = Number(s.timesFrom ?? DEFAULT_SETTINGS.timesFrom);
  if (!Number.isFinite(times) || times < 0 || times > 100000) fail("Порог «в разах» — число от 0 (не переводить) и выше");
  out.timesFrom = times;
  const digits = Number(s.digits ?? DEFAULT_SETTINGS.digits);
  if (!Number.isInteger(digits) || digits < 0 || digits > 4) fail("Знаков после запятой — от 0 до 4");
  out.digits = digits;
  return out;
}

function parseSettings(json) {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(json || "{}") }; } catch { return { ...DEFAULT_SETTINGS }; }
}

// ---------------------------------------------------------------------------
//  Группы и права
// ---------------------------------------------------------------------------

const lines = (text) => String(text || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const normGroup = (g) => String(g || "").trim().toLowerCase().replace(/,/g, ";");

/**
 * Группы бюллетеней, в которых состоит сотрудник: по группе домена (запомненной
 * при последнем входе, users.ad_groups) или по логину в списке группы.
 */
function userGroups(db, userId) {
  const u = db.prepare("SELECT ad_login, ad_groups FROM users WHERE id = ?").get(userId);
  if (!u) return [];
  const login = String(u.ad_login || "").toLowerCase();
  const adGroups = String(u.ad_groups || "");
  return db.prepare("SELECT * FROM bulletin_groups ORDER BY name").all().filter((g) =>
    lines(g.ad_groups).some((name) => normGroup(name) && adGroups.includes(`,${normGroup(name)},`))
    || parseLogins(g.logins).includes(login));
}

/**
 * Что можно человеку: какие формы видеть и какими управлять.
 * Администратор платформы может всё; остальные — по своим группам.
 */
function access(db, user) {
  const all = db.prepare("SELECT id FROM bulletin_forms").all().map((r) => r.id);
  if (user.is_admin) return { admin: true, groups: [], formIds: all, manageIds: all, manageGroups: db.prepare("SELECT id, name FROM bulletin_groups ORDER BY name").all() };
  const groups = userGroups(db, user.id);
  const linked = db.prepare("SELECT form_id FROM bulletin_group_forms WHERE group_id = ?");
  const formIds = new Set(), manageIds = new Set();
  for (const g of groups) {
    for (const { form_id } of linked.all(g.id)) {
      formIds.add(form_id);
      if (g.can_manage) manageIds.add(form_id);
    }
  }
  return {
    admin: false,
    groups: groups.map((g) => ({ id: g.id, name: g.name })),
    formIds: [...formIds],
    manageIds: [...manageIds],
    manageGroups: groups.filter((g) => g.can_manage).map((g) => ({ id: g.id, name: g.name })),
  };
}

const canManageAny = (a) => a.admin || a.manageGroups.length > 0;

// ---------------------------------------------------------------------------
//  Встроенные формы
// ---------------------------------------------------------------------------

// Заводятся в базе один раз, при первом запуске с бюллетенями. Дальше это
// обычные формы: их правят и удаляют из панели, обновление их не возвращает.
const BUILTIN_FORMS = [
  {
    name: "350 Индексы производства",
    file: "350.docx",
    settings: {
      sign: "Индексы производства по видам экономической деятельности",
      fileName: "350_{ММ}_{ГГГГ}",
      nameCol: "A", codeCol: "B", valueCols: ["C", "D", "E"],
      rules: [
        { kind: "раздел", codes: "@", sections: [], sentenceCase: true },
        { kind: "вид", codes: "##", sections: ["C"], sentenceCase: false },
      ],
      timesFrom: 200, digits: 1,
    },
  },
];

function seedBuiltinForms(db) {
  const { getSetting, setSetting } = require("./settings");
  if (getSetting(db, "bulletins_seeded")) return;
  const fs = require("fs");
  const path = require("path");
  const insert = db.prepare("INSERT OR IGNORE INTO bulletin_forms (name, settings, filename, template, updated_by) VALUES (?, ?, ?, ?, 'встроенная')");
  for (const f of BUILTIN_FORMS) {
    insert.run(f.name, JSON.stringify(normalizeSettings(f.settings)), f.file, fs.readFileSync(path.join(__dirname, "..", "bulletins", f.file)));
  }
  setSetting(db, "bulletins_seeded", "1");
}

module.exports = {
  BulletinError, MONTHS, LIST, PERIOD_TAGS, DEFAULT_SETTINGS,
  readTable, parsePeriod, maskToRegExp, selectRows, fmtValue, periodData, buildData,
  makeDocument, outputName, matchingForms, checkFormTemplate, unknownTags,
  normalizeSettings, parseSettings, userGroups, access, canManageAny, lines, seedBuiltinForms,
};
