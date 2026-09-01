// Диагностика подключения к AD, шаг за шагом.
// Это ДИАГНОСТИЧЕСКАЯ утилита, а не тест. Раньше файл назывался
// test-ldap.js, и встроенный запускатель тестов (node --test) подхватывал
// его как набор тестов: он честно пытался соединиться с контроллером
// домена и падал на любой машине, где домена нет.
//
//
// Использование:
//   node scripts/check-ldap.js A                      — проверить сеть + bind сервисной учётки для домена А
//   node scripts/check-ldap.js A d.volkov              — плюс поиск конкретного пользователя и его memberOf
//   node scripts/check-ldap.js A d.volkov "пароль"     — плюс полная проверка входа этим пользователем
//
// Если сертификат AD CS не проходит проверку доверия, повторите с флагом:
//   node --use-system-ca scripts/check-ldap.js A
// (тот же флаг уже используется в "npm start", см. package.json)
//
// Каждый шаг печатается отдельно с ОК/ОШИБКА, чтобы сразу было видно,
// где именно рвётся: сеть, TLS-сертификат, сервисная учётка или сам bind.

require("dotenv").config();
const net = require("net");
const tls = require("tls");
const { Client } = require("ldapts");
const { clientOptions } = require("../services/ldapAuth");
const config = require("../config/config");

const domainKey = process.argv[2];
const testLogin = process.argv[3];
const testPassword = process.argv[4];

if (!domainKey || !["A", "B"].includes(domainKey)) {
  console.error("Укажите домен: node scripts/check-ldap.js A|B [логин] [пароль]");
  process.exit(1);
}

const cfg = config.domains[domainKey];
const ok = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => console.log(`  ❌ ${msg}`);
const step = (n, title) => console.log(`\n${n}. ${title}`);

function parseUrl(url) {
  const m = /^(ldaps?):\/\/([^:/]+):?(\d+)?/.exec(url || "");
  if (!m) return null;
  const proto = m[1];
  return { proto, host: m[2], port: m[3] ? Number(m[3]) : (proto === "ldaps" ? 636 : 389) };
}

async function testTcp(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    socket.on("connect", () => { socket.destroy(); resolve({ ok: true }); });
    socket.on("timeout", () => { socket.destroy(); resolve({ ok: false, error: `таймаут ${timeoutMs}мс — порт не отвечает` }); });
    socket.on("error", (err) => resolve({ ok: false, error: err.message }));
  });
}

async function testTls(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, timeout: timeoutMs, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      const authorized = socket.authorized;
      const authError = socket.authorizationError;
      socket.destroy();
      resolve({ ok: true, authorized, authError, subject: cert && cert.subject, validTo: cert && cert.valid_to });
    });
    socket.on("timeout", () => { socket.destroy(); resolve({ ok: false, error: `таймаут ${timeoutMs}мс` }); });
    socket.on("error", (err) => resolve({ ok: false, error: err.message }));
  });
}

async function main() {
  console.log(`\n=== Диагностика LDAP: ${cfg.label || domainKey} ===`);
  console.log(`URL: ${cfg.url || "(не задан в .env)"}`);
  console.log(`Base DN: ${cfg.baseDn || "(не задан)"}`);
  console.log(`Сервисная учётка: ${cfg.svcDn || "(не задана)"}`);
  console.log(`Admin-группа: ${cfg.adminGroup || "(не задана)"}`);

  if (!cfg.url || !cfg.baseDn) {
    fail("В .env не заполнены DOMAIN_" + domainKey + "_LDAP_URL / DOMAIN_" + domainKey + "_BASE_DN");
    process.exit(1);
  }

  const parsed = parseUrl(cfg.url);
  if (!parsed) {
    fail(`Не удалось разобрать URL "${cfg.url}". Ожидается формат ldap://host:port или ldaps://host:port`);
    process.exit(1);
  }

  // 1. DNS + TCP
  step(1, `Сетевая доступность ${parsed.host}:${parsed.port}`);
  const tcp = await testTcp(parsed.host, parsed.port);
  if (tcp.ok) {
    ok(`TCP-соединение установлено`);
  } else {
    fail(`Не удалось подключиться: ${tcp.error}`);
    console.log(`\n  Проверьте на самом сервере (не в этом скрипте, а вручную в PowerShell):`);
    console.log(`    Test-NetConnection -ComputerName ${parsed.host} -Port ${parsed.port}`);
    console.log(`    nslookup ${parsed.host}`);
    console.log(`  Если nslookup не резолвит имя — либо опечатка в DOMAIN_${domainKey}_LDAP_URL,`);
    console.log(`  либо сервер не видит DNS этого домена (нужен forwarding или IP вместо имени).`);
    console.log(`  Если DNS резолвит, но порт не отвечает — проверьте firewall на самом DC`);
    console.log(`  (порт 389/636 должен быть открыт для адреса вашего сервера) и локальный`);
    console.log(`  firewall/антивирус (KSC) на сервере с приложением — не блокирует ли исходящее.`);
    process.exit(1);
  }

  // 2. TLS (если ldaps)
  if (parsed.proto === "ldaps") {
    step(2, `TLS-рукопожатие и сертификат`);
    const t = await testTls(parsed.host, parsed.port);
    if (t.ok) {
      ok(`TLS установлен, сертификат действителен до ${t.validTo}`);
      if (!t.authorized) {
        fail(`Сертификат НЕ прошёл проверку доверия: ${t.authError}`);
        console.log(`  Node.js не использует хранилище сертификатов Windows по умолчанию —`);
        console.log(`  у него свой встроенный список CA, независимый от системного.`);
        console.log(`  Варианты, по приоритету:`);
        console.log(`  а) запустить с флагом --use-system-ca (уже включён в "npm start" —`);
        console.log(`     если видите эту ошибку именно через этот скрипт, повторите:`);
        console.log(`     node --use-system-ca scripts/check-ldap.js ${domainKey} ${testLogin || ""}`);
        console.log(`     Сработает, если сервер в домене и сертификат уже в доверенных Windows.`);
        console.log(`  б) экспортировать корневой/промежуточный сертификат AD CS в .pem и указать`);
        console.log(`     путь в NODE_EXTRA_CA_CERTS в .env;`);
        console.log(`  в) временно, только для теста, LDAP_TLS_REJECT_UNAUTHORIZED=false в .env`);
        console.log(`     (НЕ оставлять так в проде — отключает проверку сертификата совсем).`);
      } else {
        ok(`Сертификат прошёл проверку доверия`);
      }
    } else {
      fail(`TLS-соединение не установилось: ${t.error}`);
      console.log(`  Возможно, на этом порту вообще не TLS (перепутали 389 и 636),`);
      console.log(`  либо DC требует более новую версию протокола/шифры.`);
      process.exit(1);
    }
  } else {
    console.log(`\n2. TLS пропущен (используется незашифрованный ldap://) — пароли будут идти открытым текстом по сети.`);
    console.log(`   Рекомендуется переключиться на ldaps://<host>:636, если сертификат AD CS уже есть.`);
  }

  // 3. Bind сервисной учёткой
  step(3, `Bind сервисной учёткой (${cfg.svcDn || "не задана"})`);
  if (!cfg.svcDn || !cfg.svcPassword) {
    fail(`DOMAIN_${domainKey}_SVC_DN или DOMAIN_${domainKey}_SVC_PASSWORD пусты в .env`);
    process.exit(1);
  }
  // Те же настройки подключения, что у самой службы (см. clientOptions в ldapAuth).
  const client = new Client(clientOptions(cfg.url));
  try {
    await client.bind(cfg.svcDn, cfg.svcPassword);
    ok(`Bind успешен`);
  } catch (err) {
    fail(`Bind не удался: ${err.message}`);
    if (/ECONNRESET|EPIPE/i.test(err.message)) {
      console.log(`  Соединение оборвано, а не отвергнуто — это НЕ похоже на неверный пароль:`);
      console.log(`  на неверные учётные данные DC отвечает ошибкой 49 (invalidCredentials).`);
      console.log(`  Проверьте, что схема в URL совпадает с портом (ldap:// — 389, ldaps:// — 636),`);
      console.log(`  и что между сервером и DC нет фильтрации, рвущей сессию на первом пакете.`);
    }
    console.log(`  Частые причины:`);
    console.log(`  — неверный формат DN (проверьте точное написание OU= и DC= через ADUC → свойства учётки → Attribute Editor → distinguishedName);`);
    console.log(`  — неверный пароль сервисной учётки, либо пароль истёк / требует смены при следующем входе;`);
    console.log(`  — учётка заблокирована или отключена.`);
    process.exit(1);
  }

  // 4. Поиск пользователя (если указан)
  if (testLogin) {
    step(4, `Поиск пользователя "${testLogin}" в base DN`);
    try {
      const { searchEntries } = await client.search(cfg.baseDn, {
        scope: "sub",
        filter: `(sAMAccountName=${testLogin})`,
        attributes: ["dn", "displayName", "mail", "memberOf", "userAccountControl"],
      });
      if (searchEntries.length === 0) {
        fail(`Пользователь не найден. Проверьте: правильный ли baseDn (${cfg.baseDn}),`);
        console.log(`  и что у сервисной учётки есть право чтения этого поддерева.`);
      } else {
        const u = searchEntries[0];
        ok(`Найден: ${u.dn}`);
        console.log(`     displayName: ${u.displayName || "—"}`);
        console.log(`     mail: ${u.mail || "—"}`);
        const memberOf = Array.isArray(u.memberOf) ? u.memberOf : (u.memberOf ? [u.memberOf] : []);
        console.log(`     memberOf (${memberOf.length}):`);
        memberOf.forEach((g) => console.log(`       - ${g}`));
        const adminGroup = cfg.adminGroup;
        const isAdmin = adminGroup && memberOf.some((dn) => dn.toLowerCase().includes(`cn=${adminGroup.toLowerCase()}`));
        console.log(`     Входит в admin-группу "${adminGroup}"? ${isAdmin ? "ДА" : "нет"}`);

        // 5. Полная проверка пароля, если он передан
        if (testPassword) {
          step(5, `Проверка пароля пользователя (bind под ${u.dn})`);
          const userClient = new Client({ url: cfg.url, tlsOptions: { rejectUnauthorized: config.ldapTlsRejectUnauthorized }, connectTimeout: 5000 });
          try {
            await userClient.bind(u.dn, testPassword);
            ok(`Пароль верный, вход прошёл бы успешно`);
          } catch (err) {
            fail(`Bind под пользователем не удался: ${err.message}`);
          } finally {
            await userClient.unbind().catch(() => {});
          }
        }
      }
    } catch (err) {
      fail(`Ошибка поиска: ${err.message}`);
    }
  } else {
    console.log(`\n(Чтобы проверить конкретного пользователя, добавьте логин: node scripts/check-ldap.js ${domainKey} d.volkov)`);
  }

  await client.unbind().catch(() => {});
  console.log("\n=== Готово ===\n");
}

main().catch((err) => {
  console.error("\nНеожиданная ошибка скрипта:", err);
  process.exit(1);
});
