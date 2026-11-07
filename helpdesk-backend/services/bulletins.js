const { readSheets } = require("./xlsx");
const { readXlsSheets, isXls } = require("./xls");
const { fillDocx, listTags, checkTemplate } = require("./docx");
const { parseLogins } = require("./executorGroups");

// ============================================================================
//  Бюллетени: таблица из ЦСОД + шаблон Word → готовый документ
//
//  Форма бюллетеня — шаблон Word и правила: из каких столбцов таблицы брать
//  наименование, код и значения, какие строки выводить в таблицу документа.
//  Значения можно брать и с других листов той же книги («3!U»), и из последнего
//  заполненного столбца («3!*») — так устроены выгрузки, где каждый месяц
//  добавляет справа новый столбец. Строки разных листов сопоставляются по коду,
//  а если столбца кода нет — по наименованию.
//
//  Месяц и год берутся из заголовка таблицы («…за сентябрь 2026 года»), а у
//  формы с последним заполненным столбцом — из его шапки («2026 год» / «август»).
//  От них зависят заголовок, текст и шапка таблицы документа, со склонением.
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
//  Доступ — по группам бюллетеней (Настройки → Бюллетени): у группы свой
//  набор форм. Правят формы только администраторы платформы.
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

/** Все листы .xlsx или .xls — [{ name, rows }]; формат — по содержимому файла, а не по расширению. */
function readBook(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) fail("Файл таблицы пустой");
  if (isXls(buf)) return readXlsSheets(buf);
  if (buf[0] === 0x50 && buf[1] === 0x4b) return readSheets(buf);
  fail("Это не таблица Excel (.xlsx или .xls). Если её выгрузили из ЦСОД, откройте файл в Excel и сохраните заново");
}

/** Первый лист. */
const readTable = (buf) => readBook(buf)[0].rows;

const squash = (s) => String(s ?? "").split(/\s+/).filter(Boolean).join(" ");
const headerText = (rows, depth = 10) => rows.slice(0, depth).map((r) => (r || []).map(squash).filter(Boolean).join(" ")).join(" ");

/** Месяц (1–12) и год из заголовка таблицы; null — не нашлись. */
function parsePeriod(rows) {
  const m = PERIOD_RE.exec(headerText(rows).toLowerCase());
  return m ? { month: MONTHS.findIndex((x) => x[0] === m[1]) + 1, year: Number(m[2]) } : null;
}

const MONTH_WORD_RE = new RegExp(MONTHS.map((m) => m[0]).join("|"), "g");
const YEAR_RE = /(?:^|\D)((?:19|20)\d{2})(?!\d)/;

/**
 * Месяц и год из шапки столбца: месяц — последний названный в его ячейках выше
 * данных («август», «январь-август»), год — ближайший слева в той же строке:
 * «2026 год» над месяцами стоит в объединённой ячейке, а текст объединённой
 * ячейки хранится только в первой из них.
 */
function periodFromColumn(rows, col) {
  let month = null, year = null;
  for (const row of rows) {
    const r = row || [];
    if (toNumber(r[col]) !== null) break; // начались данные
    const words = squash(r[col]).toLowerCase().match(MONTH_WORD_RE);
    if (words && !month) month = MONTHS.findIndex((m) => m[0] === words[words.length - 1]) + 1;
    for (let c = col; c >= 0 && !year; c--) {
      const y = YEAR_RE.exec(String(r[c] ?? ""));
      if (y) year = Number(y[1]);
    }
  }
  return month && year ? { month, year } : null;
}

/** «C» -> 2. */
function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const LAST = "*";

/** «3!*» -> { sheet: "3", col: "*" }; «C» -> { sheet: null, col: "C" }. */
function parseCol(spec) {
  const i = spec.lastIndexOf("!");
  return i < 0 ? { sheet: null, col: spec } : { sheet: spec.slice(0, i), col: spec.slice(i + 1) };
}

function findSheet(book, name) {
  const sheet = book.find((sh) => squash(sh.name).toLowerCase() === squash(name).toLowerCase());
  return sheet || fail(`В таблице нет листа «${name}»`);
}

/** Лист, по строкам которого идёт таблица документа: лист первого столбца значений, иначе первый. */
function mainSheet(book, s) {
  const first = parseCol(s.valueCols[0]);
  return first.sheet === null ? book[0] : findSheet(book, first.sheet);
}

/** Последний столбец листа, где есть хоть одно число. */
function lastFilledCol(sheet) {
  let last = -1;
  for (const row of sheet.rows) (row || []).forEach((v, c) => { if (c > last && toNumber(v) !== null) last = c; });
  return last >= 0 ? last : fail(`На листе «${sheet.name}» нет ни одного числа`);
}

const same = (a, b) => squash(a).toLowerCase() === squash(b).toLowerCase();

/**
 * Строки таблицы: { key, code, name, values }. Ключ — код, а без столбца кода —
 * наименование; по нему же находятся значения на других листах. Строки без
 * единого значения (шапка, сноски) пропускаются. Диапазон «с … по» — по ключу
 * или наименованию: с первой строки включительно до второй, не включая её.
 */
function dataRows(book, s) {
  const main = mainSheet(book, s);
  const nameCol = colIndex(s.nameCol);
  const codeCol = s.codeCol ? colIndex(s.codeCol) : null;
  const keyOf = (r) => squash(codeCol === null ? r[nameCol] : r[codeCol]);
  const sources = s.valueCols.map(parseCol).map((c) => {
    const sheet = c.sheet === null ? main : findSheet(book, c.sheet);
    const col = c.col === LAST ? lastFilledCol(sheet) : colIndex(c.col);
    let byKey = null;
    if (sheet !== main) {
      byKey = new Map();
      for (const row of sheet.rows) {
        const k = keyOf(row || []);
        if (k && !byKey.has(k)) byKey.set(k, row);
      }
    }
    return { sheet, col, byKey };
  });

  const out = [];
  let inRange = !s.rangeFrom;
  for (const row of main.rows) {
    const r = row || [];
    const key = keyOf(r);
    if (!key) continue;
    const name = squash(r[nameCol]);
    if (!inRange && (same(key, s.rangeFrom) || same(name, s.rangeFrom))) inRange = true;
    else if (inRange && s.rangeTo && (same(key, s.rangeTo) || same(name, s.rangeTo))) break;
    if (!inRange) continue;
    const values = sources.map((src) => {
      const from = src.byKey ? src.byKey.get(key) : r;
      return from ? (from[src.col] ?? "") : "";
    });
    if (values.every((v) => !squash(v))) continue;
    out.push({ key, code: codeCol === null ? "" : key, name, values });
  }
  return out;
}

/** Месяц и год: у формы с последним заполненным столбцом — из его шапки, иначе из заголовка листа. */
function findPeriod(book, s) {
  const last = s.valueCols.map(parseCol).find((c) => c.col === LAST);
  if (last) {
    const sheet = last.sheet === null ? mainSheet(book, s) : findSheet(book, last.sheet);
    const p = periodFromColumn(sheet.rows, lastFilledCol(sheet));
    if (p) return p;
  }
  return parsePeriod(mainSheet(book, s).rows);
}

/**
 * Маска кодов — без регулярных выражений: их пишет не программист, а
 * регулярное выражение с вложенными повторами повесило бы процесс.
 *   #  — цифра, @ — латинская буква, * — что угодно, остальное — как есть;
 *   несколько масок — через запятую: «10, 11, 12», «##.#», «@».
 */
function maskToRegExp(mask) {
  const parts = String(mask).split(",").map(squash).filter(Boolean);
  const one = (p) => [...p].map((ch) => (ch === "#" ? "\\d" : ch === "@" ? "[A-Z]" : ch === "*" ? ".*" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^(?:${parts.map(one).join("|")})$`);
}

/**
 * Строки для списка {#строки}: в порядке таблицы, каждая — по первому
 * подходящему правилу. Маска сверяется с кодом, а без столбца кода — с
 * наименованием («*федеральный округ»). Раздел — последняя строка выше с кодом
 * из одной латинской буквы (так устроены ОКВЭД и ОКПД2).
 */
function selectRows(data, rules) {
  const compiled = rules.map((r) => ({ ...r, re: maskToRegExp(r.codes) }));
  const out = [];
  let section = null;
  for (const row of data) {
    if (/^[A-Z]$/.test(row.code)) section = row.code;
    const rule = compiled.find((r) => r.re.test(row.key) && (!r.sections.length || r.sections.includes(section)));
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

/** Данные для шаблона из прочитанной книги. */
function buildData(book, s, date) {
  const period = findPeriod(book, s);
  const data = period ? periodData(period, date) : {};
  const all = dataRows(book, s);
  for (const row of all) {
    if (!row.code) continue;
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
  const { data, period } = buildData(readBook(table), settings, date);
  const problems = [];
  const missing = new Set();
  let needsPeriod = false;
  for (const tag of listTags(template)) {
    const kind = tagKind(tag, settings);
    const name = tag.replace(/^[#^]/, "");
    if (!kind) problems.push(`в шаблоне неизвестная метка {${tag}}`);
    else if (kind === "period") needsPeriod = true;
    else if (kind === "code" && !(name.split(".")[0] in data)) missing.add(name.split(".")[0].replace(/_/g, "."));
  }
  if (missing.size) problems.unshift(`в таблице нет ${missing.size > 1 ? "строк с кодами" : "строки с кодом"} ${[...missing].join(", ")}`);
  if (needsPeriod && !period) {
    problems.unshift("не нашлись месяц и год — ни в заголовке таблицы («…за сентябрь 2026 года»), ни в шапке последнего заполненного столбца");
  }
  // Чаще всего причина одна: таблица от другого бюллетеня — об этом и говорим первым.
  if (problems.length) fail(`Документ не собран — проверьте, что выбран нужный бюллетень и таблица к нему: ${problems.join("; ")}.`);
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

// ---------------------------------------------------------------------------
//  Правила формы
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  fileName: "{название}_{ММ}_{ГГГГ}", nameCol: "A", codeCol: "B", valueCols: ["C", "D", "E"],
  rangeFrom: "", rangeTo: "", rules: [], timesFrom: 200, digits: 1,
};

const COL_RE = /^[A-Z]{1,2}$/;
const SHEET_RE = /^[^[\]:*?/\\]{1,31}$/;
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
    fileName: text(s.fileName, "Имя файла", 100) || DEFAULT_SETTINGS.fileName,
    nameCol: col(s.nameCol ?? DEFAULT_SETTINGS.nameCol, "Столбец наименования"),
    // Пусто — столбца кода нет: строки листов сопоставляются по наименованию.
    codeCol: s.codeCol === "" ? "" : col(s.codeCol ?? DEFAULT_SETTINGS.codeCol, "Столбец кода"),
    rangeFrom: text(s.rangeFrom, "Строки с", 200),
    rangeTo: text(s.rangeTo, "Строки до", 200),
  };
  const values = Array.isArray(s.valueCols) ? s.valueCols : fail("Столбцы значений — списком");
  if (!values.length || values.length > 20) fail("Столбцов значений — от 1 до 20");
  out.valueCols = values.map((v) => {
    const { sheet, col: c } = parseCol(text(v, "Столбец значения", 40));
    const letter = c.trim().toUpperCase();
    if (letter !== LAST && !COL_RE.test(letter)) fail("Столбец значения — буква столбца (C) или * — последний заполненный; с другого листа — «лист!столбец»: 3!C, 3!*");
    if (sheet === null) return letter;
    if (!SHEET_RE.test(sheet.trim())) fail(`Имя листа «${sheet}» — до 31 знака, без [ ] : * ? / \\`);
    return `${sheet.trim()}!${letter}`;
  });

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
 * Какие формы человек видит. Администратор платформы — все (и только он их
 * правит); остальные — формы своих групп.
 */
function access(db, user) {
  if (user.is_admin) return { admin: true, groups: [], formIds: db.prepare("SELECT id FROM bulletin_forms").all().map((r) => r.id) };
  const groups = userGroups(db, user.id);
  const linked = db.prepare("SELECT form_id FROM bulletin_group_forms WHERE group_id = ?");
  const formIds = new Set();
  for (const g of groups) for (const { form_id } of linked.all(g.id)) formIds.add(form_id);
  return { admin: false, groups: groups.map((g) => ({ id: g.id, name: g.name })), formIds: [...formIds] };
}

// ---------------------------------------------------------------------------
//  Встроенные формы
// ---------------------------------------------------------------------------

// Каждая заводится в базе один раз — при первом запуске версии, где она
// появилась. Дальше это обычная форма: её правят и удаляют из панели, и
// обновление её не возвращает. Какие уже заводились — в настройке
// bulletins_seeded (список названий; «1» — от первой версии, где была только 350).
const BUILTIN_FORMS = [
  {
    name: "350 Индексы производства",
    file: "350.docx",
    settings: {
      fileName: "350_{ММ}_{ГГГГ}",
      nameCol: "A", codeCol: "B", valueCols: ["C", "D", "E"],
      rules: [
        { kind: "раздел", codes: "@", sections: [], sentenceCase: true },
        { kind: "вид", codes: "##", sections: ["C"], sentenceCase: false },
      ],
      timesFrom: 200, digits: 1,
    },
  },
  {
    // Значения — с трёх листов выгрузки «по субъектам», из последнего заполненного
    // столбца: лист 1 — к месяцу прошлого года, 3 — к предыдущему месяцу,
    // 2 — к периоду прошлого года. Строки — РФ и Центральный округ с его регионами.
    name: "352 Индексы производства по субъектам ЦФО",
    file: "352.docx",
    settings: {
      fileName: "352_{ММ}_{ГГГГ}",
      nameCol: "A", codeCol: "", valueCols: ["1!*", "3!*", "2!*"],
      rangeFrom: "Российская Федерация", rangeTo: "Северо-Западный федеральный округ",
      rules: [
        { kind: "итог", codes: "Российская Федерация, *федеральный округ", sections: [], sentenceCase: false },
        { kind: "регион", codes: "*", sections: [], sentenceCase: false },
      ],
      timesFrom: 200, digits: 1,
    },
  },
];

function seedBuiltinForms(db) {
  const { getSetting, setSetting } = require("./settings");
  const raw = getSetting(db, "bulletins_seeded");
  let seeded = [];
  if (raw === "1") seeded = [BUILTIN_FORMS[0].name];
  else if (raw) { try { seeded = JSON.parse(raw); } catch { seeded = BUILTIN_FORMS.map((f) => f.name); } }
  const todo = BUILTIN_FORMS.filter((f) => !seeded.includes(f.name));
  if (!todo.length) return;
  const fs = require("fs");
  const path = require("path");
  const insert = db.prepare("INSERT OR IGNORE INTO bulletin_forms (name, settings, filename, template, updated_by) VALUES (?, ?, ?, ?, 'встроенная')");
  for (const f of todo) {
    insert.run(f.name, JSON.stringify(normalizeSettings(f.settings)), f.file, fs.readFileSync(path.join(__dirname, "..", "bulletins", f.file)));
  }
  setSetting(db, "bulletins_seeded", JSON.stringify([...seeded, ...todo.map((f) => f.name)]));
}

module.exports = {
  BulletinError, MONTHS, LIST, PERIOD_TAGS, DEFAULT_SETTINGS,
  readBook, readTable, parsePeriod, periodFromColumn, maskToRegExp, selectRows, fmtValue, periodData, buildData,
  makeDocument, outputName, checkFormTemplate, unknownTags,
  normalizeSettings, parseSettings, userGroups, access, lines, seedBuiltinForms,
};
