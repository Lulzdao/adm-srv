'use strict';

const http = require("node:http");

// ============================================================================
//  Поддельные модули — Сертвивер и журнал звонков
//
//  Планировщик тянет данные по HTTP с 127.0.0.1. Подменять moduleClient
//  заглушкой значило бы не проверить ровно то, ради чего он написан: разбор
//  ответа, обработку недоступности и неверного содержимого. Поэтому поднимаем
//  настоящие HTTP-серверы на свободных портах.
//
//  Все данные здесь ВЫДУМАННЫЕ. Настоящих сертификатов и доверенностей в
//  тестах быть не должно ни в каком виде.
// ============================================================================

/** Дата через n дней от полуночи сегодня, в виде YYYY-MM-DD. */
function inDays(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Сертвивер: отдаёт то, что ему положили. Позволяет менять данные между
 * обходами — так проверяется поведение при «прошло время» и при исправлении
 * срока задним числом.
 */
async function startFakeCertviewer(initial = {}) {
  const state = {
    certificates: initial.certificates || [],
    attorneys: initial.attorneys || [],
    fail: false,        // имитация лежащего модуля
    garbage: false,     // имитация ответа не-JSON (страница логина)
  };

  const server = http.createServer((req, res) => {
    if (state.fail) { req.socket.destroy(); return; }
    if (state.garbage) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!DOCTYPE html><html><body>Вход</body></html>");
      return;
    }
    const send = (obj) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/api/certificates") return send(state.certificates);
    if (p === "/api/mchd") return send(state.attorneys);
    res.writeHead(404); res.end("{}");
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    state,
    close() { return new Promise((r) => server.close(r)); },
  };
}

/** Журнал звонков: одна ручка со сводкой по внутренним номерам. */
async function startFakeSmdr(rows = null) {
  const state = {
    rows: rows || [
      { ext: "101", fio: "Пробников П. П.", outgoing: 120, outgoingSeconds: 74400 },
      { ext: "102", fio: "Тестова Т. Т.", outgoing: 87, outgoingSeconds: 42600 },
    ],
    fail: false,
    seen: [],   // какие диапазоны дат запрашивали — проверяем границы месяца
  };

  const server = http.createServer((req, res) => {
    if (state.fail) { req.socket.destroy(); return; }
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/stats/table") {
      state.seen.push({ from: u.searchParams.get("date_from"), to: u.searchParams.get("date_to") });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state.rows));
      return;
    }
    res.writeHead(404); res.end("[]");
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    state,
    close() { return new Promise((r) => server.close(r)); },
  };
}

/** Выдуманный сертификат для реестра. */
const certificate = ({ id = 1, name = "Пробников Пробник Пробникович", days = 40,
                       serial = "AA01", uploadedDaysAgo = 200, issuer = "CN=Тестовый УЦ" } = {}) => ({
  id,
  full_name: name,
  identifier: "00000000000",
  valid_from: inDays(-365),
  valid_to: inDays(days) + "T00:00:00.000Z",
  issuer,
  issuer_raw: issuer,
  cert_serial: serial,
  file_name: "test.cer",
  uploaded_at: inDays(-uploadedDaysAgo),
});

/** Выдуманная доверенность для реестра. */
const attorney = ({ id = 1, name = "Доверов Доверитель Доверович", days = 15,
                    uuid = "00000000-1111-2222-3333-444444444444", uploadedDaysAgo = 30 } = {}) => ({
  id,
  uuid,
  reg_number: "000000000000000001",
  full_name: name,
  valid_from: inDays(-100),
  valid_to: inDays(days),
  signed: 1,
  source_format: "ЕИС",
  file_name: "test.zip",
  uploaded_at: inDays(-uploadedDaysAgo),
});

module.exports = { startFakeCertviewer, startFakeSmdr, certificate, attorney, inDays };
