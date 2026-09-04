require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const { buildWhereClause, countExtraFilters } = require('./filters');
const { durationToSeconds } = require('./duration');
const csv = require('./csv');

const app = express();
const PORT = process.env.PORT || 3102;

// Модуль встроен в платформу (хелпдеск) через прокси — платформа сама
// проверяет вход по LDAP и роль перед тем, как пропустить запрос сюда.
// Своего логина у модуля нет, слушаем только 127.0.0.1 — снаружи сети
// до этого порта не достучаться никак, кроме как через саму платформу.
const BIND_HOST = '127.0.0.1';

app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true, limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Chart.js отдаём со своего сервера, а не с внешнего CDN (который блокируется в сети)
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));

const PAGE_SIZE = 100;

function getCalls(query) {
  const { where, params } = buildWhereClause(query);
  const page = Math.max(1, parseInt(query.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const baseFrom = `FROM calls LEFT JOIN employees ON calls.ext = employees.ext${where}`;

  const filteredTotal = db.prepare(`SELECT COUNT(*) AS c ${baseFrom}`).get(...params).c;
  const totalPages = Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE));

  const rows = db.prepare(
    `SELECT calls.*, employees.fio ${baseFrom} ORDER BY calls.call_dt DESC LIMIT ? OFFSET ?`
  ).all(...params, PAGE_SIZE, offset);

  const total = db.prepare('SELECT COUNT(*) AS c FROM calls').get().c;
  const outCount = db.prepare("SELECT COUNT(*) AS c FROM calls WHERE direction='outgoing'").get().c;
  const inCount = db.prepare("SELECT COUNT(*) AS c FROM calls WHERE direction='incoming'").get().c;
  const intCount = db.prepare("SELECT COUNT(*) AS c FROM calls WHERE direction='internal'").get().c;

  return { rows, total, outCount, inCount, intCount, filteredTotal, page, totalPages };
}

function buildPageUrl(req, targetPage) {
  const params = new URLSearchParams(req.query);
  params.set('page', targetPage);
  return '?' + params.toString();
}

const { parseDirections } = require('./filters');

app.get('/', (req, res) => {
  const {
    date_from = '', date_to = '', time_from = '', time_to = '',
    search = '', col = '', colq = '', dur_min = '', ring_min = '',
  } = req.query;
  const data = getCalls(req.query);
  const prevUrl = data.page > 1 ? buildPageUrl(req, data.page - 1) : null;
  const nextUrl = data.page < data.totalPages ? buildPageUrl(req, data.page + 1) : null;
  res.render('dashboard', {
    ...data,
    date_from, date_to, time_from, time_to, search, col, colq, dur_min, ring_min,
    directions: parseDirections(req.query),
    extraCount: countExtraFilters(req.query),
    prevUrl, nextUrl,
  });
});

// Используется JS-скриптом на странице для периодического опроса без перезагрузки
app.get('/api/calls', (req, res) => {
  res.json(getCalls(req.query));
});

app.get('/stats', (req, res) => {
	const data = getCalls({});
	res.render('stats', data);
});

app.get('/api/stats/daily', (req, res) => {
  const rows = db.prepare(`
    SELECT date(call_dt) AS day, direction, COUNT(*) AS cnt
    FROM calls WHERE call_dt IS NOT NULL
    GROUP BY day, direction ORDER BY day
  `).all();
  res.json(rows);
});

app.get('/api/stats/by-ext', (req, res) => {
  const rows = db.prepare(`
    SELECT calls.ext, employees.fio, COUNT(*) AS cnt
    FROM calls LEFT JOIN employees ON calls.ext = employees.ext
    WHERE calls.ext IS NOT NULL
    GROUP BY calls.ext ORDER BY cnt DESC LIMIT 20
  `).all();
  res.json(rows);
});

app.get('/directory', (req, res) => {
  const exts = db.prepare('SELECT DISTINCT ext FROM calls WHERE ext IS NOT NULL ORDER BY ext').all().map(r => r.ext);
  const employees = db.prepare('SELECT * FROM employees').all();
  const map = {};
  employees.forEach(e => map[e.ext] = e.fio);
  res.render('directory', { exts, map });
});

app.post('/directory', (req, res) => {
  const { ext, fio } = req.body;
  // Раньше значения уходили в базу как есть: непустой проверки не было
  // вообще (пустой добавочный создавал мусорную строку), а длину никто не
  // ограничивал. Добавочный — только цифры, ФИО — обычная строка разумной длины.
  if (typeof ext !== 'string' || !/^\d{1,10}$/.test(ext.trim())) {
    return res.status(400).send('Добавочный должен состоять только из цифр (до 10 знаков)');
  }
  if (typeof fio !== 'string' || fio.length > 200) {
    return res.status(400).send('ФИО должно быть строкой не длиннее 200 символов');
  }
  db.prepare(`INSERT INTO employees (ext, fio) VALUES (?, ?)
              ON CONFLICT(ext) DO UPDATE SET fio = excluded.fio`).run(ext.trim(), fio.trim());
  res.redirect('directory');
});

app.get('/api/stats/table', (req, res) => {
  const { date_from = '', date_to = '' } = req.query;
  let sql = `SELECT calls.ext, employees.fio, calls.direction, calls.duration
             FROM calls LEFT JOIN employees ON calls.ext = employees.ext
             WHERE calls.ext IS NOT NULL`;
  const params = [];
  if (date_from) { sql += ' AND date(calls.call_dt) >= date(?)'; params.push(date_from); }
  if (date_to) { sql += ' AND date(calls.call_dt) <= date(?)'; params.push(date_to); }
  const rows = db.prepare(sql).all(...params);

  const agg = {};
  rows.forEach(r => {
    if (!agg[r.ext]) {
      agg[r.ext] = { ext: r.ext, fio: r.fio, total: 0, outgoing: 0, incoming: 0, internal: 0, outgoingSeconds: 0 };
    }
    const a = agg[r.ext];
    a.total++;
    if (r.direction === 'outgoing') {
      a.outgoing++;
      a.outgoingSeconds += durationToSeconds(r.duration);
    } else if (r.direction === 'incoming') {
      a.incoming++;
    } else if (r.direction === 'internal') {
      a.internal++;
    }
  });

  const result = Object.values(agg).sort((a, b) => b.outgoingSeconds - a.outgoingSeconds);
  res.json(result);
});

app.get('/api/stats/daily-minutes', (req, res) => {
  const rows = db.prepare(`
    SELECT date(call_dt) AS day, direction, duration
    FROM calls WHERE call_dt IS NOT NULL AND direction IN ('outgoing', 'incoming')
  `).all();

  const agg = {};
  rows.forEach(r => {
    const key = r.day + '|' + r.direction;
    agg[key] = (agg[key] || 0) + durationToSeconds(r.duration);
  });

  const result = Object.entries(agg).map(([key, seconds]) => {
    const [day, direction] = key.split('|');
    return { day, direction, minutes: Math.round(seconds / 60) };
  });

  res.json(result);
});

// ---------------------------------------------------------------------------
//  Выгрузка журнала в CSV
//
//  Окно выгрузки предлагает несколько периодов, и рядом с каждым сразу
//  написано, сколько строк уедет и сколько это весит. Это и есть
//  подтверждение: отдельного вопроса «точно выгружать?» нет — по числам видно
//  и так, а если в базе пять лет, а нужен последний месяц, период выбирается
//  прямо здесь, без возврата к фильтрам.
// ---------------------------------------------------------------------------

// Период заменяет собой ДАТЫ, остальные фильтры остаются как есть.
// 'current' — то, что человек уже настроил на экране.
const PERIODS = {
  current: null,
  month: 30,
  quarter: 92,
  year: 365,
  all: 0,   // без ограничения по дате
};

/** Копия параметров фильтра с датами, подменёнными выбранным периодом. */
function queryForPeriod(query, period, now = new Date()) {
  if (period === 'current' || !(period in PERIODS)) return query;
  const q = { ...query };
  delete q.date_from;
  delete q.date_to;
  const дней = PERIODS[period];
  if (дней) {
    const от = new Date(now.getTime() - дней * 86400000);
    q.date_from = от.toISOString().slice(0, 10);
  }
  return q;
}

function countFor(query) {
  const { where, params } = buildWhereClause(query);
  return db.prepare(`SELECT COUNT(*) AS c FROM calls LEFT JOIN employees ON calls.ext = employees.ext${where}`)
    .get(...params).c;
}

// Сколько строк уедет по каждому варианту. Пять запросов COUNT по индексу
// idx_calls_dt — единицы миллисекунд даже на сотнях тысяч строк, и считаются
// они один раз, при открытии окна.
app.get('/api/export/preview', (req, res) => {
  const now = new Date();
  const варианты = {};
  for (const period of Object.keys(PERIODS)) {
    const rows = countFor(queryForPeriod(req.query, period, now));
    варианты[period] = { rows, bytes: rows * csv.BYTES_PER_ROW };
  }
  res.json(варианты);
});

app.get('/export.csv', (req, res) => {
  const period = typeof req.query.period === 'string' && req.query.period in PERIODS
    ? req.query.period : 'current';
  const { where, params } = buildWhereClause(queryForPeriod(req.query, period));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', csv.contentDisposition(csv.fileName()));
  // Файл собирается на лету, длина заранее неизвестна — просим прокси и
  // браузер не буферизовать его целиком.
  res.setHeader('Cache-Control', 'no-store');

  res.write(csv.headerRow());

  // Пишем ПОТОКОМ, строка за строкой: год работы — это сотни тысяч записей,
  // и собирать их в одну строку в памяти нельзя. .iterate() отдаёт по одной,
  // а res.write сам притормаживает нас, когда сеть не успевает.
  const stmt = db.prepare(
    `SELECT calls.*, employees.fio FROM calls LEFT JOIN employees ON calls.ext = employees.ext${where} ORDER BY calls.call_dt DESC`
  );
  try {
    for (const row of stmt.iterate(...params)) {
      res.write(csv.formatRow(row));
    }
  } catch (e) {
    // Заголовки уже ушли, ответ подменить нечем. Пишем маркер в сам файл,
    // чтобы обрыв было видно, и в лог — чтобы было что искать.
    console.error('[выгрузка] оборвалась:', e.message);
    res.write('\r\n# ВЫГРУЗКА ОБОРВАЛАСЬ, ФАЙЛ НЕПОЛНЫЙ\r\n');
  }
  res.end();
});

app.listen(PORT, BIND_HOST, () => console.log(`Веб запущен на http://${BIND_HOST}:${PORT} (только для платформы, за прокси)`));
