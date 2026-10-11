'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Outbox = require('./renderer/outbox');

// localStorage в миниатюре: те же четыре метода и length, что использует модуль.
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
}
const NOW = 1_800_000_000_000;
const msg = (text, ageMs = 0, extra = {}) => ({ payload: { type: 'send', to: 5, text, ...extra }, at: NOW - ageMs });

test('неотправленное переживает закрытие окна: записали — прочитали то же самое', () => {
  const s = fakeStorage(); const key = Outbox.outboxKey(2, 'dm', 5);
  Outbox.write(s, key, [msg('привет'), msg('', 0, { files: [{ url: '/uploads/a.pdf', name: 'a.pdf', size: 10 }] })]);
  const back = Outbox.read(s, key);
  assert.strictEqual(back.length, 2);
  assert.strictEqual(back[0].payload.text, 'привет');
  assert.strictEqual(back[1].payload.files[0].name, 'a.pdf');
  Outbox.write(s, key, []);
  assert.strictEqual(s.getItem(key), null, 'пустая очередь ключ не оставляет');
});

test('из хранилища берётся только похожее на сообщение', () => {
  const key = Outbox.outboxKey(2, 'dm', 5);
  const bad = [
    { payload: { type: 'react', to: 5, text: 'x' }, at: NOW },   // не сообщение
    { payload: { type: 'send', text: 'без адресата' }, at: NOW },
    { payload: { type: 'send', to: 5, text: '   ' }, at: NOW },  // пустое
    { payload: { type: 'send', to: 5, text: 'без времени' } },
    null, 'строка', 42,
  ];
  assert.deepStrictEqual(Outbox.read(fakeStorage({ [key]: JSON.stringify([...bad, msg('годное')]) }), key).map((x) => x.payload.text), ['годное']);
  assert.deepStrictEqual(Outbox.read(fakeStorage({ [key]: '{не json' }), key), []);
  assert.deepStrictEqual(Outbox.read(fakeStorage({ [key]: '{"a":1}' }), key), []);
});

test('список отправляет сам только диалоги без открытого окна', () => {
  const s = fakeStorage();
  Outbox.write(s, Outbox.outboxKey(2, 'dm', 5), [msg('окно закрыто')]);
  Outbox.write(s, Outbox.outboxKey(2, 'dm', 7), [msg('окно открыто')]);
  Outbox.write(s, Outbox.outboxKey(2, 'room', 'group:3'), [msg('окно упало', 0, { to: undefined, room: 'group:3' })]);
  Outbox.write(s, Outbox.outboxKey(9, 'dm', 5), [msg('чужая учётка на этом же ПК')]);
  s.setItem(Outbox.ownerKey(2, 'dm', 7), String(NOW - 2000));                             // окно живо
  s.setItem(Outbox.ownerKey(2, 'room', 'group:3'), String(NOW - Outbox.OWNER_STALE_MS - 1)); // отметка протухла
  const got = Outbox.collectClosed(s, 2, NOW).map((d) => d.send.map((x) => x.payload.text)).flat().sort();
  assert.deepStrictEqual(got, ['окно закрыто', 'окно упало'], 'открытый чат отправит сам; чужая учётка не трогается');
});

test('давнее само не уходит — остаётся ждать человека', () => {
  const s = fakeStorage(); const key = Outbox.outboxKey(2, 'dm', 5);
  Outbox.write(s, key, [msg('вчерашнее', Outbox.AUTO_SEND_MAX_AGE_MS + 60000), msg('свежее', 60000)]);
  const [d] = Outbox.collectClosed(s, 2, NOW);
  assert.deepStrictEqual(d.send.map((x) => x.payload.text), ['свежее']);
  assert.deepStrictEqual(d.keep.map((x) => x.payload.text), ['вчерашнее']);
  Outbox.write(s, key, [msg('только старое', Outbox.AUTO_SEND_MAX_AGE_MS + 1)]);
  assert.deepStrictEqual(Outbox.collectClosed(s, 2, NOW), [], 'нечего отправлять — диалог в список не попадает');
});

test('очередь одного диалога не растёт без предела', () => {
  const s = fakeStorage(); const key = Outbox.outboxKey(2, 'dm', 5);
  Outbox.write(s, key, Array.from({ length: Outbox.MAX_ITEMS + 20 }, (_, i) => msg('№' + i)));
  const back = Outbox.read(s, key);
  assert.strictEqual(back.length, Outbox.MAX_ITEMS);
  assert.strictEqual(back[back.length - 1].payload.text, '№' + (Outbox.MAX_ITEMS + 19), 'остаются последние');
});
