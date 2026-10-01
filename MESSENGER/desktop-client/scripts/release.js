// Выпуск новой версии клиента одной командой:
//
//   npm run release              поднять последнюю цифру (1.0.0 → 1.0.1) и собрать
//   npm run release -- minor     1.0.3 → 1.1.0
//   npm run release -- major     1.4.2 → 2.0.0
//   npm run release -- 1.2.0     задать версию явно
//   npm run release -- same      пересобрать с текущим номером (первый выпуск; уже выложенный
//                                номер сервер повторно не примет)
//
// Что делает: поднимает version в package.json и package-lock.json, собирает обе сборки
// (Windows 7/8.1 и Windows 10+) и складывает готовое в ОДНУ папку:
//
//   release/<версия>/iskra-setup-win7-<версия>.exe  (+ .exe.blockmap)   latest-win7.yml
//   release/<версия>/iskra-setup-win10-<версия>.exe (+ .exe.blockmap)   latest-win10.yml
//
// Эти шесть файлов выбираются разом в панели «Искры»: «Клиенты» → «Выложить новую версию».
// Панель сама поймёт, где какая сборка (по содержимому latest-….yml), а сервер сверит
// контрольные суммы. Папка release/ в git не попадает.
//
// После выпуска закоммитьте package.json и package-lock.json: номер версии — часть исходников,
// клиенты сравнивают именно его.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkgFile = path.join(root, 'package.json');
const lockFile = path.join(root, 'package-lock.json');
const TRACKS = ['win7', 'win10'];

function nextVersion(current, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [a, b, c] = current.split('.').map(Number);
  if (how === 'same') return current;
  if (how === 'major') return `${a + 1}.0.0`;
  if (how === 'minor') return `${a}.${b + 1}.0`;
  if (how === 'patch') return `${a}.${b}.${c + 1}`;
  throw new Error(`Не понял «${how}»: patch (по умолчанию), minor, major, same или номер вида 1.2.3`);
}

/** Поменять version, не переформатируя файл: правится только первая строка "version". */
function setVersion(file, version) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  let n = 0;
  // В package-lock.json номер пакета записан дважды: в корне и в packages[""] — обе в начале файла.
  const limit = path.basename(file) === 'package-lock.json' ? 2 : 1;
  const out = text.replace(/("version":\s*")\d+\.\d+\.\d+(")/g, (m, p1, p2) => (n++ < limit ? `${p1}${version}${p2}` : m));
  fs.writeFileSync(file, out);
}

function main() {
  const how = process.argv[2] || 'patch';
  const current = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version;
  const version = nextVersion(current, how);
  console.log(`Версия клиента: ${current} → ${version}`);

  const saved = { pkg: fs.readFileSync(pkgFile, 'utf8'), lock: fs.existsSync(lockFile) ? fs.readFileSync(lockFile, 'utf8') : null };
  setVersion(pkgFile, version);
  setVersion(lockFile, version);

  try {
    for (const track of TRACKS) {
      console.log(`\n== Сборка ${track}`);
      // Прежние файлы этой сборки убираем: в dist/<сборка> должен остаться ровно один выпуск.
      fs.rmSync(path.join(root, 'dist', track), { recursive: true, force: true });
      execSync(`npm run dist:${track}`, { cwd: root, stdio: 'inherit' });
    }
  } catch (err) {
    // Сборка не удалась — номер версии возвращаем: иначе следующий запуск перепрыгнул бы через него.
    fs.writeFileSync(pkgFile, saved.pkg);
    if (saved.lock !== null) fs.writeFileSync(lockFile, saved.lock);
    console.error(`\nСборка не удалась, версия возвращена к ${current}.`);
    process.exit(1);
  }

  const out = path.join(root, 'release', version);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const track of TRACKS) {
    const exe = `iskra-setup-${track}-${version}.exe`;
    const dist = path.join(root, 'dist', track);
    for (const f of [exe, `${exe}.blockmap`]) fs.copyFileSync(path.join(dist, f), path.join(out, f));
    // Два latest.yml в одной папке — под разными именами; сборку панель узнаёт по содержимому.
    fs.copyFileSync(path.join(dist, 'latest.yml'), path.join(out, `latest-${track}.yml`));
  }

  console.log(`\nГотово: версия ${version}, обе сборки — в папке\n  ${out}`);
  for (const f of fs.readdirSync(out)) console.log(`    ${f}  (${(fs.statSync(path.join(out, f)).size / 1048576).toFixed(1)} МБ)`);
  console.log('\nДальше: панель «Искры» → «Клиенты» → «Выложить новую версию» → выбрать все шесть файлов из этой папки.');
  if (version !== current) console.log('И закоммитьте package.json и package-lock.json — номер версии часть исходников.');
}

if (require.main === module) main();
module.exports = { nextVersion };
