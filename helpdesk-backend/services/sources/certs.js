const crypto = require("crypto");
const { fetchJson } = require("../moduleClient");
const { emit, settingsFor } = require("../notifications");
const { getSetting } = require("../settings");
const tasks = require("../tasks");

// ============================================================================
//  Сроки действия: сертификаты и машиночитаемые доверенности
//
//  Два реестра Сертвивера читаются одним обходом и дают события двух типов —
//  «истекает» по порогам и «истёк» один раз. Пороги общие для обоих видов
//  документов: настройка одна, и два списка читаются одинаково.
// ============================================================================

const DEFAULT_THRESHOLDS = [30, 20, 10, 5];

// За сколько дней до конца срока документа заводится задача «перевыпустить»
// (Оповещения → Отправка → «Задача на перевыпуск»). С этого момента о
// документе напоминают задачи, а письма «истекает срок» с порогами не больше
// этого числа не отправляются. 0 — задачи не заводятся, всё как раньше.
const DEFAULT_TASK_DAYS = 10;

/** Настройка задачи на перевыпуск: за сколько дней и кому. */
function taskSettings(db) {
  const raw = getSetting(db, "expiry_task_days");
  const days = raw === null || raw === "" ? DEFAULT_TASK_DAYS : Math.max(0, Math.min(60, Number(raw) || 0));
  const chosen = String(getSetting(db, "expiry_task_assignees") || "").split(",").map(Number).filter(Boolean);
  const admins = db.prepare("SELECT id FROM users WHERE is_admin = 1 ORDER BY id").all().map((u) => u.id);
  // Выбранные — только из тех, кто сейчас администратор; не выбран никто — все администраторы.
  const assignees = chosen.filter((id) => admins.includes(id));
  return { days, chosen, assignees: assignees.length ? assignees : admins };
}

const taskRef = (doc) => `${doc.ref}:${doc.validTo}`;

// Сколько дней «свежести» есть у просрочки, случившейся до первого запуска
// службы. Смысл — отличить «истекло вчера, ещё можно спохватиться» от «истекло
// полгода назад, писать об этом поздно».
const EXPIRED_GRACE_DAYS = 30;

// Дни до конца срока по КАЛЕНДАРНЫМ датам, без часов. Документ действует весь
// последний день, поэтому «осталось 0» должно означать «истекает сегодня», а не
// «уже вчера». Считается так же, как в самом Сертвивере.
function daysLeft(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const end = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  if (isNaN(end)) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((end - today) / 86400000);
}

const isoDate = (value) => {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
};

const ru = (value) => {
  const d = isoDate(value);
  return d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "—";
};

// Ключ документа для отсева повторов. У сертификата настоящий идентификатор —
// пара «эмитент + серийный номер» (ФИО и СНИЛС повторяются при перевыпуске),
// у доверенности — uuid. Эмитент бывает длинной строкой, поэтому в ключ идёт
// его короткий хэш: ключ должен быть устойчивым, а не читаемым целиком.
//
// В сам ключ события к этому добавляется ДАТА окончания. Доверенность
// перезаписывается по uuid, и если её перезалили с исправленным сроком, старый
// ключ заблокировал бы предупреждения по новому: отправленный порог «20» не дал
// бы предупредить за 20 дней до уже другой даты. С датой в ключе исправленный
// документ начинает отсчёт порогов заново, а у неизменного ключ прежний.
const short = (s) => crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 10);

function normalize(certificates, attorneys) {
  const out = [];
  for (const c of certificates || []) {
    out.push({
      ref: `cert:${short(c.issuer_raw || c.issuer)}:${c.cert_serial || c.id}`,
      вид: "Сертификат",
      фио: c.full_name || "—",
      номер_документа: c.identifier || c.cert_serial || "—",
      validTo: isoDate(c.valid_to),
      uploadedAt: isoDate(c.uploaded_at),
    });
  }
  for (const a of attorneys || []) {
    out.push({
      ref: `mchd:${a.uuid || a.id}`,
      вид: "Доверенность",
      фио: a.full_name || "—",
      номер_документа: a.reg_number || "—",
      validTo: isoDate(a.valid_to),
      uploadedAt: isoDate(a.uploaded_at),
    });
  }
  return out.filter((d) => d.validTo);
}

function thresholdsOf(db) {
  const s = settingsFor(db, "expiry");
  const nums = String((s && s.thresholds) || "")
    .split(/[\s,]+/).filter(Boolean).map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0);
  // По возрастанию: нас интересует самый строгий из пройденных.
  return (nums.length ? nums : DEFAULT_THRESHOLDS).sort((a, b) => a - b);
}

/**
 * Обход сроков. Возвращает сводку для журнала планировщика.
 *
 * Правило порога — «пройден, и по нему ещё не отправляли», а не «осталось ровно
 * столько-то дней». Второе ломается в первый же раз, когда сервер простоял
 * выходные: день с ровным числом просто не наступил для программы, и порог
 * пропал молча.
 *
 * Из пройденных берём САМЫЙ СТРОГИЙ. Это не только правильнее по смыслу («до
 * конца 3 дня» важнее, чем «меньше месяца»), но и само по себе избавляет от
 * повторов: пока не пройден следующий порог, самый строгий не меняется, а
 * второй раз его не пропустит dedup_key.
 */
async function run(db) {
  const [certificates, attorneys] = await Promise.all([
    fetchJson("certs", "/api/certificates"),
    fetchJson("certs", "/api/mchd"),
  ]);

  const docs = normalize(certificates, attorneys);
  const thresholds = thresholdsOf(db);
  // Отсечка первого запуска: см. skipExpired ниже.
  const startedOn = getSetting(db, "notif_started_on") || "";

  let expiring = 0;
  let expired = 0;
  let skipped = 0;
  let tasksMade = 0;
  const task = taskSettings(db);

  for (const doc of docs) {
    const left = daysLeft(doc.validTo);
    if (left === null) continue;

    const payload = {
      вид: doc.вид,
      фио: doc.фио,
      срок: ru(doc.validTo),
      осталось_дней: String(Math.max(left, 0)),
      номер_документа: doc.номер_документа,
    };

    if (left >= 0) {
      // Осталось немного — заводим задачу; дальше о документе напоминают задачи.
      if (task.days && left <= task.days) {
        const isCert = doc.вид === "Сертификат";
        const id = tasks.createSystemTask(db, {
          sourceRef: taskRef(doc),
          title: `Перевыпустить ${isCert ? "сертификат" : "МЧД"}: ${doc.фио}`.slice(0, 120),
          description: `${doc.вид} на ${doc.фио} (№ ${doc.номер_документа}) действует до ${ru(doc.validTo)}. `
            + "Задачу завёл Центр по сроку документа; выполните её, когда новый документ будет загружен в Сертвивер.",
          dueDate: doc.validTo,
          priority: left <= 3 ? "critical" : "high",
          tags: [isCert ? "Сертификаты" : "МЧД"],
          assignees: task.assignees,
        });
        if (id) tasksMade++;
        // Дальше о документе напоминает задача — письма «истекает срок» не нужны.
        continue;
      }
      const crossed = thresholds.filter((t) => left <= t);
      if (!crossed.length) continue;
      const t = crossed[0]; // самый строгий из пройденных
      const created = emit(db, {
        kind: "expiry",
        subject: `${doc.вид} — ${doc.фио}, до ${ru(doc.validTo)}`,
        subjectRef: doc.ref,
        dedupKey: `expiry:${doc.ref}:${doc.validTo}:${t}`,
        payload,
      });
      if (created) expiring++;
      continue;
    }

    if (skipExpired(doc, startedOn, left)) { skipped++; continue; }
    // Есть задача на перевыпуск — о просрочке скажет она сама.
    if (db.prepare("SELECT 1 FROM tasks WHERE source_ref = ?").get(taskRef(doc))) continue;
    const created = emit(db, {
      kind: "expired",
      subject: `${doc.вид} — ${doc.фио}, истёк ${ru(doc.validTo)}`,
      subjectRef: doc.ref,
      dedupKey: `expired:${doc.ref}:${doc.validTo}`,
      payload,
    });
    if (created) expired++;
  }

  return { документов: docs.length, истекает: expiring, истекло: expired, пропущено: skipped, задач: tasksMade };
}

/**
 * Ловушка первого запуска.
 *
 * В реестре Сертвивера почти наверняка уже лежат документы с давно прошедшим
 * сроком — их загрузили как архив. Без этой проверки в день включения
 * оповещений уехала бы пачка писем «срочно выпустить новый» про бумаги
 * двухлетней давности, и читать такие письма перестали бы в тот же день.
 *
 * Два случая, когда письма быть не должно:
 *
 *   1. Документ попал в реестр УЖЕ просроченным. Это архив, а не авария:
 *      выпускать заново нечего, его положили как справку.
 *
 *   2. Срок кончился задолго до того, как служба оповещений впервые
 *      запустилась. Предупредить об этом мы физически не могли, а писать
 *      «срочно» про полугодовую давность — верный способ приучить получателей
 *      не читать такие письма.
 *
 * Второе правило намеренно с запасом в месяц, а не «всё, что до запуска».
 * Сертификат, истёкший вчера, — ровно тот случай, ради которого рассылка и
 * заводится, и терять его из-за того, что службу включили сегодня, нельзя.
 */
function skipExpired(doc, startedOn, left) {
  if (doc.uploadedAt && doc.validTo < doc.uploadedAt) return true;
  if (startedOn && doc.validTo < startedOn && left !== null && -left > EXPIRED_GRACE_DAYS) return true;
  return false;
}

module.exports = { run, daysLeft, skipExpired, taskSettings, EXPIRED_GRACE_DAYS, DEFAULT_TASK_DAYS };
