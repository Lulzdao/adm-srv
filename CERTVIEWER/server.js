const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Certificate } = require('@fidm/x509');
const { DatabaseSync } = require('node:sqlite');

// ---------- Загрузка .env (без пакета dotenv, простым парсером) ----------
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv();

const PORT = process.env.PORT || 3101;
const DB_PATH = path.join(__dirname, 'certificates.db');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// Секрет подписи сессионной cookie. Фиксированного значения по умолчанию
// быть не должно: оно лежало прямо в исходнике, а зная его, можно подписать
// себе действительную сессию, не зная пароля. Если секрет не задан — берём
// случайный на время работы процесса (после перезапуска все входят заново).
const SESSION_SECRET = (process.env.SESSION_SECRET || '').trim() || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов

// Если true — модуль встроен в общую платформу (хелпдеск) через прокси, и
// платформа уже сама проверила вход по LDAP и роль перед тем, как пропустить
// запрос сюда. Собственный логин/куку-сессию в этом случае отключаем —
// снаружи, помимо платформы, до этого порта всё равно никто не достучится
// (см. BIND_HOST ниже). Пока флаг выключен (по умолчанию) — ничего не
// меняется, модуль работает как раньше, самостоятельно.
const BEHIND_GATEWAY = process.env.BEHIND_GATEWAY === 'true';

// Порт слушаем только на loopback, когда работаем за платформой — снаружи
// сети до него достучаться нельзя, только с самого сервера (то есть только
// сама платформа, которая проксирует запросы). Вне этого режима — как раньше,
// на всех интерфейсах, для прямого автономного использования.
const BIND_HOST = BEHIND_GATEWAY ? '127.0.0.1' : process.env.HOST || '0.0.0.0';

// В автономном режиме модуль слушает всю сеть и сам отвечает за вход, поэтому
// без заданного пароля не запускаемся вовсе. Раньше в этом случае молча
// подставлялся пароль по умолчанию ('change-me') и печаталось предупреждение —
// то есть реестр сертификатов оказывался доступен из сети с общеизвестным
// паролем, если .env забыли создать.
if (!BEHIND_GATEWAY && !ADMIN_PASSWORD) {
  console.error(
    '\n[остановка] ADMIN_PASSWORD не задан, а модуль запускается автономно (BEHIND_GATEWAY=false).\n' +
      'Без пароля веб-интерфейс был бы открыт всей сети. Задайте ADMIN_PASSWORD в .env\n' +
      '(см. .env.example) либо включите BEHIND_GATEWAY=true, если модуль работает за платформой.\n'
  );
  process.exit(1);
}
if (!process.env.SESSION_SECRET && !BEHIND_GATEWAY) {
  console.warn(
    '[внимание] SESSION_SECRET не задан — используется случайный секрет на время работы процесса. ' +
      'После перезапуска сервера потребуется войти заново. Задайте свой секрет в .env.'
  );
}

// ---------- БД ----------
// node:sqlite — встроенный в сам Node.js модуль (без npm-пакета и компиляции),
// доступен без флагов начиная с Node 22.13 / 23.4.
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS certificates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT,
    identifier TEXT,
    valid_from TEXT,
    valid_to TEXT,
    issuer TEXT,
    subject_raw TEXT,
    file_name TEXT,
    uploaded_at TEXT DEFAULT (datetime('now', 'localtime'))
  )
`);

// Миграция для баз, созданных предыдущей версией: добавляем колонки для проверки
// дублей, если их ещё нет (ALTER TABLE ADD COLUMN не трогает существующие данные).
const existingColumns = db.prepare("PRAGMA table_info(certificates)").all().map((c) => c.name);
if (!existingColumns.includes('cert_serial')) {
  db.exec('ALTER TABLE certificates ADD COLUMN cert_serial TEXT');
}
if (!existingColumns.includes('issuer_raw')) {
  db.exec('ALTER TABLE certificates ADD COLUMN issuer_raw TEXT');
}

// Уникальность — по паре "эмитент + серийный номер сертификата". Это настоящий
// уникальный идентификатор в X.509 (в отличие от ФИО или СНИЛС, которые могут
// повторяться при перевыпуске сертификата на того же сотрудника).
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS ux_certificate_identity
  ON certificates(issuer_raw, cert_serial)
`);

const insertStmt = db.prepare(`
  INSERT INTO certificates (full_name, identifier, valid_from, valid_to, issuer, subject_raw, file_name, cert_serial, issuer_raw)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const listStmt = db.prepare('SELECT * FROM certificates ORDER BY id DESC');
const deleteStmt = db.prepare('DELETE FROM certificates WHERE id = ?');

function addCertificate(record) {
  try {
    const info = insertStmt.run(
      record.full_name,
      record.identifier,
      record.valid_from,
      record.valid_to,
      record.issuer,
      record.subject_raw,
      record.file_name,
      record.cert_serial,
      record.issuer_raw
    );
    return { id: Number(info.lastInsertRowid), ...record };
  } catch (err) {
    if (err.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(err.message)) {
      const dup = new Error(`Такой сертификат уже добавлен в реестр (${record.full_name}, серийный номер ${record.cert_serial})`);
      dup.isDuplicate = true;
      throw dup;
    }
    throw err;
  }
}

function listCertificates() {
  return listStmt.all();
}

function deleteCertificate(id) {
  deleteStmt.run(Number(id));
}

// ---------- Парсинг сертификата ----------
// @fidm/x509 используется вместо node-forge, потому что не пытается разбирать сам
// открытый ключ — а значит нормально читает сертификаты КриптоПро на ГОСТ Р 34.10,
// на которых node-forge падает с "OID is not RSA".
function toPem(buffer) {
  const text = buffer.toString('utf8');
  if (text.includes('-----BEGIN CERTIFICATE-----')) return text;
  const b64 = buffer.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

function parseCertificate(buffer, fileName) {
  const cert = Certificate.fromPEM(Buffer.from(toPem(buffer)));

  const getAttr = (dn, shortNameOrOid) =>
    dn.attributes.find((a) => a.shortName === shortNameOrOid || a.oid === shortNameOrOid);

  const surname = getAttr(cert.subject, '2.5.4.4');
  const givenName = getAttr(cert.subject, '2.5.4.42');
  const cn = cert.subject.CN;

  let fullName;
  if (surname || givenName) {
    fullName = [surname?.value, givenName?.value].filter(Boolean).join(' ');
  } else if (cn) {
    fullName = cn;
  } else {
    fullName = '(не найдено)';
  }

  const subjSerial = getAttr(cert.subject, '2.5.4.5');
  const identifier = subjSerial ? subjSerial.value : cert.serialNumber;

  const issuerCn = cert.issuer.CN || getAttr(cert.issuer, '2.5.4.10')?.value;
  const issuerRaw = cert.issuer.attributes.map((a) => `${a.oid}=${a.value}`).join(',');

  return {
    full_name: fullName,
    identifier,
    valid_from: cert.validFrom.toISOString(),
    valid_to: cert.validTo.toISOString(),
    issuer: issuerCn || '(неизвестно)',
    subject_raw: cert.subject.attributes.map((a) => `${a.shortName || a.name}=${a.value}`).join(', '),
    file_name: fileName,
    cert_serial: cert.serialNumber,
    issuer_raw: issuerRaw,
  };
}

// ---------- Сессии на подписанной cookie (без express-session) ----------
// Cookie хранит "username.expiry.подпись". Подпись — HMAC-SHA256 на SESSION_SECRET,
// поэтому подделать или продлить cookie без знания секрета нельзя.
function sign(data) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
}

function createSessionCookieValue(username) {
  const expiry = Date.now() + SESSION_TTL_MS;
  const payload = `${username}.${expiry}`;
  return `${payload}.${sign(payload)}`;
}

function verifySessionCookieValue(value) {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [username, expiry, signature] = parts;
  const payload = `${username}.${expiry}`;
  const expected = sign(payload);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() > Number(expiry)) return null;
  return { username };
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const result = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    result[key] = decodeURIComponent(value);
  }
  return result;
}

// sha256-сравнение вместо прямого — выравнивает длину и снижает риск
// timing-атаки при сравнении пароля.
function safeEquals(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function getSession(req) {
  const cookies = parseCookies(req);
  return verifySessionCookieValue(cookies.session);
}

function requireAuthPage(req, res, next) {
  if (BEHIND_GATEWAY || getSession(req)) return next();
  res.redirect('login');
}

function requireAuthApi(req, res, next) {
  if (BEHIND_GATEWAY || getSession(req)) return next();
  res.status(401).json({ error: 'Требуется вход в систему' });
}

// ---------- Express ----------
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

// Страница логина — доступна без авторизации
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};

  // Пароль не настроен (режим за платформой) — вход по паролю не работает
  // вообще. Без этой проверки пустой ADMIN_PASSWORD совпал бы с пустым
  // паролем в запросе и выдал бы действительную сессию кому угодно.
  if (!ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Собственный вход отключён: модуль работает за платформой' });
  }

  const userOk = typeof username === 'string' && safeEquals(username, ADMIN_USERNAME);
  const passOk = typeof password === 'string' && safeEquals(password, ADMIN_PASSWORD);

  if (userOk && passOk) {
    const cookieValue = createSessionCookieValue(ADMIN_USERNAME);
    res.setHeader(
      'Set-Cookie',
      `session=${encodeURIComponent(cookieValue)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
    );
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Неверный логин или пароль' });
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.redirect('login');
});

// Защищённая страница. Оба адреса — и корень, и прямой /index.html —
// объявлены ДО express.static: опция index:false отключает index.html только
// как индекс каталога, а по прямому адресу статика отдавала его как обычный
// файл, и реестр открывался вообще без входа.
app.get(['/', '/index.html'], requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Остальная статика (стили, скрипты) — без авторизации, там нет данных.
app.use(
  express.static(path.join(__dirname, 'public'), {
    index: false,
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  })
);

// ---------- API (защищено сессией) ----------
app.post('/api/upload', requireAuthApi, upload.array('certificates', 50), (req, res) => {
  const results = [];
  const errors = [];

  for (const file of req.files || []) {
    try {
      const parsed = parseCertificate(file.buffer, file.originalname);
      const saved = addCertificate(parsed);
      results.push(saved);
    } catch (err) {
      errors.push({ file: file.originalname, error: err.message });
    }
  }

  res.json({ inserted: results.length, results, errors });
});

app.get('/api/certificates', requireAuthApi, (req, res) => {
  res.json(listCertificates());
});

app.delete('/api/certificates/:id', requireAuthApi, (req, res) => {
  // Без проверки в запрос уходил NaN (id вида "abc"), и node:sqlite падал
  // пятисоткой вместо понятного ответа.
  if (!/^[1-9]\d{0,17}$/.test(String(req.params.id))) {
    return res.status(400).json({ error: 'Некорректный идентификатор сертификата' });
  }
  deleteCertificate(req.params.id);
  res.json({ ok: true });
});

// Всегда JSON, никогда HTML-страница ошибки по умолчанию — иначе
// фронтенд ловит "Unexpected token '<', "<!DOCTYPE" при попытке
// разобрать HTML как JSON (именно так выглядела эта ошибка на экране).
app.use((err, req, res, next) => {
  console.error('[ошибка]', err);
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Файл больше 5 МБ — такой сертификат не принимается' });
  }
  if (err && err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'Неверное имя поля с файлом при загрузке' });
  }
  res.status(500).json({ error: (err && err.message) || 'Внутренняя ошибка сервера' });
});

app.listen(PORT, BIND_HOST, () => {
  console.log(`Сервер запущен: http://${BIND_HOST}:${PORT}${BEHIND_GATEWAY ? ' (только для платформы, за прокси)' : ''}`);
});
