const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================================
//  Версии клиента: выкладка, откат и скачивание из панели (раздел «Клиенты»)
//
//  Раньше новую версию выкладывали руками: три файла (установщик, .blockmap,
//  latest.yml) копировали в updates/win7 и updates/win10 на сервере. Здесь то же
//  самое делается из панели — и с проверками, которых при копировании не было.
//
//  Раскладка на диске прежняя, клиенты ничего не заметят:
//    updates/<сборка>/iskra-setup-<сборка>-<версия>.exe      установщик
//    updates/<сборка>/iskra-setup-<сборка>-<версия>.exe.blockmap  карта блоков
//    updates/<сборка>/latest.yml          что клиенты считают текущей версией
//    updates/<сборка>/latest-<версия>.yml копия latest.yml этой версии — по ней
//                                         версию можно снова сделать текущей
//    updates-staging/<сборка>/…           загруженное, но ещё не выложенное.
//    updates-staging/<сборка>/latest-<версия>.yml — собрано на самом сервере
//                                         (deploy\build-iskra-client.cmd): скрипт
//                                         кладёт сюда установщик, карту блоков и
//                                         latest.yml, а панель показывает версию
//                                         готовой к выкладке — без выбора файлов.
//                                         РЯДОМ с updates, а не внутри: всё, что
//                                         внутри, раздаётся клиентам без входа.
//                                         (Папку с точкой в имени express.static
//                                         раздаёт — он прячет только файлы с
//                                         точкой; на этом тест и поймал первую
//                                         версию.)
//
//  ВЫКЛАДКА — ЭТО ЗАПУСК ПРОГРАММЫ НА ВСЕХ ПК. Клиенты сами скачают и поставят
//  то, что здесь объявлено текущим. Поэтому:
//   - установщик принимается, только если его sha512 и размер совпали с
//     latest.yml, который записал electron-builder (битый или подменённый по
//     дороге файл не выложится);
//   - имя файла — строго iskra-setup-<сборка>-<версия>.exe, и сборка в имени
//     должна совпасть с папкой: установщик win10 в win7 сломал бы клиентов;
//   - выкладка и смена текущей версии требуют пароль администратора заново —
//     чужого открытого окна панели или украденного токена мало;
//   - всё пишется в журнал сервера с тем, кто это сделал.
// ============================================================================

const TRACKS = ['win7', 'win10'];
const MAX_INSTALLER_BYTES = 600 * 1024 * 1024;
const MAX_BLOCKMAP_BYTES = 5 * 1024 * 1024;
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
// Собранное на сервере ждёт выкладки дольше: его собирают заранее, а выкладывают, когда удобно.
const READY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

const exeName = (track, version) => `iskra-setup-${track}-${version}.exe`;
const parseExeName = (name) => {
  const m = /^iskra-setup-(win7|win10)-(\d+\.\d+\.\d+)\.exe(\.blockmap)?$/.exec(String(name || ''));
  return m ? { track: m[1], version: m[2], blockmap: Boolean(m[3]) } : null;
};

/** -1 / 0 / 1 — сравнение версий вида 1.2.3. */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1; }
  return 0;
}

/**
 * Что записано в latest.yml. Полноценный разбор YAML ради четырёх полей не
 * нужен: файл пишет electron-builder, и вид у него всегда один.
 */
function parseLatestYml(text) {
  const t = String(text || '');
  const field = (name) => { const m = new RegExp(`^${name}:\\s*'?([^'\\r\\n]+)'?\\s*$`, 'm').exec(t); return m ? m[1].trim() : null; };
  const size = /^\s+size:\s*(\d+)\s*$/m.exec(t);
  return { version: field('version'), path: field('path'), sha512: field('sha512'), size: size ? Number(size[1]) : null, releaseDate: field('releaseDate') };
}

function sha512File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('base64')));
  });
}

function createReleases({ updatesDir, logServer }) {
  const stagingRoot = path.join(path.dirname(updatesDir), 'updates-staging');
  const trackDir = (track) => path.join(updatesDir, track);
  const stagingDir = (track) => path.join(stagingRoot, track);

  const readYml = (file) => { try { return parseLatestYml(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const currentOf = (track) => {
    const y = readYml(path.join(trackDir(track), 'latest.yml'));
    return y && y.version ? y : null;
  };

  /** Копия latest.yml текущей версии — чтобы к ней можно было вернуться (для выложенного руками). */
  function rememberCurrent(track) {
    const cur = currentOf(track);
    if (!cur || !VERSION_RE.test(cur.version)) return;
    const copy = path.join(trackDir(track), `latest-${cur.version}.yml`);
    if (!fs.existsSync(copy)) { try { fs.copyFileSync(path.join(trackDir(track), 'latest.yml'), copy); } catch { /* только чтение — не беда */ } }
  }

  function sweepStaging() {
    for (const track of TRACKS) {
      let names = [];
      try { names = fs.readdirSync(stagingDir(track)); } catch { continue; }
      // Версии, собранные на сервере (рядом лежит их latest-<версия>.yml), живут дольше.
      const ready = new Set(names.map((n) => (/^latest-(\d+\.\d+\.\d+)\.yml$/.exec(n) || [])[1]).filter(Boolean));
      for (const n of names) {
        const f = path.join(stagingDir(track), n);
        const version = (parseExeName(n) || {}).version || (/^latest-(\d+\.\d+\.\d+)\.yml$/.exec(n) || [])[1];
        const ttl = version && ready.has(version) ? READY_TTL_MS : STAGING_TTL_MS;
        try { if (Date.now() - fs.statSync(f).mtimeMs > ttl) fs.unlinkSync(f); } catch { /* занят — в другой раз */ }
      }
    }
  }

  /**
   * Версии, собранные на сервере и готовые к выкладке: в updates-staging/<сборка> лежат
   * latest-<версия>.yml, установщик и карта блоков, и версия новее текущей. Контрольную сумму
   * здесь не считаем (сотни мегабайт на каждое открытие панели) — её сверяет сама выкладка.
   */
  function readyOf(track) {
    let names = [];
    try { names = fs.readdirSync(stagingDir(track)); } catch { return []; }
    const cur = currentOf(track);
    const out = [];
    for (const n of names) {
      const m = /^latest-(\d+\.\d+\.\d+)\.yml$/.exec(n);
      if (!m) continue;
      const y = readYml(path.join(stagingDir(track), n));
      if (!y || y.version !== m[1] || y.path !== exeName(track, m[1])) continue;
      if (fs.existsSync(path.join(trackDir(track), y.path))) continue; // уже выложена
      if (cur && VERSION_RE.test(cur.version) && compareVersions(y.version, cur.version) <= 0) continue;
      const exe = path.join(stagingDir(track), y.path);
      if (!fs.existsSync(exe) || !fs.existsSync(`${exe}.blockmap`)) continue;
      const st = fs.statSync(exe);
      out.push({ version: y.version, size: st.size, built: st.mtime.toISOString() });
    }
    return out.sort((a, b) => compareVersions(b.version, a.version));
  }

  function describe(track) {
    rememberCurrent(track);
    const cur = currentOf(track);
    let names = [];
    try { names = fs.readdirSync(trackDir(track)); } catch { /* папки ещё нет */ }
    const versions = [];
    for (const n of names) {
      const p = parseExeName(n);
      if (!p || p.blockmap || p.track !== track) continue;
      const st = fs.statSync(path.join(trackDir(track), n));
      versions.push({
        version: p.version, file: n, size: st.size, modified: st.mtime.toISOString(),
        hasBlockmap: names.includes(`${n}.blockmap`),
        // Без своей копии latest.yml версию нельзя снова объявить текущей — неоткуда взять контрольную сумму.
        canMakeCurrent: names.includes(`latest-${p.version}.yml`),
        current: Boolean(cur && cur.version === p.version),
      });
    }
    versions.sort((a, b) => compareVersions(b.version, a.version));
    let staged = [];
    try { staged = fs.readdirSync(stagingDir(track)).filter((n) => parseExeName(n)); } catch { /* пусто */ }
    return { current: cur ? { version: cur.version, file: cur.path, releaseDate: cur.releaseDate } : null, versions, staged, ready: readyOf(track) };
  }

  /**
   * Выложить версию сборки track по её latest.yml: установщик и карта блоков уже лежат в
   * updates-staging/<сборка>. Сверяет имя, номер, размер и sha512 и объявляет версию текущей.
   * Возвращает { ok } или { status, error }. Пароль проверяет вызывающий.
   */
  async function publish(track, ymlText, req) {
    const fail = (status, error) => ({ status, error });
    const y = parseLatestYml(ymlText);
    if (!y.version || !y.path || !y.sha512 || !VERSION_RE.test(y.version)) {
      return fail(400, 'Это не latest.yml от сборщика: в нём должны быть version, path и sha512');
    }
    const named = parseExeName(y.path);
    if (!named || named.blockmap || named.track !== track || named.version !== y.version) {
      return fail(400, `latest.yml описывает «${y.path}» — это не установщик сборки ${track} версии ${y.version}. Возьмите latest.yml из папки dist/${track}`);
    }
    const cur = currentOf(track);
    if (fs.existsSync(path.join(trackDir(track), y.path))) {
      return fail(409, `Версия ${y.version} уже выложена. Клиенты сравнивают номер версии — исправление выпускают под новым номером`);
    }
    if (cur && VERSION_RE.test(cur.version) && compareVersions(y.version, cur.version) < 0) {
      return fail(409, `Версия ${y.version} старше текущей ${cur.version}: клиенты назад не обновляются. Чтобы остановить раздачу текущей, сделайте текущей одну из прежних версий в списке`);
    }

    const stagedExe = path.join(stagingDir(track), y.path);
    const stagedMap = `${stagedExe}.blockmap`;
    if (!fs.existsSync(stagedExe)) return fail(400, `Сначала загрузите установщик ${y.path}`);
    if (!fs.existsSync(stagedMap)) {
      return fail(400, `Нужен и файл ${y.path}.blockmap: без него каждый клиент скачает установщик целиком вместо изменившихся кусков`);
    }
    const size = fs.statSync(stagedExe).size;
    if (y.size && y.size !== size) return fail(400, `Размер установщика ${size} не совпал с latest.yml (${y.size}) — файл загрузился не полностью или это другая сборка`);
    let sum;
    try { sum = await sha512File(stagedExe); } catch (err) { return fail(500, `Не удалось прочитать установщик: ${err.message}`); }
    if (sum !== y.sha512) {
      return fail(400, 'Контрольная сумма установщика не совпала с latest.yml: файл повреждён или взят из другой сборки. Загрузите все три файла из одной папки dist');
    }

    try {
      fs.mkdirSync(trackDir(track), { recursive: true });
      rememberCurrent(track);
      fs.renameSync(stagedExe, path.join(trackDir(track), y.path));
      fs.renameSync(stagedMap, path.join(trackDir(track), `${y.path}.blockmap`));
      fs.writeFileSync(path.join(trackDir(track), `latest-${y.version}.yml`), ymlText);
      // latest.yml — последним и через переименование: клиент не увидит ни полфайла, ни версию
      // без установщика.
      const tmp = path.join(trackDir(track), `latest.yml.${crypto.randomBytes(4).toString('hex')}.tmp`);
      fs.writeFileSync(tmp, ymlText);
      fs.renameSync(tmp, path.join(trackDir(track), 'latest.yml'));
    } catch (err) {
      logServer('ERROR', 'release_publish_failed', { adminId: req.user.id, track, version: y.version, message: err.message });
      return fail(500, `Не удалось выложить: ${err.message}`);
    }
    logServer('INFO', 'release_published', { adminId: req.user.id, admin: req.user.username, track, version: y.version, previous: cur ? cur.version : null, size, ip: req.ip });
    // Свой latest-<версия>.yml собранного на сервере больше не нужен: версия выложена.
    fs.rmSync(path.join(stagingDir(track), `latest-${y.version}.yml`), { force: true });
    return { ok: true };
  }

  function registerRoutes(app, { auth, requireCapability, confirmPassword }) {
    const admin = [auth, requireCapability('can_admin')];
    const trackOf = (req, res) => {
      if (TRACKS.includes(req.params.track)) return req.params.track;
      res.status(400).json({ error: 'Сборка — win7 или win10' });
      return null;
    };

    app.get('/api/admin/releases', ...admin, (req, res) => {
      sweepStaging();
      res.json(Object.fromEntries(TRACKS.map((t) => [t, describe(t)])));
    });

    // Проверка пароля ДО загрузки: иначе опечатка в пароле выяснялась бы после того, как на
    // сервер ушли сотни мегабайт установщика. Сама выкладка проверяет пароль ещё раз.
    app.post('/api/admin/releases/confirm', ...admin, (req, res) => {
      const denied = confirmPassword(req, (req.body || {}).password);
      if (denied) return res.status(denied.status).json({ error: denied.error });
      res.json({ ok: true });
    });

    // Загрузка одного файла (установщик или его .blockmap) во временную папку — потоком на диск,
    // без буфера в памяти: установщик весит сотни мегабайт. Клиентам он ещё не виден.
    app.put('/api/admin/releases/:track/upload', ...admin, (req, res) => {
      const track = trackOf(req, res); if (!track) return;
      const parsed = parseExeName(req.query.name);
      if (!parsed) return res.status(400).json({ error: 'Имя файла должно быть вида iskra-setup-win10-1.2.3.exe (или .exe.blockmap) — как его назвал сборщик' });
      if (parsed.track !== track) {
        return res.status(400).json({ error: `Это файл сборки ${parsed.track}, а загружается в ${track}. Сборки нельзя путать: чужая у клиентов не запустится` });
      }
      const limit = parsed.blockmap ? MAX_BLOCKMAP_BYTES : MAX_INSTALLER_BYTES;
      if (Number(req.headers['content-length'] || 0) > limit) return res.status(413).json({ error: `Файл больше ${Math.round(limit / 1048576)} МБ` });

      fs.mkdirSync(stagingDir(track), { recursive: true });
      const dest = path.join(stagingDir(track), String(req.query.name));
      const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.part`;
      const out = fs.createWriteStream(tmp);
      let size = 0; let failed = false;
      const fail = (status, error) => {
        if (failed) return; failed = true;
        req.unpipe(out); out.destroy();
        fs.rm(tmp, { force: true }, () => {});
        if (!res.headersSent) res.status(status).json({ error });
      };
      req.on('data', (chunk) => { size += chunk.length; if (size > limit) fail(413, `Файл больше ${Math.round(limit / 1048576)} МБ`); });
      req.on('aborted', () => fail(400, 'Загрузка прервана'));
      req.on('error', () => fail(400, 'Загрузка прервана'));
      out.on('error', (err) => fail(500, `Не удалось записать файл: ${err.message}`));
      out.on('finish', () => {
        if (failed) return;
        if (!size) return fail(400, 'Пустой файл');
        try { fs.renameSync(tmp, dest); } catch (err) { return fail(500, `Не удалось сохранить файл: ${err.message}`); }
        res.json({ ok: true, name: req.query.name, size });
      });
      req.pipe(out);
    });

    // Выложить загруженное: сверить с latest.yml и объявить текущей версией.
    app.post('/api/admin/releases/:track/publish', ...admin, async (req, res) => {
      const track = trackOf(req, res); if (!track) return;
      const denied = confirmPassword(req, (req.body || {}).password);
      if (denied) return res.status(denied.status).json({ error: denied.error });

      const result = await publish(track, String((req.body || {}).yml || ''), req);
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.json({ ok: true, ...describe(track) });
    });

    // Выложить версию, собранную на самом сервере (deploy\build-iskra-client.cmd): все её сборки
    // разом, одним паролем. latest.yml берётся из updates-staging — его туда положил скрипт сборки
    // из папки electron-builder; проверки те же, что у загрузки из панели (имя, размер, sha512).
    app.post('/api/admin/releases/publish-ready', ...admin, async (req, res) => {
      const version = String((req.body || {}).version || '');
      if (!VERSION_RE.test(version)) return res.status(400).json({ error: 'Не указана версия' });
      const tracks = TRACKS.filter((t) => readyOf(t).some((r) => r.version === version));
      if (!tracks.length) return res.status(404).json({ error: `Собранной на сервере версии ${version} нет — запустите сборку (deploy\\build-iskra-client.cmd)` });
      const denied = confirmPassword(req, (req.body || {}).password);
      if (denied) return res.status(denied.status).json({ error: denied.error });

      const done = [];
      for (const track of tracks) {
        const ymlText = fs.readFileSync(path.join(stagingDir(track), `latest-${version}.yml`), 'utf8');
        const result = await publish(track, ymlText, req);
        if (result.error) {
          const prefix = done.length ? `Выложено: ${done.join(', ')}. ` : '';
          return res.status(result.status).json({ error: `${prefix}Сборка ${track}: ${result.error}`, published: done });
        }
        done.push(track);
      }
      res.json({ ok: true, published: done, ...Object.fromEntries(TRACKS.map((t) => [t, describe(t)])) });
    });

    // Сделать текущей уже выложенную версию (остановить раздачу неудачной).
    app.post('/api/admin/releases/:track/current', ...admin, async (req, res) => {
      const track = trackOf(req, res); if (!track) return;
      const denied = confirmPassword(req, (req.body || {}).password);
      if (denied) return res.status(denied.status).json({ error: denied.error });
      const version = String((req.body || {}).version || '');
      if (!VERSION_RE.test(version)) return res.status(400).json({ error: 'Не указана версия' });
      const copy = path.join(trackDir(track), `latest-${version}.yml`);
      const y = readYml(copy);
      const exe = path.join(trackDir(track), exeName(track, version));
      if (!y || !fs.existsSync(exe)) return res.status(404).json({ error: `Версии ${version} на сервере нет (или у неё нет своего latest.yml)` });
      if (await sha512File(exe) !== y.sha512) return res.status(409).json({ error: `Установщик версии ${version} на диске не совпадает со своей контрольной суммой — выкладывать его нельзя` });
      const cur = currentOf(track);
      rememberCurrent(track);
      const tmp = path.join(trackDir(track), `latest.yml.${crypto.randomBytes(4).toString('hex')}.tmp`);
      fs.copyFileSync(copy, tmp);
      fs.renameSync(tmp, path.join(trackDir(track), 'latest.yml'));
      logServer('INFO', 'release_current_changed', { adminId: req.user.id, admin: req.user.username, track, version, previous: cur ? cur.version : null, ip: req.ip });
      res.json({ ok: true, ...describe(track) });
    });

    app.delete('/api/admin/releases/:track/:version', ...admin, (req, res) => {
      const track = trackOf(req, res); if (!track) return;
      const version = String(req.params.version);
      if (!VERSION_RE.test(version)) return res.status(400).json({ error: 'Не указана версия' });
      const cur = currentOf(track);
      if (cur && cur.version === version) return res.status(409).json({ error: 'Текущую версию удалить нельзя: клиенты качают именно её. Сначала сделайте текущей другую' });
      const exe = path.join(trackDir(track), exeName(track, version));
      if (!fs.existsSync(exe)) return res.status(404).json({ error: `Версии ${version} на сервере нет` });
      for (const f of [exe, `${exe}.blockmap`, path.join(trackDir(track), `latest-${version}.yml`)]) fs.rmSync(f, { force: true });
      logServer('INFO', 'release_deleted', { adminId: req.user.id, admin: req.user.username, track, version, ip: req.ip });
      res.json({ ok: true, ...describe(track) });
    });
  }

  return { registerRoutes, describe };
}

module.exports = { createReleases, TRACKS };
