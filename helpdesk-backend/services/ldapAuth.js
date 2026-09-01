const { Client } = require("ldapts");
const config = require("../config/config");

// Настройки подключения к контроллеру домена.
//
// tlsOptions передаём ТОЛЬКО для ldaps://. Библиотека решает, шифровать ли
// соединение, так: this.secure = isSecureProtocol || hasTlsOptions — то есть
// один лишь факт наличия tlsOptions включает TLS, даже если в URL стоит
// открытая схема ldap://. Для домена на ldap://…:389 это означало, что мы
// отправляли в незашифрованный порт TLS ClientHello; контроллер видел мусор
// вместо LDAP-запроса и рвал соединение, а наружу это выходило неотличимо от
// сетевой аварии: "read ECONNRESET" при bind.
function clientOptions(url) {
  const opts = { url, connectTimeout: 5000 };
  if (/^ldaps:/i.test(url)) {
    opts.tlsOptions = { rejectUnauthorized: config.ldapTlsRejectUnauthorized };
  }
  return opts;
}

/**
 * Аутентификация сотрудника через LDAP-контроллер одного из доменов.
 *
 * Поток:
 *  1. Биндимся сервисной учёткой (только чтение) — она нужна, чтобы ИСКАТЬ
 *     пользователя по логину до того, как мы знаем его полный DN.
 *  2. Находим DN и атрибуты пользователя (ФИО, email, memberOf).
 *  3. Биндимся под самим пользователем его паролем — это и есть проверка
 *     пароля. Если DC отклонит bind, значит пароль неверный.
 *  4. Смотрим, входит ли пользователь в группу-администратор ЭТОГО домена
 *     (у каждого домена своё имя группы, см. .env).
 *
 * Пароли сотрудников нигде не сохраняются и не логируются.
 */
async function authenticate(domainKey, login, password, db) {
  const cfg = config.domains[domainKey];
  if (!cfg || !cfg.url) {
    throw new LdapAuthError("CONFIG_MISSING", `Домен "${domainKey}" не настроен`);
  }
  if (!login || !password) {
    throw new LdapAuthError("BAD_INPUT", "Логин и пароль обязательны");
  }

  const svcClient = new Client(clientOptions(cfg.url));

  let userEntry;
  try {
    try {
      await svcClient.bind(cfg.svcDn, cfg.svcPassword);
    } catch (err) {
      throw new LdapAuthError("DC_UNAVAILABLE", `Контроллер домена ${cfg.label} недоступен или сервисная учётка неверна`, err);
    }

    let searchEntries;
    try {
      ({ searchEntries } = await svcClient.search(cfg.baseDn, {
        scope: "sub",
        filter: `(sAMAccountName=${escapeLdapFilter(login)})`,
        attributes: ["dn", "displayName", "mail", "department", "memberOf", "telephoneNumber"],
      }));
    } catch (err) {
      // Частая причина именно для новых/только что включённых учёток:
      // объект ещё не реплицировался на контроллер, к которому мы
      // подключены (DC вернул referral вместо результата поиска).
      throw new LdapAuthError("SEARCH_FAILED", `Ошибка поиска пользователя в домене ${cfg.label}: ${err.message}`, err);
    }

    if (searchEntries.length === 0) {
      throw new LdapAuthError("USER_NOT_FOUND", "Пользователь с таким логином не найден в домене");
    }
    userEntry = searchEntries[0];
  } finally {
    await svcClient.unbind().catch(() => {});
  }

  // Проверка пароля — отдельное подключение под самим пользователем.
  const userClient = new Client(clientOptions(cfg.url));
  try {
    await userClient.bind(userEntry.dn, password);
  } catch (err) {
    throw new LdapAuthError("BAD_CREDENTIALS", "Неверный логин или пароль");
  } finally {
    await userClient.unbind().catch(() => {});
  }

  const memberOf = normalizeMemberOf(userEntry.memberOf);
  const { getSetting } = require("./settings");
  const departments = require("../config/departments");

  const inGroup = (name) => isMemberOfGroup(memberOf, name);

  // Порядок в config/departments.js — это и порядок приоритета: первое
  // совпадение побеждает (обычно "it" стоит первым, чтобы сотрудник,
  // случайно оказавшийся в двух группах, получил более широкую роль).
  // Признак администратора выводится ТОЛЬКО из группы в .env. Через панель
  // администрирования его выдать нельзя — там настраиваются группы отделов, и
  // это разные ключи. Иначе получалось так: добавили в панели группу к отделу
  // ИТ — и её участники стали администраторами платформы; хуже того, значение
  // из панели ЗАМЕЩАЛО группу из .env (там стоял ||), и настоящие
  // администраторы могли разом лишиться прав.
  const isAdmin = inGroup(cfg.adminGroup);

  // Отделов у исполнителя может быть НЕСКОЛЬКО. Раньше цикл выходил по первому
  // совпадению, и сотрудник, состоящий и в группе ИТ, и в группе ХОЗ, видел
  // очередь только того отдела, что стоит раньше в config/departments.js —
  // заявки второго до него просто не доходили.
  //
  // Группа отдела ИТ значит ровно то, чем выглядит: исполнители ИТ, без
  // каких-либо прав администратора.
  const roles = [];
  for (const dept of departments) {
    const groupName = db && getSetting(db, `${dept.role}_group_${domainKey}`);
    if (inGroup(groupName)) roles.push(dept.role);
  }
  // role — первый по порядку из config/departments.js. Нужен там, где отдел
  // должен быть один: подпись в интерфейсе, префикс, «основной» отдел.
  const role = roles[0] || "user";

  return {
    login,
    domain: domainKey,
    fullName: singleValue(userEntry.displayName) || login,
    email: singleValue(userEntry.mail),
    department: singleValue(userEntry.department),
    phone: singleValue(userEntry.telephoneNumber),
    role,
    roles,
    isAdmin,
  };
}

function normalizeMemberOf(memberOf) {
  if (!memberOf) return [];
  return Array.isArray(memberOf) ? memberOf : [memberOf];
}

/**
 * Состоит ли пользователь в группе с точно таким именем.
 *
 * Сравнивается первый компонент DN (CN=...) целиком, а не ищется подстрока.
 * Прежняя проверка (`dn.includes("cn=" + name)`) выдавала лишние права: при
 * группе администраторов "Otdel-IT" под условие попадала любая группа, чей DN
 * просто содержит эти символы, — например "CN=Otdel-IT-Praktikanty" или
 * вложенная "OU=...,CN=Otdel-IT-Arhiv". Регистр не важен (AD его не различает).
 */
function isMemberOfGroup(memberOf, groupName) {
  if (!groupName) return false;
  const target = String(groupName).trim().toLowerCase();
  if (!target) return false;

  return normalizeMemberOf(memberOf).some((dn) => {
    // Компоненты DN разделяются запятой, но запятая внутри самого имени
    // экранируется обратным слэшем ("CN=Иванов\, Иван,OU=...").
    const rdn = String(dn).split(/(?<!\\),/)[0].trim();
    if (!rdn.toLowerCase().startsWith("cn=")) return false;
    return rdn.slice(3).replace(/\\(.)/g, "$1").trim().toLowerCase() === target;
  });
}

// ldapts не всегда "схлопывает" одиночное значение атрибута в строку —
// иногда отдаёт массив из одного элемента даже для однозначных атрибутов
// вроде mail/department/telephoneNumber. Если положить такой массив прямо
// в SQLite-параметр, node:sqlite падает с TypeError (принимает только
// null/строку/число/bigint/Buffer). Приводим всё к определённому виду:
// строка или null, никогда не массив/undefined.
function singleValue(v) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.length ? String(v[0]) : null;
  return String(v);
}

// Минимальное экранирование спецсимволов LDAP-фильтра (RFC 4515),
// чтобы логин с ( ) \ * или NUL не сломал и не расширил поисковый фильтр.
function escapeLdapFilter(value) {
  return String(value).replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

class LdapAuthError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "LdapAuthError";
    this.code = code; // CONFIG_MISSING | BAD_INPUT | DC_UNAVAILABLE | USER_NOT_FOUND | BAD_CREDENTIALS
    this.cause = cause;
  }
}

module.exports = { authenticate, clientOptions, LdapAuthError, isMemberOfGroup };
