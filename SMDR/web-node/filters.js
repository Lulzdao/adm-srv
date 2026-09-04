'use strict';

// Разбор параметров фильтра журнала и сборка условия WHERE.
//
// Вынесено из server.js отдельным модулем ради тестов: собранный SQL —
// самая ответственная часть журнала. Ошибка в нём не роняет страницу, а
// молча показывает не те звонки, и заметить это некому.

const { inputToSeconds } = require('./duration');

/** Сколько значений принимаем в одном поле — чтобы длинная строка не
 *  превращалась в запрос с сотней условий. */
const MAX_VALUES = 20;

/**
 * Несколько значений в одном поле — через запятую: «214, 301».
 * Пустые куски выбрасываем: без этого «214,» давало поиск по пустой строке,
 * а LIKE '%%' совпадает со всем — фильтр переставал фильтровать, оставаясь
 * на вид включённым.
 */
function parseList(value, limit = MAX_VALUES) {
  if (typeof value !== 'string') return [];
  return value.split(/[,;]/).map((s) => s.trim()).filter(Boolean).slice(0, limit);
}

// Колонки, по которым умеет искать прицельный поиск. Ключ приходит с
// фронтенда, поэтому список закрытый: подставлять имя колонки из запроса
// в SQL нельзя ни под каким видом.
const SEARCH_COLUMNS = {
  ext: ['calls.ext'],
  // «Детали» в таблице — это одна из четырёх колонок в зависимости от
  // направления звонка, поэтому ищем сразу по всем четырём.
  details: ['calls.number', 'calls.caller', 'calls.did', 'calls.internal_to'],
  fio: ['employees.fio'],
};

// Поиск «везде» — те же колонки плюс добавочный.
const ALL_COLUMNS = [...SEARCH_COLUMNS.ext, ...SEARCH_COLUMNS.details, ...SEARCH_COLUMNS.fio];

// «Пропущенный» — не направление, а входящий, на который не ответили
// (status = 'NA', см. README модуля). В прежнем выпадающем списке места ему
// не было вовсе, хотя спрашивают про такие звонки чаще всего.
const DIRECTION_CLAUSES = {
  outgoing: "calls.direction = 'outgoing'",
  incoming: "calls.direction = 'incoming'",
  internal: "calls.direction = 'internal'",
  missed: "(calls.direction = 'incoming' AND calls.status = 'NA')",
};

/** Условие ИЛИ по набору выбранных направлений. Пусто — условия нет. */
function directionClause(kinds) {
  const выбранные = kinds.filter((k) => DIRECTION_CLAUSES[k]);
  if (!выбранные.length) return null;
  return '(' + выбранные.map((k) => DIRECTION_CLAUSES[k]).join(' OR ') + ')';
}

/** Направления из запроса. Принимаем и список через запятую, и повторяющийся
 *  параметр, и старую форму `direction=outgoing` — ссылки из закладок и из
 *  писем со старым набором параметров должны продолжать работать. */
function parseDirections(query) {
  const raw = query.direction;
  const список = Array.isArray(raw) ? raw : parseList(raw, 8);
  return список.filter((k) => DIRECTION_CLAUSES[k]);
}

/** LIKE-условие «любая из колонок содержит любое из значений». */
function likeGroup(columns, values, params) {
  const части = [];
  for (const v of values) {
    for (const col of columns) {
      части.push(`lower_ru(${col}) LIKE lower_ru(?)`);
      params.push(`%${v}%`);
    }
  }
  return части.length ? '(' + части.join(' OR ') + ')' : null;
}

/**
 * Собирает WHERE и список параметров.
 *
 * Все значения уходят В ПАРАМЕТРАХ, в строку SQL не подставляется ничего,
 * кроме имён колонок из закрытого списка выше.
 */
function buildWhereClause(query = {}) {
  const {
    date_from = '', date_to = '', time_from = '', time_to = '',
    search = '', col = '', colq = '', dur_min = '', ring_min = '',
  } = query;

  const условия = [];
  const params = [];

  if (date_from) { условия.push('date(calls.call_dt) >= date(?)'); params.push(date_from); }
  if (date_to) { условия.push('date(calls.call_dt) <= date(?)'); params.push(date_to); }
  if (time_from) { условия.push('time(calls.call_dt) >= time(?)'); params.push(time_from); }
  if (time_to) { условия.push('time(calls.call_dt) <= time(?)'); params.push(time_to); }

  const общий = parseList(search);
  const поВсем = likeGroup(ALL_COLUMNS, общий, params);
  if (поВсем) условия.push(поВсем);

  // Прицельный поиск по одной колонке. Работает вместе с общим, а не вместо:
  // заполнены оба — применяются оба.
  const колонки = SEARCH_COLUMNS[col];
  if (колонки) {
    const поКолонке = likeGroup(колонки, parseList(colq), params);
    if (поКолонке) условия.push(поКолонке);
  }

  const направления = directionClause(parseDirections(query));
  if (направления) условия.push(направления);

  // Длительность и ожидание лежат в базе строками, поэтому сравниваем через
  // свою функцию dur_sec (регистрируется в db.js рядом с lower_ru).
  const разговор = inputToSeconds(dur_min);
  if (разговор !== null) { условия.push('dur_sec(calls.duration) >= ?'); params.push(разговор); }
  const ожидание = inputToSeconds(ring_min);
  if (ожидание !== null) { условия.push('dur_sec(calls.ring) >= ?'); params.push(ожидание); }

  const where = условия.length ? ' WHERE ' + условия.join(' AND ') : ' WHERE 1=1';
  return { where, params };
}

/**
 * Сколько фильтров включено в раскрывающемся ряду. Число показывается рядом
 * с «Ещё фильтры» и в свёрнутом виде: иначе человек смотрит на неполную
 * выборку и не понимает почему.
 */
function countExtraFilters(query = {}) {
  let n = 0;
  if (parseDirections(query).length) n++;
  if (SEARCH_COLUMNS[query.col] && parseList(query.colq).length) n++;
  if (query.time_from) n++;
  if (query.time_to) n++;
  if (inputToSeconds(query.dur_min) !== null) n++;
  if (inputToSeconds(query.ring_min) !== null) n++;
  return n;
}

module.exports = {
  buildWhereClause, countExtraFilters,
  parseList, parseDirections, directionClause,
  SEARCH_COLUMNS, DIRECTION_CLAUSES, MAX_VALUES,
};
