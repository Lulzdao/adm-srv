// Разбор машинной политики C:\ProgramData\Iskra\config.json — отдельно от main.js, чтобы проверять
// его обычными тестами без Electron (см. policy.test.js). Что это за файл и зачем — в комментарии
// у readMachinePolicy в main.js.

const EMPTY = Object.freeze({ serverUrl: null, allowInsecureHttp: false, extraCa: [], source: null });

/**
 * @param raw       текст файла (как прочитан с диска) или null, если файла нет
 * @param readFile  (путь) => текст — для extraCaFiles; бросает, если файла нет
 * @param source    путь к файлу политики — для журнала и диагностики
 * @returns { policy, error } — error задан, если файл есть, но прочитать его нельзя. Тогда policy
 *          пустая: полуразобранной политике верить нельзя.
 */
function parseMachinePolicy(raw, readFile, source) {
  if (raw === null || raw === undefined) return { policy: EMPTY, error: null };

  // Метка BOM в начале. Её ставят Блокнот Windows 7 при сохранении «в UTF-8» и Windows PowerShell 5.1
  // (Set-Content/Out-File -Encoding UTF8) — то есть как раз то, чем такой файл обычно и готовят.
  // JSON.parse на ней падает, и раньше политика молча не действовала вовсе: клиент уходил на адрес
  // из сборки, а в журнале не было ни строчки о том, почему.
  const text = String(raw).replace(/^\uFEFF/, '');

  let cfg;
  try { cfg = JSON.parse(text); } catch (err) {
    return { policy: EMPTY, error: `не JSON: ${err.message}` };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { policy: EMPTY, error: 'ожидался объект { ... }' };

  const extraCa = [];
  // Корни можно задать и текстом прямо в файле, и путями к .crt — второе удобнее для GPO,
  // которая обычно кладёт рядом готовые файлы.
  for (const pem of [].concat(cfg.extraCaPem || [])) {
    if (typeof pem === 'string' && pem.includes('BEGIN CERTIFICATE')) extraCa.push(pem);
  }
  for (const file of [].concat(cfg.extraCaFiles || [])) {
    if (typeof file !== 'string') continue;
    try { extraCa.push(readFile(file)); } catch { /* файла нет — пропускаем */ }
  }

  return {
    policy: {
      serverUrl: typeof cfg.serverUrl === 'string' && cfg.serverUrl.trim() ? cfg.serverUrl.trim() : null,
      // Работа без шифрования — только явным решением администратора и только через политику.
      // Автоматического отката при ошибке сертификата нет намеренно: иначе любой в сети смог бы
      // уронить TLS и заставить клиентов самих перейти на открытый канал.
      allowInsecureHttp: cfg.allowInsecureHttp === true,
      extraCa,
      source,
    },
    error: null,
  };
}

module.exports = { parseMachinePolicy, EMPTY };
