'use strict';

const test = require("node:test");
const assert = require("node:assert/strict");

const { freshDb } = require("./helpers/tempDb");
const { startFakeCertviewer, startFakeSmdr, certificate } = require("./helpers/fakeModules");

// ============================================================================
//  Планировщик
//
//  Он не спрашивает «настал ли нужный момент», он спрашивает «сделано ли уже».
//  Всё, что здесь проверяется, — следствия именно этого выбора: перезапуск
//  сервера, пропущенные сутки, лежащий модуль, повторный запуск в тот же день.
// ============================================================================

async function withModules(t) {
  const cv = await startFakeCertviewer({ certificates: [certificate({ days: 25 })] });
  const smdr = await startFakeSmdr();
  t.after(() => Promise.all([cv.close(), smdr.close()]));
  process.env.MODULE_CERTS_URL = `http://127.0.0.1:${cv.port}`;
  process.env.MODULE_SMDR_URL = `http://127.0.0.1:${smdr.port}`;

  const { db, cleanup } = freshDb();
  t.after(cleanup);
  const scheduler = require("../services/scheduler");
  const { getSetting, setSetting } = require("../services/settings");
  return { db, scheduler, cv, smdr, getSetting, setSetting };
}

const jobById = (scheduler, id) => scheduler.JOBS.find((j) => j.id === id);
const eventCount = (db) => db.prepare("SELECT COUNT(*) c FROM notification_events").get().c;

test("час по умолчанию — 9, а не полночь", async (t) => {
  // Number(null) даёт 0, а не NaN: незаданный час однажды уже превращался в
  // полночь, и письма уходили ночью.
  const { db, scheduler } = await withModules(t);
  assert.equal(scheduler.status(db).hour, 9);
});

test("час читается из настроек, мусор откатывается к умолчанию", async (t) => {
  const { db, scheduler, setSetting } = await withModules(t);
  setSetting(db, "notif_daily_hour", "7");
  assert.equal(scheduler.status(db).hour, 7);
  setSetting(db, "notif_daily_hour", "0");
  assert.equal(scheduler.status(db).hour, 0, "явный ноль — законное значение");
  setSetting(db, "notif_daily_hour", "");
  assert.equal(scheduler.status(db).hour, 9);
  setSetting(db, "notif_daily_hour", "99");
  assert.equal(scheduler.status(db).hour, 9);
  setSetting(db, "notif_daily_hour", "не число");
  assert.equal(scheduler.status(db).hour, 9);
});

test("до назначенного часа ежедневное задание не выполняется", async (t) => {
  const { db, scheduler, setSetting } = await withModules(t);
  setSetting(db, "notif_daily_hour", "23");   // почти наверняка ещё не наступило
  const r = await scheduler.runJob(db, jobById(scheduler, "expiry"));
  if (new Date().getHours() < 23) {
    assert.equal(r.skipped, "ещё рано");
    assert.equal(eventCount(db), 0);
  }
});

test("выполненное за сегодня не выполняется второй раз", async (t) => {
  const { db, scheduler, setSetting } = await withModules(t);
  setSetting(db, "notif_daily_hour", "0");

  const first = await scheduler.runJob(db, jobById(scheduler, "expiry"));
  assert.equal(first.ok, true);
  const second = await scheduler.runJob(db, jobById(scheduler, "expiry"));
  assert.equal(second.skipped, "уже выполнялось", "окно суток закрыто");
});

test("«проверить сейчас» игнорирует и час, и отметку", async (t) => {
  const { db, scheduler, setSetting } = await withModules(t);
  setSetting(db, "notif_daily_hour", "23");
  const forced = await scheduler.runJob(db, jobById(scheduler, "expiry"), { force: true });
  assert.equal(forced.ok, true, "кнопка в панели должна работать в любое время");
});

test("принудительный повтор не создаёт дублей — от них защищает ключ, а не расписание", async (t) => {
  const { db, scheduler, setSetting } = await withModules(t);
  setSetting(db, "notif_daily_hour", "0");
  await scheduler.runJob(db, jobById(scheduler, "expiry"), { force: true });
  const after1 = eventCount(db);
  await scheduler.runJob(db, jobById(scheduler, "expiry"), { force: true });
  await scheduler.runJob(db, jobById(scheduler, "expiry"), { force: true });
  assert.equal(eventCount(db), after1);
});

test("модуль лежит: окно НЕ закрывается, следующий проход попробует снова", async (t) => {
  const { db, scheduler, cv, getSetting, setSetting } = await withModules(t);
  setSetting(db, "notif_daily_hour", "0");
  cv.state.fail = true;

  const failed = await scheduler.runJob(db, jobById(scheduler, "expiry"));
  assert.equal(failed.ok, false);
  assert.ok(failed.error, "причина должна быть, а не тишина");
  assert.equal(getSetting(db, "notif_ran:expiry"), null, "неудача не считается выполнением");

  cv.state.fail = false;
  const ok = await scheduler.runJob(db, jobById(scheduler, "expiry"));
  assert.equal(ok.ok, true, "после возвращения модуля обход проходит");
  assert.ok(eventCount(db) > 0);
});

test("состояние задания видно в панели: и удача, и ошибка", async (t) => {
  const { db, scheduler, cv, setSetting } = await withModules(t);
  setSetting(db, "notif_daily_hour", "0");

  cv.state.fail = true;
  await scheduler.runJob(db, jobById(scheduler, "expiry"));
  let job = scheduler.status(db).jobs.find((j) => j.id === "expiry");
  assert.equal(job.last.ok, false);
  assert.ok(job.last.error);
  assert.ok(job.last.at, "время попытки записано");

  cv.state.fail = false;
  await scheduler.runJob(db, jobById(scheduler, "expiry"), { force: true });
  job = scheduler.status(db).jobs.find((j) => j.id === "expiry");
  assert.equal(job.last.ok, true);
  assert.ok(job.last.detail["документов"] >= 1);
});

test("отметка первого запуска ставится один раз и потом не двигается", async (t) => {
  const { db, scheduler, getSetting, setSetting } = await withModules(t);
  setSetting(db, "notif_daily_hour", "0");
  await scheduler.tick(db);
  const first = getSetting(db, "notif_started_on");
  assert.match(first, /^\d{4}-\d{2}-\d{2}$/);
  await scheduler.tick(db);
  assert.equal(getSetting(db, "notif_started_on"), first, "отсечка не должна съезжать при каждом обходе");
});

test("минуты: запрашивается ровно прошлый месяц", async (t) => {
  const { db, scheduler, smdr, setSetting } = await withModules(t);
  setSetting(db, "notif_daily_hour", "0");
  await scheduler.runJob(db, jobById(scheduler, "minutes"), { force: true });

  assert.equal(smdr.state.seen.length, 1);
  const { from, to } = smdr.state.seen[0];
  const now = new Date();
  const firstOfPrev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastOfPrev = new Date(now.getFullYear(), now.getMonth(), 0);
  const p = (n) => String(n).padStart(2, "0");
  assert.equal(from, `${firstOfPrev.getFullYear()}-${p(firstOfPrev.getMonth() + 1)}-01`);
  assert.equal(to, `${lastOfPrev.getFullYear()}-${p(lastOfPrev.getMonth() + 1)}-${p(lastOfPrev.getDate())}`);
});

test("минуты: итог складывается по всем номерам", async (t) => {
  const { db, scheduler, smdr, setSetting } = await withModules(t);
  setSetting(db, "notif_daily_hour", "0");
  smdr.state.rows = [
    { ext: "101", outgoing: 10, outgoingSeconds: 600 },
    { ext: "102", outgoing: 5, outgoingSeconds: 300 },
    { ext: "103", outgoing: 0, outgoingSeconds: 0 },
  ];
  await scheduler.runJob(db, jobById(scheduler, "minutes"), { force: true });
  const ev = db.prepare("SELECT payload FROM notification_events WHERE kind='minutes_monthly'").get();
  const payload = JSON.parse(ev.payload);
  assert.equal(payload["минуты"], "15");
  assert.equal(payload["звонков"], "15");
});

test("минуты: отчёт за месяц уходит один раз, даже если обход повторили", async (t) => {
  const { db, scheduler, setSetting } = await withModules(t);
  setSetting(db, "notif_daily_hour", "0");
  await scheduler.runJob(db, jobById(scheduler, "minutes"), { force: true });
  await scheduler.runJob(db, jobById(scheduler, "minutes"), { force: true });
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM notification_events WHERE kind='minutes_monthly'").get().c,
    1
  );
});

test("минуты: пустой месяц даёт ноль, а не падение", async (t) => {
  const { db, scheduler, smdr, setSetting } = await withModules(t);
  setSetting(db, "notif_daily_hour", "0");
  smdr.state.rows = [];
  const r = await scheduler.runJob(db, jobById(scheduler, "minutes"), { force: true });
  assert.equal(r.ok, true);
  assert.equal(r.detail["минуты"], 0);
});

test("tick: падение одного задания не мешает другому", async (t) => {
  const { db, scheduler, cv, setSetting } = await withModules(t);
  setSetting(db, "notif_daily_hour", "0");
  cv.state.fail = true;                       // сроки не отработают
  await scheduler.tick(db);
  const st = scheduler.status(db).jobs;
  assert.equal(st.find((j) => j.id === "expiry").last.ok, false);
  assert.equal(st.find((j) => j.id === "minutes").last.ok, true, "минуты не должны пострадать");
});

test("tick: второй обход не начинается, пока идёт первый", async (t) => {
  const { db, scheduler, cv, setSetting } = await withModules(t);

  // Назначенный час — текущий, иначе ежедневное задание до него просто не
  // выполняется, обход завершается мгновенно и проверять становится нечего.
  // Тест раньше зависел от времени суток: после 9 утра он проходил, до — нет.
  setSetting(db, "notif_daily_hour", String(new Date().getHours()));

  // Заставляем модуль отвечать медленно: так первый обход заведомо ещё идёт,
  // когда setInterval выстрелил бы второй раз.
  cv.state.delayMs = 300;

  const первый = scheduler.tick(db);
  await new Promise((r) => setTimeout(r, 50)); // даём дойти до похода в модуль
  assert.equal(scheduler.isTicking(), true, "первый обход должен быть в работе");

  const запросовДо = cv.state.requests;
  await scheduler.tick(db);
  assert.equal(cv.state.requests, запросовДо,
    "второй обход сходил в модуль, пока шёл первый — обходы наложились");

  await первый;
  assert.equal(scheduler.isTicking(), false, "после завершения флаг обязан сняться");

  // Пропуск часа не блокирует навсегда: следующий обход снова проходит.
  // Окно суток первый обход уже закрыл, поэтому проверяем именно возможность
  // запуска, а не повторный поход в модуль.
  cv.state.delayMs = 0;
  await scheduler.runJob(db, scheduler.JOBS.find((j) => j.id === "expiry"), { force: true });
  assert.ok(cv.state.requests > запросовДо, "после снятия флага обход снова возможен");
});
