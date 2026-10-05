'use strict';

const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeHtml, htmlToText, fillHtml } = require("../services/mailHtml");

// ============================================================================
//  Очистка оформленного текста рассылки (services/mailHtml.js)
//
//  HTML приходит из редактора в браузере, то есть от пользователя, а уходит
//  сотням получателей. Пропустить можно только оформление.
// ============================================================================

test("оформление остаётся: жирный, курсив, подчёркнутый, шрифт, размер, цвет, выравнивание, списки", () => {
  const html = `<p style="text-align: center"><b>Ж</b><i>К</i><u>Ч</u><s>З</s></p>`
    + `<span style="font-size: 24px; font-family: Georgia; color: #c00000; background-color: rgb(255, 255, 0)">т</span>`
    + `<font face="Times New Roman" size="5" color="#00f">ф</font><ul><li>раз</li></ul><ol><li>два</li></ol>`;
  assert.equal(sanitizeHtml(html), html.replace("#c00000; background-color", "#c00000; background-color"));
});

test("опасное вырезается: скрипты, обработчики, картинки и стили по ссылке, javascript:-ссылки, формы", () => {
  const cases = [
    [`<script>alert(1)</script>ок`, "ок"],
    [`<SCRIPT >alert(1)</SCRIPT >ок`, "ок"],
    [`<img src=x onerror=alert(1)>ок`, "ок"],
    [`<b onmouseover="alert(1)">ок</b>`, "<b>ок</b>"],
    [`<a href="javascript:alert(1)">ок</a>`, `<a target="_blank" rel="noopener">ок</a>`],
    [`<a href="  JaVaScRiPt:alert(1)">ок</a>`, `<a target="_blank" rel="noopener">ок</a>`],
    [`<a href="&#106;avascript:alert(1)">ок</a>`, `<a target="_blank" rel="noopener">ок</a>`],
    [`<div style="background: url(http://x/t.png)">ок</div>`, "<div>ок</div>"],
    [`<span style="color: expression(alert(1))">ок</span>`, "<span>ок</span>"],
    [`<iframe src="https://x"></iframe><form><input></form>ок`, "ок"],
    [`<style>body{display:none}</style>ок`, "ок"],
    [`<svg><script>alert(1)</script></svg>ок`, "ок"],
    [`<!-- <script>alert(1)</script> -->ок`, "ок"],
    [`<p class="MsoNormal" style="mso-fareast-font-family: Calibri">Word<o:p></o:p></p>`, "<p>Word</p>"],
  ];
  for (const [input, want] of cases) assert.equal(sanitizeHtml(input), want, input);
});

test("кривая разметка чинится: незакрытые теги закрываются, лишние закрывающие отбрасываются, «<» в тексте — текст", () => {
  assert.equal(sanitizeHtml("<b>жирный <i>курсив</b> дальше"), "<b>жирный <i>курсив</i></b> дальше");
  assert.equal(sanitizeHtml("</i>текст</b>"), "текст");
  assert.equal(sanitizeHtml("a < b & c > d"), "a &lt; b &amp; c &gt; d");
});

test("текстовая версия: абзацы, строки, списки, ссылки с адресом", () => {
  assert.equal(htmlToText(`<p>Здравствуйте!</p><div>Строка</div><div>Ещё</div><ul><li>раз</li><li>два</li></ul><a href="https://example.invalid/">сайт</a>&nbsp;и&amp;`),
    "Здравствуйте!\n\nСтрока\nЕщё\n\n• раз\n• два\n\nсайт (https://example.invalid/) и&");
});

test("подстановки в HTML: значения экранируются, неизвестные остаются как есть", () => {
  assert.equal(fillHtml("<b>{наименование}</b> {ОКПО} {нет}", { Наименование: `<i>"ООО"</i>`, ОКПО: "1" }),
    "<b>&lt;i&gt;&quot;ООО&quot;&lt;/i&gt;</b> 1 {нет}");
});

test("список с галочками (заметки): флажки сохраняются только как «1», в тексте — ☑/☐", () => {
  const html = sanitizeHtml(`<ul data-checklist="1" onclick="x()"><li data-checked="1">купить</li><li data-checked="0">позвонить</li><li data-checked="javascript:x">ещё</li></ul><ul data-checklist="yes"><li>обычный</li></ul>`);
  assert.equal(html, `<ul data-checklist="1"><li data-checked="1">купить</li><li>позвонить</li><li>ещё</li></ul><ul><li>обычный</li></ul>`);
  assert.equal(htmlToText(html), "☑ купить\n☐ позвонить\n☐ ещё\n\n• обычный");
});
