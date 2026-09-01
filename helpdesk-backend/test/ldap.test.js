const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { Client } = require("ldapts");
const { clientOptions } = require("../services/ldapAuth");

// ---------------------------------------------------------------------------
//  Схема в URL решает, шифровать ли соединение
//
//  ldapts включает TLS не только по схеме ldaps://, но и по одному лишь факту
//  наличия tlsOptions. Мы передавали их всегда — и на домен, настроенный как
//  ldap://…:389, уходил TLS ClientHello вместо LDAP-запроса. Контроллер рвал
//  соединение, а мы видели "read ECONNRESET" и искали причину в сети.
//
//  Проверяем не форму настроек, а то, что реально уходит в сокет: первый байт
//  LDAP-сообщения — 0x30 (SEQUENCE), первый байт TLS-рукопожатия — 0x16.
// ---------------------------------------------------------------------------

// Слушает порт, отдаёт первый байт, который прислал клиент, и рвёт сессию.
function первыйБайт(t) {
  let resolveByte;
  const получен = new Promise((r) => { resolveByte = r; });
  const server = net.createServer((sock) => {
    sock.once("data", (buf) => { resolveByte(buf[0]); sock.resetAndDestroy(); });
  });
  t.after(() => new Promise((r) => server.close(r)));
  return new Promise((ready) => {
    server.listen(0, "127.0.0.1", () => ready({ port: server.address().port, получен }));
  });
}

test("на ldap:// клиент отправляет LDAP-запрос, а не TLS-рукопожатие", async (t) => {
  const { port, получен } = await первыйБайт(t);
  const client = new Client(clientOptions(`ldap://127.0.0.1:${port}`));
  await client.bind("кто-то", "пароль").catch(() => {});

  assert.strictEqual(await получен, 0x30,
    "в незашифрованный порт 389 обязан уйти BindRequest (0x30); 0x16 означает, что мы шлём туда TLS");
});

test("на ldaps:// соединение шифруется", async (t) => {
  const { port, получен } = await первыйБайт(t);
  const client = new Client(clientOptions(`ldaps://127.0.0.1:${port}`));
  await client.bind("кто-то", "пароль").catch(() => {});

  assert.strictEqual(await получен, 0x16,
    "для ldaps:// первым делом должно идти TLS-рукопожатие");
});

test("проверка сертификата для ldaps:// не отключена по умолчанию", () => {
  const opts = clientOptions("ldaps://dc.example.local:636");
  assert.strictEqual(opts.tlsOptions.rejectUnauthorized, true,
    "иначе домен, настроенный на ldaps, принимал бы любой сертификат");
  assert.strictEqual(clientOptions("ldap://dc.example.local:389").tlsOptions, undefined);
});
