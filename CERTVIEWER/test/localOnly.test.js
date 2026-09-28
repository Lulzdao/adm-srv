'use strict';

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { localOnly, hostName } = require("../localOnly");

// Проверка «запросы только от платформы» — см. комментарий в localOnly.js.

function run(headers) {
  let status = null;
  let passed = false;
  const res = { status(code) { status = code; return this; }, json() { return this; } };
  localOnly({ headers }, res, () => { passed = true; });
  return passed ? "пропущен" : status;
}

test("законные запросы проходят: прокси платформы, планировщик, администратор на сервере", () => {
  assert.equal(run({ host: "127.0.0.1:3101", "sec-fetch-site": "same-origin" }), "пропущен", "прокси платформы");
  assert.equal(run({ host: "127.0.0.1:3101" }), "пропущен", "планировщик платформы (fetch без Sec-Fetch-*)");
  assert.equal(run({ host: "localhost:3101", "sec-fetch-site": "none" }), "пропущен", "адрес, набранный в браузере на сервере");
  assert.equal(run({ host: "[::1]:3101" }), "пропущен");
});

test("чужой Host (DNS rebinding) — отказ", () => {
  assert.equal(run({ host: "evil.example:3101" }), 403);
  assert.equal(run({ host: "127.0.0.1.evil.example" }), 403, "совпадение начала имени не считается");
  assert.equal(run({}), 403, "без Host — тоже отказ");
});

test("запрос со стороннего сайта — отказ, даже на правильный адрес", () => {
  assert.equal(run({ host: "127.0.0.1:3101", "sec-fetch-site": "cross-site" }), 403);
  assert.equal(run({ host: "127.0.0.1:3101", "sec-fetch-site": "Cross-Site" }), 403);
});

test("имя хоста выделяется без порта", () => {
  assert.equal(hostName("LocalHost:80"), "localhost");
  assert.equal(hostName("[::1]:3102"), "[::1]");
  assert.equal(hostName(undefined), "");
});

test("копия в журнале звонков совпадает с этой", () => {
  const здесь = fs.readFileSync(path.join(__dirname, "..", "localOnly.js"), "utf8");
  const там = fs.readFileSync(path.join(__dirname, "..", "..", "SMDR", "web-node", "localOnly.js"), "utf8");
  assert.equal(там, здесь, "файл одинаковый в двух модулях — поправили один, поправьте и второй");
});
