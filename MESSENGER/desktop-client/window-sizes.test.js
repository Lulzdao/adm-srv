'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dropStaleWindowSizes, sizesFromCurrentDefaults } = require('./window-sizes');

const sizes = { rosterSize: { width: 500, height: 600 }, chatSize: { width: 420, height: 520 }, broadcastSize: { width: 420, height: 520 } };

test('размеры от прежней «Искры» (1.1.1.0, mini-messenger, без версии) выбрасываются', () => {
  for (const lastSeenVersion of ['1.1.1', '1.0.16', null, undefined]) {
    const out = dropStaleWindowSizes({ ...sizes, lastSeenVersion, theme: 'dark' });
    assert.deepEqual([out.rosterSize, out.chatSize, out.broadcastSize], [null, null, null], String(lastSeenVersion));
    assert.equal(out.theme, 'dark', 'прочие настройки не трогаются');
    assert.equal(out.windowSizesChecked, true);
  }
});

test('размеры, подогнанные в новой версии, остаются; проверка делается один раз', () => {
  const kept = dropStaleWindowSizes({ ...sizes, lastSeenVersion: '1.0.28' });
  assert.deepEqual(kept.chatSize, sizes.chatSize);
  const again = dropStaleWindowSizes({ ...sizes, lastSeenVersion: '1.1.1', windowSizesChecked: true });
  assert.deepEqual(again.chatSize, sizes.chatSize, 'после отметки — не трогаем, что бы ни было');
  assert.equal(sizesFromCurrentDefaults('1.0.17'), true);
});
