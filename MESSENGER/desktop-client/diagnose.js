// Почему не удалось достучаться до сервера.
//
// Модуль намеренно ничего не знает ни про Electron, ни про настройки клиента: на входе адрес и
// список корневых сертификатов, которые видит система, на выходе — код причины. Благодаря этому
// его можно прогнать настоящими TLS-серверами в тесте (см. diagnose.test.js рядом), а не
// проверять догадки на живом домене.

const http = require('http');
const https = require('https');

const CERT_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_UNTRUSTED', 'CERT_SIGNATURE_FAILURE',
]);

function probeServer(rawUrl, options) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(String(rawUrl).replace(/\/+$/, '') + '/api/ping'); } catch { return resolve({ code: 'bad-url' }); }
    const secure = url.protocol === 'https:';
    const lib = secure ? https : http;
    const req = lib.request(url, { method: 'GET', timeout: 6000, ...options }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 4096) body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ code: 'http-status', status: res.statusCode });
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* не JSON — значит по адресу не Искра */ }
        if (!parsed || parsed.app !== 'iskra') return resolve({ code: 'not-iskra', status: res.statusCode });
        resolve({ code: 'ok' });
      });
    });
    // 'timeout' сам соединение не рвёт — надо закрывать руками, иначе обещание повиснет до
    // системного таймаута TCP (на Windows это около двадцати секунд).
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => resolve({ code: 'net', netCode: err.code || err.message, message: err.message }));
    req.end();
  });
}

// Что именно мешает войти. Возвращается { code, detail } — расшифровка кода в понятный текст
// живёт в окне (см. описание отказа на экране входа в roster.html): здесь мы отвечаем на вопрос
// «что не так», а как об этом сказать сотруднику — дело интерфейса.
async function diagnoseServer(url, systemCa) {
  const secure = /^https:/i.test(url);

  // Явный список ca отключает нашу подмену createSecureContext (она вмешивается только когда
  // вызывающий свой список не задал) — то есть это честная проверка глазами системы.
  const system = await probeServer(url, secure ? { ca: systemCa } : undefined);
  if (system.code === 'ok') return { code: 'ok', url, secure };

  const certProblem = system.code === 'net' && (CERT_ERROR_CODES.has(system.netCode) || /^ERR_TLS/.test(String(system.netCode)));
  if (certProblem) {
    const app = await probeServer(url);
    if (app.code === 'ok') return { code: 'ca-missing-in-system', url, secure, detail: system.netCode };
    // Сертификат негоден и с нашими корнями — значит дело в нём самом, а не в хранилище.
    if (system.netCode === 'CERT_HAS_EXPIRED') return { code: 'cert-expired', url, secure, detail: system.netCode };
    if (system.netCode === 'ERR_TLS_CERT_ALTNAME_INVALID') return { code: 'cert-name', url, secure, detail: system.netCode };
    return { code: 'cert-untrusted', url, secure, detail: system.netCode };
  }

  if (system.code === 'net') {
    const map = {
      ENOTFOUND: 'dns', EAI_AGAIN: 'dns',
      ECONNREFUSED: 'refused',
      ETIMEDOUT: 'timeout', ESOCKETTIMEDOUT: 'timeout',
      EHOSTUNREACH: 'unreachable', ENETUNREACH: 'unreachable',
      ECONNRESET: 'reset', EPIPE: 'reset',
      EPROTO: 'protocol', ERR_SSL_WRONG_VERSION_NUMBER: 'protocol',
      CERT_HAS_EXPIRED: 'cert-expired', CERT_NOT_YET_VALID: 'cert-expired',
    };
    return { code: map[system.netCode] || 'unknown', url, secure, detail: system.netCode };
  }
  return { ...system, url, secure };
}


module.exports = { diagnoseServer, probeServer, CERT_ERROR_CODES };
