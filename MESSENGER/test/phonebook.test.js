'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { buildIndex } = require('../lib/phonebook');
const { startServer, request, login, makeUser, ADMIN } = require('./helpers/server');

// ============================================================================
//  Номер сотрудника из справочника журнала звонков (lib/phonebook.js)
//
//  Связи по id нет — сопоставление по ФИО: полное или «фамилия + инициалы», регистр, точки и «ё» не
//  важны. Неоднозначное (две «Петровы И. Н.») — без номера: лучше без номера, чем чужой.
// ============================================================================

test('сопоставление ФИО: полное, инициалы, ё, несколько номеров, неоднозначность', () => {
  const phoneOf = buildIndex([
    { ext: '215', fio: 'Петров Игорь Николаевич' },
    { ext: '101', fio: 'Голубева Ж.А.' },
    { ext: '102', fio: 'голубева ж. а.' },
    { ext: '300', fio: 'Семёнов Пётр Ильич' },
    { ext: '401', fio: 'Иванов Андрей Петрович' },
    { ext: '402', fio: 'Иванов Алексей Павлович' },
    { ext: 'abc', fio: 'Кривой Номер' },
  ]);
  assert.equal(phoneOf('Петров Игорь Николаевич'), '215');
  assert.equal(phoneOf('Голубева Жанна Александровна'), '101, 102', 'два добавочных у одного человека');
  assert.equal(phoneOf('Семенов Петр Ильич'), '300', 'ё и е — одно');
  assert.equal(phoneOf('Иванов Андрей Петрович'), '401', 'полное ФИО различает тёзок по инициалам');
  assert.equal(phoneOf('Иванов Аркадий Павлович'), null, '«Иванов А. П.» — двое в справочнике: номера нет');
  assert.equal(phoneOf('Кривой Номер'), null, 'добавочный не из цифр не берём');
  assert.equal(phoneOf('admin'), null);
});

let srv, smdr, admin, петров;
before(async () => {
  smdr = http.createServer((req, res) => {
    if (req.url !== '/api/directory') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ ext: '215', fio: 'Петров И.Н.' }]));
  });
  await new Promise((r) => smdr.listen(0, '127.0.0.1', r));
  srv = await startServer({ env: { SMDR_DIRECTORY_URL: `http://127.0.0.1:${smdr.address().port}/api/directory` } });
  admin = await login(srv.url, ADMIN.username, ADMIN.password);
  петров = await makeUser(srv.url, admin.token, 'петров-телефон');
  assert.equal((await request(srv.url, 'PATCH', '/api/me', { token: петров.token, body: { display_name: 'Петров Игорь Николаевич' } })).status, 200);
});
after(() => { if (srv) srv.stop(); if (smdr) smdr.close(); });

test('список сотрудников несёт номер из справочника', async () => {
  const r = await request(srv.url, 'GET', '/api/users', { token: admin.token });
  assert.equal(r.status, 200);
  const p = r.json.find((u) => u.id === петров.id);
  assert.equal(p.phone, '215');
  assert.equal(r.json.find((u) => u.username === ADMIN.username).phone, undefined, 'нет в справочнике — нет и поля');
});
