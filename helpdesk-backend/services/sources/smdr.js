const { fetchJson } = require("../moduleClient");
const { emit } = require("../notifications");

// ============================================================================
//  Исходящие минуты за месяц
//
//  Самый простой из адаптеров: журнал звонков уже отдаёт разбивку по внутренним
//  номерам с посчитанным outgoingSeconds — остаётся сложить и поделить на 60.
//  Дописывать в модуле ничего не потребовалось.
// ============================================================================

const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

/** Границы прошлого месяца относительно сегодняшнего дня. */
function previousMonth(now = new Date()) {
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return {
    key: `${first.getFullYear()}-${pad(first.getMonth() + 1)}`,
    label: `${MONTHS[first.getMonth()]} ${first.getFullYear()}`,
    from: ymd(first),
    to: ymd(last),
  };
}

/**
 * Отчёт за прошлый месяц. Правило — «месяц закрыт, и отчёт по нему ещё не
 * отправляли», а не «сегодня первое число»: если платформу подняли пятого,
 * письмо уйдёт пятого, а не потеряется вовсе.
 */
async function run(db, now = new Date()) {
  const period = previousMonth(now);
  const rows = await fetchJson(
    "smdr",
    `/api/stats/table?date_from=${period.from}&date_to=${period.to}`
  );

  let seconds = 0;
  let calls = 0;
  for (const r of rows || []) {
    seconds += Number(r.outgoingSeconds) || 0;
    calls += Number(r.outgoing) || 0;
  }
  const minutes = Math.round(seconds / 60);

  const created = emit(db, {
    kind: "minutes_monthly",
    subject: `Исходящие минуты за ${period.label}: ${minutes}`,
    subjectRef: period.key,
    dedupKey: `minutes_monthly:${period.key}`,
    payload: {
      период: period.label,
      минуты: String(minutes),
      звонков: String(calls),
    },
  });

  return { период: period.label, минуты: minutes, звонков: calls, отправлено: Boolean(created) };
}

module.exports = { run, previousMonth, MONTHS };
