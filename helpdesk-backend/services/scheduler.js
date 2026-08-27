const { getSetting, setSetting } = require("./settings");
const { retryPending } = require("./notifications");
const certs = require("./sources/certs");
const smdr = require("./sources/smdr");

// ============================================================================
//  Планировщик
//
//  Без единой новой зависимости: setInterval раз в час плюс отметка о том, что
//  уже сделано, в той же таблице settings. node-cron тянуть на закрытый контур
//  ради двух заданий не за чем.
//
//  Главное свойство — он не спрашивает «настал ли нужный момент», он
//  спрашивает «сделано ли уже». Поэтому и перезапуск сервера, и пропущенные
//  сутки его не смущают: проснувшись, он просто видит, что за сегодня обход не
//  выполнялся, и выполняет.
// ============================================================================

const TICK_MS = 60 * 60 * 1000;
const DEFAULT_HOUR = 9;

const JOBS = [
  {
    id: "expiry",
    label: "Сроки сертификатов и МЧД",
    period: "daily",
    run: (db) => certs.run(db),
  },
  {
    id: "minutes",
    label: "Исходящие минуты за месяц",
    period: "monthly",
    run: (db) => smdr.run(db),
  },
];

let timer = null;

const pad = (n) => String(n).padStart(2, "0");
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localMonth = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

/** Окно, за которое задание отвечает: сутки или месяц. */
const windowKey = (job, now) => (job.period === "monthly" ? localMonth(now) : localDay(now));

/** Час, в который выполняются ежедневные задания. Правится в панели. */
function dailyHour(db) {
  // Осторожно с пустым значением: Number(null) и Number("") дают 0, а не NaN,
  // и «час не задан» молча превращался в полночь вместо разумного утра.
  const stored = getSetting(db, "notif_daily_hour");
  if (stored === null || stored === "") return DEFAULT_HOUR;
  const raw = Number(stored);
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : DEFAULT_HOUR;
}

function statusOf(db, job) {
  let last = null;
  try { last = JSON.parse(getSetting(db, `notif_last:${job.id}`) || "null"); } catch { /* повреждённая отметка не повод падать */ }
  return {
    id: job.id,
    label: job.label,
    period: job.period,
    ranWindow: getSetting(db, `notif_ran:${job.id}`) || null,
    last,
  };
}

function status(db) {
  return {
    hour: dailyHour(db),
    startedOn: getSetting(db, "notif_started_on") || null,
    running: Boolean(timer),
    jobs: JOBS.map((job) => statusOf(db, job)),
  };
}

/**
 * Выполнить одно задание и запомнить исход.
 *
 * Ошибка модуля (лежит, обновляется) НЕ помечается как выполнение: окно
 * остаётся незакрытым, и следующий час попробует снова. Пропущенный обход при
 * этом ничего не теряет — порог считается от даты документа, а не от того,
 * сколько раз мы на него посмотрели.
 */
async function runJob(db, job, { force = false } = {}) {
  const now = new Date();
  const key = windowKey(job, now);

  if (!force) {
    if (getSetting(db, `notif_ran:${job.id}`) === key) return { skipped: "уже выполнялось" };
    if (now.getHours() < dailyHour(db)) return { skipped: "ещё рано" };
  }

  try {
    const detail = await job.run(db);
    setSetting(db, `notif_ran:${job.id}`, key);
    setSetting(db, `notif_last:${job.id}`, JSON.stringify({ at: now.toISOString(), ok: true, detail }));
    return { ok: true, detail };
  } catch (err) {
    // Окно НЕ закрываем — повторим на следующем часе.
    setSetting(db, `notif_last:${job.id}`, JSON.stringify({ at: now.toISOString(), ok: false, error: err.message }));
    console.error(`[планировщик] ${job.label}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function tick(db) {
  // Отсечка первого запуска. Всё, что истекло до этого дня, письма «срочно
  // выпустить новый» не порождает: про эти события мы физически не могли
  // предупредить, а рассылать их задним числом — верный способ приучить
  // получателей не читать такие письма.
  if (!getSetting(db, "notif_started_on")) {
    setSetting(db, "notif_started_on", localDay(new Date()));
  }

  for (const job of JOBS) {
    await runJob(db, job);
  }

  // То, что не ушло по вине недоступного почтового сервера, досылаем сами —
  // иначе кнопку «Повторить» пришлось бы нажимать руками после каждого сбоя.
  try {
    await retryPending(db);
  } catch (err) {
    console.error("[планировщик] повтор отправки:", err.message);
  }
}

function start(db) {
  if (timer) return;
  // Первый обход — сразу при старте, а не через час: иначе после перезапуска
  // сервера утром письма ушли бы только к обеду.
  tick(db).catch((err) => console.error("[планировщик] сбой обхода:", err.message));
  timer = setInterval(
    () => tick(db).catch((err) => console.error("[планировщик] сбой обхода:", err.message)),
    TICK_MS
  );
  // Держать процесс живым ради планировщика не нужно — сервер и так слушает порт.
  if (timer.unref) timer.unref();
  console.log(`Планировщик оповещений запущен: обход раз в час, ежедневные задания после ${dailyHour(db)}:00`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick, runJob, status, JOBS, DEFAULT_HOUR };
