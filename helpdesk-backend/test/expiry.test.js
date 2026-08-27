'use strict';

const test = require("node:test");
const assert = require("node:assert/strict");

const { freshDb } = require("./helpers/tempDb");
const { startFakeCertviewer, certificate, attorney, inDays } = require("./helpers/fakeModules");

// ============================================================================
//  Пороги сроков: 30 / 20 / 10 / 5 и «истёк»
//
//  Самая хитрая арифметика проекта. Правило — «порог ПРОЙДЕН, и по нему ещё не
//  отправляли», а не «осталось ровно столько-то дней»: второе теряет порог
//  молча, если сервер простоял выходные. Здесь эта разница и проверяется.
//
//  Все документы выдуманы.
// ============================================================================

/** Поднять поддельный Сертвивер и загрузить адаптер, нацеленный на него. */
async function withCertviewer(t, data) {
  const fake = await startFakeCertviewer(data);
  t.after(() => fake.close());
  process.env.MODULE_CERTS_URL = `http://127.0.0.1:${fake.port}`;

  const { db, cleanup } = freshDb();   // сбрасывает кэш — адрес подхватится
  t.after(cleanup);

  const certs = require("../services/sources/certs");
  const { setSetting } = require("../services/settings");
  // Отсечку первого запуска уводим в прошлое: она проверяется отдельным тестом,
  // а здесь мешала бы смотреть на сами пороги.
  setSetting(db, "notif_started_on", "2000-01-01");
  return { db, certs, fake };
}

const keys = (db) =>
  db.prepare("SELECT dedup_key FROM notification_events ORDER BY id").all().map((r) => r.dedup_key);
const kinds = (db) =>
  db.prepare("SELECT kind FROM notification_events ORDER BY id").all().map((r) => r.kind);

test("порог не пройден — письма нет", async (t) => {
  const { db, certs } = await withCertviewer(t, { certificates: [certificate({ days: 45 })] });
  const r = await certs.run(db);
  assert.equal(r["истекает"], 0);
  assert.equal(keys(db).length, 0);
});

test("между порогами берётся самый строгий из пройденных", async (t) => {
  const { db, certs } = await withCertviewer(t, {
    certificates: [
      certificate({ id: 1, serial: "A25", days: 25 }),   // пройден 30
      certificate({ id: 2, serial: "A15", days: 15 }),   // пройдены 30 и 20 -> 20
      certificate({ id: 3, serial: "A03", days: 3 }),    // пройдены все -> 5
    ],
  });
  await certs.run(db);
  const t30 = keys(db).map((k) => k.split(":").pop());
  assert.deepEqual(t30.sort(), ["20", "30", "5"], "по одному письму на документ, самый строгий порог");
});

test("повторный обход в тот же день не создаёт дублей", async (t) => {
  const { db, certs } = await withCertviewer(t, { certificates: [certificate({ days: 25 })] });
  await certs.run(db);
  await certs.run(db);
  await certs.run(db);
  assert.equal(keys(db).length, 1);
});

test("простой сервера: пройдены два порога — письмо одно, по строгому", async (t) => {
  // Ровно тот случай, ради которого правило «порог пройден» и написано.
  // Сервер стоял три недели: у документа было 25 дней, стало 14. Пройден и 30,
  // и 20 — но письмо должно уйти ОДНО, и именно про 20.
  const { db, certs, fake } = await withCertviewer(t, {
    certificates: [certificate({ serial: "AA", days: 25 })],
  });
  await certs.run(db);
  assert.deepEqual(keys(db).map((k) => k.split(":").pop()), ["30"]);

  fake.state.certificates = [certificate({ serial: "AA", days: 14 })];
  await certs.run(db);

  const thresholds = keys(db).map((k) => k.split(":").pop());
  assert.deepEqual(thresholds, ["30", "20"], "порог 10 не должен всплыть задним числом");
});

test("документ действует последний день: осталось 0 — это ещё не «истёк»", async (t) => {
  const { db, certs } = await withCertviewer(t, { certificates: [certificate({ days: 0 })] });
  await certs.run(db);
  assert.deepEqual(kinds(db), ["expiry"], "в день окончания документ ещё действует");
});

test("истёк вчера — отдельная категория, один раз", async (t) => {
  const { db, certs } = await withCertviewer(t, {
    certificates: [certificate({ days: -1, uploadedDaysAgo: 100 })],
  });
  await certs.run(db);
  await certs.run(db);
  assert.deepEqual(kinds(db), ["expired"]);
});

test("исправленный срок начинает отсчёт порогов заново", async (t) => {
  // Доверенность перезаписывается по uuid. Если её перезалили с другой датой,
  // старый ключ заблокировал бы предупреждение по новой — поэтому дата входит
  // в ключ события.
  const { db, certs, fake } = await withCertviewer(t, {
    attorneys: [attorney({ days: 3 })],
  });
  await certs.run(db);
  assert.deepEqual(keys(db).map((k) => k.split(":").pop()), ["5"]);

  fake.state.attorneys = [attorney({ days: 25 })];   // тот же uuid, срок исправлен
  await certs.run(db);
  assert.deepEqual(keys(db).map((k) => k.split(":").pop()), ["5", "30"]);
});

test("сертификаты и доверенности считаются по одним порогам", async (t) => {
  const { db, certs } = await withCertviewer(t, {
    certificates: [certificate({ days: 8 })],
    attorneys: [attorney({ days: 8 })],
  });
  await certs.run(db);
  const rows = db.prepare("SELECT payload FROM notification_events").all()
    .map((r) => JSON.parse(r.payload));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((p) => p["вид"]).sort(), ["Доверенность", "Сертификат"]);
  assert.ok(rows.every((p) => p["осталось_дней"] === "8"));
});

test("пороги берутся из настроек, а не зашиты", async (t) => {
  const { db, certs } = await withCertviewer(t, { certificates: [certificate({ days: 60 })] });
  db.prepare("INSERT INTO notification_settings (kind, thresholds) VALUES ('expiry', '90,60')").run();
  await certs.run(db);
  assert.deepEqual(keys(db).map((k) => k.split(":").pop()), ["60"], "самый строгий из пройденных 90 и 60");
});

test("документ без срока пропускается, а не роняет обход", async (t) => {
  const bad = certificate({ id: 9, serial: "BAD" });
  bad.valid_to = null;
  const { db, certs } = await withCertviewer(t, {
    certificates: [bad, certificate({ id: 1, serial: "OK", days: 10 })],
  });
  const r = await certs.run(db);
  assert.equal(r["документов"], 1, "запись без даты в обход не попадает");
  assert.equal(keys(db).length, 1);
});

test("АРХИВ: документ, загруженный уже просроченным, писем не порождает", async (t) => {
  // В реестре лежат старые бумаги как справка. Письмо «срочно выпустить новый»
  // про них — верный способ приучить получателей не читать такие письма.
  const { db, certs } = await withCertviewer(t, {
    certificates: [certificate({ days: -400, uploadedDaysAgo: 10 })],
  });
  const r = await certs.run(db);
  assert.equal(r["пропущено"], 1);
  assert.equal(keys(db).length, 0);
});

test("ОТСЕЧКА: просрочка задолго до запуска службы — письма нет", async (t) => {
  const fake = await startFakeCertviewer({
    certificates: [certificate({ days: -200, uploadedDaysAgo: 400 })],
  });
  t.after(() => fake.close());
  process.env.MODULE_CERTS_URL = `http://127.0.0.1:${fake.port}`;
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const certs = require("../services/sources/certs");
  const { setSetting } = require("../services/settings");
  setSetting(db, "notif_started_on", inDays(0));   // службу включили сегодня

  const r = await certs.run(db);
  assert.equal(r["пропущено"], 1);
  assert.equal(keys(db).length, 0);
});

test("ОТСЕЧКА: свежая просрочка проходит, несмотря на сегодняшний запуск", async (t) => {
  // Запас в месяц намеренный: сертификат, истёкший вчера, — ровно тот случай,
  // ради которого рассылка и заводится.
  const fake = await startFakeCertviewer({
    certificates: [certificate({ days: -2, uploadedDaysAgo: 100 })],
  });
  t.after(() => fake.close());
  process.env.MODULE_CERTS_URL = `http://127.0.0.1:${fake.port}`;
  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const certs = require("../services/sources/certs");
  const { setSetting } = require("../services/settings");
  setSetting(db, "notif_started_on", inDays(0));

  const r = await certs.run(db);
  assert.equal(r["истекло"], 1);
  assert.deepEqual(kinds(db), ["expired"]);
});

test("модуль лежит: понятная ошибка, а не тихий пропуск", async (t) => {
  const { db, certs, fake } = await withCertviewer(t, { certificates: [certificate({ days: 10 })] });
  fake.state.fail = true;
  await assert.rejects(() => certs.run(db), /Сертвивер.*недоступен|недоступен/);
});

test("модуль отдал не JSON — подсказка про BEHIND_GATEWAY", async (t) => {
  // Ровно так выглядит модуль, запущенный без BEHIND_GATEWAY: он отдаёт
  // страницу входа вместо данных. Сообщение должно вести к причине.
  const { db, certs, fake } = await withCertviewer(t, { certificates: [] });
  fake.state.garbage = true;
  await assert.rejects(() => certs.run(db), /BEHIND_GATEWAY/);
});

test("пустые реестры — обход проходит и ничего не создаёт", async (t) => {
  const { db, certs } = await withCertviewer(t, { certificates: [], attorneys: [] });
  const r = await certs.run(db);
  assert.deepEqual(r, { "документов": 0, "истекает": 0, "истекло": 0, "пропущено": 0 });
});
