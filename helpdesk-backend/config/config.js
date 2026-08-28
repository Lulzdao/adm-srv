const crypto = require("crypto");

// --- Откуда взялась переменная -------------------------------------------
//
// dotenv НЕ переопределяет то, что уже есть в окружении процесса. Из-за этого
// переменная, однажды заданная в системе (setx, скрипт запуска, вкладка
// Environment в NSSM), продолжает действовать, а в .env её нет — и снаружи это
// выглядит как «путь взялся ниоткуда». Снимок до загрузки .env позволяет
// сказать точно, откуда пришло значение, и не заставлять администратора это
// выяснять.
const beforeDotenv = { ...process.env };
const parsed = require("dotenv").config().parsed || {};

// Пустое значение в .env ОТМЕНЯЕТ переменную окружения. Без этого «TLS_PFX=»
// в файле ничего бы не давало (dotenv пропускает ключ, раз он уже задан), и
// убрать унаследованную переменную можно было бы только через реестр.
for (const [key, value] of Object.entries(parsed)) {
  if (value === "" && process.env[key]) delete process.env[key];
}

/**
 * Откуда пришла переменная: ".env", "система" или null, если её нет вовсе.
 * Нужно ровно для одного — чтобы сообщение об ошибке называло место, где
 * значение правится, а не просто печатало его.
 */
function envSource(name) {
  if (!process.env[name]) return null;
  if (beforeDotenv[name] === process.env[name]) return "система";
  return name in parsed ? ".env" : "система";
}

// Секрет подписи сессионных cookie. Раньше при незаданном SESSION_SECRET
// подставлялась одна и та же строка "dev-secret-change-me" — зная её (а она
// лежала в открытом исходнике), можно подписать себе любую сессию, в том
// числе администраторскую. Теперь при отсутствии переменной берём случайный
// секрет на время работы процесса: подделать нельзя, а платой будет лишь то,
// что после перезапуска сервера всем придётся войти заново — это и есть
// заметный сигнал, что секрет пора прописать в .env.
function sessionSecret() {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return crypto.randomBytes(32).toString("hex");
}

function domainConfig(prefix) {
  return {
    label: process.env[`${prefix}_LABEL`],
    url: process.env[`${prefix}_LDAP_URL`],
    baseDn: process.env[`${prefix}_BASE_DN`],
    svcDn: process.env[`${prefix}_SVC_DN`],
    svcPassword: process.env[`${prefix}_SVC_PASSWORD`],
    adminGroup: process.env[`${prefix}_ADMIN_GROUP`],
  };
}

module.exports = {
  envSource,
  port: process.env.PORT || 3000,
  sessionSecret: sessionSecret(),
  dbPath: process.env.DB_PATH || "./data/helpdesk.db",
  uploadsDir: process.env.UPLOADS_DIR || "./uploads",

  domains: {
    A: domainConfig("DOMAIN_A"),
    B: domainConfig("DOMAIN_B"),
  },

  ldapTlsRejectUnauthorized: process.env.LDAP_TLS_REJECT_UNAUTHORIZED !== "false",

  // Локальные аварийные аккаунты. Логин обязательно начинается с "!" —
  // по этому символу фронтенд отличает локальный вход от доменного и не
  // пытается искать такой логин в LDAP.
  //
  // Адрес почты у них ЗАДАН ЗДЕСЬ, а не берётся из домена. У доменных учёток
  // email приезжает из LDAP при каждом входе, а у локальных никакого LDAP нет
  // по определению: они для того и заведены, чтобы работать, когда домен
  // недоступен. Без адреса пробное письмо из раздела «Оповещения» отправить
  // было некуда, и кнопка «Проверить и отправить себе» упиралась в «у вашей
  // учётной записи не заполнен адрес в домене» — при том, что искать в домене
  // тут нечего.
  localAccounts: [
    {
      login: process.env.LOCAL_ADMIN_LOGIN || "!admin",
      passwordHash: process.env.LOCAL_ADMIN_PASSWORD_HASH || "",
      role: "it",
      fullName: "Локальный администратор",
      email: process.env.LOCAL_ADMIN_EMAIL || "48.11@rosstat.gov.ru",
    },
    {
      login: process.env.LOCAL_USER_LOGIN || "!user",
      passwordHash: process.env.LOCAL_USER_PASSWORD_HASH || "",
      role: "user",
      fullName: "Общая аварийная учётка",
      // По умолчанию пусто: это общая учётка рядовых сотрудников, и слать
      // письма о её заявках в ящик ИТ никто не просил. Задайте переменную,
      // если такое поведение всё-таки нужно.
      email: process.env.LOCAL_USER_EMAIL || "",
    },
  ],

  // Автоопределение домена по подсети клиента — чтобы не показывать
  // пользователю вкладки выбора домена.
  network: {
    domainACidr: process.env.NETWORK_DOMAIN_A_CIDR || "",
    domainBCidr: process.env.NETWORK_DOMAIN_B_CIDR || "",
  },

  sessionMaxAgeDays: Number(process.env.SESSION_MAX_AGE_DAYS) || 30,

  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_SECURE !== "false",
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
    from: process.env.SMTP_FROM || "Служба заявок <helpdesk@localhost>",
  },
};
