require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');

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

function buildWhereClause(query) {
  const { date_from = '', date_to = '', time_from = '', time_to = '', search = '', direction = '' } = query;
  let where = ' WHERE 1=1';
  const params = [];

  if (date_from) { where += ' AND date(calls.call_dt) >= date(?)'; params.push(date_from); }
  if (date_to) { where += ' AND date(calls.call_dt) <= date(?)'; params.push(date_to); }
  if (time_from) { where += ' AND time(calls.call_dt) >= time(?)'; params.push(time_from); }
  if (time_to) { where += ' AND time(calls.call_dt) <= time(?)'; params.push(time_to); }
  if (search) {
    where += ` AND (
      lower_ru(calls.number) LIKE lower_ru(?) OR
      lower_ru(calls.ext) LIKE lower_ru(?) OR
      lower_ru(calls.caller) LIKE lower_ru(?) OR
      lower_ru(calls.did) LIKE lower_ru(?) OR
      lower_ru(calls.internal_to) LIKE lower_ru(?) OR
      lower_ru(employees.fio) LIKE lower_ru(?)
    )`;
    const s = `%${search}%`;
    params.push(s, s, s, s, s, s);
  }
  if (direction) { where += ' AND calls.direction = ?'; params.push(direction); }

  return { where, params };
}

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

app.get('/', (req, res) => {
  const { date_from = '', date_to = '', time_from = '', time_to = '', search = '', direction = '' } = req.query;
  const data = getCalls(req.query);
  const prevUrl = data.page > 1 ? buildPageUrl(req, data.page - 1) : null;
  const nextUrl = data.page < data.totalPages ? buildPageUrl(req, data.page + 1) : null;
  res.render('dashboard', { ...data, date_from, date_to, time_from, time_to, search, direction, prevUrl, nextUrl });
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

function parseDurationToSeconds(str) {
  if (!str) return 0;
  const m = str.match(/^(\d{1,2}):(\d{2})'(\d{2})$/);
  if (!m) return 0;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
}

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
      a.outgoingSeconds += parseDurationToSeconds(r.duration);
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
    agg[key] = (agg[key] || 0) + parseDurationToSeconds(r.duration);
  });

  const result = Object.entries(agg).map(([key, seconds]) => {
    const [day, direction] = key.split('|');
    return { day, direction, minutes: Math.round(seconds / 60) };
  });

  res.json(result);
});

app.listen(PORT, BIND_HOST, () => console.log(`Веб запущен на http://${BIND_HOST}:${PORT} (только для платформы, за прокси)`));
