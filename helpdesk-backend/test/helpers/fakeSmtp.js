'use strict';

const net = require("node:net");

// ============================================================================
//  Поддельный SMTP-приёмник
//
//  Нужен, чтобы проверять отправку по-настоящему, а не подменять nodemailer
//  заглушкой. Подмена доказывала бы только то, что мы позвали функцию; здесь
//  же проверяется весь путь — сборка письма, кодировка темы, адреса в конверте.
//
//  Реализован на голом net: поднимать зависимость ради теста незачем, а из
//  протокола нужны ровно пять команд.
// ============================================================================

function decodeHeader(value) {
  // Тема с кириллицей уезжает как =?UTF-8?B?...?= — раскодируем, иначе в
  // проверках пришлось бы сравнивать base64, и упавший тест ничего бы не сказал.
  //
  // Кусков бывает несколько подряд: RFC ограничивает закодированное слово 75
  // символами. Собираем их байты ВМЕСТЕ и декодируем один раз — многобайтная
  // буква может оказаться разрезанной между кусками, и подекодный разбор дал бы
  // «мусорный» символ на стыке.
  const parts = [...String(value).matchAll(/=\?UTF-8\?B\?([^?]+)\?=/gi)];
  if (!parts.length) return String(value);
  return Buffer.concat(parts.map((m) => Buffer.from(m[1], "base64"))).toString("utf8");
}

function decodeBody(lines, encoding) {
  const raw = lines.join("\n");
  if (/base64/i.test(encoding || "")) {
    return Buffer.from(lines.join(""), "base64").toString("utf8");
  }
  if (/quoted-printable/i.test(encoding || "")) {
    return raw.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) =>
      String.fromCharCode(parseInt(h, 16)));
  }
  return raw;
}

/**
 * Поднять приёмник на свободном порту.
 * Возвращает { port, messages, reset, close }.
 * messages — массив { to: [], subject, body }.
 */
async function startFakeSmtp({ rejectRecipient = null } = {}) {
  const messages = [];

  const server = net.createServer((sock) => {
    let buf = "";
    let inData = false;
    let current = { to: [], subject: "", headers: {}, bodyLines: [], lastHeader: "" };
    let inHeaders = true;

    sock.write("220 fake.test ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            inHeaders = true;
            messages.push({
              to: current.to,
              subject: decodeHeader(current.subject),
              body: decodeBody(current.bodyLines, current.headers["content-transfer-encoding"]),
            });
            current = { to: [], subject: "", headers: {}, bodyLines: [], lastHeader: "" };
            sock.write("250 OK\r\n");
            continue;
          }
          if (inHeaders) {
            if (line === "") { inHeaders = false; continue; }
            // Длинный заголовок переносится на следующие строки, и они
            // начинаются с пробела. Тема с кириллицей уезжает несколькими
            // закодированными кусками по 75 символов — читая только первую
            // строку, мы получали бы обрезанную тему и ложно падающий тест.
            if (/^[ \t]/.test(line)) {
              if (current.lastHeader === "subject") current.subject += line.trim();
              continue;
            }
            const m = line.match(/^([\w-]+):\s*(.*)$/);
            if (m) {
              const key = m[1].toLowerCase();
              current.lastHeader = key;
              current.headers[key] = m[2];
              if (key === "subject") current.subject = m[2];
            }
            continue;
          }
          current.bodyLines.push(line);
          continue;
        }

        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO") || cmd.startsWith("HELO")) sock.write("250-fake.test\r\n250 8BITMIME\r\n");
        else if (cmd.startsWith("MAIL FROM")) sock.write("250 OK\r\n");
        else if (cmd.startsWith("RCPT TO")) {
          const addr = line.replace(/.*<|>.*/g, "");
          // Отказ по конкретному адресу — так проверяется путь «сервер отверг
          // получателя», который в коде помечается как неповторяемый.
          if (rejectRecipient && addr === rejectRecipient) {
            sock.write("550 5.1.1 mailbox unavailable\r\n");
          } else {
            current.to.push(addr);
            sock.write("250 OK\r\n");
          }
        }
        else if (cmd === "DATA") { inData = true; sock.write("354 End data\r\n"); }
        else if (cmd === "QUIT") { sock.write("221 Bye\r\n"); sock.end(); }
        else sock.write("250 OK\r\n");
      }
    });
    sock.on("error", () => { /* оборванное соединение теста не касается */ });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: server.address().port,
    messages,
    reset() { messages.length = 0; },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}

module.exports = { startFakeSmtp };
