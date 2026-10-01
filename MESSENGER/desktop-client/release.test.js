// Номер следующей версии для `npm run release` (scripts/release.js).
// Запуск:  node --test  (из папки desktop-client)
const test = require('node:test');
const assert = require('node:assert');
const { nextVersion } = require('./scripts/release');

test('patch / minor / major / same / явный номер', () => {
  assert.strictEqual(nextVersion('1.0.9', 'patch'), '1.0.10');
  assert.strictEqual(nextVersion('1.4.2', 'minor'), '1.5.0');
  assert.strictEqual(nextVersion('1.4.2', 'major'), '2.0.0');
  assert.strictEqual(nextVersion('1.4.2', 'same'), '1.4.2');
  assert.strictEqual(nextVersion('1.4.2', '3.0.1'), '3.0.1');
  assert.throws(() => nextVersion('1.0.0', 'чуть-чуть'), /Не понял/);
});
