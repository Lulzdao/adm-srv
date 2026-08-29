'use strict';

// ============================================================================
//  МЧД — машиночитаемые доверенности
//
//  Из ЕИС доверенность выгружается архивом, внутри которого одна и та же
//  доверенность лежит в двух форматах и рядом — открепленные подписи:
//
//    *_XML_PF.xml     формат ЕИС      (zakupki.gov.ru/cc/POATypes/1)
//    *_XML_INT.xml    он же, обёрнутый в <export> — выгрузка
//    *_XML_PF_MC.xml  формат ФНС      (EMCHD_1, теги по-русски, данные в атрибутах)
//    *_SIGN_*.sig     подписи CMS в base64 к соответствующим XML
//
//  Разбираем ОБА формата: ЕИС-формат удобнее и идёт первым, но EMCHD —
//  общероссийский стандарт, и такие же архивы приходят из других систем.
//
//  ЧТО БЕРЁМ ИЗ ДОВЕРЕННОСТИ: ФИО представителя, реестровый номер и срок
//  действия. Больше ничего. В архиве есть паспорт, СНИЛС, ИНН и дата рождения
//  — для задачи «следить за сроками» они не нужны, а раз их нет в базе, их
//  нельзя ни показать лишнему человеку, ни потерять вместе с файлом базы.
//  Это сознательное ограничение, а не недоделка: не добавляйте эти поля,
//  не обсудив.
// ============================================================================

const zlib = require('zlib');

// ---------------------------------------------------------------------------
//  Распаковка ZIP
//
//  Своими руками, без зависимости: zlib в Node встроен, а нужного от ZIP —
//  список файлов и их содержимое. Читаем центральный каталог, а не цепочку
//  локальных заголовков: при потоковой записи размеры в локальном заголовке
//  бывают нулевыми (данные уезжают в дескриптор после содержимого), и наивный
//  проход по ним разваливается.
// ---------------------------------------------------------------------------

// Пределы распаковки.
//
// Однородные данные ZIP жмёт примерно 1000:1, а записи центрального каталога
// могут ВСЕ указывать на один и тот же локальный файл — тогда усиление ещё и
// умножается на их число. Измерено на прежнем коде: архив в 199 КБ
// разворачивался в 200 МБ за 1,8 с, а маршрут загрузки принимает двадцать
// файлов по 5 МБ. Распаковка синхронная, поэтому такой архив не просто съедает
// память, а держит единственный поток модуля до самого OOM: реестры
// сертификатов и МЧД ложатся до перезапуска службы.
//
// Настоящая выгрузка МЧД из ЕИС — это несколько десятков килобайт XML и
// подписей. Пределы ниже с запасом на два порядка и ни одному законному
// архиву не мешают.
const MAX_ENTRIES = 64;                    // файлов в архиве
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;   // распакованный размер одного файла
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;  // распакованный размер всего архива
const TOO_BIG = 'Архив распаковывается в слишком большой объём — читать его отказываемся';

const EOCD_SIG = 0x06054b50;   // конец центрального каталога
const CEN_SIG = 0x02014b50;    // запись центрального каталога
const LOC_SIG = 0x04034b50;    // локальный заголовок файла

function findEndOfCentralDirectory(buf) {
  // Хвост может содержать комментарий (до 64 КБ), поэтому ищем сигнатуру с конца.
  const start = Math.max(0, buf.length - 66 * 1024);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readZip(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error('Это не ZIP-архив (не найден конец центрального каталога)');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const files = [];
  let totalBytes = 0;

  if (count > MAX_ENTRIES) throw new Error(TOO_BIG);

  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CEN_SIG) break;
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    // Заявленный размер после распаковки читаем ДО inflate: честную бомбу видно
    // по одному заголовку, не потратив на неё ни памяти, ни времени.
    const declaredSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    // Имя нужно только чтобы отличить .xml от .sig — расширение ASCII и
    // переживает любую кодировку, поэтому в тонкости cp866 не лезем.
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // каталог
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOC_SIG) continue;
    const locNameLen = buf.readUInt16LE(localOffset + 26);
    const locExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + locNameLen + locExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    if (declaredSize > MAX_ENTRY_BYTES) throw new Error(TOO_BIG);

    let data;
    if (method === 0) data = Buffer.from(raw);            // без сжатия
    else if (method === 8) {
      // maxOutputLength — вторая линия: заголовку верить нельзя, он может
      // объявить один килобайт, а развернуться в гигабайт. zlib в этом случае
      // бросает ERR_BUFFER_TOO_LARGE, и сообщение о ней читать человеку
      // бессмысленно — подменяем на внятное.
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch (err) {
        if (err.code === 'ERR_BUFFER_TOO_LARGE') throw new Error(TOO_BIG);
        throw err;
      }
    }
    else continue;                                         // прочих в выгрузках ЕИС не бывает

    // Общий предел считаем отдельно: пределом на один файл его не заменить —
    // записей каталога может быть много, и все они вправе указывать на один и
    // тот же локальный заголовок.
    totalBytes += data.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(TOO_BIG);

    files.push({ name, data, encrypted: (flags & 0x1) !== 0 });
  }
  if (!files.length) throw new Error('В архиве нет файлов');
  return files;
}

// ---------------------------------------------------------------------------
//  Разбор XML
//
//  Своими руками и здесь: единственный разбираемый документ — известной
//  формы, а тянуть парсер ради двух десятков полей на закрытый контур не
//  хочется. Ищем значения по имени тега и по имени атрибута, не строя дерево:
//  оба формата плоские настолько, что этого достаточно.
// ---------------------------------------------------------------------------

// Значение первого тега с таким именем (с учётом любого префикса пространства имён).
function tagValue(xml, tag) {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${tag}>`));
  return m ? m[1].trim() : '';
}

// Значение атрибута у первого тега с таким именем.
//
// Имя атрибута ищем как «начало строки или пробел, затем имя», а НЕ через \b:
// граница слова в JS определена через [A-Za-z0-9_], поэтому перед кириллической
// буквой её попросту нет, и `\bФамилия=` не совпадает никогда. Формат ФНС весь
// на кириллице — на этом разбор молча возвращал пустые поля.
function attrOf(openTagAttrs, attr) {
  const m = openTagAttrs.match(new RegExp(`(?:^|\\s)${attr}="([^"]*)"`));
  return m ? m[1].trim() : '';
}

function attrValue(xml, tag, attr) {
  const open = xml.match(new RegExp(`<(?:\\w+:)?${tag}(\\s[^>]*)?/?>`));
  if (!open || !open[1]) return '';
  return attrOf(open[1], attr);
}

function joinName(last, first, middle) {
  return [last, first, middle].map((p) => (p || '').trim()).filter(Boolean).join(' ');
}

// Формат ЕИС: <powerOfAttorney> либо <export><powerOfAttorney>.
function parseEis(xml) {
  if (!/POATypes/.test(xml)) return null;
  // ФИО берём из representativeInfo — это тот, НА КОГО выдана доверенность.
  // В документе есть ещё ФИО руководителя-доверителя, и перепутать их легко:
  // ищем строго внутри блока представителя.
  const repBlock = (xml.match(/<(?:\w+:)?representativeInfo[\s\S]*?<\/(?:\w+:)?representativeInfo>/) || [''])[0];
  const name = joinName(tagValue(repBlock, 'lastName'), tagValue(repBlock, 'firstName'), tagValue(repBlock, 'middleName'));
  return {
    uuid: tagValue(xml, 'uuid'),
    regNumber: tagValue(xml, 'regNumber') || tagValue(xml, 'docNumber'),
    fullName: name,
    validFrom: tagValue(xml, 'createDate'),
    validTo: tagValue(xml, 'endDate'),
    format: 'ЕИС',
  };
}

// Формат ФНС EMCHD_1: теги по-русски, значения в атрибутах.
function parseEmchd(xml) {
  if (!/ВерсФорм="EMCHD/.test(xml)) return null;
  const repBlock = (xml.match(/<СвУпПред[\s\S]*?<\/СвУпПред>/) || [''])[0];
  const fio = repBlock.match(/<ФИО(\s[^>]*)?\/?>/);
  const pick = (attr) => (fio && fio[1] ? attrOf(fio[1], attr) : '');
  return {
    uuid: attrValue(xml, 'Доверенность', 'ИдФайл'),
    regNumber: attrValue(xml, 'СвДов', 'НомДовер') || attrValue(xml, 'СвДов', 'ВнНомДовер'),
    fullName: joinName(pick('Фамилия'), pick('Имя'), pick('Отчество')),
    validFrom: attrValue(xml, 'СвДов', 'ДатаВыдДовер'),
    validTo: attrValue(xml, 'СвДов', 'СрокДейст'),
    format: 'ФНС',
  };
}

// Даты приходят в двух видах: 2026-08-27 (ЕИС) и 27.08.2026 (ФНС).
// Храним в ISO — так их сравнивает SQLite и сортирует список.
function toIsoDate(value) {
  const v = (value || '').trim();
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return '';
}

/**
 * Разобрать выгруженный из ЕИС архив.
 * Возвращает { uuid, regNumber, fullName, validFrom, validTo, signed, format }.
 * Бросает исключение с человеческим текстом, если внутри не доверенность.
 */
function parseArchive(buf) {
  const files = readZip(buf);
  if (files.some((f) => f.encrypted)) throw new Error('Архив защищён паролем');

  const xmls = files.filter((f) => /\.xml$/i.test(f.name));
  if (!xmls.length) throw new Error('В архиве нет XML с доверенностью');

  // ЕИС-формат в приоритете: в нём значения лежат в тексте, а не в атрибутах,
  // и разбор устойчивее. Файл выгрузки (_INT) — тот же документ в обёртке.
  let parsed = null;
  for (const f of xmls) {
    const xml = f.data.toString('utf8');
    parsed = parseEis(xml) || parsed;
    if (parsed && parsed.fullName && parsed.validTo) break;
  }
  if (!parsed || !parsed.fullName || !parsed.validTo) {
    for (const f of xmls) {
      const alt = parseEmchd(f.data.toString('utf8'));
      if (alt && alt.fullName && alt.validTo) { parsed = alt; break; }
    }
  }
  if (!parsed || !parsed.fullName) throw new Error('В XML не нашлось ФИО представителя — это не похоже на МЧД');
  if (!parsed.validTo) throw new Error('В XML не нашлось срока действия доверенности');

  return {
    uuid: parsed.uuid || '',
    regNumber: parsed.regNumber || '',
    fullName: parsed.fullName,
    validFrom: toIsoDate(parsed.validFrom),
    validTo: toIsoDate(parsed.validTo),
    // Подпись не проверяем — для ГОСТ-криптографии нужен КриптоПро, которого
    // на сервере нет. Записываем только факт: приложена она или нет.
    signed: files.some((f) => /\.sig$/i.test(f.name)),
    format: parsed.format,
  };
}

// parseEis/parseEmchd наружу — чтобы их можно было проверить по отдельности
// на файле каждого формата, не собирая ради этого архив.
module.exports = { parseArchive, readZip, parseEis, parseEmchd, toIsoDate };
