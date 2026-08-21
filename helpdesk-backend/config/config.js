require("dotenv").config();

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
  port: process.env.PORT || 3000,
  sessionSecret: process.env.SESSION_SECRET || "dev-secret-change-me",
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
  localAccounts: [
    {
      login: process.env.LOCAL_ADMIN_LOGIN || "!admin",
      passwordHash: process.env.LOCAL_ADMIN_PASSWORD_HASH || "",
      role: "it",
      fullName: "Локальный администратор",
    },
    {
      login: process.env.LOCAL_USER_LOGIN || "!user",
      passwordHash: process.env.LOCAL_USER_PASSWORD_HASH || "",
      role: "user",
      fullName: "Общая аварийная учётка",
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
