const { Client } = require("ldapts");
const config = require("../config/config");

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

  const svcClient = new Client({
    url: cfg.url,
    tlsOptions: { rejectUnauthorized: config.ldapTlsRejectUnauthorized },
    connectTimeout: 5000,
  });

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
  const userClient = new Client({
    url: cfg.url,
    tlsOptions: { rejectUnauthorized: config.ldapTlsRejectUnauthorized },
    connectTimeout: 5000,
  });
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

  const inGroup = (name) => name && memberOf.some((dn) => dn.toLowerCase().includes(`cn=${name.toLowerCase()}`));

  // Порядок в config/departments.js — это и порядок приоритета: первое
  // совпадение побеждает (обычно "it" стоит первым, чтобы сотрудник,
  // случайно оказавшийся в двух группах, получил более широкую роль).
  let role = "user";
  for (const dept of departments) {
    // Для роли it совместимость: если новую группу под неё ещё не задали
    // через панель администрирования, используем старое поле из .env.
    const groupName = (db && getSetting(db, `${dept.role}_group_${domainKey}`))
      || (dept.role === "it" ? cfg.adminGroup : null);
    if (inGroup(groupName)) { role = dept.role; break; }
  }

  return {
    login,
    domain: domainKey,
    fullName: singleValue(userEntry.displayName) || login,
    email: singleValue(userEntry.mail),
    department: singleValue(userEntry.department),
    phone: singleValue(userEntry.telephoneNumber),
    role,
  };
}

function normalizeMemberOf(memberOf) {
  if (!memberOf) return [];
  return Array.isArray(memberOf) ? memberOf : [memberOf];
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

module.exports = { authenticate, LdapAuthError };
