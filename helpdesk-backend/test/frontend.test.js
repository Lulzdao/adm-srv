'use strict';

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// ============================================================================
//  Экранирование во фронтенде
//
//  Берём ЖИВУЮ функцию из public/app.js, а не её копию: копия в тесте
//  разошлась бы с оригиналом при первой же правке и продолжала бы зеленеть.
//
//  Проверять её в node стало возможно ровно потому, что она больше не ходит в
//  DOM: прежняя реализация создавала div и читала innerHTML — и как раз
//  поэтому не экранировала кавычки.
// ============================================================================

function загрузитьEsc() {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const m = src.match(/function esc\(s\) \{[\s\S]*?\n\}/);
  assert.ok(m, "функция esc() не найдена в public/app.js — тест устарел");
  return new Function(`${m[0]}; return esc;`)();
}

test("esc экранирует двойную кавычку — иначе рвётся атрибут", () => {
  const esc = загрузитьEsc();
  assert.strictEqual(esc('отчёт".pdf'), "отчёт&quot;.pdf");
  assert.ok(!esc('a" onmouseover="alert(1)').includes('"'),
    "ни одной сырой кавычки остаться не должно");
});

test("esc экранирует одинарную кавычку", () => {
  const esc = загрузитьEsc();
  assert.strictEqual(esc("d'Артаньян"), "d&#39;Артаньян");
});

test("esc экранирует угловые скобки и амперсанд, и именно в таком порядке", () => {
  const esc = загрузитьEsc();
  assert.strictEqual(esc("<b>Иванов & Ко</b>"), "&lt;b&gt;Иванов &amp; Ко&lt;/b&gt;");
  // Порядок важен: если & заменять последним, получилось бы &amp;lt;
  assert.strictEqual(esc("&lt;"), "&amp;lt;");
});

test("esc не портит обычный русский текст", () => {
  const esc = загрузитьEsc();
  const обычный = "Не печатает принтер в 212 кабинете — мигает лампочка";
  assert.strictEqual(esc(обычный), обычный);
});

test("esc обрабатывает пустые значения без падения", () => {
  const esc = загрузитьEsc();
  assert.strictEqual(esc(null), "");
  assert.strictEqual(esc(undefined), "");
  assert.strictEqual(esc(0), "0");
  assert.strictEqual(esc(false), "false");
});

test("враждебное имя файла не может закрыть атрибут", () => {
  const esc = загрузитьEsc();
  // Имя файла, какое сотрудник вправе задать при загрузке вложения.
  const имяФайла = 'отчёт" onmouseover="1" x=".pdf';
  const значение = esc(имяФайла);

  // Суть защиты ровно одна: внутри значения не остаётся символа, которым
  // атрибут закрывается. Текст « onmouseover=» внутри значения остаться может
  // и вреда не несёт — он там обычные буквы, а не разметка.
  assert.ok(!значение.includes('"'), "двойная кавычка закрыла бы атрибут");
  assert.ok(!значение.includes("'"), "одинарная кавычка закрыла бы атрибут в другой записи");

  const разметка = `<a download="${значение}">вложение</a>`;
  assert.strictEqual((разметка.match(/"/g) || []).length, 2,
    "кавычек должно остаться ровно две — те, что обрамляют значение");
});
