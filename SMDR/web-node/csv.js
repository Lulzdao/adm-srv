'use strict';

// Выгрузка журнала в CSV.
//
// Почему CSV, а не .xlsx: сеть изолирована, новые пакеты не поставить, а
// собирать zip с XML вручную ради выгрузки звонков — несоразмерно.
//
// Два решения, без которых файл в русском Excel открывается неправильно, и
// оба неочевидны:
//
// 1. РАЗДЕЛИТЕЛЬ — точка с запятой, а не запятая. Excel смотрит на
//    региональный разделитель списка Windows; в русской локали это «;», и
//    файл с запятыми он свалит целиком в первую колонку.
// 2. BOM в начале файла. Без него Excel читает UTF-8 как ANSI, и вся
//    кириллица превращается в «ÐÑÐ¾Ð±Ð½Ð¸ÐºÐ¾Ð²».

const BOM = '﻿';
const SEP = ';';

const COLUMNS = ['Дата', 'Время', 'Внутренний', 'Направление', 'Детали', 'Длительность', 'Ожидание', 'Сотрудник'];

const DIRECTION_LABEL = {
  outgoing: 'Исходящий',
  incoming: 'Входящий',
  internal: 'Внутренний',
};

/**
 * Значение в ячейку CSV.
 *
 * Кавычки удваиваются, а вся ячейка берётся в кавычки, если внутри есть
 * разделитель, кавычка или перевод строки. Отдельно — ведущий знак «=», «+»,
 * «-» или «@»: Excel считает такую ячейку формулой и пытается её вычислить.
 * В журнале звонков номера вида +74951234567 — обычное дело, и без защиты
 * Excel показал бы на их месте ошибку, а в худшем случае выполнил бы то, что
 * подставил в поле человек через справочник ФИО.
 */
function cell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (s.includes(SEP) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Колонка «Детали» собирается так же, как в таблице на экране. */
function details(row) {
  if (row.direction === 'incoming') return `${row.caller || ''} → ${row.did || ''}`.trim();
  if (row.direction === 'internal') return `→ ${row.internal_to || ''}`.trim();
  if (row.direction === 'outgoing') return row.number || '';
  return 'не распознано';
}

function directionLabel(row) {
  if (row.direction === 'incoming' && row.status === 'NA') return 'Пропущенный';
  return DIRECTION_LABEL[row.direction] || 'не распознано';
}

/** Одна строка файла, уже с переводом строки. CRLF — его ждёт Excel. */
function formatRow(row) {
  return [
    row.call_date, row.call_time, row.ext,
    directionLabel(row), details(row),
    row.duration, row.ring, row.fio,
  ].map(cell).join(SEP) + '\r\n';
}

function headerRow() {
  return BOM + COLUMNS.join(SEP) + '\r\n';
}

/** Имя файла: журнал-звонков-2026-09-04.csv */
function fileName(now = new Date()) {
  const п = (n) => String(n).padStart(2, '0');
  return `журнал-звонков-${now.getFullYear()}-${п(now.getMonth() + 1)}-${п(now.getDate())}.csv`;
}

/**
 * Заголовок Content-Disposition с кириллическим именем файла.
 * ASCII-запасной вариант обязателен: браузер, не понимающий filename*,
 * иначе сохранит файл под именем самого маршрута, без расширения.
 */
function contentDisposition(name) {
  return `attachment; filename="calls.csv"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Средний вес строки в байтах — для оценки размера файла в окне выгрузки.
// Померено на строке с кириллическим ФИО и внешним номером: в UTF-8 русская
// буква занимает два байта, поэтому 8 колонок дают примерно столько.
const BYTES_PER_ROW = 150;

module.exports = { BOM, SEP, COLUMNS, cell, details, directionLabel, formatRow, headerRow, fileName, contentDisposition, BYTES_PER_ROW };
