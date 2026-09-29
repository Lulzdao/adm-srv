const { readZip, writeZip } = require("./zip");

// ============================================================================
//  Документ Word по шаблону
//
//  Синтаксис меток — тот же, что был в прежнем «Ассистенте» (docxtemplater),
//  чтобы шаблоны, которые у вас уже есть, подошли без переделки:
//
//    {поле}                 — подставить значение;
//    {#список} … {/}        — повторить для каждого элемента списка;
//    {#список} … {/список}  — то же, с явным именем в закрывающей метке;
//    {^список} … {/}        — показать, только если список пуст / значение ложно.
//
//  Если метки списка стоят в одной строке таблицы (или в разных строках одной
//  таблицы), повторяются строки целиком — так устроены все акты: в первой
//  ячейке {#tecToRepair}, в последней {/}. Если в одном абзаце — повторяется
//  кусок абзаца; если в разных абзацах — абзацы.
//
//  Главная сложность — Word режет текст на куски как хочет: метку {name},
//  набранную с исправлением опечатки, он хранит как «{na» + «me}» в двух разных
//  <w:t>. Поэтому перед подстановкой метки, разорванные между кусками одного
//  абзаца, собираются в первый из них. Оформление остального текста при этом
//  не трогается.
// ============================================================================

// Метки после сборки заменяются на символы из области частного использования:
// так их нельзя спутать с фигурными скобками в атрибутах XML (GUID в
// свойствах документа и т.п.), которые метками не являются.
const OPEN = "";
const CLOSE = "";

const PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

const escapeXml = (s) => String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Собрать разорванные метки и превратить их в маркеры.
 *
 * Все <w:t> документа идут одной последовательностью; граница абзаца
 * вставляется в общий текст переводом строки, которого нет ни в одном куске, —
 * метка через абзац не соберётся, и это правильно.
 */
function normalize(xml) {
  const nodes = [];
  const re = /(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)|<\/w:p>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[0] === "</w:p>") nodes.push(null);
    else nodes.push({ start: m.index, end: m.index + m[0].length, open: m[1], text: m[2] });
  }

  // Общий текст и хозяин каждого знака.
  let all = "";
  const owner = [];
  nodes.forEach((n, i) => {
    if (!n) { all += "\n"; owner.push(-1); return; }
    all += n.text;
    for (let k = 0; k < n.text.length; k++) owner.push(i);
  });

  // Метка, разорванная между кусками, целиком переходит к первому куску.
  for (const t of all.matchAll(/\{[^{}\n]*\}/g)) {
    const a = owner[t.index];
    for (let k = t.index; k < t.index + t[0].length; k++) owner[k] = a;
  }

  const texts = nodes.map(() => "");
  for (let k = 0; k < all.length; k++) if (owner[k] >= 0) texts[owner[k]] += all[k];

  // Пересобираем с конца, чтобы смещения ещё не тронутых кусков не поплыли.
  let out = xml;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (!n) continue;
    let text = texts[i];
    let open = n.open;
    if (/\{[^{}]*\}/.test(text)) {
      text = text.replace(/\{\s*([#^/]?)\s*([^{}]*?)\s*\}/g, (_, kind, name) => `${OPEN}${kind}${name}${CLOSE}`);
      // Пробелы по краям подставленного значения иначе Word съест.
      if (!/xml:space=/.test(open)) open = open.replace(/^<w:t/, '<w:t xml:space="preserve"');
    }
    if (text === n.text && open === n.open) continue;
    out = out.slice(0, n.start) + open + text + "</w:t>" + out.slice(n.end);
  }
  return out;
}

function lookup(stack, path) {
  if (path === "." || path === "") return stack[stack.length - 1];
  for (let i = stack.length - 1; i >= 0; i--) {
    let v = stack[i];
    if (v === null || typeof v !== "object") continue;
    const parts = path.split(".");
    if (!(parts[0] in v)) continue;
    for (const p of parts) v = v === null || v === undefined ? undefined : v[p];
    return v;
  }
  return undefined;
}

function valueXml(v) {
  if (v === null || v === undefined || v === false) return "";
  const text = typeof v === "number" ? String(v).replace(".", ",") : String(v);
  // Перевод строки в значении — настоящий перенос строки в Word.
  return escapeXml(text).split(/\r?\n/).join('</w:t><w:br/><w:t xml:space="preserve">');
}

const MARK = new RegExp(`${OPEN}([#^/]?)([^${CLOSE}]*)${CLOSE}`, "g");

function substitute(xml, stack) {
  return xml.replace(MARK, (all, kind, name) => (kind ? "" : valueXml(lookup(stack, name))));
}

// Ближайший слева открывающий тег элемента, который к позиции ещё не закрыт.
function enclosingStart(xml, pos, tag) {
  const re = new RegExp(`<${tag}[ >]|</${tag}>`, "g");
  let depth = 0, found = -1;
  const hits = [];
  let m;
  while ((m = re.exec(xml)) && m.index < pos) hits.push(m);
  for (let i = hits.length - 1; i >= 0; i--) {
    if (hits[i][0].startsWith("</")) depth++;
    else if (depth === 0) { found = hits[i].index; break; } else depth--;
  }
  return found;
}

// Конец (позиция после закрывающего тега) элемента, в котором стоит pos.
function enclosingEnd(xml, pos, tag) {
  const re = new RegExp(`<${tag}[ >]|</${tag}>`, "g");
  re.lastIndex = pos;
  let depth = 0, m;
  while ((m = re.exec(xml))) {
    if (m[0].startsWith("</")) {
      if (depth === 0) return m.index + m[0].length;
      depth--;
    } else depth++;
  }
  return -1;
}

// Абзац, в котором после удаления метки не осталось текста, убираем целиком:
// иначе от каждой метки списка в документе оставалась бы пустая строка.
function dropIfEmpty(unit, markerText) {
  const i = unit.indexOf(markerText);
  const pStart = enclosingStart(unit, i, "w:p");
  const pEnd = enclosingEnd(unit, i, "w:p");
  if (pStart < 0 || pEnd < 0) return unit.replace(markerText, "");
  const para = unit.slice(pStart, pEnd).replace(markerText, "");
  const rest = para.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, "").replace(/<[^>]+>/g, "");
  return unit.slice(0, pStart) + (rest.trim() === "" ? "" : para) + unit.slice(pEnd);
}

function render(xml, stack) {
  const open = new RegExp(`${OPEN}([#^])([^${CLOSE}]*)${CLOSE}`).exec(xml);
  if (!open) return substitute(xml, stack);

  const name = open[2];
  const openStart = open.index;
  const openEnd = open.index + open[0].length;

  // Парная закрывающая метка — с учётом вложенных списков.
  MARK.lastIndex = openEnd;
  let depth = 0, close = null, m;
  while ((m = MARK.exec(xml))) {
    if (m[1] === "#" || m[1] === "^") depth++;
    else if (m[1] === "/") {
      if (depth === 0) { close = m; break; }
      depth--;
    }
  }
  if (!close) throw new Error(`В шаблоне не закрыт список {#${name}} — нет парной метки {/}`);
  if (close[2] && close[2] !== name) throw new Error(`В шаблоне список {#${name}} закрыт чужой меткой {/${close[2]}}`);
  const closeStart = close.index;
  const closeEnd = close.index + close[0].length;
  const openMark = open[0], closeMark = close[0];

  let unitStart, unitEnd, inner;
  const between = xml.slice(openEnd, closeStart);
  const trA = enclosingStart(xml, openStart, "w:tr");
  const trB = trA >= 0 ? enclosingEnd(xml, closeStart, "w:tr") : -1;
  if (trA >= 0 && trB >= 0 && enclosingStart(xml, closeStart, "w:tbl") === enclosingStart(xml, openStart, "w:tbl")) {
    // Строки таблицы.
    unitStart = trA; unitEnd = trB;
    inner = xml.slice(unitStart, unitEnd).replace(openMark, "").replace(closeMark, "");
  } else if (!between.includes("</w:p>")) {
    // Кусок одного абзаца.
    unitStart = openStart; unitEnd = closeEnd;
    inner = between;
  } else {
    // Несколько абзацев.
    unitStart = enclosingStart(xml, openStart, "w:p");
    unitEnd = enclosingEnd(xml, closeStart, "w:p");
    inner = dropIfEmpty(dropIfEmpty(xml.slice(unitStart, unitEnd), openMark), closeMark);
  }

  const value = lookup(stack, name);
  let scopes;
  if (open[1] === "^") scopes = (Array.isArray(value) ? value.length === 0 : !value) ? [null] : [];
  else if (Array.isArray(value)) scopes = value;
  else scopes = value ? [value] : [];

  const repeated = scopes.map((item) =>
    render(inner, item === null || typeof item !== "object" ? stack : [...stack, item])).join("");
  return substitute(xml.slice(0, unitStart), stack) + repeated + render(xml.slice(unitEnd), stack);
}

/**
 * Заполнить шаблон .docx данными. Возвращает готовый файл.
 * Ошибка в самом шаблоне (незакрытый список) — исключение с понятным текстом.
 */
function fillDocx(template, data) {
  let files;
  try { files = readZip(template); } catch { throw new Error("Шаблон не открывается как документ Word (.docx)"); }
  if (!files.has("word/document.xml")) throw new Error("Шаблон не похож на документ Word — в нём нет word/document.xml");
  const out = [];
  for (const [name, buf] of files) {
    if (PARTS.test(name)) out.push([name, render(normalize(buf.toString("utf8")), [data || {}])]);
    else out.push([name, buf]);
  }
  return writeZip(out);
}

/** Какие метки есть в шаблоне — показать администратору после загрузки. */
function listTags(template) {
  const files = readZip(template);
  const tags = new Set();
  for (const [name, buf] of files) {
    if (!PARTS.test(name)) continue;
    for (const m of normalize(buf.toString("utf8")).matchAll(MARK)) {
      if (m[1] === "/") continue;
      tags.add((m[1] || "") + m[2]);
    }
  }
  return [...tags];
}

/** Проверить шаблон, ничего не подставляя: бросит на незакрытом списке. */
function checkTemplate(template) {
  fillDocx(template, {});
  return listTags(template);
}

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

module.exports = { fillDocx, listTags, checkTemplate, DOCX_TYPE, escapeXml };
