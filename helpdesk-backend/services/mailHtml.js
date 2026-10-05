// ============================================================================
//  Оформленный текст рассылки: очистка HTML, текстовая версия, подстановки
//
//  Текст письма набирают в редакторе с кнопками (жирный, курсив, шрифт,
//  размер, цвет…), и в браузере это HTML. В письмо он уходит только после
//  очистки по белому списку: теги оформления — да, всё остальное (скрипты,
//  формы, картинки по ссылке, классы и мусор из Word) — нет. Пакетов для
//  этого не тянем: нужен узкий набор, и проверить его проще, чем чужую
//  библиотеку.
// ============================================================================

// Теги, которые остаются. Значение — разрешённые атрибуты (кроме style).
const TAGS = {
  p: [], div: [], br: [], span: [], b: [], strong: [], i: [], em: [], u: [], s: [], strike: [],
  // ul[data-checklist] / li[data-checked] — список с галочками в заметках.
  sub: [], sup: [], ul: ["data-checklist"], ol: [], li: ["data-checked"], blockquote: [], h1: [], h2: [], h3: [], hr: [],
  a: ["href"], font: ["face", "size", "color"],
};
const VOID = new Set(["br", "hr"]);
// Содержимое этих тегов выбрасывается целиком, а не только сами теги.
const DROP_WITH_CONTENT = new Set(["script", "style", "head", "title", "iframe", "object", "embed", "noscript", "template", "svg", "math", "xml"]);

// Свойства style и допустимые значения. Ничего, что может сходить по ссылке
// (url(...)) или выполнить код (expression, javascript:).
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.\s,%]+\)|[a-z]{3,20})$/i;
const STYLE = {
  "font-weight": /^(bold|bolder|normal|[1-9]00)$/i,
  "font-style": /^(italic|normal|oblique)$/i,
  "text-decoration": /^[a-z\s-]{1,40}$/i,
  "text-decoration-line": /^[a-z\s-]{1,40}$/i,
  "font-size": /^(\d{1,2}(\.\d+)?(px|pt|em|rem|%)|x{0,3}-?(small|large)|medium|smaller|larger)$/i,
  "font-family": /^[\w\s"',.-]{1,120}$/i,
  "color": COLOR,
  "background-color": COLOR,
  "text-align": /^(left|right|center|justify)$/i,
  "margin-left": /^\d{1,3}(px|em)$/i,
  "padding-left": /^\d{1,3}(px|em)$/i,
};

const escapeHtml = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Значение атрибута из разметки — с раскодированными сущностями. */
function decode(s) {
  return String(s)
    .replace(/&#(\d+);?/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function cleanStyle(raw) {
  const out = [];
  for (const decl of decode(raw).split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim().replace(/\s*!important$/i, "");
    if (STYLE[prop] && STYLE[prop].test(value) && !/url\s*\(|expression|javascript:|[<>\\]/i.test(value)) out.push(`${prop}: ${value}`);
  }
  return out.join("; ");
}

function cleanAttr(tag, name, value) {
  const v = decode(value).trim();
  if (tag === "a" && name === "href") return /^(https?:|mailto:)/i.test(v) ? v : null;
  if (tag === "font" && name === "size") return /^[1-7]$/.test(v) ? v : null;
  if (tag === "font" && name === "color") return COLOR.test(v) ? v : null;
  if (tag === "font" && name === "face") return /^[\w\s"',.-]{1,120}$/.test(v) ? v : null;
  // Флажки списка с галочками: только «1», иначе атрибута нет.
  if ((tag === "ul" && name === "data-checklist") || (tag === "li" && name === "data-checked")) return v === "1" ? "1" : null;
  return null;
}

const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * HTML из редактора -> безопасный HTML для письма. Неизвестные теги
 * убираются, их текст остаётся; закрывающие теги без открывающих
 * отбрасываются, незакрытые — закрываются в конце.
 */
function sanitizeHtml(html) {
  const src = String(html || "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const out = [];
  const stack = [];
  let dropDepth = 0;
  let dropTag = null;
  // Тег — только «<» вплотную к имени: «a < b» — это текст, а не тег «b».
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)([^>]*)>|<[!?][^>]*>|([^<]+)|</g;
  let m;
  while ((m = re.exec(src))) {
    const [all, closing, rawName, rawAttrs, text] = m;
    if (text !== undefined || all === "<") {
      if (dropDepth) continue;
      // Текст уже экранирован браузером; одиночные «<» и «>» экранируем сами.
      out.push((text ?? "&lt;").replace(/>/g, "&gt;").replace(/&(?![a-z]+;|#\d+;|#x[0-9a-f]+;)/gi, "&amp;"));
      continue;
    }
    if (!rawName) continue;   // <!DOCTYPE>, <?xml?> и т.п.
    const name = rawName.toLowerCase();
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing && !/\/\s*$/.test(rawAttrs)) { if (!dropDepth) dropTag = name; if (dropTag === name) dropDepth++; }
      else if (closing && dropTag === name && dropDepth) { dropDepth--; if (!dropDepth) dropTag = null; }
      continue;
    }
    if (dropDepth || !TAGS[name]) continue;
    if (closing) {
      const at = stack.lastIndexOf(name);
      if (at < 0) continue;
      while (stack.length > at) out.push(`</${stack.pop()}>`);
      continue;
    }
    const attrs = [];
    let am;
    ATTR_RE.lastIndex = 0;
    while ((am = ATTR_RE.exec(rawAttrs))) {
      const attr = am[1].toLowerCase();
      const value = am[2] ?? am[3] ?? am[4] ?? "";
      if (attr === "style") {
        const st = cleanStyle(value);
        if (st) attrs.push(`style="${escapeHtml(st)}"`);
      } else if (TAGS[name].includes(attr)) {
        const v = cleanAttr(name, attr, value);
        if (v !== null) attrs.push(`${attr}="${escapeHtml(v)}"`);
      }
    }
    if (name === "a") attrs.push('target="_blank"', 'rel="noopener"');
    out.push(`<${name}${attrs.length ? " " + attrs.join(" ") : ""}>`);
    if (!VOID.has(name)) stack.push(name);
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join("");
}

/** Текстовая версия письма — для почтовых программ, которые HTML не показывают. */
function htmlToText(html) {
  return decode(String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*data-checked="1"[^>]*>/gi, "☑ ")
    .replace(/<ul[^>]*data-checklist[^>]*>([\s\S]*?)<\/ul>/gi, (all, inner) => `<ul>${inner.replace(/<li(?![^>]*data-checked)[^>]*>/gi, "☐ ")}</ul>`)
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<(ul|ol)[^>]*>/gi, "\n")
    // Абзац — с пустой строкой после, строка редактора (div) и пункт списка — без.
    .replace(/<\/(p|h[1-6]|blockquote)>/gi, "\n\n")
    .replace(/<\/(div|li|ul|ol)>/gi, "\n")
    .replace(/<hr[^>]*>/gi, "\n———\n")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (all, href, label) => (label.replace(/<[^>]*>/g, "").trim() === decode(href) ? label : `${label} (${href})`))
    .replace(/<[^>]*>/g, ""))
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Подстановка {Колонка} в HTML: значения экранируются, разметку из таблицы не вставить. */
const norm = (s) => String(s).trim().toLowerCase().replace(/ё/g, "е");
function fillHtml(html, fields) {
  const map = new Map(Object.entries(fields || {}).map(([k, v]) => [norm(k), v]));
  return String(html).replace(/\{([^{}<>\n]{1,60})\}/g, (all, key) => (map.has(norm(decode(key))) ? escapeHtml(map.get(norm(decode(key))) ?? "") : all));
}

module.exports = { sanitizeHtml, htmlToText, fillHtml, escapeHtml };
