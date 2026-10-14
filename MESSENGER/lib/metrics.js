'use strict';

// ---------- Нагрузка на сервер: что и сколько через него проходит ----------
//
// Сервер сам считает свою нагрузку — без внешних программ и зависимостей — и раскладывает её по
// минутам: сколько HTTP-запросов и к чему, сколько байт пришло и ушло, сколько сообщений по
// постоянным линиям (WebSocket) и каких, сколько подключений, насколько был занят процесс. Хранятся
// последние сутки, в памяти: после перезапуска службы счёт начинается заново, а история за прошлые
// часы остаётся в журнале — раз в час туда уходит сводка (см. hourSummary).
//
// Смотрится в панели, раздел «Нагрузка» (GET /api/admin/load). Чтобы найти, кто «грузит сеть»,
// трафик считается и по клиентам — по сотруднику, а для запросов без входа (раздача обновлений) —
// по адресу.
//
// Всё здесь — простые счётчики: одна запись — несколько прибавлений к числам. Стоимость ничтожна
// по сравнению с самой обработкой запроса.

const MINUTE = 60 * 1000;
const KEEP_MINUTES = 24 * 60;
// Защита от разрастания: путей и клиентов в одной минуте не больше стольких, остальное — в «прочее».
const MAX_GROUPS = 80;
const MAX_CLIENTS = 400;

// Запрос → группа для таблицы: числа и имена файлов в пути заменяются, иначе каждая переписка и
// каждый файл стали бы отдельной строкой.
function routeGroup(method, url) {
  let p = String(url || '/').split('?')[0];
  if (p.startsWith('/uploads/')) return `${method} /uploads/*`;
  if (p.startsWith('/updates/')) return `${method} /updates/* (обновления клиентов)`;
  if (!p.startsWith('/api/')) return `${method} панель (страницы, стили, скрипты)`;
  p = p.split('/').map((seg) => (/^\d+$/.test(seg) ? ':id' : /^group:\d+$/.test(seg) ? ':группа' : seg)).join('/');
  return `${method} ${p}`;
}

// Тип сообщения по постоянной линии — по началу JSON: все наши сообщения начинаются с {"type":"…".
// Разбирать весь JSON ради одного поля незачем: исходящие сообщения бывают большими (список присутствия).
function wsType(payload) {
  const m = /^\{"type":"([a-z_-]{1,40})"/i.exec(typeof payload === 'string' ? payload : '');
  return m ? m[1] : 'другое';
}

function emptyBucket(t) {
  return {
    t,
    http: { count: 0, bytesIn: 0, bytesOut: 0, msSum: 0, msMax: 0, err4: 0, err5: 0 },
    groups: new Map(),   // группа → { count, bytesIn, bytesOut, msSum, msMax, err }
    ws: { in: 0, out: 0, bytesIn: 0, bytesOut: 0, connects: 0, closes: 0, drops: 0 },
    wsTypes: new Map(),  // 'in:send' / 'out:presence' → { count, bytes }
    clients: new Map(),  // клиент → { bytesIn, bytesOut, requests, wsMessages }
    gauges: { connections: 0, users: 0, lagMaxMs: 0, rssMb: 0, heapMb: 0, cpuPct: 0 },
  };
}

function bump(map, key, limit, init) {
  let e = map.get(key);
  if (!e) {
    if (map.size >= limit) { key = 'прочее'; e = map.get(key); }
    if (!e) { e = init(); map.set(key, e); }
  }
  return e;
}

function createMetrics({ now = () => Date.now() } = {}) {
  const buckets = new Map(); // начало минуты → bucket

  function bucket() {
    const t = Math.floor(now() / MINUTE) * MINUTE;
    let b = buckets.get(t);
    if (!b) {
      b = emptyBucket(t);
      buckets.set(t, b);
      const oldest = t - KEEP_MINUTES * MINUTE;
      for (const k of buckets.keys()) if (k <= oldest) buckets.delete(k);
    }
    return b;
  }

  function client(b, key) {
    return bump(b.clients, key || 'неизвестно', MAX_CLIENTS, () => ({ bytesIn: 0, bytesOut: 0, requests: 0, wsMessages: 0 }));
  }

  return {
    // HTTP-запрос закончился.
    http({ method, url, status, bytesIn = 0, bytesOut = 0, ms = 0, clientKey }) {
      const b = bucket();
      const h = b.http;
      h.count += 1; h.bytesIn += bytesIn; h.bytesOut += bytesOut; h.msSum += ms; if (ms > h.msMax) h.msMax = ms;
      if (status >= 500) h.err5 += 1; else if (status >= 400) h.err4 += 1;
      const g = bump(b.groups, routeGroup(method, url), MAX_GROUPS, () => ({ count: 0, bytesIn: 0, bytesOut: 0, msSum: 0, msMax: 0, err: 0 }));
      g.count += 1; g.bytesIn += bytesIn; g.bytesOut += bytesOut; g.msSum += ms; if (ms > g.msMax) g.msMax = ms;
      if (status >= 400) g.err += 1;
      const c = client(b, clientKey);
      c.bytesIn += bytesIn; c.bytesOut += bytesOut; c.requests += 1;
    },
    // Сообщение по постоянной линии: dir — 'in' (от клиента) или 'out' (клиенту).
    ws(dir, payload, clientKey) {
      const b = bucket();
      const bytes = typeof payload === 'string' ? Buffer.byteLength(payload) : (payload && payload.length) || 0;
      if (dir === 'in') { b.ws.in += 1; b.ws.bytesIn += bytes; } else { b.ws.out += 1; b.ws.bytesOut += bytes; }
      const type = wsType(typeof payload === 'string' ? payload : String(payload || ''));
      const e = bump(b.wsTypes, `${dir}:${type}`, MAX_GROUPS, () => ({ count: 0, bytes: 0 }));
      e.count += 1; e.bytes += bytes;
      const c = client(b, clientKey);
      if (dir === 'in') c.bytesIn += bytes; else c.bytesOut += bytes;
      c.wsMessages += 1;
    },
    wsConnect() { bucket().ws.connects += 1; },
    wsClose(dropped) { const b = bucket(); b.ws.closes += 1; if (dropped) b.ws.drops += 1; },
    // Показатели «на сейчас» — раз в несколько секунд; в минуте остаётся наибольшее.
    gauges(g) {
      const b = bucket().gauges;
      for (const k of Object.keys(g)) if (typeof g[k] === 'number' && g[k] > b[k]) b[k] = g[k];
    },
    // Сводка за последние minutes минут (не больше суток).
    summary(minutes = 60) {
      const to = Math.floor(now() / MINUTE) * MINUTE;
      const from = to - (Math.min(Math.max(1, minutes), KEEP_MINUTES) - 1) * MINUTE;
      return summarize([...buckets.values()].filter((b) => b.t >= from && b.t <= to), from, to);
    },
  };
}

// Сложить минуты в одну сводку: ряд по минутам для графиков, таблицы путей, типов сообщений и
// клиентов, отсортированные по трафику.
function summarize(list, from, to) {
  const byT = new Map(list.map((b) => [b.t, b]));
  const series = [];
  const totals = { requests: 0, bytesIn: 0, bytesOut: 0, wsIn: 0, wsOut: 0, wsBytesIn: 0, wsBytesOut: 0, err4: 0, err5: 0, connects: 0, drops: 0, msSum: 0, msMax: 0, maxConnections: 0, maxLagMs: 0, maxCpuPct: 0, maxRssMb: 0 };
  const groups = new Map();
  const wsTypes = new Map();
  const clients = new Map();
  const add = (map, key, src) => {
    const e = map.get(key) || {};
    for (const k of Object.keys(src)) e[k] = k === 'msMax' ? Math.max(e[k] || 0, src[k]) : (e[k] || 0) + src[k];
    map.set(key, e);
  };
  for (let t = from; t <= to; t += MINUTE) {
    const b = byT.get(t);
    if (!b) { series.push({ t, requests: 0, bytesIn: 0, bytesOut: 0, wsIn: 0, wsOut: 0, connections: null, lagMaxMs: null, cpuPct: null, rssMb: null }); continue; }
    const g = b.gauges;
    series.push({
      t, requests: b.http.count, bytesIn: b.http.bytesIn + b.ws.bytesIn, bytesOut: b.http.bytesOut + b.ws.bytesOut,
      wsIn: b.ws.in, wsOut: b.ws.out, connections: g.connections, lagMaxMs: g.lagMaxMs, cpuPct: g.cpuPct, rssMb: g.rssMb,
    });
    totals.requests += b.http.count; totals.bytesIn += b.http.bytesIn; totals.bytesOut += b.http.bytesOut;
    totals.wsIn += b.ws.in; totals.wsOut += b.ws.out; totals.wsBytesIn += b.ws.bytesIn; totals.wsBytesOut += b.ws.bytesOut;
    totals.err4 += b.http.err4; totals.err5 += b.http.err5; totals.connects += b.ws.connects; totals.drops += b.ws.drops;
    totals.msSum += b.http.msSum; totals.msMax = Math.max(totals.msMax, b.http.msMax);
    totals.maxConnections = Math.max(totals.maxConnections, g.connections);
    totals.maxLagMs = Math.max(totals.maxLagMs, g.lagMaxMs);
    totals.maxCpuPct = Math.max(totals.maxCpuPct, g.cpuPct);
    totals.maxRssMb = Math.max(totals.maxRssMb, g.rssMb);
    for (const [k, v] of b.groups) add(groups, k, v);
    for (const [k, v] of b.wsTypes) add(wsTypes, k, v);
    for (const [k, v] of b.clients) add(clients, k, v);
  }
  const byTraffic = (a, b) => (b.bytesIn + b.bytesOut) - (a.bytesIn + a.bytesOut);
  return {
    from, to, series, totals,
    avgMs: totals.requests ? Math.round(totals.msSum / totals.requests) : 0,
    groups: [...groups].map(([name, v]) => ({ name, ...v, avgMs: v.count ? Math.round(v.msSum / v.count) : 0 })).sort(byTraffic),
    wsTypes: [...wsTypes].map(([key, v]) => ({ dir: key.split(':')[0], type: key.slice(key.indexOf(':') + 1), ...v })).sort((a, b) => b.bytes - a.bytes),
    clients: [...clients].map(([name, v]) => ({ name, ...v })).sort(byTraffic),
  };
}

// Строка для журнала раз в час: главное одной строкой, чтобы история нагрузки оставалась и после
// перезапуска службы (в памяти хранятся только последние сутки).
function hourSummary(s) {
  const mb = (n) => Math.round(n / 1024 / 1024 * 10) / 10;
  const t = s.totals;
  return {
    requests: t.requests,
    httpMbIn: mb(t.bytesIn), httpMbOut: mb(t.bytesOut),
    wsMessages: t.wsIn + t.wsOut, wsMbIn: mb(t.wsBytesIn), wsMbOut: mb(t.wsBytesOut),
    errors5xx: t.err5, avgMs: s.avgMs, maxMs: Math.round(t.msMax),
    maxConnections: t.maxConnections, drops: t.drops, maxLagMs: t.maxLagMs, maxCpuPct: t.maxCpuPct, maxRssMb: t.maxRssMb,
    topRoutes: s.groups.slice(0, 3).map((g) => `${g.name} ${mb(g.bytesIn + g.bytesOut)} МБ`).join('; '),
    topClients: s.clients.slice(0, 3).map((c) => `${c.name} ${mb(c.bytesIn + c.bytesOut)} МБ`).join('; '),
  };
}

module.exports = { createMetrics, summarize, hourSummary, routeGroup, wsType, MINUTE, KEEP_MINUTES };
